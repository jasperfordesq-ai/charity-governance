# Retained Confluence copy disposal authority

## Status

The main CI workflow now runs `npm run test:confluence-copy-ledger-postgres`,
which builds the API and executes the existing joined disposable PostgreSQL
restart/maintenance proof. This is separate from the API migration fixtures and
retention-policy SQL checks. The proof uses synthetic external state; passing it
does not establish real-provider custody, transport recovery or safe reopening.

16 October source correction: a forward constraint rejects non-string/non-null
JSON digests in the original ledger capture's declared control. A numeric JSONB
value could previously match the hexadecimal text check. Actual PostgreSQL
regression covers that refusal and a valid all-digit hash string. Existing
fractional-counter refusal is retained. This validates stored metadata only;
it does not authenticate independent control, activate a provider or authorise
disposal/reopening. Prior migration checksums remain unchanged. Release and
existing-record reconciliation remain separate gates; immutable rows are never
silently rewritten to make a migration pass.

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

## Restore-drill inventory coverage

The existing purge/restore comparison now uses format10 to hash complete rows in
all eight Confluence decision/capture/publication tables plus original local
ledger captures. Missing or changed withdrawals, captures, plans or receipts
refuse comparison. Hashing occurs inside
PostgreSQL; the inventory exposes IDs/hashes and count-only differences, not
review content, reasons, key references or provider targets.

The blue-green drill probes both source and disposable restore schemas, selects
the exact snapshot query and checks response format. Partial Confluence schemas,
mixed modes or a downgraded response refuse, with no fallback. Exact format9
remains for schemas with the eight earlier tables and no local-ledger-capture
table. The complete absence of Confluence tables retains exact format8 behavior;
formats3–7 keep their inventories. Results report `schemaFormat`,
`confluenceRowsCompared` and `confluenceLedgerCapturesCompared` so a legacy match
cannot imply new-table coverage.

Real disposable PostgreSQL demonstrates the original gap: the format8 comparison
passes before/after Confluence-only withdrawals/publication changes, while
format9 refuses that older inventory. Other real SQL recovery suites retain
their existing document/complaint invariants. This does not prove a live VM
drill or independently held latest history: this drill reads a fresh live source,
which may be unavailable after host loss. The newer replay component still needs
complete independent facts and supported host integration. No backup is rewritten
and no drill result authorises application reopening.

## Complete local ledger capture before independent preservation

`captureConfluenceCopyLocalLedger` captures all eight Confluence decision,
withdrawal, capture and publication tables for one active charity Owner. The
five decision-state payloads cannot recover original capture IDs/timestamps,
publication plans, key-evidence references or receipts. Those originals must be
preserved explicitly; fabricating replacement bookkeeping would not satisfy the
format9 full-row comparison.

The internal reader uses a repeatable-read transaction, charity/actor locks,
parameterised charity selection and a fixed table allowlist. SQL count/size
preflight limits each table to 10,000 rows and the aggregate to 120MiB before
loading; the complete canonical body is bounded to 128MiB. Counts, duplicate IDs
and tenant scope are checked after transfer. Unpublished withdrawals and all
ordinary scalar metadata are retained, including the original facts string.
Database errors are sanitised. No primary document bytes, integration credentials
or unrelated tables are selected.

`CONFLUENCE_COPY_LOCAL_LEDGER_V1` is a confidential local snapshot format, not an
accepted journal kind. Installation/source labels are caller declarations, and
the SHA-256 digest is change detection only. The result explicitly returns
`independentlyPreserved=false`; it is not authenticated external history, a
permission validator or a restore artefact. There is no route, scheduled caller,
provider I/O, persisted archive, grant or application-reopen path.

Focused tests cover exact eight-table retention including unpublished facts,
Owner/tenant refusal, bounded inventory and sanitised failures. A separate
disposable PostgreSQL test runs the actual reader against all current migrations,
checks its real transaction isolation and empty-table SQL handling, excludes a
primary-document sentinel, and refuses Member/foreign/revoked-Owner access.
Nonempty eight-table byte/metadata retention is covered by the reader unit test;
that PostgreSQL case does not yet prove populated archive recovery.

