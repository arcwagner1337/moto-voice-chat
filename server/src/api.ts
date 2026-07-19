import { Router } from 'express';
import type { Response } from 'express';
import {
  db, publicUser, getUserById, areFriends, isChatMember, friendIdsOf, PublicUser,
  canSeeRoute, routeInfo, haversineMeters,
} from './db';
import { hashPassword, checkPassword, signToken, requireAuth, AuthedRequest } from './auth';
import { isOnline, notifyUser, getLiveLocation, storeLocation } from './realtime';

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
      notifyUser(targetId, 'friend:accepted', { from: getUserById(userId) });
      return res.json({ ok: true, accepted: true });
    }
    return res.status(409).json({ error: 'Заявка уже отправлена' });
  }

  db.prepare('INSERT INTO friendships (from_id, to_id, status, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, targetId, 'pending', now());
  notifyUser(targetId, 'friends:update', {});
  notifyUser(targetId, 'friend:request', { from: getUserById(userId) });
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
    notifyUser(fromId, 'friend:accepted', { from: getUserById(userId) });
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

  const meMember: any = db
    .prepare('SELECT last_read_id FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, forUserId);
  const unreadRow: any = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ? AND id > ? AND sender_id != ?')
    .get(chatId, meMember?.last_read_id || 0, forUserId);

  return {
    id: chat.id,
    type: chat.type,
    title,
    avatar,
    createdBy: chat.created_by,
    unread: unreadRow?.c || 0,
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

// Добавить людей в существующую группу. Может любой участник,
// добавлять можно только своих друзей (как при создании группы).
api.post('/chats/:id/members', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  const chat: any = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || !isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  if (chat.type !== 'group') return res.status(400).json({ error: 'Добавлять можно только в группу' });

  const memberIds: number[] = Array.isArray(req.body?.memberIds)
    ? req.body.memberIds.map(Number).filter((n: number) => n && n !== userId)
    : [];
  if (memberIds.length < 1) return res.status(400).json({ error: 'Выберите хотя бы одного друга' });
  for (const id of memberIds) {
    if (!areFriends(userId, id)) {
      return res.status(403).json({ error: 'Добавлять можно только своих друзей' });
    }
  }

  const addMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)');
  for (const id of memberIds) {
    if (!isChatMember(chatId, id)) addMember.run(chatId, id, now());
  }
  const members: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  for (const m of members) notifyUser(m.user_id, 'chats:update', {});
  res.json({ chat: chatInfo(chatId, userId) });
});

// Удалить участника из группы. Создатель может убрать любого; любой участник
// может выйти сам (удалить себя). Создателя убрать нельзя.
api.delete('/chats/:id/members/:userId', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const chat: any = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || !isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  if (chat.type !== 'group') return res.status(400).json({ error: 'Только для групп' });
  if (!targetId || !isChatMember(chatId, targetId))
    return res.status(404).json({ error: 'Участник не найден' });
  if (targetId === chat.created_by)
    return res.status(400).json({ error: 'Нельзя удалить создателя группы' });
  const isOwner = userId === chat.created_by;
  if (!isOwner && targetId !== userId)
    return res.status(403).json({ error: 'Удалять участников может только создатель группы' });

  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, targetId);
  // Оповещаем оставшихся и самого удалённого (у него чат пропадёт из списка).
  const members: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  for (const m of members) notifyUser(m.user_id, 'chats:update', {});
  notifyUser(targetId, 'chats:update', {});
  res.json({ chat: isChatMember(chatId, userId) ? chatInfo(chatId, userId) : null });
});

// Звонок в чате: участникам уходит realtime-событие «входящий звонок»
// с комнатой INTERNET CALL этого чата (chat-<id>).
api.post('/chats/:id/call', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  const from = getUserById(userId);
  // Случайная скрытая комната на каждый звонок: угадать/зайти без приглашения
  // нельзя. Room-id знают только участники чата (приходит в call:incoming) и
  // звонящий (в ответе). Ручной вход по имени комнаты (общий войс) не трогаем.
  const room = `call-${chatId}-${crypto.randomUUID()}`;
  const members: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  for (const m of members) {
    if (m.user_id === userId) continue;
    const info = chatInfo(chatId, m.user_id);
    notifyUser(m.user_id, 'call:incoming', {
      chatId,
      room,
      title: info?.title || 'Чат',
      from,
    });
  }
  res.json({ ok: true, room });
});

