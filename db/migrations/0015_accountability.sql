-- 0015 Official accountability & leadership reporting (Phase 4).
--
-- Implements the officer/department/ministry KPI-KRI module from the
-- Blueprint (§5.4/5.5, §9.7/9.8) and the v2 doc's module table
-- (official-accountability, aggregator), refined by the decisions recorded
-- in claude/Nagrik_Pulse_Official_Accountability_and_Leadership_Reporting_
-- Design_2026-10-28.md (sequencing, gating, cadence). Built after case
-- engine (Phase 3) because most of its KPIs are derived from case lifecycle
-- data case engine produces (SLA adherence, time-to-resolution, reopen
-- rate, escalation count).
--
-- Honours the spec's load-bearing constraints:
--   - Office/process metrics are always computed (accountability.
--     process_metrics_daily); person-level metrics are evidence-gated
--     (accountability.person_metrics.evidence_met) and never surfaced
--     unless the gate passes.
--   - Due process: notice-and-reply, independent review before anything
--     reaches an HR file, appeal (accountability.notices). No automated
--     adverse action -- this module only ever notices and records; no code
--     path here writes to iam.users or disables an account.
--   - Dashboards and leadership pulls read only from pre-computed aggregate
--     tables, never live-joining intake/case data (Blueprint §12).
--
-- Known, documented limitation: the Blueprint's full evidence gate
-- (independent-reporter diversity, integrity/corroboration scoring,
-- internal-log corroboration) depends on an Intelligence/Integrity module
-- (§9.6) this codebase has not built -- there is no complaint-corroboration
-- pipeline yet, only intake + case. accountability.person_metrics therefore
-- uses the evidence it CAN compute today -- case volume (ACCOUNTABILITY_
-- MIN_RESOLVED_CASES) and distinct-citizen diversity (ACCOUNTABILITY_
-- MIN_DISTINCT_CITIZENS) -- as a proxy evidence gate, and evidence_met
-- should be tightened (not loosened) once integrity/corroboration exists.
-- This is a partial implementation of §9.7's evidence gate, not a
-- substitute for it.
--
-- Decisions confirmed in chat before this migration was written:
--   - Pull authorization: reuses the EXISTING STATE_LEADERSHIP/NATIONAL_
--     LEADERSHIP roles (packages/shared/src/roles.ts) at their own scope
--     nodes -- no new role concept. Lego's existing node-hierarchy check
--     (a role assigned at a STATE node already covers every DISTRICT below
--     it) does the subtree authorization for free.
--   - Purpose-stated pulls use a fixed, admin-editable reason-code list
--     (platform.classification_axes 'accountabilityPullReason'), same
--     pattern as grievanceSubtype/orgEntityKind, not free text.
--   - The monthly upward push (district -> state -> national) materializes
--     and logs an audited snapshot now (accountability.monthly_pushes);
--     there is no state/national hub in this codebase yet, so it stays
--     local until one exists or an external endpoint is specified.
--   - SLA-breach/escalation alerts fire immediately (accountability.
--     sla_alerts), in addition to the monthly rollup, off case engine's
--     existing "case".sla_escalations.

CREATE SCHEMA accountability;
REVOKE ALL ON SCHEMA accountability FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_accountability_rw') THEN CREATE ROLE np_accountability_rw NOLOGIN; END IF;
END $$;