Next: authenticated encrypted independent preservation of these original records,
binding to complete decision history and safe reconciliation of later facts,
followed by supported quarantined host recovery. No local digest or five-row
replay may substitute for these gates. Mixed protocols, old-host isolation,
provider/key custody, release-bound evidence and acceptance remain open.

## Encrypted complete-ledger archive primitives

The complete local ledger now has a strict canonical parser: all eight named
tables must be present, with no extra tables/header fields, duplicate IDs or
foreign rows. It preserves original metadata, rather than reconstructing it.
This is structural validation; it does not approve underlying decisions, verify
their semantic relationships or attest the caller-declared host/source labels.

`confluence-copy-ledger-envelope.ts` uses the existing AES-256-GCM/data-key
boundary with a distinct `CONFLUENCE_COPY_LEDGER_ARCHIVE_V1` format and AAD domain.
The AAD authenticates the exact validated context, declared observed control and
wrapped key. Context/control tenant, installation and epoch must agree; plaintext
source/tenant labels must match the context. Returned key buffers are wiped on
success and failure. The 128MiB plaintext limit has a separate 192MiB encoded
envelope limit. Maximum-size memory/throughput acceptance is not established.

Preservation conditionally creates an immutable object, authenticates readback
and requires the exact original canonical body. Same-operation retries use the
stored original ciphertext. Conflicting concurrent winners or changed metadata
refuse; acknowledgement loss requires the same original body and binding. The
caller still needs durable original capture/dispatch state before provider I/O;
recapturing a fresh timestamp is not a valid retry.

The S3 adapter has a distinct
`confluence-copy-ledger/<installation>/<charity>/<operation>.json` namespace.
Expected bucket owner, pinned region, separate replay/data-key ARN, version/SSE
metadata, checksums, conditional creation, byte bounds and deadlines reuse the
existing adapter boundaries. No bucket, key, credential or policy was provisioned.
The verified reader needs its expected digest/binding from separately trusted
publication evidence and never recreates missing published bytes.

The archive format is not an accepted decision or outcome journal kind. Its
observed control can be authenticated as supplied without proving that it was
current or independently approved. Results retain false current-history,
execution and reopening flags; storage readback does not establish custody.
No route, scheduled dispatcher, reservation release, restore or live caller uses
these primitives.

Synthetic tests cover full eight-table encryption, binding/AAD substitutions,
tampering, key cleanup, original-byte retries, conditional-write races and S3
transport refusals. Actual migrated PostgreSQL services now populate review,
unpublished withdrawal, capture and publication-plan rows; the local snapshot
retains their exact original fields and round-trips through the archive using
synthetic keys/in-memory objects. The other four tables remain empty in that
database case; nonempty eight-table coverage is unit proof. This is not real AWS
custody, publication freshness or populated host-loss replay acceptance.

Next: durable original archive dispatch, complete archive/history semantic and
epoch verification, authenticated later-fact reconciliation and supported
quarantined host recovery. Decision-only readers must reject archive entries
until their separate history/epoch rules are implemented. Do not add a generic
append or empty/missing-object fallback to obtain a passing restore comparison.

## Reserved archive publication and current-head readback

The journal now has a distinct `CONFLUENCE_COPY_LEDGER_ARCHIVE_V1` metadata kind
and explicit `appendReservedConfluenceCopyLedger` path. Ordinary `append` and
format1 `appendPublished` refuse it. Its operation cannot be reused for other
facts, and it has no disposal-outcome predecessor or automatic release rule.

`publishVerifiedConfluenceCopyLedger` authenticates an already preserved archive
against its exact plaintext reservation digest. Writer/epoch/tenant/operation
must match current control. The original declared observed head must be
unoccupied; its generation/digest are the archive entry's exact predecessor.
Control is rechecked after decryption and throughout the existing reserved
append/CAS path. Entry or head acknowledgement loss retries the same operation
and original ciphertext; missing or re-encrypted published payloads refuse.

`readPublishedConfluenceCopyLedger` verifies the complete current journal
metadata chain, exact archive entry, predecessor, encrypted object digest and
payload binding. The archive must itself be the current head under the same
writer/epoch. Any later journal entry makes that older archive unusable through
this reader. Head/control are checked again after decryption. These are bounded
observations, not an action fence, and the caller still needs separately trusted
key policy and current provider/custody guarantees.

