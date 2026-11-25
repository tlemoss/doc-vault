import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import { getUserStorageUsage } from './storage.js';

export const SESSION_COOKIE_NAME = 'vault_session';

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  quotaBytes: number;
  usedBytes: number;
  kdfSalt: string;
  kdfIterations: number;
  publicKey: string;
  publicKeyFingerprint: string;
  encryptedPrivateKey: string;
  privateKeyIv: string;
}

export interface TabAccessRecord {
  role: 'owner' | 'editor' | 'viewer';
  wrappedTabKey: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    sessionId?: string;
  }
}

export function hashSecret(secret: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex ?? crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return { salt, hash: derived.toString('hex') };
}

export function verifySecret(secret: string, saltHex: string, expectedHashHex: string): boolean {
  const { hash } = hashSecret(secret, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHashHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function createSession(
  db: DatabaseSync,
  userId: string,
  ttlMs: number
): { sessionId: string; rawToken: string; expiresAt: string } {
  const sessionId = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, userId, tokenHash, expiresAt, now.toISOString());

  return { sessionId, rawToken, expiresAt };
}

export function setSessionCookie(
  reply: FastifyReply,
  rawToken: string,
  config: ServerConfig
): void {
  reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ServerConfig): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
  });
}

export function loadUserFromSession(
  db: DatabaseSync,
  rawToken: string | undefined
): { user: AuthUser; sessionId: string } | null {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT
        s.id AS session_id,
        s.expires_at,
        u.id,
        u.username,
        u.role,
        u.quota_bytes,
        u.kdf_salt,
        u.kdf_iterations,
        u.public_key,
        u.public_key_fingerprint,
        u.encrypted_private_key,
        u.private_key_iv,
        u.is_active
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
    )
    .get(tokenHash) as
    | {
        session_id: string;
        expires_at: string;
        id: string;
        username: string;
        role: 'admin' | 'user';
        quota_bytes: number;
        kdf_salt: string;
        kdf_iterations: number;
        public_key: string;
        public_key_fingerprint: string;
        encrypted_private_key: string;
        private_key_iv: string;
        is_active: number;
      }
    | undefined;

  if (!row) return null;

  if (row.is_active !== 1 || new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      quotaBytes: Number(row.quota_bytes),
      usedBytes: getUserStorageUsage(db, row.id),
      kdfSalt: row.kdf_salt,
      kdfIterations: Number(row.kdf_iterations),
      publicKey: row.public_key,
      publicKeyFingerprint: row.public_key_fingerprint,
      encryptedPrivateKey: row.encrypted_private_key,
      privateKeyIv: row.private_key_iv,
    },
  };
}

export function makeAuthHook(db: DatabaseSync) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    const resolved = loadUserFromSession(db, rawToken);
    if (!resolved) {
      return reply.code(401).send({ error: 'Sessão inválida ou expirada.' });
    }
    request.authUser = resolved.user;
    request.sessionId = resolved.sessionId;
  };
}

export function makeAdminHook(db: DatabaseSync) {
  const requireAuth = makeAuthHook(db);
  return async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.authUser?.role !== 'admin') {
      return reply.code(403).send({ error: 'Acesso restrito a administradores.' });
    }
  };
}

export function getTabAccess(
  db: DatabaseSync,
  tabId: string,
  userId: string
): TabAccessRecord | null {
  const row = db
    .prepare(
      'SELECT role, wrapped_tab_key FROM tab_access WHERE tab_id = ? AND user_id = ?'
    )
    .get(tabId, userId) as
    | { role: 'owner' | 'editor' | 'viewer'; wrapped_tab_key: string }
    | undefined;

  if (!row) return null;
  return {
    role: row.role,
    wrappedTabKey: row.wrapped_tab_key,
  };
}

export function canEditTab(role: TabAccessRecord['role']): boolean {
  return role === 'owner' || role === 'editor';
}

export function isTabOwner(role: TabAccessRecord['role']): boolean {
  return role === 'owner';
}