api.post('/chats/:id/read', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  const lastId = Number(req.body?.lastId) || 0;
  db.prepare(
    'UPDATE chat_members SET last_read_id = MAX(last_read_id, ?) WHERE chat_id = ? AND user_id = ?'
  ).run(lastId, chatId, userId);
  res.json({ ok: true });
});

// ---------- Позиции друзей ----------

// Приём позиции по REST — используется фоновым трекингом (сокет в фоне
// может быть мёртв, обычный fetch надёжнее)
api.post('/location', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  if (!storeLocation(userId, req.body)) {
    return res.status(400).json({ error: 'Некорректные координаты' });
  }
  res.json({ ok: true });
});

api.get('/locations', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const result: any[] = [];
  for (const fid of friendIdsOf(userId)) {
    const loc = getLiveLocation(fid);
    if (loc) {
      const user = getUserById(fid);
      if (user) result.push({ ...loc, user: { ...user, online: isOnline(fid) } });
    }
  }
  res.json({ locations: result });
});

// ---------- Заезды ----------

function canSeeRide(rideId: number, userId: number): boolean {
  const isMember = db
    .prepare('SELECT 1 FROM ride_members WHERE ride_id = ? AND user_id = ?')
    .get(rideId, userId);
  if (isMember) return true;
  // Виден, если среди участников есть друг
  const friends = friendIdsOf(userId);
  if (friends.length === 0) return false;
  const placeholders = friends.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT 1 FROM ride_members WHERE ride_id = ? AND user_id IN (${placeholders}) LIMIT 1`)
    .get(rideId, ...friends);
  return !!row;
}

function rideInfo(rideId: number) {
  const ride: any = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
  if (!ride) return null;
  const members: any[] = db
    .prepare(
      `SELECT m.*, u.username, u.display_name, u.avatar FROM ride_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.ride_id = ?`
    )
    .all(rideId);
  const creator = getUserById(ride.created_by);

  let track: { lat: number; lng: number }[] | null = null;
  try {
    if (ride.track) track = JSON.parse(ride.track);
  } catch {}

  // С трассой соревнуемся по чекпоинтам, без — по дистанции
  members.sort((a, b) =>
    track
      ? b.checkpoint - a.checkpoint || b.distance - a.distance
      : b.distance - a.distance || b.max_speed - a.max_speed
  );

  return {
    id: ride.id,
    name: ride.name,
    status: ride.status,
    createdAt: ride.created_at,
    finishedAt: ride.finished_at,
    creator,
    track,
    leaderboard: members.map((m, idx) => {
      let path: { lat: number; lng: number }[] = [];
      try {
        if (m.path) path = JSON.parse(m.path);
      } catch {}
      return {
        place: idx + 1,
        user: {
          id: m.user_id,
          username: m.username,
          displayName: m.display_name,
          avatar: m.avatar,
          online: isOnline(m.user_id),
        },
        distance: m.distance,
        maxSpeed: m.max_speed,
        avgSpeed: m.avg_speed,
        duration: m.duration,
        checkpoint: m.checkpoint,
        updatedAt: m.updated_at,
        path,
        location: getLiveLocation(m.user_id) || null,
      };
    }),
  };
}

api.post('/rides', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Введите название заезда' });
  const result = db
    .prepare("INSERT INTO rides (name, created_by, status, created_at) VALUES (?, ?, 'active', ?)")
    .run(name.slice(0, 40), userId, now());
  const rideId = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO ride_members (ride_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(rideId, userId, now());
  for (const fid of friendIdsOf(userId)) notifyUser(fid, 'rides:update', {});
  res.json({ ride: rideInfo(rideId) });
});

api.get('/rides/active', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const visible = [userId, ...friendIdsOf(userId)];
  const placeholders = visible.map(() => '?').join(',');
  const rows: any[] = db
    .prepare(
      `SELECT DISTINCT r.id FROM rides r
       JOIN ride_members m ON m.ride_id = r.id
       WHERE r.status = 'active' AND m.user_id IN (${placeholders})
       ORDER BY r.id DESC LIMIT 20`
    )
    .all(...visible);
  res.json({
    rides: rows.map((r) => {
      const info: any = rideInfo(r.id);
      return {
        ...info,
        amMember: info.leaderboard.some((e: any) => e.user.id === userId),
      };
    }),
  });
});

// История завершённых заездов, видимых пользователю (свои + где есть друзья)
api.get('/rides/history', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const visible = [userId, ...friendIdsOf(userId)];
  const placeholders = visible.map(() => '?').join(',');
  const rows: any[] = db
    .prepare(
      `SELECT DISTINCT r.id FROM rides r
       JOIN ride_members m ON m.ride_id = r.id
       WHERE r.status = 'finished' AND m.user_id IN (${placeholders})
       ORDER BY r.finished_at DESC LIMIT 30`
    )
    .all(...visible);
  res.json({
    rides: rows.map((r) => {
      const info: any = rideInfo(r.id);
      return {
        ...info,
        amMember: info.leaderboard.some((e: any) => e.user.id === userId),
      };
    }),
  });
});

api.get('/rides/:id', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const rideId = Number(req.params.id);
  // Сначала существование: удалённый заезд должен отдавать 404, а не 403 —
  // по «Заезд не найден» клиент закрывает панель заезда
  const info = rideInfo(rideId);
  if (!info) return res.status(404).json({ error: 'Заезд не найден' });
  if (!canSeeRide(rideId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  res.json({ ride: info });
});

api.post('/rides/:id/join', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const rideId = Number(req.params.id);
  const ride: any = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
  if (!ride || ride.status !== 'active') return res.status(404).json({ error: 'Заезд не активен' });
  if (!canSeeRide(rideId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  const exists = db
    .prepare('SELECT 1 FROM ride_members WHERE ride_id = ? AND user_id = ?')
    .get(rideId, userId);
  if (!exists) {
    db.prepare('INSERT INTO ride_members (ride_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(rideId, userId, now());
  }
  res.json({ ride: rideInfo(rideId) });
});

// Организатор размечает трассу (массив чекпоинтов). Пустой массив — убрать.
api.post('/rides/:id/track', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const rideId = Number(req.params.id);
  const ride: any = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
  if (!ride || ride.status !== 'active') return res.status(404).json({ error: 'Заезд не активен' });
  if (ride.created_by !== userId) {
    return res.status(403).json({ error: 'Трассу задаёт только организатор' });
  }
  const raw = Array.isArray(req.body?.points) ? req.body.points : [];
  const points = raw
    .slice(0, 50)
    .map((p: any) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
    .filter((p: any) => isFinite(p.lat) && isFinite(p.lng));
  db.prepare('UPDATE rides SET track = ? WHERE id = ?').run(
    points.length ? JSON.stringify(points) : null,
    rideId
  );
  // Прогресс пересчитываем с нуля при смене трассы
  db.prepare('UPDATE ride_members SET checkpoint = 0 WHERE ride_id = ?').run(rideId);
  const members: any[] = db.prepare('SELECT user_id FROM ride_members WHERE ride_id = ?').all(rideId);
  for (const m of members) notifyUser(m.user_id, 'rides:update', {});
  res.json({ ride: rideInfo(rideId) });
});

api.post('/rides/:id/stats', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const rideId = Number(req.params.id);
  const ride: any = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
  if (!ride || ride.status !== 'active') return res.status(404).json({ error: 'Заезд не активен' });
  const member = db
    .prepare('SELECT 1 FROM ride_members WHERE ride_id = ? AND user_id = ?')
    .get(rideId, userId);
  if (!member) return res.status(403).json({ error: 'Вы не участник заезда' });

  const distance = Math.max(0, Number(req.body?.distance) || 0);
  const maxSpeed = Math.max(0, Number(req.body?.maxSpeed) || 0);
  const avgSpeed = Math.max(0, Number(req.body?.avgSpeed) || 0);
  const duration = Math.max(0, Number(req.body?.duration) || 0);
  db.prepare(
    `UPDATE ride_members
     SET distance = MAX(distance, ?), max_speed = MAX(max_speed, ?),
         avg_speed = ?, duration = ?, updated_at = ?
     WHERE ride_id = ? AND user_id = ?`
  ).run(distance, maxSpeed, avgSpeed, duration, now(), rideId, userId);
  res.json({ ok: true });
});

api.post('/rides/:id/finish', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const rideId = Number(req.params.id);
  const ride: any = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
  if (!ride) return res.status(404).json({ error: 'Заезд не найден' });
  if (ride.created_by !== userId) {
    return res.status(403).json({ error: 'Завершить заезд может только создатель' });
  }
  db.prepare("UPDATE rides SET status = 'finished', finished_at = ? WHERE id = ?").run(now(), rideId);
  const members: any[] = db.prepare('SELECT user_id FROM ride_members WHERE ride_id = ?').all(rideId);
  for (const m of members) notifyUser(m.user_id, 'rides:update', {});
  res.json({ ride: rideInfo(rideId) });
});

// Удалить заезд целиком (только создатель, в любом статусе)
api.delete('/rides/:id', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const rideId = Number(req.params.id);
  const ride: any = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
  if (!ride) return res.status(404).json({ error: 'Заезд не найден' });
  if (ride.created_by !== userId) {
    return res.status(403).json({ error: 'Удалить заезд может только создатель' });
  }
  const members: any[] = db.prepare('SELECT user_id FROM ride_members WHERE ride_id = ?').all(rideId);
  db.prepare('DELETE FROM ride_members WHERE ride_id = ?').run(rideId);
  db.prepare('DELETE FROM rides WHERE id = ?').run(rideId);
  for (const m of members) notifyUser(m.user_id, 'rides:update', {});
  res.json({ ok: true });
});

// ---------- Маршруты (постоянные, в отличие от заездов) ----------

const VISIBILITIES = ['private', 'friends', 'public'] as const;

// Нормализация и валидация трека: [{lat,lng}], до 3000 точек.
function cleanTrack(raw: any): { lat: number; lng: number }[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .slice(0, 3000)
    .map((p: any) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
    .filter((p: any) => isFinite(p.lat) && isFinite(p.lng));
}

function trackDistance(points: { lat: number; lng: number }[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = haversineMeters(points[i - 1], points[i]);
    if (seg < 500) d += seg; // отсекаем телепорты
  }
  return Math.round(d);
}

// Сохранить записанный маршрут
api.post('/routes', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Введите название маршрута' });
  const track = cleanTrack(req.body?.points);
  if (track.length < 2) return res.status(400).json({ error: 'В маршруте слишком мало точек' });
  const visibility = VISIBILITIES.includes(req.body?.visibility) ? req.body.visibility : 'private';
  const result = db
    .prepare(
      `INSERT INTO routes (user_id, name, track, distance, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, name.slice(0, 40), JSON.stringify(track), trackDistance(track), visibility, now());
  const route: any = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(result.lastInsertRowid));
  // Друзьям, которым маршрут виден, — обновить список
  if (visibility !== 'private') {
    for (const fid of friendIdsOf(userId)) notifyUser(fid, 'routes:update', {});
  }
  res.json({ route: routeInfo(route, userId) });
});

