import type { OrderRecord } from '../repositories/orders.js';

export function toOrderResponse(order: OrderRecord) {
  return {
    id: order.id,
    status: order.status,
    customerId: order.customerId,
    warehouseId: order.warehouseId,
    totalCents: order.totalCents,
    currency: 'USD',
    items: order.items,
    shippingAddress: { ...order.shippingAddress, location: order.shippingLocation },
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
