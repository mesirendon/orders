import pg from 'pg';

export interface SessionTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

export function createPool(connectionString: string, timeouts?: SessionTimeouts): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    lock_timeout: timeouts?.lockTimeoutMs,
    statement_timeout: timeouts?.statementTimeoutMs,
    idle_in_transaction_session_timeout: timeouts?.idleInTransactionTimeoutMs,
  });
}

export type Db = pg.Pool | pg.PoolClient;
