-- 0008 Adds SERVICE_SLA_SET as a change-request kind, so a notified service's
-- statutory time limit (registry.services.sla_days) can only change through
-- the same Realm Governor quorum as every other Lego setting.
ALTER TABLE platform.change_requests DROP CONSTRAINT change_requests_kind_check;
ALTER TABLE platform.change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN (
  'MODULE_SETTING','FEATURE_SETTING','REALM_SETTING','PERMISSION','ROLE_GRANT','ROLE_REVOKE',
  'KILL_SWITCH_RATIFY','QUORUM_CONFIG','USER_ENABLE','USER_RESET_CREDENTIALS','USER_DISABLE','SERVICE_SLA_SET'));
