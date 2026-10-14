import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { MockGeocoder } from './geocoder/mockGeocoder.js';
import { HttpPaymentGateway } from './payments/httpPaymentGateway.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const app = buildApp({
    pool,
    config,
    geocoder: new MockGeocoder(),
    payments: new HttpPaymentGateway(config.PAYMENT_BASE_URL, config.PAYMENT_TIMEOUT_MS),
  });

  pool.on('error', (err) => app.log.error({ err }, 'idle postgres client error'));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), config.paymentBudgetMs + 5000).unref();
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
