-- 0003 Staff identity and access (P0.3).

CREATE TABLE iam.users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             citext NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9._-]{3,64}$'),
  display_name         text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  email_enc            text,               -- field-encrypted (v1:iv:tag:ct)
  password_hash        text NOT NULL,      -- scrypt$N$r$p$salt$hash
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT true,
  totp_secret_enc      text,               -- field-encrypted; NULL until enrolled
  totp_enrolled_at     timestamptz,
  totp_last_step       bigint,             -- last accepted time step, prevents code replay
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  failed_logins        integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  preferred_locale     text NOT NULL DEFAULT 'hi' CHECK (preferred_locale IN ('hi','en')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid
);

CREATE TABLE iam.role_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES iam.users(id),
  role               text NOT NULL,
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  granted_by         uuid,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  change_request_id  uuid,               -- set when a quorum approved the grant
  revoked_at         timestamptz,
  revoked_by         uuid
);
CREATE UNIQUE INDEX role_assignments_active ON iam.role_assignments (user_id, role, node_id) WHERE revoked_at IS NULL;
CREATE INDEX role_assignments_user ON iam.role_assignments (user_id) WHERE revoked_at IS NULL;

CREATE TABLE iam.sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash           bytea NOT NULL UNIQUE,   -- SHA-256 of the cookie token; the token itself is never stored
  csrf_hash            bytea NOT NULL,
  user_id              uuid NOT NULL REFERENCES iam.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  mfa_verified_at      timestamptz,
  revoked_at           timestamptz,
  revoke_reason        text,
  ip                   inet,
  user_agent           text
);
CREATE INDEX sessions_user ON iam.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry ON iam.sessions (absolute_expires_at);

-- Fixed-window rate limits shared by every API replica.
CREATE TABLE iam.rate_limits (
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL
);

GRANT USAGE ON SCHEMA iam TO np_iam_rw;
GRANT SELECT, INSERT, UPDATE ON iam.users, iam.role_assignments, iam.sessions TO np_iam_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.rate_limits TO np_iam_rw;
GRANT DELETE ON iam.sessions TO np_iam_rw;
GRANT INSERT ON iam.audit_outbox TO np_iam_rw;
GRANT USAGE ON SEQUENCE iam.audit_outbox_id_seq TO np_iam_rw;
GRANT USAGE ON SCHEMA platform TO np_iam_rw;
GRANT SELECT ON platform.scope_nodes TO np_iam_rw;
