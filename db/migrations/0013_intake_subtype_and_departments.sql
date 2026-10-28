-- 0013 Grievance subtype + multi-department routing (schema room only).
--
-- Two gaps identified against the governance-taxonomy and business/informal-
-- sector research after Phase 2 shipped:
--
-- 1. "Enforcement/eviction-specific grievance subtype ... should be a
--    selectable case subtype" (business-sector research, §3.6) -- a street
--    vendor being evicted/harassed despite holding a vending certificate is a
--    distinct fact pattern from "service delayed," and the Town Vending
--    Committee has statutory involvement. `subtype` is another admin-
--    addable classification axis (not a hardcoded enum), same pattern as
--    org.entities.kind: validated in the API against platform.
--    classification_values, not FK'd.
--
-- 2. "Multi-department routing: a single grievance/case must be able to name
--    more than one responsible department (single-window-style) ... the
--    case-engine design (not yet built) needs this from the start rather
--    than retrofitted" (business-sector research, §3.4). The case engine
--    itself is a later phase, but the shape it will need is added now so
--    intake doesn't have to be retrofitted later: intake.grievances.entity_id
--    stays the single *primary* department (unchanged, backward compatible);
--    intake.grievance_departments holds every department actually named at
--    filing time (primary included), so the case engine has one place to
--    read "who is this routed to" without re-deriving it from entity_id.

INSERT INTO platform.classification_axes (code, name_en, name_hi, description_en, multi) VALUES
  ('grievanceSubtype', 'Grievance subtype', 'शिकायत उपप्रकार', 'Distinguishes fact patterns that need different handling from an ordinary service-delay complaint (e.g. enforcement/eviction action against a vendor) -- admin-addable.', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.classification_values (axis_code, code, name_en, name_hi) VALUES
  ('grievanceSubtype', 'STANDARD', 'Standard', 'सामान्य'),
  ('grievanceSubtype', 'ENFORCEMENT_EVICTION', 'Enforcement / eviction action', 'प्रवर्तन / बेदखली कार्रवाई')
ON CONFLICT (axis_code, code) DO NOTHING;

ALTER TABLE intake.grievances
  ADD COLUMN subtype text NOT NULL DEFAULT 'STANDARD'; -- platform.classification_values(axis_code='grievanceSubtype').code; validated in the API

CREATE TABLE intake.grievance_departments (
  grievance_id  uuid NOT NULL REFERENCES intake.grievances(id),
  entity_id     uuid NOT NULL REFERENCES org.entities(id),
  is_primary    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grievance_id, entity_id)
);
CREATE INDEX grievance_departments_entity ON intake.grievance_departments (entity_id);

-- Backfill: every existing grievance that already names a primary entity_id
-- gets one row here too, so the case engine never has two sources of truth
-- to reconcile for data filed before this migration.
INSERT INTO intake.grievance_departments (grievance_id, entity_id, is_primary)
SELECT id, entity_id, true FROM intake.grievances WHERE entity_id IS NOT NULL
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT ON intake.grievance_departments TO np_intake_rw;
