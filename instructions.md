Build a take-home backend service. Read the whole brief before writing code, then build in the phases listed at the end. Once you finish each phase ask me for reviews and I'll make the commit. Once we commit, I'll tell you so we can continue. At the end, let's create also a `docs/` folder to store puml diagrams for components and connectors, sequences, deployment, and class diagram for the db.

## Assignment

Order management API for an e-commerce platform. Only POST /orders is required.

- Order has a customer, a shipping address, and items (product + quantity).
- An order must be filled from a single warehouse that has ALL requested products. If several qualify, pick the closest to the shipping address. If none qualifies, reject.
- Address -> lat/lng via a geocoder (mocked).
- On creating the order, call an external payment API (mocked): card number, amount, description.
- It must be production-ready in how it handles data: real database, transactions, concurrency, idempotency. No auth, no CRUD for customers/warehouses/products. Automated tests are not required.

## Hard rules for the code

- Do NOT write comments unless strictly necessary to explain a non-obvious "why". No JSDoc, no section banners, no commented-out code, no comments in SQL files, no comments restating what the code does.
- I must be able to explain every line in a live interview. Prefer plain functions and small files over abstractions. No ORM, no DI framework, no decorators, no clever generics.
- Raw SQL with `pg` (node-postgres). Every locking, transaction and conditional-update statement must be visible in the code.
- Put explanations in README.md / DESIGN.md, not in code.

## Stack

- TypeScript (strict), Node 22, Fastify, zod for validation, pino logging with redaction of the card number, `tsx` for dev, multi-stage Dockerfile.
- PostgreSQL via the `postgis/postgis` image. Use PostGIS: `geography(Point,4326)` for warehouse location, GiST index, `ST_Distance` for nearest.
- Single `docker compose up` starts everything. Order: postgres (healthcheck) -> migrate -> seed -> api. The payment mock is an independent service.
- Config only via environment variables, validated at startup. Include GET /health. Graceful shutdown.

## Layout

src/
  routes/        HTTP only: parse, validate, map errors to status codes
  services/      order logic, payment orchestration, reconciliation, sweeper
  repositories/  all SQL
  geocoder/      Geocoder interface + MockGeocoder
  payments/      PaymentGateway interface + HttpPaymentGateway
  db/            pool, withTransaction helper, migration runner
migrations/      numbered .sql files, run once, re-runnable safely
seed/            idempotent (ON CONFLICT DO NOTHING)
payment-mock/    separate Fastify service
scripts/         concurrency proof script

## Schema (migrations)

All money is integer cents. Single currency (USD). Use timestamptz everywhere.

- customers(id, name, email unique)
- products(id, name, price_cents CHECK > 0)
- warehouses(id, name, location geography(Point,4326) NOT NULL) + GiST index
- warehouse_stock(warehouse_id FK, product_id FK, on_hand int CHECK >= 0, PK(warehouse_id, product_id))
- orders(id uuid, customer_id FK, status, warehouse_id FK, total_cents, shipping_line1, shipping_city, shipping_postal_code, shipping_country, shipping_location geography, created_at, updated_at) + index (customer_id, created_at desc)
- order_items(order_id FK, product_id FK, quantity CHECK > 0, unit_price_cents snapshot, PK(order_id, product_id))
- stock_reservations(id, order_id FK, warehouse_id, product_id, quantity CHECK > 0, status ACTIVE|CONFIRMED|RELEASED|EXPIRED, expires_at) + partial index on (warehouse_id, product_id) WHERE status='ACTIVE' + index on expires_at WHERE status='ACTIVE'
- payment_attempts(id, order_id FK, idempotency_key, status, card_last4, processor_payment_id, amount_cents, error, created_at). Never store the full card number.
- idempotency_keys(customer_id, key, request_hash, status IN_PROGRESS|COMPLETED, locked_until, order_id, response_status, response_body jsonb, created_at, PK/UNIQUE(customer_id, key))
- outbox(id, aggregate_id, type, payload jsonb, created_at, published_at null) -- phase 7 only
Order statuses: PENDING, PAID, PAYMENT_FAILED, PAYMENT_UNKNOWN, EXPIRED, CANCELLED, REFUND_PENDING.
Seed: 5 warehouses at distinct real-world coordinates, ~10 products, stock per warehouse (include a product with stock 1 in one warehouse for the race demo, and a case where no single warehouse has a given combination), 3 customers.

## POST /orders

Header: Idempotency-Key (required). Body:
{ customerId, shippingAddress: { line1, city, postalCode, country }, items: [{ productId, quantity }], payment: { cardNumber } }
Validate with zod: positive integer quantities, no duplicate productIds (422), 16-digit card number.
Amount is computed server-side from products.price_cents, never from the client.

Flow:

