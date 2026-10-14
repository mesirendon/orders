import { setTimeout as sleep } from 'node:timers/promises';
import { PaymentUnavailableError, type ChargeRequest, type PaymentGateway } from '../payments/gateway.js';
import type { Logger } from './types.js';

export type ChargeOutcome =
  | { kind: 'APPROVED'; paymentId: string }
  | { kind: 'DECLINED'; paymentId: string }
  | { kind: 'UNREACHABLE'; error: string };

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export async function chargeWithRetry(
  gateway: PaymentGateway,
  request: ChargeRequest,
  policy: RetryPolicy,
  log: Logger,
): Promise<ChargeOutcome> {
  let lastError = 'no attempts made';
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const result = await gateway.charge(request);
      return result.outcome === 'APPROVED'
        ? { kind: 'APPROVED', paymentId: result.paymentId }
        : { kind: 'DECLINED', paymentId: result.paymentId };
    } catch (err) {
      if (!(err instanceof PaymentUnavailableError)) throw err;
      lastError = err.message;
      log.warn({ orderId: request.idempotencyKey, attempt, reason: err.message }, 'payment attempt failed');
      if (attempt < policy.maxAttempts) {
        await sleep(policy.backoffMs * 2 ** (attempt - 1));
      }
    }
  }
  return { kind: 'UNREACHABLE', error: lastError };
}
