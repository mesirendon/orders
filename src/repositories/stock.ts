import type { Db } from '../db/pool.js';

export async function lockStockRows(
  db: Db,
  warehouseId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ product_id: string; on_hand: number }>(
    `SELECT product_id, on_hand
     FROM warehouse_stock
     WHERE warehouse_id = $1 AND product_id = ANY($2::uuid[])
     ORDER BY product_id
     FOR UPDATE`,
    [warehouseId, productIds],
  );
  return new Map(rows.map((row) => [row.product_id, row.on_hand]));
}

export async function sumActiveReservations(
  db: Db,
  warehouseId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ product_id: string; reserved: number }>(
    `SELECT product_id, sum(quantity)::int AS reserved
     FROM stock_reservations
     WHERE warehouse_id = $1
       AND product_id = ANY($2::uuid[])
       AND status = 'ACTIVE'
       AND expires_at > now()
     GROUP BY product_id`,
    [warehouseId, productIds],
  );
  return new Map(rows.map((row) => [row.product_id, row.reserved]));
}

export async function decrementOnHandForOrder(db: Db, orderId: string): Promise<number> {
  const result = await db.query(
    `UPDATE warehouse_stock ws
     SET on_hand = ws.on_hand - sr.quantity, updated_at = now()
     FROM stock_reservations sr
     WHERE sr.order_id = $1
       AND sr.status = 'CONFIRMED'
       AND ws.warehouse_id = sr.warehouse_id
       AND ws.product_id = sr.product_id`,
    [orderId],
  );
  return result.rowCount ?? 0;
}
