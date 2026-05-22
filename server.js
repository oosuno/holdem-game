const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ suit, value });
        }
    }
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
                players: [],
                deck: [],
                communityCards: [],
                pot: 0,
                currentTurn: 0,
                gameState: 'waiting'
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id,
            nickname: nickname,
            chips: 10000,
            bet: 0,
            cards: [],
            folded: false
        });
        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.gameState = 'playing';
        room.deck = createDeck();
        room.communityCards = [];
        room.pot = 0;
        room.currentTurn = 0;
        
        room.players.forEach(p => {
            p.cards = [room.deck.pop(), room.deck.pop()];
            p.bet = 0;
            p.folded = false;
            io.to(p.id).emit('dealPrivateCards', p.cards);
        });
        io.to(roomCode).emit('gameStarted', room);
    });

    // 베팅 처리 (Call, Raise, Fold)
    socket.on('action', ({ roomCode, type, amount }) => {
        const room = rooms[roomCode];
        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return; // 자기 차례가 아니면 무시

        if (type === 'call') {
            player.chips -= 1000;
            room.pot += 1000;
        } else if (type === 'fold') {
            player.folded = true;
        } else if (type === 'raise') {
            player.chips -= amount;
            room.pot += amount;
        }

        // 다음 살아있는 플레이어에게 차례 넘기기
        do {
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
        } while (room.players[room.currentTurn].folded);

        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('dealCommunity', (roomCode) => {
        const room = rooms[roomCode];
        if (room.communityCards.length < 5) {
            const count = room.communityCards.length === 0 ? 3 : 1;
            for(let i=0; i<count; i++) room.communityCards.push(room.deck.pop());
            io.to(roomCode).emit('communityUpdate', room.communityCards);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: 포트 ${PORT}`));