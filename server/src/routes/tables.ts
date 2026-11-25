import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canEditTab, getTabAccess, makeAuthHook } from '../auth.js';
import { checkQuota, getUserStorageUsage } from '../storage.js';

export function registerTableRoutes(app: FastifyInstance, db: DatabaseSync): void {
  const requireAuth = makeAuthHook(db);

  app.get<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/rows',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access) {
        return reply.code(403).send({ error: 'Sem acesso a esta tabela.' });
      }

      const rows = db
        .prepare(
          `SELECT id, tab_id, sort_order, encrypted_data, data_iv, created_by, created_at, updated_at
           FROM table_rows
           WHERE tab_id = ?
           ORDER BY sort_order ASC, created_at ASC`
        )
        .all(request.params.tabId) as Array<{
        id: string;
        tab_id: string;
        sort_order: number;
        encrypted_data: string;
        data_iv: string;
        created_by: string;
        created_at: string;
        updated_at: string;
      }>;

      return {
        rows: rows.map((r) => ({
          id: r.id,
          tabId: r.tab_id,
          sortOrder: Number(r.sort_order),
          encryptedData: r.encrypted_data,
          dataIv: r.data_iv,
          createdBy: r.created_by,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      };
    }
  );

  app.post<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/rows',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para inserir registros nesta tabela.' });
      }

      const tab = db
        .prepare('SELECT type FROM tabs WHERE id = ?')
        .get(request.params.tabId) as { type: string } | undefined;
      if (!tab || tab.type !== 'table') {
        return reply.code(400).send({ error: 'Esta aba não é do tipo tabela.' });
      }

      const parsed = z
        .object({
          encryptedData: z.string().min(16).max(524288),
          dataIv: z.string().min(12).max(64),
          sortOrder: z.number().optional(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados do registro inválidos.' });
      }

      const quota = checkQuota(db, request.authUser!.id, parsed.data.encryptedData.length);
      if (!quota.ok) {
        return reply.code(413).send({ error: 'Quota de armazenamento excedida.' });
      }

      let sortOrder = parsed.data.sortOrder;
      if (sortOrder === undefined) {
        const maxRow = db
          .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM table_rows WHERE tab_id = ?')
          .get(request.params.tabId) as { max_order: number };
        sortOrder = Number(maxRow.max_order) + 1;
      }

      const rowId = crypto.randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO table_rows (
          id, tab_id, sort_order, encrypted_data, data_iv, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rowId,
        request.params.tabId,
        sortOrder,
        parsed.data.encryptedData,
        parsed.data.dataIv,
        request.authUser!.id,
        now,
        now
      );

      return reply.code(201).send({
        row: {
          id: rowId,
          tabId: request.params.tabId,
          sortOrder,
          encryptedData: parsed.data.encryptedData,
          dataIv: parsed.data.dataIv,
          createdBy: request.authUser!.id,
          createdAt: now,
          updatedAt: now,
        },
        usedBytes: getUserStorageUsage(db, request.authUser!.id),
      });
    }
  );

  app.patch<{ Params: { tabId: string; rowId: string } }>(
    '/api/tabs/:tabId/rows/:rowId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para editar registros nesta tabela.' });
      }

      const parsed = z
        .object({
          encryptedData: z.string().min(16).max(524288),
          dataIv: z.string().min(12).max(64),
          sortOrder: z.number().optional(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados inválidos para atualizar registro.' });
      }

      const existing = db
        .prepare('SELECT id, encrypted_data, created_by FROM table_rows WHERE id = ? AND tab_id = ?')
        .get(request.params.rowId, request.params.tabId) as
        | { id: string; encrypted_data: string; created_by: string }
        | undefined;

      if (!existing) {
        return reply.code(404).send({ error: 'Registro não encontrado.' });
      }

      const delta = parsed.data.encryptedData.length - existing.encrypted_data.length;
      if (delta > 0) {
        const quota = checkQuota(db, existing.created_by, delta);
        if (!quota.ok) {
          return reply.code(413).send({ error: 'Quota de armazenamento excedida.' });
        }
      }

      const now = new Date().toISOString();
      if (parsed.data.sortOrder !== undefined) {
        db.prepare(
          `UPDATE table_rows SET encrypted_data = ?, data_iv = ?, sort_order = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          parsed.data.encryptedData,
          parsed.data.dataIv,
          parsed.data.sortOrder,
          now,
          existing.id
        );
      } else {
        db.prepare(
          `UPDATE table_rows SET encrypted_data = ?, data_iv = ?, updated_at = ?
           WHERE id = ?`
        ).run(parsed.data.encryptedData, parsed.data.dataIv, now, existing.id);
      }

      return { ok: true, updatedAt: now };
    }
  );

  app.delete<{ Params: { tabId: string; rowId: string } }>(
    '/api/tabs/:tabId/rows/:rowId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para excluir registros nesta tabela.' });
      }

      const res = db
        .prepare('DELETE FROM table_rows WHERE id = ? AND tab_id = ?')
        .run(request.params.rowId, request.params.tabId);

      if (res.changes === 0) {
        return reply.code(404).send({ error: 'Registro não encontrado.' });
      }

      return { ok: true };
    }
  );

  app.post<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/rows/batch-delete',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para excluir registros nesta tabela.' });
      }

      const parsed = z
        .object({ rowIds: z.array(z.string().uuid()).min(1).max(500) })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Lista de registros inválida.' });
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        const stmt = db.prepare('DELETE FROM table_rows WHERE id = ? AND tab_id = ?');
        for (const id of parsed.data.rowIds) {
          stmt.run(id, request.params.tabId);
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }

      return { ok: true };
    }
  );
}