// Список маршрутов: мои + видимые чужие (публичные + друзей с visibility friends)
api.get('/routes', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const friends = friendIdsOf(userId);
  const mineRows: any[] = db
    .prepare('SELECT * FROM routes WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .all(userId);
  const fPlace = friends.length ? friends.map(() => '?').join(',') : 'NULL';
  const sharedRows: any[] = db
    .prepare(
      `SELECT * FROM routes
       WHERE user_id != ?
         AND (visibility = 'public' OR (visibility = 'friends' AND user_id IN (${fPlace})))
       ORDER BY id DESC LIMIT 100`
    )
    .all(userId, ...friends);
  res.json({
    mine: mineRows.map((r) => routeInfo(r, userId)),
    shared: sharedRows.map((r) => routeInfo(r, userId)),
  });
});

api.get('/routes/:id', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const route: any = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(req.params.id));
  if (!route) return res.status(404).json({ error: 'Маршрут не найден' });
  if (!canSeeRoute(route, userId)) return res.status(403).json({ error: 'Нет доступа' });
  res.json({ route: routeInfo(route, userId) });
});

// Сменить видимость (поделиться со всеми / с друзьями / скрыть) — только владелец
api.post('/routes/:id/visibility', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const route: any = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(req.params.id));
  if (!route) return res.status(404).json({ error: 'Маршрут не найден' });
  if (route.user_id !== userId) return res.status(403).json({ error: 'Только владелец' });
  const visibility = VISIBILITIES.includes(req.body?.visibility) ? req.body.visibility : null;
  if (!visibility) return res.status(400).json({ error: 'Неверная видимость' });
  db.prepare('UPDATE routes SET visibility = ? WHERE id = ?').run(visibility, route.id);
  for (const fid of friendIdsOf(userId)) notifyUser(fid, 'routes:update', {});
  const fresh: any = db.prepare('SELECT * FROM routes WHERE id = ?').get(route.id);
  res.json({ route: routeInfo(fresh, userId) });
});

