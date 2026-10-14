import Fastify, { type FastifyInstance } from 'fastify';
import { isDatabaseTimeout } from './db/errors.js';
import { AppError, appErrorBody, errorBody } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerOrderRoutes } from './routes/orders.js';
import type { Deps } from './services/types.js';

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      redact: {
        paths: ['cardNumber', '*.cardNumber', '*.*.cardNumber', '*.*.*.cardNumber'],
        censor: '[REDACTED]',
      },
    },
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) request.log.error({ err }, 'request failed');
      return reply.code(err.statusCode).send(appErrorBody(err));
    }
    if (isDatabaseTimeout(err)) {
      request.log.warn({ err }, 'database lock or statement timeout');
      return reply
        .code(503)
        .header('retry-after', '1')
        .send(errorBody('DATABASE_BUSY', 'The database is busy; retry the request'));
    }
    const statusCode = typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(errorBody('BAD_REQUEST', err instanceof Error ? err.message : 'Bad request'));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });

  registerHealthRoutes(app, deps.pool);
  registerOrderRoutes(app, deps);

  return app;
}
