import { io, Socket } from 'socket.io-client';
import { getApiBase, getToken } from './api';

// Один общий сокет для realtime соцсети (сообщения, заявки, presence).
// Голосовые комнаты в three.tsx используют своё отдельное подключение —
// не трогаем его, чтобы не мешать сигналингу звонков.
let socket: Socket | null = null;
let currentKey = '';

export async function getSocialSocket(): Promise<Socket | null> {
  const token = await getToken();
  if (!token) {
    closeSocialSocket();
    return null;
  }
  const base = await getApiBase();
  const key = `${base}|${token}`;
  if (socket && currentKey === key && socket.connected) return socket;
  if (socket && currentKey !== key) {
    socket.disconnect();
    socket = null;
  }
  if (!socket) {
    socket = io(base, {
      // Через dev-tunnel «чистый» websocket часто не апгрейдится/рвётся —
      // разрешаем polling как фолбэк, иначе клиент реконнектится по кругу.
      transports: ['websocket', 'polling'],
      reconnection: true,
      auth: { token },
    });
    currentKey = key;
  }
  return socket;
}

export function closeSocialSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
    currentKey = '';
  }
}
