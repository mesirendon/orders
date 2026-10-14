import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { registerHealthRoutes } from './routes/health.js';

export function buildApp(config: Config, pool: pg.Pool): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['cardNumber', '*.cardNumber', '*.*.cardNumber', '*.*.*.cardNumber'],
        censor: '[REDACTED]',
      },
    },
  });

  registerHealthRoutes(app, pool);

  return app;
}
