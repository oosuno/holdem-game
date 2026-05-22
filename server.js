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
    const suits = ['s', 'h', 'd', 'c']; // pokersolver 형식 (s,h,d,c)
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
                currentMaxBet: 0, currentTurn: 0, gameState: 'waiting', 
                chat: []
            };
        }
        const room = rooms[roomCode];
        
        // 게임 중 접속 시 관전자/대기자로 추가
        const isWaiting = room.gameState === 'playing';
        room.players.push({
            id: socket.id, nickname, chips: 10000, roundBet: 0,
            cards: [], folded: false, lastAction: '', isWaiting
        });
        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('sendMessage', ({ roomCode, msg }) => {
        const room = rooms[roomCode];
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            const chatMsg = `${player.nickname}: ${msg}`;
            room.chat.push(chatMsg);
            io.to(roomCode).emit('chatUpdate', chatMsg);
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.gameState === 'playing') return;
        
        room.gameState = 'playing';
        room.deck = createDeck();
        room.communityCards = [];
        room.pot = 0;
        room.currentMaxBet = 0;
        room.currentTurn = 0;
        
        room.players.forEach(p => {
            if (!p.isWaiting) {
                p.cards = [room.deck.pop(), room.deck.pop()];
                p.roundBet = 0;
                p.folded = false;
                p.lastAction = '';
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
            player.chips -= diff;
            player.roundBet += diff;
            room.pot += diff;
        } else if (type === 'raise') {
            const total = room.currentMaxBet + amount;
            const pay = total - player.roundBet;
            player.chips -= pay;
            player.roundBet = total;
            room.pot += pay;
            room.currentMaxBet = total;
        } else if (type === 'fold') {
            player.folded = true;
        }

        const active = room.players.filter(p => !p.folded && !p.isWaiting);
        if (active.length === 1) {
            active[0].chips += room.pot;
            room.gameState = 'waiting';
            io.to(roomCode).emit('alert', `${active[0].nickname}승리!`);
        } else if (active.every(p => p.roundBet === room.currentMaxBet)) {
            // 라운드 종료 -> 카드 오픈 및 순서 리셋
            if (room.communityCards.length < 5) {
                const count = room.communityCards.length === 0 ? 3 : 1;
                for(let i=0; i<count; i++) room.communityCards.push(room.deck.pop());
                room.currentMaxBet = 0;
                room.players.forEach(p => p.roundBet = 0);
                room.currentTurn = room.players.findIndex(p => !p.folded && !p.isWaiting); // 첫 번째 생존자로 리셋
                io.to(roomCode).emit('communityUpdate', room.communityCards);
            } else {
                // 게임 최종 종료 (결과 계산 생략-간소화)
                room.gameState = 'waiting';
                io.to(roomCode).emit('alert', '라운드가 모두 끝났습니다.');
            }
        } else {
            do { room.currentTurn = (room.currentTurn + 1) % room.players.length; } 
            while (room.players[room.currentTurn].folded || room.players[room.currentTurn].isWaiting);
        }
        io.to(roomCode).emit('roomUpdate', room);
    });

    // 나가기 처리
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
server.listen(PORT, () => console.log(`Server running on ${PORT}`));