The result's `archiveAtObservedHead` describes only this archive/metadata match.
It retains false global current-history, execution and reopening flags. It does
not approve local source claims, attest restored state or prove all other
writers/copies are covered. The semantic Confluence-only prefix checks below
now apply to this reader. Epoch/key transitions and other protocol families
remain unsupported. Decision-only recovery still refuses the archive kind;
that older consumer is not silently upgraded into a full archive restorer.

Publication keeps its exact active reservation. Generic CAS clearing,
disposal-outcome release and decision-state metadata release all refuse the
archive kind. The separate archive acknowledgement below now clears only its
verified metadata slot. No cancellation, automatic outbox, scheduled caller or
supported restore command exists yet.

Unit tests cover exact publication/readback, both lost acknowledgements, binding
and head races, missing/replaced ciphertext, later-head refusal, generic-append
refusal and release exclusion. The disposable PostgreSQL case composes actual
four-table governance/capture/plan/withdrawal rows through the archive and real
journal code with synthetic keys/in-memory control/object adapters. No actual
independent provider, old-host isolation, deployment or acceptance is proved.

## Semantic ledger and supported Confluence prefix verification

`validateConfluenceCopyLedgerRows` validates all eight exact record shapes and
their relationships. It reuses the existing historical decision validator,
allows expired/withdrawn history, refuses orphan/duplicate links, and validates
the original capture body/hash/scalars plus consecutive per-review lineage.
Captured decisions must match the immutable archived records; later unpublished
withdrawals are retained. Publication plans and receipts require real linked
captures/plans, correct generation and bounded UTC chronology. Temporary
validation frames are never returned, saved or treated as original history.

Both publisher and reader now require these internal row checks. The reader
also runs `verifyConfluenceCopyLedgerPrefix`: the complete current metadata chain
must contain only supported decision-state/archive kinds, with one matching key
and writer epoch. Each earlier payload is independently read at its published
digest and decrypted under its exact context. Published decision progression is
validated, and each archive must contain the matching original capture, plan and
receipt for every preceding decision entry. Extra receipts cannot reference an
unknown, future or other-kind publication.

Each later archive must preserve every immutable row from the preceding archive
without rewriting any field or moving its capture clock backwards. Missing old
decision/archive objects are never replaced by the newest complete snapshot.
Unsupported journal families, key/epoch transitions, absent decision-store
support and control/head races refuse the whole result; nothing is filtered out.
Verification bounds aggregate encoded payloads to512MiB, retained latest decision
facts to128MiB and checks a120-second monotonic processing budget around bounded provider
calls. This is not a maximum-capacity latency or heap acceptance claim.

The returned `archivePrefixVerified` is scoped to these Confluence records and
payloads. It does not establish actual historical Owner authority, controller
approval, provider custody, all other writer/copy facts or restored-state safety.
Global current-history/action/reopening flags remain false. Retired-key policy,
writer transfer and other protocol families require their own reviewed rules.

Adversarial tests include a signed archive that omits all publication bookkeeping,
receipt contradictions, original metadata rewritten across archives, missing
earlier objects and changing control. Complete multi-archive history with later
withdrawals passes. Actual PostgreSQL governance/capture/plan rows still compose
through encrypted publication and this reader with synthetic external adapters.

The pre-append candidate and exact-pending checks below now close the earlier
publisher-prefix gap. Durable original dispatch remains required before an
operational caller; exact acknowledgement is implemented below. No runtime caller is activated.
Supported host recovery, cross-family/epoch/key integration, real custody and
acceptance stay open.

## Pre-append candidate verification and exact pending recovery

`verifyConfluenceCopyLedgerCandidate` authenticates the already stored original
archive and plaintext reservation, then verifies every supported predecessor
payload and the candidate's complete original records before any journal write.
It shares the same semantic/payload verifier as current-archive reading. A
signed internally consistent snapshot that drops earlier publication metadata
now fails before append, rather than leaving an unusable published archive.

