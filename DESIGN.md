# Design

This document explains how `POST /orders` stays correct under concurrency, retries and partial failures. Code references point at the file where each piece lives.

## 1. Request flow

```
Client ──POST /orders + Idempotency-Key──► routes/orders.ts
  │  zod validation ─────────────────────────────────────────────► 422 (nothing stored)
  ▼
services/createOrder.ts
  1. request_hash = sha256(customer, address, items sorted, card last4)
  2. INSERT idempotency_keys … ON CONFLICT DO NOTHING RETURNING        [autocommit]
       inserted ───────────────► we own the key, locked_until = now() + lock window
       conflict, other hash ───► 422 IDEMPOTENCY_KEY_REUSED
       conflict, COMPLETED ────► replay stored status + body
       conflict, locked ───────► 409 REQUEST_IN_PROGRESS
       conflict, lock expired ─► UPDATE … WHERE locked_until <= now() RETURNING
                                  (one winner) → resume from the order's state
  3. geocode (timeout)                                                 [no transaction]
  4. TX1 reserveStock ──────────────────────────────────────────────── [transaction]
       prices → candidate warehouses by ST_Distance →
       per candidate: SAVEPOINT, lock stock rows, sum reservations, check
       → order PENDING + items + ACTIVE reservations + key.order_id
       none fits → rollback → 409 INSUFFICIENT_STOCK (stored)
  5. charge, key = order id, ≤3 attempts with backoff                  [no transaction]
       approved ─────────────────────► 6
       declined ─────────────────────► failOrder → 402
       other 4xx ────────────────────► failOrder → 502
       timeouts/5xx exhausted → GET /payments/{orderId}
           SUCCEEDED ──► 6
           DECLINED ───► failOrder → 402
           NOT_FOUND ──► failOrder → 504 / 502
           lookup fails ► markPaymentUnknown → 202
  6. TX2 confirmOrder ──────────────────────────────────────────────── [transaction]
       lock order, lock stock rows,
       UPDATE reservations SET CONFIRMED WHERE ACTIVE AND expires_at > clock_timestamp()
       all rows → decrement on_hand, PAID, payment_attempt, outbox, key COMPLETED → 201
       fewer rows / order EXPIRED → rollback → re-reserve (7)
  7. reReserveOrRefund ─────────────────────────────────────────────── [transaction]
       lock order, expire leftovers, record charge, candidate search again
       found → CONFIRMED reservations, on_hand, PAID, outbox, key → 201
       none  → REFUND_PENDING, commit, then refund (no transaction)
                 ok   → TX: CANCELLED + REFUNDED attempt, key → 409
                 fail → key → 409 (refund PENDING), reconciler retries
```

## 2. Transaction boundaries

| # | Where | Statements | Why it is its own transaction |
| - | ----- | ---------- | ----------------------------- |
| claim | `repositories/idempotencyKeys.ts` | single `INSERT … ON CONFLICT DO NOTHING RETURNING` or conditional `UPDATE … RETURNING` | One atomic statement decides ownership. There is never a SELECT followed by an INSERT. |
| TX1 | `services/reserveStock.ts` | prices, candidate query, `SAVEPOINT` + `FOR UPDATE` + availability sum per candidate, insert order/items/reservations, attach order to key | Short and has no network I/O. The order and its reservations appear together or not at all. |
| – | payment | HTTP only | Holding row locks during a 3–10s external call would serialize every order for those products. |
| TX2 | `services/confirmOrder.ts` | lock order, lock stock, conditional confirm, decrement `on_hand`, PAID, payment attempt, outbox, complete key | Stock leaves the warehouse, the order is paid, the event is queued and the client's answer is stored, all in one atomic step. |
| fail | `services/failOrder.ts` | order → PAYMENT_FAILED, release reservations, attempt, complete key | Same reasoning, for the failure outcome. |
| unknown | `services/settlePayment.ts#markPaymentUnknown` | order → PAYMENT_UNKNOWN, UNKNOWN attempt, key → 202 | |
| re-reserve | `services/reReserveOrder.ts` | lock order, expire leftovers, record charge, candidate search, then PAID or REFUND_PENDING | The decision to refund is committed before the refund call. |
| refund | `services/refundOrder.ts` | HTTP refund, then REFUND_PENDING → CANCELLED + attempt + key | |
| sweep | `services/sweeper.ts` | lock orders `SKIP LOCKED`, expire reservations, PENDING → EXPIRED | |
| claim jobs | `repositories/orders.ts#claimOrdersForReconciliation` | `UPDATE … SET updated_at = now() WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` | Leases a batch. The HTTP work happens after commit. |
| outbox | `services/outboxPoller.ts` | lock unpublished `SKIP LOCKED`, deliver, mark published | |

