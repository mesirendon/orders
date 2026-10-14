# Diagrams

PlantUML sources. Render with `plantuml -tsvg docs/*.puml`, or paste a file into https://www.plantuml.com/plantuml.

| File | Shows |
| ---- | ----- |
| `components.puml` | Components and connectors: API modules, payment mock, PostgreSQL schemas and how they talk |
| `sequence-create-order.puml` | `POST /orders` happy path and decline, with TX1/TX2 statements |
| `sequence-payment-uncertainty.puml` | Payment timeouts, status lookup, `PAYMENT_UNKNOWN`, expired reservation, re-reserve and refund |
| `sequence-idempotency.puml` | Replay, conflict, and takeover after a crash |
| `sequence-background-jobs.puml` | Sweeper, reconciler (with leases) and outbox poller |
| `deployment.puml` | docker compose topology and start-up order, with the production mapping |
| `database.puml` | Database tables, keys, indexes and relationships |
