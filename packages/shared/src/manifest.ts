import { z } from 'zod';
import { ACTIONS } from './decisions.js';
import { ROLE_CODES } from './roles.js';
import { REALMS } from './roles.js';

/** Module ids: lower_snake, used as Postgres schema names, so kept short and safe. */
export const MODULE_ID = /^[a-z][a-z0-9_]{1,30}$/;
/** Feature codes: <module>.<feature>, e.g. grievance.intake */
export const FEATURE_CODE = /^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_.]{1,60}$/;

const localized = z.object({ en: z.string().min(1).max(200), hi: z.string().min(1).max(200) }).strict();

const action = z.enum(ACTIONS);
const roleCode = z.string().refine((r) => ROLE_CODES.includes(r), { message: 'unknown role code' });

export const featureSchema = z
  .object({
    code: z.string().regex(FEATURE_CODE),
    name: localized,
    actions: z.array(action).min(1),
    /** Invariant features cannot be made unavailable (v2 §3.7). Authorization still applies. */
    invariant: z.boolean().default(false),
    /** Sensitive actions are logged as ALLOW_AUDITED even when the policy says ALLOW. */
    auditedActions: z.array(action).default([]),
    defaultGrants: z.record(roleCode, z.array(action)).default({})
  })
  .strict()
  .superRefine((f, ctx) => {
    for (const [role, acts] of Object.entries(f.defaultGrants)) {
      for (const a of acts) {
        if (!f.actions.includes(a)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `grant ${role}:${a} is not an action of ${f.code}` });
        }
      }
    }
  });

export const manifestSchema = z
  .object({
    id: z.string().regex(MODULE_ID),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: localized,
    realm: z.enum(REALMS),
    invariant: z.boolean().default(false),
    defaultEnabled: z.boolean().default(true),
    requires: z.array(z.string().regex(MODULE_ID)).default([]),
    features: z.array(featureSchema).min(1)
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const f of m.features) {
      if (!f.code.startsWith(`${m.id}.`)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `feature ${f.code} must start with "${m.id}."` });
      }
      if (seen.has(f.code)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate feature ${f.code}` });
      seen.add(f.code);
      if (f.invariant && !m.invariant) {
        // An invariant feature inside a switchable module would be unreachable when the module is off.
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invariant feature ${f.code} requires an invariant module` });
      }
    }
    if (m.invariant && !m.defaultEnabled) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invariant modules must be enabled by default' });
    }
    if (m.requires.includes(m.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'module cannot require itself' });
  });

export type ModuleManifest = z.output<typeof manifestSchema>;
export type FeatureManifest = z.output<typeof featureSchema>;

/**
 * Validates a set of manifests together: unique ids, known requirements, no
 * dependency cycles, and invariant modules only depend on invariant modules.
 * Returns manifests in dependency order.
 */
export function validateManifestSet(input: unknown[]): ModuleManifest[] {
  const manifests = input.map((m) => manifestSchema.parse(m));
  const byId = new Map<string, ModuleManifest>();
  for (const m of manifests) {
    if (byId.has(m.id)) throw new Error(`duplicate module id ${m.id}`);
    byId.set(m.id, m);
  }
  for (const m of manifests) {
    for (const r of m.requires) {
      const dep = byId.get(r);
      if (!dep) throw new Error(`module ${m.id} requires unknown module ${r}`);
      if (m.invariant && !dep.invariant) throw new Error(`invariant module ${m.id} cannot require switchable module ${r}`);
    }
  }
  const ordered: ModuleManifest[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, chain: string[]): void => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`dependency cycle: ${[...chain, id].join(' -> ')}`);
    state.set(id, 'visiting');
    const m = byId.get(id)!;
    for (const r of m.requires) visit(r, [...chain, id]);
    state.set(id, 'done');
    ordered.push(m);
  };
  for (const m of manifests) visit(m.id, []);
  return ordered;
}
