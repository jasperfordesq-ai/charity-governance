# Retained Confluence copy disposal authority

## Status

Review, collection, scoped permission and recovery-capture increments,
15 October 2026. Synthetic engineering only. Internal decision/capture services
and migrations add no runtime route, executable provider permission or deletion
capability. These source increments are not deployed. The deployed
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
   consecutive-state comparison and durable committed capture now exist as source
   components. Reservation/current-head publication, complete replay and provider
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

The envelope/S3 components do **not** themselves capture SQL rows or publish a
journal kind/reservation/head, select a latest state or apply a restore.
The expected object digest must ultimately come from independently authenticated
current history, not a restored local checkpoint. Readers/progression explicitly
return `currentHistoryVerified: false`, `reopeningAuthorised: false` and no action
authority. Tests use synthetic object stores/SDK transport; they do not prove
host-loss safety, source/copy-writer completeness, live IAM or independent custody.

## Durable local capture

`ConfluenceCopyRecoveryCaptureStore` reads all five immutable decision records
under the same charity lock used by decision/scope writers. It requires an
active charity and scoped active Owner, then commits the exact canonical body,
digest, context and database capture time before any external preservation.
Operation identity is unique per charity. A retry validates and returns the
original body/time, including after later withdrawal or expiry; it cannot
recapture changed facts under that operation. New facts use a new operation and
the next review revision/predecessor digest. Epoch changes are refused.

The forward migration independently locks the charity, checks active Owner,
reconstructs the complete linked rows and verifies payload/digest/chronology and
lineage. It prevents omission of a committed withdrawal and makes capture rows
append-only, including TRUNCATE. Its functions pin the search path and qualify
tables to resist temporary-table impersonation. Canonical text validation is
also required in the service; SQL compares complete JSON values and byte hash.
No scope is registered and no decision, job, primary bytes or provider is changed.

This is a local outbox candidate, without dispatch or publication receipts.
Returning an earlier capture for retry does not make its permission current:
all results explicitly deny action/current-history/reopening authority. A test
combines capture and encrypted preservation through a lost acknowledgement,
then preserves a new withdrawal state under a new operation. The provider and
key service are synthetic; SQL guard tests use disposable isolated PostgreSQL.

Reserved publication/readback components are described below; durable publication
reconciliation and applying the full verified history remain required before
reopening. Keep binding/writer and erasure blocks until those protocols and
remaining source/copy and one-use execution facts are complete. No live
independent-custody or host-loss acceptance follows from local capture.
The capture binds installation/charity/operation/epoch/source; publication must
also durably bind the approved encryption-key context and external object receipt.

## Reserved state publication and readback

The explicit journal kind `CONFLUENCE_COPY_DECISION_STATE_V1` binds its
`factsDigest` to the exact authenticated encrypted envelope bytes, not the
plaintext capture digest. The format-2 reservation separately binds that
canonical plaintext digest, operation, writer and epoch. Generic append and
format-1 publication reject this new kind; the dedicated reserved path rechecks
the exact slot on every head read and conditional update. Existing entry kinds
keep their established semantics and are not reinterpreted as Confluence facts.

`publishVerifiedConfluenceCopyState` opens an already preserved candidate,
checks its canonical plaintext against the reservation and refuses any control
change during verification. Missing objects are never reconstructed. Entry-write
and head-write acknowledgement loss resume the same original operation; a newly
encrypted replacement, even with equivalent plaintext, cannot replace a published
envelope. The operation remains reserved after publication.

`readPublishedConfluenceCopyState` verifies the current journal chain, its exact
operation/kind, the encrypted payload digest/authentication/context and an
unchanged head after decryption. It authenticates one historical capture; it
does not choose the latest state for a review or verify the other payloads in
the chain. Its explicit current-history/reopening/action results remain false.

Synthetic tests join actual journal, reservation and envelope components, test
both lost acknowledgements, changed writers/control, missing history/objects,
replacement ciphertext and the generic-path refusal. The existing S3 release
adapter also refuses this metadata kind; no terminal disposal outcome is implied.
This is not live provider, custody, restart or host-loss acceptance.

The durable local plan/receipt workflow is described below. Still required:
approved live key/account/custody policy; automatic decision capture/outbox/dispatch;
controlled metadata-operation reconciliation/release; complete authenticated
payload progression and SQL replay; remaining source/copy/intent coverage and
one-use execution. There is no supported live workflow or automatic reservation
release in this increment. Bindings and erasure gates stay closed.

