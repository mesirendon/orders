export interface ChargeRequest {
  idempotencyKey: string;
  cardNumber: string;
  amountCents: number;
  description: string;
}

export type ChargeResult =
  | { outcome: 'APPROVED'; paymentId: string }
  | { outcome: 'DECLINED'; paymentId: string };

export type PaymentLookup =
  | { status: 'SUCCEEDED'; paymentId: string; refunded: boolean }
  | { status: 'DECLINED'; paymentId: string }
  | { status: 'NOT_FOUND' };

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  lookup(idempotencyKey: string): Promise<PaymentLookup>;
  refund(idempotencyKey: string, refundIdempotencyKey: string): Promise<void>;
}

export class PaymentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentUnavailableError';
  }
}

export class PaymentRejectedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PaymentRejectedError';
    this.status = status;
  }
}
