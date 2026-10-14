import type pg from 'pg';
import { withTransaction } from '../db/transaction.js';
import { completeIdempotencyKey } from '../repositories/idempotencyKeys.js';
import { findOrder, lockOrder, updateOrderStatus, type OrderStatus } from '../repositories/orders.js';
import { insertPaymentAttempt } from '../repositories/paymentAttempts.js';
import { confirmActiveReservations } from '../repositories/reservations.js';
import { decrementOnHandForOrder, lockStockRows } from '../repositories/stock.js';
import { toOrderResponse } from './orderView.js';
import type { HttpResult } from './types.js';

export interface ConfirmOrderInput {
  orderId: string;
  customerId: string;
  idempotencyKey: string;
  paymentId: string;
  cardLast4: string;
  amountCents: number;
}

export type ConfirmOrderResult =
  | { confirmed: true; response: HttpResult }
  | { confirmed: false; reason: 'RESERVATION_EXPIRED' | 'ORDER_NOT_PAYABLE' };

const PAYABLE_STATUSES: OrderStatus[] = ['PENDING', 'PAYMENT_UNKNOWN'];

class ReservationExpired extends Error {}

export async function confirmOrder(pool: pg.Pool, input: ConfirmOrderInput): Promise<ConfirmOrderResult> {
  try {
    return await withTransaction(pool, async (tx) => {
      const order = await lockOrder(tx, input.orderId);
      if (!order || !PAYABLE_STATUSES.includes(order.status)) {
        return { confirmed: false, reason: 'ORDER_NOT_PAYABLE' };
      }

      await lockStockRows(tx, order.warehouseId, order.productIds);
      const confirmedCount = await confirmActiveReservations(tx, input.orderId);
      if (confirmedCount !== order.productIds.length) {
        throw new ReservationExpired();
      }

      await decrementOnHandForOrder(tx, input.orderId);
      await updateOrderStatus(tx, input.orderId, PAYABLE_STATUSES, 'PAID');
      await insertPaymentAttempt(tx, {
        orderId: input.orderId,
        idempotencyKey: input.orderId,
        status: 'SUCCEEDED',
        cardLast4: input.cardLast4,
        processorPaymentId: input.paymentId,
        amountCents: input.amountCents,
        error: null,
      });

      const paid = await findOrder(tx, input.orderId);
      const response = { statusCode: 201, body: toOrderResponse(paid!) };
      await completeIdempotencyKey(tx, input.customerId, input.idempotencyKey, response.statusCode, response.body);
      return { confirmed: true, response };
    });
  } catch (err) {
    if (err instanceof ReservationExpired) {
      return { confirmed: false, reason: 'RESERVATION_EXPIRED' };
    }
    throw err;
  }
}
