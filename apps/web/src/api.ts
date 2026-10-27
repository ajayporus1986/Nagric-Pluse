/**
 * API client for the console.
 *
 * - Same-origin requests only; the session cookie is HttpOnly and never seen by JS.
 * - The CSRF token is held in memory and sent on every state-changing request.
 * - Every failure becomes an ApiError with a catalogue code, so screens can
 *   show the user a specific message and a reference (request id) for support.
 * - Network failures map to NP-CLIENT-0001; unexpected failures are reported
 *   to /api/v1/client-logs so they reach the server logs.
 */
import { ERRORS, isErrorCode, type ErrorCode, type Locale } from '@np/shared';
import { reportClientError } from './logger';

/** Error thrown by every API call. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly fields?: { path: string; message: string }[]
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Current CSRF token (set after sign-in or on loading the session). */
let csrfToken: string | null = null;
export function setCsrf(token: string | null): void {
  csrfToken = token;
}

/** Called when the server says the session is gone; the app returns to sign-in. */
let onSessionLost: () => void = () => undefined;
export function setSessionLostHandler(fn: () => void): void {
  onSessionLost = fn;
}

/** Codes that mean "you are not signed in any more". */
const SESSION_CODES: ErrorCode[] = ['NP-AUTH-0001', 'NP-SESS-0001', 'NP-SESS-0002', 'NP-AUTH-0004'];

/** Performs a JSON request; throws ApiError on any failure. */
export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, locale: Locale = 'hi'): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', 'accept-language': locale };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    // Network down, DNS, CORS, etc. Logged locally only (the server is unreachable anyway).
    console.warn('NP-CLIENT-0001', path, e);
    throw new ApiError('NP-CLIENT-0001', ERRORS['NP-CLIENT-0001'][locale], 0);
  }
  if (res.status === 204) return undefined as T;

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (res.ok) return data as T;

  // Error body: { error: { code, message, requestId, fields } }.
  const err = (data as { error?: { code?: unknown; message?: string; requestId?: string; fields?: { path: string; message: string }[] } })?.error;
  const code: ErrorCode = isErrorCode(err?.code) ? err.code : 'NP-INT-0001';
  const apiErr = new ApiError(code, err?.message ?? ERRORS[code][locale], res.status, err?.requestId ?? res.headers.get('x-request-id') ?? undefined, err?.fields);
  if (SESSION_CODES.includes(code)) onSessionLost();
  // Server-side faults (5xx) are reported with the request id so logs can be correlated.
  if (res.status >= 500) reportClientError('error', code, `${method} ${path} failed with ${res.status}`, apiErr.requestId);
  throw apiErr;
}

/** Shorthand helpers. */
export const get = <T>(path: string, locale?: Locale) => api<T>('GET', path, undefined, locale);
export const post = <T>(path: string, body?: unknown, locale?: Locale) => api<T>('POST', path, body ?? {}, locale);
