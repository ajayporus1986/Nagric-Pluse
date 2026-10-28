# Operations guide (Phase 0)

## Components

| Process | Image / command | Talks to |
| --- | --- | --- |
| `db` | `postgres:16` | — |
| `migrate` (one-shot) | `api` image, `migrate.js` then `db-roles.js` | db as schema owner |
| `api` | `api` image, `dist/server.js` | db as `np_platform`, `np_iam`, `np_audit`, `np_registry`, `np_citizen`, `np_org`, `np_intake` |
| `worker` | `api` image, `dist/worker/main.js` | db as `np_relay`, `np_platform`, `np_iam`, `np_citizen`, `np_org`, `np_intake` |
| `web` | nginx serving the console, proxying `/api` | api |

The API is stateless: run as many replicas as needed behind the web tier. Sessions, rate limits and policy live in Postgres; replicas pick up policy changes within about 100 ms through `LISTEN/NOTIFY`.

## First deployment of a district

```bash
cp docker/.env.example docker/.env            # fill in every secret
mkdir -p docker/secrets
openssl genpkey -algorithm ed25519 -out docker/secrets/audit-signing.pem
sudo chown 1000:1000 docker/secrets/audit-signing.pem && chmod 600 docker/secrets/audit-signing.pem  # only the container user (uid 1000) can read it
cd docker
docker compose --env-file .env up -d --build  # migrations and DB roles run automatically
# Register the audit signing public key (the private key never enters the database)
docker compose --env-file .env run --rm -v $PWD/secrets:/secrets:ro migrate \
  node dist/scripts/audit-key.js register /secrets/audit-signing.pem
# One-time bootstrap: district tree + first accounts (needs enough governors for quorum)
docker compose --env-file .env run --rm migrate node dist/scripts/bootstrap.js \
  --district districts/UP-144/district.json \
  --user "gov1|Full Name|REALM_GOVERNOR|D144" \
  --user "gov2|Full Name|REALM_GOVERNOR|D144" \
  --user "ops1|Ops Team|PLATFORM_OPERATOR|D144"
```

The bootstrap prints one-time passwords once. Hand them over in person. Each user must set a new password and enrol an authenticator app at first sign-in. After bootstrap, every role grant goes through quorum change requests; the bootstrap refuses to run again.

## Database roles

Migrations create NOLOGIN group roles with least-privilege grants. `db-roles.js` creates one LOGIN role per service and makes it a member of exactly one group:

| Login role | Group | Can do |
| --- | --- | --- |
| `np_platform` | `np_platform_rw` | Lego registry, change requests, kill switches; column-limited writes to accounts for approved resets, and to `registry.services.sla_days` for approved SLA changes |
| `np_iam` | `np_iam_rw` | accounts, sessions, rate limits |
| `np_audit` | `np_audit_reader` | read the audit ledger, run `verify_chain()` |
| `np_relay` | `np_audit_relay` | move outbox rows into the ledger, write signed checkpoints |
| `np_registry` | `np_registry_rw` | offices, posts, post holders, notified services (not `sla_days`, which only the platform role changes, and only via an approved change request) |
| `np_citizen` | `np_citizen_rw` | citizen identity, OTP challenges, citizen sessions and rate limits — never touches `iam.*`, `registry.*` or any staff table |
| `np_org` | `np_org_rw` | the org directory (`org.entities`): departments, statutory authorities, SPVs, SEZ offices and other service providers that `registry.services` and future modules reference |
| `np_intake` | `np_intake_rw` | grievance intake (`intake.grievances`, `intake.grievance_events`): citizen/business/anonymous filings, their status history, and a read-only lookup into `registry.services`, `org.entities` and `citizen.citizens` needed at filing time |

No service role can UPDATE or DELETE the audit ledger; triggers refuse it even for the owner.

## Logs and debugging

All processes log one JSON object per line to stdout.

| Field | Meaning |
| --- | --- |
| `service` | `api`, `worker`, `bootstrap` |
| `reqId` | request id; also returned in the `x-request-id` header and shown in the console as "reference" |
| `errCode` | catalogue code, see [error-codes.md](error-codes.md) |
| `userId` | staff user id (never names, passwords, codes or tokens; these are redacted) |
| `route`, `status`, `ms`, `decision` | one access-log line per request |
| `detail` | internal context for the failure (never shown to users) |

To trace a user's report: take the reference from the screen and run
`docker compose logs api | grep <reference>`. Faults (`level` ≥ 50) include the stack trace; expected user errors (wrong password, validation) log only the code and context.

Client-side failures in the console are reported to `/api/v1/client-logs` and appear with `source: "web"`.

Audit verification failures log at `fatal` with `NP-AUDIT-0001` (chain broken) or `NP-AUDIT-0003` (checkpoint signature or hash mismatch). Treat either as a security incident.

## Keys

- **Field encryption** (`FIELD_ENCRYPTION_KEYS`): add a new key id, switch `FIELD_ENCRYPTION_ACTIVE_KEY` to it, restart. Old values still decrypt; new values use the new key. Remove an old key only after re-encrypting its data.
- **Audit signing key**: generate a new Ed25519 key, `audit-key register` it, point the worker at it, then `audit-key retire <old-id>`. Old checkpoints keep verifying with the retired public key.

## Citizen OTP delivery

`SMS_PROVIDER` picks how the citizen module delivers sign-in codes:

- `console` only logs the code (labelled as a stub). Refused at startup in production.
- `webhook` HTTPS-POSTs an HMAC-signed `{mobile, otp, purpose, requestId}` payload to `SMS_WEBHOOK_URL`, signed with `SMS_WEBHOOK_SECRET` (header `x-np-signature`, `HMAC-SHA256("<x-np-timestamp>.<body>")`). That endpoint is expected to be the operator's own bridge into whichever SMS gateway they hold an account with; this project does not wire in a gateway SDK directly, since no account or credential format has been confirmed for one.

`OTP_TTL_SECONDS` and `OTP_MAX_ATTEMPTS` are ordinary config, not Lego settings, the same way session lifetimes are: they are operational/security parameters, not civic data that varies per district.

## Capacity (measured)

Single API replica on 2 shared vCPUs (Postgres, nginx and the load generator on the same machine), 50 concurrent connections, authenticated requests:

| Endpoint | Throughput | p50 | p99 | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/v1/capabilities` | 731 req/s | 64 ms | 139 ms | 0 |
| `GET /api/v1/modules` | 677 req/s | 67 ms | 162 ms | 0 |

The read target (1,000 req/s) needs a second API replica or more cores; the API is stateless, so it scales horizontally. Intake write targets are measured in Phase 1, when intake exists.

## Backups

Run continuous WAL archiving (e.g. pgBackRest) to meet the 15-minute recovery point. Back up `docker/secrets/` and the encryption key ring separately from the database: a database backup without the keys cannot reveal encrypted fields, and keys without the backup reveal nothing.
