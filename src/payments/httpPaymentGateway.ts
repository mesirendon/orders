import {
  PaymentRejectedError,
  PaymentUnavailableError,
  type ChargeRequest,
  type ChargeResult,
  type PaymentGateway,
  type PaymentLookup,
} from './gateway.js';

interface PaymentBody {
  paymentId?: string;
  status?: string;
  refunded?: boolean;
}

export class HttpPaymentGateway implements PaymentGateway {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const { status, body } = await this.send('POST', '/payments', request.idempotencyKey, {
      cardNumber: request.cardNumber,
      amountCents: request.amountCents,
      description: request.description,
    });
    if (status === 200 || status === 201) {
      return { outcome: 'APPROVED', paymentId: String(body.paymentId) };
    }
    if (status === 402) {
      return { outcome: 'DECLINED', paymentId: String(body.paymentId) };
    }
    throw new PaymentRejectedError(status, `payment rejected with status ${status}`);
  }

  async lookup(idempotencyKey: string): Promise<PaymentLookup> {
    const { status, body } = await this.send('GET', `/payments/${encodeURIComponent(idempotencyKey)}`);
    if (status !== 200) {
      throw new PaymentRejectedError(status, `payment lookup failed with status ${status}`);
    }
    if (body.status === 'SUCCEEDED') {
      return { status: 'SUCCEEDED', paymentId: String(body.paymentId), refunded: body.refunded === true };
    }
    if (body.status === 'DECLINED') {
      return { status: 'DECLINED', paymentId: String(body.paymentId) };
    }
    return { status: 'NOT_FOUND' };
  }

  async refund(idempotencyKey: string, refundIdempotencyKey: string): Promise<void> {
    const { status } = await this.send(
      'POST',
      `/payments/${encodeURIComponent(idempotencyKey)}/refund`,
      refundIdempotencyKey,
    );
    if (status !== 200) {
      throw new PaymentRejectedError(status, `refund failed with status ${status}`);
    }
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    idempotencyKey?: string,
    payload?: unknown,
  ): Promise<{ status: number; body: PaymentBody }> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (payload !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    let body: PaymentBody;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = parseBody(await response.text());
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error';
      throw new PaymentUnavailableError(`${method} ${path}: ${reason}`);
    }

    if (response.status >= 500) {
      throw new PaymentUnavailableError(`${method} ${path}: upstream status ${response.status}`);
    }
    return { status: response.status, body };
  }
}

function parseBody(text: string): PaymentBody {
  try {
    return JSON.parse(text) as PaymentBody;
  } catch {
    return {};
  }
}
