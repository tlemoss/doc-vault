import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { hashToken, makeAdminHook, makeAuthHook } from '../auth.js';
import { getUserStorageUsage } from '../storage.js';

export function registerUserRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  config: ServerConfig
): void {
  const requireAuth = makeAuthHook(db);
  const requireAdmin = makeAdminHook(db);

  // Directory of active users with public keys (needed to share tabs E2EE)
  app.get('/api/users/directory', { preHandler: requireAuth }, async () => {
    const rows = db
      .prepare(
        `SELECT id, username, public_key, public_key_fingerprint
         FROM users
         WHERE is_active = 1
         ORDER BY username ASC`
      )
      .all() as Array<{
      id: string;
      username: string;
      public_key: string;
      public_key_fingerprint: string;
    }>;

    return {
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        publicKey: r.public_key,
        publicKeyFingerprint: r.public_key_fingerprint,
      })),
    };
  });

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        `SELECT id, username, role, quota_bytes, is_active, public_key_fingerprint, created_at
         FROM users
         ORDER BY created_at ASC`
      )
      .all() as Array<{
      id: string;
      username: string;
      role: 'admin' | 'user';
      quota_bytes: number;
      is_active: number;
      public_key_fingerprint: string;
      created_at: string;
    }>;

    return {
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role,
        quotaBytes: Number(r.quota_bytes),
        usedBytes: getUserStorageUsage(db, r.id),
        isActive: r.is_active === 1,
        publicKeyFingerprint: r.public_key_fingerprint,
        createdAt: r.created_at,
      })),
    };
  });

  app.patch<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = z
        .object({
          quotaBytes: z
            .number()
            .int()
            .min(1024 * 1024) // min 1 MB
            .max(100 * 1024 * 1024 * 1024) // max 100 GB
            .optional(),
          role: z.enum(['admin', 'user']).optional(),
          isActive: z.boolean().optional(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Parâmetros de usuário inválidos.' });
      }

      const target = db
        .prepare('SELECT id, role, is_active FROM users WHERE id = ?')
        .get(request.params.id) as
        | { id: string; role: 'admin' | 'user'; is_active: number }
        | undefined;

      if (!target) {
        return reply.code(404).send({ error: 'Usuário não encontrado.' });
      }

      const nextRole = parsed.data.role ?? target.role;
      const nextActive =
        parsed.data.isActive === undefined ? target.is_active === 1 : parsed.data.isActive;

      // Ensure at least one active admin remains
      if (target.role === 'admin' && (nextRole !== 'admin' || !nextActive)) {
        const activeAdmins = db
          .prepare(
            "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?"
          )
          .get(target.id) as { count: number };
        if (Number(activeAdmins.count) === 0) {
          return reply
            .code(400)
            .send({ error: 'É necessário manter pelo menos um administrador ativo.' });
        }
      }

      const updates: string[] = [];
      const values: (string | number)[] = [];

      if (parsed.data.quotaBytes !== undefined) {
        updates.push('quota_bytes = ?');
        values.push(parsed.data.quotaBytes);
      }
      if (parsed.data.role !== undefined) {
        updates.push('role = ?');
        values.push(parsed.data.role);
      }
      if (parsed.data.isActive !== undefined) {
        updates.push('is_active = ?');
        values.push(parsed.data.isActive ? 1 : 0);
      }

      if (updates.length > 0) {
        values.push(target.id);
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      if (parsed.data.isActive === false) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      }

      return { ok: true };
    }
  );

  app.get('/api/admin/invites', { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        `SELECT i.token_hash, i.username, i.role, i.quota_bytes, i.expires_at, i.created_at,
                u_created.username AS created_by_username,
                u_used.username AS used_by_username
         FROM invites i
         LEFT JOIN users u_created ON u_created.id = i.created_by
         LEFT JOIN users u_used ON u_used.id = i.used_by
         ORDER BY i.created_at DESC`
      )
      .all() as Array<{
      token_hash: string;
      username: string | null;
      role: 'admin' | 'user';
      quota_bytes: number;
      expires_at: string;
      created_at: string;
      created_by_username: string | null;
      used_by_username: string | null;
    }>;

    return {
      invites: rows.map((r) => ({
        tokenHash: r.token_hash,
        username: r.username,
        role: r.role,
        quotaBytes: Number(r.quota_bytes),
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        createdBy: r.created_by_username,
        usedBy: r.used_by_username,
      })),
    };
  });

  app.post('/api/admin/invites', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({
        username: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9._-]+$/)
          .min(3)
          .max(48)
          .optional()
          .or(z.literal('')),
        role: z.enum(['admin', 'user']).default('user'),
        quotaBytes: z
          .number()
          .int()
          .min(1024 * 1024)
          .max(100 * 1024 * 1024 * 1024)
          .default(config.defaultQuotaBytes),
        expiresInHours: z.number().int().min(1).max(24 * 30).default(72),
      })
      .safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Dados do convite inválidos.' });
    }

    const rawToken = crypto.randomBytes(24).toString('base64url');
    const tokenHash = hashToken(rawToken);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + parsed.data.expiresInHours * 60 * 60 * 1000
    ).toISOString();
    const reservedUsername = parsed.data.username ? parsed.data.username : null;

    db.prepare(
      `INSERT INTO invites (token_hash, username, role, quota_bytes, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tokenHash,
      reservedUsername,
      parsed.data.role,
      parsed.data.quotaBytes,
      request.authUser!.id,
      expiresAt,
      now.toISOString()
    );

    return reply.code(201).send({
      invite: {
        token: rawToken,
        tokenHash,
        username: reservedUsername,
        role: parsed.data.role,
        quotaBytes: parsed.data.quotaBytes,
        expiresAt,
      },
    });
  });

  app.delete<{ Params: { tokenHash: string } }>(
    '/api/admin/invites/:tokenHash',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const result = db
        .prepare('DELETE FROM invites WHERE token_hash = ? AND used_by IS NULL')
        .run(request.params.tokenHash);
      if (result.changes === 0) {
        return reply.code(404).send({ error: 'Convite não encontrado ou já utilizado.' });
      }
      return { ok: true };
    }
  );
}
