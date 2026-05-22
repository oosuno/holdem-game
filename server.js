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
            cards: [], folded: false, lastAction: '', isReady: false, showCards: false, profit: 0
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
            p.folded = false; p.lastAction = ''; p.showCards = false;
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
            const total = amount;
            const pay = total - player.roundBet;
            player.chips -= pay; player.roundBet = total; player.totalBet += pay; room.pot += pay;
            room.currentMaxBet = total;
            player.lastAction = `RAISE ${total.toLocaleString()}`;
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
                // 첫 번째 플레이어 찾기
                room.showdownTurn = room.players.findIndex(p => !p.folded);
                
                // 첫 번째 사람은 무조건 자동 오픈
                const firstPlayer = room.players[room.showdownTurn];
                firstPlayer.showCards = true;
                firstPlayer.lastAction = 'SHOW';
                
                // 다음 사람 판단 로직 실행
                checkNextShowdown(room, roomCode);
            }
        } else {
            do {
                room.currentTurn = (room.currentTurn + 1) % room.players.length;
            } while (room.players[room.currentTurn].folded);
        }
        io.to(roomCode).emit('roomUpdate', room);
    });

    function checkNextShowdown(room, roomCode) {
        let foundNext = false;
        // 현재 오픈된 카드들 중 최고 족보 랭크 확인
        const shownPlayers = room.players.filter(p => p.showCards);
        let bestRank = 0;
        shownPlayers.forEach(p => {
            const hand = Solver.solve([...p.cards, ...room.communityCards]);
            if (hand.rank > bestRank) bestRank = hand.rank;
        });

        for (let i = 1; i < room.players.length; i++) {
            let idx = (room.showdownTurn + i) % room.players.length;
            let p = room.players[idx];
            
            if (!p.folded && p.lastAction !== 'SHOW' && p.lastAction !== 'MUCK') {
                room.showdownTurn = idx;
                const myHand = Solver.solve([...p.cards, ...room.communityCards]);
                
                // 내가 이겼으면 자동 오픈하고 그 다음 사람 체크 (재귀)
                if (myHand.rank > bestRank) {
                    p.showCards = true;
                    p.lastAction = 'SHOW';
                    checkNextShowdown(room, roomCode);
                    return;
                }
                // 내가 졌으면 멈추고 유저에게 MUCK 선택지 노출 (foundNext = true)
                foundNext = true;
                break;
            }
        }
        if (!foundNext) finishGame(room, roomCode);
    }

    socket.on('showdownAction', ({ roomCode, action }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'showdown') return;
        const player = room.players[room.showdownTurn];
        if (!player || player.id !== socket.id) return;

        if (action === 'show') player.showCards = true;
        player.lastAction = action.toUpperCase();

        checkNextShowdown(room, roomCode);
        io.to(roomCode).emit('roomUpdate', room);
    });

    function finishGame(room, roomCode) {
        const active = room.players.filter(p => !p.folded);
        const winners = solveWinners(active, room.communityCards);
        const prize = Math.floor(room.pot / winners.length);
        
        winners.forEach(w => {
            const p = room.players.find(pl => pl.id === w.id);
            p.chips += prize;
        });

        // 손익 계산
        room.players.forEach(p => {
            const isWinner = winners.some(w => w.id === p.id);
            p.profit = isWinner ? (prize - p.totalBet) : -p.totalBet;
        });

        endGame(roomCode, `결과: ${winners.map(w => w.nickname).join(', ')} 승리!`);
    }

    function solveWinners(players, community) {
        let bestScore = -1;
        let winners = [];
        players.forEach(p => {
            const hand = Solver.solve([...p.cards, ...community]);
            if (hand.rank > bestScore) {
                bestScore = hand.rank;
                winners = [p];
            } else if (hand.rank === bestScore) {
                winners.push(p);
            }
        });
        return winners;
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