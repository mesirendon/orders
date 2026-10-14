import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { behaviorFor } from './behavior.js';
import type { Config } from './config.js';
import { findPayment, markRefunded, recordPayment, type PaymentRow } from './payments.js';

const idempotencyKeySchema = z.string().trim().min(1).max(255);

const createPaymentSchema = z.object({
  cardNumber: z.string().regex(/^\d{16}$/),
  amountCents: z.number().int().positive(),
  description: z.string().min(1).max(500),
});

function toResponse(row: PaymentRow) {
  return {
    paymentId: row.payment_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    amountCents: row.amount_cents,
    cardLast4: row.card_last4,
    refunded: row.refunded_at !== null,
    refundedAt: row.refunded_at,
    createdAt: row.created_at,
  };
}

export function registerRoutes(app: FastifyInstance, pool: pg.Pool, config: Config): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/payments', async (request, reply) => {
    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!key.success) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const body = createPaymentSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', details: z.flattenError(body.error).fieldErrors });
    }

    const cardLast4 = body.data.cardNumber.slice(-4);
    const behavior = behaviorFor(body.data.cardNumber);
    request.log.info({ idempotencyKey: key.data, cardLast4, behavior }, 'payment requested');

    if (behavior === 'HANG_WITHOUT_RECORDING') {
      await sleep(config.SLOW_RESPONSE_MS);
      return reply.code(504).send({ error: 'PROCESSOR_TIMEOUT' });
    }

    const { row, created } = await recordPayment(pool, {
      idempotencyKey: key.data,
      status: behavior === 'DECLINE' ? 'DECLINED' : 'SUCCEEDED',
      amountCents: body.data.amountCents,
      cardLast4,
      description: body.data.description,
    });

    if (row.amount_cents !== body.data.amountCents) {
      return reply.code(422).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
    }

    if (behavior === 'RECORD_THEN_HANG') {
      await sleep(config.SLOW_RESPONSE_MS);
    }

    reply.header('Idempotent-Replayed', String(!created));
    return reply.code(row.status === 'DECLINED' ? 402 : 201).send(toResponse(row));
  });

  app.get<{ Params: { key: string } }>('/payments/:key', async (request) => {
    const row = await findPayment(pool, request.params.key);
    if (!row) {
      return { idempotencyKey: request.params.key, status: 'NOT_FOUND' };
    }
    return toResponse(row);
  });

  app.post<{ Params: { key: string } }>('/payments/:key/refund', async (request, reply) => {
    const refundKey = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!refundKey.success) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    }

    const refunded = await markRefunded(pool, request.params.key, refundKey.data);
    if (refunded) {
      request.log.info({ idempotencyKey: request.params.key }, 'payment refunded');
      return toResponse(refunded);
    }

    const row = await findPayment(pool, request.params.key);
    if (!row) {
      return reply.code(404).send({ error: 'PAYMENT_NOT_FOUND' });
    }
    if (row.status !== 'SUCCEEDED') {
      return reply.code(409).send({ error: 'PAYMENT_NOT_REFUNDABLE', status: row.status });
    }
    reply.header('Idempotent-Replayed', 'true');
    return toResponse(row);
  });
}
