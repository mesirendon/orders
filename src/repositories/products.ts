import type { Db } from '../db/pool.js';

export async function findProductPrices(db: Db, productIds: string[]): Promise<Map<string, number>> {
  const { rows } = await db.query<{ id: string; price_cents: number }>(
    'SELECT id, price_cents FROM products WHERE id = ANY($1::uuid[])',
    [productIds],
  );
  return new Map(rows.map((row) => [row.id, row.price_cents]));
}