`readConfluenceCopyLedgerAppendHistory` requires the exact writer/epoch/slot and
original generation/digest. It verifies the complete metadata chain and returns
only the published predecessor entries. At most the exact matching archive entry
may be present at the next generation, either pending or already head-published.
Foreign pending work, changed ciphertext/digests, extra suffix entries, source
checkpoint conflicts and control changes refuse. A pending entry is never
labelled as published predecessor evidence.

The candidate and all preceding payloads are reauthenticated for every attempt,
including lost entry-write or head-write acknowledgements. The original body,
binding, ciphertext and entry are retained; no missing bytes are reconstructed.
Candidate plus prefix share the existing512MiB encoded-payload/128MiB latest
decision-facts bounds and monotonic processing budget. Metadata/control are
rechecked after verification; the actual append still uses the existing exact
reservation and provider CAS. This publication path introduces no timeout
cancellation, force-unlock or slot release; acknowledgement is separate below.

Tests reproduce the earlier source gap and prove pre-write refusal, original
pending retry, already-published retry, foreign pending work, replacement bytes
and a second pending entry. The PostgreSQL composition now asserts the
candidate-prefix gate before encrypted archive publication. External adapters
remain synthetic; no runtime dispatcher, real provider or hosted release is
activated. Durable dispatch, approved key/epoch/other protocol rules, supported
host recovery and Nikita acceptance remain open.

## Exact verified archive acknowledgement

`acknowledgeConfluenceCopyLedgerArchive` verifies the original prepared snapshot
digest/binding against the exact current archive and its complete supported
payload prefix. It rechecks writer, epoch, operation, plaintext reservation,
entry/ciphertext digest and control revision before using the distinct
`releaseConfluenceCopyLedgerControl` provider method. That method permits only
the archive kind; generic outcome and decision-state release paths remain
separate and cannot acknowledge an archive.

Successful readback must preserve the complete installation/charity/writer/epoch/
journal-head identity, change the revision and clear only the exact occupied
slot. Failed CAS without matching readback, unexpected identity changes and
pending/unpublished archives refuse. Lost-response retry still authenticates
the full original evidence before recognising an already empty slot. It cannot
clear a newly acquired operation. A concurrent identical acknowledgement is
recognised only from the exact final identity/empty-slot readback.

This is acknowledgement of historical metadata, not disposal completion or
latest-local-state coverage. Later local decisions still need their own archive.
The original digest/binding must come from durable prepared dispatch; that
workflow remains unimplemented, and this helper does not prove its durability.
No provider-I/O dispatcher, timeout clearing, force-unlock or production caller
is enabled. Global current-history, execution and reopening flags remain false.

Synthetic tests cover acknowledgement/retry/new-reservation progression, lost
responses, missing objects even on null-slot retry, wrong bindings, pending
publication and control/readback races. S3 transport tests exercise generation1
and2 archives, exact encrypted digest, ETag races and refusal across all three
release types. Actual PostgreSQL-generated rows now compose through archive
publication/readback and acknowledgement using synthetic external adapters.
This does not establish real provider custody or independent host recovery.

## Atomic original ledger capture before preservation I/O

`ConfluenceCopyLedgerCaptureStore.prepare` records the complete original body,
digest, actor, context and declared observed control in an immutable database
row. It captures the eight source tables and inserts the row in one
repeatable-read transaction under charity/actor locks. No key generation,
provider lookup, object write or reservation occurs in this operation.

The transaction explicitly requests synchronous commit; its SQL guard also
requires fsync/full-page writes and synchronous commit, active charity Owner,
valid binding/hash/clock, bounded source size and exact complete source rows
within the transaction snapshot. SQL compares all eight normalised row sets,
not a caller-supplied list of IDs. Update/delete/truncate and unreviewed recovery
binding activation refuse. Invoker functions use pinned search paths and public
qualified relations; no security definer, session bypass or runtime privilege
increase is introduced.

An existing operation returns its original validated body/binding without
recapturing new rows or timestamps. Changed actor/key/source/epoch/observation
refuse. An unknown local commit response is retried by lookup of that same
operation. Original bytes are returned only after active-Owner checks and
canonical/hash/relationship validation. Observed control/source labels remain
declarations until independently authenticated in later publication gates.

