import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  blobsDir: string;
  defaultQuotaBytes: number;
  maxFileSizeBytes: number;
  cookieSecure: boolean;
  sessionTtlMs: number;
  clientDistDir: string;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.DATA_DIR ?? path.join(__dirname, '../../data')
  );
  const clientDistDir = path.resolve(
    overrides.clientDistDir ?? process.env.CLIENT_DIST_DIR ?? path.join(__dirname, '../../client/dist')
  );

  return {
    port: overrides.port ?? Number(process.env.PORT ?? 3000),
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'vault.db'),
    blobsDir: overrides.blobsDir ?? path.join(dataDir, 'blobs'),
    defaultQuotaBytes:
      overrides.defaultQuotaBytes ??
      Number(process.env.DEFAULT_QUOTA_BYTES ?? 1024 * 1024 * 1024), // 1 GB default
    maxFileSizeBytes:
      overrides.maxFileSizeBytes ??
      Number(process.env.MAX_FILE_SIZE_BYTES ?? 100 * 1024 * 1024), // 100 MB per file
    cookieSecure:
      overrides.cookieSecure ?? process.env.COOKIE_SECURE === 'true',
    sessionTtlMs:
      overrides.sessionTtlMs ??
      Number(process.env.SESSION_TTL_HOURS ?? 24) * 60 * 60 * 1000,
    clientDistDir,
  };
}
