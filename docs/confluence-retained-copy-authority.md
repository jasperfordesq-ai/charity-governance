# Retained Confluence copy disposal authority

## Status

Review contract and durable evidence-storage increments, 15 October 2026.
Synthetic engineering only. The source adds an internal review/withdrawal
service and migration; no runtime route, executable permission, provider call
or deletion capability is added. The migration is not deployed. The deployed
retained-source refusal remains intact.
Private item-specific decisions and evidence stay in the ignored roadmap.

## Two distinct decisions

Retaining a governance record in the Vault and disposing of its Confluence
publication are separate decisions. Retiring a document or withdrawing its
publication approval does not grant permission to purge either object.
The existing DRAFT-only primary-removal workflow must remain unchanged.

`confluence-retained-copy-review.ts` prepares a review candidate for a retained
RETIRED source with withdrawn external approval and no asserted deletion hold.
The candidate binds charity, source identity/revision/hash, publication
identity/revision, cloud/site/space/page, page versions and attachment versions,
hashes and sizes. Explicit review, synthetic-scope, retention, hold and inventory
evidence references and caller-specified review/expiry times are required.
There are no invented retention periods or default approval lifetimes.

Inventories reject duplicates, missing current versions, versions ahead of the
reported current version, incomplete or Trash status, malformed identifiers,
unexpected fields and ambiguous origins. Ordering is canonicalised. A fresh
observation of identical content may have a later observation time; comparison
requires that time to be at or after review and no later than the supplied
current time. Content and revision changes require a new review.

Every candidate explicitly carries `authorisesProviderIO: false`. A digest
compares content; it is not a signature, an authenticated reviewer, proof of
inventory completeness, proof of a synthetic tenant or a durable permission.
Caller-supplied evidence and flags must not be trusted as any of those things.
The parser bounds inventories to100attachments and1000versions per attachment
or page. Exceeding a bound refuses the candidate, never truncates the inventory.

## Durable evidence storage

`ConfluenceRetainedCopyReviewService` records parsed review evidence under the
authenticated charity Owner's identity and the database clock. SQL repeats
Owner/charity, retained-source/hold, publication, revision, target and time
checks under locks. The original row is append-only; withdrawal is a separate
tenant-bound, append-only row. Both reject UPDATE, DELETE and TRUNCATE.
`authorisesProviderIO` is constrained to false even for direct SQL inserts.
The service has no route and neither erasure request nor worker imports it.

Provider inventory, byte hashes, synthetic status and evidence references are
still assertions to review: storage does not establish their truth or sign a
policy. SQL does not recompute the JavaScript canonical snapshot hash or prove
all nested version inventories. Future permission issuance must independently
collect/revalidate those facts and the complete contract; it cannot treat a
stored row, matching digest or absence of a withdrawal as execution authority.

Existing independent-recovery bindings refuse new review/withdrawal writes
until independently recorded outcomes are supported. Conversely, review history
prevents new binding activation until its baseline/history can be replayed.
Those symmetric refusals preserve the missing-history gate; they do not supply
independent storage, replay or a host-loss recovery result.

## Next increments before execution

### Explicit synthetic decision records now in source

`ConfluenceSyntheticCopyScope` registers one exact immutable review, snapshot
digest, scope/disposal decision evidence, accountable Owner and expiry. Only
the actual maintenance table owner can insert it; the application DML role
cannot self-register or use a temporary table to impersonate that owner.
No scope is seeded. There is no supported live registration command yet;
do not substitute raw production SQL for the future reviewed operator path.

The internal `ConfluenceRetainedCopyPermissionService` requires the active
Owner's explicit attestation, expected reviewed digest, matching registered
scope/disposal evidence and an expiry no later than either parent limit. It
re-observes the exact source/remote facts outside database locks, then repeats
review, Owner, scope, expiry and current-source checks in a final transaction.
Source and remote changes refuse. The decision binds the connected integration
and grant generation; SQL repeats the exact site/generation check at insertion.

