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

// 라운드 종료 및 다음 단계 이동 로직
function advanceStage(roomCode) {
    const room = rooms[roomCode];
    room.currentMaxBet = 0;
    room.players.forEach(p => p.roundBet = 0);

    if (room.communityCards.length === 0) {
        // 플랍 (3장)
        for(let i=0; i<3; i++) room.communityCards.push(room.deck.pop());
    } else if (room.communityCards.length < 5) {
        // 턴 & 리버 (1장씩)
        room.communityCards.push(room.deck.pop());
    } else {
        // 리버까지 끝났을 경우 (여기서는 단순화하여 새 게임 안내)
        io.to(roomCode).emit('alert', '게임이 종료되었습니다. 새 게임을 시작하세요.');
        return;
    }
    io.to(roomCode).emit('communityUpdate', room.communityCards);
}

// 베팅이 끝났는지 확인하는 함수
function checkRoundOver(room) {
    const activePlayers = room.players.filter(p => !p.folded);
    // 모든 살아있는 플레이어가 현재 최고 베팅액과 같은 금액을 냈는지 확인
    return activePlayers.every(p => p.roundBet === room.currentMaxBet);
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
                currentMaxBet: 0,
                currentTurn: 0,
                gameState: 'waiting'
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id,
            nickname: nickname,
            chips: 10000,
            roundBet: 0,
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
        io.to(roomCode).emit('communityUpdate', []);
    });

    socket.on('action', ({ roomCode, type, amount }) => {
        const room = rooms[roomCode];
        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return;

        if (type === 'check') {
            if (room.currentMaxBet > player.roundBet) {
                return socket.emit('alert', '베팅이 들어와서 체크할 수 없습니다!');
            }
        } else if (type === 'call') {
            const callAmount = room.currentMaxBet - player.roundBet;
            player.chips -= callAmount;
            player.roundBet += callAmount;
            room.pot += callAmount;
        } else if (type === 'raise') {
            const totalRaise = room.currentMaxBet + amount;
            const payAmount = totalRaise - player.roundBet;
            player.chips -= payAmount;
            player.roundBet = totalRaise;
            room.pot += payAmount;
            room.currentMaxBet = totalRaise;
        } else if (type === 'fold') {
            player.folded = true;
        }

        // 1명 제외 모두 폴드했는지 확인
        const activePlayers = room.players.filter(p => !p.folded);
        if (activePlayers.length === 1) {
            const winner = activePlayers[0];
            winner.chips += room.pot;
            io.to(roomCode).emit('alert', `${winner.nickname}님 외 모두 폴드하여 ${winner.nickname}님이 승리했습니다!`);
            room.gameState = 'waiting';
            return io.to(roomCode).emit('roomUpdate', room);
        }

        // 베팅 라운드 종료 확인
        if (checkRoundOver(room)) {
            advanceStage(roomCode);
        } else {
            // 다음 턴 계산
            do {
                room.currentTurn = (room.currentTurn + 1) % room.players.length;
            } while (room.players[room.currentTurn].folded);
        }

        io.to(roomCode).emit('roomUpdate', room);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: 포트 ${PORT}`));