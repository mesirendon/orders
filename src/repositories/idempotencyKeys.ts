import type { Db } from '../db/pool.js';

export interface IdempotencyKeyRow {
  customer_id: string;
  key: string;
  request_hash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  locked_until: Date;
  order_id: string | null;
  response_status: number | null;
  response_body: unknown;
  lock_expired: boolean;
}

const COLUMNS = `customer_id, key, request_hash, status, locked_until, order_id,
  response_status, response_body, locked_until <= now() AS lock_expired`;

export async function insertIdempotencyKey(
  db: Db,
  customerId: string,
  key: string,
  requestHash: string,
  lockMs: number,
): Promise<IdempotencyKeyRow | undefined> {
  const { rows } = await db.query<IdempotencyKeyRow>(
    `INSERT INTO idempotency_keys (customer_id, key, request_hash, status, locked_until)
     VALUES ($1, $2, $3, 'IN_PROGRESS', now() + make_interval(secs => $4 / 1000.0))
     ON CONFLICT (customer_id, key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [customerId, key, requestHash, lockMs],
  );
  return rows[0];
}

export async function findIdempotencyKey(
  db: Db,
  customerId: string,
  key: string,
): Promise<IdempotencyKeyRow | undefined> {
  const { rows } = await db.query<IdempotencyKeyRow>(
    `SELECT ${COLUMNS} FROM idempotency_keys WHERE customer_id = $1 AND key = $2`,
    [customerId, key],
  );
  return rows[0];
}

export async function attachOrderToKey(db: Db, customerId: string, key: string, orderId: string): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys SET order_id = $3, updated_at = now()
     WHERE customer_id = $1 AND key = $2 AND status = 'IN_PROGRESS'`,
    [customerId, key, orderId],
  );
}

export async function completeIdempotencyKey(
  db: Db,
  customerId: string,
  key: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys
     SET status = 'COMPLETED', response_status = $3, response_body = $4, updated_at = now()
     WHERE customer_id = $1 AND key = $2 AND status = 'IN_PROGRESS'`,
    [customerId, key, responseStatus, JSON.stringify(responseBody)],
  );
}

export async function releaseIdempotencyKey(db: Db, customerId: string, key: string): Promise<void> {
  await db.query(
    `DELETE FROM idempotency_keys
     WHERE customer_id = $1 AND key = $2 AND status = 'IN_PROGRESS' AND order_id IS NULL`,
    [customerId, key],
  );
}
