-- 0004 Lego registry and policy (P0.4).

CREATE TABLE platform.modules (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  version        text NOT NULL,
  manifest       jsonb NOT NULL,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.module_settings (
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  module_id          text NOT NULL REFERENCES platform.modules(id),
  state              text NOT NULL CHECK (state IN ('ENABLED','DISABLED')),
  change_request_id  uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, module_id)
);

CREATE TABLE platform.feature_settings (
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  feature_code       text NOT NULL,
  state              text NOT NULL CHECK (state IN ('ENABLED','DISABLED')),
  change_request_id  uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, feature_code)
);

CREATE TABLE platform.realm_settings (
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  realm              text NOT NULL CHECK (realm IN ('GOVERNMENT','PARTY','OBSERVER')),
  state              text NOT NULL CHECK (state IN ('ENABLED','DISABLED')),
  change_request_id  uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, realm)
);

CREATE TABLE platform.permissions (
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  feature_code       text NOT NULL,
  role               text NOT NULL,
  actions            text[] NOT NULL CHECK (actions <@ ARRAY['view','create','update','delete','approve','export','special']),
  change_request_id  uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, feature_code, role)
);

-- Approvals required per scope level. Never fewer than 2 (no one-person changes).
CREATE TABLE platform.quorum_config (
  level      text PRIMARY KEY CHECK (level IN ('NATION','STATE','DISTRICT','SUBDISTRICT','BLOCK','URBAN_BODY','AUTHORITY','WARD','VILLAGE')),
  required   integer NOT NULL CHECK (required BETWEEN 2 AND 9)
);
INSERT INTO platform.quorum_config (level, required) VALUES
  ('NATION', 3), ('STATE', 3), ('DISTRICT', 2), ('SUBDISTRICT', 2), ('BLOCK', 2),
  ('URBAN_BODY', 2), ('AUTHORITY', 2), ('WARD', 2), ('VILLAGE', 2);

CREATE TABLE platform.change_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id             text NOT NULL REFERENCES platform.scope_nodes(id),
  kind                text NOT NULL CHECK (kind IN ('MODULE_SETTING','FEATURE_SETTING','REALM_SETTING','PERMISSION','ROLE_GRANT','ROLE_REVOKE','KILL_SWITCH_RATIFY','QUORUM_CONFIG')),
  payload             jsonb NOT NULL,
  reason              text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  impact              jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','REJECTED','EXPIRED','WITHDRAWN')),
  required_approvals  integer NOT NULL CHECK (required_approvals >= 2),
  proposed_by         uuid NOT NULL,
  proposed_at         timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  decided_at          timestamptz,
  CHECK (expires_at > proposed_at)
);
CREATE INDEX change_requests_pending ON platform.change_requests (status, expires_at) WHERE status = 'PENDING';

CREATE TABLE platform.approvals (
  change_request_id  uuid NOT NULL REFERENCES platform.change_requests(id),
  approver_id        uuid NOT NULL,
  verdict            text NOT NULL CHECK (verdict IN ('APPROVE','REJECT')),
  comment            text,
  at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (change_request_id, approver_id)
);

CREATE TABLE platform.kill_switches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id           text NOT NULL REFERENCES platform.modules(id),
  node_id             text NOT NULL REFERENCES platform.scope_nodes(id),
  reason              text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  activated_by        uuid NOT NULL,
  activated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  ratified_by_cr      uuid REFERENCES platform.change_requests(id),
  cleared_at          timestamptz,
  cleared_by          uuid,
  CHECK (expires_at > activated_at AND expires_at <= activated_at + interval '24 hours')
);
CREATE INDEX kill_switches_active ON platform.kill_switches (module_id) WHERE cleared_at IS NULL;

-- Any change to policy tables notifies API replicas to rebuild their snapshot.
CREATE FUNCTION platform.notify_policy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('policy_changed', TG_TABLE_NAME);
  RETURN NULL;
END $$;
CREATE TRIGGER modules_notify AFTER INSERT OR UPDATE OR DELETE ON platform.modules FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();
CREATE TRIGGER module_settings_notify AFTER INSERT OR UPDATE OR DELETE ON platform.module_settings FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();
CREATE TRIGGER feature_settings_notify AFTER INSERT OR UPDATE OR DELETE ON platform.feature_settings FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();
CREATE TRIGGER realm_settings_notify AFTER INSERT OR UPDATE OR DELETE ON platform.realm_settings FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();
CREATE TRIGGER permissions_notify AFTER INSERT OR UPDATE OR DELETE ON platform.permissions FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();
CREATE TRIGGER kill_switches_notify AFTER INSERT OR UPDATE OR DELETE ON platform.kill_switches FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();
CREATE TRIGGER scope_nodes_notify AFTER INSERT OR UPDATE OR DELETE ON platform.scope_nodes FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();

GRANT USAGE ON SCHEMA platform TO np_platform_rw;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA platform TO np_platform_rw;
GRANT DELETE ON platform.module_settings, platform.feature_settings, platform.realm_settings, platform.permissions TO np_platform_rw;
REVOKE UPDATE ON platform.audit_outbox FROM np_platform_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA platform TO np_platform_rw;
-- The platform module applies approved role grants, so it may write role assignments (but not credentials).
GRANT USAGE ON SCHEMA iam TO np_platform_rw;
GRANT SELECT (id, username, display_name, status) ON iam.users TO np_platform_rw;
GRANT SELECT, INSERT, UPDATE ON iam.role_assignments TO np_platform_rw;
