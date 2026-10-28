-- 0012 Grievance intake module (Phase 2): the first module built on top of
-- the shared grievance shapes forward-declared in @np/shared (COMPLAINANT_
-- TYPES, businessProfileSchema, frictionReportSchema, complainantSchema --
-- see packages/shared/src/grievance.ts) and on the classification/org
-- directory layers added in Phase 1.5. A grievance can target either a
-- notified service (registry.services, for SLA tracking under the UP
-- Janhit Guarantee Act) or a general org entity (org.entities -- a
-- department/authority with no single notified service), or neither (a
-- purely civic complaint with just a free-text subject/description).
--
-- Citizens may file anonymously (complainant_type = 'ANONYMOUS', citizen_id
-- NULL) -- the governance-taxonomy research found this is a real need for
-- both citizens and businesses who fear retaliation, not a theoretical edge
-- case. The friction_report/business_profile blocks are stored as jsonb,
-- validated by the matching zod schema in @np/shared before insert, not
-- re-modelled as columns -- so every future module that reuses those shapes
-- (ground audit named explicitly by the user) stores them the same way.

CREATE SCHEMA intake;
REVOKE ALL ON SCHEMA intake FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_intake_rw') THEN CREATE ROLE np_intake_rw NOLOGIN; END IF;
END $$;

-- Backs human-readable reference codes ("NP-D144-000123"); the numeric part
-- is global (not per-node) so the sequence never needs per-district setup.
CREATE SEQUENCE intake.grievance_seq;

CREATE TABLE intake.grievances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code     text NOT NULL UNIQUE,
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  -- A grievance may target a notified service (SLA tracking), a general org
  -- entity, or neither (free-text civic complaint); at least a subject is
  -- always required regardless.
  service_id         uuid REFERENCES registry.services(id),
  entity_id          uuid REFERENCES org.entities(id),
  citizen_id         uuid REFERENCES citizen.citizens(id), -- NULL when filed anonymously
  complainant_type   text NOT NULL CHECK (complainant_type IN ('CITIZEN','BUSINESS','ANONYMOUS')),
  -- Validated against businessProfileSchema / frictionReportSchema
  -- (@np/shared) in the API before insert; stored as-is so new fields in
  -- those shapes need no migration.
  business_profile   jsonb,
  friction_report    jsonb,
  subject            text NOT NULL CHECK (length(subject) BETWEEN 3 AND 300),
  description        text NOT NULL CHECK (length(description) BETWEEN 1 AND 5000),
  locale             text NOT NULL DEFAULT 'hi' CHECK (locale IN ('hi','en')),
  status             text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ACKNOWLEDGED','IN_PROGRESS','RESOLVED','REJECTED','CLOSED')),
  -- Snapshot of the linked service's sla_days at filing time, so a later
  -- SERVICE_SLA_SET change request never retroactively moves the due date
  -- of a grievance already in flight.
  sla_days           integer CHECK (sla_days IS NULL OR sla_days BETWEEN 1 AND 365),
  sla_due_at         timestamptz,
  created_by_ip      inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  CHECK (complainant_type <> 'ANONYMOUS' OR citizen_id IS NULL),
  CHECK (complainant_type = 'ANONYMOUS' OR citizen_id IS NOT NULL)
);
CREATE INDEX grievances_node ON intake.grievances (node_id, status);
CREATE INDEX grievances_citizen ON intake.grievances (citizen_id) WHERE citizen_id IS NOT NULL;
CREATE INDEX grievances_service ON intake.grievances (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX grievances_entity ON intake.grievances (entity_id) WHERE entity_id IS NOT NULL;

-- Status-change history: who moved it, from/to, and an optional staff note.
-- actor_user_id is NULL for the system-generated 'filed' event at creation.
CREATE TABLE intake.grievance_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id    uuid NOT NULL REFERENCES intake.grievances(id),
  from_status     text,
  to_status       text NOT NULL,
  note            text CHECK (note IS NULL OR length(note) <= 2000),
  actor_user_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grievance_events_grievance ON intake.grievance_events (grievance_id, created_at);

-- Same fixed-window pattern as citizen.rate_limits / iam.rate_limits: a
-- separate table per module rather than a shared one, so no module's
-- least-privilege role needs a grant on another module's schema.
CREATE TABLE intake.rate_limits (
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL
);

SELECT audit.create_outbox('intake');

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA intake TO np_intake_rw;
GRANT SELECT, INSERT, UPDATE ON intake.grievances TO np_intake_rw;
GRANT SELECT, INSERT ON intake.grievance_events TO np_intake_rw;
GRANT SELECT, INSERT, UPDATE ON intake.rate_limits TO np_intake_rw;
GRANT USAGE ON SEQUENCE intake.grievance_seq TO np_intake_rw;
GRANT INSERT ON intake.audit_outbox TO np_intake_rw;
GRANT USAGE ON SEQUENCE intake.audit_outbox_id_seq TO np_intake_rw;

-- Cross-module reads intake needs: service SLA/node at filing time, entity
-- existence, citizen existence (to confirm the session's citizen_id is
-- real), classification values (to validate business-profile/friction-report
-- codes), and the scope tree (subtree queries for staff list views).
GRANT USAGE ON SCHEMA registry TO np_intake_rw;
GRANT SELECT ON registry.services TO np_intake_rw;
GRANT USAGE ON SCHEMA org TO np_intake_rw;
GRANT SELECT ON org.entities TO np_intake_rw;
GRANT USAGE ON SCHEMA citizen TO np_intake_rw;
GRANT SELECT ON citizen.citizens TO np_intake_rw;
GRANT USAGE ON SCHEMA platform TO np_intake_rw;
GRANT SELECT ON platform.classification_values, platform.scope_nodes TO np_intake_rw;

GRANT USAGE ON SCHEMA intake TO np_audit_relay;
GRANT SELECT, DELETE ON intake.audit_outbox TO np_audit_relay;
