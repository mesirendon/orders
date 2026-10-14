import { withTransaction } from '../db/transaction.js';
import { completeIdempotencyKeyForOrder } from '../repositories/idempotencyKeys.js';
import {
  findOrder,
  lockOrder,
  updateOrderStatus,
  updateOrderWarehouse,
  type OrderStatus,
} from '../repositories/orders.js';
import { insertPaymentAttempt } from '../repositories/paymentAttempts.js';
import { expireActiveReservationsForOrder, insertReservations } from '../repositories/reservations.js';
import { decrementOnHandForOrder } from '../repositories/stock.js';
import { recordOrderPaid } from './orderEvents.js';
import { paidResponse, responseForOrder } from './orderResponses.js';
import { refundOrder } from './refundOrder.js';
import { lockFirstAvailableWarehouse } from './reserveStock.js';
import type { ChargedOrder, Deps, HttpResult, Logger } from './types.js';

const RE_RESERVABLE_STATUSES: OrderStatus[] = ['PENDING', 'PAYMENT_UNKNOWN', 'EXPIRED'];

type ReReserveOutcome = { kind: 'SETTLED'; response: HttpResult } | { kind: 'REFUND_REQUIRED' };

export async function reReserveOrRefund(deps: Deps, charged: ChargedOrder, log: Logger): Promise<HttpResult> {
  const outcome = await withTransaction(deps.pool, async (tx): Promise<ReReserveOutcome> => {
    const locked = await lockOrder(tx, charged.orderId);
    const order = (await findOrder(tx, charged.orderId))!;
    if (!locked || !RE_RESERVABLE_STATUSES.includes(locked.status)) {
      const response = responseForOrder(order);
      await completeIdempotencyKeyForOrder(tx, order.id, response.statusCode, response.body);
      return { kind: 'SETTLED', response };
    }

    await expireActiveReservationsForOrder(tx, order.id);
    await insertPaymentAttempt(tx, {
      orderId: order.id,
      idempotencyKey: order.id,
      status: 'SUCCEEDED',
      cardLast4: charged.cardLast4,
      processorPaymentId: charged.paymentId,
      amountCents: charged.amountCents,
      error: null,
    });

    const warehouseId = await lockFirstAvailableWarehouse(tx, order.items, order.shippingLocation);
    if (!warehouseId) {
      await updateOrderStatus(tx, order.id, RE_RESERVABLE_STATUSES, 'REFUND_PENDING');
      return { kind: 'REFUND_REQUIRED' };
    }

    await insertReservations(tx, order.id, warehouseId, order.items, deps.config.RESERVATION_TTL_SECONDS, 'CONFIRMED');
    await decrementOnHandForOrder(tx, order.id);
    await updateOrderWarehouse(tx, order.id, warehouseId);
    await updateOrderStatus(tx, order.id, RE_RESERVABLE_STATUSES, 'PAID');

    const paid = (await findOrder(tx, order.id))!;
    await recordOrderPaid(tx, paid);
    const response = paidResponse(paid);
    await completeIdempotencyKeyForOrder(tx, order.id, response.statusCode, response.body);
    return { kind: 'SETTLED', response };
  });

  if (outcome.kind === 'SETTLED') {
    log.info({ orderId: charged.orderId }, 'order settled after reservation expired');
    return outcome.response;
  }
  log.warn({ orderId: charged.orderId }, 'stock gone after payment; refunding');
  return refundOrder(deps, charged, log);
}
