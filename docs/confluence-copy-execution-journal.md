# Retained-copy request and outcome journal

## Required contract

A consumption claim alone cannot establish whether a destructive request was
prepared, sent or acknowledged. Preserve append-only request identities and
reported outcomes before activating the provider coordinator. Preparation is
quarantined intent, never proof of dispatch or authority to dispatch.

Bind each prepared request to one tenant, consumed claim, initiating active Owner,
exact action (TRASH or PURGE), caller-chosen reconciliation key and evidence.
One request per claim/action and one key per tenant are permanent constraints:
expiry, a missing response, a new client or withdrawal must not renew them.
The database supplies time and repeats current source, permission, hold, grant,
expiry and durable-WAL checks under the organisation lock and Read Committed.

A separate immutable outcome records only ACKNOWLEDGED, REFUSED or UNRESOLVED
as an APPLICATION_REPORT. It never establishes provider absence or all-copy
erasure and never permits automatic retry. An outcome must remain recordable if
the initiating Owner or permission ceased to be active while a request was in
flight. Therefore internal outcome persistence derives its request/tenant binding
from the immutable request and records the actual database role; it does not
pretend to be a new live Owner approval. No public route exposes these writes.

New-client receipt lookup requires a current active Owner in the same active
tenant. Empty results do not prove that an in-flight transaction failed. No raw
provider error, response body, credentials or download URL belongs in the journal.

## Activation and recovery boundaries

Requests and outcomes never grant provider IO. No route, scheduler or coordinator
calls the transport primitive in this increment. A later dispatcher needs its own
one-use durable dispatch boundary, independently current authority publication,
last source/grant checks and provider readback. A prepared PURGE intent is not
proof that TRASH happened; the dispatcher must establish the exact intermediate
Trash state before that stage. Uncertain dispatch cannot be automatically retried.

Restore comparison must inventory both new tables and reject older state that
omits their records, while retaining exact older comparison formats. Disposable
reset and the lifecycle map must include them. The independent V1 archive still
omits claims/requests/outcomes and must remain blocked when claims exist. A
compatible independently recoverable archive and current-head recovery proof are
required before any provider consumer is enabled. Local SQL/restart tests are
not physical-host-loss or provider proof.


## Current implementation and evidence

The internal `ConfluenceCopyExecutionJournalService` implements preparation,
redacted outcome reporting and active-Owner receipt lookup. The forward
`20261016160000_confluence_copy_execution_journal` migration supplies the SQL
constraints, locks, immutable triggers and server time/role attribution.
Current restore format15 includes both groups, with exact format14 retained.
No existing migration checksum was edited.

The joined disposable PostgreSQL proof uses the restricted runtime database
role. It races preparations, loses acknowledgements after actual request and
outcome commits, reads receipts through new clients, rejects renewal and mutation,
and records an unresolved report after an atomic Owner transfer and permission
withdrawal. An ACKNOWLEDGED application report still cannot assert absence,
all-copy verification, retry or provider authority; the database overwrites a
forged role attribution. WAL/isolation/hold/grant/tenant/role checks, older restore
refusal and a transactionally removed outcome table exercise refusal paths.
The original V1 eight-group archive/replay proof still has its narrower scope.
Neither test sends a provider request or proves independent current custody,
actual dispatch recovery or physical host loss.
