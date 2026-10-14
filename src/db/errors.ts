export const FOREIGN_KEY_VIOLATION = '23503';
export const IDLE_IN_TRANSACTION_TIMEOUT = '25P03';
export const LOCK_NOT_AVAILABLE = '55P03';
export const QUERY_CANCELED = '57014';

const TIMEOUT_CODES = [LOCK_NOT_AVAILABLE, QUERY_CANCELED, IDLE_IN_TRANSACTION_TIMEOUT];

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

export function isDatabaseTimeout(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code !== undefined && TIMEOUT_CODES.includes(code);
}
