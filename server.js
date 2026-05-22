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
                currentMaxBet: 0, currentTurn: 0, gameState: 'waiting'
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id, nickname, chips: 10000, roundBet: 0,
            cards: [], folded: false, lastAction: '', isReady: false
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

        // 모든 참가자가 준비되고 최소 2명일 때 자동 시작
        if (total >= 2 && total === readyCount) {
            startNewGame(roomCode);
        } else {
            io.to(roomCode).emit('roomUpdate', room);
        }
    });

    function startNewGame(roomCode) {
        const room = rooms[roomCode];
        room.gameState = 'playing';
        room.deck = createDeck();
        room.communityCards = [];
        room.pot = 0;
        room.currentMaxBet = 0;
        
        // 순서는 랜덤하게 또는 첫 번째 플레이어부터
        room.currentTurn = 0;
        
        room.players.forEach(p => {
            p.roundBet = 0;
            p.folded = false;
            p.lastAction = '';
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

        player.lastAction = type.toUpperCase();

        if (type === 'call') {
            const diff = room.currentMaxBet - player.roundBet;
            player.chips -= diff; player.roundBet += diff; room.pot += diff;
        } else if (type === 'raise') {
            const total = room.currentMaxBet + amount;
            const pay = total - player.roundBet;
            player.chips -= pay; player.roundBet = total; room.pot += pay;
            room.currentMaxBet = total;
        } else if (type === 'fold') {
            player.folded = true;
        }

        const active = room.players.filter(p => !p.folded);
        if (active.length === 1) {
            // 폴드 승리
            active[0].chips += room.pot;
            endGame(roomCode, `${active[0].nickname}님 폴드 승리!`);
        } else if (active.every(p => p.roundBet === room.currentMaxBet)) {
            // 라운드 종료
            if (room.communityCards.length < 5) {
                const draw = room.communityCards.length === 0 ? 3 : 1;
                for(let i=0; i<draw; i++) room.communityCards.push(room.deck.pop());
                room.currentMaxBet = 0;
                room.players.forEach(p => p.roundBet = 0);
                // 첫 번째 생존 플레이어로 턴 리셋
                room.currentTurn = room.players.findIndex(p => !p.folded);
                io.to(roomCode).emit('communityUpdate', room.communityCards);
            } else {
                // 리버 종료
                endGame(roomCode, '게임이 종료되었습니다. (쇼다운 생략)');
            }
        } else {
            // 다음 턴
            do {
                room.currentTurn = (room.currentTurn + 1) % room.players.length;
            } while (room.players[room.currentTurn].folded);
        }
        io.to(roomCode).emit('roomUpdate', room);
    });

    function endGame(roomCode, msg) {
        const room = rooms[roomCode];
        room.gameState = 'waiting';
        room.players.forEach(p => {
            p.isReady = false;
            p.cards = [];
        });
        io.to(roomCode).emit('alert', msg);
    }

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