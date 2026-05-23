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

// 카드 값 보정 (10 -> T)
function standardizeCards(cards) {
    return cards.map(c => {
        let val = c.slice(0, -1);
        let suit = c.slice(-1);
        if (val === '10') val = 'T';
        return val + suit;
    });
}

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

function solveWinners(players, community) {
    const handsWithPlayer = players.map(p => ({
        player: p,
        hand: Solver.solve(standardizeCards([...p.cards, ...community]))
    }));
    const winningHands = Solver.winners(handsWithPlayer.map(hp => hp.hand));
    return players.filter(p => {
        const pHand = Solver.solve(standardizeCards([...p.cards, ...community]));
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
        if (room.players.length >= 2 && room.players.every(p => p.isReady)) startNewGame(roomCode);
        else io.to(roomCode).emit('roomUpdate', room);
    });

    function startNewGame(roomCode) {
        const room = rooms[roomCode];
        room.gameState = 'playing';
        room.deck = createDeck();
        room.communityCards = [];
        room.pot = 0;
        room.players.forEach(p => {
            p.cards = [room.deck.pop(), room.deck.pop()];
            p.roundBet = 0; p.totalBet = 0; p.profit = 0;
            p.folded = false; p.lastAction = ''; p.showCards = false; p.handDesc = '';
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
            room.currentMaxBet = amount; player.lastAction = `RAISE ${amount}`;
        } else if (type === 'fold') {
            player.folded = true; player.lastAction = 'FOLD';
        } else if (type === 'check') {
            player.lastAction = 'CHECK';
        }

        const active = room.players.filter(p => !p.folded);
        if (active.length === 1) {
            const winner = active[0]; winner.chips += room.pot;
            endGame(roomCode, `${winner.nickname}님 승리!`);
        } else if (active.every(p => p.roundBet === room.currentMaxBet) && room.actionCount >= active.length) {
            if (room.communityCards.length < 5) {
                const draw = room.communityCards.length === 0 ? 3 : 1;
                for(let i=0; i<draw; i++) room.communityCards.push(room.deck.pop());
                room.currentMaxBet = 0; room.actionCount = 0;
                room.players.forEach(p => { p.roundBet = 0; p.lastAction = ''; });
                room.currentTurn = room.players.findIndex(p => !p.folded);
                io.to(roomCode).emit('communityUpdate', room.communityCards);
            } else {
                room.gameState = 'showdown';
                room.showdownTurn = room.players.findIndex(p => !p.folded);
                const first = room.players[room.showdownTurn];
                first.showCards = true; first.lastAction = 'SHOW';
                first.handDesc = Solver.solve(standardizeCards([...first.cards, ...room.communityCards])).descr;
                checkNextShowdown(room, roomCode);
            }
        } else {
            do { room.currentTurn = (room.currentTurn + 1) % room.players.length; } while (room.players[room.currentTurn].folded);
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
            player.handDesc = Solver.solve(standardizeCards([...player.cards, ...room.communityCards])).descr;
        } else player.handDesc = '';
        checkNextShowdown(room, roomCode);
        io.to(roomCode).emit('roomUpdate', room);
    });

    function checkNextShowdown(room, roomCode) {
        let bestHand = null;
        room.players.filter(p => p.showCards).forEach(p => {
            const h = Solver.solve(standardizeCards([...p.cards, ...room.communityCards]));
            if (!bestHand || h.compare(bestHand) > 0) bestHand = h;
        });

        let foundNext = false;
        for (let i = 1; i < room.players.length; i++) {
            let idx = (room.showdownTurn + i) % room.players.length;
            let p = room.players[idx];
            if (!p.folded && p.lastAction !== 'SHOW' && p.lastAction !== 'MUCK') {
                room.showdownTurn = idx;
                const myHand = Solver.solve(standardizeCards([...p.cards, ...room.communityCards]));
                
                // [수정] 내 패가 앞선 베스트 핸드보다 좋으면 자동 오픈, 아니면 MUCK 선택지 전송
                if (bestHand && myHand.compare(bestHand) > 0) {
                    p.showCards = true; p.lastAction = 'SHOW'; p.handDesc = myHand.descr;
                    checkNextShowdown(room, roomCode); return;
                } else if (bestHand && myHand.compare(bestHand) < 0) {
                    io.to(p.id).emit('canMuck', { canMuck: true });
                }
                foundNext = true; break;
            }
        }
        if (!foundNext) finishGame(room, roomCode);
    }

    function finishGame(room, roomCode) {
        const active = room.players.filter(p => !p.folded);
        const winners = solveWinners(active, room.communityCards);
        const prize = Math.floor(room.pot / winners.length);
        winners.forEach(w => { const p = room.players.find(pl => pl.id === w.id); p.chips += prize; });
        endGame(roomCode, `승자: ${winners.map(w => w.nickname).join(', ')}`);
    }

    function endGame(roomCode, msg) {
        const room = rooms[roomCode];
        room.gameState = 'waiting'; room.statusMsg = msg;
        room.players.forEach(p => { p.isReady = false; });
        io.to(roomCode).emit('roomUpdate', room);
    }

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
    socket.on('disconnect', () => leave(socket.id));
});

server.listen(process.env.PORT || 3000, () => console.log('Server running...'));