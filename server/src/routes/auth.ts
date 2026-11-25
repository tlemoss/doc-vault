import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getChallengePepper } from '../db.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSession,
  hashSecret,
  hashToken,
  loadUserFromSession,
  makeAuthHook,
  setSessionCookie,
  verifySecret,
} from '../auth.js';
import { getUserStorageUsage } from '../storage.js';

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Usuário deve ter pelo menos 3 caracteres.')
  .max(48, 'Usuário deve ter no máximo 48 caracteres.')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use apenas letras, números, ponto, hífen ou underscore.');

const registrationCryptoSchema = z.object({
  username: usernameSchema,
  kdfSalt: z.string().min(16).max(128),
  kdfIterations: z.number().int().min(100000).max(2000000),
  authKey: z.string().min(32).max(256),
  publicKey: z.string().min(100).max(4096),
  publicKeyFingerprint: z.string().min(16).max(128),
  encryptedPrivateKey: z.string().min(100).max(16384),
  privateKeyIv: z.string().min(12).max(64),
  recoveryEncryptedPrivateKey: z.string().min(100).max(16384),
  recoveryIv: z.string().min(12).max(64),
  recoverySalt: z.string().min(16).max(128),
  recoveryAuthKey: z.string().min(32).max(256),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  config: ServerConfig
): void {
  const requireAuth = makeAuthHook(db);

  app.get('/api/auth/status', async (request) => {
    const countRow = db.prepare('SELECT COUNT(*) AS count FROM users').get() as {
      count: number;
    };
    const initialized = Number(countRow.count) > 0;
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    const resolved = loadUserFromSession(db, rawToken);

    return {
      initialized,
      user: resolved?.user ?? null,
      maxFileSizeBytes: config.maxFileSizeBytes,
      defaultQuotaBytes: config.defaultQuotaBytes,
    };
  });

  app.post(
    '/api/auth/setup',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const parsed = registrationCryptoSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? 'Dados inválidos.',
        });
      }

      const data = parsed.data;
      const userId = crypto.randomUUID();
      const now = new Date().toISOString();
      const authHashed = hashSecret(data.authKey);
      const recoveryHashed = hashSecret(data.recoveryAuthKey);

      db.exec('BEGIN IMMEDIATE');
      try {
        const countRow = db.prepare('SELECT COUNT(*) AS count FROM users').get() as {
          count: number;
        };
        if (Number(countRow.count) > 0) {
          db.exec('ROLLBACK');
          return reply.code(409).send({ error: 'A plataforma já foi inicializada.' });
        }

        db.prepare(
          `INSERT INTO users (
            id, username, role, kdf_salt, kdf_iterations,
            auth_salt, auth_hash, public_key, public_key_fingerprint,
            encrypted_private_key, private_key_iv,
            recovery_encrypted_private_key, recovery_iv, recovery_salt,
            recovery_auth_salt, recovery_auth_hash,
            quota_bytes, is_active, created_at
          ) VALUES (?, ?, 'admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        ).run(
          userId,
          data.username,
          data.kdfSalt,
          data.kdfIterations,
          authHashed.salt,
          authHashed.hash,
          data.publicKey,
          data.publicKeyFingerprint,
          data.encryptedPrivateKey,
          data.privateKeyIv,
          data.recoveryEncryptedPrivateKey,
          data.recoveryIv,
          data.recoverySalt,
          recoveryHashed.salt,
          recoveryHashed.hash,
          config.defaultQuotaBytes,
          now
        );

        const session = createSession(db, userId, config.sessionTtlMs);
        db.exec('COMMIT');

        setSessionCookie(reply, session.rawToken, config);
        return reply.code(201).send({
          user: {
            id: userId,
            username: data.username,
            role: 'admin',
            quotaBytes: config.defaultQuotaBytes,
            usedBytes: 0,
            kdfSalt: data.kdfSalt,
            kdfIterations: data.kdfIterations,
            publicKey: data.publicKey,
            publicKeyFingerprint: data.publicKeyFingerprint,
            encryptedPrivateKey: data.encryptedPrivateKey,
            privateKeyIv: data.privateKeyIv,
          },
        });
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      }
    }
  );

  app.get<{ Params: { token: string } }>('/api/auth/invite/:token', async (request, reply) => {
    const tokenHash = hashToken(request.params.token);
    const invite = db
      .prepare(
        'SELECT username, role, quota_bytes, expires_at, used_by FROM invites WHERE token_hash = ?'
      )
      .get(tokenHash) as
      | {
          username: string | null;
          role: 'admin' | 'user';
          quota_bytes: number;
          expires_at: string;
          used_by: string | null;
        }
      | undefined;

    if (!invite || invite.used_by || new Date(invite.expires_at).getTime() <= Date.now()) {
      return reply.code(404).send({ error: 'Convite inválido, já utilizado ou expirado.' });
    }

    return {
      valid: true,
      username: invite.username,
      role: invite.role,
      quotaBytes: Number(invite.quota_bytes),
      expiresAt: invite.expires_at,
    };
  });

  app.post(
    '/api/auth/register',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const schema = registrationCryptoSchema.extend({
        inviteToken: z.string().min(16).max(256),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? 'Dados inválidos.',
        });
      }

      const data = parsed.data;
      const tokenHash = hashToken(data.inviteToken);
      const userId = crypto.randomUUID();
      const now = new Date().toISOString();
      const authHashed = hashSecret(data.authKey);
      const recoveryHashed = hashSecret(data.recoveryAuthKey);

      db.exec('BEGIN IMMEDIATE');
      try {
        const invite = db
          .prepare(
            'SELECT username, role, quota_bytes, expires_at, used_by FROM invites WHERE token_hash = ?'
          )
          .get(tokenHash) as
          | {
              username: string | null;
              role: 'admin' | 'user';
              quota_bytes: number;
              expires_at: string;
              used_by: string | null;
            }
          | undefined;

        if (!invite || invite.used_by || new Date(invite.expires_at).getTime() <= Date.now()) {
          db.exec('ROLLBACK');
          return reply.code(400).send({ error: 'Convite inválido, já utilizado ou expirado.' });
        }

        if (
          invite.username &&
          invite.username.toLowerCase() !== data.username.toLowerCase()
        ) {
          db.exec('ROLLBACK');
          return reply.code(400).send({
            error: `Este convite está reservado para o usuário "${invite.username}".`,
          });
        }

        const existing = db
          .prepare('SELECT id FROM users WHERE username = ?')
          .get(data.username) as { id: string } | undefined;
        if (existing) {
          db.exec('ROLLBACK');
          return reply.code(409).send({ error: 'Este nome de usuário já está em uso.' });
        }

        db.prepare(
          `INSERT INTO users (
            id, username, role, kdf_salt, kdf_iterations,
            auth_salt, auth_hash, public_key, public_key_fingerprint,
            encrypted_private_key, private_key_iv,
            recovery_encrypted_private_key, recovery_iv, recovery_salt,
            recovery_auth_salt, recovery_auth_hash,
            quota_bytes, is_active, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        ).run(
          userId,
          data.username,
          invite.role,
          data.kdfSalt,
          data.kdfIterations,
          authHashed.salt,
          authHashed.hash,
          data.publicKey,
          data.publicKeyFingerprint,
          data.encryptedPrivateKey,
          data.privateKeyIv,
          data.recoveryEncryptedPrivateKey,
          data.recoveryIv,
          data.recoverySalt,
          recoveryHashed.salt,
          recoveryHashed.hash,
          Number(invite.quota_bytes),
          now
        );

        db.prepare('UPDATE invites SET used_by = ? WHERE token_hash = ?').run(
          userId,
          tokenHash
        );

        const session = createSession(db, userId, config.sessionTtlMs);
        db.exec('COMMIT');

        setSessionCookie(reply, session.rawToken, config);
        return reply.code(201).send({
          user: {
            id: userId,
            username: data.username,
            role: invite.role,
            quotaBytes: Number(invite.quota_bytes),
            usedBytes: 0,
            kdfSalt: data.kdfSalt,
            kdfIterations: data.kdfIterations,
            publicKey: data.publicKey,
            publicKeyFingerprint: data.publicKeyFingerprint,
            encryptedPrivateKey: data.encryptedPrivateKey,
            privateKeyIv: data.privateKeyIv,
          },
        });
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }
    }
  );

  app.post(
    '/api/auth/login/challenge',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const parsed = z.object({ username: z.string().trim().min(1).max(64) }).safeParse(
        request.body
      );
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Informe o nome de usuário.' });
      }

      const row = db
        .prepare('SELECT kdf_salt, kdf_iterations FROM users WHERE username = ?')
        .get(parsed.data.username) as
        | { kdf_salt: string; kdf_iterations: number }
        | undefined;

      if (row) {
        return {
          kdfSalt: row.kdf_salt,
          kdfIterations: Number(row.kdf_iterations),
        };
      }

      // Deterministic pseudo-salt prevents username enumeration
      const pepper = getChallengePepper(db);
      const fakeSalt = crypto
        .createHmac('sha256', pepper)
        .update(parsed.data.username.toLowerCase())
        .digest()
        .subarray(0, 16)
        .toString('base64');

      return {
        kdfSalt: fakeSalt,
        kdfIterations: 600000,
      };
    }
  );

  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: { max: 15, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const parsed = z
        .object({
          username: z.string().trim().min(1).max(64),
          authKey: z.string().min(32).max(256),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Credenciais inválidas.' });
      }

      const row = db
        .prepare(
          `SELECT id, username, role, kdf_salt, kdf_iterations,
            auth_salt, auth_hash, public_key, public_key_fingerprint,
            encrypted_private_key, private_key_iv, quota_bytes, is_active
          FROM users WHERE username = ?`
        )
        .get(parsed.data.username) as
        | {
            id: string;
            username: string;
            role: 'admin' | 'user';
            kdf_salt: string;
            kdf_iterations: number;
            auth_salt: string;
            auth_hash: string;
            public_key: string;
            public_key_fingerprint: string;
            encrypted_private_key: string;
            private_key_iv: string;
            quota_bytes: number;
            is_active: number;
          }
        | undefined;

      if (!row) {
        // Equalize timing with a dummy scrypt work factor
        hashSecret(parsed.data.authKey, '00000000000000000000000000000000');
        return reply.code(401).send({ error: 'Usuário ou senha mestre incorretos.' });
      }

      const valid = verifySecret(parsed.data.authKey, row.auth_salt, row.auth_hash);
      if (!valid) {
        return reply.code(401).send({ error: 'Usuário ou senha mestre incorretos.' });
      }

      if (row.is_active !== 1) {
        return reply.code(403).send({ error: 'Esta conta foi desativada pelo administrador.' });
      }

      const session = createSession(db, row.id, config.sessionTtlMs);
      setSessionCookie(reply, session.rawToken, config);

      return {
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
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (rawToken) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
    }
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.post(
    '/api/auth/recovery/challenge',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '5 minutes' },
      },
    },
    async (request, reply) => {
      const parsed = z.object({ username: z.string().trim().min(1).max(64) }).safeParse(
        request.body
      );
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Informe o nome de usuário.' });
      }

      const row = db
        .prepare(
          `SELECT recovery_salt, recovery_encrypted_private_key, recovery_iv, public_key, is_active
          FROM users WHERE username = ?`
        )
        .get(parsed.data.username) as
        | {
            recovery_salt: string;
            recovery_encrypted_private_key: string;
            recovery_iv: string;
            public_key: string;
            is_active: number;
          }
        | undefined;

      if (!row || row.is_active !== 1) {
        return reply
          .code(404)
          .send({ error: 'Conta não encontrada ou indisponível para recuperação.' });
      }

      return {
        recoverySalt: row.recovery_salt,
        recoveryEncryptedPrivateKey: row.recovery_encrypted_private_key,
        recoveryIv: row.recovery_iv,
        publicKey: row.public_key,
      };
    }
  );

  app.post(
    '/api/auth/recovery/reset',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '5 minutes' },
      },
    },
    async (request, reply) => {
      const parsed = z
        .object({
          username: z.string().trim().min(1).max(64),
          recoveryAuthKey: z.string().min(32).max(256),
          kdfSalt: z.string().min(16).max(128),
          kdfIterations: z.number().int().min(100000).max(2000000),
          authKey: z.string().min(32).max(256),
          encryptedPrivateKey: z.string().min(100).max(16384),
          privateKeyIv: z.string().min(12).max(64),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados de recuperação inválidos.' });
      }

      const data = parsed.data;
      const row = db
        .prepare(
          `SELECT id, username, role, public_key, public_key_fingerprint,
            recovery_auth_salt, recovery_auth_hash, quota_bytes, is_active
          FROM users WHERE username = ?`
        )
        .get(data.username) as
        | {
            id: string;
            username: string;
            role: 'admin' | 'user';
            public_key: string;
            public_key_fingerprint: string;
            recovery_auth_salt: string;
            recovery_auth_hash: string;
            quota_bytes: number;
            is_active: number;
          }
        | undefined;

      if (
        !row ||
        row.is_active !== 1 ||
        !verifySecret(data.recoveryAuthKey, row.recovery_auth_salt, row.recovery_auth_hash)
      ) {
        return reply.code(401).send({ error: 'Chave de recuperação inválida.' });
      }

      const newAuth = hashSecret(data.authKey);

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          `UPDATE users SET
            kdf_salt = ?,
            kdf_iterations = ?,
            auth_salt = ?,
            auth_hash = ?,
            encrypted_private_key = ?,
            private_key_iv = ?
          WHERE id = ?`
        ).run(
          data.kdfSalt,
          data.kdfIterations,
          newAuth.salt,
          newAuth.hash,
          data.encryptedPrivateKey,
          data.privateKeyIv,
          row.id
        );

        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
        const session = createSession(db, row.id, config.sessionTtlMs);
        db.exec('COMMIT');

        setSessionCookie(reply, session.rawToken, config);
        return {
          user: {
            id: row.id,
            username: row.username,
            role: row.role,
            quotaBytes: Number(row.quota_bytes),
            usedBytes: getUserStorageUsage(db, row.id),
            kdfSalt: data.kdfSalt,
            kdfIterations: data.kdfIterations,
            publicKey: row.public_key,
            publicKeyFingerprint: row.public_key_fingerprint,
            encryptedPrivateKey: data.encryptedPrivateKey,
            privateKeyIv: data.privateKeyIv,
          },
        };
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }
    }
  );

  app.post(
    '/api/auth/change-password',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = z
        .object({
          currentAuthKey: z.string().min(32).max(256),
          kdfSalt: z.string().min(16).max(128),
          kdfIterations: z.number().int().min(100000).max(2000000),
          newAuthKey: z.string().min(32).max(256),
          encryptedPrivateKey: z.string().min(100).max(16384),
          privateKeyIv: z.string().min(12).max(64),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados inválidos para troca de senha.' });
      }

      const userId = request.authUser!.id;
      const row = db
        .prepare('SELECT auth_salt, auth_hash FROM users WHERE id = ?')
        .get(userId) as { auth_salt: string; auth_hash: string };

      if (!verifySecret(parsed.data.currentAuthKey, row.auth_salt, row.auth_hash)) {
        return reply.code(401).send({ error: 'Senha atual incorreta.' });
      }

      const nextAuth = hashSecret(parsed.data.newAuthKey);
      db.prepare(
        `UPDATE users SET
          kdf_salt = ?,
          kdf_iterations = ?,
          auth_salt = ?,
          auth_hash = ?,
          encrypted_private_key = ?,
          private_key_iv = ?
        WHERE id = ?`
      ).run(
        parsed.data.kdfSalt,
        parsed.data.kdfIterations,
        nextAuth.salt,
        nextAuth.hash,
        parsed.data.encryptedPrivateKey,
        parsed.data.privateKeyIv,
        userId
      );

      // Revoke other sessions of this user
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(
        userId,
        request.sessionId!
      );

      return { ok: true };
    }
  );
}
