import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

// Секрет для JWT: берём из env, иначе генерируем один раз и храним в файле,
// чтобы токены переживали перезапуск сервера.
function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretPath = path.join(__dirname, '..', '.jwt-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
  }
}

const JWT_SECRET = loadSecret();

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function checkPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function signToken(userId: number): string {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '180d' });
}

export function verifyToken(token: string): number | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number };
    return typeof payload.id === 'number' ? payload.id : null;
  } catch {
    return null;
  }
}

export interface AuthedRequest extends Request {
  userId: number;
}

// Middleware: требует Authorization: Bearer <token>
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: 'Требуется вход' });
    return;
  }
  (req as AuthedRequest).userId = userId;
  next();
}