All transactions use `READ COMMITTED` through `db/transaction.ts` (`withTransaction` / `inTransaction`). `withTransaction` also guards the checked-out client against server-side session kills (§3, rule 6).

## 3. Locking rules

1. **Lock order is always: order row → stock rows sorted by `product_id` → reservation rows.** TX2, re-reserve, failOrder and the sweeper all touch the order first. TX1 creates a new order, so it has no order row to lock first. Because everyone acquires locks in the same order, no wait cycle can form between two transactions.
2. **One warehouse locked at a time in the candidate loop.** Each candidate gets `SAVEPOINT candidate`. If it can't fill the order, `ROLLBACK TO SAVEPOINT` releases the row locks taken since. A transaction therefore never holds warehouse A's rows while waiting for warehouse B's, which rules out deadlocks between requests that rank the warehouses differently.
3. **Lock first, then count, in two statements.** `lockStockRows` (`SELECT … FOR UPDATE`) and `sumActiveReservations` are separate queries on purpose. In READ COMMITTED, a single statement reads from a snapshot taken when it started. If it had to wait for a lock, a subquery inside it would not see reservations committed by the transaction it was waiting on, and we would oversell. The second statement takes a fresh snapshot after the lock is held.
4. **TX2 compares against `clock_timestamp()`, not `now()`.** `now()` is when the transaction started, which can be before it waited for the stock lock. With `now()`, a reservation that expired while TX2 was waiting could still be confirmed after another request had already reused that stock. TX1 uses `now()`, which only errs on the side of counting a reservation as still active.
5. **The stock rows are the only contended resource.** Two orders for different products, or for different warehouses, never block each other.
6. **Every wait is bounded.** The API pool sets `lock_timeout` (5s), `statement_timeout` (10s) and `idle_in_transaction_session_timeout` (30s) as connection parameters, so Postgres enforces them. Config refuses to start unless lock < statement < idle. These errors (SQLSTATE 55P03, 57014, 25P03) become `503 DATABASE_BUSY` with `Retry-After`. Before an order exists, the key is released. After, it is unlocked and the retry resumes the same order. Migrate and seed connect without these limits because `CREATE EXTENSION postgis` can be slow.
   - **A killed session can't crash the process.** `pg-pool` removes its error listener while a client is checked out, so a session that Postgres terminates between queries (idle timeout, `pg_terminate_backend`, a restart) would raise an unhandled `error` event and exit Node. `withTransaction` attaches its own listener for as long as it holds the client, rethrows the connection error as the cause, and releases the client with that error so the pool discards it.
   - **A lock timeout fails the whole TX1; it does not skip to the next candidate.** Absorbing it per candidate could keep TX1 waiting for one lock timeout per warehouse (5 × 5s), longer than the 19.6s idempotency lock window. Until TX1 commits, the key has no order attached, so a retry that took over the lapsed key would create a second order. Failing fast keeps TX1 well inside the window. After TX1 a lapsed window is harmless: a takeover resumes the attached order, and every write is conditional.
7. **The CHECK `on_hand >= 0` is the last line of defence.** A bug in the logic above would raise an error instead of overselling.

Proof: `npm run concurrency -- --reset` fires 20 (or `PARALLEL=50`) simultaneous orders at the product with stock 1. Exactly one gets 201, the rest get 409, and `on_hand` ends at 0.

## 4. Stock model

```
available(warehouse, product) = on_hand − Σ quantity of ACTIVE reservations with expires_at > now
```

- TX1 inserts `ACTIVE` reservations with `expires_at = now() + RESERVATION_TTL` (120s).
- TX2 sets them to `CONFIRMED` and decrements `on_hand`. A confirmed reservation is no longer counted because `on_hand` already reflects it.
- A decline releases them (`RELEASED`). The sweeper marks lapsed ones `EXPIRED`. Availability already ignores lapsed rows by their timestamp, so the sweeper is cleanup, not a correctness requirement.
- The TTL (120s) must exceed the payment budget (12.6s). The config check refuses to start otherwise. A reservation can therefore only lapse during payment if the process stalls or crashes, and that case is handled by re-reserve or refund.

## 5. Idempotency

