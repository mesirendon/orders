import { withTransaction } from '../db/transaction.js';
import { expirePendingOrders, lockOrdersWithExpiredReservations } from '../repositories/orders.js';
import { expireLapsedReservations } from '../repositories/reservations.js';
import type { Deps, Logger } from './types.js';

const BATCH_SIZE = 100;

export async function sweepExpiredReservations(deps: Deps, log: Logger): Promise<void> {
  const result = await withTransaction(deps.pool, async (tx) => {
    const orderIds = await lockOrdersWithExpiredReservations(tx, BATCH_SIZE);
    if (orderIds.length === 0) return { reservations: 0, orders: 0 };
    const reservations = await expireLapsedReservations(tx, orderIds);
    const orders = await expirePendingOrders(tx, orderIds);
    return { reservations, orders };
  });

  if (result.reservations > 0) {
    log.info(result, 'expired lapsed reservations');
  }
}