## Durable publication plan and receipt

`ConfluenceCopyPublicationStore.prepare` commits the exact capture, writer,
encryption-key identifier, key evidence reference and expected journal predecessor
before the first independent-store write. Scoped active Owner/charity and the
original canonical capture are checked. A retry cannot choose another key,
writer, evidence reference or head. The key reference records an Owner assertion;
it does not provision a key or independently approve its account/custody policy.

`resume` loads that immutable plan/capture and performs reservation, encrypted
preservation, verified publication and authenticated readback outside database
transactions. When the head has already advanced, it verifies the exact original
published entry instead of reserving again. Its immutable receipt records the
winning envelope hash, exact journal generation/digest and observed head revision.
An existing different slot is untouched during historical reconciliation. Missing
payload/history or a head behind a committed receipt cannot cause reconstruction.

The forward migration tenant-binds both models, requires current active Owner
and charity, checks expected generation and key/revision shape, and refuses
UPDATE/DELETE/TRUNCATE. The service rechecks local capture/plan and Owner before
committing a receipt. Role/charity checks are observations around remote I/O, not
a distributed execution fence. A receipt proves one past observation; it does not
assert that all later facts were captured or that the permission remains current.

Synthetic tests join the store with the real reservation/journal/envelope logic
through object, entry, head, local-save and local-commit acknowledgement failures.
The database fixture separately tests scoped immutable rows on disposable
PostgreSQL. No live provider, supported operator route, automatic dispatch,
reservation release, full replay, host-loss reopening or deletion is enabled.
The local plan/evidence-reference history is not itself part of the independent
decision payload; complete replay/custody evidence coverage still needs review.

## Decision-history payload verification

`readPublishedHistory` exposes defensive copies of complete journal metadata
only after its normal full-chain and stable live-head checks. It does not
authenticate payloads. `readConfluenceCopyDecisionHistory` opens every payload
in a decision-state-only history using a separately trusted key allowlist and
the current supported writer epoch. It refuses unsupported kinds/epoch transitions;
it never filters or silently treats older generic entries as equivalent facts.

Each review starts at facts revision1 and advances by its exact predecessor
plaintext digest. Complete immutable review/scope/permission/withdrawal records
must persist unchanged; globally unique child IDs cannot be reused for another
review. Optional restored captures must match their exact independent operation
and bytes; they cannot supply missing remote objects or an invented permission.
The latest observed state for each review therefore retains later withdrawals.
Head/control are checked again after every payload has been opened.

The verifier accepts the complete maximum review inventory without truncation.
It stops without returning partial results beyond512MiB cumulative encrypted
payloads,128MiB retained latest facts or128MiB restored evidence, and the existing
per-object/fact/journal bounds. Larger histories need a reviewed streaming or
segmentation/rollover protocol, not trimming. Provider/key dependencies still
require their existing bounded authenticated-call contracts; no live throughput
or recovery-duration acceptance is established.

The result explicitly scopes `confluencePayloadsVerified` to this protocol and
keeps `currentHistoryVerified`, action and reopening authority false. Encryption
authenticates stored assertions, not their underlying accuracy or current
permission. Mixed-protocol payload verification, local publication/key-decision
coverage, database replay/application and source/copy/intent coverage remain
incomplete. This reader makes no SQL/provider mutations
and enables no operator restore, automatic outbox or disposal workflow.

## Exact metadata-operation acknowledgement

`ConfluenceCopyPublicationStore.release` acknowledges a published metadata state.
It requires current active Owner/charity, the exact immutable capture/plan/receipt,
complete supported decision payload history, matching latest review state and
exact current head. Local evidence and writer/epoch/control are rechecked before
invoking a separate metadata-release provider method. Mixed kinds/epochs or
missing/corrupt evidence stop release.

S3 `releaseConfluenceCopyStateControl` accepts only this explicit state kind and
exact envelope/entry/operation/plaintext/head match, then conditionally clears
that slot while preserving writer, epoch and history. Existing disposal release
rejects metadata; the metadata method rejects disposal outcomes. Generic slot
clearing remains forbidden. Lost acknowledgements retry the same plan; another
operation's slot is never cleared. Readback requires changed revision, unchanged
identity/history and an empty slot before reporting success.

This grants no provider I/O or reopening and is not an erasure outcome. Later
local decisions still need capture/publication; acknowledging an older committed
state must not deadlock the slot needed for a newer withdrawal. A future execution
gate must reconcile current SQL decisions and latest independent history before
action; it is not implemented here. A joined synthetic test acknowledges the first
publication, reserves a new operation and publishes its later withdrawal, retaining
it in history with false action authority.

