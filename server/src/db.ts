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
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL REFERENCES chats(id),
  sender_id       INTEGER NOT NULL REFERENCES users(id),
  text            TEXT    NOT NULL,
  reply_to        INTEGER REFERENCES messages(id),
  edited_at       INTEGER,
  attachment_url  TEXT,
  attachment_type TEXT,
  created_at      INTEGER NOT NULL
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
  path       TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ride_id, user_id)
);

-- Постоянные маршруты пользователя (в отличие от заездов — не соревнование,
-- а сохранённый трек: «как я проехал»). visibility: private | friends | public.
CREATE TABLE IF NOT EXISTS routes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT    NOT NULL,
  track      TEXT    NOT NULL,
  distance   REAL    NOT NULL DEFAULT 0,
  visibility TEXT    NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','friends','public')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  title      TEXT    NOT NULL,
  note       TEXT,
  place      TEXT,
  lat        REAL,
  lng        REAL,
  route_id   INTEGER REFERENCES routes(id),
  photo      TEXT,
  visibility TEXT    NOT NULL DEFAULT 'friends',
  start_at   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_members (
  event_id  INTEGER NOT NULL REFERENCES events(id),
  user_id   INTEGER NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS map_pins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  lat        REAL    NOT NULL,
  lng        REAL    NOT NULL,
  title      TEXT    NOT NULL,
  note       TEXT,
  emoji      TEXT,
  media_url  TEXT,
  media_type TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_friendships_to ON friendships(to_id, status);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_routes_user ON routes(user_id);
CREATE INDEX IF NOT EXISTS idx_routes_visibility ON routes(visibility);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
`);

// Миграции для баз, созданных до появления новых колонок
const migrations = [
  'ALTER TABLE chat_members ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE rides ADD COLUMN track TEXT',
  'ALTER TABLE ride_members ADD COLUMN checkpoint INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE ride_members ADD COLUMN last_lat REAL',
  'ALTER TABLE ride_members ADD COLUMN last_lng REAL',
  'ALTER TABLE ride_members ADD COLUMN last_ts INTEGER',
  'ALTER TABLE ride_members ADD COLUMN path TEXT',
  'ALTER TABLE messages ADD COLUMN reply_to INTEGER',
  'ALTER TABLE messages ADD COLUMN edited_at INTEGER',
  'ALTER TABLE events ADD COLUMN lat REAL',
  'ALTER TABLE events ADD COLUMN lng REAL',
  'ALTER TABLE events ADD COLUMN route_id INTEGER',
  'ALTER TABLE events ADD COLUMN photo TEXT',
  'ALTER TABLE messages ADD COLUMN attachment_url TEXT',
  'ALTER TABLE messages ADD COLUMN attachment_type TEXT',
  'ALTER TABLE messages ADD COLUMN attachments TEXT',
  'ALTER TABLE map_pins ADD COLUMN emoji TEXT',
  "ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'friends'",
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

    // Реально пройденный трек участника (для отрисовки цветной линии на карте).
    // Прореживаем: точку добавляем, если сдвинулись >8м от последней сохранённой,
    // и ограничиваем ~2000 точек (при переполнении отбрасываем самые старые).
    let path: { lat: number; lng: number }[] = [];
    try {
      if (m.path) path = JSON.parse(m.path);
    } catch {}
    const tail = path[path.length - 1];
    if (!tail || haversineMeters(tail, { lat, lng }) > 8) {
      path.push({ lat, lng });
      if (path.length > 2000) path.splice(0, path.length - 2000);
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
           last_lat = ?, last_lng = ?, last_ts = ?, path = ?, updated_at = ?
       WHERE ride_id = ? AND user_id = ?`
    ).run(
      distance, maxSpeed, Math.round(avgSpeed * 10) / 10, duration, checkpoint,
      lat, lng, nowTs, JSON.stringify(path), nowTs, m.ride_id, userId
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

export function chatMemberIds(chatId: number): number[] {
  const rows: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  return rows.map((r) => r.user_id as number);
}

// ---------- События (совместные поездки) ----------

export function eventInfo(eventId: number, viewerId?: number) {
  const e: any = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!e) return null;
  const members: any[] = db
    .prepare(
      `SELECT u.* FROM event_members em JOIN users u ON u.id = em.user_id
       WHERE em.event_id = ? ORDER BY em.joined_at`
    )
    .all(eventId);
  let route: { id: number; name: string } | null = null;
  if (e.route_id) {
    const r: any = db.prepare('SELECT id, name FROM routes WHERE id = ?').get(e.route_id);
    if (r) route = { id: r.id, name: r.name };
  }
  return {
    id: e.id,
    title: e.title,
    note: e.note || null,
    place: e.place || null,
    lat: e.lat ?? null,
    lng: e.lng ?? null,
    route,
    photo: e.photo || null,
    visibility: (e.visibility || 'friends') as 'all' | 'friends',
    startAt: e.start_at,
    finished: e.start_at <= Date.now(),
    createdAt: e.created_at,
    creator: getUserById(e.creator_id),
    participants: members.map((m) => publicUser(m)),
    count: members.length,
    mine: viewerId != null && e.creator_id === viewerId,
    joined: viewerId != null && members.some((m) => m.id === viewerId),
  };
}

// ---------- Маршруты ----------

// Маршрут виден: владельцу всегда; публичный — всем; friends — только друзьям.
export function canSeeRoute(route: any, userId: number): boolean {
  if (!route) return false;
  if (route.user_id === userId) return true;
  if (route.visibility === 'public') return true;
  if (route.visibility === 'friends') return areFriends(route.user_id, userId);
  return false;
}

// Формат маршрута для клиента. viewerId — чтобы проставить mine.
export function routeInfo(route: any, viewerId: number) {
  if (!route) return null;
  let track: { lat: number; lng: number }[] = [];
  try {
    track = JSON.parse(route.track);
  } catch {}
  return {
    id: route.id as number,
    name: route.name as string,
    distance: route.distance as number,
    visibility: route.visibility as 'private' | 'friends' | 'public',
    createdAt: route.created_at as number,
    owner: getUserById(route.user_id),
    mine: route.user_id === viewerId,
    track,
  };
}