api.delete('/routes/:id', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const route: any = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(req.params.id));
  if (!route) return res.status(404).json({ error: 'Маршрут не найден' });
  if (route.user_id !== userId) return res.status(403).json({ error: 'Только владелец' });
  db.prepare('DELETE FROM routes WHERE id = ?').run(route.id);
  if (route.visibility !== 'private') {
    for (const fid of friendIdsOf(userId)) notifyUser(fid, 'routes:update', {});
  }
  res.json({ ok: true });
});

// ---------- Сообщения ----------

// Общий SELECT с автором и превью цитируемого сообщения (reply_to)
const MESSAGE_SELECT = `
  SELECT m.*, u.username, u.display_name, u.avatar,
         rm.text AS reply_text, ru.display_name AS reply_sender
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages rm ON rm.id = m.reply_to
  LEFT JOIN users ru ON ru.id = rm.sender_id`;

function messagePayload(r: any) {
  return {
    id: r.id,
    chatId: r.chat_id,
    text: r.text,
    createdAt: r.created_at,
    editedAt: r.edited_at || null,
    replyTo: r.reply_to
      ? { id: r.reply_to, text: r.reply_text ?? '', senderName: r.reply_sender ?? '' }
      : null,
    sender: { id: r.sender_id, username: r.username, displayName: r.display_name, avatar: r.avatar },
  };
}

