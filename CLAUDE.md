# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Take-home order management API: `POST /orders` geocodes the address, reserves stock from the single nearest warehouse that has every item, charges an external payment API, and confirms. The original brief is `instructions.md`; `README.md` (usage, status codes, seed IDs, card prefixes) and `DESIGN.md` (transaction boundaries, locking rules, failure matrix) are the reference docs. `docs/*.puml` holds the diagrams.

## Commands

```bash
docker compose up --build -d --wait   # postgres -> migrate -> seed -> api (:3000); payment-mock (:4000) is independent
docker compose down -v             # wipe the DB
npm run typecheck                  # tsc --noEmit (the only static check; there is no linter)
cd payment-mock && npm run typecheck
npm run demo                       # scripts/demo.sh: curl for every card prefix and error path
npm run concurrency -- --reset     # N parallel orders on the stock-1 product; exits 1 unless exactly one 201
docker compose exec postgres psql -U canals -d canals
```

Local dev without the api container: `docker compose up -d postgres payment-mock`, then `set -a && source .env.example && set +a && npm run migrate && npm run seed && npm run dev`.

There are no automated tests by design. Verify changes against the running stack:
- `npm run demo` and `npm run concurrency -- --reset`.
- Fault injection: `docker compose stop payment-mock` (gives 202 / PAYMENT_UNKNOWN), `docker compose kill api` mid-request (gives takeover/resume), holding a stock row `FOR UPDATE` from psql with `pg_sleep` (gives 503 after the 5s lock timeout), and moving `stock_reservations.expires_at`, `idempotency_keys.locked_until` or `orders.updated_at` into the past in SQL. That last one forces expiry, takeover or a reconciler lease without waiting.
- Cards `1111` and `2222` take ~10s (three 3s timeouts plus a status lookup).

On Apple Silicon, `postgis/postgis` runs under amd64 emulation (`platform: linux/amd64`).

## Hard rules for code (from the brief; the author must explain every line in a live interview)

- No comments unless strictly needed for a non-obvious "why". No JSDoc, no banners, no comments in SQL files. Put explanations in README.md / DESIGN.md.
- Plain functions and small files. No ORM, no DI framework, no decorators, no clever generics or callback-style abstractions.
- Raw SQL with `pg` only, and only in `src/repositories/`. Every `BEGIN`, `FOR UPDATE`, `SKIP LOCKED`, `SAVEPOINT` and conditional `UPDATE ... WHERE status = ...` must be visible in code.
- Money is integer cents (USD). The amount charged is always computed on the server from `products.price_cents`.
- Never store or log the full card number. Only `card_last4` is persisted, the request hash uses last4, and pino redacts `cardNumber`.
- Migrations are append-only, numbered `migrations/NNN_*.sql`. Never edit an applied one; add a new file. The seed must stay idempotent (`ON CONFLICT DO NOTHING`).
- Config comes only from env vars, validated by zod in `src/config.ts`. It refuses to start unless `RESERVATION_TTL_SECONDS` exceeds the derived payment budget and `DB_LOCK_TIMEOUT_MS < DB_STATEMENT_TIMEOUT_MS < DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`.
- Check Postgres error codes with `pgErrorCode` / `isDatabaseTimeout` from `src/db/errors.ts`, not ad-hoc `err.code` checks.

## Architecture

`routes/` (HTTP + zod) → `services/` (orchestration) → `repositories/` (SQL). `geocoder/` and `payments/` are interfaces with one implementation each. `Deps` (`services/types.ts`) is a plain object built in `server.ts` and passed down; there is no container.

The order flow lives in `services/createOrder.ts` → `settlePayment.ts`:
1. **Claim the idempotency key** with `INSERT ... ON CONFLICT DO NOTHING RETURNING`, never SELECT-then-INSERT. On conflict:
   - different hash → 422;
   - COMPLETED → replay the stored response;
   - lock still held → 409;
   - lock expired → conditional `UPDATE ... WHERE locked_until <= now() RETURNING` (takeover), then resume from the order's state.
