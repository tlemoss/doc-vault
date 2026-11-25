import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canEditTab, getTabAccess, makeAuthHook } from '../auth.js';
import type { ServerConfig } from '../config.js';
import { type BlobStorage, checkQuota, getUserStorageUsage } from '../storage.js';

export function registerDocumentRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  storage: BlobStorage,
  config: ServerConfig
): void {
  const requireAuth = makeAuthHook(db);

  app.get<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/documents',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access) {
        return reply.code(403).send({ error: 'Sem acesso a esta aba.' });
      }

      const rows = db
        .prepare(
          `SELECT id, tab_id, kind, encrypted_meta, meta_iv,
                  encrypted_content, content_iv,
                  wrapped_file_key, file_key_iv, blob_iv, blob_size,
                  created_by, created_at, updated_at
           FROM documents
           WHERE tab_id = ? AND upload_complete = 1
           ORDER BY updated_at DESC`
        )
        .all(request.params.tabId) as Array<{
        id: string;
        tab_id: string;
        kind: 'file' | 'note';
        encrypted_meta: string;
        meta_iv: string;
        encrypted_content: string | null;
        content_iv: string | null;
        wrapped_file_key: string | null;
        file_key_iv: string | null;
        blob_iv: string | null;
        blob_size: number;
        created_by: string;
        created_at: string;
        updated_at: string;
      }>;

      return {
        documents: rows.map((r) => ({
          id: r.id,
          tabId: r.tab_id,
          kind: r.kind,
          encryptedMeta: r.encrypted_meta,
          metaIv: r.meta_iv,
          encryptedContent: r.encrypted_content,
          contentIv: r.content_iv,
          wrappedFileKey: r.wrapped_file_key,
          fileKeyIv: r.file_key_iv,
          blobIv: r.blob_iv,
          blobSize: Number(r.blob_size),
          createdBy: r.created_by,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      };
    }
  );

  app.post<{ Params: { tabId: string } }>(
    '/api/tabs/:tabId/documents',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para adicionar documentos nesta aba.' });
      }

      const tab = db
        .prepare('SELECT type FROM tabs WHERE id = ?')
        .get(request.params.tabId) as { type: string } | undefined;
      if (!tab || tab.type !== 'documents') {
        return reply.code(400).send({ error: 'Esta aba não é do tipo documentos.' });
      }

      const parsed = z
        .object({
          kind: z.enum(['file', 'note']),
          encryptedMeta: z.string().min(16).max(65536),
          metaIv: z.string().min(12).max(64),
          encryptedContent: z.string().max(4 * 1024 * 1024).nullable().optional(),
          contentIv: z.string().min(12).max(64).nullable().optional(),
          wrappedFileKey: z.string().min(16).max(512).nullable().optional(),
          fileKeyIv: z.string().min(12).max(64).nullable().optional(),
          blobIv: z.string().min(12).max(64).nullable().optional(),
          expectedBlobSize: z.number().int().min(0).max(config.maxFileSizeBytes + 4096).optional(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados do documento inválidos.' });
      }

      const d = parsed.data;
      if (d.kind === 'file' && (!d.wrappedFileKey || !d.fileKeyIv || !d.blobIv)) {
        return reply
          .code(400)
          .send({ error: 'Arquivos criptografados exigem chave empacotada e IVs.' });
      }
      if (d.kind === 'note' && (d.encryptedContent == null || !d.contentIv)) {
        return reply.code(400).send({ error: 'Notas exigem conteúdo criptografado e IV.' });
      }

      const estimatedAddition =
        d.encryptedMeta.length +
        (d.encryptedContent?.length ?? 0) +
        (d.expectedBlobSize ?? 0);

      const quota = checkQuota(db, request.authUser!.id, estimatedAddition);
      if (!quota.ok) {
        return reply.code(413).send({
          error: 'Espaço insuficiente na sua quota de armazenamento.',
          usedBytes: quota.usedBytes,
          quotaBytes: quota.quotaBytes,
        });
      }

      const docId = crypto.randomUUID();
      const now = new Date().toISOString();
      const uploadComplete = d.kind === 'note' ? 1 : 0;

      db.prepare(
        `INSERT INTO documents (
          id, tab_id, kind, encrypted_meta, meta_iv,
          encrypted_content, content_iv,
          wrapped_file_key, file_key_iv, blob_iv, blob_size, blob_path,
          upload_complete, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`
      ).run(
        docId,
        request.params.tabId,
        d.kind,
        d.encryptedMeta,
        d.metaIv,
        d.encryptedContent ?? null,
        d.contentIv ?? null,
        d.wrappedFileKey ?? null,
        d.fileKeyIv ?? null,
        d.blobIv ?? null,
        uploadComplete,
        request.authUser!.id,
        now,
        now
      );

      return reply.code(201).send({
        document: {
          id: docId,
          tabId: request.params.tabId,
          kind: d.kind,
          encryptedMeta: d.encryptedMeta,
          metaIv: d.metaIv,
          encryptedContent: d.encryptedContent ?? null,
          contentIv: d.contentIv ?? null,
          wrappedFileKey: d.wrappedFileKey ?? null,
          fileKeyIv: d.fileKeyIv ?? null,
          blobIv: d.blobIv ?? null,
          blobSize: 0,
          createdBy: request.authUser!.id,
          createdAt: now,
          updatedAt: now,
        },
        usedBytes: getUserStorageUsage(db, request.authUser!.id),
      });
    }
  );

  app.put<{ Params: { tabId: string; docId: string } }>(
    '/api/tabs/:tabId/documents/:docId/blob',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para enviar arquivos nesta aba.' });
      }

      const doc = db
        .prepare(
          'SELECT id, kind, blob_size, blob_path, created_by FROM documents WHERE id = ? AND tab_id = ?'
        )
        .get(request.params.docId, request.params.tabId) as
        | {
            id: string;
            kind: string;
            blob_size: number;
            blob_path: string | null;
            created_by: string;
          }
        | undefined;

      if (!doc || doc.kind !== 'file') {
        return reply.code(404).send({ error: 'Registro de arquivo não encontrado.' });
      }

      if (!Buffer.isBuffer(request.body)) {
        return reply
          .code(400)
          .send({ error: 'Envie o conteúdo criptografado como application/octet-stream.' });
      }

      const payload = request.body;
      if (payload.length > config.maxFileSizeBytes + 4096) {
        return reply.code(413).send({ error: 'Arquivo excede o tamanho máximo permitido.' });
      }

      const delta = payload.length - Number(doc.blob_size);
      const quota = checkQuota(db, doc.created_by, Math.max(0, delta));
      if (!quota.ok) {
        // Clean up incomplete placeholder record
        if (!doc.blob_path) {
          db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
        }
        return reply.code(413).send({
          error: 'Quota de armazenamento excedida.',
          usedBytes: quota.usedBytes,
          quotaBytes: quota.quotaBytes,
        });
      }

      const nextBlobName = storage.generateBlobName();
      storage.writeBlob(nextBlobName, payload);

      const now = new Date().toISOString();
      const headerIv = request.headers['x-blob-iv'];
      const nextBlobIv = typeof headerIv === 'string' && headerIv.length >= 12 ? headerIv : null;

      if (nextBlobIv) {
        db.prepare(
          `UPDATE documents SET
            blob_path = ?, blob_size = ?, blob_iv = ?, upload_complete = 1, updated_at = ?
           WHERE id = ?`
        ).run(nextBlobName, payload.length, nextBlobIv, now, doc.id);
      } else {
        db.prepare(
          `UPDATE documents SET
            blob_path = ?, blob_size = ?, upload_complete = 1, updated_at = ?
           WHERE id = ?`
        ).run(nextBlobName, payload.length, now, doc.id);
      }

      if (doc.blob_path) {
        storage.deleteBlob(doc.blob_path);
      }

      return {
        ok: true,
        blobSize: payload.length,
        updatedAt: now,
        usedBytes: getUserStorageUsage(db, request.authUser!.id),
      };
    }
  );

  app.get<{ Params: { tabId: string; docId: string } }>(
    '/api/tabs/:tabId/documents/:docId/blob',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access) {
        return reply.code(403).send({ error: 'Sem acesso a este arquivo.' });
      }

      const doc = db
        .prepare(
          'SELECT kind, blob_path, upload_complete FROM documents WHERE id = ? AND tab_id = ?'
        )
        .get(request.params.docId, request.params.tabId) as
        | { kind: string; blob_path: string | null; upload_complete: number }
        | undefined;

      if (!doc || doc.kind !== 'file' || doc.upload_complete !== 1 || !doc.blob_path) {
        return reply.code(404).send({ error: 'Arquivo criptografado não encontrado.' });
      }

      const data = storage.readBlob(doc.blob_path);
      if (!data) {
        return reply.code(404).send({ error: 'Conteúdo do arquivo não encontrado no disco.' });
      }

      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Cache-Control', 'no-store')
        .send(data);
    }
  );

  app.patch<{ Params: { tabId: string; docId: string } }>(
    '/api/tabs/:tabId/documents/:docId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para editar este documento.' });
      }

      const parsed = z
        .object({
          encryptedMeta: z.string().min(16).max(65536).optional(),
          metaIv: z.string().min(12).max(64).optional(),
          encryptedContent: z.string().max(4 * 1024 * 1024).optional(),
          contentIv: z.string().min(12).max(64).optional(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Dados inválidos para atualizar documento.' });
      }

      const existing = db
        .prepare('SELECT id, encrypted_meta, encrypted_content, created_by FROM documents WHERE id = ? AND tab_id = ?')
        .get(request.params.docId, request.params.tabId) as
        | {
            id: string;
            encrypted_meta: string;
            encrypted_content: string | null;
            created_by: string;
          }
        | undefined;

      if (!existing) {
        return reply.code(404).send({ error: 'Documento não encontrado.' });
      }

      const d = parsed.data;
      const updates: string[] = [];
      const values: string[] = [];
      let delta = 0;

      if (d.encryptedMeta !== undefined && d.metaIv !== undefined) {
        updates.push('encrypted_meta = ?', 'meta_iv = ?');
        values.push(d.encryptedMeta, d.metaIv);
        delta += d.encryptedMeta.length - existing.encrypted_meta.length;
      }
      if (d.encryptedContent !== undefined && d.contentIv !== undefined) {
        updates.push('encrypted_content = ?', 'content_iv = ?');
        values.push(d.encryptedContent, d.contentIv);
        delta += d.encryptedContent.length - (existing.encrypted_content?.length ?? 0);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'Nenhuma alteração enviada.' });
      }

      if (delta > 0) {
        const quota = checkQuota(db, existing.created_by, delta);
        if (!quota.ok) {
          return reply.code(413).send({ error: 'Quota de armazenamento excedida.' });
        }
      }

      const now = new Date().toISOString();
      updates.push('updated_at = ?');
      values.push(now, existing.id);

      db.prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      return {
        ok: true,
        updatedAt: now,
        usedBytes: getUserStorageUsage(db, request.authUser!.id),
      };
    }
  );

  app.delete<{ Params: { tabId: string; docId: string } }>(
    '/api/tabs/:tabId/documents/:docId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = getTabAccess(db, request.params.tabId, request.authUser!.id);
      if (!access || !canEditTab(access.role)) {
        return reply.code(403).send({ error: 'Sem permissão para excluir este documento.' });
      }

      const doc = db
        .prepare('SELECT id, blob_path FROM documents WHERE id = ? AND tab_id = ?')
        .get(request.params.docId, request.params.tabId) as
        | { id: string; blob_path: string | null }
        | undefined;

      if (!doc) {
        return reply.code(404).send({ error: 'Documento não encontrado.' });
      }

      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
      if (doc.blob_path) {
        storage.deleteBlob(doc.blob_path);
      }

      return {
        ok: true,
        usedBytes: getUserStorageUsage(db, request.authUser!.id),
      };
    }
  );
}