function loadMessage(msgId: number) {
  const r: any = db.prepare(MESSAGE_SELECT + ' WHERE m.id = ?').get(msgId);
  return r ? messagePayload(r) : null;
}

api.get('/chats/:id/messages', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });

  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const rows: any[] = db
    .prepare(MESSAGE_SELECT + ' WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?')
    .all(chatId, before, limit);

  res.json({ messages: rows.reverse().map(messagePayload) });
});

api.post('/chats/:id/messages', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

  // reply_to принимаем только если это сообщение из этого же чата
  let replyTo: number | null = Number(req.body?.replyTo) || null;
  if (replyTo) {
    const src: any = db.prepare('SELECT chat_id FROM messages WHERE id = ?').get(replyTo);
    if (!src || src.chat_id !== chatId) replyTo = null;
  }

  const result = db
    .prepare('INSERT INTO messages (chat_id, sender_id, text, reply_to, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, userId, text.slice(0, 2000), replyTo, now());

  const message = loadMessage(Number(result.lastInsertRowid));

  // Realtime-доставка всем участникам (включая другие устройства отправителя)
  const members: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  for (const m of members) {
    notifyUser(m.user_id, 'chat:new', message);
  }
  res.json({ message });
});

// Редактирование своего сообщения
api.patch('/chats/:id/messages/:msgId', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  const msgId = Number(req.params.msgId);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

  const msg: any = db.prepare('SELECT sender_id, chat_id FROM messages WHERE id = ?').get(msgId);
  if (!msg || msg.chat_id !== chatId) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.sender_id !== userId) return res.status(403).json({ error: 'Можно менять только свои сообщения' });

  db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(
    text.slice(0, 2000),
    now(),
    msgId
  );
  const message = loadMessage(msgId);
  const members: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  for (const m of members) {
    notifyUser(m.user_id, 'chat:edited', message);
    notifyUser(m.user_id, 'chats:update', {});
  }
  res.json({ message });
});

