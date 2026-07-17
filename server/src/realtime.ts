import type { Server } from 'socket.io';
import { verifyToken } from './auth';

let io: Server | null = null;

// userId -> количество активных сокетов (несколько устройств/переподключения)
const online = new Map<number, number>();

export function isOnline(userId: number): boolean {
  return (online.get(userId) || 0) > 0;
}

// Доставить событие во все сокеты пользователя
export function notifyUser(userId: number, event: string, payload: any) {
  io?.to(`user:${userId}`).emit(event, payload);
}

// Хранилище истории голосовых комнат (как в старом сервере, в памяти)
const roomsData: { [key: string]: any[] } = {};

export function setupRealtime(server: Server) {
  io = server;

  server.on('connection', (socket) => {
    // Авторизация опциональна: старый голосовой клиент подключается без токена,
    // и это должно продолжать работать.
    const token = socket.handshake.auth?.token;
    const userId = typeof token === 'string' ? verifyToken(token) : null;

    if (userId) {
      socket.data.userId = userId;
      socket.join(`user:${userId}`);
      online.set(userId, (online.get(userId) || 0) + 1);
      console.log(`🟢 user:${userId} online (сокетов: ${online.get(userId)})`);
    } else {
      console.log('✅ Анонимный (голосовой) клиент подключился:', socket.id);
    }

    // ---------- Legacy: голосовые комнаты INTERNET CALL ----------

    socket.on('join-room', (roomId: string, userName: string) => {
      socket.join(roomId);
      if (!roomsData[roomId]) roomsData[roomId] = [];
      socket.emit('chat-history', roomsData[roomId]);
      socket.to(roomId).emit('user-joined', { id: socket.id, name: userName });
      console.log(`👤 ${userName} зашел в комнату: ${roomId}`);
    });

    socket.on('chat', (roomId: string, msg: any) => {
      if (roomsData[roomId]) {
        const messageWithId = { ...msg, id: Date.now().toString() };
        roomsData[roomId].push(messageWithId);
        if (roomsData[roomId].length > 50) roomsData[roomId].shift();
        socket.to(roomId).emit('chat', messageWithId);
      }
    });

    socket.on('signal', (to: string, data: any) => {
      server.to(to).emit('signal', socket.id, data);
    });

    // ---------- Отключение ----------

    socket.on('disconnect', () => {
      server.emit('user-left', socket.id);
      const uid = socket.data.userId as number | undefined;
      if (uid) {
        const count = (online.get(uid) || 1) - 1;
        if (count <= 0) online.delete(uid);
        else online.set(uid, count);
        console.log(`⚪ user:${uid} отключился (осталось сокетов: ${count})`);
      }
    });
  });
}
