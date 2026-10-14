import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createPool } from './pool.js';
import { inTransaction } from './transaction.js';

const MIGRATION_LOCK_ID = 727001;
const MIGRATIONS_DIR = path.resolve('migrations');

async function main(): Promise<void> {
  const databaseUrl = z.string().min(1).parse(process.env.DATABASE_URL);
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip ${file}`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await inTransaction(client, async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      console.log(`applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed', err);
  process.exit(1);
});