The immutable record says `OWNER_ATTESTED_SYNTHETIC`, not independently verified
synthetic content or DPO acceptance. Withdrawal appends separate evidence;
future consumers must also treat review withdrawal as invalidation of the decision. One permission per review
and scope prevents renewing a spent/withdrawn decision by overwriting history.
Future execution must check both withdrawals, all expiries, exact source/target
facts and connection generation again.

The forward permission migration pins search paths for new guards and the
earlier unshipped review guards, without editing earlier migration checksums.
Temporary-table impersonation of scope, Owner and source records has SQL
regressions. All scope/permission/withdrawal tables reject mutation/truncation.
Existing independent-history bindings still freeze these decisions, and the
parent review history still prevents activation before independent replay.

No HTTP route, actual registered scope, live permission, erasure exception or
provider execution was added. Issuance returns `providerIOAuthorised: false`:
the recorded controller decision still needs independently committed history
and a durable one-use request/worker decision. Primary retention and the
existing retained-source erasure refusal remain unchanged.

### Provider observation collector now in source

`collectRetainedConfluenceCopyInventory` reads an exact current page and its
provider-listed page versions, inventories attachments, and reuses the existing
historical attachment byte reader and repeated-current observation. It revisits
page/attachment metadata and each history after byte collection, refusing
detected changes. All HTTP calls are GETs; byte redirects retain the existing
host guard and never receive the bearer token. Shared pagination follows only
an unambiguous cursor on a fixed endpoint, never an upstream next URL.

Bounds:100attachments,1000page versions,32versions per attachment,128MiB across
attachment reads including repeats, and the existing50MiB per-read ceiling.
The combined120second cancellation signal reaches HTTP responses and streamed
bodies. Credential acquisition is checked before/after awaiting the existing
token provider; this does not cancel a token-store wait. Limits refuse rather
than truncate. Provider visibility and concurrency still limit what a bounded
observation proves: this is not an atomic provider snapshot or discovery of
hidden copies, comments, exports, backups or all provider-held data.

The collector has no HTTP route or erasure caller. A new internal wrapper
derives its cloud/site/page from tenant publication/connection state and
checks that binding around observation. Local primary bytes, synthetic-fixture
authority and policy remain unverified by the low-level primitive. Its explicit
`actionAuthorized`, `allCopiesVerified` and `sourceVerified` flags are false.

Read contracts were checked against Atlassian's official [version API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-version/),
[attachment metadata API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/)
and [version-specific download API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---attachments/).
Actual sandbox responses, grant scope and byte behavior still need acceptance.

### Tenant and source observation wrapper now in source

`observeRetainedConfluenceCopySource` accepts only trusted tenant/actor context
and a publication ID. It requires an active charity Owner, an unheld retained
RETIRED source with withdrawn publication approval, an identified RETIRED
publication without an erasure job, and a matching connected site with known
read scopes. Site URL, recorded provider/path and source/publication revisions
are derived from stored rows. Extra input fields cannot override a target or
source hash. The eventual HTTP caller must supply authenticated actor context;
the service is not itself an authentication endpoint.

The wrapper hashes the retained primary bytes through `StorageService` using
the recorded provider and tenant path, before and after provider collection.
Source size/hash changes and source, publication, Owner or grant changes refuse.
Token acquisition is bracketed by the same checks. `connectedAt` identifies the
grant generation; ordinary refresh metadata does not impersonate reconnection.
A known recorded attachment missing from the visible inventory remains
unresolved. Completion time comes from the database, followed by a final state
recheck, and the returned snapshot uses the existing strict review contract.

`sourceBytesObserved: true` is a bounded repeated byte observation, not proof
that remote bytes equal the current primary or that either record has legal
authority. These optimistic reads are not an atomic distributed snapshot or
durable execution fence. `syntheticVerified`, `allCopiesVerified` and
`actionAuthorized` remain false. No stored review is automatically promoted;
fixture/policy-backed permission issuance and independent history remain open.

