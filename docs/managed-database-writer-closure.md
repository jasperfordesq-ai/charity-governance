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

The [guarded shutdown prototype](managed-backend-maintenance.md) now composes
these component observations under a separate installation-wide one-attempt
control. Its native database proof uses synthetic provider transports and does
not close the remaining activation, custody, credential or host-loss gates.

## Database password invalidation while closed

`invalidatePasswords()` now requires the existing verified closure, NOLOGIN and
zero target sessions. It reads only `rolpassword IS NULL` booleans from
`pg_authid`, matching every exact role name/OID; it never retrieves a password
or verifier. Missing catalogue permission is a refusal, not an assumption that
the credentials were revoked. A single durable transaction clears non-null
passwords with `ALTER ROLE ... PASSWORD NULL`, then rereads identity, closure
and boolean states. Fresh post-commit readback is separate. Partial/late errors
roll back; lost commit acknowledgements remain unresolved. No old password is
restored and no LOGIN/replacement-secret method is exposed.

`observePasswordsInvalidated()` verifies both closure and null passwords and
returns a scoped digest. This invalidates PostgreSQL password authentication;
it does not rotate provider API tokens, certificates or other authentication
mechanisms. [PostgreSQL password authentication](https://www.postgresql.org/docs/16/auth-password.html)
documents the null-password refusal, and [ALTER ROLE](https://www.postgresql.org/docs/16/sql-alterrole.html)
defines the explicit PASSWORD NULL operation.

The real TLS PostgreSQL fixture proves catalogue-access refusal, no mutation
while LOGIN is enabled, atomic rollback, actual commit with lost acknowledgement,
idempotent observation, and a fixture-only LOGIN counterfactual: old password
fails while a replacement synthetic password succeeds through the same path.
The fixture restores NOLOGIN/PASSWORD NULL afterward. These test-only changes
are not a supported reopening or credential-delivery workflow.

The guarded shutdown plan is now protocol2 with an explicit
PASSWORD_NULL_WHILE_CLOSED policy. It invalidates passwords after session drain
and before final readback/recording; the independent control record stays
format1. A legacy closure-only plan cannot authorise this new step. Full
credentialRotationVerified staysfalse until fresh credentials are protected,
delivered, independently verified and used only by the authorised new release.
