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

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_friendships_to ON friendships(to_id, status);
`);

// Миграция для баз, созданных до появления счётчика непрочитанных
try {
  db.exec('ALTER TABLE chat_members ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0');
} catch {
  // колонка уже есть
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
