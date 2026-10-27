-- 0001 Foundation: extensions, schemas, group roles, scope tree.
--
-- Login roles are NOT created here (they need passwords). Operators create one
-- login role per service and grant it the matching group role, e.g.
--   CREATE ROLE np_api_iam LOGIN PASSWORD '...' IN ROLE np_iam_rw;
-- See docs/database-roles.md.

CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_platform_rw') THEN CREATE ROLE np_platform_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_iam_rw') THEN CREATE ROLE np_iam_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_audit_relay') THEN CREATE ROLE np_audit_relay NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_audit_reader') THEN CREATE ROLE np_audit_reader NOLOGIN; END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA platform;
CREATE SCHEMA iam;
CREATE SCHEMA audit;

REVOKE ALL ON SCHEMA platform, iam, audit FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Jurisdiction tree (LGD). Shared reference data: every module may read it,
-- only the platform module writes it.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.scope_nodes (
  id          text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_]{1,64}$'),
  parent_id   text REFERENCES platform.scope_nodes(id),
  level       text NOT NULL CHECK (level IN ('NATION','STATE','DISTRICT','SUBDISTRICT','BLOCK','URBAN_BODY','AUTHORITY','WARD','VILLAGE')),
  lgd_code    text,
  name_en     text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  name_hi     text NOT NULL CHECK (length(name_hi) BETWEEN 1 AND 200),
  path        ltree NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((parent_id IS NULL) = (level = 'NATION'))
);
CREATE INDEX scope_nodes_path_gist ON platform.scope_nodes USING gist (path);
CREATE INDEX scope_nodes_parent ON platform.scope_nodes (parent_id);
CREATE UNIQUE INDEX scope_nodes_lgd ON platform.scope_nodes (level, lgd_code) WHERE lgd_code IS NOT NULL;

-- Path is always derived from the parent so it cannot be forged or drift.
CREATE FUNCTION platform.scope_nodes_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_path ltree;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := text2ltree(NEW.id);
  ELSE
    SELECT path INTO parent_path FROM platform.scope_nodes WHERE id = NEW.parent_id;
    IF parent_path IS NULL THEN RAISE EXCEPTION 'parent % not found', NEW.parent_id; END IF;
    NEW.path := parent_path || text2ltree(NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scope_nodes_path BEFORE INSERT ON platform.scope_nodes
  FOR EACH ROW EXECUTE FUNCTION platform.scope_nodes_set_path();

-- Re-parenting would silently move permissions and settings; forbid it.
CREATE FUNCTION platform.scope_nodes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.path <> OLD.path OR NEW.level <> OLD.level THEN
    RAISE EXCEPTION 'scope node identity, parent, path and level are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scope_nodes_immutable BEFORE UPDATE ON platform.scope_nodes
  FOR EACH ROW EXECUTE FUNCTION platform.scope_nodes_immutable();
