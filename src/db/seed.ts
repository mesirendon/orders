import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createPool } from './pool.js';
import { withTransaction } from './transaction.js';

const SEED_FILE = path.resolve('seed', 'seed.sql');

async function main(): Promise<void> {
  const databaseUrl = z.string().min(1).parse(process.env.DATABASE_URL);
  const pool = createPool(databaseUrl);
  try {
    const sql = await readFile(SEED_FILE, 'utf8');
    await withTransaction(pool, (tx) => tx.query(sql));

    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM customers) AS customers,
        (SELECT count(*)::int FROM products) AS products,
        (SELECT count(*)::int FROM warehouses) AS warehouses,
        (SELECT count(*)::int FROM warehouse_stock) AS stock_rows
    `);
    console.log('seed complete', rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('seed failed', err);
  process.exit(1);
});
