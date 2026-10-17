# Live-head anchored plan bootstrap

17 October 2026. Internal source implementation with synthetic cloud transports;
not a hosted activation, provider/IAM attestation or complete recovery admission.

## Why a descriptor is needed

The existing live maintenance head commits to a protocol9 plan digest, epoch and
attempt. Previously unknown-ID catalogue discovery still needed the plan/source
bootstrap retained elsewhere. The immutable plan descriptor supplies the exact
plan preimage. Its SHA-256 must equal the digest read from the separately trusted
live head, so its source version and component configuration hashes are not trusted
merely because a candidate or descriptor asserts them.

`planDescriptor()` preserves the original format9 fields, policies and ordering;
`planDigest()` hashes that same object. This does not change protocol9, candidate
bindingV2, immutable candidate requests/reports or legacy archive formats. The
shared `requireProtocol9ClosedHead` extracts the existing full closed-evidence
shape check for reuse by inspection and bootstrap. It checks recorded evidence
structure/bindings, not fresh provider execution or actual issuer/IAM closure.

## Explicit publication and capture barrier

After an original closed attempt, `publishCaptureBootstrap(journal)` checks the
exact configured plan/installation/epoch, inspects supported original evidence and
fresh metadata, then conditionally stores the descriptor at:

`managed-maintenance/<installation>/<attempt>/plan-bootstrap.json`

The file is the strict canonical plan JSON itself, bounded to 8KiB. Publication
uses expected owner, SSE-KMS, SHA-256, If-None-Match:* and exact-version readback;
the head must remain unchanged. A lost ACK refuses the result, and the in-process
publication attempt is consumed. There is no read-then-write fallback or overwrite.

`captureQuarantined` now requires the saved descriptor to match the actual closed
head before its original request is reserved. It never creates a missing descriptor
implicitly. Reading a valid saved descriptor can establish configuration identity;
it does not reconstruct its publication ACK or grant capture permission. A new
candidate still requires all existing head/scope checks and its own original
acknowledged conditional request. No old candidate/history receipt is rewritten.

## Current recovery discovery without local source/plan IDs

`journal.discoverCurrentCandidates(control, minimumEpoch)` uses only separately
trusted control/journal storage, explicit credentials and a protected epoch floor.
It reads the existing live closed head, refuses an epoch below that floor, reads
and exact-version verifies its plan descriptor, then calls the scoped unknown-ID
catalogue using the verified source/plan/epoch/attempt and actual head revision.
A second live-head read must match. No candidate ID, source SHA, plan digest or
attempt is selected from a local cache or guessed from the first candidate.

Missing/unsupported descriptors, a non-closed or incomplete head, changed plan,
wrong source/installation/epoch, head movement, missing newer data or a lower epoch
refuse. There is no implicit fallback to an older epoch. Low-level historical
inspection with explicitly trusted original bootstrap remains available; it is
not promoted into current authority.

The protected epoch floor remains an external trust input. This method does not
prove a complete monotonic history or detect every privileged provider rollback.
The live head must actually have independent authenticated custody without cache
or checkpoint fallback. The descriptor identifies the release declared by the
original plan; it does not attest the current running tool or provider release.
Exact-source/deployment and real supplier custody gates remain required.

## Scope and proof limits

This reuses `S3ManagedMaintenanceControl` live reads/revisions; it introduces no
new head, counter, initialization, epoch-advance or reopening API. Tenant-bound
recovery authority and Confluence V2 history remain separate and unchanged.
Saved descriptor/catalogue reads authorise neither execution nor restore/disposal.
Current tenant authority, monotonic history, actual source-host loss, reconstructed
ACK, archive admission and action authority remain explicitly false.

Unit proof covers a complete original coordinator, explicit publication, cold
source/plan discovery, missing descriptor before capture, lost descriptor ACK,
plan tampering, minimum epoch floor, moving head, and two independently closed
epoch fixtures. A missing newer descriptor fails; publishing its exact plan then
selects epoch2 without falling back to epoch1. These are synthetic control/provider
fixtures, not a real operational epoch transition or rollback certification.

Native TLS PostgreSQL composition includes original close/fences, one descriptor,
five candidate cases and encrypted custody. The source database holder is then
disconnected; fresh GET-only control and GET/LIST-only journal clients learn the
source plan and candidate IDs using only live control plus an epoch floor. There
are no new capture/data-key/write operations during discovery. Cloud storage stays
an in-process synthetic backend, so real source-host-off recovery is not proved.

## Remaining full goal

Verify real provider roots, protected epoch floor, IAM/deletion/lifecycle/rollback
exclusion and independent custody. Join actual database capture, file receipts and
authenticated index/root publication under the supported common boundary. Complete
non-SQL/in-flight/issuer/control-plane writer accounting, independently current
preservation/disposal authority and full application quarantine/replacement,
identity/secret/session changes, repeated epochs and actual provider/host-loss/
guarded reopening proof. The full delegated goal remains active.

See [candidate catalogue](managed-candidate-catalogue.md),
[durable journal](managed-candidate-capture-journal.md) and
[writer/capture audit](managed-writer-capture-audit-2026-10-17.md).
