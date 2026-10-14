# Order Management API

Backend for placing e-commerce orders. `POST /orders` geocodes the shipping address, picks the **single nearest warehouse that can supply every item**, reserves the stock, charges the card through an external payment API, and confirms the order. It is built to behave correctly under concurrent requests, client retries, payment timeouts and process crashes.

- TypeScript (strict), Node 22, Fastify, zod, pino
- PostgreSQL + PostGIS, raw SQL with `node-postgres` (no ORM)
- A separate payment mock service with its own schema
- In-process background jobs: reservation sweeper, payment reconciler, outbox poller

The design (transaction boundaries, locking, idempotency and the failure matrix) is in [DESIGN.md](DESIGN.md). Diagrams are in [docs/](docs/).

---

## Running it

```bash
docker compose up --build            # or: docker compose up --build -d --wait (returns once api and payment-mock are healthy)
```

Startup order: `postgres` (healthcheck) → `migrate` → `seed` → `api`. The `payment-mock` service only depends on postgres. `api` and `payment-mock` each have a healthcheck on `GET /health`, so `docker compose up -d --wait` returns once both are ready.

| Service        | URL                      |
| -------------- | ------------------------ |
| API            | http://localhost:3000    |
| Payment mock   | http://localhost:4000    |
| PostgreSQL     | localhost:5432 (`canals` / `canals`) |

```bash
curl localhost:3000/health          # {"status":"ok"}
docker compose down -v              # wipe the database and start over
```

`postgis/postgis` only publishes amd64 images, so on Apple Silicon it runs under emulation (`platform: linux/amd64`). It is slower to start but works.

Migrations and seed can be re-run safely. Applied migrations are tracked in `schema_migrations`, and the seed uses `ON CONFLICT DO NOTHING`.

### Running the API outside Docker

```bash
npm install
docker compose up -d postgres payment-mock
cp .env.example .env && set -a && source .env && set +a
npm run migrate && npm run seed
npm run dev
```

---

## API

### `POST /orders`

Header `Idempotency-Key` is required, at most 255 characters, and scoped per customer.

```json
{
  "customerId": "11111111-0000-4000-8000-000000000001",
  "shippingAddress": { "line1": "233 S Wacker Dr", "city": "Chicago", "postalCode": "60601", "country": "US" },
  "items": [{ "productId": "22222222-0000-4000-8000-000000000001", "quantity": 2 }],
  "payment": { "cardNumber": "4242424242424242" }
}
```

Validation:
- `items`: 1–20 entries, each `productId` a UUID used once, `quantity` an integer from 1 to 100.
- `cardNumber`: exactly 16 digits.

The amount charged is always computed on the server from `products.price_cents`.

| Status | `error.code` | When |
| ------ | ------------ | ---- |
| 201 | – | Paid. Body is the order. |
| 202 | – | Payment outcome unknown (provider unreachable). Body has `orderId`; the reconciler resolves it in the background. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `BAD_REQUEST` | Missing key or malformed JSON. |
| 402 | `PAYMENT_DECLINED` | Card declined. Order is `PAYMENT_FAILED` and its stock is released. |
| 409 | `INSUFFICIENT_STOCK` | No single warehouse can fulfil the order. `details.products` lists the shortfall at the warehouse that covers the most items. |
| 409 | `REQUEST_IN_PROGRESS` | Another request with the same key is still running. |
| 409 | `ORDER_CANCELLED` | The reservation expired during payment and stock was gone; the payment was refunded (`details.refund` is `COMPLETED` or `PENDING`). |
| 422 | `VALIDATION_FAILED`, `UNKNOWN_CUSTOMER`, `UNKNOWN_PRODUCT` | Invalid input. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different request body. |
| 422 | `GEOCODING_FAILED` | Address could not be geocoded (for example a blank postal code). |
| 502 / 504 | `PAYMENT_UNAVAILABLE`, `PAYMENT_REJECTED` | The provider failed and confirmed it never charged the card (504 if the last error was a timeout). Order is `PAYMENT_FAILED`. |
| 503 | `DATABASE_BUSY` | A lock wait, statement or idle transaction exceeded its database timeout. Sent with `Retry-After: 1`. **Retry with the same key, never a new one:** before an order exists the retry starts over; after (for example a timeout in the confirm step, once the card is charged) it resumes the same order without charging again. A new key would create a second order and a second charge. |
| 504 | `GEOCODER_TIMEOUT` | Geocoder timed out. Nothing is stored, so a retry with the same key starts over. |

