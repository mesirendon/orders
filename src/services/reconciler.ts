import { claimAbandonedKeysForExpiredOrders } from '../repositories/idempotencyKeys.js';
import { claimOrdersForReconciliation } from '../repositories/orders.js';
import { findLatestCardLast4 } from '../repositories/paymentAttempts.js';
import { failOrder } from './failOrder.js';
import { declinedResponse, notChargedResponse } from './orderResponses.js';
import { refundOrder } from './refundOrder.js';
import { completeFromOrderState, lookupPayment, settleCharged } from './settlePayment.js';
import type { Deps, Logger } from './types.js';

const BATCH_SIZE = 20;
const LEASE_SECONDS = 30;

interface ClaimedOrder {
  orderId: string;
  totalCents: number;
}

export async function reconcile(deps: Deps, log: Logger): Promise<void> {
  const unknown = await claimOrdersForReconciliation(deps.pool, 'PAYMENT_UNKNOWN', LEASE_SECONDS, BATCH_SIZE);
  await forEachOrder(unknown, log, (order) => resolveUnknownPayment(deps, order, log));

  const refunds = await claimOrdersForReconciliation(deps.pool, 'REFUND_PENDING', LEASE_SECONDS, BATCH_SIZE);
  await forEachOrder(refunds, log, (order) => retryRefund(deps, order, log));

  const abandoned = await claimAbandonedKeysForExpiredOrders(deps.pool, deps.config.idempotencyLockMs, BATCH_SIZE);
  await forEachOrder(abandoned, log, (order) => recoverAbandonedRequest(deps, order, log));
}

async function resolveUnknownPayment(deps: Deps, order: ClaimedOrder, log: Logger): Promise<void> {
  const lookup = await lookupPayment(deps, order.orderId, log);
  if (lookup === 'UNAVAILABLE') return;
  log.info({ orderId: order.orderId, status: lookup.status }, 'resolving PAYMENT_UNKNOWN');

  if (lookup.status === 'SUCCEEDED') {
    await settleCharged(
      deps,
      { orderId: order.orderId, cardLast4: lookup.cardLast4, amountCents: order.totalCents, paymentId: lookup.paymentId },
      log,
    );
    return;
  }

  const payment = {
    orderId: order.orderId,
    cardLast4: await requireCardLast4(deps, order.orderId),
    amountCents: order.totalCents,
  };
  if (lookup.status === 'DECLINED') {
    await failOrder(deps.pool, {
      ...payment,
      attemptStatus: 'DECLINED',
      processorPaymentId: lookup.paymentId,
      error: 'card declined (reconciled)',
      response: declinedResponse(order.orderId),
    });
    return;
  }
  await failOrder(deps.pool, {
    ...payment,
    attemptStatus: 'FAILED',
    processorPaymentId: null,
    error: 'payment not found at provider (reconciled)',
    response: notChargedResponse(order.orderId, false),
  });
}

async function retryRefund(deps: Deps, order: ClaimedOrder, log: Logger): Promise<void> {
  log.info({ orderId: order.orderId }, 'retrying refund');
  await refundOrder(
    deps,
    { orderId: order.orderId, cardLast4: await requireCardLast4(deps, order.orderId), amountCents: order.totalCents },
    log,
  );
}

async function recoverAbandonedRequest(deps: Deps, order: ClaimedOrder, log: Logger): Promise<void> {
  const lookup = await lookupPayment(deps, order.orderId, log);
  if (lookup === 'UNAVAILABLE') return;
  log.info({ orderId: order.orderId, status: lookup.status }, 'recovering abandoned request');

  if (lookup.status === 'SUCCEEDED') {
    await settleCharged(
      deps,
      { orderId: order.orderId, cardLast4: lookup.cardLast4, amountCents: order.totalCents, paymentId: lookup.paymentId },
      log,
    );
    return;
  }
  await completeFromOrderState(deps, order.orderId);
}

async function requireCardLast4(deps: Deps, orderId: string): Promise<string> {
  const cardLast4 = await findLatestCardLast4(deps.pool, orderId);
  if (!cardLast4) {
    throw new Error(`no payment attempt recorded for order ${orderId}`);
  }
  return cardLast4;
}

async function forEachOrder(
  orders: ClaimedOrder[],
  log: Logger,
  handle: (order: ClaimedOrder) => Promise<void>,
): Promise<void> {
  for (const order of orders) {
    try {
      await handle(order);
    } catch (err) {
      log.error({ err, orderId: order.orderId }, 'reconciliation failed for order');
    }
  }
}
