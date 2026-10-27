-- 0006 Disabling an account that holds an oversight (sensitive) role needs a quorum.
-- Without this, one Realm Governor could disable every other governor and leave
-- the district with nobody able to approve anything.
ALTER TABLE platform.change_requests DROP CONSTRAINT change_requests_kind_check;
ALTER TABLE platform.change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN (
  'MODULE_SETTING','FEATURE_SETTING','REALM_SETTING','PERMISSION','ROLE_GRANT','ROLE_REVOKE',
  'KILL_SWITCH_RATIFY','QUORUM_CONFIG','USER_ENABLE','USER_RESET_CREDENTIALS','USER_DISABLE'));
