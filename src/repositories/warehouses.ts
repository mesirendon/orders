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
