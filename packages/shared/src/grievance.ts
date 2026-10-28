/**
 * Shared, reusable grievance types -- forward-declared ahead of the intake
 * module so later work (intake, case engine, ground audit) does not have to
 * retrofit every downstream schema. Not wired into any database table yet;
 * no intake/case table exists in Phase 1 (registry -> citizen -> intake ->
 * ...). This file is the one place these shapes are defined, so every module
 * that attaches them reuses the same zod schema rather than inventing its
 * own.
 *
 * Grounded in two project-doc research passes:
 *   - Nagrik_Pulse_Governance_Taxonomy_and_Configurability_Design (citizen
 *     civic grievances + jurisdiction variety)
 *   - Nagrik_Pulse_Business_and_Informal_Sector_Grievance_Research (business/
 *     MSME/informal-sector friction, which turns out to use the exact same
 *     reason taxonomy as citizen friction)
 */
import { z } from 'zod';

/**
 * Who is raising the grievance. ANONYMOUS covers both citizens and
 * businesses who fear retaliation -- the research found this is a real,
 * common pattern for both populations, not just a citizen concern.
 */
export const COMPLAINANT_TYPES = ['CITIZEN', 'BUSINESS', 'ANONYMOUS'] as const;
export type ComplainantType = (typeof COMPLAINANT_TYPES)[number];

/**
 * Business-profile sub-block, present only when complainantType = BUSINESS.
 * `sectorFormality` and `operatingContext` deliberately read from the
 * platform's admin-editable classification_values (axis codes
 * "sectorFormality" / "operatingContext"), NOT a hardcoded TS enum -- the
 * research found the real variety (organized/MSME/unorganized/home-based;
 * shop/Authority-area unit/SEZ unit/IT park unit/street vendor/gig worker)
 * is exactly the kind of thing that must stay admin-addable. The zod schema
 * here only constrains shape, not vocabulary.
 */
export const businessProfileSchema = z
  .object({
    sectorFormality: z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/), // classification_values axis "sectorFormality"
    operatingContext: z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/), // classification_values axis "operatingContext"
    gstin: z.string().trim().max(20).optional(),
    udyamNumber: z.string().trim().max(30).optional(),
    tradeLicenseNumber: z.string().trim().max(60).optional(),
    vendingCertificateNumber: z.string().trim().max(60).optional()
  })
  .strict();
export type BusinessProfile = z.infer<typeof businessProfileSchema>;

/**
 * Reusable friction-report block: did the complainant have to pay, hire an
 * agent, or use influence to get the service done, and why. Attachable to
 * any module's case/record (service request, citizen case, ground-audit
 * finding, and future modules) rather than rebuilt per module -- the reason
 * codes come from platform.classification_values (axis
 * "grievanceFrictionReason", seeded in 0010_classification.sql) so new
 * reasons can be added without a code change. "OTHER" always requires
 * otherText.
 */
export const frictionReportSchema = z
  .object({
    occurred: z.boolean(),
    reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/)).max(10).default([]),
    otherText: z.string().trim().max(1000).optional()
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.occurred && f.reasonCodes.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['reasonCodes'], message: 'at least one reason is required when occurred is true' });
    }
    if (f.reasonCodes.includes('OTHER') && !f.otherText) {
      ctx.addIssue({ code: 'custom', path: ['otherText'], message: 'required when OTHER is selected' });
    }
  });
export type FrictionReport = z.infer<typeof frictionReportSchema>;

/** Full complainant block a future intake/case record attaches: type plus the matching profile. */
export const complainantSchema = z
  .object({
    type: z.enum(COMPLAINANT_TYPES),
    businessProfile: businessProfileSchema.optional(),
    frictionReport: frictionReportSchema.optional()
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.type === 'BUSINESS' && !c.businessProfile) {
      ctx.addIssue({ code: 'custom', path: ['businessProfile'], message: 'required when type is BUSINESS' });
    }
    if (c.type !== 'BUSINESS' && c.businessProfile) {
      ctx.addIssue({ code: 'custom', path: ['businessProfile'], message: 'only valid when type is BUSINESS' });
    }
  });
export type Complainant = z.infer<typeof complainantSchema>;
