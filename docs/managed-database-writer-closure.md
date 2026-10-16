# Managed database writer closure

This internal maintenance primitive is one component of the managed whole-backend
recovery plan in [product governance decisions](product-governance-decisions.md).
It is not activated by an API route, worker, CLI or operator recovery command.

`ManagedDatabaseWriterFence` requires a separately trusted registry of exact
cluster role and database names/OIDs, including explicit trusted custodians.
The caller must supply a verified canonical TLS connection and coordinate the
maintenance operation so custodians do not concurrently change the registry.
SQL verifies encryption, primary identity and durable WAL settings; SQL alone
cannot attest the peer certificate, vendor custody or all possible writers.

## Closure ordering

1. Refuse mismatched identities, elevated writer attributes, upward memberships,
   unlisted LOGIN aliases able to assume a writer, cross-database dependencies or
   sessions, prepared transactions and oversized session inventories.
2. Commit NOLOGIN for the configured writers before draining their sessions.
3. Terminate only sessions matching the original PID, role OID, database OID and
   exact server backend-start timestamp; then use a fresh readback to verify
   NOLOGIN and zero remaining sessions. NOLOGIN alone leaves old sessions alive.
4. An unknown commit or termination outcome stays unresolved. Never compensate by
   restoring LOGIN. A later explicit call may observe/drain already closed roles;
   there is no reopening method. Preserve prepared transactions for investigation.

The observation digest is unkeyed and is not an authorisation or independently
held receipt. Its scope is CONFIGURED_DATABASE_PRINCIPALS_ONLY. Source-host
fencing, provider-job fencing, whole-backend quiescence and reopening authority
are explicitly false. Custodians remain powerful trusted actors.

## Verification and integration remaining

The disposable PostgreSQL 16 fixture uses verified local Docker, temporary TLS,
actual Prisma connections and synthetic data. It demonstrates old-session writes
after a lost NOLOGIN commit acknowledgement, LOGIN-alias bypass refusal, prepared
and cross-database refusal, fresh-login denial, draining, repeated observation and
preservation of source rows. It is wired into CI and the runtime-role test gate.
The runtime probe also checks all eight maintenance functions, including the
three V2 functions; a real PUBLIC EXECUTE fault on V2 rows is rejected.

Integration still needs coordinated suspension of every service/scheduler/job,
credential rotation, provider lifecycle and independent-history authority,
document-byte recovery, actual custody and source-host-unavailable/reopening
proof. This primitive provides none of those by itself. No database migration,
restore-inventory change, vendor operation or live role modification is included.
