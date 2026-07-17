import type { Server } from 'socket.io';
import { verifyToken } from './auth';
import { friendIdsOf } from './db';

let io: Server | null = null;

// userId -> количество активных сокетов (несколько устройств/переподключения)
const online = new Map<number, number>();

// Живые позиции (в памяти — история не хранится)
export type LiveLocation = {
  lat: number;
  lng: number;
  speed: number; // км/ч
  heading: number;
  updatedAt: number;
};
const locations = new Map<number, LiveLocation>();

export function getLiveLocation(userId: number): LiveLocation | undefined {
  const loc = locations.get(userId);
  // Позиция старше 5 минут считается неактуальной
  if (loc && Date.now() - loc.updatedAt > 5 * 60 * 1000) return undefined;
  return loc;
}

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

    // ---------- Живые позиции (карта друзей / заезды) ----------

    socket.on('loc:update', (data: any) => {
      const uid = socket.data.userId as number | undefined;
      if (!uid) return;
      const loc: LiveLocation = {
        lat: Number(data?.lat),
        lng: Number(data?.lng),
        speed: Math.max(0, Number(data?.speed) || 0),
        heading: Number(data?.heading) || 0,
        updatedAt: Date.now(),
      };
      if (!isFinite(loc.lat) || !isFinite(loc.lng)) return;
      locations.set(uid, loc);
      for (const fid of friendIdsOf(uid)) {
        if (isOnline(fid)) {
          server.to(`user:${fid}`).emit('loc:friend', { userId: uid, ...loc });
        }
      }
    });

    socket.on('loc:stop', () => {
      const uid = socket.data.userId as number | undefined;
      if (!uid) return;
      locations.delete(uid);
      for (const fid of friendIdsOf(uid)) {
        if (isOnline(fid)) {
          server.to(`user:${fid}`).emit('loc:friend-stop', { userId: uid });
        }
      }
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
