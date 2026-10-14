import type { RequestedItem, WarehouseAvailability } from '../repositories/warehouses.js';

export interface Shortfall {
  bestWarehouseId: string | null;
  products: { productId: string; requested: number; available: number }[];
}

export function computeShortfall(items: RequestedItem[], availability: WarehouseAvailability[]): Shortfall {
  const byWarehouse = new Map<string, Map<string, number>>();
  for (const row of availability) {
    const products = byWarehouse.get(row.warehouseId) ?? new Map<string, number>();
    products.set(row.productId, row.available);
    byWarehouse.set(row.warehouseId, products);
  }

  let best: { warehouseId: string; covered: number; available: Map<string, number> } | null = null;
  for (const [warehouseId, available] of byWarehouse) {
    const covered = items.filter((item) => (available.get(item.productId) ?? 0) >= item.quantity).length;
    if (!best || covered > best.covered) {
      best = { warehouseId, covered, available };
    }
  }

  return {
    bestWarehouseId: best?.warehouseId ?? null,
    products: items
      .map((item) => ({
        productId: item.productId,
        requested: item.quantity,
        available: best?.available.get(item.productId) ?? 0,
      }))
      .filter((product) => product.available < product.requested),
  };
}
