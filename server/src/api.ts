import { Router } from 'express';
import type { Response } from 'express';
import { db, publicUser, getUserById, areFriends, isChatMember, PublicUser } from './db';
import { hashPassword, checkPassword, signToken, requireAuth, AuthedRequest } from './auth';
import { isOnline, notifyUser } from './realtime';

export const api = Router();

const now = () => Date.now();

// ---------- Аккаунты ----------

api.post('/register', (req, res) => {
  const { username, password, displayName, avatar } = req.body || {};
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Логин: 3–20 символов, латиница/цифры/_' });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Пароль: минимум 4 символа' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Логин уже занят' });

  const name = (typeof displayName === 'string' && displayName.trim()) || username;
  const av = (typeof avatar === 'string' && avatar) || '🏍️';
  const result = db
    .prepare('INSERT INTO users (username, password_hash, display_name, avatar, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, hashPassword(password), name.trim().slice(0, 40), av.slice(0, 8), now());
  const id = Number(result.lastInsertRowid);
  res.json({ token: signToken(id), user: getUserById(id) });
});

api.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const row: any = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!row || !checkPassword(String(password || ''), row.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  res.json({ token: signToken(row.id), user: publicUser(row) });
});

api.get('/me', requireAuth, (req, res) => {
  const me = getUserById((req as AuthedRequest).userId);
  if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: me });
});

api.put('/me', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const { displayName, avatar } = req.body || {};
  if (typeof displayName === 'string' && displayName.trim()) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName.trim().slice(0, 40), userId);
  }
  if (typeof avatar === 'string' && avatar) {
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar.slice(0, 8), userId);
  }
  res.json({ user: getUserById(userId) });
});

// ---------- Поиск ----------

api.get('/users/search', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });

  const rows: any[] = db
    .prepare(
      `SELECT * FROM users
       WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)
       ORDER BY username LIMIT 20`
    )
    .all(userId, `%${q}%`, `%${q}%`);

  const users = rows.map((row) => {
    const rel: any = db
      .prepare(
        `SELECT from_id, status FROM friendships
         WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`
      )
      .get(userId, row.id, row.id, userId);
    let relation: string = 'none';
    if (rel) {
      if (rel.status === 'accepted') relation = 'friends';
      else relation = rel.from_id === userId ? 'pending_out' : 'pending_in';
    }
    return { ...publicUser(row), relation };
  });
  res.json({ users });
});

// ---------- Друзья ----------

api.get('/friends', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;

  const friendRows: any[] = db
    .prepare(
      `SELECT u.*, f.id AS fid FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.from_id = ? THEN f.to_id ELSE f.from_id END
       WHERE f.status = 'accepted' AND (f.from_id = ? OR f.to_id = ?)`
    )
    .all(userId, userId, userId);

  const incoming: any[] = db
    .prepare(
      `SELECT u.* FROM friendships f JOIN users u ON u.id = f.from_id
       WHERE f.to_id = ? AND f.status = 'pending'`
    )
    .all(userId);

  const outgoing: any[] = db
    .prepare(
      `SELECT u.* FROM friendships f JOIN users u ON u.id = f.to_id
       WHERE f.from_id = ? AND f.status = 'pending'`
    )
    .all(userId);

  res.json({
    friends: friendRows.map((r) => ({ ...publicUser(r), online: isOnline(r.id) })),
    incoming: incoming.map(publicUser),
    outgoing: outgoing.map(publicUser),
  });
});

api.post('/friends/request', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const targetId = Number(req.body?.userId);
  if (!targetId || targetId === userId || !getUserById(targetId)) {
    return res.status(400).json({ error: 'Некорректный пользователь' });
  }
  const existing: any = db
    .prepare(
      `SELECT * FROM friendships
       WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`
    )
    .get(userId, targetId, targetId, userId);

  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Вы уже друзья' });
    // Встречная заявка — принимаем сразу
    if (existing.from_id === targetId) {
      db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(existing.id);
      notifyUser(targetId, 'friends:update', {});
      return res.json({ ok: true, accepted: true });
    }
    return res.status(409).json({ error: 'Заявка уже отправлена' });
  }

  db.prepare('INSERT INTO friendships (from_id, to_id, status, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, targetId, 'pending', now());
  notifyUser(targetId, 'friends:update', {});
  res.json({ ok: true });
});

api.post('/friends/respond', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const fromId = Number(req.body?.userId);
  const accept = !!req.body?.accept;
  const row: any = db
    .prepare("SELECT * FROM friendships WHERE from_id = ? AND to_id = ? AND status = 'pending'")
    .get(fromId, userId);
  if (!row) return res.status(404).json({ error: 'Заявка не найдена' });

  if (accept) {
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(row.id);
  } else {
    db.prepare('DELETE FROM friendships WHERE id = ?').run(row.id);
  }
  notifyUser(fromId, 'friends:update', {});
  res.json({ ok: true });
});

