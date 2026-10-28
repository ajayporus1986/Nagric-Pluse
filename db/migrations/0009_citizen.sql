-- 0009 Citizen module (P1.2): mobile-number + OTP self-service identity for
-- citizens, kept entirely separate from staff identity (iam.*). A citizen has
-- no role in the Lego permission model (roles there are for staff acting
-- within a jurisdiction); citizen self-service is instead switched on or off
-- per scope node through the ordinary module/feature toggle mechanism
-- (platform.module_settings / platform.feature_settings), exactly like any
-- other module, so a district can enable it only once ready.
--
-- A mobile number is personal data: it is stored only as a field-encrypted
-- value (mobile_number_enc) plus a SHA-256 lookup hash (mobile_hash), the same
-- pattern iam.users uses for email. The OTP itself is never stored in clear,
-- only its hash, with a short expiry and a bounded number of guesses.

CREATE SCHEMA citizen;
REVOKE ALL ON SCHEMA citizen FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'np_citizen_rw') THEN CREATE ROLE np_citizen_rw NOLOGIN; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Citizens: one row per mobile number. id is chosen by the application (not
-- DEFAULT gen_random_uuid()) so the mobile-number ciphertext can be bound to
-- it as AAD at insert time, the same binding pattern as iam.users' TOTP secret.
-- ---------------------------------------------------------------------------
CREATE TABLE citizen.citizens (
  id                 uuid PRIMARY KEY,
  mobile_hash        bytea NOT NULL UNIQUE,     -- SHA-256 of the normalised number; used for lookup, never reversed
  mobile_number_enc  text NOT NULL,             -- field-encrypted (v1:iv:tag:ct), AAD-bound to id
  display_name       text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  preferred_locale    text NOT NULL DEFAULT 'hi' CHECK (preferred_locale IN ('hi','en')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  -- Scope node where this citizen first verified an OTP (e.g. their district).
  -- Informational only: it does not restrict which node's services they may
  -- later use, it just records where self-service was switched on for them.
  registered_node_id text NOT NULL REFERENCES platform.scope_nodes(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at      timestamptz
);

-- ---------------------------------------------------------------------------
-- OTP challenges: one row per OTP sent. Never stores the OTP itself, only its
-- hash. attempts caps guessing (see citizen.otp_challenges_max_attempts in the
-- application); consumed_at is set exactly once, enforced by the partial
-- unique index below so a concurrent double-use is rejected, not raced.
-- ---------------------------------------------------------------------------
CREATE TABLE citizen.otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile_hash  bytea NOT NULL,
  purpose      text NOT NULL DEFAULT 'LOGIN' CHECK (purpose IN ('LOGIN')),
  otp_hash     bytea NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  -- Scope node the request was made at; used only to check that citizen
  -- self-service is switched on there (Lego gate) and recorded for audit.
  node_id      text NOT NULL REFERENCES platform.scope_nodes(id),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ip           inet
);
CREATE INDEX otp_challenges_mobile ON citizen.otp_challenges (mobile_hash, created_at DESC);
CREATE INDEX otp_challenges_expiry ON citizen.otp_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- Citizen sessions. Same cookie-token / SHA-256 / HMAC-CSRF design as staff
-- sessions (iam.sessions), but a wholly separate table and cookie name so a
-- citizen session can never be confused with, or escalate into, a staff one.
-- ---------------------------------------------------------------------------
CREATE TABLE citizen.sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash           bytea NOT NULL UNIQUE,
  csrf_hash            bytea NOT NULL,
  citizen_id           uuid NOT NULL REFERENCES citizen.citizens(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoke_reason        text,
  ip                   inet,
  user_agent           text
);
CREATE INDEX citizen_sessions_citizen ON citizen.sessions (citizen_id) WHERE revoked_at IS NULL;
CREATE INDEX citizen_sessions_expiry ON citizen.sessions (absolute_expires_at);

-- Fixed-window rate limits, kept in this schema (not iam.rate_limits) so the
-- citizen database role never needs any grant on the staff identity schema.
CREATE TABLE citizen.rate_limits (
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL
);

SELECT audit.create_outbox('citizen');

-- ---------------------------------------------------------------------------
-- Grants (least privilege). np_citizen_rw never receives any grant on iam.*,
-- registry.*, or platform.* beyond reading the scope-node list it needs to
-- validate node ids and check the Lego toggle.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA citizen TO np_citizen_rw;
GRANT SELECT, INSERT, UPDATE ON citizen.citizens, citizen.sessions TO np_citizen_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON citizen.otp_challenges, citizen.rate_limits TO np_citizen_rw;
GRANT DELETE ON citizen.sessions TO np_citizen_rw;
GRANT INSERT ON citizen.audit_outbox TO np_citizen_rw;
GRANT USAGE ON SEQUENCE citizen.audit_outbox_id_seq TO np_citizen_rw;
GRANT USAGE ON SCHEMA platform TO np_citizen_rw;
GRANT SELECT ON platform.scope_nodes TO np_citizen_rw;

-- The audit relay drains every module's outbox, including citizen's.
GRANT USAGE ON SCHEMA citizen TO np_audit_relay;
GRANT SELECT, DELETE ON citizen.audit_outbox TO np_audit_relay;
