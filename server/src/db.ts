import { DatabaseSync } from 'node:sqlite';
import path from 'path';

// База — один файл рядом с сервером. Для бэкапа достаточно скопировать его.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'meshvoice.db');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  avatar        TEXT    NOT NULL DEFAULT '🏍️',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friendships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES users(id),
  to_id      INTEGER NOT NULL REFERENCES users(id),
  status     TEXT    NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK (type IN ('dm', 'group')),
  name       TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id      INTEGER NOT NULL REFERENCES chats(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  joined_at    INTEGER NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL REFERENCES chats(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  status      TEXT    NOT NULL CHECK (status IN ('active', 'finished')),
  track       TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS ride_members (
  ride_id    INTEGER NOT NULL REFERENCES rides(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  joined_at  INTEGER NOT NULL,
  distance   REAL    NOT NULL DEFAULT 0,
  max_speed  REAL    NOT NULL DEFAULT 0,
  avg_speed  REAL    NOT NULL DEFAULT 0,
  duration   INTEGER NOT NULL DEFAULT 0,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  last_lat   REAL,
  last_lng   REAL,
  last_ts    INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ride_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_friendships_to ON friendships(to_id, status);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
`);

// Миграции для баз, созданных до появления новых колонок
const migrations = [
  'ALTER TABLE chat_members ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE rides ADD COLUMN track TEXT',
  'ALTER TABLE ride_members ADD COLUMN checkpoint INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE ride_members ADD COLUMN last_lat REAL',
  'ALTER TABLE ride_members ADD COLUMN last_lng REAL',
  'ALTER TABLE ride_members ADD COLUMN last_ts INTEGER',
];
for (const m of migrations) {
  try {
    db.exec(m);
  } catch {
    // колонка уже есть
  }
}

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Накопление статистики заезда по входящей позиции. Вызывается на каждый
// location-апдейт (сокет или REST) — работает одинаково для переднего
// плана и фонового трекинга.
export function accumulateRideStats(userId: number, lat: number, lng: number, speedKmh: number) {
  const memberships: any[] = db
    .prepare(
      `SELECT m.*, r.track FROM ride_members m
       JOIN rides r ON r.id = m.ride_id
       WHERE m.user_id = ? AND r.status = 'active'`
    )
    .all(userId);

  const nowTs = Date.now();
  for (const m of memberships) {
    let distance = m.distance as number;
    let checkpoint = m.checkpoint as number;

    if (m.last_lat != null && m.last_lng != null) {
      const d = haversineMeters({ lat: m.last_lat, lng: m.last_lng }, { lat, lng });
      // отсекаем дрожание GPS (<1м) и телепорты (>500м между тиками)
      if (d > 1 && d < 500) distance += d;
    }

    // Прогресс по трассе: чекпоинт засчитывается в радиусе 60 метров
    if (m.track) {
      try {
        const points: { lat: number; lng: number }[] = JSON.parse(m.track);
        while (
          checkpoint < points.length &&
          haversineMeters(points[checkpoint], { lat, lng }) < 60
        ) {
          checkpoint++;
        }
      } catch {}
    }

    const duration = Math.max(0, Math.round((nowTs - m.joined_at) / 1000));
    const maxSpeed = Math.max(m.max_speed, Math.min(speedKmh, 350));
    const avgSpeed = duration > 30 ? distance / 1000 / (duration / 3600) : 0;

    db.prepare(
      `UPDATE ride_members
       SET distance = ?, max_speed = ?, avg_speed = ?, duration = ?, checkpoint = ?,
           last_lat = ?, last_lng = ?, last_ts = ?, updated_at = ?
       WHERE ride_id = ? AND user_id = ?`
    ).run(
      distance, maxSpeed, Math.round(avgSpeed * 10) / 10, duration, checkpoint,
      lat, lng, nowTs, nowTs, m.ride_id, userId
    );
  }
}

export type PublicUser = {
  id: number;
  username: string;
  displayName: string;
  avatar: string;
};

export function publicUser(row: any): PublicUser {
  return {
    id: row.id as number,
    username: row.username as string,
    displayName: row.display_name as string,
    avatar: row.avatar as string,
  };
}

export function getUserById(id: number): PublicUser | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? publicUser(row) : null;
}

// Дружба в любом направлении со статусом accepted
export function areFriends(a: number, b: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`
    )
    .get(a, b, b, a);
  return !!row;
}

export function isChatMember(chatId: number, userId: number): boolean {
  const row = db
    .prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, userId);
  return !!row;
}

// id всех принятых друзей пользователя
export function friendIdsOf(userId: number): number[] {
  const rows: any[] = db
    .prepare(
      `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS fid
       FROM friendships WHERE status = 'accepted' AND (from_id = ? OR to_id = ?)`
    )
    .all(userId, userId, userId);
  return rows.map((r) => r.fid as number);
}
