-- 0014 Case engine module (Phase 3): the layer on top of grievance intake
-- that the Blueprint calls C4 ("Lifecycle, SLAs, routing, confirmation
-- windows, escalation") and C5 ("Responder inbox"). Intake (Phase 2) already
-- owns filing and the manual status machine; case engine adds what intake
-- deliberately left out:
--
--   1. Assignment: which staff member is currently working a grievance
--      (case.assignments, full history kept, not overwritten).
--   2. SLA-breach escalation: a worker sweep flags a grievance that is still
--      open past its sla_due_at (case.sla_escalations is the append-only
--      log; intake.grievances.escalation_level is the current count, read by
--      the responder inbox to sort by urgency).
--   3. Citizen closure confirmation: when staff mark a grievance RESOLVED, a
--      confirmation window opens; the citizen confirms (-> CLOSED) or
--      disputes (-> reopened to IN_PROGRESS) through the public API, or a
--      worker sweep auto-closes it if the window lapses with no response.
--      (case.closure_confirmations). This reuses intake's own status
--      transitions (RESOLVED -> CLOSED / RESOLVED -> IN_PROGRESS are already
--      legal in its TRANSITIONS table), rather than inventing a parallel
--      status machine.
--
-- Case engine therefore needs narrow, column-scoped write access into
-- intake's tables for these automated transitions -- a deliberate, scoped
-- exception to "each module only writes its own schema", because this is
-- exactly the concern the Blueprint assigns to a separate case-engine layer
-- rather than to intake itself. Intake's own role (np_intake_rw) is
-- unaffected; its manual staff-triage PATCH endpoint keeps working exactly
-- as before.

CREATE SCHEMA "case";
REVOKE ALL ON SCHEMA "case" FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_case_rw') THEN CREATE ROLE np_case_rw NOLOGIN; END IF;
END $$;

ALTER TABLE intake.grievances
  ADD COLUMN escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0);

-- Current assignee = the row for a grievance with unassigned_at IS NULL (at
-- most one at a time, enforced in the API transaction, not a DB constraint,
-- since closing the old row and opening the new one are two statements).
CREATE TABLE "case".assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id      uuid NOT NULL REFERENCES intake.grievances(id),
  node_id           text NOT NULL REFERENCES platform.scope_nodes(id),
  assignee_user_id  uuid NOT NULL,
  assigned_by       uuid NOT NULL,
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  unassigned_at     timestamptz
);
CREATE INDEX assignments_grievance_current ON "case".assignments (grievance_id) WHERE unassigned_at IS NULL;
CREATE INDEX assignments_assignee_current ON "case".assignments (assignee_user_id) WHERE unassigned_at IS NULL;

-- Append-only: one row per escalation step a worker sweep records. Never
-- updated or deleted; intake.grievances.escalation_level is the fast-read
-- current count.
CREATE TABLE "case".sla_escalations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id   uuid NOT NULL REFERENCES intake.grievances(id),
  from_level     integer NOT NULL,
  to_level       integer NOT NULL,
  escalated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sla_escalations_grievance ON "case".sla_escalations (grievance_id);

CREATE TABLE "case".closure_confirmations (
  grievance_id      uuid PRIMARY KEY REFERENCES intake.grievances(id),
  window_expires_at timestamptz NOT NULL,
  confirmed         boolean, -- NULL = no citizen response yet
  confirmed_at      timestamptz,
  dispute_note      text CHECK (dispute_note IS NULL OR length(dispute_note) <= 2000),
  auto_closed       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Same fixed-window pattern as every other module's rate_limits table.
CREATE TABLE "case".rate_limits (
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL
);

SELECT audit.create_outbox('case');

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "case" TO np_case_rw;
GRANT SELECT, INSERT, UPDATE ON "case".assignments TO np_case_rw;
GRANT SELECT, INSERT ON "case".sla_escalations TO np_case_rw;
GRANT SELECT, INSERT, UPDATE ON "case".closure_confirmations TO np_case_rw;
GRANT SELECT, INSERT, UPDATE ON "case".rate_limits TO np_case_rw;
GRANT INSERT ON "case".audit_outbox TO np_case_rw;
GRANT USAGE ON SEQUENCE "case".audit_outbox_id_seq TO np_case_rw;

-- Narrow, column-scoped cross-module access into intake, for exactly the
-- automated transitions case engine owns (see header comment).
GRANT USAGE ON SCHEMA intake TO np_case_rw;
GRANT SELECT ON intake.grievances TO np_case_rw;
GRANT UPDATE (status, resolved_at, updated_at, escalation_level) ON intake.grievances TO np_case_rw;
GRANT INSERT ON intake.grievance_events TO np_case_rw;

-- Staff-account existence/status check when assigning a case (never reads
-- password_hash, totp_secret_enc, email_enc, or any other sensitive column).
GRANT USAGE ON SCHEMA iam TO np_case_rw;
GRANT SELECT (id, display_name, status) ON iam.users TO np_case_rw;

GRANT USAGE ON SCHEMA platform TO np_case_rw;
GRANT SELECT ON platform.scope_nodes TO np_case_rw;

GRANT USAGE ON SCHEMA "case" TO np_audit_relay;
GRANT SELECT, DELETE ON "case".audit_outbox TO np_audit_relay;
