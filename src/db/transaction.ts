import type pg from 'pg';

export async function inTransaction<T>(
  client: pg.PoolClient,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await inTransaction(client, fn);
  } finally {
    client.release();
  }
}