These local transport records are outside the eight-table authoritative archive
payload, preventing recursive snapshots of their own bodies. Format10 backup
comparison includes their full original rows; missing later pending captures
therefore refuse an old restore. Their host-loss reconciliation is unfinished:
do not invent missing IDs/timestamps or treat the eight-table payload as proof
that the separate local transport records survived.

The flag `durableCaptureRecorded` means a committed database original under its
storage/durability contract. Actual power-loss storage and independent recovery
remain unproved. Tests show a fresh Node process/new database connection returns
the original bytes after the source records change; they do not simulate loss
of PostgreSQL or the host. No latest-local-state coverage or action follows.

### Exact prepared-ciphertext transport

`preservePreparedConfluenceCopyLedgerArchive` provides the pre-publication
transport step for a future durable dispatcher. The caller supplies the saved
original body/digest/binding and saved encrypted envelope/digest. Before object
lookup it verifies canonical structure, complete eight-table semantics, both
hashes, binding, original unoccupied observation and decrypted plaintext. It
needs only key unwrapping; key generation and resealing are unavailable.

Conditional creation sends only the supplied original ciphertext. Existing or
read-back bytes must match exactly, even when another ciphertext decrypts to
the same plaintext. Unknown write responses remain unresolved until retry with
the same candidate authenticates exact stored bytes. Invalid, missing or changed
readback never yields a successful receipt. Caller-input changes during key
unwrapping cannot replace the already checked strings or operation identity.

This helper does not save ciphertext, verify durable-save provenance or manage
publication progress. It must be called only while the operation is unpublished;
the future dispatcher must enforce that using durable state and independently
verified history. Once published, use the expected-digest read-only verifier;
a missing published object must not be reconstructed by this creation-capable
path. The older seal-on-demand convenience function remains for existing
synthetic composition and is not a restart-safe durable dispatcher. No runtime
caller is added. All global authority flags remain false.

### Durable original encrypted candidate

`ConfluenceCopyLedgerCandidateStore.prepare` saves one immutable ciphertext/hash
for a saved original capture. Initial Owner/charity/capture checks occur in a
repeatable-read transaction. Key generation/encryption happens outside database
locks. A second fenced transaction rechecks the original capture and current
active Owner, and saves the original ciphertext under synchronous commit. Only
the committed candidate is returned. A concurrent winner is authenticated and
returned; the losing generated candidate is never uploaded or returned.

Existing and unknown-local-commit retries authenticate the original stored
envelope and plaintext without new key generation. Corrupt rows refuse; there
is no automatic reseal or overwrite. A failed or lost commit cannot expose
uncommitted bytes to a caller. Preparation itself has no object-store methods,
reservation or journal access, so it cannot create an external candidate before
the local commit.

SQL enforces append-only insert, no update/delete/truncate, durable WAL settings,
repeatable isolation, active charity Owner and exact original actor/capture/
declared envelope binding/hash. Pinned invoker functions and public-qualified
relations provide no privileged bypass. SQL does not authenticate ciphertext;
application canonical/AES-GCM/plaintext validation remains required before
upload. A durable candidate receipt is a local database guarantee under its
storage contract, not physical power-loss, independent custody or current-history
authority.

Both local transport tables remain outside the eight-table archive payload to
avoid self-recursion. Format11 includes candidates and captures in full-source
backup comparison; format10 retains the earlier capture-only inventory. Host-loss
reconciliation of these separate local transport rows remains unfinished.
The original publication phase still must be enforced by a future durable
dispatcher; preparation is not proof that a missing remote object is unpublished.

### Durable authenticated publication observations

`ConfluenceCopyLedgerProgressStore.observe` records separate immutable PUBLISHED
and ACKNOWLEDGED observations for an already saved candidate. It accepts only
object reads and control reads. It creates no provider object, appends no journal
entry, reserves no operation and releases no slot. Shared saved-candidate
authentication verifies original ciphertext/hash/binding/plaintext. Full exact
current archive and supported prefix verification are mandatory on every call,
including a retry with an existing local progress receipt.

The verified writer/epoch/head/revision and encrypted digest must match the
original candidate. A foreign active operation refuses both stages. ACKNOWLEDGED
additionally needs an empty current slot and an exact previously committed
PUBLISHED observation. It records an empty-slot observation, not proof that this
caller performed a conditional release or completed remote content deletion.
Active Owner/charity/original rows are checked again before local commit.
Unknown local commit retries preserve the original receipt identity; later
authenticated control revisions do not rewrite its historical observation.