1. **Permission issuance after fact collection:** internal Owner-scoped review
   storage, separate withdrawal and SQL immutability/revision checks now exist
   with disposable PostgreSQL tests under a restricted DML role. Server-derived
   target and primary-byte observation now have synthetic adapter tests; actual
   sandbox validation remains open. Internal issuance/withdrawal now records an
   explicit Owner decision under a maintenance-registered exact scope. Establish
   the actual synthetic fixture, selected disposal decision evidence and reviewed
   registration workflow before activation. Stored review evidence alone is not
   a permission, and the decision record alone cannot execute provider I/O.
2. **Independent recovery:** canonical linked review/scope/permission/withdrawal
   facts, authenticated encrypted preservation, an S3 object boundary and strict
   consecutive-state comparison now exist as source primitives. Durable committed
   capture, reservation/current-head publication, complete replay and provider
   custody remain required. Retain possible-copy and execution-intent facts too;
   a restored approval cannot resurrect withdrawn or spent execution permission.
3. **One-use provider execution:** request and worker must recheck the same
   approved policy, holds, exact target inventory and source state. Persist the
   decision before provider I/O; handle crashes, lost acknowledgements and
   retries without turning a stale approval into renewed destructive authority.
   Only then add an explicitly guarded retained-source alternative to the
   existing request, SQL insertion and worker checks. Do not remove those
   checks as a standalone change.
4. **Synthetic journey and provider acceptance:** build matching synthetic
   source/publication fixtures through supported flows, freshly review complete
   target inventories, and obtain separately scoped connection/action authority.
   Test concurrent withdrawal, holds, changes and retries before the provider
   operation. Distinguish recoverable Trash, recorded-target purge/readback,
   UNKNOWN outcomes and all-copy/provider-retention limitations.

These increments remain part of the full acceptance work. No production
retention policy, provider grant, live governance record disposal or independent
reviewer acceptance follows from the contract tests.

## Recovery facts and encrypted preservation primitives

`confluence-copy-recovery-facts.ts` validates the complete five-record decision
bundle: immutable review, optional scope, optional permission, and each optional
withdrawal. It checks cross-record/tenant identity, snapshot hashes, expiry and
chronology, and retains expired historical decisions. Descriptive documents,
primary/provider bytes and credentials are excluded; reasons and evidence
references remain sensitive governance metadata requiring live retention approval.

Consecutive facts bind predecessor digest/revision, installation, charity and
writer epoch, preserve every previously recorded row/withdrawal, and refuse a
new row predating an earlier snapshot that declared it absent. Writer-epoch
transition is not supported by this comparison; it needs its separate reviewed
control protocol. Parse failures are sanitised and inputs bounded before parsing.

The16MiB fact limit preserves the full review contract: a synthetic maximum
100,000-version case retains13,309,771canonical bytes without truncation. The
32MiB encrypted-envelope limit includes encoding overhead. Existing envelope
key/context/AAD binding and key-buffer wiping are reused, with a distinct
Confluence kind. Atomic create-if-absent and readback preserve the exact original
operation identity after lost acknowledgements; different facts cannot overwrite
it. A missing expected object is never rebuilt from a backup.

S3 methods use a distinct `confluence-copy-state` namespace, expected account,
existing separate storage/data KMS keys, bounded authenticated reads and conditional
writes. No live bucket, IAM policy/prefix permission, retention lock, credentials
or cloud resource was configured or used by this increment.

These components do **not** capture committed SQL rows, maintain an outbox,
publish a journal kind/reservation/head, select a latest state or apply a restore.
The expected object digest must ultimately come from independently authenticated
current history, not a restored local checkpoint. Readers/progression explicitly
return `currentHistoryVerified: false`, `reopeningAuthorised: false` and no action
authority. Tests use synthetic object stores/SDK transport; they do not prove
host-loss safety, source/copy-writer completeness, live IAM or independent custody.

Next capture and retain the original canonical body durably by operation before
its first external write, then publish under the exact reserved writer/current
head. A retry must use that original body; recapturing with a new timestamp is a
different fact and must refuse under the old identity. Reconcile/apply the full
verified history before any reopening. Keep binding/writer and erasure blocks
until these protocols and the remaining source/copy facts are complete.
