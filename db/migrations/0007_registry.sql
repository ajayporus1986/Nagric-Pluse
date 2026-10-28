-- 0007 Registry module (P1.1): offices, posts, post holders, and the services
-- notified under a right-to-public-service law (e.g. the Uttar Pradesh Janhit
-- Guarantee Adhiniyam, 2011, s.3: a designated officer, a stipulated time
-- limit, and a first/second appeal path per service).
--
-- Every value here is per scope_node, never a code constant: each district
-- (or any node) can carry its own office list and its own service timelines,
-- per the "editable, not hardcoded" requirement for the Janhit Guarantee SLAs.
-- sla_days is changed only through platform.change_requests (kind
-- SERVICE_SLA_SET), the same quorum-controlled path as every other Lego
-- setting, so no single person can silently lengthen or shorten a citizen's
-- statutory timeline.

CREATE SCHEMA registry;
REVOKE ALL ON SCHEMA registry FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_registry_rw') THEN CREATE ROLE np_registry_rw NOLOGIN; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Offices: a physical/administrative office at some node (a tehsil office, a
-- ULB office, a development-authority department, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE registry.offices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id        text NOT NULL REFERENCES platform.scope_nodes(id),
  name_en        text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  name_hi        text NOT NULL CHECK (length(name_hi) BETWEEN 1 AND 200),
  department_en  text NOT NULL CHECK (length(department_en) BETWEEN 1 AND 200),
  department_hi  text NOT NULL CHECK (length(department_hi) BETWEEN 1 AND 200),
  address_en     text CHECK (address_en IS NULL OR length(address_en) <= 500),
  address_hi     text CHECK (address_hi IS NULL OR length(address_hi) <= 500),
  phone          text CHECK (phone IS NULL OR phone ~ '^[0-9+()\- ]{6,20}$'),
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offices_node ON registry.offices (node_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Posts: a position within an office (e.g. Tehsildar, SDM). Posts, not
-- individual officials, are what services point to as the designated
-- officer / first appeal officer, because the holder changes but the
-- statutory responsibility stays with the post.
-- ---------------------------------------------------------------------------
CREATE TABLE registry.posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id   uuid NOT NULL REFERENCES registry.offices(id),
  title_en    text NOT NULL CHECK (length(title_en) BETWEEN 1 AND 200),
  title_hi    text NOT NULL CHECK (length(title_hi) BETWEEN 1 AND 200),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_office ON registry.posts (office_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Post holders: who currently (or historically) holds a post. A post with no
-- open-ended (assigned_to IS NULL) row is vacant. Assigning a new holder
-- without first closing the previous one is rejected by the unique index
-- below, not silently allowed to overlap.
-- ---------------------------------------------------------------------------
CREATE TABLE registry.post_holders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        uuid NOT NULL REFERENCES registry.posts(id),
  user_id        uuid NOT NULL REFERENCES iam.users(id),
  assigned_from  date NOT NULL DEFAULT CURRENT_DATE,
  assigned_to    date,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (assigned_to IS NULL OR assigned_to >= assigned_from)
);
CREATE INDEX post_holders_post ON registry.post_holders (post_id);
-- At most one open-ended holder per post at a time.
CREATE UNIQUE INDEX post_holders_one_open ON registry.post_holders (post_id) WHERE assigned_to IS NULL;

-- ---------------------------------------------------------------------------
-- Services notified under a right-to-public-service law. designated_officer
-- and first_appeal_officer are posts (so they survive a change of holder);
-- the second appellate authority is usually a fixed state-level body, so it
-- is recorded as free text rather than forced into the post model.
-- ---------------------------------------------------------------------------
CREATE TABLE registry.services (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id                        text NOT NULL REFERENCES platform.scope_nodes(id),
  code                           text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,60}$'),
  name_en                        text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 300),
  name_hi                        text NOT NULL CHECK (length(name_hi) BETWEEN 1 AND 300),
  department_en                  text NOT NULL CHECK (length(department_en) BETWEEN 1 AND 200),
  department_hi                  text NOT NULL CHECK (length(department_hi) BETWEEN 1 AND 200),
  designated_officer_post_id     uuid REFERENCES registry.posts(id),
  first_appeal_officer_post_id   uuid REFERENCES registry.posts(id),
  second_appellate_authority_en  text CHECK (second_appellate_authority_en IS NULL OR length(second_appellate_authority_en) <= 300),
  second_appellate_authority_hi  text CHECK (second_appellate_authority_hi IS NULL OR length(second_appellate_authority_hi) <= 300),
  -- Statutory time limit in days. Editable per node only via a quorum-approved
  -- change request (platform.change_requests kind SERVICE_SLA_SET); never a
  -- code constant, per the project's "adjustable variable per district" rule.
  sla_days                       integer NOT NULL CHECK (sla_days BETWEEN 1 AND 365),
  source_act_en                  text NOT NULL DEFAULT 'Uttar Pradesh Janhit Guarantee Adhiniyam, 2011',
  source_act_hi                  text NOT NULL DEFAULT 'उत्तर प्रदेश जनहित गारंटी अधिनियम, 2011',
  is_notified                    boolean NOT NULL DEFAULT true,
  active                         boolean NOT NULL DEFAULT true,
  -- Last change request that set the current sla_days (mirrors
  -- platform.module_settings.change_request_id); NULL until the SLA is first
  -- changed from its creation-time value.
  change_request_id              uuid,
  created_by                     uuid NOT NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, code)
);
CREATE INDEX services_node ON registry.services (node_id) WHERE active;

-- Every write to the tables above is audited via the same transactional
-- outbox pattern as the other modules.
SELECT audit.create_outbox('registry');

-- ---------------------------------------------------------------------------
-- Grants (least privilege).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA registry TO np_registry_rw;
GRANT SELECT, INSERT, UPDATE ON registry.offices, registry.posts, registry.post_holders, registry.services TO np_registry_rw;
GRANT INSERT ON registry.audit_outbox TO np_registry_rw;
GRANT USAGE ON SEQUENCE registry.audit_outbox_id_seq TO np_registry_rw;
-- Registry displays post-holder names; it never touches credentials.
GRANT USAGE ON SCHEMA iam TO np_registry_rw;
GRANT SELECT (id, username, display_name, status) ON iam.users TO np_registry_rw;

-- The audit relay drains every module's outbox, including registry's.
GRANT USAGE ON SCHEMA registry TO np_audit_relay;
GRANT SELECT, DELETE ON registry.audit_outbox TO np_audit_relay;

-- The platform module applies approved SERVICE_SLA_SET change requests, so it
-- may update exactly the SLA column (and its own bookkeeping columns) on
-- registry.services — nothing else in the registry schema.
GRANT USAGE ON SCHEMA registry TO np_platform_rw;
GRANT SELECT ON registry.services TO np_platform_rw;
GRANT UPDATE (sla_days, change_request_id, updated_at) ON registry.services TO np_platform_rw;
