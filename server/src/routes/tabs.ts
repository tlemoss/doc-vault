import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canEditTab, getTabAccess, isTabOwner, makeAuthHook } from '../auth.js';
import type { BlobStorage } from '../storage.js';

export function registerTabRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  storage: BlobStorage
): void {
  const requireAuth = makeAuthHook(db);

  app.get('/api/tabs', { preHandler: requireAuth }, async (request) => {
    const userId = request.authUser!.id;
    const rows = db
      .prepare(
        `SELECT
          t.id, t.type, t.encrypted_meta, t.meta_iv,
          t.encrypted_schema, t.schema_iv, t.key_version,
          t.created_by, t.created_at, t.updated_at,
          ta.role, ta.wrapped_tab_key,
          (SELECT COUNT(*) FROM tab_access ta2 WHERE ta2.tab_id = t.id) AS member_count
        FROM tabs t
        JOIN tab_access ta ON ta.tab_id = t.id
        WHERE ta.user_id = ?
        ORDER BY t.created_at ASC`
      )
      .all(userId) as Array<{
      id: string;
      type: 'documents' | 'table';
      encrypted_meta: string;
      meta_iv: string;
      encrypted_schema: string | null;
      schema_iv: string | null;
      key_version: number;
      created_by: string;
      created_at: string;
      updated_at: string;
      role: 'owner' | 'editor' | 'viewer';
      wrapped_tab_key: string;
      member_count: number;
    }>;

    return {
      tabs: rows.map((r) => ({
        id: r.id,
        type: r.type,
        encryptedMeta: r.encrypted_meta,
        metaIv: r.meta_iv,
        encryptedSchema: r.encrypted_schema,
        schemaIv: r.schema_iv,
        keyVersion: Number(r.key_version),
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        role: r.role,
        wrappedTabKey: r.wrapped_tab_key,
        memberCount: Number(r.member_count),
      })),
    };
  });

  app.post('/api/tabs', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z
      .object({
        type: z.enum(['documents', 'table']),
        encryptedMeta: z.string().min(16).max(65536),
        metaIv: z.string().min(12).max(64),
        encryptedSchema: z.string().min(16).max(262144).nullable().optional(),
        schemaIv: z.string().min(12).max(64).nullable().optional(),
        wrappedTabKey: z.string().min(64).max(4096),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Dados inválidos para criação de aba.' });
    }

    const userId = request.authUser!.id;
    const tabId = crypto.randomUUID();
    const now = new Date().toISOString();
    const d = parsed.data;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO tabs (
          id, type, encrypted_meta, meta_iv,
          encrypted_schema, schema_iv, key_version,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(
        tabId,
        d.type,
        d.encryptedMeta,
        d.metaIv,
        d.encryptedSchema ?? null,
        d.schemaIv ?? null,
        userId,
        now,
        now
      );

      db.prepare(
        `INSERT INTO tab_access (tab_id, user_id, role, wrapped_tab_key, granted_by, granted_at)
         VALUES (?, ?, 'owner', ?, ?, ?)`
      ).run(tabId, userId, d.wrappedTabKey, userId, now);

      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }

    return reply.code(201).send({
      tab: {
        id: tabId,
        type: d.type,
        encryptedMeta: d.encryptedMeta,
        metaIv: d.metaIv,
        encryptedSchema: d.encryptedSchema ?? null,
        schemaIv: d.schemaIv ?? null,
        keyVersion: 1,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        role: 'owner',
        wrappedTabKey: d.wrappedTabKey,
        memberCount: 1,
      },
    });
  });

  app.patch<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para editar esta aba.' });
      }

      const parsed = z
        .object({
          encryptedMeta: z.string().min(16).max(65536).optional(),
          metaIv: z.string().min(12).max(64).optional(),
          encryptedSchema: z.string().min(16).max(262144).optional(),
          schemaIv: z.string().min(12).max(64).optional(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados inválidos para atualizar aba.' });
      }

      const d = parsed.data;
      const updates: string[] = [];
      const values: string[] = [];

      if (d.encryptedMeta !== undefined && d.metaIv !== undefined) {
        updates.push('encrypted_meta = ?', 'meta_iv = ?');
        values.push(d.encryptedMeta, d.metaIv);
      }
      if (d.encryptedSchema !== undefined && d.schemaIv !== undefined) {
        updates.push('encrypted_schema = ?', 'schema_iv = ?');
        values.push(d.encryptedSchema, d.schemaIv);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'Nenhuma alteração enviada.' });
      }

      const now = new Date().toISOString();
      updates.push('updated_at = ?');
      values.push(now, request.params.tabId);

      db.prepare(`UPDATE tabs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      return { ok: true, updatedAt: now };
    }
  );

  app.delete<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !isTabOwner(access.role)) {
        return reply
          .code(403)
          .send({ error: 'Apenas o proprietário pode excluir esta aba.' });
      }

      const blobs = db
        .prepare('SELECT blob_path FROM documents WHERE tab_id = ? AND blob_path IS NOT NULL')
        .all(request.params.tabId) as Array<{ blob_path: string }>;

      db.prepare('DELETE FROM tabs WHERE id = ?').run(request.params.tabId);

      for (const b of blobs) {
        storage.deleteBlob(b.blob_path);
      }

      return { ok: true };
    }
  );

  app.get<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/access',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access) {
        return reply.code(403).send({ error: 'Sem acesso a esta aba.' });
      }

      const rows = db
        .prepare(
          `SELECT ta.user_id, ta.role, ta.granted_at, u.username, u.public_key, u.public_key_fingerprint
           FROM tab_access ta
           JOIN users u ON u.id = ta.user_id
           WHERE ta.tab_id = ?
           ORDER BY ta.granted_at ASC`
        )
        .all(request.params.tabId) as Array<{
        user_id: string;
        role: 'owner' | 'editor' | 'viewer';
        granted_at: string;
        username: string;
        public_key: string;
        public_key_fingerprint: string;
      }>;

      return {
        members: rows.map((r) => ({
          userId: r.user_id,
          username: r.username,
          role: r.role,
          publicKey: r.public_key,
          publicKeyFingerprint: r.public_key_fingerprint,
          grantedAt: r.granted_at,
        })),
      };
    }
  );

  app.post<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/access',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !isTabOwner(access.role)) {
        return reply
          .code(403)
          .send({ error: 'Apenas proprietários podem gerenciar permissões.' });
      }

      const parsed = z
        .object({
          userId: z.string().uuid(),
          role: z.enum(['owner', 'editor', 'viewer']),
          wrappedTabKey: z.string().min(64).max(4096),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados de compartilhamento inválidos.' });
      }

      const targetUser = db
        .prepare('SELECT id, is_active FROM users WHERE id = ?')
        .get(parsed.data.userId) as { id: string; is_active: number } | undefined;

      if (!targetUser || targetUser.is_active !== 1) {
        return reply.code(404).send({ error: 'Usuário de destino não encontrado ou inativo.' });
      }

      // Prevent owner from demoting themselves if they are the only owner
      if (parsed.data.userId === request.authUser!.id && parsed.data.role !== 'owner') {
        const otherOwners = db
          .prepare(
            "SELECT COUNT(*) AS count FROM tab_access WHERE tab_id = ? AND role = 'owner' AND user_id != ?"
          )
          .get(request.params.tabId, request.authUser!.id) as { count: number };
        if (Number(otherOwners.count) === 0) {
          return reply
            .code(400)
            .send({ error: 'A aba precisa manter pelo menos um proprietário.' });
        }
      }

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tab_access (tab_id, user_id, role, wrapped_tab_key, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tab_id, user_id) DO UPDATE SET
           role = excluded.role,
           wrapped_tab_key = excluded.wrapped_tab_key,
           granted_by = excluded.granted_by,
           granted_at = excluded.granted_at`
      ).run(
        request.params.tabId,
        parsed.data.userId,
        parsed.data.role,
        parsed.data.wrappedTabKey,
        request.authUser!.id,
        now
      );

      return { ok: true };
    }
  );

  app.delete<{ Params: { tabId: string; userId: string } }>(
    '/api/tabs/:tabId/access/:userId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !isTabOwner(access.role)) {
        return reply
          .code(403)
          .send({ error: 'Apenas proprietários podem revogar acessos.' });
      }

      const targetAccess = getTabAccess(db, request.params.tabId, request.params.userId);
      if (!targetAccess) {
        return reply.code(404).send({ error: 'Usuário não possui acesso a esta aba.' });
      }

      if (targetAccess.role === 'owner') {
        const otherOwners = db
          .prepare(
            "SELECT COUNT(*) AS count FROM tab_access WHERE tab_id = ? AND role = 'owner' AND user_id != ?"
          )
          .get(request.params.tabId, request.params.userId) as { count: number };
        if (Number(otherOwners.count) === 0) {
          return reply
            .code(400)
            .send({ error: 'Não é possível remover o único proprietário da aba.' });
        }
      }

      db.prepare('DELETE FROM tab_access WHERE tab_id = ? AND user_id = ?').run(
        request.params.tabId,
        request.params.userId
      );

      return { ok: true };
    }
  );

  // Atomic cryptographic key rotation for a tab (e.g. after revoking a member)
  app.post<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/rotate-key',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !isTabOwner(access.role)) {
        return reply
          .code(403)
          .send({ error: 'Apenas proprietários podem rotacionar a chave da aba.' });
      }

      const parsed = z
        .object({
          encryptedMeta: z.string().min(16),
          metaIv: z.string().min(12),
          encryptedSchema: z.string().min(16).nullable().optional(),
          schemaIv: z.string().min(12).nullable().optional(),
          memberKeys: z
            .array(
              z.object({
                userId: z.string().uuid(),
                wrappedTabKey: z.string().min(64),
              })
            )
            .min(1),
          documents: z
            .array(
              z.object({
                id: z.string().uuid(),
                encryptedMeta: z.string().min(16),
                metaIv: z.string().min(12),
                encryptedContent: z.string().nullable().optional(),
                contentIv: z.string().nullable().optional(),
                wrappedFileKey: z.string().nullable().optional(),
                fileKeyIv: z.string().nullable().optional(),
              })
            )
            .default([]),
          rows: z
            .array(
              z.object({
                id: z.string().uuid(),
                encryptedData: z.string().min(16),
                dataIv: z.string().min(12),
              })
            )
            .default([]),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Payload de rotação de chave inválido.' });
      }

      const tabId = request.params.tabId;
      const d = parsed.data;
      const now = new Date().toISOString();

      db.exec('BEGIN IMMEDIATE');
      try {
        const currentMembers = db
          .prepare('SELECT user_id FROM tab_access WHERE tab_id = ?')
          .all(tabId) as Array<{ user_id: string }>;
        const currentIds = new Set(currentMembers.map((m) => m.user_id));
        const providedMap = new Map(d.memberKeys.map((m) => [m.userId, m.wrappedTabKey]));

        for (const id of currentIds) {
          if (!providedMap.has(id)) {
            db.exec('ROLLBACK');
            return reply.code(400).send({
              error: 'A rotação de chave deve incluir chaves empacotadas para todos os membros atuais.',
            });
          }
        }

        db.prepare(
          `UPDATE tabs SET
            encrypted_meta = ?,
            meta_iv = ?,
            encrypted_schema = ?,
            schema_iv = ?,
            key_version = key_version + 1,
            updated_at = ?
          WHERE id = ?`
        ).run(
          d.encryptedMeta,
          d.metaIv,
          d.encryptedSchema ?? null,
          d.schemaIv ?? null,
          now,
          tabId
        );

        const updateMember = db.prepare(
          'UPDATE tab_access SET wrapped_tab_key = ? WHERE tab_id = ? AND user_id = ?'
        );
        for (const id of currentIds) {
          updateMember.run(providedMap.get(id)!, tabId, id);
        }

        const updateDoc = db.prepare(
          `UPDATE documents SET
            encrypted_meta = ?,
            meta_iv = ?,
            encrypted_content = ?,
            content_iv = ?,
            wrapped_file_key = ?,
            file_key_iv = ?,
            updated_at = ?
          WHERE id = ? AND tab_id = ?`
        );
        for (const doc of d.documents) {
          updateDoc.run(
            doc.encryptedMeta,
            doc.metaIv,
            doc.encryptedContent ?? null,
            doc.contentIv ?? null,
            doc.wrappedFileKey ?? null,
            doc.fileKeyIv ?? null,
            now,
            doc.id,
            tabId
          );
        }

        const updateRow = db.prepare(
          `UPDATE table_rows SET encrypted_data = ?, data_iv = ?, updated_at = ?
           WHERE id = ? AND tab_id = ?`
        );
        for (const row of d.rows) {
          updateRow.run(row.encryptedData, row.dataIv, now, row.id, tabId);
        }

        db.exec('COMMIT');
        return { ok: true, updatedAt: now };
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
}
