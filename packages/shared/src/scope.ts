/**
 * Scope levels of the LGD-based jurisdiction tree (v2 §3.6, §10.4).
 * AUTHORITY covers statutory development authorities (e.g. Noida Authority, YEIDA)
 * that govern areas outside municipal bodies.
 */
export const SCOPE_LEVELS = [
  'NATION',
  'STATE',
  'DISTRICT',
  'SUBDISTRICT',
  'BLOCK',
  'URBAN_BODY',
  'AUTHORITY',
  'WARD',
  'VILLAGE'
] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** ltree labels allow [A-Za-z0-9_]; node ids follow the same rule so paths can be built from them. */
export const SCOPE_NODE_ID = /^[A-Za-z0-9_]{1,64}$/;

export interface ScopeNode {
  id: string;
  parentId: string | null;
  level: ScopeLevel;
  lgdCode: string | null;
  nameEn: string;
  nameHi: string;
  /** Ancestor ids from the root down to and including this node. */
  path: string[];
}

/** True when `ancestorPath` is the same node as, or an ancestor of, the node at `path`. */
export function isAncestorOrSelf(ancestorPath: readonly string[], path: readonly string[]): boolean {
  if (ancestorPath.length > path.length) return false;
  for (let i = 0; i < ancestorPath.length; i++) {
    if (ancestorPath[i] !== path[i]) return false;
  }
  return true;
}
