/**
 * End-to-end API tests against a real Postgres, using real per-module login
 * roles (so the least-privilege grants are exercised, not bypassed).
 *
 * Requires DATABASE_URL pointing at a superuser on a disposable server
 * (CI service container or local dev). Skipped otherwise.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateManifestSet } from '@np/shared';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createPools, closePools, type Pools } from './db/pools.js';
import { migrate } from './db/migrator.js';
import { buildApp, type App } from './http/app.js';
import { ALL_MANIFESTS } from './modules/manifests.js';
import { registerManifests } from './platform/registry.js';
import { PolicyService } from './policy/service.js';
import { registerRoutes } from './routes.js';
import { buildKeyRing, encryptField, hashPassword, type KeyRing } from './security/crypto.js';
import { generateTotpSecret, totpAt } from './security/totp.js';
import { expireRecords, relayAudit, signCheckpointIfDue } from './worker/jobs.js';
import { keyIdOf } from './audit/checkpoint.js';

const ADMIN_URL = process.env.DATABASE_URL;
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const tag = `${process.pid}_${Date.now()}`;
const dbName = `np_api_${tag}`;
const PW = 'Correct-Horse-Battery-2026';

/** A non-invariant demo module so switching and kill switches can be tested. */
const DEMO = validateManifestSet([
  ...ALL_MANIFESTS,
  {
    id: 'demo', version: '1.0.0', name: { en: 'Demo', hi: 'डेमो' }, realm: 'GOVERNMENT',
    features: [{ code: 'demo.items', name: { en: 'Items', hi: 'वस्तुएँ' }, actions: ['view', 'create'], defaultGrants: { OBSERVER: ['view'] } }]
  }
]);

