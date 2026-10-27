import { describe, expect, it } from 'vitest';
import { validateManifestSet } from '@np/shared';
import { buildSnapshot, capabilityMap, decide, impactPreview, type Principal, type SnapshotRows } from './index.js';

const IN = ['IN'];
const GBN = ['IN', 'UP', 'D144'];
const NOIDA = ['IN', 'UP', 'D144', 'AUTH_NOIDA'];
const DADRI = ['IN', 'UP', 'D144', 'SUB_742'];
const OTHER = ['IN', 'UP', 'D145'];

const manifests = validateManifestSet([
  {
    id: 'grievance',
    version: '1.0.0',
    name: { en: 'Grievances', hi: 'शिकायतें' },
    realm: 'CITIZEN',
    invariant: true,
    features: [
      {
        code: 'grievance.intake',
        name: { en: 'Intake', hi: 'प्राप्ति' },
        actions: ['create', 'view'],
        invariant: true,
        defaultGrants: { CITIZEN_ANONYMOUS: ['create'], OFFICER: ['view'] }
      }
    ]
  },
  {
    id: 'works',
    version: '1.0.0',
    name: { en: 'Works', hi: 'कार्य' },
    realm: 'GOVERNMENT',
    requires: ['grievance'],
    features: [
      {
        code: 'works.projects',
        name: { en: 'Projects', hi: 'परियोजनाएँ' },
        actions: ['view', 'create', 'approve'],
        auditedActions: ['approve'],
        defaultGrants: { OFFICER: ['view', 'create'], OFFICE_HEAD: ['view', 'approve'] }
      },
      { code: 'works.tenders', name: { en: 'Tenders', hi: 'निविदा' }, actions: ['view'], defaultGrants: { OFFICER: ['view'] } }
    ]
  },
  {
    id: 'party',
    version: '1.0.0',
    name: { en: 'Party', hi: 'दल' },
    realm: 'PARTY',
    defaultEnabled: false,
    features: [{ code: 'party.outreach', name: { en: 'Outreach', hi: 'संपर्क' }, actions: ['view'], defaultGrants: { PARTY_WORKER: ['view'] } }]
  },
  {
    id: 'analytics',
    version: '1.0.0',
    name: { en: 'Analytics', hi: 'विश्लेषण' },
    realm: 'GOVERNMENT',
    requires: ['works'],
    features: [{ code: 'analytics.dash', name: { en: 'Dashboard', hi: 'डैशबोर्ड' }, actions: ['view'], defaultGrants: { OFFICER: ['view'] } }]
  }
]);

function rows(over: Partial<SnapshotRows> = {}): SnapshotRows {
  return { manifests, moduleSettings: [], featureSettings: [], realmSettings: [], permissions: [], killSwitches: [], ...over };
}
const officer = (path: string[], mfa = true): Principal => ({ userId: 'u1', mfaVerified: mfa, assignments: [{ role: 'OFFICER', path }] });