api.delete('/friends/:userId', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const otherId = Number(req.params.userId);
  db.prepare(
    `DELETE FROM friendships
     WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`
  ).run(userId, otherId, otherId, userId);
  notifyUser(otherId, 'friends:update', {});
  res.json({ ok: true });
});

// ---------- Чаты ----------

function chatInfo(chatId: number, forUserId: number) {
  const chat: any = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return null;
  const members: any[] = db
    .prepare(
      `SELECT u.* FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ?`
    )
    .all(chatId);
  const last: any = db
    .prepare(
      `SELECT m.*, u.display_name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 1`
    )
    .get(chatId);

  const others = members.filter((m) => m.id !== forUserId);
  const title =
    chat.type === 'dm'
      ? others[0]?.display_name || 'Диалог'
      : chat.name || 'Группа';
  const avatar = chat.type === 'dm' ? others[0]?.avatar || '👤' : '👥';

  return {
    id: chat.id,
    type: chat.type,
    title,
    avatar,
    members: members.map((m) => ({ ...publicUser(m), online: isOnline(m.id) })),
    lastMessage: last
      ? { text: last.text, senderName: last.sender_name, createdAt: last.created_at }
      : null,
  };
}

api.get('/chats', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const rows: any[] = db
    .prepare(
      `SELECT c.id, MAX(COALESCE(m.id, 0)) AS last_msg
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
       LEFT JOIN messages m ON m.chat_id = c.id
       GROUP BY c.id ORDER BY last_msg DESC`
    )
    .all(userId);
  res.json({ chats: rows.map((r) => chatInfo(r.id, userId)).filter(Boolean) });
});

api.get('/chats/:id', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  res.json({ chat: chatInfo(chatId, userId) });
});

api.post('/chats/dm', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const otherId = Number(req.body?.userId);
  if (!otherId || !getUserById(otherId)) return res.status(400).json({ error: 'Некорректный пользователь' });
  if (!areFriends(userId, otherId)) return res.status(403).json({ error: 'Личный чат доступен только друзьям' });

  const existing: any = db
    .prepare(
      `SELECT c.id FROM chats c
       JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
       JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
       WHERE c.type = 'dm' LIMIT 1`
    )
    .get(userId, otherId);
  if (existing) return res.json({ chat: chatInfo(existing.id, userId) });

  const result = db
    .prepare("INSERT INTO chats (type, created_by, created_at) VALUES ('dm', ?, ?)")
    .run(userId, now());
  const chatId = Number(result.lastInsertRowid);
  const addMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)');
  addMember.run(chatId, userId, now());
  addMember.run(chatId, otherId, now());
  notifyUser(otherId, 'chats:update', {});
  res.json({ chat: chatInfo(chatId, userId) });
});

api.post('/chats/group', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const name = String(req.body?.name || '').trim();
  const memberIds: number[] = Array.isArray(req.body?.memberIds)
    ? req.body.memberIds.map(Number).filter((n: number) => n && n !== userId)
    : [];
  if (!name) return res.status(400).json({ error: 'Введите название группы' });
  if (memberIds.length < 1) return res.status(400).json({ error: 'Добавьте хотя бы одного друга' });
  for (const id of memberIds) {
    if (!areFriends(userId, id)) {
      return res.status(403).json({ error: 'В группу можно добавлять только друзей' });
    }
  }

  const result = db
    .prepare("INSERT INTO chats (type, name, created_by, created_at) VALUES ('group', ?, ?, ?)")
    .run(name.slice(0, 40), userId, now());
  const chatId = Number(result.lastInsertRowid);
  const addMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)');
  addMember.run(chatId, userId, now());
  for (const id of memberIds) {
    addMember.run(chatId, id, now());
    notifyUser(id, 'chats:update', {});
  }
  res.json({ chat: chatInfo(chatId, userId) });
});

// ---------- Сообщения ----------

api.get('/chats/:id/messages', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });

  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const rows: any[] = db
    .prepare(
      `SELECT m.*, u.username, u.display_name, u.avatar FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = ? AND m.id < ?
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(chatId, before, limit);

  res.json({
    messages: rows.reverse().map((r) => ({
      id: r.id,
      chatId,
      text: r.text,
      createdAt: r.created_at,
      sender: { id: r.sender_id, username: r.username, displayName: r.display_name, avatar: r.avatar },
    })),
  });
});

api.post('/chats/:id/messages', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

  const result = db
    .prepare('INSERT INTO messages (chat_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(chatId, userId, text.slice(0, 2000), now());

  const sender = getUserById(userId) as PublicUser;
  const message = {
    id: Number(result.lastInsertRowid),
    chatId,
    text: text.slice(0, 2000),
    createdAt: now(),
    sender,
  };

  // Realtime-доставка всем участникам (включая другие устройства отправителя)
  const members: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  for (const m of members) {
    notifyUser(m.user_id, 'chat:new', message);
  }
  res.json({ message });
});