Migration187 guards append-only observations, original candidate/actor/hash/
generation, publication-before-acknowledgement ordering, isolation/WAL and clocks.
SQL cannot independently authenticate external history. Local receipts alone
must never authorise object creation, skip external evidence or claim completion.
An unavailable/missing current archive therefore refuses even with a receipt.
Physical power loss and independent custody are not proved by database commits.

Format12 covers these local progress rows as well as saved capture/candidate
rows. Exact format11 retains the earlier candidate inventory, and formats3–10
remain available only for their matching schemas. All three transport tables
remain outside the authoritative eight-table archive, so host-loss reconciliation
of them still needs reviewed integration. Full dispatcher restart is not yet
implemented; a separate process can read the saved progress rows, which is a
narrower persistence check.

### Restarting the exact metadata operation

The prepared-candidate preflight forwards provider reader methods explicitly,
preserving their original receiver. It must not spread a class instance to copy
capabilities: inherited methods, including the production-style decision reader,
are not enumerable own properties. A regression with two published decision
payloads and a prototype-backed provider proves full dispatch, with a negative
missing-old-payload retry that performs no additional upload or release.

`ConfluenceCopyLedgerDispatcher.resume` coordinates one already saved candidate.
It never creates a fresh snapshot or encryption. Current writer/head determines
the path: an exact already-published head is reauthenticated and observed without
upload/reservation; an unchanged predecessor can reserve only the original
operation. Saved-candidate bytes and every supported predecessor payload are
authenticated before upload, using local candidate bytes strictly as preparation
input, never as proof that remote bytes exist.

Migration188 records a unique immutable `ConfluenceCopyLedgerUploadAttempt`
before calling conditional object creation. Only the successful first claimant
may invoke creation. Existing attempts, pending metadata entries and published
heads use expected-digest object reads. A lost attempt-commit response, a crash
before upload or an unknown upload with no readable object therefore remains
unresolved: there is no automatic second create, expiry, takeover or force-clear.
This deliberate limit prevents retrying from absent local publication progress
and reconstructing missing published evidence. The supported default S3 adapter
also uses `maxAttempts: 1`; injected adapters must not secretly retry writes.

SQL checks original actor/candidate, exact declared original-head reservation,
absence of local publication progress, isolation/WAL/clock and append-only
lifecycle. These are local dispatch-intent controls, not independent proof that
the declared provider head is authentic. Application prefix/control inspection
still gates the action. Existing persisted attempts are validated before reuse.
Owner/original identity is rechecked around action boundaries; no transaction
lock is treated as a remote provider lease or host-isolation proof.

After exact byte readback, the coordinator uses the existing authenticated
publisher, commits a reauthenticated PUBLISHED observation, invokes only the
archive-specific acknowledgement, then commits ACKNOWLEDGED observation.
Unknown upload/entry/head/release responses preserve original identity and are
reconciled on retry. No source document or Confluence page is deleted. All global
current-history, execution and reopening flags remain false.

Tests use four fresh Node processes, a restricted disposable PostgreSQL role and
synthetic external state carried between processes, losing upload/head/release
responses in sequence. They converge to one create, original ciphertext and two
saved observations. This is application-process restart against a surviving
database and synthetic provider, not loss of the database, real provider custody
or old-host isolation. An old/restored database must not run this dispatcher until
its separate capture/candidate/progress/attempt history is reconciled and the old
host is isolated. That supported recovery/activation integration is absent.

Format13 compares the attempt rows as well; format12 retains the prior progress
inventory, with exact older formats retained. All four transport tables remain
outside the authoritative eight-table archive. No route, scheduler, provider
credential factory or operator activation command is wired to this coordinator.

Next: independent transport-state/host-loss reconciliation and supported reviewed
provider/activation integration, including resolution of a stranded unknown
upload without inventing evidence or clearing a reservation. No automatic
cleanup is enabled. Original
capture retention/purpose and real key/provider custody still require review;
there is no automatic expiry or disposal of these confidential copies.