Errors share one shape: `{ "error": { "code", "message", "details"? } }`.

A request with the same key and same body replays the stored status and body. Every outcome once an order exists is stored, as are deterministic rejections (insufficient stock, geocoding failure, unknown product), so retrying returns the same answer instead of creating a second order. Validation errors and 5xx failures before an order exists are not stored, so a retry with the same key starts over.

### `GET /orders/:id`

Returns the order (200), `400 INVALID_ORDER_ID` or `404 ORDER_NOT_FOUND`.

### `GET /health`

`200 {"status":"ok"}` if the database answers, otherwise `503`.

---

## Seed data

| Customers | ID |
| --------- | -- |
| Ada Lovelace | `11111111-0000-4000-8000-000000000001` |
| Grace Hopper | `11111111-0000-4000-8000-000000000002` |
| Alan Turing | `11111111-0000-4000-8000-000000000003` |

Warehouses `33333333-…-0001` to `…-0005`: New York, Chicago, Dallas, Los Angeles, Seattle.

Products `22222222-0000-4000-8000-0000000000NN`:

| NN | Product | Price | Stocked in |
| -- | ------- | ----- | ---------- |
| 01–05, 07, 08 | Keyboard, Mouse, USB-C Hub, Monitor, Laptop Stand, Headphones, Desk Lamp | various | all five |
| 06 | 4K Webcam | $69.99 | New York, Los Angeles |
| 09 | **Limited Edition Print** | $199.99 | **Chicago only, stock 1** (race demo) |
| 10 | Standing Desk | $499.99 | Dallas, Seattle |

**Webcam (06) + Standing Desk (10)** are never stocked in the same warehouse, so ordering both returns 409.

The mock geocoder knows these postal codes: `10001` New York, `02108` Boston, `60601` Chicago, `75201` Dallas, `80202` Denver, `90012` Los Angeles, `94105` San Francisco, `98101` Seattle, `30303` Atlanta, `33131` Miami. Any other well-formed code is hashed to a fixed point inside the continental US.

---

## Payment mock card numbers

| Prefix | Behaviour | What the API returns |
| ------ | --------- | -------------------- |
| `4242` (and any other valid number) | Approved | 201 |
| `0000` | Declined (402, stored) | 402 |
| `1111` | Records SUCCEEDED, then sleeps 10s on every call | Each attempt times out after 3s. The status lookup finds SUCCEEDED and the order is paid: 201 after about 10s. |
| `2222` | Sleeps 10s without recording anything | Each attempt times out. The status lookup finds nothing, so the card was never charged: 504 after about 10s. |

To get a **202**, run `docker compose stop payment-mock`, place an order, then `docker compose start payment-mock`. Within about 40s the reconciler resolves the order to `PAID` or `PAYMENT_FAILED`.

---

## Trying it out

```bash
docker compose up --build -d --wait    # stack up and healthy
npm install                            # once, for the scripts
npm run demo                           # curl walkthrough of every card prefix and error case
npm run concurrency -- --reset         # 20 parallel orders for the stock-1 product; exactly one wins
PARALLEL=50 npm run concurrency -- --reset
```

`--reset` puts the Limited Edition Print's stock back to 1 directly in the database. It isn't needed on a fresh `docker compose down -v && up`. The script exits non-zero unless exactly one order succeeds.

A few curl examples:

```bash
curl -s -X POST localhost:3000/orders \
  -H 'content-type: application/json' -H 'Idempotency-Key: example-1' \
  -d '{"customerId":"11111111-0000-4000-8000-000000000001",
       "shippingAddress":{"line1":"1 Pike St","city":"Seattle","postalCode":"98101","country":"US"},
       "items":[{"productId":"22222222-0000-4000-8000-000000000010","quantity":1}],
       "payment":{"cardNumber":"4242424242424242"}}'
# 201, fulfilled from Seattle (the standing desk is only in Dallas and Seattle)

# same command again: same 201 body, no second charge

curl -s localhost:3000/orders/<order id>
curl -s localhost:4000/payments/<order id>      # what the payment provider recorded
```

Useful queries:

```bash
docker compose exec postgres psql -U canals -d canals -c \
  "SELECT id, status, total_cents, updated_at FROM orders ORDER BY created_at DESC LIMIT 10"
docker compose exec postgres psql -U canals -d canals -c \
  "SELECT order_id, status, expires_at FROM stock_reservations ORDER BY id DESC LIMIT 10"
```

