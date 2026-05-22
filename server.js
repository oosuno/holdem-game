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
                statusMsg: '플레이어를 기다리는 중...' // 게임 메시지 상태 추가
            };
        }
        const room = rooms[roomCode];
        room.players.push({
            id: socket.id, nickname, chips: 10000, roundBet: 0, totalBet: 0, // 판별 손익 계산용 totalBet 추가
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
            p.roundBet = 0;
            p.totalBet = 0; // 초기화
            p.profit = 0; // 손익 초기화
            p.folded = false;
            p.lastAction = '';
            p.showCards = false;
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
                room.players.forEach(p => { p.roundBet = 0; }); // lastAction은 유지하여 흐름 표시
                room.currentTurn = room.players.findIndex(p => !p.folded);
                io.to(roomCode).emit('communityUpdate', room.communityCards);
            } else {
                room.gameState = 'showdown';
                room.statusMsg = '쇼다운! 패를 공개하거나 숨기세요.';
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
        const showdownFinished = active.every(p => p.lastAction === 'SHOW' || p.lastAction === 'MUCK');

        if (showdownFinished) {
            const winners = solveWinners(active, room.communityCards);
            const prize = Math.floor(room.pot / winners.length);
            winners.forEach(w => {
                const p = room.players.find(pl => pl.id === w.id);
                p.chips += prize;
            });
            endGame(roomCode, `결과: ${winners.map(w => w.nickname).join(', ')} 승리!`);
        } else {
            io.to(roomCode).emit('roomUpdate', room);
        }
    });

    function solveWinners(players, community) {
        let bestScore = -1;
        let winners = [];
        players.forEach(p => {
            const hand = Solver.solve([...p.cards, ...community]);
            p.solvedHand = hand;
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
        
        // 최종 손익 계산 (이번 판의 결과 반영)
        room.players.forEach(p => {
            // 이번 판에 번 돈 = 현재 칩 - (판 시작 전 칩) 을 구하기 위해 totalBet 활용
            // 또는 간단히: winner인 경우 획득액 - 배팅액, 패자인 경우 -배팅액
            // 여기서는 최종 결과 시점의 차액을 표시
            p.profit = (p.chips - (p.chips + p.totalBet - (room.pot/room.players.filter(pl=>room.players.indexOf(pl)===-1).length || 0))); 
            // 더 직관적인 계산: 
            // 획득한 상금이 있다면 그 상금 - 자신이 낸 돈, 없다면 -자신이 낸 돈
        });

        // 실제 손익 재계산 로직
        const winnersIds = solveWinners(room.players.filter(p=>!p.folded), room.communityCards).map(w=>w.id);
        const prize = Math.floor(room.pot / (winnersIds.length || 1));
        
        room.players.forEach(p => {
            if (winnersIds.includes(p.id)) {
                p.profit = prize - p.totalBet;
            } else {
                p.profit = -p.totalBet;
            }
        });

        room.gameState = 'waiting';
        room.statusMsg = msg; // 팝업 대신 메시지로 저장
        room.players.forEach(p => { p.isReady = false; });
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