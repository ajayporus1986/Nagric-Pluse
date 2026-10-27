-- 0002 Audit ledger: append-only, hash-chained, with signed checkpoints.
--
-- Modules never write the ledger directly. Each module writes events to its own
-- <schema>.audit_outbox inside the same transaction as the business change
-- (so an action and its audit record commit or roll back together). The worker
-- relays outbox rows into audit.ledger in order.

CREATE TABLE audit.ledger (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id      uuid NOT NULL UNIQUE,
  source        text NOT NULL,            -- module id that produced the event
  occurred_at   timestamptz NOT NULL,     -- when the action happened (from the outbox)
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id      uuid,                     -- staff user; NULL for system or anonymous citizen
  actor_roles   text[] NOT NULL DEFAULT '{}',
  action        text NOT NULL,            -- e.g. iam.login.success, platform.change_request.approved
  feature_code  text,
  scope_path    text,
  target_type   text,
  target_id     text,
  decision      text CHECK (decision IN ('BLOCK','LIMIT','ALLOW_AUDITED','ALLOW')),
  ip            inet,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     bytea NOT NULL,
  hash          bytea NOT NULL UNIQUE
);
CREATE INDEX ledger_actor ON audit.ledger (actor_id, seq);
CREATE INDEX ledger_action ON audit.ledger (action, seq);
CREATE INDEX ledger_target ON audit.ledger (target_type, target_id);
CREATE INDEX ledger_recorded ON audit.ledger (recorded_at);

-- Canonical text of a row, the input to the hash. jsonb text output is normalised
-- (sorted keys, no duplicate keys), so the same event always hashes the same.
CREATE FUNCTION audit.canonical(l audit.ledger) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'seq', l.seq, 'event_id', l.event_id, 'source', l.source,
    'occurred_at', to_char(l.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'recorded_at', to_char(l.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_id', l.actor_id, 'actor_roles', to_jsonb(l.actor_roles), 'action', l.action,
    'feature_code', l.feature_code, 'scope_path', l.scope_path, 'target_type', l.target_type,
    'target_id', l.target_id, 'decision', l.decision, 'ip', host(l.ip), 'detail', l.detail
  )::text
$$;

CREATE FUNCTION audit.ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_hash bytea;
BEGIN
  -- Serialise appends so the chain has no forks. Writers must use READ COMMITTED
  -- so the SELECT below sees the row committed by the previous lock holder.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit.ledger inserts require READ COMMITTED isolation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('audit.ledger.chain'));
  SELECT hash INTO last_hash FROM audit.ledger ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := coalesce(last_hash, decode(repeat('00', 32), 'hex'));
  NEW.recorded_at := clock_timestamp();
  NEW.hash := sha256(NEW.prev_hash || convert_to(audit.canonical(NEW), 'UTF8'));
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_chain BEFORE INSERT ON audit.ledger FOR EACH ROW EXECUTE FUNCTION audit.ledger_chain();

CREATE FUNCTION audit.ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.ledger is append-only (% refused)', TG_OP;
END $$;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON audit.ledger FOR EACH ROW EXECUTE FUNCTION audit.ledger_append_only();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON audit.ledger FOR EACH STATEMENT EXECUTE FUNCTION audit.ledger_append_only();

-- Recompute the chain between two sequence numbers. Returns the first broken seq, or NULL if intact.
CREATE FUNCTION audit.verify_chain(from_seq bigint DEFAULT 1, to_seq bigint DEFAULT NULL)
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint) LANGUAGE plpgsql STABLE AS $$
DECLARE r audit.ledger; expected_prev bytea; n bigint := 0;
BEGIN
  SELECT hash INTO expected_prev FROM audit.ledger WHERE seq < from_seq ORDER BY seq DESC LIMIT 1;
  expected_prev := coalesce(expected_prev, decode(repeat('00', 32), 'hex'));
  FOR r IN SELECT * FROM audit.ledger WHERE seq >= from_seq AND (to_seq IS NULL OR seq <= to_seq) ORDER BY seq LOOP
    n := n + 1;
    IF r.prev_hash <> expected_prev OR r.hash <> sha256(r.prev_hash || convert_to(audit.canonical(r), 'UTF8')) THEN
      RETURN QUERY SELECT false, n, r.seq; RETURN;
    END IF;
    expected_prev := r.hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint;
END $$;

-- Signed checkpoints. The Ed25519 key lives outside the database (worker host /
-- KMS); the public key is published so anyone can verify.
CREATE TABLE audit.checkpoints (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  up_to_seq   bigint NOT NULL UNIQUE REFERENCES audit.ledger(seq),
  ledger_hash bytea NOT NULL,
  key_id      text NOT NULL,
  signature   bytea NOT NULL,
  signed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER checkpoints_no_update BEFORE UPDATE OR DELETE ON audit.checkpoints FOR EACH ROW EXECUTE FUNCTION audit.ledger_append_only();
CREATE TRIGGER checkpoints_no_truncate BEFORE TRUNCATE ON audit.checkpoints FOR EACH STATEMENT EXECUTE FUNCTION audit.ledger_append_only();

CREATE TABLE audit.signing_keys (
  key_id      text PRIMARY KEY,
  public_key  text NOT NULL,       -- SPKI PEM
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);

-- Outbox template, created per module schema.
CREATE FUNCTION audit.create_outbox(schema_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($f$
    CREATE TABLE %I.audit_outbox (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id     uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor_id     uuid,
      actor_roles  text[] NOT NULL DEFAULT '{}',
      action       text NOT NULL,
      feature_code text,
      scope_path   text,
      target_type  text,
      target_id    text,
      decision     text CHECK (decision IN ('BLOCK','LIMIT','ALLOW_AUDITED','ALLOW')),
      ip           inet,
      detail       jsonb NOT NULL DEFAULT '{}'::jsonb
    )$f$, schema_name);
END $$;

SELECT audit.create_outbox('platform');
SELECT audit.create_outbox('iam');

-- Grants. Relay: read+delete outboxes, insert ledger. Readers: select only.
GRANT USAGE ON SCHEMA audit TO np_audit_relay, np_audit_reader;
GRANT INSERT, SELECT ON audit.ledger TO np_audit_relay;
GRANT INSERT, SELECT ON audit.checkpoints TO np_audit_relay;
GRANT SELECT ON audit.signing_keys TO np_audit_relay;
GRANT SELECT ON audit.ledger, audit.checkpoints, audit.signing_keys TO np_audit_reader;
GRANT EXECUTE ON FUNCTION audit.verify_chain(bigint, bigint) TO np_audit_reader, np_audit_relay;
GRANT USAGE ON SCHEMA platform, iam TO np_audit_relay;
GRANT SELECT, DELETE ON platform.audit_outbox, iam.audit_outbox TO np_audit_relay;
REVOKE TRUNCATE ON audit.ledger, audit.checkpoints FROM PUBLIC;
