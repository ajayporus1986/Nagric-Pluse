/**
 * Delivers an OTP to a citizen's mobile number.
 *
 * No SMS gateway account or credentials exist for this project, and none are
 * fabricated here: that would mean inventing a vendor integration this
 * project has not actually set up, which is exactly the kind of unverifiable
 * detail this codebase avoids (see the registry module's notes on GB Nagar's
 * still-missing office list for the same policy).
 *
 * Instead this is a small, genuinely working extension point:
 *   - "console": logs the OTP at warn level, clearly labelled as a stub.
 *     Refused outside development/test (SMS_PROVIDER cannot be "console" in
 *     production — see core/config.ts) so a real deployment cannot silently
 *     ship with OTPs only visible in logs.
 *   - "webhook": HTTPS POSTs an HMAC-signed, timestamped payload to a URL the
 *     operator configures (NP_SMS_WEBHOOK_URL / NP_SMS_WEBHOOK_SECRET). That
 *     endpoint is the operator's own integration with whichever SMS gateway
 *     they actually hold an account with; this code never talks to a gateway
 *     directly, so no gateway-specific SDK or credential format is guessed.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '../core/errors.js';

export interface OtpSender {
  /** mobile: E.164-ish normalised number, e.g. "+919876543210". Never logs the OTP itself outside the console sender. */
  send(mobile: string, otp: string, purpose: 'LOGIN'): Promise<void>;
}

/** Development/test only: logs the OTP instead of sending it. Refused in production (see core/config.ts). */
export class ConsoleOtpSender implements OtpSender {
  constructor(private readonly log: Logger) {}
  async send(mobile: string, otp: string, purpose: 'LOGIN'): Promise<void> {
    this.log.warn({ mobileMasked: maskMobile(mobile), purpose, stub: true }, `[dev-only stub] OTP for ${maskMobile(mobile)} is ${otp} (not actually sent as SMS)`);
  }
}

/**
 * Posts the OTP to an operator-configured webhook, which is expected to be
 * the operator's own bridge into their SMS gateway of choice. The body is
 * signed (HMAC-SHA256 over "<timestamp>.<body>") so the receiving endpoint
 * can reject forged or replayed deliveries.
 */
export class WebhookOtpSender implements OtpSender {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly log: Logger
  ) {}

  async send(mobile: string, otp: string, purpose: 'LOGIN'): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ mobile, otp, purpose, requestId: randomUUID() });
    const signature = createHmac('sha256', this.secret).update(`${timestamp}.${body}`).digest('hex');
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-np-timestamp': timestamp, 'x-np-signature': signature },
        body,
        signal: AbortSignal.timeout(10_000)
      });
    } catch (e) {
      this.log.error({ err: e, errCode: 'NP-CIT-0009' }, 'SMS webhook unreachable');
      throw new AppError('NP-CIT-0009', { reason: 'sms webhook unreachable' }, { cause: e });
    }
    if (!res.ok) {
      this.log.error({ status: res.status, errCode: 'NP-CIT-0009' }, 'SMS webhook rejected the delivery');
      throw new AppError('NP-CIT-0009', { reason: `sms webhook returned ${res.status}` });
    }
  }
}

/** Masks all but the last 2 digits of a mobile number, for safe logging. */
function maskMobile(mobile: string): string {
  return mobile.length <= 2 ? mobile : `${'x'.repeat(mobile.length - 2)}${mobile.slice(-2)}`;
}