describe('availability', () => {
  it('modules on by default are available everywhere', () => {
    const s = buildSnapshot(rows());
    expect(decide(officer(GBN), 'works.projects', 'view', NOIDA, s).decision).toBe('ALLOW');
  });

  it('a DISABLED at an ancestor is a ceiling a lower ENABLED cannot lift', () => {
    const s = buildSnapshot(
      rows({
        moduleSettings: [
          { nodeId: 'D144', moduleId: 'works', state: 'DISABLED' },
          { nodeId: 'AUTH_NOIDA', moduleId: 'works', state: 'ENABLED' }
        ]
      })
    );
    const r = decide(officer(GBN), 'works.projects', 'view', NOIDA, s);
    expect(r.decision).toBe('BLOCK');
    expect(r.trace.some((t) => t.detail.includes('disabled at D144'))).toBe(true);
  });

  it('disabling a sub-node leaves siblings alone', () => {
    const s = buildSnapshot(rows({ moduleSettings: [{ nodeId: 'AUTH_NOIDA', moduleId: 'works', state: 'DISABLED' }] }));
    expect(decide(officer(GBN), 'works.projects', 'view', NOIDA, s).decision).toBe('BLOCK');
    expect(decide(officer(GBN), 'works.projects', 'view', DADRI, s).decision).toBe('ALLOW');
  });

  it('off-by-default modules need an explicit ENABLED on the path', () => {
    const worker: Principal = { userId: 'p', mfaVerified: true, assignments: [{ role: 'PARTY_WORKER', path: GBN }] };
    expect(decide(worker, 'party.outreach', 'view', GBN, buildSnapshot(rows())).decision).toBe('BLOCK');
    const s = buildSnapshot(rows({ moduleSettings: [{ nodeId: 'D144', moduleId: 'party', state: 'ENABLED' }] }));
    expect(decide(worker, 'party.outreach', 'view', NOIDA, s).decision).toBe('ALLOW');
    expect(decide(worker, 'party.outreach', 'view', OTHER, s).decision).toBe('BLOCK');
  });

  it('a feature can be disabled while its module stays on', () => {
    const s = buildSnapshot(rows({ featureSettings: [{ nodeId: 'UP', featureCode: 'works.tenders', state: 'DISABLED' }] }));
    expect(decide(officer(GBN), 'works.tenders', 'view', GBN, s).decision).toBe('BLOCK');
    expect(decide(officer(GBN), 'works.projects', 'view', GBN, s).decision).toBe('ALLOW');
  });

  it('dependencies propagate: disabling works disables analytics', () => {
    const s = buildSnapshot(rows({ moduleSettings: [{ nodeId: 'D144', moduleId: 'works', state: 'DISABLED' }] }));
    const r = decide(officer(GBN), 'analytics.dash', 'view', GBN, s);
    expect(r.decision).toBe('BLOCK');
    expect(r.trace.some((t) => t.step === 'requires')).toBe(true);
  });

  it('invariant features cannot be disabled by module, feature or realm settings', () => {
    const s = buildSnapshot(
      rows({
        moduleSettings: [{ nodeId: 'IN', moduleId: 'grievance', state: 'DISABLED' }],
        featureSettings: [{ nodeId: 'IN', featureCode: 'grievance.intake', state: 'DISABLED' }],
        killSwitches: [{ moduleId: 'grievance', path: IN, expiresAt: new Date(Date.now() + 3600_000) }]
      })
    );
    const anon: Principal = { userId: 'a', mfaVerified: false, assignments: [{ role: 'CITIZEN_ANONYMOUS', path: GBN }] };
    expect(decide(anon, 'grievance.intake', 'create', NOIDA, s).decision).toBe('ALLOW');
  });

  it('invariants do not grant authorization', () => {
    const anon: Principal = { userId: 'a', mfaVerified: false, assignments: [{ role: 'CITIZEN_ANONYMOUS', path: GBN }] };
    expect(decide(anon, 'grievance.intake', 'view', GBN, buildSnapshot(rows())).decision).toBe('BLOCK');
  });

  it('kill switch blocks until it expires', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    const s = buildSnapshot(rows({ killSwitches: [{ moduleId: 'works', path: GBN, expiresAt: new Date('2026-11-01T12:00:00Z') }] }));
    expect(decide(officer(GBN), 'works.projects', 'view', NOIDA, s, { now }).decision).toBe('BLOCK');
    expect(decide(officer(GBN), 'works.projects', 'view', NOIDA, s, { now: new Date('2026-11-02T00:00:00Z') }).decision).toBe('ALLOW');
  });

  it('realm switch turns off modules and roles of that realm', () => {
    const s = buildSnapshot(
      rows({
        moduleSettings: [{ nodeId: 'D144', moduleId: 'party', state: 'ENABLED' }],
        realmSettings: [{ nodeId: 'D144', realm: 'PARTY', state: 'DISABLED' }]
      })
    );
    const worker: Principal = { userId: 'p', mfaVerified: true, assignments: [{ role: 'PARTY_WORKER', path: GBN }] };
    expect(decide(worker, 'party.outreach', 'view', GBN, s).decision).toBe('BLOCK');
  });

  it('unknown feature and unknown action are blocked', () => {
    const s = buildSnapshot(rows());
    expect(decide(officer(GBN), 'nope.x', 'view', GBN, s).decision).toBe('BLOCK');
    expect(decide(officer(GBN), 'works.tenders', 'delete', GBN, s).decision).toBe('BLOCK');
  });
});