---

## Order state machine

```
                  TX2 (confirmed)
            ┌───────────────────────────────► PAID ◄──────────────────┐
            │                                                          │
            │ decline / provider says not charged                      │ reconciler or re-reserve
 TX1 ──► PENDING ─────────────────────────► PAYMENT_FAILED ◄──────────┤ once the charge is known
            │                                                          │
            │ provider and lookup unreachable                          │
            ├───────────────────────────► PAYMENT_UNKNOWN ────────────┤
            │                                                          │
            │ sweeper: reservation lapsed                              │
            ├───────────────────────────► EXPIRED ────────────────────┤
            │                                                          │
            │ charged, but stock gone on re-reserve                    │
            └───────────────────────────► REFUND_PENDING ◄────────────┘
                                                │ refund succeeds (request or reconciler)
                                                ▼
                                            CANCELLED
```

| From | To | Who |
| ---- | -- | --- |
| – | PENDING | TX1 (stock reserved) |
| PENDING, PAYMENT_UNKNOWN | PAID | TX2 (reservations confirmed) |
| PENDING, PAYMENT_UNKNOWN, EXPIRED | PAID | Re-reserve after a confirmed charge whose reservation lapsed |
| PENDING, PAYMENT_UNKNOWN, EXPIRED | PAYMENT_FAILED | Decline, provider rejection, or lookup NOT_FOUND |
| PENDING, EXPIRED | PAYMENT_UNKNOWN | Payment and status lookup both unreachable |
| PENDING | EXPIRED | Sweeper (reservation lapsed, nothing confirmed) |
| PENDING, PAYMENT_UNKNOWN, EXPIRED | REFUND_PENDING | Charged, but no warehouse has the stock any more |
| REFUND_PENDING | CANCELLED | Refund succeeded (request path or reconciler) |

Final states: `PAID`, `PAYMENT_FAILED`, `CANCELLED`. `EXPIRED` is final unless a charge for it turns up, in which case the reconciler pays or refunds it.

---

## Project layout

```
src/
  routes/        HTTP only: validation, status codes
  services/      order flow, payment settlement, re-reserve/refund, sweeper, reconciler, outbox poller
  repositories/  all SQL
  geocoder/      Geocoder interface + MockGeocoder
  payments/      PaymentGateway interface + HttpPaymentGateway
  db/            pool (session timeouts), withTransaction, pg error codes, migration and seed runners
migrations/      numbered .sql files, applied once
seed/            idempotent seed data
payment-mock/    separate Fastify service (own package and Dockerfile)
scripts/         concurrency.ts, demo.sh
docs/            PlantUML diagrams
```

## Configuration

