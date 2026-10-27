import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrator.js';

const ADMIN_URL = process.env.DATABASE_URL;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');
const dbName = `np_test_${process.pid}_${Date.now()}`;

describe.skipIf(!ADMIN_URL)('migrations and database guarantees', () => {
  let admin: pg.Client;
  let db: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await migrate(db, dir);
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('is idempotent', async () => {
    const r = await migrate(db, dir);
    expect(r.applied).toEqual([]);
  });

  it('derives scope paths from parents and forbids re-parenting', async () => {
    await db.query(`INSERT INTO platform.scope_nodes (id, parent_id, level, name_en, name_hi) VALUES
      ('IN', NULL, 'NATION', 'India', 'भारत'),
      ('UP', 'IN', 'STATE', 'Uttar Pradesh', 'उत्तर प्रदेश'),
      ('D144', 'UP', 'DISTRICT', 'Gautam Buddh Nagar', 'गौतम बुद्ध नगर')`);
    const { rows } = await db.query(`SELECT path::text FROM platform.scope_nodes WHERE id = 'D144'`);
    expect(rows[0].path).toBe('IN.UP.D144');
    await expect(db.query(`UPDATE platform.scope_nodes SET parent_id = 'IN' WHERE id = 'D144'`)).rejects.toThrow(/immutable/);
  });

  it('chains audit rows, verifies them, and refuses edits', async () => {
    for (let i = 0; i < 5; i++) {
      await db.query(`INSERT INTO audit.ledger (event_id, source, occurred_at, action, detail) VALUES (gen_random_uuid(), 'test', now(), 'test.event', $1)`, [{ i, text: 'नमस्ते' }]);
    }
    const v = await db.query('SELECT * FROM audit.verify_chain()');
    expect(v.rows[0]).toMatchObject({ ok: true, checked: '5' });
    await expect(db.query(`UPDATE audit.ledger SET action = 'x' WHERE seq = 2`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit.ledger WHERE seq = 2`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE audit.ledger`)).rejects.toThrow();
  });

  it('detects tampering when triggers are bypassed', async () => {
    // Simulates a superuser editing a row with triggers disabled.
    await db.query('BEGIN');
    await db.query(`SET LOCAL session_replication_role = replica`);
    await db.query(`UPDATE audit.ledger SET detail = '{"i": 99}' WHERE seq = 3`);
    const v = await db.query('SELECT * FROM audit.verify_chain()');
    await db.query('ROLLBACK');
    expect(v.rows[0]).toMatchObject({ ok: false, first_bad_seq: '3' });
  });

  it('refuses ledger inserts outside READ COMMITTED', async () => {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await expect(
      db.query(`INSERT INTO audit.ledger (event_id, source, occurred_at, action) VALUES (gen_random_uuid(), 'test', now(), 'x')`)
    ).rejects.toThrow(/READ COMMITTED/);
    await db.query('ROLLBACK');
  });

  it('enforces quorum of at least two and 24-hour kill switches', async () => {
    await expect(db.query(`UPDATE platform.quorum_config SET required = 1 WHERE level = 'DISTRICT'`)).rejects.toThrow();
    await db.query(`INSERT INTO platform.modules (id, version, manifest) VALUES ('works', '1.0.0', '{}')`);
    await expect(
      db.query(`INSERT INTO platform.kill_switches (module_id, node_id, reason, activated_by, expires_at)
                VALUES ('works', 'D144', 'database overload in works', gen_random_uuid(), now() + interval '25 hours')`)
    ).rejects.toThrow();
  });
});
