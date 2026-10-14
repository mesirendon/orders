import { createHash } from 'node:crypto';
import type { CreateOrderInput } from './createOrder.js';

export function hashRequest(input: CreateOrderInput): string {
  const canonical = {
    customerId: input.customerId,
    shippingAddress: {
      line1: input.shippingAddress.line1,
      city: input.shippingAddress.city,
      postalCode: input.shippingAddress.postalCode,
      country: input.shippingAddress.country,
    },
    items: [...input.items]
      .sort((a, b) => a.productId.localeCompare(b.productId))
      .map((item) => ({ productId: item.productId, quantity: item.quantity })),
    cardLast4: input.payment.cardNumber.slice(-4),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
