import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const BLOB_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.enc$/;

export class BlobStorage {
  private readonly dir: string;

  constructor(blobsDir: string) {
    this.dir = path.resolve(blobsDir);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  generateBlobName(): string {
    return `${crypto.randomUUID()}.enc`;
  }

  private resolveSafePath(blobName: string): string {
    if (!BLOB_NAME_RE.test(blobName)) {
      throw new Error('Invalid blob identifier');
    }
    const resolved = path.resolve(this.dir, blobName);
    if (!resolved.startsWith(this.dir + path.sep)) {
      throw new Error('Path traversal rejected');
    }
    return resolved;
  }

  writeBlob(blobName: string, data: Buffer): void {
    const target = this.resolveSafePath(blobName);
    const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  readBlob(blobName: string): Buffer | null {
    const target = this.resolveSafePath(blobName);
    if (!fs.existsSync(target)) {
      return null;
    }
    return fs.readFileSync(target);
  }

  deleteBlob(blobName: string | null | undefined): void {
    if (!blobName || !BLOB_NAME_RE.test(blobName)) return;
    const target = this.resolveSafePath(blobName);
    try {
      fs.unlinkSync(target);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

export function getUserStorageUsage(db: DatabaseSync, userId: string): number {
  const docRow = db
    .prepare(
      `SELECT COALESCE(SUM(
        blob_size + LENGTH(encrypted_meta) + COALESCE(LENGTH(encrypted_content), 0)
      ), 0) AS total
      FROM documents
      WHERE created_by = ?`
    )
    .get(userId) as { total: number };

  const tableRow = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(encrypted_data)), 0) AS total
      FROM table_rows
      WHERE created_by = ?`
    )
    .get(userId) as { total: number };

  return Number(docRow.total) + Number(tableRow.total);
}

export function checkQuota(
  db: DatabaseSync,
  userId: string,
  additionalBytes: number
): { ok: boolean; usedBytes: number; quotaBytes: number } {
  const user = db
    .prepare('SELECT quota_bytes FROM users WHERE id = ?')
    .get(userId) as { quota_bytes: number } | undefined;

  if (!user) {
    return { ok: false, usedBytes: 0, quotaBytes: 0 };
  }

  const usedBytes = getUserStorageUsage(db, userId);
  const quotaBytes = Number(user.quota_bytes);
  return {
    ok: usedBytes + additionalBytes <= quotaBytes,
    usedBytes,
    quotaBytes,
  };
}
