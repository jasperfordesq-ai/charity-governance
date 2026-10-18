# Capture role catalogue window

An explicit internal `ManagedStorageDatabaseInventory.runCaptureRoleWindow`
operation holds PostgreSQL 16 catalogue SHARE locks while a bounded capture
callback runs. It verifies the configured TLS/database/observer before locking,
then observes the dedicated role after all locks have been acquired. The
transaction uses Read Committed so a prior DCL commit cannot be hidden by an
older Repeatable Read snapshot. The fixed lock order follows catalogue OIDs.

The eight catalogues are pg_attribute, pg_proc, pg_class, pg_authid,
pg_auth_members, pg_database, pg_namespace and pg_policy. They cover the role,
membership, ownership, table/column ACL, routine, schema/database privilege and
RLS metadata predicates inspected by the role boundary. DCL may release catalogue
relation locks at command end before its transaction commits. After acquiring
the locks, the window therefore refuses any other assigned transaction still
holding its transaction-ID lock. This includes prepared transactions with no PID
and transactions in other databases, because role catalogues are shared. A fresh
Read Committed observation follows that entry barrier. This conservative check
can also refuse unrelated active writes; it does not terminate or retry them.
Existing incompatible writers must finish before entry; lock acquisition times out rather than letting
the callback run without its locks. No function body or role password is read.

The callback receives only frozen configured role identity and a cancellation
signal. No transaction client or SQL operation is exposed. A 1–30 second window,
250 ms connection/lock checks and final predicate/lock checks bound execution.
Cancellation, expiry, callback failure, connection loss, missing locks and late
or unknown transaction acknowledgement discard the candidate. Callers must
propagate cancellation; the capture class zeros visitor buffers on cancellation.
Locks end with the original transaction, and returned evidence states that the
window is no longer held. It grants no retry or restore authority.

`SupabaseRecoveryCapture.captureWithSqlRoleWindow` requires the asymmetric JWT
mode and an exact match between its configured role name/OID and the live SQL
observation. It returns a separate `SUPABASE_SQL_ROLE_WINDOW_CANDIDATE_V1` report.
Legacy maintenance/archive authorization still refuses that mode pending its
own versioned protocol. Existing ordinary observations and captures remain
available with their explicit weaker evidence.

## Operational and proof limits

Catalogue locking requires existing permission and can block unrelated DDL,
role management and metadata writes. Shared role/database catalogues affect the
cluster. A DDL actor may also hold user-table locks while waiting, so capture can
fail or time out; availability is not guaranteed. No permissions are provisioned,
no provider is enabled, and no route or scheduled job activates this operation.
Unsupported managed-host permissions must fail closed. Do not grant broader
provider authority merely to make this component run.

The positive claim is limited to changes to these listed SQL catalogues during
the original callback. It does not prove hosted token/key currency, current
Storage process identity, complete RLS visibility, all byte writers, external
management-plane exclusion, arbitrary external function effects, or physical
host-loss recovery. Other database contents and object bytes are not locked by
this component. No global quiescence, complete read-only credential, provider
identity or action-authorization claim becomes true.

## Primary references

PostgreSQL documents [lock conflicts](https://www.postgresql.org/docs/16/explicit-locking.html)
and [cluster-wide role metadata](https://www.postgresql.org/docs/16/catalog-pg-authid.html).
The reviewed PostgreSQL 16 [ACL implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/catalog/aclchk.c)
opens relation/attribute catalogues with RowExclusiveLock for grants, and
[role management](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/commands/user.c)
uses the role catalogues for role changes. Executable native tests, rather than
these source references alone, establish the bounded behavior in the disposable
PostgreSQL fixture. Hosted provider proof remains separate.

## Executed synthetic verification — 18 October 2026

The native TLS PostgreSQL cohort passed the configured asymmetric JWT/SQL role
join, exact-OID mismatch refusal before HTTP, visitor-buffer clearing on
cancellation, positive RLS reads and actual mutation refusal. Nine concurrent
DCL/DDL actors were observed waiting on the catalogue locks until callback
completion. A previously completed but uncommitted GRANT, a prepared GRANT and
an observer lacking catalogue-lock permission all refused before callback entry.
Real deadline expiry, caller cancellation, termination of the actual holding
backend and callback failure discarded the result and released its locks.

The first native attempt exposed the command-end lock release gap; the assigned
transaction barrier was implemented and the same counterexample then passed.
All previous SQL writer/metadata-window/managed-capture regressions passed in
the final cohort. These are original disposable database observations, not
hosted Supabase or physical-host-loss evidence. Exact source revisions and logs
are recorded in the ignored private handoff; the running release is recorded
separately. No provider privilege is inferred from these tests.
