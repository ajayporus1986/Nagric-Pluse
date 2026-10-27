-- 0005 Change-request targets, credential-reset kinds, and column-level grants
-- the platform module needs to apply approved identity changes.

-- A normalised description of what a change request touches, e.g.
-- "MODULE_SETTING:works" or "ROLE_GRANT:<userId>:OFFICER". Only one pending
-- request per (node, target) is allowed, so conflicting proposals cannot race.
ALTER TABLE platform.change_requests ADD COLUMN target_key text NOT NULL DEFAULT '';
ALTER TABLE platform.change_requests ALTER COLUMN target_key DROP DEFAULT;
CREATE UNIQUE INDEX change_requests_one_pending
  ON platform.change_requests (node_id, target_key) WHERE status = 'PENDING';

-- Outcome detail (error code when an approved change could not be applied).
ALTER TABLE platform.change_requests ADD COLUMN outcome jsonb;

-- Additional kinds: re-enable a disabled account, and reset a user's password
-- and authenticator. Both concern account takeover risk, so both need quorum.
ALTER TABLE platform.change_requests DROP CONSTRAINT change_requests_kind_check;
ALTER TABLE platform.change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN (
  'MODULE_SETTING','FEATURE_SETTING','REALM_SETTING','PERMISSION','ROLE_GRANT','ROLE_REVOKE',
  'KILL_SWITCH_RATIFY','QUORUM_CONFIG','USER_ENABLE','USER_RESET_CREDENTIALS'));

-- Applying USER_ENABLE / USER_RESET_CREDENTIALS happens in the platform
-- transaction that records the final approval, so the platform role gets
-- column-level UPDATE on exactly the columns those changes touch.
GRANT UPDATE (password_hash, password_changed_at, must_change_password, totp_secret_enc, totp_enrolled_at,
              totp_last_step, status, failed_logins, locked_until) ON iam.users TO np_platform_rw;
GRANT SELECT (id, user_id, revoked_at) ON iam.sessions TO np_platform_rw;
GRANT UPDATE (revoked_at, revoke_reason) ON iam.sessions TO np_platform_rw;
GRANT INSERT ON iam.audit_outbox TO np_platform_rw;
GRANT USAGE ON SEQUENCE iam.audit_outbox_id_seq TO np_platform_rw;

-- The worker expires change requests and kill switches through the platform role,
-- and cleans up expired sessions and rate-limit windows through the iam role.
-- (Grants already cover those tables; nothing else is needed.)

-- 0001 revoked PUBLIC access to schema public. The ltree and citext types and
-- operators live there, so each module role needs USAGE (not CREATE) on it.
GRANT USAGE ON SCHEMA public TO np_platform_rw, np_iam_rw, np_audit_relay, np_audit_reader;

-- The worker (platform role) expires pending change requests and kill switches.
-- Existing table grants cover this; listed here for reviewers.