-- Admin-editable reason codes for an on-demand leadership pull (the
-- "purpose-stated" requirement in Blueprint §5.5), same pattern as
-- grievanceSubtype -- validated in the API against classification_values,
-- not FK'd, so a district can add more without a redeploy.
INSERT INTO platform.classification_axes (code, name_en, name_hi, description_en, multi) VALUES
  ('accountabilityPullReason', 'Leadership pull reason', 'नेतृत्व पुल कारण', 'Why state/national leadership queried accountability data outside the scheduled monthly push -- every pull is logged with one of these codes.', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.classification_values (axis_code, code, name_en, name_hi) VALUES
  ('accountabilityPullReason', 'ROUTINE_REVIEW', 'Routine review', 'नियमित समीक्षा'),
  ('accountabilityPullReason', 'AUDIT', 'Audit', 'लेखा परीक्षा'),
  ('accountabilityPullReason', 'PARLIAMENTARY_QUESTION', 'Legislative / parliamentary question', 'विधायी / संसदीय प्रश्न'),
  ('accountabilityPullReason', 'INCIDENT_FOLLOWUP', 'Incident follow-up', 'घटना अनुवर्ती कार्रवाई'),
  ('accountabilityPullReason', 'OTHER', 'Other (see note)', 'अन्य (टिप्पणी देखें)')
ON CONFLICT (axis_code, code) DO NOTHING;

-- Process-level metrics (always computed, never gated). One row per
-- (node, department, day); entity_id NULL = all departments combined at
-- that node. Populated by the hourly rollupProcessMetrics worker job from
-- intake + case data; dashboards and pulls read only from here.
CREATE TABLE accountability.process_metrics_daily (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id                        text NOT NULL REFERENCES platform.scope_nodes(id),
  entity_id                      uuid REFERENCES org.entities(id),
  metric_date                    date NOT NULL,
  filed_count                    integer NOT NULL DEFAULT 0,
  resolved_count                 integer NOT NULL DEFAULT 0,
  closed_count                   integer NOT NULL DEFAULT 0,
  reopened_count                 integer NOT NULL DEFAULT 0,
  escalated_count                integer NOT NULL DEFAULT 0,
  sla_met_count                  integer NOT NULL DEFAULT 0,
  sla_breached_count             integer NOT NULL DEFAULT 0,
  avg_time_to_resolution_hours   numeric,
  avg_time_to_first_ack_hours    numeric,
  citizen_confirmed_count        integer NOT NULL DEFAULT 0,
  computed_at                    timestamptz NOT NULL DEFAULT now()
);
-- Expression-based unique key so entity_id IS NULL ("all departments") is a
-- real upsert target too (NULL <> NULL would otherwise defeat a plain
-- UNIQUE(node_id, entity_id, metric_date)).
CREATE UNIQUE INDEX process_metrics_daily_key ON accountability.process_metrics_daily
  (node_id, metric_date, (COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX process_metrics_daily_node_date ON accountability.process_metrics_daily (node_id, metric_date DESC);

-- Person-level metrics (evidence-gated). One row per officer, a rolling-
-- window snapshot (not a daily series) overwritten by each rollupPersonMetrics
-- tick. evidence_met is computed and stored, not just checked in the API, so
-- a bug in a query filter can never leak a row that hasn't cleared the gate.
CREATE TABLE accountability.person_metrics (
  assignee_user_id              uuid PRIMARY KEY,
  node_id                        text NOT NULL REFERENCES platform.scope_nodes(id),
  window_days                    integer NOT NULL,
  assigned_count                 integer NOT NULL DEFAULT 0,
  resolved_count                 integer NOT NULL DEFAULT 0,
  sla_met_count                  integer NOT NULL DEFAULT 0,
  sla_breached_count             integer NOT NULL DEFAULT 0,
  avg_time_to_resolution_hours   numeric,
  distinct_citizens              integer NOT NULL DEFAULT 0,
  evidence_met                   boolean NOT NULL DEFAULT false,
  computed_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_metrics_node ON accountability.person_metrics (node_id) WHERE evidence_met;

-- Due process: notice of a de-identified allegation/metric, the officer's
-- right of reply, independent review (Integrity Reviewer) before anything
-- could reach an HR file, and appeal. No column or trigger here performs an
-- HR action; this table only records the due-process trail.
CREATE TABLE accountability.notices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  assignee_user_id   uuid NOT NULL,
  metric_ref         text NOT NULL CHECK (length(metric_ref) BETWEEN 1 AND 200),
  allegation_summary text NOT NULL CHECK (length(allegation_summary) BETWEEN 1 AND 2000),
  issued_by          uuid NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  reply_due_at       timestamptz NOT NULL,
  reply_text         text CHECK (reply_text IS NULL OR length(reply_text) <= 4000),
  replied_at         timestamptz,
  review_status      text NOT NULL DEFAULT 'PENDING_REPLY' CHECK (review_status IN ('PENDING_REPLY','UNDER_REVIEW','UPHELD','DISMISSED','APPEALED')),
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  review_note        text CHECK (review_note IS NULL OR length(review_note) <= 2000),
  appeal_note        text CHECK (appeal_note IS NULL OR length(appeal_note) <= 2000),
  appealed_at        timestamptz
);
CREATE INDEX notices_assignee ON accountability.notices (assignee_user_id, issued_at DESC);
CREATE INDEX notices_node ON accountability.notices (node_id, issued_at DESC);

-- On-demand leadership pull: a logged, purpose-stated request (Blueprint
-- §5.5), never raw/unaudited DB access. result_summary is the exact
-- snapshot returned at request time, so a later audit sees exactly what
-- leadership was shown.
CREATE TABLE accountability.pull_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by    uuid NOT NULL,
  node_id         text NOT NULL REFERENCES platform.scope_nodes(id),
  reason_code     text NOT NULL, -- platform.classification_values(axis_code='accountabilityPullReason').code; validated in the API
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  result_summary  jsonb NOT NULL
);
CREATE INDEX pull_requests_node ON accountability.pull_requests (node_id, requested_at DESC);

-- Scheduled upward push, district -> state -> national (monthly, per the
-- confirmed cadence decision). Materialize-and-log only for now: this
-- codebase builds a single district pod and has no state/national hub to
-- send to yet, so a push is an audited local record until one exists.
CREATE TABLE accountability.monthly_pushes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id   text NOT NULL REFERENCES platform.scope_nodes(id),
  period    date NOT NULL, -- first day of the pushed month
  payload   jsonb NOT NULL,
  pushed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, period)
);

