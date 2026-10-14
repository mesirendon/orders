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

export async function takeOverIdempotencyKey(
  db: Db,
  customerId: string,
  key: string,
  lockMs: number,
): Promise<IdempotencyKeyRow | undefined> {
  const { rows } = await db.query<IdempotencyKeyRow>(
    `UPDATE idempotency_keys
     SET locked_until = now() + make_interval(secs => $3 / 1000.0), updated_at = now()
     WHERE customer_id = $1 AND key = $2 AND status = 'IN_PROGRESS' AND locked_until <= now()
     RETURNING ${COLUMNS}`,
    [customerId, key, lockMs],
  );
  return rows[0];
}

export async function completeIdempotencyKeyForOrder(
  db: Db,
  orderId: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys
     SET status = 'COMPLETED', response_status = $2, response_body = $3, updated_at = now()
     WHERE order_id = $1 AND status = 'IN_PROGRESS'`,
    [orderId, responseStatus, JSON.stringify(responseBody)],
  );
}

export async function releaseIdempotencyKey(db: Db, customerId: string, key: string): Promise<void> {
  await db.query(
    `DELETE FROM idempotency_keys
     WHERE customer_id = $1 AND key = $2 AND status = 'IN_PROGRESS' AND order_id IS NULL`,
    [customerId, key],
  );
  await db.query(
    `UPDATE idempotency_keys SET locked_until = now(), updated_at = now()
     WHERE customer_id = $1 AND key = $2 AND status = 'IN_PROGRESS'`,
    [customerId, key],
  );
}

export async function claimAbandonedKeysForExpiredOrders(
  db: Db,
  lockMs: number,
  limit: number,
): Promise<{ orderId: string; totalCents: number }[]> {
  const { rows } = await db.query<{ order_id: string; total_cents: number }>(
    `UPDATE idempotency_keys ik
     SET locked_until = now() + make_interval(secs => $1 / 1000.0), updated_at = now()
     FROM orders o
     WHERE o.id = ik.order_id
       AND (ik.customer_id, ik.key) IN (
         SELECT k.customer_id, k.key
         FROM idempotency_keys k
         JOIN orders eo ON eo.id = k.order_id
         WHERE k.status = 'IN_PROGRESS' AND k.locked_until <= now() AND eo.status = 'EXPIRED'
         LIMIT $2
         FOR UPDATE OF k SKIP LOCKED
       )
     RETURNING ik.order_id, o.total_cents`,
    [lockMs, limit],
  );
  return rows.map((row) => ({ orderId: row.order_id, totalCents: row.total_cents }));
}
