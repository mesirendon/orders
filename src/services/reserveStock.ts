import type pg from 'pg';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import type { Address, Coordinates } from '../geocoder/geocoder.js';
import { attachOrderToKey } from '../repositories/idempotencyKeys.js';
import { insertOrder } from '../repositories/orders.js';
import { findProductPrices } from '../repositories/products.js';
import { insertReservations } from '../repositories/reservations.js';
import { lockStockRows, sumActiveReservations } from '../repositories/stock.js';
import {
  findAvailabilityByWarehouse,
  findCandidateWarehouses,
  type RequestedItem,
} from '../repositories/warehouses.js';
import { computeShortfall } from './stockShortfall.js';

export interface ReserveStockInput {
  orderId: string;
  customerId: string;
  idempotencyKey: string;
  shippingAddress: Address;
  shippingLocation: Coordinates;
  items: RequestedItem[];
  ttlSeconds: number;
}

export interface Reservation {
  orderId: string;
  warehouseId: string;
  totalCents: number;
}

export async function reserveStock(pool: pg.Pool, input: ReserveStockInput): Promise<Reservation> {
  return withTransaction(pool, async (tx) => {
    const productIds = input.items.map((item) => item.productId);
    const prices = await findProductPrices(tx, productIds);
    const unknownProductIds = productIds.filter((id) => !prices.has(id));
    if (unknownProductIds.length > 0) {
      throw new AppError(422, 'UNKNOWN_PRODUCT', 'Some products do not exist', { productIds: unknownProductIds });
    }

    const warehouseId = await lockFirstAvailableWarehouse(tx, input.items, input.shippingLocation);
    if (warehouseId) {
      const orderItems = input.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: prices.get(item.productId)!,
      }));
      const totalCents = orderItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);

      await insertOrder(tx, {
        id: input.orderId,
        customerId: input.customerId,
        warehouseId,
        totalCents,
        shippingAddress: input.shippingAddress,
        shippingLocation: input.shippingLocation,
        items: orderItems,
      });
      await insertReservations(tx, input.orderId, warehouseId, input.items, input.ttlSeconds, 'ACTIVE');
      await attachOrderToKey(tx, input.customerId, input.idempotencyKey, input.orderId);

      return { orderId: input.orderId, warehouseId, totalCents };
    }

    const availability = await findAvailabilityByWarehouse(tx, productIds, input.shippingLocation);
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK',
      'No single warehouse can fulfil this order',
      computeShortfall(input.items, availability),
    );
  });
}

export async function lockFirstAvailableWarehouse(
  tx: pg.PoolClient,
  items: RequestedItem[],
  destination: Coordinates,
): Promise<string | null> {
  const candidates = await findCandidateWarehouses(tx, items, destination);
  for (const candidate of candidates) {
    await tx.query('SAVEPOINT candidate');
    if (await hasAvailableStock(tx, candidate.warehouseId, items)) {
      await tx.query('RELEASE SAVEPOINT candidate');
      return candidate.warehouseId;
    }
    await tx.query('ROLLBACK TO SAVEPOINT candidate');
  }
  return null;
}

async function hasAvailableStock(tx: pg.PoolClient, warehouseId: string, items: RequestedItem[]): Promise<boolean> {
  const productIds = items.map((item) => item.productId);
  const onHand = await lockStockRows(tx, warehouseId, productIds);
  const reserved = await sumActiveReservations(tx, warehouseId, productIds);
  return items.every((item) => {
    const available = (onHand.get(item.productId) ?? 0) - (reserved.get(item.productId) ?? 0);
    return available >= item.quantity;
  });
}
