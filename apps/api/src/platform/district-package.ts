/**
 * District package loader. A district package is a versioned JSON file that
 * describes one district's jurisdiction tree (and, from Phase 1, its offices,
 * posts, service timelines and defaults). Every district runs the same code;
 * only the package differs.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type pg from 'pg';
import { SCOPE_LEVELS } from '@np/shared';

/** Schema of a district package file. */
export const districtPackageSchema = z
  .object({
    $comment: z.string().optional(),
    packageId: z.string().regex(/^[A-Z]{2}-\d{1,4}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    languages: z.array(z.enum(['hi', 'en'])).min(1),
    defaultLocale: z.enum(['hi', 'en']),
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
            parentId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).nullable(),
            level: z.enum(SCOPE_LEVELS),
            lgdCode: z.string().max(20).nullable(),
            nameEn: z.string().min(1).max(200),
            nameHi: z.string().min(1).max(200)
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export type DistrictPackage = z.output<typeof districtPackageSchema>;

/** Reads and validates a package file. Parents must appear before children. */
export async function readDistrictPackage(file: string): Promise<DistrictPackage> {
  const pkg = districtPackageSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const seen = new Set<string>();
  for (const n of pkg.nodes) {
    if (n.parentId && !seen.has(n.parentId)) throw new Error(`node ${n.id}: parent ${n.parentId} must be listed before it`);
    seen.add(n.id);
  }
  return pkg;
}

/**
 * Inserts missing nodes; verifies existing ones have the same parent and level
 * (the tree is immutable once created). Returns the number of nodes inserted.
 */
export async function importNodes(c: pg.PoolClient, pkg: DistrictPackage): Promise<number> {
  let inserted = 0;
  for (const n of pkg.nodes) {
    const cur = await c.query<{ parent_id: string | null; level: string }>('SELECT parent_id, level FROM platform.scope_nodes WHERE id = $1', [n.id]);
    const row = cur.rows[0];
    if (row) {
      if (row.parent_id !== n.parentId || row.level !== n.level) throw new Error(`node ${n.id} already exists with a different parent or level`);
      continue;
    }
    await c.query('INSERT INTO platform.scope_nodes (id, parent_id, level, lgd_code, name_en, name_hi) VALUES ($1, $2, $3, $4, $5, $6)', [
      n.id, n.parentId, n.level, n.lgdCode, n.nameEn, n.nameHi
    ]);
    inserted += 1;
  }
  return inserted;
}
