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

// [추가/수정] 족보 이름을 한국어로 변환하고 J 10 투페어 등을 정확히 표시하기 위한 함수
function getHandNameKr(solved) {
    const nameMap = {
        "Royal Flush": "로열 플러쉬",
        "Straight Flush": "스트레이트 플러쉬",
        "Four of a Kind": "포카드",
        "Full House": "풀하우스",
        "Flush": "플러쉬",
        "Straight": "스트레이트",
        "Three of a Kind": "트리플",
        "Two Pair": "투페어",
        "Pair": "원페어",
        "High Card": "하이카드"
    };
    
    let name = nameMap[solved.name] || solved.name;
    
    // [수정] 투페어일 경우 구성 카드 값을 포함하여 "J 10 투페어" 형식으로 생성
    if (solved.name === "Two Pair") {
        const p1 = solved.values[0].replace('T','10');
        const p2 = solved.values[1].replace('T','10');
        return `${p1} ${p2} 투페어`;
    } else if (solved.name === "Pair") {
        const p = solved.values[0].replace('T','10');
        return `${p} 원페어`;
    }
    
    return name;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomCode, nickname }) => {
        socket.join(roomCode);
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [], deck: [], communityCards: [], pot: 0,
                currentMaxBet: 0, currentTurn: 0, gameState: 'waiting', actionCount: 0,
                lastAggressorId: null // [추가] 마지막 공격자 추적
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id, nickname, chips: 10000, roundBet: 0,
            cards: [], folded: false, lastAction: '', isReady: false, showCards: false,
            handName: '', isWinner: false // [추가] 족보 및 승리여부 저장
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
        room.deck = createDeck();
        room.communityCards = [];
        room.pot = 0;
        room.currentMaxBet = 0;
        room.currentTurn = 0;
        room.actionCount = 0;
        room.lastAggressorId = null;
        
        room.players.forEach(p => {
            p.roundBet = 0;
            p.folded = false;
            p.lastAction = '';
            p.showCards = false;
            p.handName = '';
            p.isWinner = false;
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
        player.lastAction = type.toUpperCase();

        if (type === 'call') {
            const diff = room.currentMaxBet - player.roundBet;
            player.chips -= diff; player.roundBet += diff; room.pot += diff;
        } else if (type === 'raise') {
            const total = amount; 
            const pay = total - player.roundBet;
            player.chips -= pay; player.roundBet = total; room.pot += pay;
            room.currentMaxBet = total;
            room.lastAggressorId = player.id; // [추가] 마지막 레이저 기록
        } else if (type === 'fold') {
            player.folded = true;
        }

        const active = room.players.filter(p => !p.folded);
        if (active.length === 1) {
            active[0].chips += room.pot;
            endGame(roomCode, `${active[0].nickname}님 폴드 승리!`);
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
                // [수정] 쇼다운 진입 전 승자 및 족보 미리 계산
                const winners = solveWinners(active, room.communityCards);
                room.players.forEach(p => {
                    if (!p.folded) {
                        const solved = Solver.solve([...p.cards, ...room.communityCards]);
                        p.handName = getHandNameKr(solved);
                        p.isWinner = winners.some(w => w.id === p.id);
                    }
                });
                room.gameState = 'showdown';
                io.to(roomCode).emit('roomUpdate', room);
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
        const player = room.players.find(p => p.id === socket.id);
        if (!room || room.gameState !== 'showdown' || !player) return;

        if (action === 'show') player.showCards = true;
        player.lastAction = action.toUpperCase();

        const active = room.players.filter(p => !p.folded);
        const showdownFinished = active.every(p => p.lastAction === 'SHOW' || p.lastAction === 'MUCK' || p.id === room.lastAggressorId || p.isWinner);

        if (showdownFinished) {
            const winners = room.players.filter(p => p.isWinner);
            const prize = Math.floor(room.pot / winners.length);
            winners.forEach(w => { w.chips += prize; });
            endGame(roomCode, `결과: ${winners.map(w => w.nickname).join(', ')} 승리!`);
        } else {
            io.to(roomCode).emit('roomUpdate', room);
        }
    });

    function solveWinners(players, community) {
        const hands = players.map(p => {
            const h = Solver.solve([...p.cards, ...community]);
            h.id = p.id;
            h.nickname = p.nickname;
            return h;
        });
        const winnerHands = Solver.winners(hands);
        return winnerHands.map(h => ({ id: h.id, nickname: h.nickname }));
    }

    function endGame(roomCode, msg) {
        const room = rooms[roomCode];
        if (!room) return;
        room.gameState = 'waiting';
        room.players.forEach(p => { p.isReady = false; });
        io.to(roomCode).emit('alert', msg);
        io.to(roomCode).emit('roomUpdate', room);
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));