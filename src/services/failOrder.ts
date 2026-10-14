import type pg from 'pg';
import { withTransaction } from '../db/transaction.js';
import { completeIdempotencyKey } from '../repositories/idempotencyKeys.js';
import { updateOrderStatus, type OrderStatus } from '../repositories/orders.js';
import { insertPaymentAttempt, type PaymentAttemptStatus } from '../repositories/paymentAttempts.js';
import { releaseActiveReservations } from '../repositories/reservations.js';
import type { HttpResult } from './types.js';

export interface FailOrderInput {
  orderId: string;
  customerId: string;
  idempotencyKey: string;
  attemptStatus: PaymentAttemptStatus;
  processorPaymentId: string | null;
  cardLast4: string;
  amountCents: number;
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
    await completeIdempotencyKey(
      tx,
      input.customerId,
      input.idempotencyKey,
      input.response.statusCode,
      input.response.body,
    );
    return input.response;
  });
}