describe('authorization', () => {
  it('role assigned lower in the tree does not reach upward or sideways', () => {
    const s = buildSnapshot(rows());
    expect(decide(officer(NOIDA), 'works.projects', 'view', GBN, s).decision).toBe('BLOCK');
    expect(decide(officer(NOIDA), 'works.projects', 'view', DADRI, s).decision).toBe('BLOCK');
    expect(decide(officer(GBN), 'works.projects', 'view', OTHER, s).decision).toBe('BLOCK');
  });

  it('staff roles grant nothing before the second factor', () => {
    const s = buildSnapshot(rows());
    expect(decide(officer(GBN, false), 'works.projects', 'view', GBN, s).decision).toBe('BLOCK');
  });

  it('audited actions return ALLOW_AUDITED', () => {
    const head: Principal = { userId: 'h', mfaVerified: true, assignments: [{ role: 'OFFICE_HEAD', path: GBN }] };
    expect(decide(head, 'works.projects', 'approve', GBN, buildSnapshot(rows())).decision).toBe('ALLOW_AUDITED');
  });

  it('nearest permission override wins over the manifest default and over higher overrides', () => {
    const s = buildSnapshot(
      rows({
        permissions: [
          { nodeId: 'UP', featureCode: 'works.projects', role: 'OFFICER', actions: [] },
          { nodeId: 'AUTH_NOIDA', featureCode: 'works.projects', role: 'OFFICER', actions: ['view'] }
        ]
      })
    );
    expect(decide(officer(GBN), 'works.projects', 'view', DADRI, s).decision).toBe('BLOCK');
    expect(decide(officer(GBN), 'works.projects', 'view', NOIDA, s).decision).toBe('ALLOW');
    expect(decide(officer(GBN), 'works.projects', 'create', NOIDA, s).decision).toBe('BLOCK');
  });

  it('most permissive role among the covering assignments wins', () => {
    const p: Principal = {
      userId: 'x',
      mfaVerified: true,
      assignments: [
        { role: 'OFFICER', path: GBN },
        { role: 'OFFICE_HEAD', path: NOIDA }
      ]
    };
    const s = buildSnapshot(rows());
    expect(decide(p, 'works.projects', 'approve', NOIDA, s).decision).toBe('ALLOW_AUDITED');
    expect(decide(p, 'works.projects', 'approve', DADRI, s).decision).toBe('BLOCK');
  });

  it('election overlay can only tighten', () => {
    const s = buildSnapshot(rows());
    const overlay = () => ({ decision: 'LIMIT' as const, reason: 'MCC in force' });
    expect(decide(officer(GBN), 'works.projects', 'create', GBN, s, { overlay }).decision).toBe('LIMIT');
    const anon: Principal = { userId: 'a', mfaVerified: false, assignments: [{ role: 'CITIZEN_ANONYMOUS', path: GBN }] };
    const block = () => ({ decision: 'BLOCK' as const, reason: 'test' });
    expect(decide(anon, 'grievance.intake', 'create', GBN, s, { overlay: block }).decision).toBe('ALLOW');
  });
});

describe('capability map and impact preview', () => {
  it('lists only what the principal may do', () => {
    const map = capabilityMap(officer(GBN), GBN, buildSnapshot(rows()));
    expect(map['works.projects']).toEqual({ view: 'ALLOW', create: 'ALLOW' });
    expect(map['party.outreach']).toBeUndefined();
  });

  it('previews which features change availability', () => {
    const before = buildSnapshot(rows());
    const after = buildSnapshot(rows({ moduleSettings: [{ nodeId: 'D144', moduleId: 'works', state: 'DISABLED' }] }));
    const changes = impactPreview(before, after, [GBN, OTHER]);
    expect(changes.map((c) => `${c.path.at(-1)}:${c.featureCode}`).sort()).toEqual(['D144:analytics.dash', 'D144:works.projects', 'D144:works.tenders']);
  });
});
