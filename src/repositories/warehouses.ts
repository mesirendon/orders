import type { Db } from '../db/pool.js';
import type { Coordinates } from '../geocoder/geocoder.js';

export interface RequestedItem {
  productId: string;
  quantity: number;
}

export interface CandidateWarehouse {
  warehouseId: string;
  distanceMeters: number;
}

export async function findCandidateWarehouses(
  db: Db,
  items: RequestedItem[],
  destination: Coordinates,
): Promise<CandidateWarehouse[]> {
  const { rows } = await db.query<{ warehouse_id: string; distance_meters: number }>(
    `WITH requested AS (
       SELECT * FROM unnest($1::uuid[], $2::int[]) AS r(product_id, quantity)
     )
     SELECT w.id AS warehouse_id,
            ST_Distance(w.location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS distance_meters
     FROM warehouses w
     JOIN warehouse_stock ws ON ws.warehouse_id = w.id
     JOIN requested r ON r.product_id = ws.product_id AND ws.on_hand >= r.quantity
     GROUP BY w.id
     HAVING count(*) = (SELECT count(*) FROM requested)
     ORDER BY distance_meters, w.id`,
    [items.map((item) => item.productId), items.map((item) => item.quantity), destination.lng, destination.lat],
  );
  return rows.map((row) => ({ warehouseId: row.warehouse_id, distanceMeters: row.distance_meters }));
}

export interface WarehouseAvailability {
  warehouseId: string;
  productId: string;
  available: number;
}

export async function findAvailabilityByWarehouse(
  db: Db,
  productIds: string[],
  destination: Coordinates,
): Promise<WarehouseAvailability[]> {
  const { rows } = await db.query<{ warehouse_id: string; product_id: string; available: number }>(
    `SELECT w.id AS warehouse_id,
            p.product_id,
            GREATEST(COALESCE(ws.on_hand, 0) - COALESCE(res.reserved, 0), 0)::int AS available
     FROM warehouses w
     CROSS JOIN unnest($1::uuid[]) AS p(product_id)
     LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id AND ws.product_id = p.product_id
     LEFT JOIN (
       SELECT warehouse_id, product_id, sum(quantity) AS reserved
       FROM stock_reservations
       WHERE status = 'ACTIVE' AND expires_at > now() AND product_id = ANY($1::uuid[])
       GROUP BY warehouse_id, product_id
     ) res ON res.warehouse_id = w.id AND res.product_id = p.product_id
     ORDER BY ST_Distance(w.location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography), w.id, p.product_id`,
    [productIds, destination.lng, destination.lat],
  );
  return rows.map((row) => ({ warehouseId: row.warehouse_id, productId: row.product_id, available: row.available }));
}
