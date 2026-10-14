import { randomUUID } from 'node:crypto';
import { AppError, appErrorBody } from '../errors.js';
import { GeocodingError, type Address, type Coordinates } from '../geocoder/geocoder.js';
import {
  completeIdempotencyKey,
  findIdempotencyKey,
  insertIdempotencyKey,
  releaseIdempotencyKey,
} from '../repositories/idempotencyKeys.js';
import { TimeoutError, withTimeout } from '../timeout.js';
import { chargeWithRetry } from './chargePayment.js';
import { confirmOrder } from './confirmOrder.js';
import { hashRequest } from './requestHash.js';
import { reserveStock } from './reserveStock.js';
import type { Deps, HttpResult, Logger } from './types.js';

export interface CreateOrderInput {
  idempotencyKey: string;
  customerId: string;
  shippingAddress: Address;
  items: { productId: string; quantity: number }[];
  payment: { cardNumber: string };
}

export async function createOrder(deps: Deps, input: CreateOrderInput, log: Logger): Promise<HttpResult> {
  const requestHash = hashRequest(input);
  const replay = await claimIdempotencyKey(deps, input, requestHash);
  if (replay) {
    log.info({ idempotencyKey: input.idempotencyKey }, 'replaying stored response');
    return replay;
  }

  try {
    return await processNewOrder(deps, input, log);
  } catch (err) {
    await settleKeyAfterFailure(deps, input, err, log);
    throw err;
  }
}

async function claimIdempotencyKey(
  deps: Deps,
  input: CreateOrderInput,
  requestHash: string,
): Promise<HttpResult | undefined> {
  let inserted;
  try {
    inserted = await insertIdempotencyKey(
      deps.pool,
      input.customerId,
      input.idempotencyKey,
      requestHash,
      deps.config.idempotencyLockMs,
    );
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(422, 'UNKNOWN_CUSTOMER', 'Customer does not exist');
    }
    throw err;
  }
  if (inserted) return undefined;

  const existing = await findIdempotencyKey(deps.pool, input.customerId, input.idempotencyKey);
  if (!existing) {
    throw new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is being processed');
  }
  if (existing.request_hash !== requestHash) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
  }
  if (existing.status === 'COMPLETED') {
    return { statusCode: existing.response_status!, body: existing.response_body };
  }
  throw new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is being processed');
}

async function processNewOrder(deps: Deps, input: CreateOrderInput, log: Logger): Promise<HttpResult> {
  const shippingLocation = await geocode(deps, input.shippingAddress);

  const reservation = await reserveStock(deps.pool, {
    orderId: randomUUID(),
    customerId: input.customerId,
    idempotencyKey: input.idempotencyKey,
    shippingAddress: input.shippingAddress,
    shippingLocation,
    items: input.items,
    ttlSeconds: deps.config.RESERVATION_TTL_SECONDS,
  });
  log.info(reservation, 'stock reserved');

  const charge = await chargeWithRetry(
    deps.payments,
    {
      idempotencyKey: reservation.orderId,
      cardNumber: input.payment.cardNumber,
      amountCents: reservation.totalCents,
      description: `Order ${reservation.orderId}`,
    },
    { maxAttempts: deps.config.PAYMENT_MAX_ATTEMPTS, backoffMs: deps.config.PAYMENT_BACKOFF_MS },
    log,
  );
  if (charge.kind !== 'APPROVED') {
    throw new AppError(502, 'PAYMENT_FAILED', 'Payment could not be completed');
  }

  const confirmation = await confirmOrder(deps.pool, {
    orderId: reservation.orderId,
    customerId: input.customerId,
    idempotencyKey: input.idempotencyKey,
    paymentId: charge.paymentId,
    cardLast4: input.payment.cardNumber.slice(-4),
    amountCents: reservation.totalCents,
  });
  if (!confirmation.confirmed) {
    throw new AppError(409, confirmation.reason, 'Order could not be confirmed');
  }
  log.info({ orderId: reservation.orderId }, 'order paid');
  return confirmation.response;
}

async function geocode(deps: Deps, address: Address): Promise<Coordinates> {
  try {
    return await withTimeout(deps.geocoder.geocode(address), deps.config.GEOCODER_TIMEOUT_MS, 'geocoding');
  } catch (err) {
    if (err instanceof GeocodingError) {
      throw new AppError(422, 'GEOCODING_FAILED', err.message);
    }
    if (err instanceof TimeoutError) {
      throw new AppError(504, 'GEOCODER_TIMEOUT', err.message);
    }
    throw err;
  }
}

async function settleKeyAfterFailure(deps: Deps, input: CreateOrderInput, err: unknown, log: Logger): Promise<void> {
  try {
    if (err instanceof AppError && err.statusCode < 500) {
      await completeIdempotencyKey(deps.pool, input.customerId, input.idempotencyKey, err.statusCode, appErrorBody(err));
    } else {
      await releaseIdempotencyKey(deps.pool, input.customerId, input.idempotencyKey);
    }
  } catch (settleErr) {
    log.error({ err: settleErr, idempotencyKey: input.idempotencyKey }, 'failed to settle idempotency key');
  }
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23503';
}
