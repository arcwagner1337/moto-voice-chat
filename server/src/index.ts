import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { api } from './api';
import { setupRealtime } from './realtime';

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'meshvoice-server' });
});

app.use('/api', api);

const server = http.createServer(app);

// socket.io на том же порту: и сигналинг голосовых комнат, и realtime соцсети
const io = new Server(server, { cors: { origin: '*' } });
setupRealtime(io);

server.listen(PORT, () => {
  console.log(`🚀 MeshVoice-сервер запущен на порту ${PORT}`);
});
