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
  let connectionError: Error | undefined;
  const onConnectionError = (err: Error) => {
    connectionError ??= err;
  };
  // pg-pool removes its own 'error' listener while a client is checked out; without one,
  // a server-side session kill between queries is an unhandled 'error' event and exits the process.
  client.on('error', onConnectionError);
  try {
    return await inTransaction(client, fn);
  } catch (err) {
    throw connectionError ?? err;
  } finally {
    client.off('error', onConnectionError);
    client.release(connectionError);
  }
}
