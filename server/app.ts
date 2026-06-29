import { Server } from "socket.io";

const PORT = 3000;
const io = new Server({ cors: { origin: "*" } });

// Заменить в будущем на бд или другое хранилище 
const roomsData: { [key: string]: any[] } = {};

io.on("connection", (socket) => {
  console.log("✅ Юзер подключился:", socket.id);

  socket.on("join-room", (roomId: string, userName: string) => {
    socket.join(roomId);
    
    // 1. Инициализируем историю комнаты, если её нет
    if (!roomsData[roomId]) {
      roomsData[roomId] = [];
    }

    // 2. Отправляем новичку историю сообщений этой комнаты
    socket.emit("chat-history", roomsData[roomId]);

    // 3. Уведомляем остальных
    socket.to(roomId).emit("user-joined", { id: socket.id, name: userName });
    console.log(`👤 ${userName} зашел в комнату: ${roomId}. Истории: ${roomsData[roomId].length}`);
  });

  socket.on("chat", (roomId: string, msg: any) => {
    // Сохраняем сообщение в историю сервера
    if (roomsData[roomId]) {
      const messageWithId = { ...msg, id: Date.now().toString() };
      roomsData[roomId].push(messageWithId);
      if (roomsData[roomId].length > 50) {
        roomsData[roomId].shift();
      }
      socket.to(roomId).emit("chat", messageWithId);
    }
  });

  socket.on("signal", (to: string, data: any) => {
    io.to(to).emit("signal", socket.id, data);
  });

  socket.on("disconnect", () => {
    io.emit("user-left", socket.id);
    console.log("❌ Юзер отключился:", socket.id);
  });
});

io.listen(PORT);
console.log(`🚀 Мессенджер-сервер запущен на порту ${PORT}`);
