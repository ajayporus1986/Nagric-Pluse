/**
 * Operational endpoints:
 *   GET  /healthz       process is up (no dependencies checked) — for liveness probes
 *   GET  /readyz        database reachable and policy loaded — for readiness probes
 *   POST /client-logs   the web console reports client-side errors here so they
 *                       appear in the server logs with the user's request id
 */
import { z } from 'zod';
import { isErrorCode } from '@np/shared';
import type { App, AppDeps } from './app.js';
import { MemoryRateLimiter } from '../iam/rate-limit.js';
import { AppError } from '../core/errors.js';

export function registerSystemRoutes(app: App, deps: AppDeps): void {
  const { pools, policy } = deps;
  // Client error reports are cheap to send, so cap them hard per IP.
  const clientLogLimiter = new MemoryRateLimiter(30, 60_000);

  app.get('/healthz', { config: { access: { kind: 'public' } } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { config: { access: { kind: 'public' } } }, async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    // Each pool is checked separately so a misconfigured module role shows up by name.
    for (const [name, pool] of Object.entries(pools)) {
      try {
        await pool.query('SELECT 1');
        checks[`db_${name}`] = true;
      } catch {
        checks[`db_${name}`] = false;
      }
    }
    try {
      policy.current();
      checks.policy = true;
    } catch {
      checks.policy = false;
    }
    const ok = Object.values(checks).every(Boolean);
    void reply.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'not_ready', checks };
  });

  app.post(
    '/api/v1/client-logs',
    {
      config: { access: { kind: 'public' } },
      schema: {
        body: z
          .object({
            level: z.enum(['warn', 'error']),
            code: z.string().max(20),
            message: z.string().max(500),
            page: z.string().max(200),
            requestId: z.string().max(64).optional(),
            stack: z.string().max(4000).optional()
          })
          .strict()
      }
    },
    async (req, reply) => {
      if (!clientLogLimiter.hit(req.ip)) throw new AppError('NP-RATE-0001', { limiter: 'client-logs' });
      const b = req.body;
      // Untrusted input: only known codes are kept as codes; text fields are length-capped by the schema.
      req.log[b.level](
        { source: 'web', clientCode: isErrorCode(b.code) ? b.code : 'NP-CLIENT-0002', page: b.page, relatedRequestId: b.requestId, userId: req.auth?.userId, stack: b.stack },
        `client: ${b.message}`
      );
      void reply.status(204);
      return null;
    }
  );
}
