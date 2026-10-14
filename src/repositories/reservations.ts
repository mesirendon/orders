import type { Db } from '../db/pool.js';
import type { RequestedItem } from './warehouses.js';

export async function insertReservations(
  db: Db,
  orderId: string,
  warehouseId: string,
  items: RequestedItem[],
  ttlSeconds: number,
): Promise<void> {
  await db.query(
    `INSERT INTO stock_reservations (order_id, warehouse_id, product_id, quantity, status, expires_at)
     SELECT $1, $2, r.product_id, r.quantity, 'ACTIVE', now() + make_interval(secs => $5)
     FROM unnest($3::uuid[], $4::int[]) AS r(product_id, quantity)`,
    [orderId, warehouseId, items.map((item) => item.productId), items.map((item) => item.quantity), ttlSeconds],
  );
}

export async function confirmActiveReservations(db: Db, orderId: string): Promise<number> {
  const result = await db.query(
    `UPDATE stock_reservations
     SET status = 'CONFIRMED', updated_at = now()
     WHERE order_id = $1 AND status = 'ACTIVE' AND expires_at > clock_timestamp()`,
    [orderId],
  );
  return result.rowCount ?? 0;
}
