/**
 * Structured JSON logging (pino).
 *
 * Every log line carries: time, level, service, and where applicable reqId,
 * userId, errCode. Secrets and personal data are redacted by path so a
 * careless `log.info({ body })` cannot leak a password or OTP.
 */
import pino, { type Logger } from 'pino';

/**
 * Paths removed from every log line. Covers request headers, bodies and
 * common field names. Pino replaces the value with "[REDACTED]".
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.code',
  '*.token',
  '*.csrfToken',
  '*.secret',
  '*.totpSecret',
  '*.otpauthUrl',
  '*.qrDataUrl',
  '*.email',
  '*.oneTimePassword',
  'password',
  'token',
  'secret'
];

/** Creates the root logger for a service (api, worker, cli). */
export function createLogger(service: string, level = 'info'): Logger {
  return pino({
    level,
    base: { service },
    // ISO timestamps are easier to correlate across services than epoch millis.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Error objects are serialised with type, message and stack.
    serializers: { err: pino.stdSerializers.err }
  });
}
