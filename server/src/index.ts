import http from 'http';
import https from 'https';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { api } from './api';
import { setupRealtime } from './realtime';

const PORT = Number(process.env.PORT) || 3000;

// HTTPS включается, если заданы пути к сертификату и ключу:
//   TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem node dist/index.js
// (например сертификаты Let's Encrypt на боевом сервере). Если переменных нет —
// поднимается обычный HTTP (локальная разработка, либо TLS терминирует Caddy/nginx).
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'meshvoice-server' });
});

app.use('/api', api);

let server: http.Server | https.Server;
let scheme: string;
if (TLS_CERT && TLS_KEY) {
  server = https.createServer(
    {
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
      // Опциональная цепочка CA, если серт не полный (fullchain уже включает её).
      ...(process.env.TLS_CA ? { ca: fs.readFileSync(process.env.TLS_CA) } : {}),
    },
    app
  );
  scheme = 'https';
} else {
  server = http.createServer(app);
  scheme = 'http';
}

// socket.io на том же сервере: и сигналинг голосовых комнат, и realtime соцсети.
// Наследует HTTP/HTTPS автоматически, отдельного порта не требует.
const io = new Server(server, { cors: { origin: '*' } });
setupRealtime(io);

server.listen(PORT, () => {
  console.log(`🚀 MeshVoice-сервер запущен на ${scheme}://0.0.0.0:${PORT}`);
});
