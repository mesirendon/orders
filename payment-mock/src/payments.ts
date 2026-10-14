import type pg from 'pg';

export type PaymentStatus = 'SUCCEEDED' | 'DECLINED';

export interface PaymentRow {
  idempotency_key: string;
  payment_id: string;
  status: PaymentStatus;
  amount_cents: number;
  card_last4: string;
  description: string;
  refund_idempotency_key: string | null;
  refunded_at: Date | null;
  created_at: Date;
}

export interface NewPayment {
  idempotencyKey: string;
  status: PaymentStatus;
  amountCents: number;
  cardLast4: string;
  description: string;
}

export async function recordPayment(
  pool: pg.Pool,
  payment: NewPayment,
): Promise<{ row: PaymentRow; created: boolean }> {
  const inserted = await pool.query<PaymentRow>(
    `INSERT INTO payment_mock.payments (idempotency_key, status, amount_cents, card_last4, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [payment.idempotencyKey, payment.status, payment.amountCents, payment.cardLast4, payment.description],
  );
  if (inserted.rows[0]) {
    return { row: inserted.rows[0], created: true };
  }
  const existing = await findPayment(pool, payment.idempotencyKey);
  if (!existing) {
    throw new Error(`payment ${payment.idempotencyKey} conflicted but was not found`);
  }
  return { row: existing, created: false };
}

export async function findPayment(pool: pg.Pool, idempotencyKey: string): Promise<PaymentRow | undefined> {
  const { rows } = await pool.query<PaymentRow>(
    'SELECT * FROM payment_mock.payments WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  return rows[0];
}

export async function markRefunded(
  pool: pg.Pool,
  idempotencyKey: string,
  refundIdempotencyKey: string,
): Promise<PaymentRow | undefined> {
  const { rows } = await pool.query<PaymentRow>(
    `UPDATE payment_mock.payments
     SET refunded_at = now(), refund_idempotency_key = $2
     WHERE idempotency_key = $1 AND status = 'SUCCEEDED' AND refunded_at IS NULL
     RETURNING *`,
    [idempotencyKey, refundIdempotencyKey],
  );
  return rows[0];
}
