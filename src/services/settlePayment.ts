import { withTransaction } from '../db/transaction.js';
import { completeIdempotencyKeyForOrder } from '../repositories/idempotencyKeys.js';
import { findOrder, updateOrderStatus } from '../repositories/orders.js';
import { insertPaymentAttempt } from '../repositories/paymentAttempts.js';
import type { PaymentLookup } from '../payments/gateway.js';
import { chargeWithRetry } from './chargePayment.js';
import { confirmOrder } from './confirmOrder.js';
import { failOrder } from './failOrder.js';
import {
  declinedResponse,
  notChargedResponse,
  rejectedResponse,
  responseForOrder,
  unknownResponse,
} from './orderResponses.js';
import { reReserveOrRefund } from './reReserveOrder.js';
import type { ChargedOrder, Deps, HttpResult, Logger, PaymentContext } from './types.js';

export async function chargeAndSettle(
  deps: Deps,
  order: PaymentContext,
  cardNumber: string,
  log: Logger,
): Promise<HttpResult> {
  const charge = await chargeWithRetry(
    deps.payments,
    {
      idempotencyKey: order.orderId,
      cardNumber,
      amountCents: order.amountCents,
      description: `Order ${order.orderId}`,
    },
    { maxAttempts: deps.config.PAYMENT_MAX_ATTEMPTS, backoffMs: deps.config.PAYMENT_BACKOFF_MS },
    log,
  );

  switch (charge.kind) {
    case 'APPROVED':
      return settleCharged(deps, { ...order, paymentId: charge.paymentId }, log);
    case 'DECLINED':
      log.info({ orderId: order.orderId }, 'payment declined');
      return failOrder(deps.pool, {
        ...order,
        attemptStatus: 'DECLINED',
        processorPaymentId: charge.paymentId,
        error: 'card declined',
        response: declinedResponse(order.orderId),
      });
    case 'REJECTED':
      return failOrder(deps.pool, {
        ...order,
        attemptStatus: 'FAILED',
        processorPaymentId: null,
        error: charge.error,
        response: rejectedResponse(order.orderId),
      });
    case 'UNREACHABLE': {
      log.warn({ orderId: order.orderId, error: charge.error }, 'payment unreachable; checking status');
      const lookup = await lookupPayment(deps, order.orderId, log);
      if (lookup === 'UNAVAILABLE') {
        return markPaymentUnknown(deps, order, charge.error);
      }
      if (lookup.status === 'SUCCEEDED') {
        return settleCharged(deps, { ...order, paymentId: lookup.paymentId }, log);
      }
      if (lookup.status === 'DECLINED') {
        return failOrder(deps.pool, {
          ...order,
          attemptStatus: 'DECLINED',
          processorPaymentId: lookup.paymentId,
          error: 'card declined',
          response: declinedResponse(order.orderId),
        });
      }
      return failOrder(deps.pool, {
        ...order,
        attemptStatus: 'FAILED',
        processorPaymentId: null,
        error: charge.error,
        response: notChargedResponse(order.orderId, charge.timedOut),
      });
    }
  }
}

export async function lookupPayment(
  deps: Deps,
  orderId: string,
  log: Logger,
): Promise<PaymentLookup | 'UNAVAILABLE'> {
  try {
    return await deps.payments.lookup(orderId);
  } catch (err) {
    log.warn({ err, orderId }, 'payment status lookup failed');
    return 'UNAVAILABLE';
  }
}

export async function settleCharged(deps: Deps, charged: ChargedOrder, log: Logger): Promise<HttpResult> {
  const result = await confirmOrder(deps.pool, charged);
  if (result.confirmed) {
    log.info({ orderId: charged.orderId }, 'order paid');
    return result.response;
  }
  if (result.reason === 'ORDER_NOT_PAYABLE' && result.status !== 'EXPIRED') {
    return completeFromOrderState(deps, charged.orderId);
  }
  log.warn({ orderId: charged.orderId, reason: result.reason }, 'reservation lapsed during payment');
  return reReserveOrRefund(deps, charged, log);
}

export async function completeFromOrderState(deps: Deps, orderId: string): Promise<HttpResult> {
  return withTransaction(deps.pool, async (tx) => {
    const response = responseForOrder((await findOrder(tx, orderId))!);
    await completeIdempotencyKeyForOrder(tx, orderId, response.statusCode, response.body);
    return response;
  });
}

export async function markPaymentUnknown(deps: Deps, order: PaymentContext, error: string): Promise<HttpResult> {
  return withTransaction(deps.pool, async (tx) => {
    await updateOrderStatus(tx, order.orderId, ['PENDING', 'EXPIRED'], 'PAYMENT_UNKNOWN');
    await insertPaymentAttempt(tx, {
      orderId: order.orderId,
      idempotencyKey: order.orderId,
      status: 'UNKNOWN',
      cardLast4: order.cardLast4,
      processorPaymentId: null,
      amountCents: order.amountCents,
      error,
    });
    const response = unknownResponse(order.orderId);
    await completeIdempotencyKeyForOrder(tx, order.orderId, response.statusCode, response.body);
    return response;
  });
}
