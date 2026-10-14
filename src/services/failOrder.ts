import type pg from 'pg';
import { withTransaction } from '../db/transaction.js';
import { completeIdempotencyKeyForOrder } from '../repositories/idempotencyKeys.js';
import { updateOrderStatus, type OrderStatus } from '../repositories/orders.js';
import { insertPaymentAttempt, type PaymentAttemptStatus } from '../repositories/paymentAttempts.js';
import { releaseActiveReservations } from '../repositories/reservations.js';
import type { HttpResult, PaymentContext } from './types.js';

export interface FailOrderInput extends PaymentContext {
  attemptStatus: PaymentAttemptStatus;
  processorPaymentId: string | null;
  error: string;
  response: HttpResult;
}

const FAILABLE_STATUSES: OrderStatus[] = ['PENDING', 'PAYMENT_UNKNOWN', 'EXPIRED'];

export async function failOrder(pool: pg.Pool, input: FailOrderInput): Promise<HttpResult> {
  return withTransaction(pool, async (tx) => {
    await updateOrderStatus(tx, input.orderId, FAILABLE_STATUSES, 'PAYMENT_FAILED');
    await releaseActiveReservations(tx, input.orderId);
    await insertPaymentAttempt(tx, {
      orderId: input.orderId,
      idempotencyKey: input.orderId,
      status: input.attemptStatus,
      cardLast4: input.cardLast4,
      processorPaymentId: input.processorPaymentId,
      amountCents: input.amountCents,
      error: input.error,
    });
    await completeIdempotencyKeyForOrder(tx, input.orderId, input.response.statusCode, input.response.body);
    return input.response;
  });
}
