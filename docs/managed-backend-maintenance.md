# Guarded managed-backend shutdown

This internal prototype combines Render service/job observations with actual
PostgreSQL writer-principal closure. It is not an operator command, migration,
credential-rotation or application-reopening workflow and is not activated by a
route or scheduler. Keep the supported private/personal-server paths distinct.

## Independent installation control

`S3ManagedMaintenanceControl` uses a separate installation-wide key:
`managed-maintenance/<installationId>/control.json`. It does not reuse any tenant
preservation/disposal head or journal and cannot establish their freshness.

A separately authorised provisioning process must already have placed a canonical
format1 READY control for the exact plan digest and positive maintenance epoch.
The record contains installationId, planDigest, phase, nullable attemptId and
observations, plus a unique publicationId. This implementation has no create,
initialise, reset, expiry, takeover, release or reopen method. Missing control
means unresolved; it never creates replacement history. Repeated maintenance
operations require a separately reviewed epoch/provisioning lifecycle before
activation; this prototype deliberately cannot reset its own consumed guard.

Reads require the exact account, explicit credentials, Ireland endpoint, KMS key,
current version and canonical bounded UTF-8 JSON. SDK retries and region redirects
are disabled. A15-second bound destroys stalled read streams. Conditional writes
use the observed ETag, an explicit integrity checksum and a new publication UUID;
fresh readback must match the full body, returned version/ETag and new revision.
The store rejects null-version objects, delete markers, malformed/noncanonical
bodies, missing/changed metadata, wrong installation and conditional conflicts.

These are implementations of [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
and the [GetObject metadata contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
They do not establish independently administered credentials, retention/IAM policy
or immunity to a privileged actor replaying an old READY object. Those provider
and custody gates remain required. Do not treat SSE-KMS alone as separate custody.

## Coordinator sequence

`ManagedBackendMaintenance` computes the plan from a copied installation,
source SHA and maintenance epoch plus hashes of the actual provider and database
configuration registries. This binds the reviewed target identities and exact
pinned image paths; it does not independently prove that images were built from
the supplied source SHA. Exact-release build/attestation evidence remains needed.

1. Read the expected READY record; conditionally write a unique ATTEMPTED record
   and verify it. Only that fresh acknowledged caller proceeds. A lost write
   response stays unresolved even if a later read sees its committed attempt.
2. Suspend the exact Render services and separately cancel surviving one-off
   jobs, requiring the adapter's full fresh readback.
3. Commit NOLOGIN and drain the exact configured database sessions through
   `ManagedDatabaseWriterFence`. Unknown commit never causes automatic LOGIN.
4. Observe provider services/jobs and database closure again.
5. Conditionally record OBSERVED_CLOSED against the original attempt's exact
   revision. A changed head or unknown final write result stays unresolved.

A fresh `close()` call cannot dispatch from ATTEMPTED or OBSERVED_CLOSED.
`inspect()` is read-only: it checks actual current component state between two
unchanged independent-control reads. It returns original recorded observations
separately from new observations. It never fills in a missing original completion
record or silently drains sessions after an uncertain acquisition.

## Proof and remaining work

The unit suite injects SDK and component faults, proves a single dispatch under
concurrent callers, verifies the default SDK endpoint/retry configuration and
destroys a stalled provider body at the read deadline. The existing disposable TLS
PostgreSQL gate now also runs `managed-backend-maintenance-postgres-proof.mjs`.
It composes the real database fence with synthetic Render HTTP and S3 SDK
transports, covering successful ordering, lost acquisition acknowledgement, lost
actual NOLOGIN commit acknowledgement and lost final control acknowledgement.
Fresh clients refuse repeats. Real old sessions remain usable after NOLOGIN
until explicitly drained; inspection refuses that unresolved state. Explicit
fixture-only cleanup is separate from the coordinator and is not a recovery API.

The receipt and fresh inspection keep wholeBackendQuiesced,
credentialRotationVerified, currentTenantAuthorityVerified, sourceHostFenced,
reopeningAuthorised and actionAuthorized false. A point-in-time component pair
is not a global durable fence or permission to reopen. The control does not
prevent manual provider jobs, Blueprint actions, privileged role changes, an
outside credential or already-dispatched IO.

Before managed activation, complete control-plane writer exclusion, credential
rotation, the repeated-maintenance lifecycle, current independent tenant history,
whole business-data/document-byte backup/restore and authority reconciliation.
Prove real provider/IAM/key custody and source-host-off recovery/reopening. No
provider account/resource/access grant or real cloud mutation occurred in these
tests. No database migration or restore-inventory change is included.
