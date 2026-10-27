/**
 * Application error type. Every failure that should reach a client is thrown
 * as an AppError carrying a catalogue code (see @np/shared ERRORS). Anything
 * else that escapes a handler is treated as NP-INT-0001 by the error handler.
 */
import { ERRORS, type ErrorCode } from '@np/shared';

export class AppError extends Error {
  /** Catalogue code, e.g. NP-AUTH-0002. */
  readonly code: ErrorCode;
  /** HTTP status taken from the catalogue. */
  readonly status: number;
  /**
   * Internal detail for the log only. Never sent to the client.
   * Must not contain secrets or personal data.
   */
  readonly detail: Record<string, unknown>;
  /** Field-level validation messages, safe to show to the user. */
  readonly fields?: { path: string; message: string }[];

  constructor(code: ErrorCode, detail: Record<string, unknown> = {}, opts: { cause?: unknown; fields?: { path: string; message: string }[] } = {}) {
    // The English catalogue message is used as Error.message so stack traces are readable.
    super(ERRORS[code].en, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERRORS[code].http;
    this.detail = detail;
    if (opts.fields) this.fields = opts.fields;
  }
}

/** Narrowing helper used by catch blocks. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Maps low-level Postgres errors to catalogue codes so the client gets a
 * meaningful, specific code and the log keeps the original SQLSTATE.
 * Returns undefined if the error is not a recognised database error.
 */
export function fromPgError(e: unknown): AppError | undefined {
  // pg errors carry a 5-character SQLSTATE in `code`.
  const err = e as { code?: unknown; message?: unknown; constraint?: unknown };
  if (typeof err?.code !== 'string' || err.code.length !== 5) {
    // Connection-level failures from node-postgres have no SQLSTATE.
    const msg = String(err?.message ?? '');
    if (/ECONNREFUSED|ENOTFOUND|Connection terminated|timeout exceeded when trying to connect/i.test(msg)) {
      return new AppError('NP-DB-0001', { reason: msg }, { cause: e });
    }
    return undefined;
  }
  const detail = { sqlstate: err.code, constraint: err.constraint };
  switch (err.code) {
    case '57014': // query_canceled (statement_timeout)
      return new AppError('NP-DB-0002', detail, { cause: e });
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new AppError('NP-DB-0003', detail, { cause: e });
    case '23505': // unique_violation
    case '23503': // foreign_key_violation
    case '23514': // check_violation
    case '23502': // not_null_violation
      return new AppError('NP-DB-0004', detail, { cause: e });
    case '08000':
    case '08003':
    case '08006':
    case '57P01': // admin_shutdown
    case '57P03': // cannot_connect_now
      return new AppError('NP-DB-0001', detail, { cause: e });
    default:
      return undefined;
  }
}
