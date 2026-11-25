import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { DatabaseSync } from 'node:sqlite';
import { type ServerConfig, loadConfig } from './config.js';
import { initDatabase } from './db.js';
import { BlobStorage } from './storage.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerTabRoutes } from './routes/tabs.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerTableRoutes } from './routes/tables.js';

export interface BuiltApp {
  app: FastifyInstance;
  db: DatabaseSync;
  storage: BlobStorage;
  config: ServerConfig;
}

export async function buildApp(
  configOverrides: Partial<ServerConfig> = {},
  options: { logger?: boolean; disableRateLimit?: boolean } = {}
): Promise<BuiltApp> {
  const config = loadConfig(configOverrides);
  const db = initDatabase(config.dbPath);
  const storage = new BlobStorage(config.blobsDir);

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: Math.max(config.maxFileSizeBytes + 16384, 10 * 1024 * 1024),
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  if (!options.disableRateLimit) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
    });
  }

  // Raw binary body parser for encrypted file blobs
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: config.maxFileSizeBytes + 4096 },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerAuthRoutes(app, db, config);
  registerUserRoutes(app, db, config);
  registerTabRoutes(app, db, storage);
  registerDocumentRoutes(app, db, storage, config);
  registerTableRoutes(app, db);

  // Serve built frontend static files in production / self-hosted single-server mode
  if (fs.existsSync(path.join(config.clientDistDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.clientDistDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Endpoint não encontrado.' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    db.close();
  });

  return { app, db, storage, config };
}
