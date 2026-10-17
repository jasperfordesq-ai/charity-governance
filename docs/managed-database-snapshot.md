## 17 October: original canonical source actions import the guarded snapshot

Read [imported source capture](managed-imported-source-capture.md). The original
backup helper now prepares its existing dump/fingerprint actions against an
explicit imported snapshot, checking database/exporter scope before capture.
Native source and restored public fingerprints, including Document metadata,
match and exclude later application rows. This is not complete report-v2/root
publication, real provider custody or host-loss proof; the full goal stays active.

# Database snapshot inside the guarded metadata interval

17 October 2026. Internal source component and synthetic native integration.
No hosted activation, cloud resources, new grants, tenant policy or deployment.
The full delegated multi-organisation goal remains active.

## Decision and provider contract

PostgreSQL16 supports exporting a transaction snapshot for concurrent sessions.
The snapshot can be imported only while its exporting transaction remains open.
[PostgreSQL snapshot functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)
describe why export is meaningful in Read Committed transactions too. The
[`pg_dump --snapshot` contract](https://www.postgresql.org/docs/16/app-pgdump.html)
allows the dump to import that particular view instead of choosing a new one.
These contracts establish PostgreSQL behaviour, not this application's actual
managed provider identity, privileges, release or object-store write exclusion.

Reuse the existing metadata-window transaction rather than create a second,
independently timed transaction. Export **after** all configured exact-OID SHARE
locks have been acquired and rechecked. A snapshot exported before those locks
could precede a write that the later file inventory observes.

## Source contract

`ManagedStorageMetadataWindow.runWithSnapshot(callback, optionalAbortSignal)`
uses the same bounded TLS PostgreSQL16 identity, relation, lock, heartbeat and
cancellation checks as `run`. It exports exactly one snapshot after the lock
barrier and passes a frozen ephemeral descriptor plus the cancellation signal to
the callback. The descriptor includes snapshot ID, database/OID, observer OID and
holder PID. It exposes no Prisma transaction or arbitrary SQL executor.

The callback must import that snapshot in its database consumer and await all
work before returning. The transaction remains open through the callback and the
final identity/lock check. Consumer failure, cancellation, malformed export,
missing/changed identity, heartbeat loss or unknown transaction acknowledgement
cannot yield successful interval evidence. No automatic retry or replay exists.

The returned `databaseSnapshot` evidence contains a domain-separated descriptor
hash and the original window ID/configuration digest, with no raw snapshot ID.
The callback value belongs to the caller; the generic API cannot prevent callers
from retaining the ephemeral descriptor. A saved hash is not an import token,
provider signature, database dump receipt or admission permission. It reports
`importedByConsumerVerified`, `snapshotStillImportable`, `nonMvccStateCaptured`,
`wholeBackendQuiesced` and `actionAuthorized` as false. In particular, the window
cannot infer that a caller really supplied `--snapshot` merely because it
received the identifier. Native integration must verify that separately.

Ordinary `run`, its evidence format1 and configuration digest remain unchanged.
Default protocol9 maintenance and candidateV2 journal records are unchanged.
This does not silently activate a database capture in the file-only coordinator
or claim its old reports contain a dump or common capture proof.

## Executed native integration

The existing managed fence native proof now additionally runs
`scripts/managed-database-snapshot-postgres-proof.mjs` in its disposable TLS
PostgreSQL16 fixture. It creates a synthetic schema with one metadata row and
application row; the window locks the metadata relation, then exports. An
unrelated application row commits after export and before actual `pg_dump`.

The asynchronous dump process imports that exact snapshot while the transaction
is open. It is followed by the actual Supabase file-capture class, using synthetic
HTTP responses whose bytes match the locked metadata row. The custom-format dump
is restored into a separate disposable database. Restored application content
contains only the pre-export row, proving the imported view rather than a fresh
after-export snapshot; restored metadata matches the captured file. Importing the
original snapshot after the window closes fails with invalid snapshot identifier.

All child commands use the verified local Docker endpoint pinned before the
interval. The fixture uses bounded asynchronous processes, TLS verification,
statement/lock timeouts and bounded buffers; it never publishes a remote daemon
or invokes a shell with generated commands. Its database password is synthetic.
The native helper is a test fixture, not a supported production capture command.

## Remaining integration and limits

This is a real exported-snapshot/database-dump/file-capture interval proof for
synthetic scoped tables, not a complete application backup. It has no encrypted
database custody, canonical source report, file receipt/index/root join, immutable
set publication, current preservation/disposal authority or restore admission.
The established encrypted archive/index/root services still need that integration.
In particular, `ArchivedRecoverySets` still requires the original canonical v2
source/isolated-restore proof, exact public.Document metadata and fingerprints.
The new scoped native dump does not satisfy that contract. Extend the original
source-capture helper to import the same exported snapshot for both dump and
fingerprints and produce genuine source/restore evidence; do not weaken its
existing assertions or manufacture a v2 report from these interval observations.
The ordinary file-only parent workflow deliberately retains its existing limits.

Actual provider project, database, endpoint, Storage relation and release mapping
must be independently verified. SHARE locks protect only configured metadata
relations, not remote object bytes or every control-plane actor. Retained keys,
issuers, in-flight/multipart/cleanup writers and external capabilities remain
accounted for separately. MVCC excludes sequence runtime state and external
object bytes; no sequence/global-role/ownership/ACL proof is added by this API.
Complete common database/files custody, independent roots/current authority,
full-application quarantine/replacement and actual provider/source-host-off proof
remain required before the full goal can be complete.