1. Validate. Compute request_hash.
2. Idempotency: `INSERT ... ON CONFLICT (customer_id, key) DO NOTHING RETURNING`. Never SELECT-then-INSERT.
   - Row returned -> this request owns it, set locked_until = now() + payment budget.
   - Conflict: same key different hash -> 422. COMPLETED -> replay stored status+body. IN_PROGRESS with locked_until in the future -> 409 "request in progress". IN_PROGRESS with locked_until in the past -> take over and resume (safe because the payment key is reused).
3. Geocode OUTSIDE any transaction (timeout, GeocodingError -> 422).
4. TRANSACTION 1 (short): find candidate warehouses that stock every requested product (GROUP BY warehouse HAVING count = n), ordered by ST_Distance to the shipping point. For each candidate in order: SELECT ... FROM warehouse_stock WHERE warehouse_id=$1 AND product_id = ANY($2) ORDER BY product_id FOR UPDATE; recompute available = on_hand - SUM(active, unexpired reservations); if enough for every item, insert ACTIVE reservations (expires_at = now() + RESERVATION_TTL), insert order PENDING with items and price snapshots, commit. If a candidate fails the recheck, try the next one. If none works -> rollback, 409 INSUFFICIENT_STOCK listing the products that could not be covered. Whole order from ONE warehouse, never split.
5. Payment OUTSIDE any transaction, key = order id. Per-call timeout, max 3 attempts with backoff, retry only timeouts/5xx/network errors, never a decline.
   - Approved -> TRANSACTION 2.
   - Declined (402) -> order PAYMENT_FAILED, reservations RELEASED, respond 402.
   - Timeout/5xx after attempts -> call GET /payments/{key}. SUCCEEDED -> TRANSACTION 2. NOT_FOUND -> treat as not charged, PAYMENT_FAILED, release, respond 502/504. Lookup itself fails -> order PAYMENT_UNKNOWN, respond 202 with order id.
6. TRANSACTION 2: `UPDATE stock_reservations SET status='CONFIRMED' WHERE order_id=$1 AND status='ACTIVE' AND expires_at > now()`.
   - Rows affected = full set -> order PAID, store payment_attempt, mark idempotency COMPLETED with response, respond 201.
   - Zero rows (reservation expired during payment): new short transaction repeating lock+recheck+reserve. If stock is still there -> confirm and PAID. If not -> refund via gateway with key `refund:{order_id}`, order CANCELLED, respond 409. If the refund call fails -> order REFUND_PENDING.
Also GET /orders/:id.

## Payment mock (separate service, own schema in the same Postgres instance)

- POST /payments {cardNumber, amountCents, description} with Idempotency-Key header. Same key returns the same stored result without charging twice.
- GET /payments/:key -> SUCCEEDED | NOT_FOUND | DECLINED
- POST /payments/:key/refund (idempotent)
- Behavior by card number prefix: 4242 approved; 0000 declined (402); 1111 records the payment as SUCCEEDED then sleeps past the client timeout; 2222 sleeps past the client timeout WITHOUT recording anything. Any other valid 16-digit number is approved. Never log or persist the full card number.

## Background jobs (in-process setInterval, each tick idempotent, FOR UPDATE SKIP LOCKED)

- Sweeper: mark ACTIVE reservations past expires_at as EXPIRED; move still-PENDING orders to EXPIRED.
- Reconciler: resolve PAYMENT_UNKNOWN via GET /payments/{key}; retry REFUND_PENDING.

## Status codes

201 created, 202 outcome unknown, 400 bad request, 402 declined, 409 insufficient stock / request in progress / expired-and-refunded, 422 validation / key reuse with different body / geocoding failure, 502/504 upstream failure.

## Geocoder

Geocoder interface. MockGeocoder resolves by postalCode from a small lookup table of known codes, with a deterministic hash fallback into a bounding box. Blank postal code -> GeocodingError.

## Decisions already made (do not revisit)

- Postgres, not DynamoDB. No ORM. No Lambda/CDK/EventBridge; the README mentions how production would map to them.
- No RabbitMQ or other broker. Phase 7 uses a transactional outbox row written in TRANSACTION 2, a poller publishes to a stub "delivery" consumer that only logs and marks published_at.
- Price lives on products only. Config defaults: RESERVATION_TTL=2 minutes (must exceed total payment budget), payment timeout 3s, 3 attempts.

## Phases

1. compose, Dockerfiles, migrations, seed, db helpers, health endpoint
2. payment mock service
3. POST /orders happy path (steps 1-6 without idempotency edge cases)
4. 409 insufficient stock, 402 decline, GET /orders/:id
5. full idempotency handling and the timeout/unknown/refund paths
6. sweeper, reconciler, scripts/concurrency.ts (fire N parallel orders at the stock-1 product, print exactly one winner) and scripts/demo.sh with curl examples for every card number
7. outbox + stub delivery consumer
8. README (run, test, curl examples, state machine, design decisions and trade-offs, what was cut, production notes) and DESIGN.md (flow diagram in text, transaction boundaries, failure matrix)

After each phase, run the project and verify it works before continuing. Tell me briefly what you built and anything you were unsure about.
