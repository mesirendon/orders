import { randomUUID } from 'node:crypto';
import pg from 'pg';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://canals:canals@localhost:5432/canals';
const PARALLEL = Number(process.env.PARALLEL ?? 20);

const STOCK_ONE_PRODUCT = '22222222-0000-4000-8000-000000000009';
const CHICAGO_WAREHOUSE = '33333333-0000-4000-8000-000000000002';
const CUSTOMERS = [
  '11111111-0000-4000-8000-000000000001',
  '11111111-0000-4000-8000-000000000002',
  '11111111-0000-4000-8000-000000000003',
];

async function resetStock(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE stock_reservations SET status = 'RELEASED', updated_at = now()
       WHERE product_id = $1 AND status = 'ACTIVE'`,
      [STOCK_ONE_PRODUCT],
    );
    await client.query('UPDATE warehouse_stock SET on_hand = 1 WHERE warehouse_id = $1 AND product_id = $2', [
      CHICAGO_WAREHOUSE,
      STOCK_ONE_PRODUCT,
    ]);
  } finally {
    await client.end();
  }
}

async function placeOrder(index: number): Promise<{ index: number; status: number; body: { id?: string; status?: string } }> {
  const response = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `race-${randomUUID()}` },
    body: JSON.stringify({
      customerId: CUSTOMERS[index % CUSTOMERS.length],
      shippingAddress: { line1: '233 S Wacker Dr', city: 'Chicago', postalCode: '60601', country: 'US' },
      items: [{ productId: STOCK_ONE_PRODUCT, quantity: 1 }],
      payment: { cardNumber: '4242424242424242' },
    }),
  });
  return { index, status: response.status, body: await response.json() };
}

async function main(): Promise<void> {
  if (process.argv.includes('--reset')) {
    await resetStock();
    console.log('reset: Limited Edition Print stock set to 1 in Chicago');
  }

  console.log(`firing ${PARALLEL} parallel orders for the stock-1 product...`);
  const results = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => placeOrder(i)));

  const byStatus = new Map<number, number>();
  for (const result of results) {
    byStatus.set(result.status, (byStatus.get(result.status) ?? 0) + 1);
  }
  for (const [status, count] of [...byStatus].sort()) {
    console.log(`  HTTP ${status}: ${count}`);
  }

  const winners = results.filter((result) => result.status === 201);
  for (const winner of winners) {
    console.log(`winner: request #${winner.index} -> order ${winner.body.id} (${winner.body.status})`);
  }

  if (winners.length !== 1) {
    console.error(`expected exactly one winner, got ${winners.length}`);
    process.exit(1);
  }
  console.log('OK: exactly one winner');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
