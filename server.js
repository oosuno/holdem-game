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

// [수정] 정확한 승자 판별을 위해 rank와 타이브레이커를 포함한 비교 로직 사용
function solveWinners(players, community) {
    let bestHand = null;
    let winners = [];

    players.forEach(p => {
        const hand = Solver.solve([...p.cards, ...community]);
        
        if (!bestHand) {
            bestHand = hand;
            winners = [p];
        } else {
            // hand.compare(bestHand) -> 1: hand가 우세, -1: bestHand가 우세, 0: 무승부
            const result = hand.compare(bestHand);
            if (result > 0) {
                bestHand = hand;
                winners = [p];
            } else if (result === 0) {
                winners.push(p);
            }
        }
    });
    return winners;
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
                const firstPlayer = room.players[room.showdownTurn];
                firstPlayer.showCards = true;
                firstPlayer.lastAction = 'SHOW';
                const hand = Solver.solve([...firstPlayer.cards, ...room.communityCards]);
                firstPlayer.handDesc = hand.descr;
                checkNextShowdown(room, roomCode);
            }
        } else {
            do {
                room.currentTurn = (room.currentTurn + 1) % room.players.length;
            } while (room.players[room.currentTurn].folded);
        }
        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('showdownAction', ({ roomCode, action }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'showdown') return;
        const player = room.players[room.showdownTurn];
        if (!player || player.id !== socket.id) return;

        player.lastAction = action.toUpperCase();
        if (action === 'show') {
            player.showCards = true;
            const hand = Solver.solve([...player.cards, ...room.communityCards]);
            player.handDesc = hand.descr;
        } else {
            player.handDesc = ''; 
        }

        checkNextShowdown(room, roomCode);
        io.to(roomCode).emit('roomUpdate', room);
    });

    function checkNextShowdown(room, roomCode) {
        let foundNext = false;
        let bestHand = null;

        room.players.filter(p => p.showCards).forEach(p => {
            const hand = Solver.solve([...p.cards, ...room.communityCards]);
            if (!bestHand || hand.compare(bestHand) > 0) bestHand = hand;
        });

        for (let i = 1; i < room.players.length; i++) {
            let idx = (room.showdownTurn + i) % room.players.length;
            let p = room.players[idx];
            
            if (!p.folded && p.lastAction !== 'SHOW' && p.lastAction !== 'MUCK') {
                room.showdownTurn = idx;
                const myHand = Solver.solve([...p.cards, ...room.communityCards]);
                
                if (bestHand && myHand.compare(bestHand) > 0) {
                    p.showCards = true;
                    p.lastAction = 'SHOW';
                    p.handDesc = myHand.descr; 
                    checkNextShowdown(room, roomCode);
                    return;
                }
                foundNext = true;
                break;
            }
        }
        if (!foundNext) finishGame(room, roomCode);
    }

    function finishGame(room, roomCode) {
        const active = room.players.filter(p => !p.folded);
        const winners = solveWinners(active, room.communityCards);
        const prize = Math.floor(room.pot / winners.length);
        winners.forEach(w => { const p = room.players.find(pl => pl.id === w.id); p.chips += prize; });
        room.players.forEach(p => {
            const isWinner = winners.some(w => w.id === p.id);
            p.profit = isWinner ? (prize - p.totalBet) : -p.totalBet;
        });
        endGame(roomCode, `결과: ${winners.map(w => w.nickname).join(', ')} 승리!`);
    }

    function endGame(roomCode, msg) {
        const room = rooms[roomCode];
        if (!room) return;
        room.gameState = 'waiting';
        room.statusMsg = msg;
        room.players.forEach(p => { p.isReady = false; });
        io.to(roomCode).emit('roomUpdate', room);
    }

    socket.on('sendMessage', ({ roomCode, msg }) => {
        const room = rooms[roomCode];
        const player = room.players?.find(p => p.id === socket.id);
        if (player) io.to(roomCode).emit('chatUpdate', `${player.nickname}: ${msg}`);
    });

    const leave = (socketId) => {
        for (const code in rooms) {
            const room = rooms[code];
            const idx = room.players.findIndex(p => p.id === socketId);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                if (room.players.length === 0) delete rooms[code];
                else io.to(code).emit('roomUpdate', room);
            }
        }
    };
    socket.on('leaveRoom', () => leave(socket.id));
    socket.on('disconnect', () => leave(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));