- **Key:** `(customer_id, Idempotency-Key)`. **Hash:** SHA-256 over customer, address, items sorted by product, and the card's last 4 digits. The full card number is never hashed: an unsalted hash of a 16-digit number can be brute-forced.
- **Lock window:** `locked_until = now() + geocoder timeout + payment budget + 5s`. While it holds, a duplicate request gets 409. Once it lapses, the owner is presumed dead.
- **Takeover** is a single conditional `UPDATE … WHERE status='IN_PROGRESS' AND locked_until <= now() RETURNING`, so two retries can't both take over. The new owner resumes from what is in the database:
  - no order → start over;
  - `PENDING` → charge again with the same payment key (the provider returns the stored result, so there's no double charge);
  - `EXPIRED` → look the payment up and, if it was charged, re-reserve or refund;
  - anything else → reply from the order's state (`services/orderResponses.ts#responseForOrder`).
- **What is stored:**
  - **Every outcome once an order exists.** It is written in the same transaction that sets the order's state, completed through `order_id` (migration 002 adds the index).
  - **4xx outcomes before an order exists:** stock, geocoding, unknown product.
  - **Not stored:** validation errors (rejected before the key is claimed) and 5xx errors before an order exists. For those the key is deleted, so a retry starts fresh.
  - **Unexpected error after the order exists:** the key is kept, but `locked_until` is set to `now()` so the next retry resumes immediately.
- **Payment side:** the order ID is the payment idempotency key and `refund:{orderId}` is the refund key. The mock stores a payment under its key with `INSERT … ON CONFLICT DO NOTHING`. Repeated calls return the stored row, and the refund is a conditional `UPDATE … WHERE refunded_at IS NULL`.

## 6. Background jobs

All three are `setInterval` jobs (`services/jobs.ts`). A tick is skipped if the previous one is still running, and shutdown waits for the current tick. Every tick can safely be repeated or run on several instances at once.

| Job | Picks up | Does |
| --- | -------- | ---- |
| Sweeper (5s) | `PENDING`/`PAYMENT_UNKNOWN` orders with lapsed ACTIVE reservations, `FOR UPDATE SKIP LOCKED` | Reservations → EXPIRED. `PENDING` orders → EXPIRED. `PAYMENT_UNKNOWN` orders are left for the reconciler. |
| Reconciler (10s) | `PAYMENT_UNKNOWN` (lease 30s) | Look up the payment. SUCCEEDED goes through the same TX2 / re-reserve / refund path as a request. DECLINED or NOT_FOUND → PAYMENT_FAILED and stock released. Provider still down → try again next tick. |
| | `REFUND_PENDING` (lease 30s) | Retry the refund with the same `refund:{orderId}` key, then → CANCELLED. |
| | Abandoned requests: key `IN_PROGRESS` with lock expired and order `EXPIRED` | Take over the key, look up the payment. Charged → re-reserve or refund. Not charged → complete the key with 409 ORDER_EXPIRED. This covers a crash after the charge when the client never retries. |
| Outbox (2s) | Unpublished rows, `FOR UPDATE SKIP LOCKED`, in id order | Deliver to the stub consumer, then set `published_at`. A failed delivery stays unpublished and is retried. At-least-once. The transaction stays open during delivery, which is fine for an in-process stub that only logs. A real network consumer should use the reconciler's lease pattern instead (claim, commit, deliver, then mark published), otherwise a slow batch would hold row locks and could hit the 30s idle-in-transaction timeout. |

A **lease** is how the reconciler avoids holding a transaction open during HTTP. It claims rows by bumping `updated_at` (`SKIP LOCKED` keeps instances from claiming the same row), commits, then does the slow work. Another instance won't see the row as eligible again until `updated_at` is 30s old. Even if two instances processed the same row, every write is conditional on the current status, so the second one changes nothing.

## 7. Failure matrix

| # | Failure | Data left behind | Client sees | Recovery |
| - | ------- | ---------------- | ----------- | -------- |
| 1 | Invalid body / missing key | nothing | 422 / 400 | – |
| 2 | Unknown customer | nothing (FK rejects the key insert) | 422 | – |
| 3 | Duplicate request while the first is running | – | 409 REQUEST_IN_PROGRESS | retry later |
| 4 | Same key, different body | – | 422 | – |
| 5 | Geocoding error | key COMPLETED (422) | 422 | – |
| 6 | Geocoder timeout | key deleted | 504 | retry with the same key starts over. A timeout is reported as an upstream failure (504), not as the 422 used for addresses that can't be geocoded, because the address may be fine. |
| 7 | No warehouse can fill the order | TX1 rolled back, key COMPLETED (409) | 409 + shortfall | – |
| 8 | DB error / crash during TX1 | TX1 rolled back, key deleted (or left IN_PROGRESS until the lock lapses) | 500 | retry starts over |
| 8a | Stock row locked longer than `lock_timeout` (5s) | TX1 rolled back, key deleted | 503 DATABASE_BUSY + `Retry-After` | retry with the same key |
| 8b | Session killed mid-transaction: idle-in-transaction timeout (25P03), `pg_terminate_backend` or a DB restart (57P01) | transaction rolled back by Postgres; the broken connection is discarded, the process keeps running | 503 DATABASE_BUSY for 25P03, 500 otherwise | retry with the same key (starts over before an order exists, resumes it after) |
| 9 | Crash after TX1, before charging | order PENDING, key IN_PROGRESS | connection dropped | Retry after the lock lapses → takeover → charge. No retry → sweeper EXPIRED → reconciler finds NOT_FOUND → key 409 ORDER_EXPIRED. |
| 10 | Card declined | PAYMENT_FAILED, reservations RELEASED | 402 | – |
| 11 | Provider 4xx other than 402 | PAYMENT_FAILED | 502 PAYMENT_REJECTED | – |
| 12 | Timeouts, provider actually charged (`1111`) | – | 201 after the lookup | – |
| 13 | Timeouts, provider never charged (`2222`) | PAYMENT_FAILED, released | 504 | – |
| 14 | Provider and lookup both unreachable | PAYMENT_UNKNOWN, reservations ACTIVE, key → 202 | 202 + orderId | Reconciler resolves to PAID / PAYMENT_FAILED / refund. |
| 15 | Crash after the charge, before TX2 | order PENDING (charged), key IN_PROGRESS | connection dropped | Retry → takeover → charge again with the same key → provider replays → TX2. No retry → sweeper EXPIRED → reconciler takes over → SUCCEEDED → re-reserve or refund. |
| 16 | DB error in TX2 | TX2 rolled back, key unlocked | 500 | Retry resumes immediately (same as 15). |
| 17 | Reservation lapsed during payment, stock still there | re-reserved, maybe from another warehouse | 201 | – |
| 18 | Reservation lapsed, stock gone | REFUND_PENDING → refunded → CANCELLED | 409 ORDER_CANCELLED (refund COMPLETED) | – |
| 19 | …and the refund call fails | REFUND_PENDING | 409 ORDER_CANCELLED (refund PENDING) | Reconciler retries the refund. |
| 20 | Crash between REFUND_PENDING and the refund call | REFUND_PENDING | connection dropped | Reconciler refunds. A takeover replies from the order's state. |
| 21 | Outbox delivery fails | row unpublished | – | Poller retries next tick. |
| 22 | Two API instances | – | – | `SKIP LOCKED`, leases and conditional updates keep the jobs from duplicating work. |

Scenarios 1–7, 8a, 10, 12–15 and 17–19 were exercised against the running stack by stopping the payment-mock container, killing the API mid-request, and moving `expires_at` / `locked_until` / `updated_at` in SQL. Scenario 8b was exercised with a script that kills a checked-out session through `withTransaction`; without the guard the same kill exits the process. Scenarios 8, 9, 11, 16, 20 and 21 go through the same code paths but were not individually injected.

## 8. Known gaps

- **A charge that lands after the provider said "not found".** We trust a NOT_FOUND lookup made after the retries have timed out. A real provider that records the charge later would leave the order `PAYMENT_FAILED` with money taken. The fix is a periodic settlement-report reconciliation against the provider, which isn't implemented.
- **The stored 202 doesn't change.** A key completed as 202 keeps replaying 202 after the reconciler settles the order. Clients are told to poll `GET /orders/:id`, which is the source of truth. Updating the stored response would make keys mutable; we chose not to.
- **No clean-up** of old idempotency keys, released/expired reservations, or published outbox rows. Production would add TTL deletes or table partitioning.
- **Re-reserve can switch warehouses.** It reruns the full candidate search, so an order paid against Chicago could ship from New York instead of being refunded. That is intentional, but `warehouse_id` on an order can change.
- **57014 is not only a timeout.** `query_canceled` is also raised when an operator cancels a query (`pg_cancel_backend`). Such a cancel is reported as a retryable 503, so the client may simply retry the work. Accepted as reasonable.
- **The lock window does not cover the slowest possible request.** Geocoding + TX1 + payment budget + a 5s lock wait in TX2 can exceed 19.6s. That is safe: once TX1 has committed the key points at the order, so a takeover resumes it and every write is conditional. What must fit in the window is everything *before* TX1 commits, which is why a lock timeout fails TX1 instead of trying the next warehouse.
- **First reconcile is delayed by the lease.** A new `PAYMENT_UNKNOWN` order waits about 30s before its first lookup.
