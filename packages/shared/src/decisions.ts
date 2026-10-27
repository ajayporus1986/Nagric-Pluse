/**
 * Policy decision lattice, as defined in the v2 election-control matrix (§10.3).
 * Ordered from most to least restrictive. "Strictest wins" = minimum rank.
 */
export const DECISIONS = ['BLOCK', 'LIMIT', 'ALLOW_AUDITED', 'ALLOW'] as const;
export type Decision = (typeof DECISIONS)[number];

const RANK: Record<Decision, number> = { BLOCK: 0, LIMIT: 1, ALLOW_AUDITED: 2, ALLOW: 3 };

export function decisionRank(d: Decision): number {
  return RANK[d];
}

/** Strictest of the given decisions. An empty list is BLOCK (default deny). */
export function strictest(...ds: Decision[]): Decision {
  if (ds.length === 0) return 'BLOCK';
  return ds.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

/** Most permissive of the given decisions. An empty list is BLOCK (default deny). */
export function mostPermissive(...ds: Decision[]): Decision {
  if (ds.length === 0) return 'BLOCK';
  return ds.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
}

export function isAllowed(d: Decision): boolean {
  return d !== 'BLOCK';
}

export const ACTIONS = ['view', 'create', 'update', 'delete', 'approve', 'export', 'special'] as const;
export type Action = (typeof ACTIONS)[number];