describe.skipIf(!ADMIN_URL)('API (integration)', () => {
  let admin: pg.Client;
  let ownerUrl: string;
  let roleUrl: (role: string) => string;
  let pools: Pools;
  let relayPool: pg.Pool;
  let policy: PolicyService;
  let app: App;
  let ring: KeyRing;
  const secrets = new Map<string, string>();
  const ids = new Map<string, string>();

  /** Creates a ready-to-use staff user (password set, authenticator enrolled) with roles. */
  async function seedUser(owner: pg.Client, username: string, roles: [string, string][]) {
    const secret = generateTotpSecret();
    const r = await owner.query<{ id: string }>(
      `INSERT INTO iam.users (username, display_name, password_hash, must_change_password, totp_enrolled_at) VALUES ($1, $3, $2, false, now()) RETURNING id`,
      [username, await hashPassword(PW), username]
    );
    const id = r.rows[0]!.id;
    await owner.query('UPDATE iam.users SET totp_secret_enc = $2 WHERE id = $1', [id, encryptField(ring, secret, `iam.users.totp_secret:${id}`)]);
    for (const [role, node] of roles) await owner.query('INSERT INTO iam.role_assignments (user_id, role, node_id) VALUES ($1, $2, $3)', [id, role, node]);
    secrets.set(username, secret);
    ids.set(username, id);
  }

  /** Extracts the session cookie pair from a response. */
  function cookieOf(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [raw];
    const c = list.find((x) => typeof x === 'string' && x.startsWith('np_session=')) as string;
    return c.split(';')[0]!;
  }

  /**
   * Full sign-in (password + TOTP) for a seeded user. Replay protection rejects a
   * second use of the same 30-second code, so the test clears the user's last-used
   * step first (tests sign the same user in several times within one window).
   */
  async function signIn(username: string): Promise<{ cookie: string; csrf: string }> {
    const o = new pg.Client({ connectionString: ownerUrl });
    await o.connect();
    await o.query('UPDATE iam.users SET totp_last_step = NULL WHERE username = $1', [username]);
    await o.end();
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: PW } });
    expect(r1.statusCode, r1.body).toBe(200);
    const c1 = cookieOf(r1);
    const r2 = await app.inject({
      method: 'POST', url: '/api/v1/auth/mfa/verify', headers: { cookie: c1, 'x-csrf-token': r1.json().csrfToken },
      payload: { code: totpAt(secrets.get(username)!, Date.now()) }
    });
    expect(r2.statusCode, r2.body).toBe(200);
    return { cookie: cookieOf(r2), csrf: r2.json().csrfToken };
  }

  /** Authenticated request helper. */
  const call = (s: { cookie: string; csrf: string }, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    ownerUrl = u.toString();
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    await migrate(owner, MIGRATIONS);

    // Real login roles per module, each inheriting only its group role.
    const loginPw = randomBytes(12).toString('hex');
    for (const [suffix, group] of [['platform', 'np_platform_rw'], ['iam', 'np_iam_rw'], ['audit', 'np_audit_reader'], ['relay', 'np_audit_relay']]) {
      await admin.query(`CREATE ROLE np_t_${suffix}_${tag} LOGIN PASSWORD '${loginPw}' IN ROLE ${group}`);
    }
    roleUrl = (suffix: string) => {
      const x = new URL(ownerUrl);
      x.username = `np_t_${suffix}_${tag}`;
      x.password = loginPw;
      return x.toString();
    };

    ring = buildKeyRing([`v1:${randomBytes(32).toString('base64')}`], 'v1');
    await owner.query(`INSERT INTO platform.scope_nodes (id, parent_id, level, lgd_code, name_en, name_hi) VALUES
      ('IN', NULL, 'NATION', NULL, 'India', 'भारत'), ('UP', 'IN', 'STATE', '9', 'Uttar Pradesh', 'उत्तर प्रदेश'),
      ('D144', 'UP', 'DISTRICT', '144', 'Gautam Buddha Nagar', 'गौतम बुद्ध नगर'),
      ('SUB_A', 'D144', 'SUBDISTRICT', NULL, 'Tehsil A', 'तहसील ए'), ('SUB_B', 'D144', 'SUBDISTRICT', NULL, 'Tehsil B', 'तहसील बी')`);
    for (const g of ['gov1', 'gov2', 'gov3']) await seedUser(owner, g, [['REALM_GOVERNOR', 'D144']]);
    await seedUser(owner, 'sre1', [['PLATFORM_OPERATOR', 'D144']]);
    await seedUser(owner, 'obs1', [['OBSERVER', 'D144']]);
    await owner.end();

    const cfg = loadConfig({
      NODE_ENV: 'test', LOG_LEVEL: (process.env.TEST_LOG_LEVEL as string) ?? 'fatal', PUBLIC_ORIGIN: 'http://localhost:5173', COOKIE_SECURE: 'false',
      DATABASE_URL_PLATFORM: roleUrl('platform'), DATABASE_URL_IAM: roleUrl('iam'), DATABASE_URL_AUDIT: roleUrl('audit'),
      FIELD_ENCRYPTION_KEYS: `v1:${ring.keys.get('v1')!.toString('base64')}`, FIELD_ENCRYPTION_ACTIVE_KEY: 'v1'
    });
    const log = createLogger('api-test', cfg.LOG_LEVEL);
    pools = createPools(cfg, log);
    relayPool = new pg.Pool({ connectionString: roleUrl('relay'), max: 2 });
    await registerManifests(pools.platform, DEMO, log);
    policy = new PolicyService(pools.platform, cfg.db.platform, log);
    await policy.start();
    app = await buildApp({ cfg, log, pools, policy, ring }, registerRoutes);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await policy?.stop();
    if (pools) await closePools(pools);
    await relayPool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    for (const s of ['platform', 'iam', 'audit', 'relay']) await admin.query(`DROP ROLE IF EXISTS np_t_${s}_${tag}`);
    await admin.end();
  });

  it('serves health and readiness with every module role connected', async () => {
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    const r = await app.inject('/readyz');
    expect(r.statusCode, r.body).toBe(200);
  });

  it('refuses to register a route without an access declaration', async () => {
    const log = createLogger('x', 'fatal');
    await expect(
      buildApp({ cfg: loadConfig({ NODE_ENV: 'test', DATABASE_URL: ownerUrl, PUBLIC_ORIGIN: 'http://x.test', FIELD_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`, FIELD_ENCRYPTION_ACTIVE_KEY: 'v1' }), log, pools, policy, ring }, (a) => {
        a.get('/oops', async () => 'x');
      })
    ).rejects.toMatchObject({ code: 'NP-CFG-0004' });
  });

  it('returns catalogue error codes with request ids', async () => {
    const r = await app.inject('/api/v1/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatchObject({ code: 'NP-HTTP-0001' });
    expect(r.json().error.requestId).toBe(r.headers['x-request-id']);
    const v = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: '' } });
    expect(v.json().error.code).toBe('NP-VAL-0001');
    expect(v.json().error.fields).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'username' }), expect.objectContaining({ path: 'password' })]));
    const hi = await app.inject({ url: '/api/v1/modules?nodeId=D144', headers: { 'accept-language': 'hi-IN' } });
    expect(hi.json().error).toMatchObject({ code: 'NP-AUTH-0001', message: 'कृपया साइन इन करें।' });
  });

  it('walks a new account through password change, authenticator enrolment and verification', async () => {
    const s = await signIn('gov1');
    const created = await call(s, 'POST', '/api/v1/users', { nodeId: 'D144', username: 'newuser', displayName: 'नया उपयोगकर्ता' });
    expect(created.statusCode, created.body).toBe(201);
    ids.set('newuser', created.json().id);
    const otp = created.json().oneTimePassword as string;

    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'newuser', password: otp } });
    expect(l.json().next).toBe('CHANGE_PASSWORD');
    const c = { cookie: cookieOf(l), csrf: l.json().csrfToken };
    // Nothing else is reachable until the flow completes.
    expect((await call(c, 'GET', '/api/v1/capabilities?nodeId=D144')).json().error.code).toBe('NP-AUTH-0005');
    expect((await call(c, 'POST', '/api/v1/auth/password', { currentPassword: otp, newPassword: 'short' })).json().error.code).toBe('NP-AUTH-0006');
    const pw = await call(c, 'POST', '/api/v1/auth/password', { currentPassword: otp, newPassword: PW });
    expect(pw.json().next).toBe('MFA_ENROLL');
    const start = await call(c, 'POST', '/api/v1/auth/mfa/enroll/start');
    expect(start.json().qrDataUrl).toMatch(/^data:image\/png;base64,/);
    secrets.set('newuser', start.json().secret);
    expect((await call(c, 'POST', '/api/v1/auth/mfa/enroll/confirm', { code: '000000' })).json().error.code).toBe('NP-MFA-0003');
    const ok = await call(c, 'POST', '/api/v1/auth/mfa/enroll/confirm', { code: totpAt(start.json().secret, Date.now()) });
    expect(ok.json().next).toBe('READY');
    // The pre-MFA session token is dead; the upgraded one works.
    expect((await call(c, 'GET', '/api/v1/auth/session')).json().error.code).toBe('NP-SESS-0002');
    const s2 = await call({ cookie: cookieOf(ok), csrf: ok.json().csrfToken }, 'GET', '/api/v1/auth/session');
    expect(s2.json().next).toBe('READY');
  });

  it('rate-limits repeated failed sign-ins per account', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'obs1', password: 'wrong-password!' } })).statusCode;
    }
    expect(last).toBe(429);
    await admin.query('SELECT 1'); // keep connection alive
    const o = new pg.Client({ connectionString: ownerUrl });
    await o.connect();
    await o.query('DELETE FROM iam.rate_limits');
    await o.query('UPDATE iam.users SET failed_logins = 0, locked_until = NULL');
    await o.end();
  });

  it('rejects a reused authenticator code (replay)', async () => {
    await signIn('gov3');
    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'gov3', password: PW } });
    const again = await app.inject({
      method: 'POST', url: '/api/v1/auth/mfa/verify', headers: { cookie: cookieOf(l), 'x-csrf-token': l.json().csrfToken },
      payload: { code: totpAt(secrets.get('gov3')!, Date.now()) }
    });
    expect(again.json().error.code).toBe('NP-MFA-0003');
  });

  it('enforces CSRF tokens and same-origin requests', async () => {
    const s = await signIn('gov2');
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: s.cookie } });
    expect(noCsrf.json().error.code).toBe('NP-CSRF-0001');
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://evil.example' } });
    expect(foreign.json().error.code).toBe('NP-CSRF-0002');
  });

  it('applies role permissions per scope', async () => {
    const obs = await signIn('obs1');
    expect((await call(obs, 'GET', '/api/v1/change-requests?nodeId=D144')).statusCode).toBe(200);
    const create = await call(obs, 'POST', '/api/v1/change-requests', { nodeId: 'D144', kind: 'MODULE_SETTING', payload: { moduleId: 'demo', state: 'DISABLED' }, reason: 'observer should not be able to do this' });
    expect(create.json().error.code).toBe('NP-POL-0001');
    // Observer at D144 cannot see above its scope.
    expect((await call(obs, 'GET', '/api/v1/change-requests?nodeId=UP')).json().error.code).toBe('NP-POL-0001');
    const caps = (await call(obs, 'GET', '/api/v1/capabilities?nodeId=SUB_A')).json().capabilities;
    expect(caps['demo.items']).toEqual({ view: 'ALLOW' });
  });

  it('runs a quorum change request with impact preview, and switches a module off below the district', async () => {
    const g1 = await signIn('gov3');
    const g2 = await signIn('gov2');
    const p = await call(g1, 'POST', '/api/v1/change-requests', { nodeId: 'SUB_A', kind: 'MODULE_SETTING', payload: { moduleId: 'demo', state: 'DISABLED' }, reason: 'pilot paused in tehsil A' });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json().impact.lines).toEqual([{ featureCode: 'demo.items', from: true, to: false, nodes: 1, sample: ['SUB_A'] }]);
    const id = p.json().id as string;
    // Duplicate pending proposal for the same target is refused.
    const dup = await call(g2, 'POST', '/api/v1/change-requests', { nodeId: 'SUB_A', kind: 'MODULE_SETTING', payload: { moduleId: 'demo', state: 'ENABLED' }, reason: 'conflicting proposal here' });
    expect(dup.json().error.code).toBe('NP-CR-0009');
    expect((await call(g1, 'POST', `/api/v1/change-requests/${id}/votes`, { verdict: 'APPROVE' })).json().error.code).toBe('NP-CR-0003');
    const v = await call(g2, 'POST', `/api/v1/change-requests/${id}/votes`, { verdict: 'APPROVE' });
    expect(v.json().status, v.body).toBe('APPLIED');
    const mods = (await call(g1, 'GET', '/api/v1/modules?nodeId=SUB_A')).json().modules;
    expect(mods.find((m: { id: string }) => m.id === 'demo').features[0].available).toBe(false);
    const sibling = (await call(g1, 'GET', '/api/v1/modules?nodeId=SUB_B')).json().modules;
    expect(sibling.find((m: { id: string }) => m.id === 'demo').features[0].available).toBe(true);
    const obs = await signIn('obs1');
    expect((await call(obs, 'GET', '/api/v1/capabilities?nodeId=SUB_A')).json().capabilities['demo.items']).toBeUndefined();
  });

  it('refuses to switch off protected modules and self-concerning changes', async () => {
    const g = await signIn('gov1');
    const inv = await call(g, 'POST', '/api/v1/change-requests', { nodeId: 'D144', kind: 'MODULE_SETTING', payload: { moduleId: 'audit', state: 'DISABLED' }, reason: 'trying to turn off audit' });
    expect(inv.json().error.code).toBe('NP-CR-0006');
    const self = await call(g, 'POST', '/api/v1/change-requests', { nodeId: 'D144', kind: 'ROLE_GRANT', payload: { userId: ids.get('gov1'), role: 'OBSERVER' }, reason: 'granting myself more power' });
    expect(self.json().error.code).toBe('NP-CR-0004');
    const lvl = await call(g, 'POST', '/api/v1/change-requests', { nodeId: 'SUB_A', kind: 'ROLE_GRANT', payload: { userId: ids.get('newuser'), role: 'DISTRICT_MAGISTRATE' }, reason: 'DM only at district level' });
    expect(lvl.json().error.code).toBe('NP-SCOPE-0002');
  });

  it('grants a role by quorum and resets credentials by quorum', async () => {
    const g1 = await signIn('gov1');
    const g2 = await signIn('gov2');
    const grant = await call(g1, 'POST', '/api/v1/change-requests', { nodeId: 'D144', kind: 'ROLE_GRANT', payload: { userId: ids.get('newuser'), role: 'OBSERVER' }, reason: 'new district observer' });
    expect(grant.statusCode, grant.body).toBe(201);
    expect((await call(g2, 'POST', `/api/v1/change-requests/${grant.json().id}/votes`, { verdict: 'APPROVE' })).json().status).toBe('APPLIED');
    const nu = await signIn('newuser');
    expect((await call(nu, 'GET', '/api/v1/capabilities?nodeId=D144')).json().capabilities['audit.ledger']).toEqual({ view: 'ALLOW_AUDITED', special: 'ALLOW_AUDITED' });

    const reset = await call(g1, 'POST', '/api/v1/change-requests', { nodeId: 'D144', kind: 'USER_RESET_CREDENTIALS', payload: { userId: ids.get('newuser') }, reason: 'lost phone, reset authenticator' });
    const applied = await call(g2, 'POST', `/api/v1/change-requests/${reset.json().id}/votes`, { verdict: 'APPROVE' });
    expect(applied.json().status).toBe('APPLIED');
    expect(applied.json().oneTimePassword).toHaveLength(20);
    // Existing sessions of the reset account are revoked.
    expect((await call(nu, 'GET', '/api/v1/auth/session')).json().error.code).toBe('NP-SESS-0002');
  });

  it('activates and clears a kill switch, never on protected modules', async () => {
    const sre = await signIn('sre1');
    const bad = await call(sre, 'POST', '/api/v1/kill-switches', { nodeId: 'D144', moduleId: 'iam', reason: 'should never be allowed', hours: 2 });
    expect(bad.json().error.code).toBe('NP-KILL-0001');
    const k = await call(sre, 'POST', '/api/v1/kill-switches', { nodeId: 'D144', moduleId: 'demo', reason: 'database overload from demo', hours: 2 });
    expect(k.statusCode, k.body).toBe(201);
    const obs = await signIn('obs1');
    expect((await call(obs, 'GET', '/api/v1/capabilities?nodeId=SUB_B')).json().capabilities['demo.items']).toBeUndefined();
    expect((await call(sre, 'POST', `/api/v1/kill-switches/${k.json().id}/clear`)).statusCode).toBe(200);
    expect((await call(obs, 'GET', '/api/v1/capabilities?nodeId=SUB_B')).json().capabilities['demo.items']).toEqual({ view: 'ALLOW' });
  });

  it('disables an account immediately and signs it out', async () => {
    const g = await signIn('gov1');
    const o = await signIn('obs1');
    const r = await call(g, 'POST', `/api/v1/users/${ids.get('obs1')}/disable`, { nodeId: 'D144', reason: 'left the department today' });
    expect(r.json().sessionsRevoked).toBeGreaterThan(0);
    expect((await call(o, 'GET', '/api/v1/auth/session')).statusCode).toBe(401);
  });

  it('relays audit events, signs a checkpoint, and verifies the ledger', async () => {
    const moved = await relayAudit(relayPool);
    expect(moved).toBeGreaterThan(10);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const o = new pg.Client({ connectionString: ownerUrl });
    await o.connect();
    await o.query('INSERT INTO audit.signing_keys (key_id, public_key) VALUES ($1, $2)', [keyIdOf(publicKey), publicKey.export({ type: 'spki', format: 'pem' })]);
    await o.end();
    const seq = await signCheckpointIfDue(relayPool, { privateKey, keyId: keyIdOf(publicKey) }, 1, 60_000, createLogger('t', 'fatal'));
    expect(seq).not.toBeNull();

    const g = await signIn('gov1');
    const ev = await call(g, 'GET', '/api/v1/audit/events?nodeId=D144&limit=200');
    const actions = ev.json().events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['iam.login.failure', 'iam.mfa.enrolled', 'platform.change_request.applied', 'platform.kill_switch.activated', 'iam.user.disabled']));
    const v = await call(g, 'POST', '/api/v1/audit/verify', { nodeId: 'D144' });
    expect(v.json()).toMatchObject({ ok: true, checkpointsChecked: 1, errCode: null });
  });

  it('expires stale change requests', async () => {
    const g = await signIn('gov1');
    const p = await call(g, 'POST', '/api/v1/change-requests', { nodeId: 'SUB_B', kind: 'FEATURE_SETTING', payload: { featureCode: 'demo.items', state: 'DISABLED' }, reason: 'will expire in this test' });
    const o = new pg.Client({ connectionString: ownerUrl });
    await o.connect();
    await o.query(`UPDATE platform.change_requests SET proposed_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1`, [p.json().id]);
    await o.end();
    expect((await expireRecords(pools.platform)).changeRequests).toBe(1);
    const g2 = await signIn('gov2');
    expect((await call(g2, 'POST', `/api/v1/change-requests/${p.json().id}/votes`, { verdict: 'APPROVE' })).json().error.code).toBe('NP-CR-0002');
  });
});
