# Database roles

See the "Database roles" section of [operations.md](operations.md). Login roles are created by `apps/api/src/scripts/db-roles.ts` (run by the `migrate` service), never by migrations, because they carry passwords.
