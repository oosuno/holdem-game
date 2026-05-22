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
                currentMaxBet: 0, // 현재 라운드의 최고 베팅액
                currentTurn: 0,
                gameState: 'waiting'
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id,
            nickname: nickname,
            chips: 10000,
            roundBet: 0, // 이번 라운드에 내가 낸 돈
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
        room.currentMaxBet = 0;
        room.currentTurn = 0;
        
        room.players.forEach(p => {
            p.cards = [room.deck.pop(), room.deck.pop()];
            p.roundBet = 0;
            p.folded = false;
            io.to(p.id).emit('dealPrivateCards', p.cards);
        });
        io.to(roomCode).emit('gameStarted', room);
    });

    socket.on('action', ({ roomCode, type, amount }) => {
        const room = rooms[roomCode];
        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return;

        if (type === 'check') {
            // 앞사람이 베팅을 해서 currentMaxBet이 내 roundBet보다 높으면 체크 불가
            if (room.currentMaxBet > player.roundBet) {
                return socket.emit('alert', '베팅이 들어와서 체크할 수 없습니다! 콜이나 레이즈를 하세요.');
            }
        } else if (type === 'call') {
            const callAmount = room.currentMaxBet - player.roundBet;
            player.chips -= callAmount;
            player.roundBet += callAmount;
            room.pot += callAmount;
        } else if (type === 'raise') {
            const totalRaise = room.currentMaxBet + amount; // 현재 최고가 + 추가베팅액
            const payAmount = totalRaise - player.roundBet;
            player.chips -= payAmount;
            player.roundBet = totalRaise;
            room.pot += payAmount;
            room.currentMaxBet = totalRaise; // 최고 베팅액 갱신
        } else if (type === 'fold') {
            player.folded = true;
        }

        // 다음 차례 계산
        do {
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
        } while (room.players[room.currentTurn].folded);

        io.to(roomCode).emit('roomUpdate', room);
    });

    socket.on('dealCommunity', (roomCode) => {
        const room = rooms[roomCode];
        // 새로운 카드가 깔리면 베팅 금액 초기화
        room.currentMaxBet = 0;
        room.players.forEach(p => p.roundBet = 0);

        if (room.communityCards.length < 5) {
            const count = room.communityCards.length === 0 ? 3 : 1;
            for(let i=0; i<count; i++) room.communityCards.push(room.deck.pop());
            io.to(roomCode).emit('communityUpdate', room.communityCards);
            io.to(roomCode).emit('roomUpdate', room); // 베팅 초기화 상태 알림
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: 포트 ${PORT}`));