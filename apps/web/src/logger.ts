/**
 * Client-side error reporting. Errors are written to the browser console and
 * sent (best effort, rate-limited by the server) to /api/v1/client-logs so
 * they appear in the server logs next to the related request id.
 *
 * Never include personal data, passwords or codes in reports.
 */
export function reportClientError(level: 'warn' | 'error', code: string, message: string, requestId?: string, stack?: string): void {
  const entry = { level, code, message: message.slice(0, 500), page: location.pathname.slice(0, 200), requestId, stack: stack?.slice(0, 4000) };
  if (level === 'error') console.error(`[${code}]`, message, requestId ? `(request ${requestId})` : '');
  else console.warn(`[${code}]`, message, requestId ? `(request ${requestId})` : '');
  // keepalive lets the report finish even if the page is unloading. Failures are ignored.
  void fetch('/api/v1/client-logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(entry),
    keepalive: true
  }).catch(() => undefined);
}

/** Installs global handlers for uncaught errors and promise rejections. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (e) => reportClientError('error', 'NP-CLIENT-0002', e.message || 'uncaught error', undefined, e.error instanceof Error ? e.error.stack : undefined));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { name?: string; message?: string; stack?: string };
    // ApiErrors are already handled (and reported if 5xx) by the API client.
    if (r?.name === 'ApiError') return;
    reportClientError('error', 'NP-CLIENT-0002', r?.message ?? 'unhandled rejection', undefined, r?.stack);
  });
}
