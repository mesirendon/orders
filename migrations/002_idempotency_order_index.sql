CREATE INDEX idempotency_keys_order_idx ON idempotency_keys (order_id) WHERE order_id IS NOT NULL;
