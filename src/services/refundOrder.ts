import { withTransaction } from '../db/transaction.js';
import { completeIdempotencyKeyForOrder } from '../repositories/idempotencyKeys.js';
import { updateOrderStatus } from '../repositories/orders.js';
import { insertPaymentAttempt } from '../repositories/paymentAttempts.js';
import { cancelledResponse } from './orderResponses.js';
import type { Deps, HttpResult, Logger, PaymentContext } from './types.js';

export function refundKeyFor(orderId: string): string {
  return `refund:${orderId}`;
}

export async function refundOrder(deps: Deps, order: PaymentContext, log: Logger): Promise<HttpResult> {
  try {
    await deps.payments.refund(order.orderId, refundKeyFor(order.orderId));
  } catch (err) {
    log.error({ err, orderId: order.orderId }, 'refund failed; order stays REFUND_PENDING');
    const pending = cancelledResponse(order.orderId, 'PENDING');
    await completeIdempotencyKeyForOrder(deps.pool, order.orderId, pending.statusCode, pending.body);
    return pending;
  }

  return withTransaction(deps.pool, async (tx) => {
    const cancelled = await updateOrderStatus(tx, order.orderId, ['REFUND_PENDING'], 'CANCELLED');
    if (cancelled) {
      await insertPaymentAttempt(tx, {
        orderId: order.orderId,
        idempotencyKey: refundKeyFor(order.orderId),
        status: 'REFUNDED',
        cardLast4: order.cardLast4,
        processorPaymentId: null,
        amountCents: order.amountCents,
        error: null,
      });
      log.info({ orderId: order.orderId }, 'order cancelled and refunded');
    }
    const response = cancelledResponse(order.orderId, 'COMPLETED');
    await completeIdempotencyKeyForOrder(tx, order.orderId, response.statusCode, response.body);
    return response;
  });
}