// Удаление своего сообщения
api.delete('/chats/:id/messages/:msgId', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const chatId = Number(req.params.id);
  const msgId = Number(req.params.msgId);
  if (!isChatMember(chatId, userId)) return res.status(403).json({ error: 'Нет доступа' });

  const msg: any = db.prepare('SELECT sender_id, chat_id FROM messages WHERE id = ?').get(msgId);
  if (!msg || msg.chat_id !== chatId) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.sender_id !== userId) return res.status(403).json({ error: 'Можно удалять только свои сообщения' });

  // Отвязываем ответы на это сообщение, чтобы не висела мёртвая ссылка
  db.prepare('UPDATE messages SET reply_to = NULL WHERE reply_to = ?').run(msgId);
  db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
  const members: any[] = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  for (const m of members) {
    notifyUser(m.user_id, 'chat:deleted', { chatId, id: msgId });
    notifyUser(m.user_id, 'chats:update', {});
  }
  res.json({ ok: true });
});

// ---------- Навигатор (turn-by-turn) ----------

const DIR: Record<string, string> = {
  left: 'налево',
  right: 'направо',
  'slight left': 'левее',
  'slight right': 'правее',
  'sharp left': 'резко налево',
  'sharp right': 'резко направо',
  straight: 'прямо',
  uturn: 'разворот',
};

// Манёвр OSRM → короткая инструкция на русском
function maneuverRu(m: any, name?: string): string {
  const dir = m?.modifier ? DIR[m.modifier] || '' : '';
  const road = name ? ` на ${name}` : '';
  switch (m?.type) {
    case 'depart':
      return 'Старт';
    case 'arrive':
      return 'Вы на месте';
    case 'turn':
      return `Поверните ${dir}${road}`;
    case 'new name':
      return `Продолжайте${road}`;
    case 'continue':
      return `Продолжайте ${dir || 'движение'}${road}`;
    case 'merge':
      return `Перестройтесь ${dir}${road}`;
    case 'on ramp':
      return `Съезд ${dir}${road}`;
    case 'off ramp':
      return `Съезжайте ${dir}${road}`;
    case 'fork':
      return `Держитесь ${dir || 'по развилке'}${road}`;
    case 'end of road':
      return `В конце дороги — ${dir}${road}`;
    case 'roundabout':
    case 'rotary':
      return `На круге — ${m?.exit ? m.exit + '-й съезд' : 'по кругу'}`;
    default:
      return `Продолжайте ${dir || 'движение'}${road}`;
  }
}

// Прокси к OSRM (без ключей). Клиент шлёт from/to как "lat,lng".
api.get('/route', requireAuth, async (req, res) => {
  const parse = (s: any): [number, number] | null => {
    const [lat, lng] = String(s || '').split(',').map(Number);
    return isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
  };
  const from = parse(req.query.from);
  const to = parse(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'Нужны from и to (lat,lng)' });

  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const j: any = await r.json();
    if (j.code !== 'Ok' || !j.routes?.length) {
      return res.status(502).json({ error: 'Маршрут не найден' });
    }
    const route = j.routes[0];
    const geometry = route.geometry.coordinates.map((c: number[]) => ({ lat: c[1], lng: c[0] }));
    const steps = (route.legs[0]?.steps || []).map((s: any) => ({
      text: maneuverRu(s.maneuver, s.name),
      distance: Math.round(s.distance),
      lat: s.maneuver.location[1],
      lng: s.maneuver.location[0],
    }));
    res.json({
      distance: Math.round(route.distance),
      duration: Math.round(route.duration),
      geometry,
      steps,
    });
  } catch {
    res.status(502).json({ error: 'Роутинг временно недоступен' });
  }
});

// ---------- SOS: экстренное оповещение друзей ----------

api.post('/sos', requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const message = (String(req.body?.message || '').trim() || 'У меня беда, прошу помочь').slice(0, 300);

  const friends = friendIdsOf(userId);
  // Если получатели не заданы — шлём всем друзьям; иначе только выбранным (и
  // только тем, кто реально в друзьях).
  const picked: number[] = Array.isArray(req.body?.recipientIds)
    ? req.body.recipientIds.map(Number)
    : [];
  const targets = picked.length ? picked.filter((id) => friends.includes(id)) : friends;

  const from = getUserById(userId);
  const payload = {
    from,
    message,
    lat: isFinite(lat) ? lat : null,
    lng: isFinite(lng) ? lng : null,
    at: now(),
  };
  for (const t of targets) notifyUser(t, 'sos:alert', payload);
  res.json({ ok: true, sent: targets.length });
});
