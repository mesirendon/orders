import { errorBody } from '../errors.js';
import type { OrderRecord } from '../repositories/orders.js';
import { toOrderResponse } from './orderView.js';
import type { HttpResult } from './types.js';

export function paidResponse(order: OrderRecord): HttpResult {
  return { statusCode: 201, body: toOrderResponse(order) };
}

export function declinedResponse(orderId: string): HttpResult {
  return { statusCode: 402, body: errorBody('PAYMENT_DECLINED', 'The card was declined', { orderId }) };
}

export function paymentFailedResponse(orderId: string): HttpResult {
  return { statusCode: 402, body: errorBody('PAYMENT_FAILED', 'Payment failed', { orderId }) };
}

export function notChargedResponse(orderId: string, timedOut: boolean): HttpResult {
  return {
    statusCode: timedOut ? 504 : 502,
    body: errorBody('PAYMENT_UNAVAILABLE', 'Payment provider did not respond; the card was not charged', { orderId }),
  };
}

export function rejectedResponse(orderId: string): HttpResult {
  return {
    statusCode: 502,
    body: errorBody('PAYMENT_REJECTED', 'Payment provider rejected the request', { orderId }),
  };
}

export function unknownResponse(orderId: string): HttpResult {
  return {
    statusCode: 202,
    body: {
      orderId,
      status: 'PAYMENT_UNKNOWN',
      message: `Payment outcome is being confirmed; check GET /orders/${orderId}`,
    },
  };
}

export function cancelledResponse(orderId: string, refund: 'COMPLETED' | 'PENDING'): HttpResult {
  const message =
    refund === 'COMPLETED'
      ? 'Stock was no longer available after payment; the payment was refunded'
      : 'Stock was no longer available after payment; the refund is being processed';
  return { statusCode: 409, body: errorBody('ORDER_CANCELLED', message, { orderId, refund }) };
}

export function expiredResponse(orderId: string): HttpResult {
  return {
    statusCode: 409,
    body: errorBody('ORDER_EXPIRED', 'The reservation expired before payment completed', { orderId }),
  };
}

export function responseForOrder(order: OrderRecord): HttpResult {
  switch (order.status) {
    case 'PAID':
      return paidResponse(order);
    case 'PAYMENT_FAILED':
      return paymentFailedResponse(order.id);
    case 'CANCELLED':
      return cancelledResponse(order.id, 'COMPLETED');
    case 'REFUND_PENDING':
      return cancelledResponse(order.id, 'PENDING');
    case 'EXPIRED':
      return expiredResponse(order.id);
    case 'PENDING':
    case 'PAYMENT_UNKNOWN':
      return unknownResponse(order.id);
  }
}
