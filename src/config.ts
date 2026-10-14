import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PAYMENT_BASE_URL: z.url(),
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  PAYMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  PAYMENT_BACKOFF_MS: z.coerce.number().int().min(0).default(200),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
});

export type Config = z.infer<typeof envSchema> & { paymentBudgetMs: number };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const values = parsed.data;

  let backoffTotalMs = 0;
  for (let attempt = 1; attempt < values.PAYMENT_MAX_ATTEMPTS; attempt++) {
    backoffTotalMs += values.PAYMENT_BACKOFF_MS * 2 ** (attempt - 1);
  }
  const statusLookupMs = values.PAYMENT_TIMEOUT_MS;
  const paymentBudgetMs =
    values.PAYMENT_MAX_ATTEMPTS * values.PAYMENT_TIMEOUT_MS + backoffTotalMs + statusLookupMs;

  if (values.RESERVATION_TTL_SECONDS * 1000 <= paymentBudgetMs) {
    throw new Error(
      `RESERVATION_TTL_SECONDS (${values.RESERVATION_TTL_SECONDS}s) must exceed the payment budget (${paymentBudgetMs}ms)`,
    );
  }

  return { ...values, paymentBudgetMs };
}
