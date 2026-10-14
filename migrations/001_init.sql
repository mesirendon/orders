CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location geography(Point, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX warehouses_location_gist ON warehouses USING gist (location);

CREATE TABLE warehouse_stock (
  warehouse_id uuid NOT NULL REFERENCES warehouses (id),
  product_id uuid NOT NULL REFERENCES products (id),
  on_hand integer NOT NULL CHECK (on_hand >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, product_id)
);

CREATE INDEX warehouse_stock_product_idx ON warehouse_stock (product_id);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers (id),
  status text NOT NULL CHECK (status IN (
    'PENDING', 'PAID', 'PAYMENT_FAILED', 'PAYMENT_UNKNOWN',
    'EXPIRED', 'CANCELLED', 'REFUND_PENDING'
  )),
  warehouse_id uuid NOT NULL REFERENCES warehouses (id),
  total_cents integer NOT NULL CHECK (total_cents > 0),
  shipping_line1 text NOT NULL,
  shipping_city text NOT NULL,
  shipping_postal_code text NOT NULL,
  shipping_country text NOT NULL,
  shipping_location geography(Point, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_needs_attention_idx ON orders (status, updated_at)
  WHERE status IN ('PENDING', 'PAYMENT_UNKNOWN', 'REFUND_PENDING');

CREATE TABLE order_items (
  order_id uuid NOT NULL REFERENCES orders (id),
  product_id uuid NOT NULL REFERENCES products (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE stock_reservations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders (id),
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (warehouse_id, product_id) REFERENCES warehouse_stock (warehouse_id, product_id)
);

CREATE INDEX stock_reservations_active_idx ON stock_reservations (warehouse_id, product_id)
  WHERE status = 'ACTIVE';
CREATE INDEX stock_reservations_active_expiry_idx ON stock_reservations (expires_at)
  WHERE status = 'ACTIVE';
CREATE INDEX stock_reservations_order_idx ON stock_reservations (order_id);

CREATE TABLE payment_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders (id),
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('SUCCEEDED', 'DECLINED', 'FAILED', 'UNKNOWN', 'REFUNDED')),
  card_last4 char(4) NOT NULL,
  processor_payment_id text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_attempts_order_idx ON payment_attempts (order_id);

CREATE TABLE idempotency_keys (
  customer_id uuid NOT NULL REFERENCES customers (id),
  key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  locked_until timestamptz NOT NULL,
  order_id uuid REFERENCES orders (id),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, key)
);