All configuration comes from environment variables, validated with zod at startup. The API refuses to start if they are invalid, if the database timeouts are not ordered `DB_LOCK_TIMEOUT_MS < DB_STATEMENT_TIMEOUT_MS < DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, or if `RESERVATION_TTL_SECONDS` is not longer than the payment budget (`attempts × timeout + backoff + one status lookup` = 12.6s with the defaults).

| Variable | Default | |
| -------- | ------- | - |
| `DATABASE_URL` | – (required) | |
| `PAYMENT_BASE_URL` | – (required) | |
| `PORT` | 3000 | |
| `LOG_LEVEL` | info | |
| `PAYMENT_TIMEOUT_MS` | 3000 | per HTTP call to the provider |
| `PAYMENT_MAX_ATTEMPTS` | 3 | retries only on timeout / network / 5xx |
| `PAYMENT_BACKOFF_MS` | 200 | exponential: 200, 400, … |
| `GEOCODER_TIMEOUT_MS` | 2000 | |
| `RESERVATION_TTL_SECONDS` | 120 | |
| `SWEEP_INTERVAL_MS` | 5000 | |
| `RECONCILE_INTERVAL_MS` | 10000 | |
| `OUTBOX_INTERVAL_MS` | 2000 | |
| `DB_LOCK_TIMEOUT_MS` | 5000 | max wait for a row lock (API pool only) |
| `DB_STATEMENT_TIMEOUT_MS` | 10000 | max duration of one statement (API pool only) |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 30000 | Postgres kills a session that sits idle inside a transaction, releasing its locks |

The idempotency lock window is derived: geocoder timeout + payment budget + 5s ≈ 19.6s.

---

## Design decisions and trade-offs

The short version; [DESIGN.md](DESIGN.md) has the details.

- **External calls happen outside transactions.** Geocoding and payment never run while row locks are held. The database work is split into short transactions (TX1 reserves, TX2 confirms), and the reservation TTL covers the gap.
- **Reservations instead of decrementing stock up front.** `available = on_hand − active, unexpired reservations`. `on_hand` only drops when TX2 confirms. An abandoned order frees its stock simply by its reservation expiring, with nothing to undo.
- **Pessimistic locking with a fixed order.** Stock rows are locked with `FOR UPDATE` in `product_id` order. Each candidate warehouse gets a `SAVEPOINT` that is rolled back if it can't fill the order, which releases its locks before the next candidate is tried. The availability sum runs as a separate statement after the lock is taken, so it sees reservations committed while this transaction was waiting.
- **Idempotency in two layers.** Client requests are deduplicated by `(customer_id, Idempotency-Key)` using `INSERT … ON CONFLICT DO NOTHING`. Payments are deduplicated by the order ID, which is the payment idempotency key. A retry, a takeover after a crash, or the reconciler can therefore safely "charge again".
- **A timeout means "unknown", not "failed".** After the retries run out, the API asks the provider what happened before deciding. If it can't even ask, the order is parked as `PAYMENT_UNKNOWN` (202) and a background job resolves it.
- **Write the intent before the side effect.** An order moves to `REFUND_PENDING` before the refund is called, so a crash in between is recovered by the reconciler.
- **Bounded waits.** The API's connections set `lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout`. A stalled transaction can't block other orders for the same products indefinitely: waiters get a retryable 503, and Postgres kills the stuck session. Killing a session can't crash the API: `withTransaction` listens for connection errors while it holds a client, and the pool discards the broken connection.
- **Background jobs use `SKIP LOCKED`** plus an `updated_at` lease. Several API instances can run them at the same time without doing the same work twice.
- **Transactional outbox.** The `OrderPaid` event is written in the same transaction that marks the order paid, and a poller publishes it at least once.
- **No ORM, no DI container.** Every lock, transaction and conditional update is plain SQL you can read in `src/repositories`.

### What was cut

- Authentication. `customerId` comes from the request body, and idempotency keys are scoped to it.
- CRUD for customers, products, warehouses and stock. Restocking a cancelled paid order isn't supported either.
- Automated tests. Behaviour is verified with `scripts/demo.sh`, `scripts/concurrency.ts`, and fault injection by stopping containers and moving timestamps in SQL.
- Multi-currency (USD only), taxes, shipping cost, partial fulfilment from several warehouses.
- Clean-up of old idempotency keys and published outbox rows.
- A real geocoder, a real payment provider, and a real message broker.

### Running this in production

- **Compute.** Run the API on ECS/Fargate, or Lambda behind API Gateway, defined with CDK. On Lambda, the `setInterval` jobs become EventBridge Scheduler rules that invoke `sweep`, `reconcile` and `publishOutbox` Lambdas. The functions are already plain, stateless and safe to run concurrently thanks to `SKIP LOCKED` and leases.
- **Database.** RDS or Aurora PostgreSQL with PostGIS, behind RDS Proxy (needed with Lambda to avoid exhausting connections). Run migrations as a pipeline step instead of a compose service.
- **Events.** The outbox poller publishes to an EventBridge bus, or Debezium/logical replication streams the outbox table. Consumers deduplicate on the event ID, since delivery is at-least-once.
- **Payments and PCI.** Card numbers should never reach this service. Use client-side tokenization so the API only handles a token. Until then, the number is never stored or logged: only the last 4 digits are kept, logs are redacted, and the request hash uses last4 only.
- **Secrets and config.** Secrets Manager or SSM Parameter Store, injected as environment variables. The startup validation stays the same.
- **Observability.** OpenTelemetry traces across the API, the provider and the database. Alarms on the number of `PAYMENT_UNKNOWN` and `REFUND_PENDING` orders, unpublished outbox rows, reconciler errors and lock wait time.
- **Geocoding.** AWS Location Service or similar, with a cache keyed by the normalized address, a circuit breaker, and the same timeout.
- **Scale.** Contention is per `(warehouse, product)` row, so hot SKUs serialize while everything else runs in parallel. If one SKU becomes a bottleneck, split its stock into buckets or move to a stock ledger.
