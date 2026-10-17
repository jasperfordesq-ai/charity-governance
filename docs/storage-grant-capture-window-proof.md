# Storage grants and capture-window proof

17 October 2026. Test-only PostgreSQL evidence; no hosted Supabase privileges,
keys, policies, records or deployment were changed. This is a design constraint,
not a supported live operator procedure or completed whole-backend fence.

## Pinned upstream source

Reviewed Supabase Storage source revision
`c826a70ac6e6f56d3e6033ccb164fb1ff5282570`; this is not an attestation of the
managed service's deployed revision or enabled features.

The uploader checks caller permission separately from privileged completion.
Object bytes can be written before the final database transaction; completion
uses a privileged transaction and a caller permission probe. Cleanup can be
queued separately. SQL metadata consistency alone therefore cannot establish
object-byte or cleanup-worker quiescence.
[Uploader source](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/storage/uploader.ts).

The database adapter preserves caller context across privileged operations and
implements permission testing through a transaction that is rolled back. The
transaction scope sets the database role and request claims locally. A successful
caller probe is not an inventory of every effective writer.
[Database adapter](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/storage/database/pg.ts),
[transaction scope](https://github.com/supabase/storage/blob/c826a70ac6e6f56d3e6033ccb164fb1ff5282570/src/internal/database/postgres/scope.ts).

## Executed native counterexamples and positive controls

`scripts/storage-grant-boundary-postgres-proof.mjs` runs inside the existing
loopback-only, TLS, disposable PostgreSQL fixture, after the existing managed
maintenance cases. It refuses a different database-name pattern, non-loopback
endpoint, non-postgres custodian or non-TLS connection. All records and passwords
are synthetic. It is not a Supabase schema migration.

| Experiment | Observed result | Consequence |
| --- | --- | --- |
| BYPASSRLS role with ordinary DML grants | Actual INSERT succeeds despite forced RLS and no policy | RLS alone does not make capture read-only |
| Revoke table DML while an authorised INSERT transaction remains open | Grant check becomes false, but the prior transaction subsequently commits | A grant acknowledgement alone does not drain prior writes |
| Column INSERT, SECURITY DEFINER function, NOINHERIT membership | Column grant, executable privileged function and explicit SET ROLE each permit actual writes | Table ACL inspection alone is incomplete |
| Exclusive relation lock before revoke | Exact pending lock observed in pg_locks; lock waits for writer commit, then revocation commits; same capture connection reads successfully and INSERT/UPDATE/DELETE fail with 42501 | Lock/drain ordering is testable and requires positive reads plus negative writes |
| Separate privileged custodian after revoke | Actual write still succeeds | Scoped capture-role closure is not a global actor fence |
| SHARE read window | Exact privileged RowExclusiveLock observed waiting; capture SELECT succeeds, pending row absent; writer commits after window release | A temporary read-compatible relation window can block this SQL writer, but does not permanently remove its authority |

PostgreSQL documents the relevant lock conflicts and RLS bypass semantics:
[LOCK](https://www.postgresql.org/docs/16/sql-lock.html),
[row security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html).

Final local run: existing native runner passed 1 top-level test, 0 failures,
0 skipped, 17,521.847 ms, including the existing 39 protocol9 scenarios and four
additional storage-boundary experiments. Private receipt:
`storage-grant-boundary-native-final-20261017.log`.

## Engineering decision and remaining work

Require an inventory of effective table AND column grants, role membership and
SET ROLE, executable privileged functions, relation owners and privileged actors.
A future metadata-capture boundary also needs an observed read-compatible window
covering the actual relations and capture interval, including failure/release
handling. Do not substitute standalone REVOKE or a read-only transaction for that
boundary. Do not run this fixture SQL against a live managed project.

Before implementing a provider adapter, establish the supported provider contract,
actual Storage database/relations and deployed release, and verify its HTTP data
path. Account separately for writes to object bytes, background cleanup, in-flight
uploads/multipart, privileged/control-plane actors and current credential issuers.
The experiment does not freeze any of those paths, prove common database/file
snapshot consistency, or authorise cloud changes. Protocol9's original positive
controls must remain valid; a later capture window is a separate phase.

The full multi-organisation goal remains active. Continue from
[remaining boundaries](managed-writer-capture-audit-2026-10-17.md) and
[protocol9 S3 integration](durable-s3-maintenance.md). Further personal DPO review
is optional; engineering evidence and accurate scope remain required.
