const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Solver = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

function createDeck() {
    const suits = ['s', 'h', 'd', 'c'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push(v + s);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// [수정] 승자 판별 로직: Hand.winners 사용
function solveWinners(players, community) {
    const handsWithPlayer = players.map(p => ({
        player: p,
        hand: Solver.solve([...p.cards, ...community])
    }));
    const winningHands = Solver.winners(handsWithPlayer.map(hp => hp.hand));
    return players.filter(p => {
        const pHand = Solver.solve([...p.cards, ...community]);
        return winningHands.some(wh => wh.compare(pHand) === 0);
    });
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomCode, nickname }) => {
        socket.join(roomCode);
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [], deck: [], communityCards: [], pot: 0,
                currentMaxBet: 0, currentTurn: 0, gameState: 'waiting', actionCount: 0,
                statusMsg: '플레이어를 기다리는 중...'
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id, nickname, chips: 10000, roundBet: 0, totalBet: 0,
            cards: [], folded: false, lastAction: '', isReady: false, showCards: false, profit: 0, handDesc: ''
        });
        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('toggleReady', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.gameState === 'playing') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.isReady = !player.isReady;

        const total = room.players.length;
        const readyCount = room.players.filter(p => p.isReady).length;
        if (total >= 2 && total === readyCount) {
            startNewGame(roomCode);
        } else {
            io.to(roomCode).emit('roomUpdate', room);
        }
    });

    function startNewGame(roomCode) {
        const room = rooms[roomCode];
        room.gameState = 'playing';
        room.statusMsg = '게임이 시작되었습니다.';
        room.deck = createDeck();
        room.communityCards = [];
        room.pot = 0;
        room.currentMaxBet = 0;
        room.currentTurn = 0;
        room.actionCount = 0;
        
        room.players.forEach(p => {
            p.roundBet = 0; p.totalBet = 0; p.profit = 0;
            p.folded = false; p.lastAction = ''; p.showCards = false; p.handDesc = '';
            p.cards = [room.deck.pop(), room.deck.pop()];
            io.to(p.id).emit('dealPrivateCards', p.cards);
        });
        io.to(roomCode).emit('communityUpdate', []);
        io.to(roomCode).emit('roomUpdate', room);
    }

    socket.on('action', ({ roomCode, type, amount }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'playing') return;
        const player = room.players[room.currentTurn];
        if (!player || player.id !== socket.id) return;

        room.actionCount++;

        if (type === 'call') {
            const diff = room.currentMaxBet - player.roundBet;
            player.chips -= diff; player.roundBet += diff; player.totalBet += diff; room.pot += diff;
            player.lastAction = 'CALL';
        } else if (type === 'raise') {
            const pay = amount - player.roundBet;
            player.chips -= pay; player.roundBet = amount; player.totalBet += pay; room.pot += pay;
            room.currentMaxBet = amount;
            player.lastAction = `RAISE ${amount}`;
        } else if (type === 'fold') {
            player.folded = true;
            player.lastAction = 'FOLD';
        } else if (type === 'check') {
            player.lastAction = 'CHECK';
        }

        const active = room.players.filter(p => !p.folded);
        if (active.length === 1) {
            const winner = active[0];
            winner.chips += room.pot;
            endGame(roomCode, `${winner.nickname}님 폴드 승리!`);
        } else if (active.every(p => p.roundBet === room.currentMaxBet) && room.actionCount >= active.length) {
            if (room.communityCards.length < 5) {
                const draw = room.communityCards.length === 0 ? 3 : 1;
                for(let i=0; i<draw; i++) room.communityCards.push(room.deck.pop());
                room.currentMaxBet = 0;
                room.actionCount = 0;
                room.players.forEach(p => { p.roundBet = 0; p.lastAction = ''; });
                room.currentTurn = room.players.findIndex(p => !p.folded);
                io.to(roomCode).emit('communityUpdate', room.communityCards);
            } else {
                room.gameState = 'showdown';
                room.statusMsg = '쇼다운이 진행됩니다.';
                room.showdownTurn = room.players.findIndex(p => !p.folded);
                io.to(roomCode).emit('roomUpdate', room);
            }
        } else {
            do {
                room.currentTurn = (room.currentTurn + 1) % room.players.length;
            } while (room.players[room.currentTurn].folded);
        }
        io.to(roomCode).emit('roomUpdate', room);
    });

    // (이하 생략 - 이전 로직과 동일)
    socket.on('disconnect', () => { /* ... leave logic ... */ });
    
    // ... 나머지 함수들 (finishGame, endGame, sendMessage 등)은 이전과 동일하게 유지하세요.
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));