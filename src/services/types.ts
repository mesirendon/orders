import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { Geocoder } from '../geocoder/geocoder.js';
import type { PaymentGateway } from '../payments/gateway.js';

export interface Deps {
  pool: pg.Pool;
  config: Config;
  geocoder: Geocoder;
  payments: PaymentGateway;
}

export type Logger = FastifyBaseLogger;

export interface HttpResult {
  statusCode: number;
  body: unknown;
}

export interface PaymentContext {
  orderId: string;
  cardLast4: string;
  amountCents: number;
}

export interface ChargedOrder extends PaymentContext {
  paymentId: string;
}
