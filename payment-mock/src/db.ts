import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS payment_mock;

    CREATE TABLE IF NOT EXISTS payment_mock.payments (
      idempotency_key text PRIMARY KEY,
      payment_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      status text NOT NULL CHECK (status IN ('SUCCEEDED', 'DECLINED')),
      amount_cents integer NOT NULL CHECK (amount_cents > 0),
      card_last4 char(4) NOT NULL,
      description text NOT NULL,
      refund_idempotency_key text,
      refunded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}
