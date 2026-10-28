/**
 * API process entry point.
 *
 * Startup order: config → logger → key ring → pools → module registration →
 * policy snapshot → HTTP. Any failure before listening exits with code 1 and a
 * fatal log line carrying its error code, so orchestrators restart cleanly.
 */
import { loadConfig, describeConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { isAppError } from './core/errors.js';
import { closePools, createPools } from './db/pools.js';
import { ConsoleOtpSender, WebhookOtpSender, type OtpSender } from './citizen/otp-sender.js';
import { buildApp } from './http/app.js';
import { ALL_MANIFESTS } from './modules/manifests.js';
import { registerManifests } from './platform/registry.js';
import { PolicyService } from './policy/service.js';
import { registerRoutes } from './routes.js';
import { buildKeyRing } from './security/crypto.js';

const bootLog = createLogger('api', process.env.LOG_LEVEL ?? 'info');

// Last-resort handlers: log with a code, then exit so the orchestrator restarts a clean process.
process.on('unhandledRejection', (err) => {
  bootLog.fatal({ err, errCode: 'NP-INT-0001' }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  bootLog.fatal({ err, errCode: 'NP-INT-0001' }, 'uncaught exception');
  process.exit(1);
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger('api', cfg.LOG_LEVEL);
  log.info({ config: describeConfig(cfg) }, 'starting');

  const ring = buildKeyRing(cfg.FIELD_ENCRYPTION_KEYS, cfg.FIELD_ENCRYPTION_ACTIVE_KEY);
  const pools = createPools(cfg, log);
  await registerManifests(pools.platform, ALL_MANIFESTS, log);
  const policy = new PolicyService(pools.platform, cfg.db.platform, log);
  await policy.start();
  // Chosen once at startup from SMS_PROVIDER; see citizen/otp-sender.ts for why there is no direct gateway SDK.
  const otpSender: OtpSender = cfg.SMS_PROVIDER === 'webhook' ? new WebhookOtpSender(cfg.SMS_WEBHOOK_URL!, cfg.SMS_WEBHOOK_SECRET!, log) : new ConsoleOtpSender(log);

  const app = await buildApp({ cfg, log, pools, policy, ring, otpSender }, registerRoutes);
  await app.listen({ host: cfg.HOST, port: cfg.PORT });

  // Graceful shutdown: stop accepting, finish in-flight requests, close pools.
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.error({ errCode: 'NP-INT-0001' }, 'shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    force.unref();
    await app.close();
    await policy.stop();
    await closePools(pools);
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Startup errors carry their own code (e.g. NP-CFG-0001) when raised by our code.
  bootLog.fatal({ err, errCode: isAppError(err) ? err.code : 'NP-INT-0001', detail: isAppError(err) ? err.detail : undefined }, 'startup failed');
  process.exit(1);
});
