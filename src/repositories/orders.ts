import type { Db } from '../db/pool.js';
import type { Address, Coordinates } from '../geocoder/geocoder.js';

export type OrderStatus =
  | 'PENDING'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_UNKNOWN'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING';

export interface NewOrderItem {
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface NewOrder {
  id: string;
  customerId: string;
  warehouseId: string;
  totalCents: number;
  shippingAddress: Address;
  shippingLocation: Coordinates;
  items: NewOrderItem[];
}

export interface OrderRecord {
  id: string;
  customerId: string;
  status: OrderStatus;
  warehouseId: string;
  totalCents: number;
  shippingAddress: Address;
  shippingLocation: Coordinates;
  items: NewOrderItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface LockedOrder {
  id: string;
  status: OrderStatus;
  warehouseId: string;
  productIds: string[];
}

export async function insertOrder(db: Db, order: NewOrder): Promise<void> {
  await db.query(
    `INSERT INTO orders (
       id, customer_id, status, warehouse_id, total_cents,
       shipping_line1, shipping_city, shipping_postal_code, shipping_country, shipping_location
     ) VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, $8, ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography)`,
    [
      order.id,
      order.customerId,
      order.warehouseId,
      order.totalCents,
      order.shippingAddress.line1,
      order.shippingAddress.city,
      order.shippingAddress.postalCode,
      order.shippingAddress.country,
      order.shippingLocation.lng,
      order.shippingLocation.lat,
    ],
  );
  await db.query(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
     SELECT $1, i.product_id, i.quantity, i.unit_price_cents
     FROM unnest($2::uuid[], $3::int[], $4::int[]) AS i(product_id, quantity, unit_price_cents)`,
    [
      order.id,
      order.items.map((item) => item.productId),
      order.items.map((item) => item.quantity),
      order.items.map((item) => item.unitPriceCents),
    ],
  );
}

export async function lockOrder(db: Db, orderId: string): Promise<LockedOrder | undefined> {
  const { rows } = await db.query<{ id: string; status: OrderStatus; warehouse_id: string }>(
    'SELECT id, status, warehouse_id FROM orders WHERE id = $1 FOR UPDATE',
    [orderId],
  );
  const order = rows[0];
  if (!order) return undefined;
  const items = await db.query<{ product_id: string }>(
    'SELECT product_id FROM order_items WHERE order_id = $1 ORDER BY product_id',
    [orderId],
  );
  return {
    id: order.id,
    status: order.status,
    warehouseId: order.warehouse_id,
    productIds: items.rows.map((row) => row.product_id),
  };
}

export async function updateOrderStatus(
  db: Db,
  orderId: string,
  fromStatuses: OrderStatus[],
  toStatus: OrderStatus,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE orders SET status = $3, updated_at = now()
     WHERE id = $1 AND status = ANY($2::text[])`,
    [orderId, fromStatuses, toStatus],
  );
  return result.rowCount === 1;
}

export async function updateOrderWarehouse(db: Db, orderId: string, warehouseId: string): Promise<void> {
  await db.query('UPDATE orders SET warehouse_id = $2, updated_at = now() WHERE id = $1', [orderId, warehouseId]);
}

export async function findOrder(db: Db, orderId: string): Promise<OrderRecord | undefined> {
  const { rows } = await db.query<{
    id: string;
    customer_id: string;
    status: OrderStatus;
    warehouse_id: string;
    total_cents: number;
    shipping_line1: string;
    shipping_city: string;
    shipping_postal_code: string;
    shipping_country: string;
    lat: number;
    lng: number;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, customer_id, status, warehouse_id, total_cents,
            shipping_line1, shipping_city, shipping_postal_code, shipping_country,
            ST_Y(shipping_location::geometry) AS lat, ST_X(shipping_location::geometry) AS lng,
            created_at, updated_at
     FROM orders WHERE id = $1`,
    [orderId],
  );
  const order = rows[0];
  if (!order) return undefined;

  const items = await db.query<{ product_id: string; quantity: number; unit_price_cents: number }>(
    'SELECT product_id, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY product_id',
    [orderId],
  );

  return {
    id: order.id,
    customerId: order.customer_id,
    status: order.status,
    warehouseId: order.warehouse_id,
    totalCents: order.total_cents,
    shippingAddress: {
      line1: order.shipping_line1,
      city: order.shipping_city,
      postalCode: order.shipping_postal_code,
      country: order.shipping_country,
    },
    shippingLocation: { lat: order.lat, lng: order.lng },
    items: items.rows.map((row) => ({
      productId: row.product_id,
      quantity: row.quantity,
      unitPriceCents: row.unit_price_cents,
    })),
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

export async function lockOrdersWithExpiredReservations(db: Db, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT o.id
     FROM orders o
     WHERE o.status IN ('PENDING', 'PAYMENT_UNKNOWN')
       AND EXISTS (
         SELECT 1 FROM stock_reservations sr
         WHERE sr.order_id = o.id AND sr.status = 'ACTIVE' AND sr.expires_at <= now()
       )
     ORDER BY o.created_at
     LIMIT $1
     FOR UPDATE OF o SKIP LOCKED`,
    [limit],
  );
  return rows.map((row) => row.id);
}

export async function expirePendingOrders(db: Db, orderIds: string[]): Promise<number> {
  const result = await db.query(
    `UPDATE orders SET status = 'EXPIRED', updated_at = now()
     WHERE id = ANY($1::uuid[]) AND status = 'PENDING'`,
    [orderIds],
  );
  return result.rowCount ?? 0;
}

export async function claimOrdersForReconciliation(
  db: Db,
  status: OrderStatus,
  leaseSeconds: number,
  limit: number,
): Promise<{ orderId: string; totalCents: number }[]> {
  const { rows } = await db.query<{ id: string; total_cents: number }>(
    `UPDATE orders SET updated_at = now()
     WHERE id IN (
       SELECT id FROM orders
       WHERE status = $1 AND updated_at <= now() - make_interval(secs => $2)
       ORDER BY updated_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, total_cents`,
    [status, leaseSeconds, limit],
  );
  return rows.map((row) => ({ orderId: row.id, totalCents: row.total_cents }));
}
