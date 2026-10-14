import { randomUUID } from 'node:crypto';
import { AppError, appErrorBody } from '../errors.js';
import { GeocodingError, type Address, type Coordinates } from '../geocoder/geocoder.js';
import {
  completeIdempotencyKey,
  findIdempotencyKey,
  insertIdempotencyKey,
  releaseIdempotencyKey,
  takeOverIdempotencyKey,
} from '../repositories/idempotencyKeys.js';
import { findOrder } from '../repositories/orders.js';
import { TimeoutError, withTimeout } from '../timeout.js';
import { hashRequest } from './requestHash.js';
import { reserveStock } from './reserveStock.js';
import {
  chargeAndSettle,
  completeFromOrderState,
  lookupPayment,
  markPaymentUnknown,
  settleCharged,
} from './settlePayment.js';
import type { Deps, HttpResult, Logger } from './types.js';

export interface CreateOrderInput {
  idempotencyKey: string;
  customerId: string;
  shippingAddress: Address;
  items: { productId: string; quantity: number }[];
  payment: { cardNumber: string };
}

type Claim = { kind: 'REPLAY'; result: HttpResult } | { kind: 'OWNED'; existingOrderId: string | null };

export async function createOrder(deps: Deps, input: CreateOrderInput, log: Logger): Promise<HttpResult> {
  const claim = await claimIdempotencyKey(deps, input, hashRequest(input));
  if (claim.kind === 'REPLAY') {
    log.info({ idempotencyKey: input.idempotencyKey }, 'replaying stored response');
    return claim.result;
  }

  try {
    if (claim.existingOrderId) {
      log.warn({ orderId: claim.existingOrderId }, 'took over stale request; resuming order');
      return await resumeOrder(deps, claim.existingOrderId, input, log);
    }
    return await processNewOrder(deps, input, log);
  } catch (err) {
    await settleKeyAfterFailure(deps, input, err, log);
    throw err;
  }
}

async function claimIdempotencyKey(deps: Deps, input: CreateOrderInput, requestHash: string): Promise<Claim> {
  const { pool, config } = deps;
  let inserted;
  try {
    inserted = await insertIdempotencyKey(
      pool,
      input.customerId,
      input.idempotencyKey,
      requestHash,
      config.idempotencyLockMs,
    );
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(422, 'UNKNOWN_CUSTOMER', 'Customer does not exist');
    }
    throw err;
  }
  if (inserted) {
    return { kind: 'OWNED', existingOrderId: null };
  }

  const existing = await findIdempotencyKey(pool, input.customerId, input.idempotencyKey);
  if (!existing) {
    throw requestInProgress();
  }
  if (existing.request_hash !== requestHash) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
  }
  if (existing.status === 'COMPLETED') {
    return { kind: 'REPLAY', result: { statusCode: existing.response_status!, body: existing.response_body } };
  }
  if (!existing.lock_expired) {
    throw requestInProgress();
  }

  const taken = await takeOverIdempotencyKey(pool, input.customerId, input.idempotencyKey, config.idempotencyLockMs);
  if (!taken) {
    throw requestInProgress();
  }
  return { kind: 'OWNED', existingOrderId: taken.order_id };
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

  return chargeAndSettle(
    deps,
    {
      orderId: reservation.orderId,
      cardLast4: input.payment.cardNumber.slice(-4),
      amountCents: reservation.totalCents,
    },
    input.payment.cardNumber,
    log,
  );
}

async function resumeOrder(deps: Deps, orderId: string, input: CreateOrderInput, log: Logger): Promise<HttpResult> {
  const order = await findOrder(deps.pool, orderId);
  if (!order) {
    throw new Error(`idempotency key references missing order ${orderId}`);
  }
  const payment = { orderId, cardLast4: input.payment.cardNumber.slice(-4), amountCents: order.totalCents };

  if (order.status === 'PENDING') {
    return chargeAndSettle(deps, payment, input.payment.cardNumber, log);
  }

  if (order.status === 'EXPIRED') {
    const lookup = await lookupPayment(deps, orderId, log);
    if (lookup === 'UNAVAILABLE') {
      return markPaymentUnknown(deps, payment, 'payment status unavailable while resuming');
    }
    if (lookup.status === 'SUCCEEDED') {
      return settleCharged(deps, { ...payment, paymentId: lookup.paymentId }, log);
    }
  }

  return completeFromOrderState(deps, orderId);
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

function requestInProgress(): AppError {
  return new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is being processed');
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23503';
}
