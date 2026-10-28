# Security policy

Nagrik Pulse handles citizen grievances, identities and whistleblower reports. Security and data protection are release blockers, not follow-ups.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). We aim to acknowledge within 2 working days.

## Rules for this codebase

- **No secrets in git.** Keys, passwords and tokens come from the environment or a secrets manager. `.env*` files (except `.env.example`) are ignored; gitleaks runs on every push.
- **No default credentials.** The first administrator is created with the `admin:bootstrap` CLI on the server, never through the web.
- **Staff sign-in needs two factors.** Password (scrypt) plus TOTP; passkeys next. Sessions are opaque random tokens stored only as hashes.
- **Default deny.** Every API route declares a feature code and action; routes without one fail to register. The policy resolver decides; the UI only reflects its capability map.
- **Personal data is encrypted at field level** (AES-256-GCM with key ids so keys can rotate) and never written to logs (pino redaction).
- **Audit is append-only.** The audit ledger is hash-chained, protected by a trigger against UPDATE/DELETE, and checkpointed with an Ed25519 signature whose key is kept outside the database.
- **Least privilege in the database.** Each module connects with its own Postgres role that can reach only its own schema.
- **Reviews.** `main` is protected: pull request, passing CI (tests, lint, typecheck, CodeQL, gitleaks, dependency audit) and one approving review.

## Supported versions

Only the latest release on `main` receives security fixes.
