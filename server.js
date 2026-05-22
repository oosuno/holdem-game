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
                players: [], communityCards: [], pot: 0, currentMaxBet: 0, 
                currentTurn: 0, gameState: 'waiting', chat: []
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id, nickname, chips: 10000, roundBet: 0,
            cards: [], folded: false, lastAction: '', isReady: false, isWaiting: room.gameState === 'playing'
        });
        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        // 1. 혼자일 때 시작 방지
        const activeCount = room.players.filter(p => !p.isWaiting).length;
        if (activeCount < 2) return io.to(socket.id).emit('alert', '최소 2명의 플레이어가 필요합니다!');

        room.gameState = 'playing';
        room.deck = createDeck();
        room.communityCards = [];
        room.pot = 0;
        room.currentMaxBet = 0;
        room.currentTurn = 0;
        
        room.players.forEach(p => {
            p.roundBet = 0;
            p.folded = false;
            p.lastAction = '';
            if (!p.isWaiting) {
                p.cards = [room.deck.pop(), room.deck.pop()];
                io.to(p.id).emit('dealPrivateCards', p.cards);
            }
        });
        io.to(roomCode).emit('gameStarted', room);
    });

    socket.on('action', ({ roomCode, type, amount }) => {
        const room = rooms[roomCode];
        const player = room.players[room.currentTurn];
        if (!player || player.id !== socket.id) return;

        player.lastAction = type.toUpperCase();
        if (type === 'call') {
            const diff = room.currentMaxBet - player.roundBet;
            player.chips -= diff; player.roundBet += diff; room.pot += diff;
        } else if (type === 'raise') {
            const total = room.currentMaxBet + amount;
            const pay = total - player.roundBet;
            player.chips -= pay; player.roundBet = total; room.pot += pay;
            room.currentMaxBet = total;
        } else if (type === 'fold') { player.folded = true; }

        const active = room.players.filter(p => !p.folded && !p.isWaiting);
        if (active.length === 1) {
            active[0].chips += room.pot;
            room.gameState = 'waiting';
            io.to(roomCode).emit('alert', `${active[0].nickname} 승리!`);
        } else if (active.every(p => p.roundBet === room.currentMaxBet)) {
            if (room.communityCards.length < 5) {
                const count = room.communityCards.length === 0 ? 3 : 1;
                for(let i=0; i<count; i++) room.communityCards.push(room.deck.pop());
                room.currentMaxBet = 0;
                room.players.forEach(p => p.roundBet = 0);
                room.currentTurn = room.players.findIndex(p => !p.folded && !p.isWaiting);
                io.to(roomCode).emit('communityUpdate', room.communityCards);
            } else {
                room.gameState = 'waiting';
                io.to(roomCode).emit('alert', '게임 종료! 새 게임을 준비하세요.');
            }
        } else {
            do { room.currentTurn = (room.currentTurn + 1) % room.players.length; } 
            while (room.players[room.currentTurn].folded || room.players[room.currentTurn].isWaiting);
        }
        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('sendMessage', ({ roomCode, msg }) => {
        const room = rooms[roomCode];
        const player = room.players.find(p => p.id === socket.id);
        if (player) io.to(roomCode).emit('chatUpdate', `${player.nickname}: ${msg}`);
    });

    const leave = (socketId) => {
        for (const code in rooms) {
            const room = rooms[code];
            const idx = room.players.findIndex(p => p.id === socketId);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                io.to(code).emit('roomUpdate', room);
            }
        }
    };
    socket.on('leaveRoom', () => leave(socket.id));
    socket.on('disconnect', () => leave(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));