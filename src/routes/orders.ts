import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errorBody } from '../errors.js';
import { findOrder } from '../repositories/orders.js';
import { createOrder } from '../services/createOrder.js';
import { toOrderResponse } from '../services/orderView.js';
import type { Deps } from '../services/types.js';

const idempotencyKeySchema = z.string().trim().min(1).max(255);

const createOrderSchema = z.object({
  customerId: z.uuid(),
  shippingAddress: z.object({
    line1: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().max(20),
    country: z.string().trim().min(2).max(100),
  }),
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int().positive().max(100),
      }),
    )
    .min(1)
    .max(20)
    .refine((items) => new Set(items.map((item) => item.productId)).size === items.length, {
      message: 'productId values must be unique',
    }),
  payment: z.object({
    cardNumber: z.string().regex(/^\d{16}$/, 'cardNumber must be 16 digits'),
  }),
});

export function registerOrderRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/orders', async (request, reply) => {
    const idempotencyKey = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!idempotencyKey.success) {
      return reply.code(400).send(errorBody('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required'));
    }

    const body = createOrderSchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(422)
        .send(errorBody('VALIDATION_FAILED', 'Request body is invalid', z.flattenError(body.error)));
    }

    const result = await createOrder(deps, { idempotencyKey: idempotencyKey.data, ...body.data }, request.log);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (request, reply) => {
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send(errorBody('INVALID_ORDER_ID', 'Order id must be a UUID'));
    }
    const order = await findOrder(deps.pool, id.data);
    if (!order) {
      return reply.code(404).send(errorBody('ORDER_NOT_FOUND', 'Order not found'));
    }
    return toOrderResponse(order);
  });
}