-- Immediate SLA-breach/escalation alerts, additional to the monthly push
-- (confirmed decision: breach visibility should not wait a month). One row
-- per grievance per escalation level reached, off case engine's existing
-- "case".sla_escalations -- this table does not duplicate that log, only
-- marks which steps have already been surfaced as an accountability alert.
CREATE TABLE accountability.sla_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id      uuid NOT NULL,
  node_id           text NOT NULL REFERENCES platform.scope_nodes(id),
  escalation_level  integer NOT NULL,
  alerted_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grievance_id, escalation_level)
);
CREATE INDEX sla_alerts_node ON accountability.sla_alerts (node_id, alerted_at DESC);

-- Same fixed-window pattern as every other module's rate_limits table.
CREATE TABLE accountability.rate_limits (
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL
);

SELECT audit.create_outbox('accountability');

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA accountability TO np_accountability_rw;
GRANT SELECT, INSERT, UPDATE ON accountability.process_metrics_daily TO np_accountability_rw;
GRANT SELECT, INSERT, UPDATE ON accountability.person_metrics TO np_accountability_rw;
GRANT SELECT, INSERT, UPDATE ON accountability.notices TO np_accountability_rw;
GRANT SELECT, INSERT ON accountability.pull_requests TO np_accountability_rw;
GRANT SELECT, INSERT ON accountability.monthly_pushes TO np_accountability_rw;
GRANT SELECT, INSERT ON accountability.sla_alerts TO np_accountability_rw;
GRANT SELECT, INSERT, UPDATE ON accountability.rate_limits TO np_accountability_rw;
GRANT INSERT ON accountability.audit_outbox TO np_accountability_rw;
GRANT USAGE ON SEQUENCE accountability.audit_outbox_id_seq TO np_accountability_rw;

-- Narrow, read-only cross-module access -- this module computes aggregates
-- from other modules' data but never writes to it (unlike case engine's
-- documented write exception into intake). A deliberate, documented
-- exception to "each module writes only its own schema", read-only side.
GRANT USAGE ON SCHEMA intake TO np_accountability_rw;
GRANT SELECT (id, node_id, entity_id, status, subtype, citizen_id, created_at, updated_at, resolved_at, sla_due_at, escalation_level) ON intake.grievances TO np_accountability_rw;
GRANT SELECT (id, grievance_id, from_status, to_status, created_at) ON intake.grievance_events TO np_accountability_rw;

GRANT USAGE ON SCHEMA "case" TO np_accountability_rw;
GRANT SELECT (id, grievance_id, node_id, assignee_user_id, assigned_at, unassigned_at) ON "case".assignments TO np_accountability_rw;
GRANT SELECT (id, grievance_id, from_level, to_level, escalated_at) ON "case".sla_escalations TO np_accountability_rw;
GRANT SELECT (grievance_id, confirmed, confirmed_at, auto_closed) ON "case".closure_confirmations TO np_accountability_rw;

-- Staff display-name lookups only (never password_hash, totp_secret_enc, or
-- any other sensitive column) -- same narrow grant shape as case engine's.
GRANT USAGE ON SCHEMA iam TO np_accountability_rw;
GRANT SELECT (id, display_name, status) ON iam.users TO np_accountability_rw;

GRANT USAGE ON SCHEMA org TO np_accountability_rw;
GRANT SELECT (id, node_id, kind, name_en, name_hi, active) ON org.entities TO np_accountability_rw;

GRANT USAGE ON SCHEMA platform TO np_accountability_rw;
GRANT SELECT ON platform.scope_nodes TO np_accountability_rw;
GRANT SELECT ON platform.classification_axes TO np_accountability_rw;
GRANT SELECT ON platform.classification_values TO np_accountability_rw;

GRANT USAGE ON SCHEMA accountability TO np_audit_relay;
GRANT SELECT, DELETE ON accountability.audit_outbox TO np_audit_relay;
