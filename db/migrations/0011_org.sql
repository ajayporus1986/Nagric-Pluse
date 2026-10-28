-- 0011 Org directory module (Phase 1.5): an ERP-style register of
-- departments, ministries, statutory authorities, SPVs and other service
-- providers, so every module (registry services, future intake/case
-- engine/ground audit) can reference one `entityId` instead of free-text
-- department names. `kind` is an admin-addable lookup (platform.
-- classification_values, axis "orgEntityKind"), not a hardcoded enum,
-- because the research found real org types go well beyond DEPARTMENT/
-- MINISTRY: statutory authorities (NOIDA/GNIDA/YEIDA), SEZ Development
-- Commissioner offices, Smart City SPVs, Town Vending Committees, Cantonment
-- Boards, Port Trusts, Labour/Fire/Pollution/Electricity/FSSAI departments
-- businesses actually encounter.

CREATE SCHEMA org;
REVOKE ALL ON SCHEMA org FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_org_rw') THEN CREATE ROLE np_org_rw NOLOGIN; END IF;
END $$;

INSERT INTO platform.classification_axes (code, name_en, name_hi, description_en, multi) VALUES
  ('orgEntityKind', 'Organization entity kind', 'संगठन संस्था प्रकार', 'Department / Ministry / Statutory Authority / SPV / SEZ Authority / Cantonment Board / PSU Township / Port Trust / Service Provider -- admin-addable, covers both government departments and the parastatals/zones businesses actually deal with.', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.classification_values (axis_code, code, name_en, name_hi) VALUES
  ('orgEntityKind', 'DEPARTMENT', 'Department', 'विभाग'),
  ('orgEntityKind', 'MINISTRY', 'Ministry', 'मंत्रालय'),
  ('orgEntityKind', 'SERVICE_PROVIDER', 'Service provider', 'सेवा प्रदाता'),
  ('orgEntityKind', 'STATUTORY_AUTHORITY', 'Statutory development authority', 'सांविधिक विकास प्राधिकरण'),
  ('orgEntityKind', 'SPV', 'Special Purpose Vehicle (e.g. Smart City SPV)', 'विशेष प्रयोजन वाहन'),
  ('orgEntityKind', 'SEZ_AUTHORITY', 'SEZ Development Commissioner office', 'एसईजेड विकास आयुक्त कार्यालय'),
  ('orgEntityKind', 'TOWN_VENDING_COMMITTEE', 'Town Vending Committee', 'नगर विक्रय समिति'),
  ('orgEntityKind', 'CANTONMENT_BOARD', 'Cantonment Board', 'छावनी बोर्ड'),
  ('orgEntityKind', 'PSU_TOWNSHIP', 'PSU/enterprise township', 'पीएसयू टाउनशिप'),
  ('orgEntityKind', 'PORT_TRUST', 'Port Trust', 'पोर्ट ट्रस्ट')
ON CONFLICT (axis_code, code) DO NOTHING;

CREATE TABLE org.entities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id          text NOT NULL REFERENCES platform.scope_nodes(id),
  kind             text NOT NULL, -- platform.classification_values(axis_code='orgEntityKind').code; validated in the API, not FK'd (org predates a node's classification state, keep it loosely coupled)
  name_en          text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 300),
  name_hi          text NOT NULL CHECK (length(name_hi) BETWEEN 1 AND 300),
  parent_entity_id uuid REFERENCES org.entities(id),
  contact_en       text CHECK (contact_en IS NULL OR length(contact_en) <= 500),
  contact_hi       text CHECK (contact_hi IS NULL OR length(contact_hi) <= 500),
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entities_node ON org.entities (node_id) WHERE active;
CREATE INDEX entities_parent ON org.entities (parent_entity_id) WHERE active;

SELECT audit.create_outbox('org');

-- registry.services may now reference an org.entities row instead of (or
-- alongside, during transition) its free-text department_en/department_hi
-- fields. Nullable: existing rows and districts that haven't adopted the org
-- directory yet keep working unchanged.
ALTER TABLE registry.services ADD COLUMN entity_id uuid REFERENCES org.entities(id);
CREATE INDEX services_entity ON registry.services (entity_id) WHERE entity_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA org TO np_org_rw;
GRANT SELECT, INSERT, UPDATE ON org.entities TO np_org_rw;
GRANT INSERT ON org.audit_outbox TO np_org_rw;
GRANT USAGE ON SEQUENCE org.audit_outbox_id_seq TO np_org_rw;
GRANT USAGE ON SCHEMA platform TO np_org_rw;
GRANT SELECT ON platform.classification_axes, platform.classification_values TO np_org_rw;

GRANT USAGE ON SCHEMA org TO np_audit_relay;
GRANT SELECT, DELETE ON org.audit_outbox TO np_audit_relay;

-- The registry module may now read (and, through its own routes, set)
-- registry.services.entity_id by looking it up against org.entities.
GRANT USAGE ON SCHEMA org TO np_registry_rw;
GRANT SELECT ON org.entities TO np_registry_rw;
