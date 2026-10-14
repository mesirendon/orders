import type { Db } from '../db/pool.js';
import type { OrderRecord } from '../repositories/orders.js';
import { insertOutboxEvent } from '../repositories/outbox.js';

export const ORDER_PAID = 'OrderPaid';

export async function recordOrderPaid(db: Db, order: OrderRecord): Promise<void> {
  await insertOutboxEvent(db, {
    aggregateId: order.id,
    type: ORDER_PAID,
    payload: {
      orderId: order.id,
      customerId: order.customerId,
      warehouseId: order.warehouseId,
      totalCents: order.totalCents,
      currency: 'USD',
      items: order.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      shippingAddress: order.shippingAddress,
      paidAt: order.updatedAt.toISOString(),
    },
  });
}
