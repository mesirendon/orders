import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createPool, ensureSchema } from './db.js';
import { registerRoutes } from './routes.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: ['cardNumber', '*.cardNumber', '*.*.cardNumber'], censor: '[REDACTED]' },
    },
  });

  pool.on('error', (err) => app.log.error({ err }, 'idle postgres client error'));
  await ensureSchema(pool);
  registerRoutes(app, pool, config);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), config.SLOW_RESPONSE_MS + 5000).unref();
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.PORT });
}

main().catch((err) => {
  console.error('failed to start', err);
  process.exit(1);
});
