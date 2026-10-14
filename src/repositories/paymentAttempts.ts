import type { Db } from '../db/pool.js';

export type PaymentAttemptStatus = 'SUCCEEDED' | 'DECLINED' | 'FAILED' | 'UNKNOWN' | 'REFUNDED';

export interface NewPaymentAttempt {
  orderId: string;
  idempotencyKey: string;
  status: PaymentAttemptStatus;
  cardLast4: string;
  processorPaymentId: string | null;
  amountCents: number;
  error: string | null;
}

export async function insertPaymentAttempt(db: Db, attempt: NewPaymentAttempt): Promise<void> {
  await db.query(
    `INSERT INTO payment_attempts
       (order_id, idempotency_key, status, card_last4, processor_payment_id, amount_cents, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      attempt.orderId,
      attempt.idempotencyKey,
      attempt.status,
      attempt.cardLast4,
      attempt.processorPaymentId,
      attempt.amountCents,
      attempt.error,
    ],
  );
}

export async function findLatestCardLast4(db: Db, orderId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ card_last4: string }>(
    'SELECT card_last4 FROM payment_attempts WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
    [orderId],
  );
  return rows[0]?.card_last4;
}
