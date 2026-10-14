import type pg from 'pg';
import { withTransaction } from '../db/transaction.js';
import { completeIdempotencyKeyForOrder } from '../repositories/idempotencyKeys.js';
import { findOrder, lockOrder, updateOrderStatus, type OrderStatus } from '../repositories/orders.js';
import { insertPaymentAttempt } from '../repositories/paymentAttempts.js';
import { confirmActiveReservations } from '../repositories/reservations.js';
import { decrementOnHandForOrder, lockStockRows } from '../repositories/stock.js';
import { recordOrderPaid } from './orderEvents.js';
import { paidResponse } from './orderResponses.js';
import type { ChargedOrder, HttpResult } from './types.js';

export type ConfirmOrderResult =
  | { confirmed: true; response: HttpResult }
  | { confirmed: false; reason: 'RESERVATION_EXPIRED' }
  | { confirmed: false; reason: 'ORDER_NOT_PAYABLE'; status: OrderStatus | undefined };

const PAYABLE_STATUSES: OrderStatus[] = ['PENDING', 'PAYMENT_UNKNOWN'];

class ReservationExpired extends Error {}

export async function confirmOrder(pool: pg.Pool, charged: ChargedOrder): Promise<ConfirmOrderResult> {
  try {
    return await withTransaction(pool, async (tx): Promise<ConfirmOrderResult> => {
      const order = await lockOrder(tx, charged.orderId);
      if (!order || !PAYABLE_STATUSES.includes(order.status)) {
        return { confirmed: false, reason: 'ORDER_NOT_PAYABLE', status: order?.status };
      }

      await lockStockRows(tx, order.warehouseId, order.productIds);
      const confirmedCount = await confirmActiveReservations(tx, charged.orderId);
      if (confirmedCount !== order.productIds.length) {
        throw new ReservationExpired();
      }

      await decrementOnHandForOrder(tx, charged.orderId);
      await updateOrderStatus(tx, charged.orderId, PAYABLE_STATUSES, 'PAID');
      await insertPaymentAttempt(tx, {
        orderId: charged.orderId,
        idempotencyKey: charged.orderId,
        status: 'SUCCEEDED',
        cardLast4: charged.cardLast4,
        processorPaymentId: charged.paymentId,
        amountCents: charged.amountCents,
        error: null,
      });

      const paid = (await findOrder(tx, charged.orderId))!;
      await recordOrderPaid(tx, paid);
      const response = paidResponse(paid);
      await completeIdempotencyKeyForOrder(tx, charged.orderId, response.statusCode, response.body);
      return { confirmed: true, response };
    });
  } catch (err) {
    if (err instanceof ReservationExpired) {
      return { confirmed: false, reason: 'RESERVATION_EXPIRED' };
    }
    throw err;
  }
}
