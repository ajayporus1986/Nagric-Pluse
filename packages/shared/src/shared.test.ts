import { describe, expect, it } from 'vitest';
import {
  ROLES,
  getRole,
  isAncestorOrSelf,
  mostPermissive,
  negotiateLocale,
  strictest,
  validateManifestSet
} from './index.js';

const feat = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  name: { en: code, hi: code },
  actions: ['view', 'create'],
  ...extra
});
const mod = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  version: '1.0.0',
  name: { en: id, hi: id },
  realm: 'GOVERNMENT',
  features: [feat(`${id}.main`)],
  ...extra
});

describe('decision lattice', () => {
  it('strictest picks the most restrictive', () => {
    expect(strictest('ALLOW', 'LIMIT', 'ALLOW_AUDITED')).toBe('LIMIT');
    expect(strictest('ALLOW', 'BLOCK')).toBe('BLOCK');
  });
  it('mostPermissive picks the least restrictive', () => {
    expect(mostPermissive('LIMIT', 'ALLOW_AUDITED')).toBe('ALLOW_AUDITED');
  });
  it('empty lists default to BLOCK', () => {
    expect(strictest()).toBe('BLOCK');
    expect(mostPermissive()).toBe('BLOCK');
  });
});

describe('roles', () => {
  it('codes are unique and every role has Hindi and English names', () => {
    const codes = new Set(ROLES.map((r) => r.code));
    expect(codes.size).toBe(ROLES.length);
    for (const r of ROLES) {
      expect(r.nameEn.length).toBeGreaterThan(0);
      expect(r.nameHi).toMatch(/[ऀ-ॿ]/);
      expect(r.levels.length).toBeGreaterThan(0);
    }
  });
  it('governance and oversight roles are sensitive', () => {
    for (const c of ['REALM_GOVERNOR', 'DATA_PROTECTION_OFFICER', 'PLATFORM_OPERATOR', 'WHISTLE_REVIEWER', 'DISTRICT_MAGISTRATE']) {
      expect(getRole(c)?.sensitive).toBe(true);
    }
  });
});

describe('scope paths', () => {
  it('ancestor-or-self', () => {
    expect(isAncestorOrSelf(['IN', 'UP'], ['IN', 'UP', 'D144'])).toBe(true);
    expect(isAncestorOrSelf(['IN', 'UP', 'D144'], ['IN', 'UP', 'D144'])).toBe(true);
    expect(isAncestorOrSelf(['IN', 'UP', 'D145'], ['IN', 'UP', 'D144'])).toBe(false);
    expect(isAncestorOrSelf(['IN', 'UP', 'D144', 'X'], ['IN', 'UP', 'D144'])).toBe(false);
  });
});

describe('manifests', () => {
  it('orders by dependency', () => {
    const out = validateManifestSet([mod('beta', { requires: ['alpha'] }), mod('alpha')]);
    expect(out.map((m) => m.id)).toEqual(['alpha', 'beta']);
  });
  it('rejects cycles', () => {
    expect(() => validateManifestSet([mod('alpha', { requires: ['beta'] }), mod('beta', { requires: ['alpha'] })])).toThrow(/cycle/);
  });
  it('rejects unknown requirements', () => {
    expect(() => validateManifestSet([mod('alpha', { requires: ['zeta'] })])).toThrow(/unknown module/);
  });
  it('rejects features outside the module namespace', () => {
    expect(() => validateManifestSet([mod('alpha', { features: [feat('beta.x')] })])).toThrow();
  });
  it('rejects grants for actions the feature does not have', () => {
    expect(() => validateManifestSet([mod('alpha', { features: [feat('alpha.x', { defaultGrants: { OFFICER: ['delete'] } })] })])).toThrow();
  });
  it('rejects unknown roles in grants', () => {
    expect(() => validateManifestSet([mod('alpha', { features: [feat('alpha.x', { defaultGrants: { WIZARD: ['view'] } })] })])).toThrow();
  });
  it('invariant modules cannot depend on switchable ones', () => {
    expect(() => validateManifestSet([mod('alpha'), mod('beta', { invariant: true, requires: ['alpha'] })])).toThrow(/invariant/);
  });
  it('invariant features need an invariant module', () => {
    expect(() => validateManifestSet([mod('alpha', { features: [feat('alpha.x', { invariant: true })] })])).toThrow();
  });
});

describe('locale negotiation', () => {
  it('defaults to Hindi', () => {
    expect(negotiateLocale(undefined)).toBe('hi');
    expect(negotiateLocale('fr-FR')).toBe('hi');
  });
  it('honours quality values', () => {
    expect(negotiateLocale('en-IN;q=0.9,hi;q=0.8')).toBe('en');
    expect(negotiateLocale('hi-IN,en;q=0.5')).toBe('hi');
  });
});
