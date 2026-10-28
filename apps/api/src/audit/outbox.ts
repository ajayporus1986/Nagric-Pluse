/**
 * Writes audit events to a module's transactional outbox.
 *
 * Call this with the SAME client/transaction as the business change. If the
 * audit insert fails, the transaction rolls back and the action does not
 * happen (NP-AUDIT-0002): there is no such thing as an unaudited change.
 */
import type pg from 'pg';
import type { Decision } from '@np/shared';
import { AppError } from '../core/errors.js';

/** Schemas that own an audit_outbox table. */
export type OutboxSchema = 'platform' | 'iam' | 'registry' | 'citizen' | 'org' | 'intake' | 'case' | 'accountability';

/** One audit event. Never put secrets or raw personal data in `detail`. */
export interface AuditEvent {
  /** Dotted action name, e.g. iam.login.failure. */
  action: string;
  actorId?: string | null;
  actorRoles?: string[];
  featureCode?: string | null;
  /** Scope path (ltree text) the action applies to. */
  scopePath?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  decision?: Decision | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

/** Inserts the event into <schema>.audit_outbox using the caller's transaction. */
export async function writeAudit(client: pg.PoolClient, schema: OutboxSchema, ev: AuditEvent): Promise<void> {
  // The schema name comes from a closed union, never from user input, so the
  // identifier interpolation below cannot be injected.
  const table =
    schema === 'platform' ? 'platform.audit_outbox'
    : schema === 'iam' ? 'iam.audit_outbox'
    : schema === 'registry' ? 'registry.audit_outbox'
    : schema === 'org' ? 'org.audit_outbox'
    : schema === 'intake' ? 'intake.audit_outbox'
    : schema === 'case' ? '"case".audit_outbox' // "case" is a reserved SQL keyword and must stay quoted
    : schema === 'accountability' ? 'accountability.audit_outbox'
    : 'citizen.audit_outbox';
  try {
    await client.query(
      `INSERT INTO ${table} (actor_id, actor_roles, action, feature_code, scope_path, target_type, target_id, decision, ip, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ev.actorId ?? null,
        ev.actorRoles ?? [],
        ev.action,
        ev.featureCode ?? null,
        ev.scopePath ?? null,
        ev.targetType ?? null,
        ev.targetId ?? null,
        ev.decision ?? null,
        ev.ip ?? null,
        ev.detail ?? {}
      ]
    );
  } catch (e) {
    // Re-throw as a specific code so the log shows that auditing, not the action, failed.
    throw new AppError('NP-AUDIT-0002', { action: ev.action, reason: (e as Error).message }, { cause: e });
  }
}
