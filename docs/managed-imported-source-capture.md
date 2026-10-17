# Original canonical capture actions with an imported snapshot

17 October 2026. Internal supervised capture preparation and synthetic native
proof. No hosted activation, deployment, new provider access or tenant changes.
The full delegated multi-organisation goal remains active.

## Decision

Reuse the original `scripts/postgres-backup.mjs` canonical source action and
fingerprint action. A second implementation of row/schema hashes would weaken the
connection to existing archive admission. `prepareSnapshotFingerprintCapture`
prepares those original programs with an explicit imported snapshot for source
dumps; it never silently chooses a fresh source snapshot.

The original `prove-restore` CLI, report-v2 contracts and default snapshot holder
are unchanged. This internal function renders a program/environment for a trusted
supervised runner; it is not a new supported operator command, remote execution
endpoint, activated backup job or recovery permission.

## Inputs and fail-closed ordering

The internal preparation function takes a TLS verify-full PostgreSQL URL with a
root-certificate setting, separately supplied endpoint identity hash, safe report
and optional dump filenames, bounded existing temp-file limit and original
`ManagedDatabaseSnapshot` descriptor. A source dump requires that descriptor.
Fresh independent fingerprint-only preparation remains available for the isolated
restored database. Inputs use the existing canonical bounds and safe filenames.

The imported holder begins REPEATABLE READ READ ONLY and imports the original
snapshot before any SQL query. It then verifies current database/name/OID and the
presence of an active exporting transaction with the declared PID, database OID
and observer OID. Mismatch refuses before dump/fingerprint actions. This checks
visible scope and exporter presence; it does not cryptographically attest the
snapshot's PID ownership or independent provider/cluster identity. Those remain
separate trust and deployment evidence.

The holder retains original canonical settings, public-table ACCESS SHARE locks,
public-table presence check, workload bounds and re-export for its child actions.
The existing dump and canonical fingerprint subprocesses import that re-exported
view, which derives from the original guarded metadata interval. The original
source-size-aware capacity preflight, dump size cap, sequence/unsupported-object
refusals and row/schema/metadata fingerprint projections remain intact.

Snapshot and scope values enter psql through quoted variable parameters, not SQL
string concatenation. Raw IDs and database credentials exist only in the returned
secret-bearing environment, not embedded in the returned script. Callers must not
print/persist that environment. It contains only explicit original action inputs
plus imported-snapshot scope, not arbitrary ambient CHARITYPILOT/host variables.
Validation errors are sanitised and carry no raw cause. The returned program
sets `actionAuthorized:false`; saved data never grants execution.

## Native executed path

The existing TLS PostgreSQL fixture now uses this original program instead of a
separate plain pg_dump command. It exports after the configured metadata lock,
commits later application rows, then imports the original view in the canonical
source holder. Wrong declared database OID refuses before a source action.

The actual custom-format dump and canonical source fingerprints are produced.
The public snapshot sentinel has one row, although a fresh view has two. A minimal
synthetic public.Document row points at the captured file, and its SQL metadata
projection hash equals the existing independent JS canonical metadata-row hash.
The actual Supabase file-capture class still uses synthetic HTTP/file records.
The fixture's lock covers its declared Storage-like metadata relation; this does
not claim all Document or provider writers are independently fenced.

After restoring that dump into a separate disposable database, the original fresh
fingerprint program produces matching public schema, table membership, row and
Document metadata fingerprints. Restored application rows omit the after-export
sentinels, and the restored metadata matches the captured file bytes. Expired
original snapshot import still refuses. These are real PostgreSQL dump/import/
fingerprint/restore operations over synthetic records, not actual cloud storage
custody or source-host-off recovery.

## Remaining integration

There is still no complete canonical report-v2 publication from this supervised
path. `ArchivedRecoverySets` continues to require the full original isolated
restore/dump descriptor, exact source-helper release, identity/capacity and
public.Document proof. Do not construct a permissive report from the returned
program or interval flags, and do not relax those admission assertions.

A production runner must preserve exact-release/helper binding, protected output
files and descriptors, actual endpoint/certificate/provider identity, bounded
process/lease lifetime and cleanup evidence, and genuine complete source/restore
report construction. Join encrypted database custody and exact file receipts with
the existing authenticated index/root and independent discovery. Actual provider
writer/in-flight/control-plane exclusion, current preservation/disposal authority,
independent root/epoch custody, full application quarantine/replacement and real
provider/source-host-off/reopening proof remain open. Nikita's further personal
review remains optional.
