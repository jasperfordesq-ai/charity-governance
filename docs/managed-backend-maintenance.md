# Guarded managed-backend shutdown

> **17 October protocol9 S3 integration:** The default coordinator now requires
> explicit S3 mode evidence, an original S3_BASELINED head acknowledgement before
> shutdown, and a fresh paired S3 report before OBSERVED_CLOSED. Saved inspection
> never repeats S3 probes or backfills ACKs. Both modes pass native PostgreSQL
> integration with synthetic providers. See [required S3 maintenance](durable-s3-maintenance.md).


> **Current protocol5:** [Durable standard-write maintenance](durable-standard-write-maintenance.md)
> adds exact-version write baseline/report pins and a WRITE_BASELINED barrier
> before shutdown. The protocol4 sequence below is the earlier checkpoint;
> current inspection reads saved write reports without running active probes.

> **17 October protocol4:** The current coordinator binds the credential-probe
> registry and requires an independently saved/read-back baseline BEFORE any
> shutdown or key deletion. BASELINED remains consumed after an unknown response.
> Completed records retain both baseline and later read-refusal artifacts; fresh
> inspection does not rewrite missing history. See [durable baseline](durable-credential-read-baseline.md).
> Broader write/capability/global/provider/host-loss gates remain open.

> **17 October protocol3 history:** This introduced the
> [named Supabase storage access-path control](supabase-storage-writer-control.md)
> and binds its exact registry into the plan. It runs after database password
> invalidation, then records a separate storage observation. Old protocol1/2
> plans cannot dispatch it. Global writer exclusion, signed capabilities,
> in-flight drain, real data-plane rejection/custody and reopening remain open.

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
source SHA and maintenance epoch, protocol4/password-invalidation, named-storage-key and independently retained read-baseline policy and hashes of the actual provider, storage, probe and database
configuration registries. This binds the reviewed target identities and exact
pinned image paths; it does not independently prove that images were built from
the supplied source SHA. Exact-release build/attestation evidence remains needed.

1. Read the expected READY record; conditionally write a unique ATTEMPTED record
   and verify it. Only that fresh acknowledged caller proceeds. A lost write
   response stays unresolved even if a later read sees its committed attempt.
2. Capture the exact credential baseline and CAS its body/original SHA to
   BASELINED with exact readback. Only after that acknowledgement suspend and
   freshly confirm the exact gateway, then scheduler/private web/API
   in a defined order, separately cancel surviving one-off jobs from all four
   components and require the adapter's full fresh readback. Provider list order
   cannot choose the sequence. The configuration digest has a four-component
   domain; legacy three-service control plans refuse before dispatch.
3. Commit NOLOGIN and drain the exact configured database sessions through
   `ManagedDatabaseWriterFence`, then atomically clear their database passwords
   while they remain closed. Unknown commit never causes automatic LOGIN or
   password restoration. Catalogue proof is mandatory, with no raw password or
   verifier reads. A legacy protocol1 plan refuses this new workflow; the
   independent control record itself remains format1. Next close the reviewed
   Supabase API/S3 key paths without retry or automatic replacement credentials.
4. Verify credential GET refusals with controls, then observe provider
   services/jobs, database closure and named storage paths again.
5. Conditionally record
   OBSERVED_CLOSED and that complete artifact against the saved baseline revision.
   A changed head or unknown final write result stays unresolved.

A fresh `close()` call cannot dispatch from ATTEMPTED, BASELINED or OBSERVED_CLOSED.
`inspect()` is read-only: it checks actual current component state between two
unchanged independent-control reads. It returns original recorded observations
separately from new observations. It never fills in a missing original completion
record or silently drains sessions after an uncertain acquisition.
Protocol4 requires complete recorded storage/read evidence for OBSERVED_CLOSED;
readable legacy observations do not become new closure evidence. Stored and fresh
read observations are returned separately, including after a lost baseline ACK.

## Proof and remaining work

The unit suite injects SDK and component faults, proves a single dispatch under
concurrent callers, verifies the default SDK endpoint/retry configuration and
destroys a stalled provider body at the read deadline. The existing disposable TLS
PostgreSQL gate now also runs `managed-backend-maintenance-postgres-proof.mjs`.
It composes the real database fence with synthetic Render HTTP and S3 SDK
transports, covering old-three-service plan refusal, four-component ordering, lost
acquisition acknowledgement, lost
actual NOLOGIN commit acknowledgement, lost PASSWORD NULL commit
acknowledgement and lost final control acknowledgement.
Fresh clients refuse repeats. Real old sessions remain usable after NOLOGIN
until explicitly drained; inspection refuses that unresolved state. Explicit
fixture-only cleanup is separate from the coordinator and is not a recovery API.

The receipt and fresh inspection now verify databasePasswordCredentialsInvalidated
when their fresh checks succeed. They still keep wholeBackendQuiesced,
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


## Document byte candidate increment

The [Supabase candidate reader](supabase-recovery-capture.md) now supplies bounded
recursive source reads and byte rechecks for a future capture worker. It does
not close the separate storage credential/control-plane writer paths. Keep
wholeBackendQuiesced false and do not infer complete common capture from stable
readbacks. Orphan/disposal reconciliation and independent source visibility
remain required alongside the original maintenance/custody gates.

The [document byte archive](document-byte-backup.md) supplies encrypted object
candidates outside the intent journal. It does not complete a database/object
recovery set or authorise reopening. Full capture, manifest, current-authority,
provider/custody and host-loss integration gates above remain open.

## Read-only database maintenance preflight

Before control acquisition or shutdown, `ManagedDatabaseWriterFence.observeCompatibility()`
checks the pinned database/maintenance identity and TLS/durability, then PostgreSQL
16–18 catalogue predicates for role administration, full session visibility,
configured-session termination and column-level password-state access. The actual
password query returns only `rolpassword IS NULL`, names and OIDs. It runs with
`SET TRANSACTION READ ONLY` and a catalogue-only search path, rereads predicates,
and returns missing privileges without granting anything. Full registry, alias,
cross-database and prepared-transaction checks run when the predicates pass.

This is an advisory prerequisite, not a saved execution permit or a substitute for
fresh mutation checks. It neither proves that a provider permits ALTER ROLE in
practice nor certifies all writers, endpoint directness or ongoing permissions.
The role predicate conservatively requires direct ADMIN OPTION for every configured
target unless the maintenance role is a superuser.

PostgreSQL documents these boundaries in [ALTER ROLE](https://www.postgresql.org/docs/17/sql-alterrole.html),
[signalling functions](https://www.postgresql.org/docs/17/functions-admin.html)
and [pg_authid](https://www.postgresql.org/docs/17/catalog-pg-authid.html).
Supabase documents that its customer [postgres role is not a superuser](https://supabase.com/docs/guides/database/postgres/roles-superuser).
That fact alone does not determine a project's complete permissions. Check the
actual configured account; do not grant hosted privileges to force this prototype
to pass, or infer hosted-provider compatibility from synthetic PostgreSQL results.