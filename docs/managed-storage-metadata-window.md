## 17 October: exported snapshot inside the guarded metadata interval

The [database snapshot integration](managed-database-snapshot.md) exports after
exact relation locks and keeps the transaction open through the consumer.
Native TLS pg_dump/isolated restore proves the imported view excludes a later
application row while file capture matches locked synthetic metadata; expired
imports refuse. This adds no root/index admission or real provider/host-loss
proof. The full delegated goal remains active; Nikita review remains optional.

# Guarded Storage metadata-capture interval

17 October 2026. Internal PostgreSQL16 component, verified in disposable native
PostgreSQL. No actual provider activation, live grant changes or deployment.
This advances the full managed recovery implementation; it is not a complete
Storage writer fence, common database/file capture or recovery admission.

## Contract and ordering

`ManagedStorageMetadataWindow` takes a separately trusted database name/OID,
observer name/OID, 1–16 exact ordinary-table schema/name/OIDs and an explicit
`maxWindowMs` of 100–3,600,000. The TLS client/host/provider binding must be
established separately. The holder needs the provider-supported privilege to
acquire SHARE locks; a read-only transaction does not make its credential
least-privileged. Partitioned/inherited relations and non-PostgreSQL16 servers
are unsupported and refuse.

`run(capture, optionalAbortSignal)` opens a Read Committed, READ ONLY transaction,
pins local search_path to pg_catalog and validates TLS, database, observer/session
identity, primary state, version and exact table identities. It acquires SHARE
locks in ascending OID order and rechecks every identity and granted lock before
calling capture. Read Committed is deliberate: identity discovery precedes the
lock wait, but capture must see a writer that commits during that wait. A Repeatable
Read snapshot acquired for the initial discovery could incorrectly omit that row.
[PostgreSQL LOCK guidance](https://www.postgresql.org/docs/16/sql-lock.html),
[transaction semantics](https://www.postgresql.org/docs/16/sql-set-transaction.html).

The callback receives only an AbortSignal, never the SQL transaction. Propagate
that signal to all external reads. Candidate output must remain unadmitted until
`run` returns successfully. Heartbeats check session/table identity and all granted
locks every 250ms; the final check precedes transaction completion. Statement
and lock waits are bounded at 1.5s and 1s. The configured callback deadline and
outer transaction timeout (window budget plus 30s) bound normal execution.
A transaction-local 15s idle-session timeout provides database-side cleanup if
the holder stops sending queries; this setting is not a process-crash certification.
[PostgreSQL timeout contract](https://www.postgresql.org/docs/16/runtime-config-client.html).

Callback error, caller cancellation, deadline, lock/identity/liveness failure or
an unknown transaction acknowledgement rejects with a sanitised unresolved error.
The signal is aborted on closure, late callback output is discarded, timers are
cleared and in-flight health queries settle before transaction exit. A callback
that ignores cancellation may continue its own work; it cannot produce an
accepted result from this guard. No retry, acknowledgement reconstruction or
candidate admission occurs. In-process overlapping runs on one instance refuse.

Only after the transaction returns does the caller receive its value plus a
configuration-bound interval report, random window ID, backend PID and database
start/end observations. `metadataWindowCompleted` describes that past interval;
`windowStillHeld` is false. Object-byte fencing, complete writer inventory,
whole-backend quiescence and action authority remain false. The digest does not
prove candidate-byte integrity, provider identity or independent evidence custody.
Returned registry objects are copied, preventing output mutation from modifying
the private validated identifiers. The related inventory capture-role output is
also copied; its native regression now covers that aliasing boundary.

## Native and unit coverage

The existing disposable TLS PostgreSQL gate runs the actual component with two
configured tables. An earlier INSERT is held open; the exact pending SHARE lock
is observed and the callback has not started. After the writer commits, capture
reads that newly committed row. A privileged INSERT into the second table is
observed waiting behind the window while positive reads succeed; it commits only
after release. Existing grant/role/function and protocol9 checks remain intact.

Further native cases cover callback error, deadline with an uncooperative
callback, caller cancellation, lock timeout before callback, connection
termination during capture, wrong database identity, returned-evidence mutation
and unknown commit acknowledgement after an actual transaction. They reject
unsafe results and allow subsequent writes after release. Unit tests cover unsafe
registries, input snapshots, sanitised failures and concurrent reentry.

## Remaining managed integration

This is not a live operator command or application route. Establish actual
supported provider connection/project/release and complete table mapping before
activation. Join the guard to actual capture/custody and the original maintenance
attempt/source/epoch; a standalone digest is not an admission receipt. Preserve
protocol9 original positive controls and quarantine candidate artifacts after any
unresolved outcome.

SHARE locks protect only the configured SQL relations during this interval.
Object bytes, uploads/multipart already writing outside SQL, cleanup workers,
other tables, current credential issuers and control-plane actors remain separate.
Grant/function/role changes are not all prevented by these relation locks.
Independent preservation/disposal authority, whole-application restore/replacement
and actual provider/source-host-off/reopening proofs remain required. Continue
from [authority inventory](managed-storage-database-inventory.md) and
[remaining boundaries](managed-writer-capture-audit-2026-10-17.md).