No supported live operator route, automatic dispatch/release, SQL replay, provider
disposal or real custody/host-loss acceptance is added. Recovery bindings and
retained-source erasure gates remain closed. Reviewed mixed-protocol handling,
guarded recovery, all writers and one-use execution remain required.

## Exact local reconciliation proposal

`inspectConfluenceCopyReconciliation` is an active-Owner/charity-scoped read-only
inspection. It locks and reads all five local decision tables, authenticates
independent history, then locks/reads the local rows again and rechecks control.
Changed local decisions or Owner/charity state stop inspection. No historical
insert guard is relaxed and no decision is mutated.

PostgreSQL checks row counts and JSON wire sizes before materialising review
JSON:10000rows/table,120MiB server aggregate with representation headroom before
the128MiB local-wire bound. Capacity excess returns no partial plan. This does
not establish large-history latency acceptance.

`buildConfluenceCopyReconciliationPlan` compares complete immutable records with
verified latest states. Missing rows become proposed inserts in dependency order;
matching records are retained. Unknown local evidence (including an unpublished
withdrawal), conflicting values, duplicate IDs or foreign rows stop the plan.
Nothing is proposed for deletion or overwrite. Original dates and evidence stay
intact. Object-key order is immaterial; extra JSON fields are not discarded.

The candidate digest binds observed head/revision, local-row digest and inserts.
It detects change; it is not a signature, controller decision or restore authority.
Action/current-history/reopening results remain false even with no missing rows.
Captures, publication plans/receipts and source/copy state are outside this five-
table comparison. The inspection requires an active application Owner; it is not
the quarantined replacement-host maintenance flow.

Next implement a supported isolated maintenance coordinator with fresh independent
proof and exact local recheck for atomic historical replay. Current ordinary
writes correctly refuse that replay. Do not add an app-wide bypass flag, accept
plan JSON/hash as proof, or document raw database commands as an operator restore.
Mixed protocols, all writers, one-use execution and live host-loss proof stay open.

## Internal atomic maintenance replay

The forward migration adds invoker-only `ConfluenceCopyRecovery_rows` and
`ConfluenceCopyRecovery_replay` delegates, with PUBLIC execution revoked and no
SECURITY DEFINER or runtime route. Replay additionally checks the actual owner
of all five public tables, a SUSPENDED charity, read-committed isolation, observed
sole-client maintenance access, exact enabled user/FK guards and the original
local snapshot. Qualified public relations resist temporary-table impersonation.

Within one transaction it takes exclusive locks on all five tables, temporarily
pauses only their five named current-time insertion guards, and inserts exact
typed historical rows. Foreign keys, checks, unique constraints and no-truncate
guards stay enabled. Extra/missing fields, changed dates, foreign rows, duplicate
IDs or readback changes fail. All five insertion guards are re-enabled before
successful return. Errors roll back data and transactional trigger DDL together;
ordinary application roles receive no bypass flag or write capability.

`replayConfluenceCopyDecisionRows` requires an explicitly supplied maintenance
client, authenticates fresh independent decision history and regenerates the
exact proposal. A bounded read-committed transaction calls SQL, checks counts and
complete post-replay rows, then rechecks the independent head before commit.
Changed history or late errors roll back; private database errors are sanitised.
Unknown commit outcomes retry from fresh history/current rows, not a saved plan.
The result is explicitly scoped to decision rows and grants no action, overall
current-history or reopening authority. Charity suspension is never removed.

Real disposable PostgreSQL tests commit five exact recovered records, preserve
dates and suspension, and prove ordinary edits remain refused after commit.
They test late FK rollback, stale snapshots, role denial even after explicit
EXECUTE grant, disabled guards, another client and wrong transaction isolation.
Coordinator tests use mocked Prisma with real journal/envelope verification;
they are separate from the SQL delegate tests, not a real-provider/Prisma journey.

This remains an internal component, not a supported operator entry point.
Host integration must attest canonical source/destination, stop application and
worker access, use a dedicated single-connection maintenance client and maintain
quarantine. SQL's client observation alone is not proof of host isolation.
Existing supported installer/recovery paths remain authoritative; raw SQL is not
an operator substitute. Mixed protocols, all other writer/key facts, outbox,
one-use execution, real provider custody and host-loss acceptance remain open.
