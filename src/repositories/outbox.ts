import type { Db } from '../db/pool.js';

export interface OutboxEvent {
  id: string;
  aggregateId: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export async function insertOutboxEvent(
  db: Db,
  event: { aggregateId: string; type: string; payload: unknown },
): Promise<void> {
  await db.query('INSERT INTO outbox (aggregate_id, type, payload) VALUES ($1, $2, $3)', [
    event.aggregateId,
    event.type,
    JSON.stringify(event.payload),
  ]);
}

export async function lockUnpublishedEvents(db: Db, limit: number): Promise<OutboxEvent[]> {
  const { rows } = await db.query<{
    id: string;
    aggregate_id: string;
    type: string;
    payload: unknown;
    created_at: Date;
  }>(
    `SELECT id, aggregate_id, type, payload, created_at
     FROM outbox
     WHERE published_at IS NULL
     ORDER BY id
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    aggregateId: row.aggregate_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

export async function markEventsPublished(db: Db, ids: string[]): Promise<void> {
  await db.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [ids]);
}