2. **Geocode** outside any transaction.
3. **TX1** (`reserveStock.ts`): candidate warehouses by `ST_Distance`. For each candidate: `SAVEPOINT` → lock stock rows → separate reservation-sum query → `RELEASE` or `ROLLBACK TO SAVEPOINT`. Then insert the order (PENDING), items and ACTIVE reservations.
4. **Charge** outside any transaction. The payment idempotency key is the order ID. Retry only timeouts, network errors and 5xx. After the retries run out, `GET /payments/{orderId}` decides between confirm, fail (502/504) and PAYMENT_UNKNOWN (202).
5. **TX2** (`confirmOrder.ts`): lock order → lock stock → confirm reservations with `expires_at > clock_timestamp()` → decrement `on_hand` → PAID → payment attempt → outbox `OrderPaid` → complete the key.
6. **Reservation lapsed** → `reReserveOrder.ts`: one transaction re-runs the candidate search (may pick another warehouse). If none fits, it commits `REFUND_PENDING` first and then calls `refundOrder.ts` with key `refund:{orderId}`.

Background jobs (`services/jobs.ts`, started in `server.ts`, awaited on shutdown):
- **sweeper:** expires lapsed reservations and PENDING orders.
- **reconciler:** handles PAYMENT_UNKNOWN orders, REFUND_PENDING orders, and abandoned IN_PROGRESS keys whose order EXPIRED.
- **outboxPoller:** publishes to the stub `deliveryConsumer`.

### Invariants that correctness depends on (see DESIGN.md §3–5 before touching these)

- **Lock order is always order row → stock rows `ORDER BY product_id` → reservation rows.** New code that locks must follow it.
- **Lock, then count, in two separate statements.** `lockStockRows` and `sumActiveReservations` stay separate: in READ COMMITTED, a single statement's subquery would read a snapshot taken before the lock wait and oversell. Do not merge them.
- **TX2 uses `clock_timestamp()`; TX1 uses `now()`.** Do not swap them.
- **Availability** = `on_hand` − ACTIVE unexpired reservations. `on_hand` only decreases on confirm.
- **Once an order exists, the idempotency key is completed by `order_id`** (`completeIdempotencyKeyForOrder`), in the same transaction that sets the order's final state.
- **HTTP responses come from `services/orderResponses.ts`**, including `responseForOrder`, which maps order state to a response. Keep stored and replayed bodies consistent by building them there.
- **Every status change is a conditional `UPDATE ... WHERE status = ANY(...)`.** That is what makes retries, takeovers and parallel job instances safe to run twice.
- **Waits are bounded.** The API pool sets `lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout` (`db/pool.ts`, env `DB_*`). Timeout SQLSTATEs (`db/errors.ts`) map to 503 DATABASE_BUSY in `app.ts`. Migrate and seed deliberately use no timeouts. In API and job code always use `withTransaction`: it attaches the error listener that keeps a server-side session kill from crashing the process. Only the one-shot migrate runner calls `pool.connect()` directly.
- **TX1 must commit inside the idempotency lock window (19.6s).** Until then the key has no `order_id`, and a takeover would start a second order. That is why a lock timeout fails TX1 instead of being absorbed per candidate warehouse. Don't add waits or external calls before TX1 commits without growing the window in `config.ts`.
- **Background claims use `FOR UPDATE SKIP LOCKED`.** The reconciler leases rows by bumping `updated_at` (30s), commits, and only then does HTTP. No transaction is held open across a network call. The one exception, the outbox poller holding its transaction while it calls the in-process stub consumer, would have to move to the lease pattern before a real consumer is plugged in.

## Payment mock (`payment-mock/`)

A separate service with its own `package.json`, Dockerfile and `payment_mock` schema, which it creates on startup (it does not use the API's migrations).

| Card prefix | Behaviour |
| ----------- | --------- |
| `4242`, any other valid number | approved |
| `0000` | declined (402) |
| `1111` | records SUCCEEDED, then sleeps 10s on every call |
| `2222` | sleeps without recording |

## Working agreement

Work so far was done phase by phase. After each phase the user reviews and commits themselves; do not commit unless asked. Commit messages end with the `Co-Authored-By` attribution line.
