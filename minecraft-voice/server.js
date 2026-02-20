const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer'); // ДОБАВЛЕНО: Свой сигнальный сервер
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- АНТИ-БЛОК: Встраиваем свой PeerJS сервер ---
// Теперь нам не нужно публичное облако, которое блокируют провайдеры РФ.
// Все подключения идут строго на наш сервер.
const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/'
});
app.use('/peerjs', peerServer); // Сигнальный трафик пойдет по адресу /peerjs
// ------------------------------------------------

// Раздаем index.html из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация базы данных SQLite
const db = new sqlite3.Database('./voicechat.db', (err) => {
    if (err) console.error('Ошибка подключения к БД:', err.message);
    else console.log('✅ Подключено к базе данных SQLite.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (
        session_id TEXT PRIMARY KEY, room_id TEXT, peer_id TEXT, 
        nickname TEXT, is_muted INTEGER DEFAULT 0, is_online INTEGER DEFAULT 1, 
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Обработка подключений по Socket.IO
io.on('connection', (socket) => {
    console.log(`🔌 Новое подключение Socket: ${socket.id}`);

    socket.on('join_room', (data) => {
        const { sessionId, roomId, peerId, nickname } = data;
        socket.sessionId = sessionId; socket.roomId = roomId;
        socket.join(roomId);

        db.run(`INSERT OR IGNORE INTO rooms (id) VALUES (?)`, [roomId]);
        db.run(`
            INSERT INTO users (session_id, room_id, peer_id, nickname, is_online, last_seen) 
            VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id) DO UPDATE SET 
                room_id = excluded.room_id, peer_id = excluded.peer_id,
                nickname = excluded.nickname, is_online = 1, last_seen = CURRENT_TIMESTAMP
        `, [sessionId, roomId, peerId, nickname], () => {
            db.all(`SELECT session_id, peer_id, nickname, is_muted FROM users WHERE room_id = ? AND is_online = 1`, [roomId], (err, users) => {
                if (err) return console.error(err);
                socket.emit('room_state', users);
                socket.to(roomId).emit('user_joined', { sessionId, peerId, nickname, isMuted: 0 });
                console.log(`🟢 ${nickname} зашел в комнату ${roomId}`);
            });
        });
    });

    socket.on('toggle_mute', (isMuted) => {
        if (!socket.sessionId || !socket.roomId) return;
        db.run(`UPDATE users SET is_muted = ? WHERE session_id = ?`, [isMuted ? 1 : 0, socket.sessionId]);
        socket.to(socket.roomId).emit('user_muted', { sessionId: socket.sessionId, isMuted: isMuted });
    });

    socket.on('leave_room', () => {
        if (!socket.sessionId || !socket.roomId) return;
        db.run(`UPDATE users SET is_online = 0 WHERE session_id = ?`, [socket.sessionId]);
        socket.to(socket.roomId).emit('user_left', { sessionId: socket.sessionId });
        socket.leave(socket.roomId);
    });

    socket.on('disconnect', () => {
        if (socket.sessionId && socket.roomId) {
            db.run(`UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE session_id = ?`, [socket.sessionId]);
            socket.to(socket.roomId).emit('user_disconnected', { sessionId: socket.sessionId });
        }
    });
});

const PORT = process.env.PORT || 8080; 

// ОБЯЗАТЕЛЬНО указываем '0.0.0.0', чтобы Railway смог пробросить трафик из интернета
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🔗 Сигнальный сервер WebRTC доступен по пути /peerjs`);
});
