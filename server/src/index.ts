import { buildApp } from './app.js';

async function main() {
  const { app, config } = await buildApp({}, { logger: true });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Documents Vault rodando em http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Falha ao iniciar servidor:', err);
  process.exit(1);
});
