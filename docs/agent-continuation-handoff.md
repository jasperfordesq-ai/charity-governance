# CharityPilot Agent Continuation Handoff

Last updated: 2026-09-30

## Atomic local preservation outcomes

Private release 24e9ca03 is deployed with bounded runtime, backup, restore and
Owner-navigation acceptance; the private release receipt records exact evidence.
Independent recovery remains inactive and incomplete.

The next source change adds `ComplaintHoldRecoveryOutcome`: insertion applies
the original prepared hold and records its outcome in one PostgreSQL transaction.
The ordinary hold guard rechecks current charity administrator authority and
record/revision state. The outcome guard additionally checks the exact preceding
hold and supplies its own event ID, transaction ID and timestamp. Rollback or an
outcome constraint failure leaves no hold transition. Outcomes are append-only.
The committed evidence reader verifies the original preparation and every hold
decision field, emitting a minimal receipt without reasons or evidence text.

This is an inactive internal primitive, with no route or ordinary service caller.
It does not verify remote publication or enforce the independent writer; that
execution gate, encrypted outcome publication, safe reservation cancellation,
release/replay and other preservation writers remain required before activation.
Do not treat a local outcome as independent custody or reopening authority.
Current source verification is recorded in the private hold-outcome logs; hosted
gates and deployment must be evidenced separately for the resulting revision.

## Inactive complaint database execution gate

The next preservation-writer slice adds `ComplaintHoldRecoveryPreparation` and
`ComplaintHoldRecoveryPreparationStore.capture`. It records a typed, immutable
apply/release candidate with the exact preceding hold, under charity/record/actor
locks and current Admin/Owner authority. Retry returns the original decision;
changed operation meaning is refused. No hold changes or independent publication
occur during capture. The schema excludes complaint narrative and the database
checks the prior event, current revisions, identity and digest. Both restore and
reset inventories include it. Local evidence is recorded in the private hold
preparation logs: API2,523, PostgreSQL5, inventory/reset/restore57 and the full
production-migration integration passed without failures or skips.

The follow-up hold envelope has its own authenticated payload kind and bounded
`hold-preparations/` object namespace. Publication decrypts the original candidate,
checks its reserved facts and unchanged writer/epoch/control, then records
`COMPLAINT_HOLD_PREPARATION_V1` through the existing reserved journal protocol.
Older readers reject this new kind. The published reader verifies full current
history and exact ciphertext, with no recreation fallback for missing bytes.
Candidate storage, journal-entry and head acknowledgement losses resume exact
bytes and operation identity. These are synthetic-provider tests, not AWS custody
acceptance. All receipts still grant no action permission; the reservation stays
occupied. Hold execution/outcome, safe cancellation of stale disposal reservations
and recovery replay remain required before activation. The original role/file,
report, replay-event, C1 and policy acceptance requirements remain open.

Hold-publication verification: API2,525 and separate PostgreSQL5 tests passed
with no failures/skips. SDK transport is synthetic. Keep the resulting revision
steady for exact hosted CI/E2E and supported deployment review before starting
another source slice. Deployment must keep recovery activation off; independent
provider custody and complete execution/replay are not supplied by this release.

Migration `20260930234500_complaint_recovery_execution` adds a durable, immutable
charity/installation/writer binding and transaction-bound execution receipts.
There is no supported activation, disable or writer-replacement command. With a
binding present, old service code and direct claims require a matching execution
in the same transaction; a deferred constraint requires the matching outcome.
Existing Owner, policy, hold, removal and retention guards remain in force.
Application rollback must preserve this binding and fail closed.

`executePublishedComplaintOperation` authenticates the current reserved published
preparation before opening a bounded local transaction. The transaction binds
the exact local preparation and enforced writer, then commits execution, claim
and outcome together. Provider IO stays outside database locks. Both new models
participate in restore comparison. This is inactive complaint-primary support,
not full all-writer protection, external-provider acceptance or permission to
reopen after server loss. No live provider or user-facing path is activated.

Local build, 2,519 API tests, five PostgreSQL checks, 57 inventory/reset/restore
checks and the initial complete guarded-protocol test passed. An expanded
protocol test also passed with Owner/hold/withdrawal changes between receipt
and claim. Final evidence is recorded privately. Hosted gates
and deployment remain separate. Next: durable preservation writer coverage,
document/worker/copy paths, approved custody, replacement isolation and the
original DPO acceptance requirements.

## Recovery protocol composition verification (earlier checkpoint)

The disposable production-migration complaint test now runs
`scripts/complaint-recovery-protocol-proof.mjs`: real Prisma/PostgreSQL capture,
reservation, authenticated preparation publication, atomic claim/outcome,
reconnection, authenticated outcome publication and exact release retry after
a lost acknowledgement. The local run passed without failures or skips.
Encryption is real; S3/KMS transport is synthetic and proves no provider custody.

This is test-only integration of the inactive recovery components. Ordinary
deletion paths still lack mandatory independent-publication enforcement at the
database boundary. Next work must enforce exact preparation/operation/writer
identity in the claim transaction, preserve current dependency guards, and prove
that bypassing the service cannot bypass an activated gate. Do not activate or
claim server-loss readiness from this test. Hosted checks, deployment, real
provider acceptance, replacement isolation and the original DPO acceptance
requirements remain separate gates.

## Current recovery publication checkpoint

The private release receipt `release-6afddb4f-acceptance.md` records deployment
and bounded acceptance of 6afddb4f, superseding the older source-only and d31
release statements below. Independent recovery remains inactive and incomplete.

The local `publishVerifiedComplaintPreparation` integration authenticates and
decrypts existing candidate bytes, checks their canonical facts against the
exact reservation, rechecks the control after decryption, and publishes the
ciphertext digest through the reserved journal path. It never recreates missing
bytes or grants execution authority. Five focused publication tests pass,
including lost acknowledgement and rejection of re-encrypted replacement bytes.
Local suite results are recorded in the private roadmap; hosted verification
and deployment of this follow-up remain separate gates. Outcome/release,
database enforcement, provider activation and full host-loss acceptance remain.

## Inactive recovery reservation acquisition

`recovery-operation-reservation.ts` adds acquisition against a strict format-2
control contract: charity/installation binding, current writer ID and epoch,
journal checkpoint, and one non-expiring operation/preparation digest. Atomic
conflicts and lost acknowledgements require reconciliation or exact retry;
receipts still return `actionAuthorized: false`. No live caller, provider adapter,
release, initialization, writer replacement or database execution fence is wired.
The provider integration must use one authoritative control resource for journal
publication, reservations and writer changes. Do not combine this with a separate
format-1 head or interpret it as host-loss recovery readiness. Preparation facts
and encrypted envelope bytes have distinct digests and must remain distinguished.
Local verification: four focused reservation tests, 2,502 main API tests and four
separate PostgreSQL migration tests pass. Hosted verification and deployment of
this addition remain pending; the private release receipt is authoritative.

The follow-up S3 adapter implements format-2 read/acquisition on the existing
`head.json`, with its existing bounded encrypted/versioned object I/O and ETag
conditional write. Format-1 and format-2 head readers reject one another. The
adapter refuses release and writer/epoch changes. Reserved complaint preparation
publication now advances one journal generation while preserving the exact
active operation and writer. Outcome transitions and database integration remain
unfinished. This is not a
second independent head or an automatic protocol upgrade. No AWS resources,
credentials or live caller have been activated. Focused adapter/reservation
verification passed 22 tests before the subsequent publication integration.
`appendReservedComplaintPreparation` rechecks the writer/epoch/preparation on
every projected head read and conditional write, then uses existing journal
chain/retry verification. The envelope digest must already have been verified by
the caller; this method records it, does not fetch or decrypt it. Publication
retains the reservation and grants no execution permission. Full local tests for
this follow-up are recorded in the private roadmap; hosted/live acceptance remains
separate.

## Recovery authority development and corrected release status

The inactive recovery reader now joins full journal/current-head verification
to exact encrypted preparation bytes through `readPublishedComplaintPreparation`.
The new `COMPLAINT_PREPARATION_V1` kind explicitly binds `factsDigest` to the
envelope SHA-256; older generic kinds are not interpreted as this payload, and
older readers reject the new kind. Missing/replaced envelopes and a head revision
change during decryption refuse the read. This is evidence retrieval only, not
writer reservation, execution fencing, replay application or permission to reopen.
No production caller or provider has been activated. Preserve the separate trusted
checkpoint and provider contracts; never source the expected digest solely from a
restored local database or recreate a missing published envelope.

Hosted verification for the inactive recovery foundation at
4b7eae1edfe16bf168069b9b45b7a9b992d6671a passed: CI 36742905676 and E2E
36742905671 (238 browser tests). It is not deployed or a completed independent
recovery capability. The subsequent aggregate scan-deadline change has separate
local verification; do not attribute that change to the earlier hosted result.

The private release receipt records d31ac597d6af47e307921edb1990353cf10eb618
deployed on 30 September at 15:43 UTC after CI 36737004873 and E2E
36737004807 passed (238 browser tests). It includes both the surviving-document
restore comparison and backup preservation guard described below. Post-release
restore rehearsal and off-host backup hash checks passed. This supersedes their
earlier source-only status, but does not authorize host-loss reopening.

Independent recovery authority is still under development. The new journal
primitive is not connected to production actions. It requires an explicitly
supplied, charity/installation-bound checkpoint from separate trusted custody;
reads and writes refuse history shorter than that checkpoint or with a different
digest at that generation. This detects loss or replacement of known history,
not truncation after an old checkpoint. Receipts never authorize actions.

The separate `inspectCurrent` operation also requires a live independent head
source: it compares complete observed history with two validated head reads and
refuses a changing revision, missing head or unpublished journal suffix. Its
provider contract requires authenticated uncached reads and non-reused revisions.
This is an observation only: action fencing is not implemented, and another
writer can advance immediately afterwards. Do not use it as an execution permit.

The subsequent local `appendPublished` protocol adds conditional head publication
through an abstract provider contract. It resumes the exact operation after loss
of either object-write or head-write acknowledgement, refuses a different pending
operation, and rejects a head behind the separately trusted checkpoint. It does
not create an initial head. Successful receipts still cannot authorize actions.
Real provider integration, durable custody and fencing remain required.

The S3 intent-object adapter is now implemented for explicit credentials, an
Ireland endpoint, expected bucket owner and a configured KMS key. It uses
create-only conditional writes and bounded current-version reads. Its tests
include SDK request serialization/signing through an isolated HTTP handler.
The S3 head adapter now reads a strict envelope, derives a revision from the
bound request/version/ETag/body, and conditionally advances one generation with
a fresh publication UUID. ETag conditional writes are not version-ID conditions;
privileged out-of-band replay remains a custody/policy threat. Missing heads do
not initialize automatically. Combined synthetic journal/adapter restart tests
cover lost publication acknowledgement. Explicit operation deadlines include
response streaming; the SDK warning-only timeout default is overridden.
Each full journal scan also has a 30-second deadline, propagated to S3 reads.
Cancellation cannot be interpreted as an absent object or empty history. This
bounds each scan, not the full multi-phase publication or a database transaction;
it does not replace the durable mutation fence or justify holding locks remotely.
Measured synthetic SDK counts for the current full-scan implementation are
4N+9 GETs and two PUTs per successful publication with N existing entries.
The private deployment/cost review records regional rate sources and assumptions.
Before paid activation, replace repeated whole-history append scans with verified
incremental traversal and make full recovery resumable; also resolve the
10,000-entry capacity/rollover boundary. Do not weaken chain/freshness checks or
raise deadlines as a substitute. No live resource has been provisioned.

An opt-in VERIFIED_PREFIX append mode now reuses only history fully verified in
the same process, rereads its boundary and verifies new entries. Measured warm
appends at 10 and 100 existing entries use 12 S3 GETs and two PUTs. FULL remains
the default; recovery inspection always traverses every entry. Prefix mode does
not re-audit older bytes on every append and must stay disabled until immutable
entry storage is independently enforced and reviewed. Failures invalidate reuse;
known history cannot silently shrink on fallback. Restarts require verification
again. Resumable full recovery, rollover, mutation fencing and activation remain
unfinished; this optimization is not a recovery or disposal authorization.
No S3 resource has been provisioned or live-tested. Provisioning, bucket
policy/retention, independent key custody, fencing and end-to-end recovery
acceptance still gate activation.

Replay/fencing design must account for the actual claim triggers: both primary
records are deleted in the claim transaction; only document byte cleanup is
deferred. A worker-only journal check or post-claim publication is too late.
The ignored replay/fencing contract and source map cover 17 ledger models plus
three mutable state/job models. Review their field-level retention and dependency
requirements before exporting data. Current head observations do not fence a
later hold, and replacement-host writes need an independent writer epoch. Do
not replay old claims through ordinary insert triggers during restore planning.

Before integration, implement fresh independent authority, protected replay
facts, provider durability/permissions, action fencing and supported recovery
reconciliation. The bounded sequential prototype must not be presented as the
complete store protocol or used as permission to reopen. No paid storage or
retention terms have been activated. Full original DPO scope remains open;
private proposal and review pack retain the decisions and evidence.

## Backup preservation guard - 30 September 2026 (source only)

Inspection found age-only recursive deletion of backup sets after deploy and
standalone backup, independent of approved terms or preservation holds. A real
filesystem test reproduced loss of an aged synthetic set. Both commands now
preserve all sets and report the count needing age review; fourteen days is only
a review reminder. No disposal permission or retention term is inferred. All 118
deployment/backup tests pass, including byte-preservation checks through both
command paths. Evidence: private backup-preservation-red.log and
backup-preservation-green.log. No live backup was changed by these tests.

The next release must include this guard together with 289e61f9's restored
document-control comparison. Exact hosted checks and deployment remain pending.
Capacity monitoring, approved backup disposal with current holds, independent
durable authority and supported recovery reopening remain open. Do not deploy
the intermediate restore-only candidate as the final remediation release.

## Verified release and next restore guard - 30 September 2026

Release 5f02c28ea016805c4988976fbe03a7da93486623 passed exact CI
36733408484 and E2E 36733408468 (238 tests) and is deployed on the private
review host. Runtime, local-only host publication, off-host backup hashes and
the supported restore drill passed. Signed-in Owner read-only checks loaded
the new audit feeds and empty document/complaint copy policy and claim histories.
No real policies, holds or disposal decisions were created. Private receipts
and the original six-finding acceptance table remain in the ignored review pack.
This supersedes older source-only release statuses below, not their limitations.

A further restore gap was reproduced in an isolated PostgreSQL restore:
changing a surviving document's hold was accepted when purge history matched.
The comparison now includes full surviving document row hashes, covering
recovery and visibility controls without returning raw fields. All 44 focused
tests pass, including actual PostgreSQL restore drift for hold, active/removed
state, recovery deadline and Member visibility, plus orchestrator refusal and
cleanup. Evidence: private document-restore-controls-verified.log (runner 67734,
exit 0). This additional guard is not yet deployed. Independent durable
authority, supported host-loss reopening and broader original DPO scope remain open.

## Release gate fixture repair - 30 September 2026 (verification running)

Broader CI exposed two stale removal mocks after the policy ambiguity guard:
one still expected the document lock before the organisation lock; one returned
the selected policy for the competing-policy query. Both reproduced locally.
The fixtures now assert the scoped lock/query contracts, and the route scenarios
include a competing approval refusal. All 102 tests in the two affected files
pass. No application guard or expected refusal was weakened.

Evidence: private release-ci-failed.log, removal-fixtures-red.log and
removal-fixtures-green.log. The full API test command is now running; exact new
CI/E2E acceptance and deployment remain pending. Runtime remains e39edbe8.

## Admin copy preservation navigation - 30 September 2026 (source only)

Documents and Registers now include copy preservation administration for existing
Owner/Admin viewers. It discovers committed primary claims through the metadata
archive, then loads exact scope/revision metadata through a new browser-only
copy-scopes endpoint. The service rechecks active Owner/Admin identity, same
charity parent and committed claim; it excludes observation reasons/evidence.
Admins retain no access to Owner-only complaint disposal plans or copy authority.

The panel requires complete scope pages before selection, supports a newly
identified scope at observation revision zero, and opens the existing guarded
hold/release form. Stale revisions are rejected server-side. New-scope entry is
implemented but not separately exercised in the new Admin browser journey.

Nine API/service tests pass, including the role/client/session-level matrix and
scoped metadata selection. API build, web/E2E types and targeted lint pass.
Both compiled isolated Chromium journeys pass (27.5s and 35.1s): a separate
Admin discovers a claimed scope, records a hold and reloads it; Owner approval
controls remain absent. Existing Owner policy/authority/observation/audit flows
also run. Evidence: private admin-copy-browser.log. Runner 81078 completed exit 0.
Runtime remains e39edbe8. No real policy or business record changed. Exact release
verification and live acceptance, plus broader original DPO scope, remain open.

## Retention and disposal audit coverage - 30 September 2026 (source only)

Nine additional metadata feeds cover retention policy revisions/withdrawals,
complaint recoverable removal, and document/complaint primary disposal authority,
withdrawal and claim. Authorization/claim feeds page by their own recorded times
with an ID tie-breaker. The dashboard displays those timestamps and explicitly
labels document claims as requiring a storage receipt. It excludes decision
reasons, evidence references, disposition plans, storage paths and transaction IDs.

All 35 audit API tests pass (nine initial missing-feed failures preserved in
private lifecycle-audit-red.log; green run in lifecycle-audit-green.log).
API build, web/E2E types and targeted lint pass. Both compiled isolated browser
journeys pass in 55.3s, including populated policy, primary and copy audit feed
responses and rendered decision labels, with private fields absent from payloads.
Evidence: private lifecycle-audit-browser.log. Runner 37220 is terminal exit 0.
Runtime remains e39edbe8; source is not yet deployed. Admin preservation navigation,
release checks, live acceptance and broader original DPO scope remain outstanding.

## Scoped copy authority dashboard - 30 September 2026 (source only)

Owners can now load complete scoped authority/hold histories and copy-policy
history from the existing document and complaint observation forms. Exactly one
unwithdrawn approved copy policy is required. The form records explicit scope,
observation, predecessor and hold revisions, separate retention/hold evidence,
reason, expiry and a reviewed creation anchor for timed policies. It supports
withdrawal without grant fields. Changing evidence clears confirmation; every
submission invalidates review state, including uncertain responses.

An explicit selection attaches current scoped authority to a later observation
and changes the available outcomes to its reviewed disposition. The database
still rechecks ownership, policy, retention, holds, chronology and expiry.
Loading/refreshing review clears the selected observation authority. This UI
is not provider erasure or aggregate-erasure proof.

Two scope/policy selection unit tests pass. Web/E2E type checks and targeted lint
pass. Both compiled isolated Chromium journeys pass (58.4s), including copy
policy proposal/approval/withdrawal, hold/release, a retained scope reauthorized
for disposal, an explicitly bound absence observation, and authority withdrawal.
Evidence: private copy-authority-ui-browser.log. Session 76759 is terminal exit 0.
Runtime remains e39edbe8; no live business record or policy changed. Admin
preservation navigation, remaining lifecycle audit coverage, exact release and
live acceptance plus the original broader DPO requirements remain open.

## Copy retention policy dashboard - 30 September 2026 (source only)

Documents and Registers now expose separate DOCUMENT_COPY and COMPLAINT_COPY
policy panels through the existing restricted policy component. Admins can
propose terms; Owner approval and withdrawal use the established server gates.
Timed rules name reviewed copy creation as their anchor. No period is supplied
automatically. Copy-specific text distinguishes recorded recovery terms from
actual provider recovery and requires separate scoped authority for disposal.

Both compiled isolated Chromium journeys pass (48.1s): each retains a proposal,
requires explicit approval confirmation, approves a separate copy policy,
withdraws it and displays both historical revisions. They also repeat primary
disposal and copy hold/release coverage. Web/E2E type checks and targeted lint
pass. Evidence: private copy-policy-ui-browser.log. Session 24571 is terminal,
exit 0. No live policy changed. Runtime remains e39edbe8; deployment, scoped
copy-authority forms, Admin preservation access and wider DPO acceptance remain.

## Scoped copy preservation dashboard - 30 September 2026 (source only)

The document and complaint copy-observation forms now provide preservation
history and exact-scope hold/release review. A changed scope or observation
remounts review state; the complete paginated hold history is required before
submission. Evidence changes clear confirmation. Every submission, including an
uncertain response, invalidates the loaded revision before another attempt.
Release explicitly does not approve deletion or revive earlier copy authority.
The existing parent screens currently expose this workflow to the Owner;
Admin dashboard access and copy-authority review forms remain outstanding.

The scope-selection test, web/E2E type checks and targeted lint pass. Both
isolated Chromium journeys pass (39.5s total): each family records/releases a
hold, retains both decisions and clears confirmation when evidence changes.
The compiled disposable stack passed its readiness gates. Evidence: private
copy-hold-ui-browser.log. All handles are terminal. Runtime remains e39edbe8;
these are synthetic local checks, not live charity acceptance or deployment.

## Copy review audit integration - 30 September 2026 (source only)

Governance Audit now exposes six metadata-only feeds: document and complaint
copy authority decisions, scoped preservation holds and copy observations.
The dashboard names each history and links back to its restricted record area.
Reasons, scope references and evidence references are excluded from the overview.
Observations are labelled as observations, not proof of aggregate erasure.

All 26 audit API tests pass, including six new cases covering Member/connector
refusal, same-charity cursors, equal-timestamp pagination and exact response
projections. API build, web type check and targeted page lint pass. Private
copy-audit-red.log preserves six initial missing-feed failures; copy-audit-green.log
records the passing run. No live records changed. Runtime remains e39edbe8;
real browser verification, remaining lifecycle audit feeds, copy-review forms,
deployment and the broader original DPO scope remain open.

## Copy review API - 30 September 2026 (source only)

Document and complaint families now expose browser-only copy-authority and
copy-hold history/write endpoints beneath their purge authorization, plus
separate copy-policy proposal/approval/withdrawal endpoints. Authority review
and its history require the active Owner; holds allow active Owner/Admin.
Policies allow Admin drafts and Owner approval/withdrawal. All mutations require
ADMIN session level; direct connector access is refused. The server selects
DOCUMENT_COPY/COMPLAINT_COPY, never a submitted record class.

Strict review bodies require explicit confirmations, exact prior/scope/observation
and hold revisions, evidence and bounded dates. Withdrawal cannot smuggle grant
fields. Transactions recheck actor and same-charity primary claim, paginate
history within that parent and convert named database conflicts into safe review
guidance. No endpoint dispatches provider deletion or declares aggregate erasure.

42 focused API/service tests pass, including both route prefixes, every role,
WEB/connector sessions, READ/WRITE/ADMIN levels, controlled IDs, confirmations,
scoped pagination and independent copy-policy histories/anchors. API build and
408 connector tests pass (two Windows skips). Evidence: private
copy-review-api-final.log, copy-review-build-final.log and copy-review-mcp.log;
initial missing-module failures are retained in the red logs. All handles are
terminal. Metadata-only governance audit integration, dashboard controls,
real browser journeys and exact hosted/deployment acceptance remain next.
Runtime remains e39edbe8. No live policy or record changed.

## Vault policy ambiguity guard - 30 September 2026 (source only)

The legacy document-retention proof exposed a real guard gap: a selected
approval could still support removal/authorization/claim while another approved
VAULT_DRAFT policy remained unwithdrawn. Normal policy replacement already
withdraws previous approvals; this fix also rejects ambiguous direct database
state. Migration 2200 adds the check at all three transitions without editing
historical policy decisions or creating a cleanup job on refusal.

Recovery API transactions now lock the organisation before the document, matching
policy and purge ordering. Removal refuses competing approvals before reading
stored bytes. Withdrawal of the competing approval permits the reviewed operation;
original recovery deadlines, retention checks, holds and atomic deletion remain.
No evidence establishes that this ambiguous state exists in the live charity.
Runtime remains e39edbe8; this migration and the copy-control changes await release.
Review-management API/UI, metadata audit and full original DPO scope remain open.

Ambiguity proof: the initial database and service tests accepted the operation
and failed as expected. Final populated PostgreSQL proof passes in 65.38s,
including an explicitly lock-ordered concurrent approval/claim refusal, no
cleanup dispatch on refusal, and successful rollback-contained disposal after
reviewed withdrawal. All 21 focused recovery/purge API tests and API build pass.
Migration 2200 gate: zero blocked, zero warnings, no override. Private evidence:
document-policy-conflict-{red,api-red,api-green,final,build}.log and gate.json.
All test handles are terminal. The previously recorded primary-policy invariant
gap is fixed in source; live deployment/acceptance remains outstanding.

## Copy policy and observation binding - 30 September 2026 (source only)

Migration 2100 binds later document/complaint copy authority to a separately
approved DOCUMENT_COPY or COMPLAINT_COPY policy. Timed rules require a reviewed
copy-creation anchor and elapsed retention; permanent rules permit retention,
not disposal. Policy creation/withdrawal serialize with review consumers.
No policy is seeded or approved by this migration.

Observations can reference an exact current scoped authority. The database
rechecks its scope, active Owner, expiry, policy and unheld revision; evidence
cannot predate that authority. Withdrawal/expiry cannot silently reactivate the
original plan. Original-plan final observations also require that original
policy to remain current. NEEDS_REVIEW/FAILED facts remain recordable without
claiming a new disposal permission. Existing observations retain their original
binding; no evidence is retroactively attached to a newer decision.

Document and complaint observation APIs accept and return the controlled
copyAuthorityId, and translate these database refusals into safe review guidance.
Creating/reviewing copy policies, authorities and holds through restricted API/UI,
metadata audit integration, real browser journeys, hosted gates and deployment
remain next. External evidence and supplied anchor dates still require reviewer
verification; this does not independently prove provider disposal or all copies
absent. Runtime remains e39edbe8; migrations 1900/2000/2100 are not deployed.

Binding evidence: complaint PostgreSQL proof passed in 65.27s (the complaint
result in copy-binding-database-final.log); final document proof passed in
61.86s in copy-binding-document-final.log after explicitly resolving the
fixture's ambiguous approvals. Coverage includes policy withdrawal racing an
observation, hold racing an observation, release requiring a fresh review,
expiry, no fallback after withdrawal, scoped binding/chronology, timed and
permanent policy checks, original-policy withdrawal and populated restore.
All 27 focused API tests and 94 supporting restore/model/reset/backup tests
pass; Prisma validation/generation and API build pass. Pending migrations
1900/2000/2100 pass the static gate: zero blocked, three warnings, no override.
API evidence: copy-binding-api-{red,green}.log; build-final/unit/gate receipts
use the copy-binding prefix. All local handles are terminal. No live changes.

## Scoped copy preservation - 30 September 2026 (source only)

Migration 2000 adds immutable document/complaint copy-hold histories under the
retained primary disposal authorization. Active same-charity Owner/Admin review
can preserve a named area/scope even before its first observation. Releases
require the exact next revision; stale observation reviews, repeated states,
foreign actors and immutable-history edits are refused. Primary records need
not exist. Restore comparison and disposable reset/model inventories include
both ledgers.

New scoped authority records bind an explicit hold revision and require the
current scope to be unheld; withdrawals remain possible while held. A hold
arriving after a review is retained independently, so eventual consumers must
recheck that hold revision rather than treating the older review as current.
This is persistence and database enforcement only: API/UI, metadata audit,
current policy binding and observation-time authority checks remain to be
implemented. No external copy was deleted and no policy decision was approved.
Runtime remains e39edbe8; migrations 1900/2000 are not deployed.

Scoped-hold evidence: final real PostgreSQL complaint proof passed in 58.69s
and document proof in 54.76s. Coverage includes Owner/Admin versus Member,
suspended and foreign actors; newly discovered scopes; release/stale binding;
withdrawal while held; both explicitly lock-ordered hold/review races; and
populated restore rejection when hold history is missing. Supporting 94 tests,
Prisma validation/generation and API build passed. Combined pending migrations
1900/2000: zero blocked, two index warnings, no overrides. Private evidence:
copy-hold-{red,database-final,unit,build}.log and copy-hold-migration-gate.json.
All local test/build sessions are terminal. No live deployment occurred.

## Scoped copy authority persistence — 30 September 2026 (source only)

Migration 1900 adds separate document and complaint scoped authority histories.
An active same-charity Owner can append a time-limited reviewed decision against
an existing primary claim and exact area/scope observation revision. Exact
predecessor identity and revision prevent stale replacement. Separate controlled
retention and hold-review references are mandatory; withdrawal grants nothing,
and replacement preserves every prior decision. No primary plan is rewritten.
Restore comparison hashes both histories and disposable-reset/model inventories
include them. References are reviewer evidence, not independent verification.

This is the persistence increment, not an enabled disposal workflow. No API or
UI can create these records yet; existing observations deliberately continue
using the original plan and reject contradictory absence assertions. Next:
bind observations to exact scoped authority, recheck current policy/holds and
expiry under the shared locks, add restricted browser review and metadata audit,
and prove withdrawal/policy/hold races and both browser journeys. No provider
operation, policy approval, production migration or live data change occurred.
Runtime remains e39edbe8. Broader original DPO scope remains open.

Persistence evidence: real disposable PostgreSQL complaint proof passed in
53.98s and document proof in 51.32s, including stale restore rejection, immutable
withdrawal/replacement history, original-plan preservation, no implicit absence
authority and competing complaint authority revisions. All 94 supporting
restore/model/reset/backup tests pass; Prisma validation/generation and API
build pass. Migration gate: zero blocked, one new-table index warning, no
override. Private logs: copy-authority-database-final.log,
copy-authority-unit-final.log, copy-authority-build.log; initial missing-table
failure is recorded in copy-authority-red.log. All test handles are terminal.

## Verified deployment — 30 September 2026

Private runtime e39edbe8f220c9118d248ab7d92d95a603ba1cbb is live on green
since 13:49:34.968 UTC (14:49 Irish time). Exact CI 36722795524 and E2E
36722795397 succeeded; all 238 browser tests passed. The four migrations
1500/1600/1700/1800 passed the gate with zero blocked, four warnings and no
override. Candidate/front-door smoke, runtime health and exact scheduler
identity passed. Previous blue e5e988a3 is stopped and retained for rollback.
Only Caddy publishes 127.0.0.1:8080; the local Docker boundary was re-proved.

Complaint holds, Owner disposal authorization/withdrawal/claim, immutable
receipts, per-scope copy evidence and complaint-aware restore reconciliation
are now deployed. Signed-in Owner read-only acceptance reached Registers and
the fully loaded complaint-disposal panel, showing no disposal reviews. No
live retention policy, complaint purge or copy observation was created.

Cutover backup 2026-09-30T13-48-44-971Z and post-migration backup
2026-09-30T13-50-38-535Z have off-host copies with all three file hashes
verified against the host; dump/archive hashes also match their manifests.
The supported isolated restore drill passed with 129 migrations, 63 documents,
22 risks and 22 governing acts. Live complaint/policy/purge ledgers are empty;
populated destructive-workflow proof comes from isolated tests. This drill
is not authority to reopen a restored application after host loss.

Later approved changes to copy dispositions, independent durable purge
authority, supported recovery reopening, remaining classes/stores, real
record/audience decisions, historical replay attribution, role-specific live
acceptance and DPO/controller approval remain open. This is bounded private
release evidence, not public-launch or formal DPO sign-off.

The implementation checkpoints below are historical. Their source-only and
pending-deployment wording is superseded by the verified release above.

Complaint copy-evidence dashboard checkpoint (source only): shared evidence
controls now map complaint scopes/endpoints explicitly while retaining the
document workflow. Owner history supports new scope observations, follow-up
dates and append-only later observations without claiming aggregate erasure.
Isolated Chromium passed both journeys on first attempt: complaint 14.9s,
document regression 21.4s, total 37.8s; runner 83685 exited 0. Complaint proof
includes retained-backup evidence, revision-two reopening, historical revision
preservation, reload, exact actor and primary absence. Document proof preserves
its separate primary deletion-job state. Web/E2E type checks and edited-file
lint passed. Evidence: private complaint-copy-browser.log. All local handles
are terminal. Later changes to approved copy dispositions, exact hosted gates,
deployment/live acceptance, independent durable restore authority and broader
DPO scope remain open. Runtime remains e5e988a3; no live data changed.

Complaint copy-evidence API checkpoint (source only): Owner browser GET/POST
disposition routes now expose scoped, paginated history and append-only reviewed
observations. Writes require ADMIN session level, active charity Owner and a
primary disposal claim; strict input excludes primary disposition, spoofed actor
fields and unconfirmed evidence. Retained/unresolved statuses require follow-up
dates. Database guards remain authoritative for times, revisions and approved
plan consistency; conflicts return safe review guidance. No deletion is
dispatched by copy observations, and no aggregate erasure claim is returned.
Initial focused tests failed for missing methods; implementation passed 42
API/route tests, 408 MCP tests (two Windows skips) and API build. Private logs:
complaint-copy-api-{red,green,mcp,build}.log. Dashboard observation controls,
synthetic browser proof, separately reviewed later disposition changes, exact
hosted gates and deployment/live acceptance remain. Runtime remains e5e988a3.

Complaint copy-disposition persistence checkpoint (source only): migration 1800
adds immutable per-scope observations for snapshots, exports, audit/evidence,
backups and other copies. The primary deletion result remains its separate
claim receipt. Same-charity active Owner authority, an existing claim, exact
scope revision, consistency with the reviewed plan, bounded observation time
and future follow-up for retained/unresolved scopes are enforced in PostgreSQL.
Concurrent corrections accept exactly one. Restore inventories now include this
ledger; old populated backups lose authority and are refused. Real complaint
migration/backup proof passed in 51.5s, 94 reconciliation/model/reset/backup tests
passed, Prisma validate/generate and API build passed. Static migration gate:
zero blocked, one new-table index warning, no override. Private logs use prefix
complaint-copy-ledger. Initial test correctly failed for the missing ledger.
API/UI recording and real browser proof remain next. Retained scopes needing a
later change of approved disposition also require separately reviewed authority;
the immutable original plan must not be silently changed. Exact hosted gates,
deployment/live checks and wider record/store coverage remain open.

Complaint purge dashboard checkpoint (source only): Owner-only Registers panel
now supports explicit six-area copy-plan review, exact recovery/hold/policy
binding, withdrawal, separate permanent-action confirmation and paginated
retained history. No disposition defaults are chosen for downstream copies.
Confirmation is required; successful claim refreshes the recovery list without
unmounting the review. Receipts explicitly distinguish primary disposal from
erasure of retained copies. Synthetic Chromium journey passed in 10.5s (runner
83953 exit 0), including authorization, withdrawal, second review, confirmation,
primary absence, exact Owner receipt, recovery-list refresh and history after
reload. Initial run failed on exact selector-label lookup; explicit accessible
labels fixed it. Web/E2E types and edited-file lint passed. Evidence: private
complaint-purge-browser-fixed.log; initial failure is retained separately.
Scoped downstream disposition evidence, exact hosted gates, deployment and live
acceptance remain required. Runtime remains e5e988a3; no live records changed.

Complaint purge API checkpoint (source only): Owner browser routes now list
paginated reviews, authorize an exact removed revision/recovery decision,
withdraw unclaimed authority and explicitly confirm a primary purge claim.
Writes require ADMIN session level; every service transaction rechecks active
same-charity Owner membership. Input binds original recovery deadline, removal,
policy, record/hold revisions and all six reviewed copy-plan areas. Database
guards remain authoritative for changed holds/policies and expiry. A retry
returns the existing receipt without another deletion; transaction IDs are
excluded. API conflicts give a refresh/review message without raw database text.
Focused API tests: 44 passed. MCP: 408 passed, two Windows skips. API build
passed. Read/write connector coverage explicitly excludes all four new routes.
Private evidence: complaint-purge-api-final.log, complaint-purge-mcp.log and
complaint-purge-api-build-final.log. Dashboard confirmation/history, scoped
copy-disposition records, real browser proof, exact hosted gates and deployment
remain; no live purge or policy change occurred. Runtime remains e5e988a3.

Complaint purge concurrency checkpoint (source only): populated PostgreSQL
tests now prove both orderings of hold/claim, withdrawal/claim and restore/claim.
Each ordered test keeps the first transaction open until pg_stat_activity
confirms the second connection is waiting on a database lock. A hold or
withdrawal committed first blocks claim; claim committed first prevents a new
hold/withdrawal. Valid restoration invalidates the reviewed removed revision;
a raw restoration UPDATE waiting behind deletion affects no row and cannot
resurrect it (the recovery service separately returns not-found). A valid
single-Owner transfer also refuses the former Owner's claim. The first fixture
incorrectly attempted an ownerless charity and was rejected by the existing
continuity constraint; the corrected transaction transfers ownership legally.
Full populated migration/backup proof passed in 47.2s. Evidence is in private
complaint-purge-race-db-fixed.log. This closes the named database race gap;
API/idempotency, confirmation UI, downstream copy evidence, hosted gates and
deployment/live acceptance still remain. Live runtime is still e5e988a3.

Complaint purge claim persistence increment (not deployed): a claim rechecks
unwithdrawn same-Owner authority, exact removed record, current approved policy,
unchanged unheld revision, original recovery deadline and elapsed retention.
Database-generated transaction identity binds the guarded primary DELETE to the
claim; an AFTER trigger deletes exactly one complaint and appends metadata audit
atomically. Any later transaction error restores all three. Claims are immutable,
unique per complaint/authorization, prevent identity reuse and prohibit later
withdrawal. Restore reconciliation includes claim history and rejects any
claimed complaint still present even when source and restored snapshots agree.
Real proof covers early/withdrawn/stale-policy/stale-hold refusal, rollback after
delete and two competing claims accepting exactly one. Explicit hold/withdrawal/
restore-versus-claim race coverage, API/idempotent retry UI, downstream evidence,
hosted gates/deployment and bounded live acceptance remain required before
calling complaint purge operational. No live records or policies changed.

Earlier complaint purge review persistence checkpoint (superseded by the claim checkpoint above; not deployed): immutable
ComplaintPurgeAuthorization binds the current removed closed complaint revision,
removal decision and original recovery deadline, latest unheld revision, active
same-charity Owner and one current approved COMPLAINT policy. Timed policies
require resolution evidence matching the original removal revision. The plan
covers PRIMARY, SNAPSHOTS, EXPORTS, AUDIT, BACKUPS and OTHER_COPIES with controlled
references. Owner withdrawals retain history. Both tables participate in restore
reconciliation. These are reviewed intentions only: hard DELETE remains blocked,
no execution route exists and no copy is erased. Next implement a separately
verified atomic claim/delete receipt, rechecking policy/hold/owner/record and
retention/recovery expiry; prevent withdrawal after claim, retain metadata audit,
and extend restore resurrection checks before enabling the API/dashboard flow.

Complaint-aware restore reconciliation increment: the current-authority snapshot
now hashes complaint resolution, removal and hold ledgers plus current complaint
revision/recovery pointers. This refuses an old restore that loses hold decisions
or reactivates removed records even when append-only history alone would match.
Raw narratives, evidence references and reasons remain inside PostgreSQL.
Missing complaint inventories fail closed. The real complaint migration proof
now dumps/restores old and current populated databases: old history/state is
refused and the current copy matches. This is bounded same-host authority proof,
not independently durable authority or permission to reopen after host loss.
Exact successor hosted gates, private deployment and live restore drill remain
required. Continue complaint purge authorization/claim and broader R4 scope.

Complaint hold application checkpoint: browser-only Owner/Admin hold history and
state-change routes are implemented, with Admin session level for writes, active
actor checks, charity/record/actor locks and exact record/hold revisions. Active
holds now produce explicit retention/removal refusals. Governance Audit lists
hold transition metadata without case reasons/references. Registers supports
reviewed apply/release for active and recoverable complaints, preserving the
selection and refreshing assessment after changes. Isolated Chromium passed
first-attempt after a UI fix (16.8s, runner exit 0): apply blocks removal, release
permits reviewed removal, a new hold on the removed record survives restoration,
contents remain identical and all three hold events bind the exact actor.
The initial test found a whole-page refresh losing the selected complaint; only
hold history/assessment now refresh. All 58 focused API tests, 408 runnable MCP
tests (two Windows skips), API build, web/E2E types and edited UI lint pass.
Evidence: private complaint-hold-api.log, complaint-hold-mcp.log and
complaint-hold-browser-fixed.log. Security & Data wording changed after the
browser snapshot and passed focused lint. Exact hosted/deployment gates remain
required; runtime remains e5e988a3. Next implement guarded complaint purge,
copy disposition and complaint-aware restore reconciliation, preserving all
broader record/store, durable authority, reopening and DPO acceptance scope.
Older hold checkpoints below describe implementation order, not current API scope.

Complaint hold persistence increment (not yet deployed): append-only
ComplaintHoldEvent records alternating apply/release decisions, exact complaint
and hold revisions, active same-charity Owner/Admin, controlled evidence and
reason, with database timestamps. Holds apply to active and removed records
without changing complaint content or resolution revisions. Database guards
reject removal decisions and removal/purge while held; restore preserves the
hold. Retained hold identities cannot be reused. Real PostgreSQL proof covers
unauthorized/stale transitions, append-only history, holds arriving after removal
review, restoration without clearing a hold and competing hold writes.
Restricted API, dashboard, metadata audit feed, assessment/removal messages and
isolated browser proof remain required before calling this a usable hold control.
Then continue complaint purge and the full remaining scope below.

Current private runtime: e5e988a364c7ace46c7e77ac1a6821fb8cd2f17e on blue,
deployed at 12:46:33 UTC. Exact CI 36715435652 and E2E 36715435558 succeeded;
all 237 browser tests passed first-attempt, including the complaint recovery
journey. Two migrations passed the deployment gate without override. API/web
health, front-door smoke and exact scheduler version passed. Only Caddy publishes
127.0.0.1:8080; Tailscale Serve remains tailnet-only. Previous 442eb788 on green
is retained for rollback. Cutover/post-migration backups have verified off-host
copies; the supported isolated restore drill passed with 125 migrations.
Live complaint, policy and purge ledgers are empty, so this drill does not replace
populated synthetic proof or authorize host-loss reopening. Signed-in Owner
read-only acceptance confirms complaint resolution/recovery/policy panels,
empty policy history and Governance Audit. No live policy or complaint changed.

Next: audited complaint holds before permanent purge, then separate Owner
authorization/claim, retained-copy evidence and complaint-aware restore
reconciliation. Preserve broader R4 record/store coverage, independently durable
purge authority, supported recovery reopening, role/content acceptance and all
original policy/historical review decisions. Security & Data wording/navigation
is corrected in the working source after this release; it is not yet deployed.
The private release-e5e988a3-acceptance.md and complaint-purge-implementation-contract.md
record the restricted operational evidence and next implementation contract.
Older checkpoints below are historical and do not override this runtime status.

Complaint recovery application checkpoint: browser-only Admin-level remove and
restore routes now use charity/record/actor locks, current revision checks and
transactional policy/evidence validation. Removal retains the immutable decision;
restoration is limited by the recorded deadline. Both append actor-bound register
audit transitions without copying complaint narratives. Registers now offers
reviewed removal, a paged recovery list and confirmed restoration. Legacy DELETE
remains refused and points to these controls. The isolated Chromium journey
passed first-attempt (10.5s): active-list removal, recovery listing, content-identical
restore, both exact actor audit entries and stale resolution evidence afterward.
Runner exit 0. All 121 affected API tests, 408 runnable MCP tests (two Windows
skips), API build, web/E2E types and edited-file lint pass; the real recovery
migration proof passes again (25.3s). Exact successor hosted checks and private
deployment are not yet accepted. Prioritize finishing those gates and deploying
this complete recovery increment before the next purge implementation. Complaint
purge, other record classes/stores, durable purge authority and recovery reopening
remain in scope, alongside policy and role/content acceptance decisions.

Complaint recovery persistence checkpoint: ComplaintRemoval now retains scoped,
immutable actor/policy/evidence decisions and a database-calculated recovery
deadline. ComplaintRecord has a guarded removal pointer and timestamp. The
database requires a closed complaint without board evidence, current approved
complaint policy and elapsed matching resolution evidence for timed rules.
Removal and restoration preserve content; removed records cannot be edited or
receive resolution evidence, stale authority cannot be reused, and hard deletion
is refused pending the separate purge workflow. Ordinary lists/details, edits,
counts, search and working exports exclude removed complaints. The application
removal/restore service, UI, actor-bound restore audit and browser acceptance
remain open; no new runtime deployment occurred. Real PostgreSQL migration
proof passes, including restoration, withdrawn evidence/policy and expired
recovery refusal (expiry uses fixture-only time travel with append-only
protection re-enabled before testing). All 119 affected API/search/export tests,
51 model/reset checks, schema validation, API build and 408 runnable MCP tests
pass (two Windows skips). CI now names both complaint migration proofs.

38ed10ad CI 36713260937 failed because the legacy delete blocker returned 409
instead of scoped not-found for another charity's record. The implementation
now performs the same-charity active-record lookup before refusing deletion;
the existing cross-tenant contract passes without weakening its assertion.
Exact successor hosted gates remain required. E2E 36713260920 was still running
at its last observation; do not infer completion from the failed CI result.

Complaint policy/assessment checkpoint: the policy service now separates
COMPLAINT from VAULT_DRAFT, with RESOLVED_AT as the complaint timed anchor.
Browser-only administration permits Admin proposals and Owner approval or
withdrawal. A read-only assessment requires one current approved class policy
and the latest matching resolution evidence; it never authorizes removal.
Registers exposes policy history/administration and assessment. Legacy immediate
complaint deletion is refused with COMPLAINT_RECOVERY_REQUIRED until recoverable
removal is implemented, so new policies cannot coexist with that API bypass.
Forty-two focused API tests pass, including class isolation and deletion refusal.
The two isolated Chromium journeys pass first-attempt (complaint assessment and
existing exact-byte Vault recovery); runner exit 0. The deletion guard was added
after that browser image was built and is covered by the focused API tests.
MCP checks pass (408 runnable, two Windows skips); web/E2E types and edited web
lint pass. Hosted successor gates and deployment remain pending. Next implement
policy-bound recoverable complaint removal/restore, then purge; retain the
broader R4 stores, independent purge authority and recovery-reopening scope.

Complaint resolution review increment: Owner/Admin browser-only history and
submission routes, a Registers review panel and a metadata-only Governance Audit
feed are implemented locally. Both record and evidence revisions are checked
under the charity lock. The isolated Chromium journey passed first-attempt:
two competing browser reviews produced one 201 and one 409; withdrawal and
correction preserved history; reopening invalidated the earlier evidence.
The managed runner completed with exit 0. Fifty focused API/audit tests,
408 runnable MCP tests (two Windows skips), API build, web/E2E type checks
and edited web-file lint pass. The browser proof preceded the additive audit
feed and callback cleanup; exact successor hosted acceptance remains required.
No new private deployment occurred. Policy consumption, recoverable complaint
removal, purge and broader record/store coverage remain technical work.

Complaint retention persistence checkpoint: a new, locally verified migration
adds database-maintained complaint revisions and append-only resolution evidence.
Evidence requires the current closed complaint, a valid resolution date and an
active administrator of the same charity. Corrections and withdrawals retain
history; subsequent complaint edits invalidate the earlier anchor, and removed
identities with retained evidence cannot be reused. Existing complaints receive
no inferred resolution date. The disposable PostgreSQL migration proof passes,
as do schema validation, API build, 51 model/reset checks and 408 runnable MCP
checks (two Windows skips). This slice is not deployed. Restricted API, review
UI, concurrent request proof, policy consumption, recoverable complaint removal
and purge remain open. No policy is activated and no live complaint is changed.

Private deployment checkpoint: 442eb788920bb79b021eaef668c1a97af3bf81ce is live
on the existing private host from 11:44:52 UTC. Exact CI and E2E succeeded;
E2E recorded234 first-pass and two retry passes. Eight migrations passed the
unchanged migration gate; candidate/front-door checks and runtime health pass.
Pre/post-migration backups have matching off-host copies and the supported
post-migration isolated restore drill passed. The previous321a0c84 runtime is
retained for rollback. The live purge ledger is empty: this drill does not
prove recovery of populated purge history or authorize reopening after host
loss. Owner browser checks confirm the22-act Minute Book, governance audit,
empty recovery/policy lists and nine existing replay events. No live policy,
classification, report approval or deletion was performed. Broader record
classes, independently durable purge authority and recovery reopening remain
technical scope; policy decisions and role-specific acceptance remain open.

The two442eb788 retry cases are repaired locally: register history now owns its
charity; the token-disclosure journey owns its integration and explicitly tests
disconnected and connected-without-a-space states. It no longer assumes that
every connected account offers Change the space. Both complete spec files pass
together,24 first-attempt journeys (1.2m), managed runner exit0. TypeScript and
all116 runner contracts pass. This follow-up changes tests only, not runtime
behavior; exact successor hosted results are not yet available.

Further browser isolation checkpoint: 5b0e7c66 E2E completed with234 first-pass
tests and two retry passes. Compliance pagination inherited six earlier audit
rows; the Confluence connection journey inherited an existing integration.
Both journeys now create their own verified charity and fenced browser context.
The focused pair passes first-attempt locally (9.9s), managed runner exit0;
E2E TypeScript and all116 runner contracts pass. Assertions and product behavior
are unchanged. Exact successor hosted checks remain required. The efa2e27e CI
has passed local Docker smoke and the Linux MCP connector gate; its complete
CI/E2E results were still pending at this checkpoint. No new deployment.

Connector inventory follow-up: 41c00edf CI 36707087273 passed the previously
failing local Docker smoke, then found missing route and field classifications
in the MCP coverage ledger. Recovery/policy/purge administration is now explicitly
excluded with human-review reasons, matching existing API web-session guards;
eight new Document fields are classified as withheld by the connector privacy
filter. The inventory also names sibling-file purge reads and dynamically
registered claim/withdraw actions. No connector tool or access was added.
All408 runnable connector tests pass locally; two POSIX/symlink tests are skipped
on Windows and remain required in Linux CI. Exact successor checks are pending.

Browser retry follow-up: the three 6671d6fd retries were traced to fixture/input
behavior. The exact-count history test shared a worker charity, inheriting seven
earlier rows and leaving 202 future-dated rows ahead of later removal events.
It now uses its own charity and fenced context. The purge datetime fixture now
uses Chromium's canonical datetime-local value and checks millisecond fidelity;
Playwright rejects a noncanonical value such as .800 when Chromium stores .8.
All three affected journeys pass together on the first local attempt (34.3s),
runner exit0, with unchanged product behavior and no relaxed assertions. E2E
TypeScript and all116 isolation contract tests pass. Exact hosted confirmation
for this test revision remains required.

Local Docker startup follow-up: 6671d6fd CI 36705637183 passed the main tests,
reliability ledger and PostgreSQL backup/restore, then its smoke API exited.
A disposable PostgreSQL/application reproduction identified the demo seed's
missing required deadline-audit actor. It now passes the seeded Owner ID and
preserves an existing sample risk instead of overwriting its reviewed state on
restart. First and repeat seed through all 123 migrations pass, retaining four
starter documents and four same-charity deadline audit entries. Seed TypeScript
checking is now part of the API test command; 45 local-stack and 116 runner
contract tests pass. No live host was changed. Exact successor gates remain.

6671d6fd E2E 36705637418 completed successfully: 233 passed and three flaky
tests passed on retry (purge observation timestamp input, document history
pagination, and retained case linkage after removal). These are recorded
follow-ups, not a clean first-attempt result or successor/deployed evidence.

Logout release-gate correction: 60b07ed9 CI 36704289527 and E2E 36704289606
failed the isolated-runner contract because the new browser tests installed
request handlers over the origin fence. The earlier three-test pass below is
superseded for release acceptance. Replacement delayed-logout checks hold the
synthetic organisation database row and pass through the unchanged fence;
both dashboard and idle checks pass, as do all 116 runner contract tests.
Offline diagnostics exposed the Logout button's lazily loaded ripple animation:
its failed chunk download triggered a reload without a connection. Disabling
that button's ripple preserves the visible retry. All three replacement
Chromium journeys now pass (including no page errors on offline retry), along
with E2E TypeScript and edited-file lint. Exact successor hosted checks and
deployment remain required. The recovery runbook also records the current
purge-history comparison and its explicit refusal to authorize reopening.

Reliability ledger follow-up: 2e2267be CI 36703357729 passed the test step but
found eight stale guarantee links. Their claims still described immediate
document deletion/cleanup and broad Member deadline reads. Existing IDs now
describe provider-pinned upload reservations, recoverable removal, reviewed
purge claim retry and current-rule Member deadline scope, linked to the actual
tests. The executed reliability command reports API 2561/Web 542 passing test
titles and all 509 covered links verified; docs/RELIABILITY.md is regenerated.
Those are report/title counts, not new independent or deployed acceptance.

DPO-02 logout ordering repair: dashboard navigation and idle expiry previously
started logout without waiting for the response that clears cookies. Both now
wait; logout never triggers refresh interception, and failed sign-out retains a
visible retry instead of claiming success. The delayed-response browser test
fails against the previous implementation. Three corrected Chromium journeys
pass: delayed dashboard logout, network-failure retry and idle expiry. The
dashboard test verifies cleared cookies and no synthetic-charity replay event.
Web unit tests (543), web/E2E TypeScript and edited-file lint pass. This is local
proof of a reproduced defect, not attribution of all historical replay alerts;
exact hosted release and live observation remain required.

Hosted follow-up: f9857ed6 CI 36702789366 failed the web audit-summary test,
which assumed there could be no remaining decorative-page findings. The
refreshed audit flags Minute Book. The assertion now follows the recorded
route findings. Workspace test caching is disabled because source-wiring tests
also read repository-level docs/scripts outside package cache inputs. A direct
uncached web run passes all 542 tests; broader uncached verification is recorded
in the private release evidence. The earlier root-command success included
cached workspace results and is not proof of this changed audit assertion.

Data Requests release-gate repair: request state, API operations and stale-response
guards now live in a route-local hook, with shared typed records separate from
the 381-line display route. Rendered forms and request handling are preserved.
The local route inventory now counts all 41 routes; strict progress assertions
validate arithmetic instead of requiring a different checkout's July score.
The generated audit has been refreshed, without closing the human issue ledger.
Web build, TypeScript, scoped lint, all 45 local-Docker tests and six isolated
Chromium journeys pass (intake/pagination, response corrections, retained Vault
associations, review navigation and Member restrictions). The complete root test
command also passes. Exact revised hosted CI/E2E and deployment/live acceptance
remain outstanding. Prior cf955dcf CI failed the now-corrected 37-route assertion.

Windows release-check repair: Node-spawned Windows PowerShell inherited the
bundled PowerShell edition's module search path. The ACL helper now imports its
executing PSHOME Security module; archive-test creation likewise selects its
native Archive module. No execution-policy or ACL gate was weakened. All 164
personal-server tests pass. The complete local test command now reaches the
local-Docker suite, which exposes stale route-count expectations (37 versus 41)
and an actual 893-line data-lifecycle page. Resolve that page's structure before
claiming the full local gate; do not just relax the zero-oversized-page check.

Canonical CI 36701064283 for 63ca0da5 passed the full PostgreSQL backup/restore
step, resolving the sequence incompatibility with the unchanged verifier. The
later API suite exposed a stale cross-charity delete fixture: missing recovery
policy/version/evidence fields stopped at validation. The fixture now submits
the current request and asserts tenant-scoped lock/read plus no deletion or
recovery update. API build and all 36 document reliability tests pass locally.
Whole revised CI/E2E and deployment/live acceptance still remain required.

Audit-ordering backup compatibility candidate: the integer cursor now uses a
transactional database-default allocator. Populated upgrade/down/upgrade keeps
historical rows and high-water ordering; append-only, concurrent allocation,
rollback and snapshot visibility pass in managed PostgreSQL (two tests, exit 0).
All 50 disposable database safety tests pass. See
`docs/architecture/risk-verification-ordering.md`. The backup guard is unchanged;
exact-candidate CI backup/restore proof and deployment remain outstanding.

Browser gate repair: login and retention-help contrast now passes the actual
light/dark accessibility checks. Connector expectations now enforce Member
denial for approval readiness and unclassified Minute Book reads, and withheld
whole-file download refusal before a FULL/write authorised byte comparison.
The real browser approval journey exposed and fixed ApprovalsPage's duplicate
response-envelope unwrapping, which hid pending approvals. All 68 connector
tests now pass in the managed disposable stack, including UI password approval
and subsequent connector consumption; runner exit 0. No live change yet.

Remaining release blocker: CI 36698825672 at 78009bac now seeds the backup
sentinel successfully, but snapshot-bound proof refuses the PostgreSQL sequence
behind RiskControlVerification.sequence. Preserve audit ordering and backup
consistency when resolving this compatibility issue; do not bypass the guard.

Backup gate follow-up: CI 36698387739 for 86b5433d failed while seeding its
synthetic restore sentinel, before backup began. Its PENDING-to-PROCESSED
local-storage fixture omitted the activeObjectAbsentAt receipt required by
the new database guard. The fixture now supplies its synthetic fixed timestamp
in the same completion update; no production guard is relaxed. The backup
CLI suite passes 43 tests with one platform skip. Actual PostgreSQL CI backup
and restore verification and exact-candidate E2E remain required before deploy.

CI security follow-up: the synthetic worker proof uses tagged constant DDL and
the trusted repository identity SQL through Prisma's supported query API.
Integration control-character expressions now use explicit Unicode escapes;
the same 65 control-code-point boundaries are covered by a new API test.
Secret/SAST/control-byte scans and API build pass. The actual isolated worker
proof passes again (including the real five-minute retry) and the Owner purge
Chromium journey passes; managed runner exit 0. The regular production-check
suite now includes the purge/restore tests: 1,101 pass, zero fail, two platform
skips. These correct the failed security gate for candidate 486dcd4c; a revised
candidate still needs exact-SHA CI/E2E and deployment/live acceptance.

Release gate repair: Windows recovery-manifest ACL publication failed when a
Node child inherited the bundled PowerShell edition's module search path.
Both ACL setup and verification now explicitly import the Security module from
the executing Windows PowerShell's PSHOME. Owner-only ACL semantics and
fail-closed checks are unchanged; no execution-policy bypass was added. The
real owner-only directory/file test passes, and test:production-check passes
1,096 tests with zero failures and two platform skips when installed Git Bash
is selected instead of the unavailable WSL launcher. This is local evidence;
deployment and live acceptance remain outstanding.

Restore archive follow-up: the bluegreen drill now checks extracted regular
files against hashed current claimed local-storage keys. Matching paths fail
even if bytes differ or primary cleanup is pending. Path ambiguity and duplicate
entries fail validation. Tests cover conflict cleanup and charity-path scope;
remote copies and alternate filesystem links are outside this bounded check.
No destructive reconciliation is performed and no reopen approval is issued.

Restore-drill integration checkpoint: bluegreen/backup.mjs now invokes purge
reconciliation after artifact verification. It obtains current history with a
SELECT-only query to the configured live database, compares the disposable
restore, and recaptures authority to detect intervening changes. Missing schema,
unreadable authority and mismatches fail the drill with existing cleanup. The
117 backup/deployment tests pass, including stale/unreadable/changed-authority
refusals. The command explicitly denies application-reopen authority.
These are local orchestration tests plus the earlier real database primitive
proof; an integrated live drill has not run. Actual file/copy reconciliation,
independent durable authority after host loss and personal-server recovery
integration remain open. No private-host recovery entry point was altered.

Backup reconciliation checkpoint, 30 September: the new database comparison
primitive rejects missing/changed/unexpected purge history and reappearing
claimed documents. Four focused tests and the populated PostgreSQL migration
proof pass. That proof restores actual pre-claim and current pg_dump backups
into separate disposable databases: the older restore resurrects a document
and is rejected; the current restore matches the database ledger. Objects and
external copies still require reconciliation. This is local proof only.

Next: wire independently authenticated current authority into recovery paths,
preserve durable authority independently of old backups, handle concurrent
source changes, and check restored files/copies before reopening. The existing
bluegreen/backup.mjs runRestoreDrill at this earlier checkpoint verified artifact
fidelity and row counts only (superseded by the integration above). Do not claim the live
recovery safeguard is enforced yet. No live host profile was changed.

Dashboard downstream-evidence checkpoint, 30 September 2026: each claimed
disposal decision now exposes copy/backup history and an Owner form for a named
scope. Plan-compatible outcomes, evidence, observation time, required follow-up
and explicit review are shown. Later observations append a new revision with
fixed area/scope; older entries are marked historical. History is paged and
refreshable, forbidden responses clear its contents, and failed refresh after a
successful write is reported without pretending the save failed.

The isolated Chromium journey passes: record approved retention for a synthetic
backup scope, append a needs-review correction, retain both revisions across a
reload, and prove the primary job remains PENDING with no absence receipt.
Runner exit 0 and the rendered history screenshot confirm this local checkpoint.
Full web/E2E typechecks, edited UI lint, API build and 16 focused purge tests pass.
The first browser runs found an observation timestamp rounded before the claim;
the fixture now uses the actual database UTC clock with millisecond precision.
The UI accepts that precision and timestamp refusals now explain the permitted
interval. Database chronology guards were not weakened.

Real external-copy inventories/disposal, backup restore reconciliation, other
record classes, deployment/live verification and policy/DPO acceptance remain
open. Reviewer-entered observations never assert complete erasure or perform
provider actions. This checkpoint is local and has not been deployed.

Downstream disposition evidence checkpoint, 30 September 2026: the new
DocumentPurgeDispositionEvent ledger and restricted API retain append-only,
revisioned observations for a named scope in versions, Confluence, exports,
audit records or backups. Owner writes require a claimed authorization, an
explicit evidence review, controlled references and observation time. Unresolved
and approved-retention outcomes require a future follow-up date. Primary-file
absence cannot be entered here; it remains derived from the cleanup receipt.
Outcomes cannot contradict the immutable plan. A later discovery reopens review
by appending a revision; concurrent stale revisions are rejected.

The API exposes paged same-charity history to Owner/Admin web sessions and
writes only to the active Owner's privileged web session. It reports scoped
reviewer evidence without an aggregate erased status or provider action.
The dashboard editor, actual provider observations, complete copy inventories,
backup restore reconciliation, other record classes and deployment/live
acceptance remain outstanding. This ledger does not independently verify the
reviewer's evidence or the completeness of the referenced scope.

Verification: populated disposable PostgreSQL migration and real concurrent
correction test pass, including unchanged pending primary-job data. Schema
validation, API build, 24 focused service/route tests and all 51 model-map/reset
safety tests pass. The isolated database was removed successfully. These are
local proofs; no deployment or external-provider erasure is claimed.

Local primary-purge worker checkpoint, 30 September 2026: the guarded runner
now executes a real worker proof inside its exact attested API container, with
two identity-verified PostgreSQL connections and local tmpfs files. The proof
passes: retained removal/claim preserve bytes; only one competing worker
dispatches; completion observes actual filesystem absence; repeated processing
is inert; injected timeout preserves bytes and records a retry; early retry is
refused; normal retry after the real database deadline removes the intended file.
An unrelated control file remains byte-identical. Recovery expiry alone uses
synthetic dates in the disposable fixture; the retry clock/deadline is real.
Both reviewed-purge and exact-byte recovery browser journeys then pass after
their database reset. Runner exit 0 confirms the managed run and cleanup;
52 runner/attestation tests and E2E TypeScript also pass.

The initial proof incorrectly counted successful dispatches in the failed-attempt
counter, then tried to advance the application clock past a database-clock gate.
Both test assumptions were corrected without weakening production controls.
Ordinary browser probes now use origin-fenced browser fetch, and policy selection
uses its evidence reference rather than a hard-coded revision number.

This proves local primary-file disposal only. Supabase/version mutation, retained
per-store disposition evidence, Confluence/export/backup handling, backup restore
reconciliation, other record classes, deployment and live/DPO acceptance remain
open. No live policy was activated and no deployment occurred in this checkpoint.

R3 dashboard review and persisted browser handoff pass. The six-store form has
explicit Owner confirmation; cancellation and permanent primary disposal are
separate reviews, and history remains browsable after purge. Real disposable
Chromium proves upload/removal, authorization, early refusal, cancellation,
synthetic expiry/new approval, one pending cleanup job, idempotent retry and
history after reload. Runner exits 0 and history screenshot was inspected.
The stack has no cleanup worker; physical bytes are NOT yet proven removed.
Next verified isolated worker integration, retry/timeout/two-worker and external
copy/backup evidence. Final API build/79 tests, full web/E2E typechecks and UI lint
pass. Fixed selector naming and actual Prisma P0001 error translation. An earlier
generic navigation error had no captured cause and did not recur; preserve that
observation without claiming its root cause resolved. No deployment occurred.

R3 application service/API now exposes private bounded purge authorization
history and browser Owner-only authorize/withdraw/claim actions. Explicit plan
and execution confirmations, current Owner locks, tenant/revision binding and
pinned-byte hash checks precede new authority/claims; retries return one existing
receipt. Paths/fingerprints/transaction IDs are excluded from review responses.
API build and focused service/route tests pass. These tests use a DB double;
separate PostgreSQL proof is not yet a combined HTTP/provider journey. Next
dashboard review controls and real isolated end-to-end authorization, refusal,
cancellation, expiry/claim/worker-byte proof. Provider mutation after the hash
read and downstream version/Confluence/export/backup handling remain open.

R3 atomic database claim/outbox now checks Owner, unwithdrawn exact authorization,
revision/object, current policy, recovery/retention expiry, holds and links before
creating one pinned primary cleanup job, retained audit and Document removal in
one transaction. Claim commit prevents cancellation/restore and path redirection.
No API/UI consumer or deployment exists yet. Real PostgreSQL proof covers
rollback, duplicate claims and claim races against hold/cancellation/restoration;
expiry fixtures are explicitly aged in the disposable database, not production.
Next API/UI authorization and claim workflow, actual provider-byte/retry/timeout
proof, retained downstream-copy dispositions and R4/R5. A pending primary job
is not proof of erasure or DPO acceptance.

R3 withdrawal persistence is added: separate immutable Owner cancellation of a
purge authorization, same-charity/active-role checks, evidence and database time.
Two real PostgreSQL sessions prove duplicate withdrawal serialization; invalid
actors and rewritten history are rejected and no cleanup job is created. No
route or worker consumer exists. Next the atomic claim/outbox must lock the same
authorization, reject withdrawn authority, recheck document/policy/actor/holds
and both expiry boundaries, and reject withdrawal after irreversible claim.
The unpublished authorization migration was aligned to generated Prisma index
names and foreign-key update actions; no live migration was edited or deployed.

R3 authorization persistence now binds an immutable Owner decision to the exact
retained document revision/object, current policy and six-store disposition plan.
Database upgrade/negative proof and teardown pass; schema validation and all 51
model-map/reset-safety tests pass. A plan is not evidence of absence. No route or
worker consumes it; hard deletion remains blocked and restoration remains
available. Next implement authorization withdrawal and the atomic claim/outbox,
rechecking current actor/policy, revision, holds, retention and recovery deadlines
before releasing a pinned primary-storage job. Preserve separate downstream
dispositions and test restore/hold/purge races. R3-R5 remain undeployed and open.

The previously recorded full-web typecheck gate is resolved. Test environment
setup now respects Next's readonly NODE_ENV declaration; client logging tests
also restore the actual pre-test environment. Full `tsc -p apps/web/tsconfig.json
--noEmit --incremental false` passes without excluding tests. Test compilation
and all 30 affected proxy, download-URL and client-logging tests pass. Production
behavior is unchanged. Recovery retirement/race checkpoint is saved in
`6a332ce1`; R3 purge authorization/outbox and R4/R5 remain open and undeployed.

Obsolete DocumentService.remove and its private immediate-delete Confluence
retirement subtree are removed. Their obsolete test helpers/assertions were
retired; live cleanup-worker and publication-worker coverage remains and 191
focused tests pass with the API build. Both older DPO browser scenarios now
exercise retained removal: case association survives and Governance Audit shows
RECORD_REMOVE without a storage cleanup receipt. Both passed on the managed
disposable stack, with runner exit 0. Storage-job linkage after an actual purge
still needs its R3 journey; the old hard-delete journey is no substitute.
The PostgreSQL migration proof now uses competing sessions and observes actual
lock waits: a committed hold or policy withdrawal causes the waiting removal to
fail, preserving the active row and zero cleanup jobs. Test and teardown pass.
Next build R3 explicit purge authority/claim/outbox and the restore/hold/purge
races, retain downstream disposition accounting, and complete R4/R5.

Draft-policy administration is now implemented locally: browser Admin/Owner can
record immutable proposals; only the active Owner can approve or withdraw with
controlled evidence. Approval allocates a new revision and atomically withdraws
older approvals of VAULT_DRAFT. Existing removed-item deadlines are untouched.
The UI previews exact terms and requires the Owner's authority acknowledgement.
No live policy was activated. The expanded disposable browser journey passed
proposal, approval, replacement, unchanged recovery deadline, restored exact bytes
and explicit withdrawal. The new viewport screenshot was inspected successfully.
After that run, withdrawal adopted the same organisation/actor lock ordering as
approval; API build and all 74 policy/recovery/route tests pass on final source.
Real-database concurrent approval/withdrawal/removal still needs explicit proof.
Next retire unused hard-delete code/tests, adapt old DPO browser journeys, add
persisted negative/race proof, then implement R3 purge and R4 downstream/other
record classes before deployment and live acceptance.

Deleted Items/restore UI now exists and the real disposable Chromium journey
`tests/document-recovery.spec.ts` passes through upload, policy-bound removal,
retained PostgreSQL record/hash, zero cleanup jobs, Owner ordinary detail/download
404, Deleted Items listing, restoration, identical downloaded bytes, restricted
visibility and both audit events. Runner exit 0 followed the successful test.
The initial run exposed an API-client response-unwrapping mismatch in the new
panel; fixed and rerun successfully. The isolated production build/typecheck also
passed. This is synthetic local-stack evidence, not live charity acceptance.
Next: policy administration, retire the old unused hard-delete service and adapt
the two older DPO browser journeys that still expect hard deletion; broaden
persisted proof to missing/changed bytes, role/tenant denial and races; then purge,
other stores, approved activation, deployment and live review.

Ordinary Vault DELETE now calls DocumentRecoveryService.remove, requires an Admin
web session, current revision, approved policy and removal evidence reference,
and returns the retained removal result without a cleanup job. The dialog loads
approved unwithdrawn draft policies and requires explicit selection; none are
seeded or activated. The old DocumentService.remove implementation remains
uncalled by production routes and should be removed with its obsolete direct
tests before release. Next: policy administration and Deleted Items/restore UI,
browser verification and real persisted HTTP/race tests, then controlled purge.
API build and 69 recovery/route tests pass; 178 frontend wiring tests and the
274-file application typecheck pass. Full frontend typecheck fails in unchanged
tests that assign readonly NODE_ENV; record/fix this gate before release. No
browser proof or deployment was performed for this checkpoint.

Latest recovery checkpoint: a new DocumentRecoveryService implements policy-bound
retained removal and fingerprint-checked restoration with audit. Deleted Items
and restore endpoints require an Admin/Owner web session. Migration
`20260930030000_document_recovery_fingerprint` adds immutable removed-file hashes
and removal/restore audit kinds. IMPORTANT: ordinary DELETE still calls the old
immediate-delete implementation; the new removal service is not connected yet.
Next replace that route and dashboard action, add policy administration and
Deleted Items UI, then run persisted journeys and concurrency checks. Current
proof combines actual local storage with a database double, plus a separate
real-PostgreSQL migration test; no end-to-end or deployment claim follows.

Recovery continuation: removal-state migration and ordinary read exclusions are
now implemented locally. The PostgreSQL upgrade proof checks retained metadata,
no cleanup job, restricted restoration, policy withdrawal and rejection of new
citations/replacement links to trash. The mirror endpoint filters removed rows
before publication lookup. Build and 73 document-route tests pass after that
fix; the preceding broader focused run passed 804 tests. No physical-byte restore,
concurrency, removal/restore API/UI or live deployment is proven. R2-R5 remain
open; see the recovery contract for the next work and exact evidence limits.

Recovery R1 policy persistence is now implemented locally in migration
`20260930010000_retention_policy_revisions`: immutable proposals/approvals and
separate withdrawal facts, same-charity active actor checks, complete approval
evidence and bounded explicit periods. No tenant policy is seeded or activated.
The new `test:retention-policy` command upgrades disposable PostgreSQL 16
through the previous history and tests this migration with preserved document
and upload-intent rows; it passes with teardown. Schema validation, API build
and 51 model-map/reset-safety checks pass. Removal state, policy API/UI, true
trash/restore, purge and deployment remain open. See the recovery contract;
this does not close DPO-05 or authorize disposal.

The revised Nikita goal is active: finish, deploy and verify technical
remediation, prepare policy decisions and provide an evidence/acceptance pack.
The private `nikita-review-pack-2026-09-30.md` now contains nine proposed
decisions, a candidate schedule crosswalk and the four requested review
locations. No proposal is approved or sent. The remaining engineering
contract is [Document recovery and purge](architecture/document-recovery-and-purge.md).
The current ordinary draft deletion still removes the row and starts byte
cleanup; true trash/restore and full purge remain unimplemented. Work through
R1-R5 in that contract, including all ordinary read surfaces, concurrency,
downstream copies and backup reconciliation. Approval gates live policy
activation, not synthetic implementation. Do not equate cleanup retries with
restoration or a policy ledger with completed DPO-05 remediation.

2026-09-30 resumed live evidence: two 28 September replay alerts correlate in
the retained former API logs with logout, a rejected session check and a
rejected refresh milliseconds later. That sequence fits the former web
proxy's post-logout refresh path, which the deployed release removed; the old
logs lack a session-family link and the other five events remain unattributed.
Separately, NEXUS commit `33d8b492515293315051cbc219eff3c91b3440ae`
removed registrant names and email addresses from admin signup notices on
2 May. Two delivered notices to Jasper dated 8 August and 12 September omit
those fields. The live C1 risk was edited to record this bounded verification
and its date while preserving the open risk and unknowns about other
recipients, communities, locales, historical exposure and DPO acceptance.
The ordinary notice still carries an authenticated profile URL with a numeric
user ID. The original separate closure receipt was not found. Restricted
evidence and precise limits are in the gitignored private roadmap and replay
note; this is neither a universal control verification nor a breach finding.

2026-09-30 authorised private-host release: blue/green switched hOUR Timebank
CLG to `321a0c8434eb3b3bd5abbe1e4209dd950dd01bff` at 06:58 UTC after
57 migrations with zero blocked by the gate, its automatic pre-migration
backup, candidate smoke and public smoke. API and web are healthy, the
scheduler is running, the front-door health check is HTTP 200 and the prior
green version remains rollbackable. A clean Linux install and 1,096
production-check tests passed; the production dependency audit is clear. The
exact pre-deploy backup was copied off-host with matching hashes. A signed-in
Owner visit found the new Governance Audit, Security & Data and Data Requests
pages, all 63 Vault records restricted and unreviewed (including the statutory
directors/secretary register), the 22-act Minute Book and unchanged seven
historical replay events. At this initial post-release visit, the C1 risk
still carried stale wording; the later bounded correction is recorded above.
Its original verification receipt has not been found. See the gitignored
private roadmap and acceptance audit for restricted findings and limits.
This is a private-host release and bounded read-only acceptance, not formal
DPO approval or public-production launch evidence. Member classification,
external-report audience, retention/hold/recovery/purge rules, historical
replay attribution and Nikita's first-pass review remain open.

2026-09-30 pre-release discovery and preparation snapshot: the current tenant,
deployed commit and historical replay/C1 records were inspected under an
authorised read-only session. Restricted details and evidence limits are in
the gitignored private roadmap and incident note. The original C1 closure
receipt is still missing; the historical replay events lack request IDs, so
their cause cannot yet be certified. A point-in-time private-host backup
passed a restore drill and was copied off host with matching hashes. All 57
pending migrations then applied to a loopback-only disposable restore of that
backup; Prisma reported 115/115 current and the disposable database was
removed. The offline blue/green gate found zero blocked migrations and warned
about index builds and constraint validation. Local build, lint and 180
production-check assertions pass; the broad Windows tooling suite still has
two host-specific Bash/ACL failures, to be checked on the Linux release host.
Jasper authorised deployment; the source was unreleased at that checkpoint.
The rehearsal does not prove concurrent live writes, external-provider state
or DPO acceptance.

The pre-release Nikita acceptance recheck found local implementations for the
named source controls and four dashboard locations. The private-host Owner
visit above supplies bounded live confirmation of those locations and records;
Nikita's own account walkthrough is still pending. The March retention
schedule is not an approved CharityPilot class-to-disposal mapping. The
private roadmap gives the six-point evidence ledger. Do not infer a provider
purge or DPO sign-off from the local suite or private-host visit.

2026-09-30 DPO connector exclusion audit: browser action-approval list/grant
and Confluence authorization/space setup now require web sessions at the API.
The terminal connector approval path remains intact. API build, 97 focused
approval/integration tests and 22 connector approval regression tests pass.
The private `connector-exclusion-boundary.md` maps the dashboard-only routes
against direct API controls and distinguishes scoped session info, gated file
tools and terminal approvals. The later mutation pass below covers the listed
browser-only Confluence, Vault retry, Team and billing routes;
actual Nikita-tenant grants and historical exposure remain unverified.

2026-09-30 DPO-01/03/05 Vault and Confluence review-channel guard: direct
Admin connector reads of replacement candidates, mirror/control/deletion
histories and failed cleanup, plus external-copy and citation inventories,
now require a web session. Connector tool exclusion alone had not enforced
that API boundary. The separate authorised full-data document-download tool
is unchanged. API build and 165 document/integration route tests pass locally;
no actual external audience, provider purge or Nikita tenant was verified.

2026-09-30 DPO-02/06 history and replay channel guard: organisation,
deadline, Minute Book and compliance detailed histories, plus replay
diagnostics, now refuse direct connector sessions before their sensitive
reads. The allowed Team Security Audit connector tool remains accessible.
The API build and 107 focused route tests pass. Vault/Confluence excluded
reads were checked in the later 2026-09-30 pass; Nikita's historical replay
cause, C1 evidence and deployed tenant are not established.

2026-09-30 DPO-06 audit/control connector boundary: risk and register change
history, control verification/attention reads and verification writes, and
Governance Audit feeds now require an Owner/Admin web session at the API.
The connector catalogue's exclusion alone did not prevent direct requests.
The API build and 135 focused document, data-request, register and audit
tests pass. Other excluded dashboard reads need direct-API review; no C1
closure fact, historical event or live tenant was verified.

2026-09-30 DPO-01/05 connector channel hardening: document deletion-hold and
written-provider verification now require a web session before record access;
the entire controlled data-request route group also requires a web session
in addition to Owner/Admin. The connector's tool exclusions previously did
not stop a direct API call. API build and 90 focused document/data-request
route tests pass, including connector denial before case or document reads.
No actual hold authority, case evidence, provider state or Nikita deployment
has been verified.

2026-09-30 DPO-01 connector decision boundary: direct MCP connector calls to
the document PATCH route can no longer set visibility, content suitability,
lifecycle or external-publication approval. The connector's metadata edit
still works. The API checks client kind before file I/O or mutation; its build
and 68 focused document route tests pass. This closes a gap between the
connector tool schema and the underlying API, but does not prove human review
or the state of Nikita's deployed tenant.

2026-09-30 DPO-01 current-checkout Member browser retest: the guarded
disposable PostgreSQL/API/production-web/Chromium authorization journey passes
1/1 with runner exit 0. It checks restricted Vault detail and download return
404, expressly released bytes download, and Board, Compliance and Registers
remain read-only to a Member. This is local synthetic evidence, not review of
real file contents, Nikita's tenant, earlier exposure or DPO acceptance.

2026-09-30 DPO accumulated-checkout gate: the compiled non-migration API suite
passes 2,357/2,357 with the local Docker pipe available; four separate real
PostgreSQL migration suites pass 4/4. The compiled web suite passes 542/542
with the private test-only Windows account-lookup preload. Two web source
assertions were refreshed for the current Member release and draft-deletion
wording, and a compiled recovery CLI test avoids loading the TypeScript runner
for a JavaScript entry point. The earlier broad-suite host failures recorded
below are historical checkpoints. This is local proof only; Nikita's tenant,
real records, provider state, policy decisions and DPO acceptance remain open.

2026-09-30 DPO-01 Vault pagination: the dashboard now loads older Documents
pages beyond the former first 50 files and labels evidence counts as partial
while more remain. A disposable Owner browser journey reached the oldest of
52 synthetic files after the next page; web build, lint and E2E TypeScript
pass. This is local navigation proof, not actual-file classification or
Nikita-tenant verification. The API now pages from the last file's tenant-bound
cursor, and the screen asks for a refresh if the final loaded count changed
during review. This is still not a fixed database snapshot.

2026-09-30 DPO-01 reviewer-download receipt: migrations 50-51 attach an
optional SHA-256 and document revision to an Owner/Admin's existing append-only
download-preparation audit, with a separate concurrent lookup index. A new
Member-suitable assessment requires a prior matching preparation by the same
charity user and still hashes current server bytes before saving. The populated
64-baseline/51-DPO PostgreSQL rehearsal, 101 focused document API tests,
production web build, E2E TypeScript and two rendered Owner/Member journeys
pass locally. The second journey verifies refusal before download and release
after it. A failed disposable migration attempt showed the index must be in
its own migration; the corrected full rehearsal and gated cleanup exit 0.
This proves only server preparation, not human inspection, actual tenant
contents, Nikita's deployment or DPO acceptance.

The DPO-01 reviewed-byte control has since passed a disposable rendered
Owner/Member Chromium journey (1/1): newly uploaded test file, reasoned
lifecycle and Member release, authenticated Member download and a second
restricted file hidden. The initial runner stopped before testing because
`DeadlineReminderAudit` was missing from its strict reset inventory. Adding
that prior model restored exact coverage; 50 database-safety tests and the
guarded E2E rerun pass with cleanup exit 0. This remains local synthetic
evidence, not Nikita's deployment or actual file review.

DPO-01 reviewed-byte release, 2026-09-29: migration 49 adds a nullable
`memberReviewedSha256` and a `NOT VALID` gate on new/updated Member-visible
rows. Owner/Admin suitability review fingerprints current server-read bytes;
Member queries hide older approvals without a digest and the download route
checks current size and SHA-256 before delivery. The Vault identifies and
allows reasoned re-review of legacy suitable rows. Shared/API and production
web builds, 116 focused document/search tests, edited web lint, 71 migration
gate tests, SQL lint and the populated 64-baseline/49-DPO PostgreSQL rehearsal
pass locally with gated cleanup. This does not prove what bytes a human saw,
classify the real files or verify Nikita's deployment. No live migration ran.

DPO-01 written-provider release gate, 2026-09-29: migration 48 adds a
`NOT VALID` check requiring a known written provider for new or updated
Member-visible documents. The API refuses a `MEMBER_SUITABLE` assessment
until custody is verified and withholds legacy unknown-provider rows from
Member list, detail, search, activity, Board-submission and download paths.
Download rechecks custody after storage I/O. A populated disposable
PostgreSQL upgrade applied 64 baseline and 48 DPO migrations, rejected an
unverified release and allowed the same fixture after the existing custody
review path. API build and 162 focused tests pass; SQL lint has no finding.
The `NOT VALID` constraint preserves legacy rows for review, and the synthetic
custody fixture is not proof of actual provider contents or Nikita's tenant.

DPO-01 reviewed-file identity guard, 2026-09-29: migration 47 expands the
database trigger so a `MEMBER_SUITABLE` assessment cannot be retained when a
direct writer changes the document's storage path, provider, size, MIME type
or version, as well as the previously guarded card metadata. A populated
disposable PostgreSQL upgrade applied 64 baseline and 47 DPO migrations,
rejected each forged byte-identity edit and preserved Member access to the
unchanged fixture. The blue-green SQL gate has no findings and its 71 tests
pass. This does not detect a provider-side same-path byte overwrite, classify
real files or prove the reviewed tenant's deployed state.

DPO-06 connector change outcomes, 2026-09-29: Governance Audit now pages
existing append-only `ClientActivityEvent` rows for Owner/Admin. It shows
actor, method, matched route, record ID when present, HTTP status, request ID
and time, including refused connector writes. The overview omits the session
ID and supplied reason and replaces a literal unmatched path with a safe
marker. Member denial, tenant-bound paging and output minimisation pass in 17
focused archive tests; API and production web builds plus edited-page lint
pass. The activity hook records after response, so a failed audit write still
requires operational alert review; HTTP success is not domain-state proof.
This is source/local evidence, not Nikita's hosted audit trail.

DPO-02 connector process coordination, 2026-09-29: refresh now takes an
OS-owned `127.0.0.1` listener lock keyed to local user, API origin and realm
before reading the shared keyring token, and releases it after the replacement
is persisted. An occupied lock times out after ten seconds before token use;
the server's replay quarantine is unchanged. Four coordination tests include
real cross-process exclusion, and the full connector suite passes 406/410
with four platform skips. This needs every concurrently running connector
process upgraded; old processes do not participate. Nikita's historical event
cause, reviewed tenant and deployed client versions remain unknown.

DPO-02 connector refresh fail-closed guard, 2026-09-29: a successful connector
refresh must now return both tokens, and the new refresh token is stored before
the access token becomes usable. A missing/unreadable response or keyring write
failure clears the still-current spent credential. A rejected call preserves a
different successor written by another client. The focused Session tests pass
29/29 and full connector suite passes 401 with four platform skips. Connector
field-policy drift also now explicitly withholds the new Vault content class.
Cross-process coordination is now locally tested; Nikita's historical event
attribution and deployed verification remain open.

DPO-06 reminder audit, 2026-09-29: migration 46 adds a database-triggered,
append-only record of future reminder creation, status and reconciliation
transitions. Governance Audit pages the metadata for Owner/Admin without
recipient addresses, titles, provider IDs or errors. A populated disposable
PostgreSQL upgrade applied 64 baseline plus 46 DPO migrations and verified
the trigger and immutable history after an operational log was removed. API/web
builds and 16 focused archive tests pass. Earlier states cannot be
reconstructed; recorded status does not prove email receipt or Nikita's live
tenant state.

DPO-01 assessment freshness, 2026-09-29: a later Vault metadata edit now
withdraws a `MEMBER_SUITABLE` assessment and any Member visibility atomically,
with retained control and visibility events. Migration 45 rejects a direct SQL
metadata edit that keeps the prior assessment. A populated PostgreSQL upgrade
accepted the authenticated Admin edit, confirmed both audit rows and denied a
subsequent Member read; 98 focused document tests pass. Actual file reviews,
deployed tenant proof and DPO acceptance remain open.


DPO-01 Vault content assessment, 2026-09-29: Owner/Admin now record a reasoned
`UNASSESSED`, `MEMBER_SUITABLE` or `RESTRICTED_SENSITIVE` full-file access
assessment separately from lifecycle and visibility. Member Vault list, detail,
search, activity, Board-submission lookup and download require an expressly
Member-suitable file; download rechecks after storage I/O. Migration 45 defaults
all existing rows to unassessed and preserves old Member-visible rows for
controller review with a `NOT VALID` check while the API hides them. A populated
64-baseline/45-DPO PostgreSQL upgrade, 160 focused API tests, 71 migration-gate
tests and two disposable Owner/Member browser journeys pass, including a
sensitive-to-reviewed-to-restricted sequence. The exact tenant, prior exposure,
content classifications, Confluence audience and DPO acceptance remain open.


DPO-03/05 linked-evidence deletion guard, 2026-09-29: ordinary Vault draft
deletion now refuses a current standard link or cited charity-managed
Confluence page before creating a storage cleanup job. The conditional delete
checks again, and migration `20260929420000_document_linked_evidence_delete_guard`
blocks direct row deletion while either link exists. The populated PostgreSQL
16 rehearsal applied 64 baseline plus 44 DPO migrations, rejected direct
deletion with each link, preserved the links, and exited with gated cleanup.
API build, 131 focused tests and 71 migration-gate tests pass. This protects
link evidence. A focused disposable Owner browser journey also confirms an
unlinked draft still deletes and retains its reason in history. Review,
retention, restore, provider purge, tenant proof and
DPO acceptance remain open.

DPO-05/06 reasoned draft deletion, 2026-09-29: ordinary Vault DELETE now
requires a bounded administrator reason, validated before document access and
retained in the append-only `RECORD_DELETE` event in the same transaction as
row removal and the provider-pinned cleanup job. The Owner/Admin Documents
history remains readable after removal; Governance Audit shows metadata only.
The dashboard and connector require the reason. API/web builds, E2E TypeScript,
129 focused API tests, 397 connector passes with four skips and two disposable
Owner browser journeys pass with gated teardown. This is accountability for
draft deletion, not a deleted-item bin, restore, approved retention period,
provider/backup purge, reviewed-tenant proof or DPO acceptance.

DPO-05/06 source-area audit continuation, 2026-09-29: Governance Audit now pages the new data-request coverage events with charity-bound cursors and Owner/Admin access. It exposes request, area, disposition, actor and time; case reasons and controlled-archive evidence references remain in the individual case history. The connector explicitly excludes the case reads and human assessment write. API/web builds, E2E TypeScript, 15 focused audit tests, a focused disposable Owner browser journey and the full connector suite (397 passed, four skipped) pass. This is local proof, not reviewed-tenant, retention-policy, deleted-item recovery, provider-purge or DPO acceptance.

DPO-02 no-Web-Locks replay guard, 2026-09-29: a browser without cross-tab Web
Locks no longer presents an expired session's single-use refresh token. A
reactive probe accepts a cookie already renewed by another tab; otherwise the
browser directs to login with a clear fresh-sign-in explanation. Proactive
timeout extension and protected-page renewal take the same safe path. The API
still quarantines genuine spent-token reuse. The production web build, 56
focused compiled web tests, E2E TypeScript and complete five-case disposable
Chromium replay suite pass with gated teardown. Nikita's historical events,
deployed browser topology and logs remain unresolved.

DPO-05 data-source coverage review, 2026-09-29: Data Requests now lists eight
source areas per case as unreviewed until an Admin records a reasoned,
append-only assessment. The possible outcomes are in scope, needs follow-up
and not applicable, with an optional opaque controlled-archive reference.
Migration 43 enforces the tenant/case relationship and event immutability.
API/web builds, 20 focused API tests and a representative 64-baseline/43-DPO
populated PostgreSQL upgrade and focused disposable Owner browser journey pass.
These entries do not select retention periods, identify
all subject records, authorise erasure, restore deleted items, prove provider
purge or close a case. P0-08 remains open.

DPO-02 web-worker replay prevention, 2026-09-29: the Next proxy no longer
rotates refresh tokens after a protected-page `/auth/me` 401. It redirects
to a public no-store `/session-renew` page when a refresh cookie exists, and
the browser uses the existing shared lock and current-session probe before
rotation. The proxy still denies protected rendering on 401, keeps other
failures at no-store 503, and lets the Confluence callback handle its own
one-use code. The API's spent-token quarantine is unchanged. Production web
build, 51 relevant compiled web tests and the four-case disposable replay
suite pass locally. The broader generated web reliability command is not
verified on this Windows host: its `tsx` preload fails at `os.userInfo()` with
`uv_os_get_passwd ENOMEM`. This removes the source-level
race between separate web workers; Nikita's historical replay cause, her
deployed topology/logs and browsers without Web Locks remain unverified.

DPO-05 actual-response evidence, 2026-09-29: the Admin Data Requests case
screen records, corrects and withdraws actual response sent time separately
from a target, requiring an opaque controlled-archive evidence reference when
set. The case history is append-only and paged; Governance Audit pages only
change metadata. API/web builds, 33 focused case/audit tests, a focused Owner
browser journey and the full 19-case disposable DPO browser suite pass. A
representative populated upgrade applies 64 baseline plus 42 DPO migrations,
preserves an old case's unknown response as null, and refuses a pre-receipt
response date. This is local proof, not independent delivery proof, retention
expiry, deletion authority, Nikita-tenant verification or DPO acceptance.
P0-08 remains open; the CharityPilot schedule mapping and recovery/purge
design still need controller decisions and live evidence.

DPO-06 register action history, 2026-09-29: the Owner/Admin detailed register
change API and Registers page now page retained conflict, complaint,
fundraising and risk record actions past the former 100-row cap. The view
shows metadata and changed field names across years without earlier values.
API and production web builds, 26 focused register tests, edited lint and E2E
TypeScript pass. A disposable Owner journey viewed 52 tied-time changes, and
all 19 DPO browser cases passed together with gated teardown exit 0. This is
local proof, not historical backfill, Nikita's tenant or DPO acceptance. No
migration or personal-server profile was changed.

DPO-06 compliance detail history, 2026-09-29: the Owner/Admin compliance
audit now pages detailed retained decisions by charity and reporting year,
including tied-time events, rather than stopping at 100. The Compliance page
offers collapsed before/after records and older-page navigation. API and
production web builds, 22 focused compliance tests, edited lint and E2E
TypeScript pass. A disposable Owner browser journey viewed 52 synthetic
decisions and a retained state; gated teardown exited 0. This is local proof,
not Nikita tenant or C1 closure evidence. No migration or personal-server
profile was changed.

DPO browser suite, 2026-09-29: after risk-detail, register-action-detail, Minute Book-detail and
compliance-detail cases were added, all 19 Owner/Member cases passed together on the disposable
PostgreSQL/API/web/Chromium stack with gated teardown exit 0. This replaces
the older 14-case combined checkpoint for current local behavior; it is not
hosted or DPO acceptance evidence.

DPO-06 Minute Book detail history, 2026-09-29: the restricted governing-act
audit now pages retained detailed changes with a tenant-bound occurrence-time/ID
cursor instead of stopping at 100. The Minute Book page offers collapsed
before/after records and older-page navigation. API build and 37 focused
governing-act tests pass, as do the production web build, edited lint and E2E
TypeScript. A disposable Owner browser journey viewed 52 tied-time changes;
gated teardown exited 0. Earlier unrecorded history is not backfilled, and
Nikita's tenant is unverified. No migration or personal-server change.

DPO-06 risk detail history, 2026-09-29: `GET /governance-registers/risks/audit`
now pages detailed risk changes past the previous 100-row cap using a
tenant-bound, stable occurrence-time/ID cursor. The Registers panel loads
older pages and correctly reads the already-unwrapped API response for its
control-review attention and selected-risk verification history. API build,
25 focused register tests, production web build, edited lint and E2E
TypeScript pass. A disposable Owner browser journey displayed a synthetic
stale C1 claim, traversed 52 detailed changes and opened the selected risk's
retained claim; gated teardown exited 0. This is local proof, not C1 closure,
legacy audit backfill, Nikita tenant verification or DPO acceptance. No
migration or personal-server profile was changed.

DPO-05 deletion-hold database guard, 2026-09-29: migration
`20260929390000_document_deletion_hold_delete_guard` makes PostgreSQL refuse a
direct deletion of a Vault document while its administrative hold is set.
The existing Owner/Admin API still requires a reason and records hold changes;
ordinary Vault DELETE already refuses held rows. The blue-green SQL gate has
no block or warning. A populated 64-baseline/41-DPO migration rehearsal
rejected direct held-row DELETE and removed its exact disposable container.
A separate disposable Owner Chromium journey placed a reasoned hold, observed
the database refusal and retained document, and passed with gated teardown;
E2E TypeScript passes. This is defense for the existing mechanical hold, not
an approved legal-hold rule, retention period, deleted-item recovery, final
purge or proof on Nikita's tenant.

DPO dashboard server boundary, 2026-09-29: the new Governance Audit,
Security & Data and Data Requests pages were missing from the Next proxy's
protected-route list. The client layout still gated rendering and their APIs
enforced roles, but those page requests skipped server session validation,
login redirect and protected no-store headers. The prefixes are now covered,
and a structural test checks every dashboard route group. Focused compiled
route/proxy tests pass 32/32, as do test TypeScript, edited lint and the
production web build. Two disposable PostgreSQL/Chromium Owner/Member
navigation journeys pass with gated teardown. This is local verification;
Nikita's deployed revision and account remain unverified.

DPO reviewer navigation, 2026-09-29: all 14 synthetic Owner/Member cases in
`dpo-review-navigation.spec.ts` pass together in disposable PostgreSQL and
Chromium, including Minute Book, Governance Audit, document controls, data
requests, integration copies/citations, failed cleanup and Member boundaries.
E2E TypeScript and gated teardown pass. The first combined run passed 13/14;
its final audit assertion had matched a second absence receipt from an earlier
shared-fixture case. It now scopes the row by the deletion ID created in that
case; the whole rerun passed. This verifies local rendered behavior, not
Nikita's account, actual governance content or the reviewed deployment.

DPO-02 replay suite correction, 2026-09-29: the current isolated
PostgreSQL/Chromium run passed both spent-token and two-tab cases after the
second test stopped assuming an empty charity-wide replay history. Its
worker-scoped Owner charity retains the deliberate replay event from the
first case, so the two-tab test now asserts no increase from its own baseline.
The isolated runner and gated teardown exited 0; E2E TypeScript passes. This
is a test-isolation correction, not a determination of Nikita's historical
events or proof against multi-process races.

DPO-05 provider diagnostic boundary, 2026-09-29: the Admin failed-cleanup
listing now applies the existing diagnostic scrubber on read to legacy saved
`lastError` values, as well as on new writes. A focused route test confirms
redaction of an embedded object path, email and bearer value; API build and
13 recovery-route tests pass. The rendered Documents panel does not display
the field. This does not rewrite old rows or prove every possible historical
provider message is free of personal content; access remains Owner/Admin-only.

DPO-05 failed cleanup administration, 2026-09-29: the Owner/Admin failed
storage-deletion API now pages retained dead letters by a tenant-bound,
oldest-first cursor instead of stopping at 100. The Documents page lists
provider, terminal reason, attempts and dates in 50-row pages without showing
raw provider errors or object paths. Eligible jobs have a reasoned,
typed-confirmation retry using the existing `REQUEUE_UNCHANGED` route; a
permanently rejected storage path is directed to platform review. API/web
builds, 13 route tests with 203 jobs, edited UI lint and E2E TypeScript pass.
A disposable PostgreSQL/Chromium Owner journey reviewed 52 jobs, submitted
one retry and verified its retained recovery decision; the runner and gated
teardown exited 0. Retrying can later delete the target; it does not restore
a document or prove provider, version or backup purge. No Nikita tenant was
inspected and no migration was added.

DPO-03/06 document history, 2026-09-29: the Owner/Admin Documents
change-history feed now pages retained control and visibility events 50 at a
time instead of stopping at 100. The API uses a tenant-bound cursor and a
stable cross-table order, including timestamp ties; the Documents page can
load older entries while retaining prior pages. API and production web builds,
35 focused API tests with a 202-event tied-time fixture, edited UI lint and
E2E TypeScript pass. A disposable PostgreSQL/Chromium Owner journey loaded all
five pages of 202 same-time synthetic events in the rendered Documents page;
the isolated runner and gated teardown exited 0. The initial sandbox run
failed with `spawn EPERM` before starting the browser; the approved rerun
passed. No migration, historical backfill or deployed-tenant verification is
claimed. The audit still begins when its underlying events were introduced.

DPO-05 deletion-job history, 2026-09-29: the Admin document storage-deletion
history API now pages retained jobs 50 at a time with a tenant-bound cursor
instead of silently stopping at 100. Its existing metadata projection excludes
storage paths and provider errors; invalid and foreign cursors fail. API build
and all 57 document-route tests pass locally, including a 202-job fixture and
Member denial. The Governance Audit screen has a separate paged summary. This
does not restore deleted documents, establish an approved retention period or
prove provider-version, replica or backup purge. Nikita's tenant is unverified.

DPO-03 citation inventory, 2026-09-29: Admin Integrations now pages current
charity-managed Confluence page citations separately from CharityPilot's own
published copies. It shows recorded site/page, cited version/time and linked
Vault lifecycle/visibility, with no erasure action. The route excludes actor
and URL, scopes rows and cursors to the charity and denies Members. API/web/
MCP builds, 103 focused API tests, E2E TypeScript, edited web lint and three
disposable Chromium/PostgreSQL Integrations journeys pass. The later linked-
evidence guard requires unciting before document deletion; unciting removes
the current citation row, so this is not a historical inventory;
the retained control audit has only the citation ID, not a full target
snapshot. A historical-retention rule needs controller review. No actual
Confluence page, audience or Nikita tenant was checked.

DPO-03 recorded-target review, 2026-09-29: both Admin Integrations copy
lists now show the saved Confluence site, space and page IDs. The non-retired
inventory compares document approval's saved destination with that page and
shows match, mismatch or unknown. A retired row without a site/page ID has
no UI erasure action; server validation still decides eligibility. The
connector's closed personal-data projection withholds these new identifiers.
API/web/MCP builds, 102 focused API tests, connector tests (397 passed, four
skipped), edited web lint, E2E TypeScript and both disposable browser
journeys pass. These recorded IDs do not verify live provider audience or
page existence, and no reviewed tenant was inspected. A later disposable
PostgreSQL/Chromium journey also confirmed that a CURRENT document approved
for a new space displays a mismatch against its recorded old-space page.

DPO-03 recorded-copy inventory, 2026-09-29: Admin Integrations now lists
non-retired publication rows with a recorded Confluence page, in 50-row
tenant-bound pages, beside the separate retired-copy erasure queue. It joins
the current same-charity Vault lifecycle/approval and flags missing,
non-CURRENT or unapproved documents for audience/disposition review. No
erasure action is offered for these rows. API/web builds, 93 focused API
tests, edited web lint, E2E TypeScript, the MCP coverage suite and a
disposable PostgreSQL/Chromium journey pass. The first browser fixture was
rejected by a processing-timestamp CHECK; the corrected run passed with
clean teardown. Unrecorded pages, actual provider permissions and Nikita's
tenant remain unverified; no migration was added.

DPO-03/05 MCP follow-up, 2026-09-29: the retired Confluence reference tool now
passes the API's 50-row cursor and filters the actual `{ data }` wrapper under
its closed personal-data gate. Its wording no longer implies that a retained
reference proves a live provider page or purge. New response-target routes
are explicitly excluded from connector tools for human case review; document
publication site/space IDs are withheld. MCP build and tests pass (397 passed,
4 skipped).
No reviewed tenant or Atlassian provider state was checked.

DPO-03/05 retired-copy administration, 2026-09-29: the Owner/Admin
Integrations page now lists this charity's retained `RETIRED` Confluence
publication references in 50-row pages and offers the existing separately
confirmed erasure request for an eligible copy. The API cursor is tenant
bound and removes its previous silent 200-row limit. A successful request
shows its technical deletion job ID; it is not a purge receipt. API/web
builds, 91 focused integration tests, edited web lint, E2E TypeScript and a
disposable PostgreSQL/Chromium request journey pass with gated teardown.
The test used a synthetic connection/page and did not contact Atlassian.
Non-retired copies, real site permissions, provider outcomes, the reviewed
tenant and retention policy still need review. No migration was added.

DPO-05 response-target continuation, 2026-09-29: Owner/Admin can set or
withdraw a reasoned case-specific response target, see past entered targets
outside the received-date queue, and inspect append-only target history. The
cross-domain Governance Audit exposes target-change metadata only. Migration
40 leaves old cases without an inferred target. API/web builds, Prisma
validation, 30 focused API tests, the schema map, E2E TypeScript and a
disposable PostgreSQL/Chromium set-withdraw-audit journey pass with gated
teardown. A separate populated 64-baseline/40-DPO upgrade retained a null
legacy target and rejected a date before receipt. This is local tracking,
not a statutory deadline, erasure approval, deleted-item recovery, purge,
live-tenant verification or DPO sign-off.

DPO-03 concurrent approval check, 2026-09-29: document approval now locks
the tenant's selected Confluence integration row through its database
transaction. A disposable Chromium/PostgreSQL journey held a concurrent
space change open, observed the approval query waiting on the row lock,
committed the change, and received a 409 with no approval saved. Reopening
the review after restoring the selection succeeded with the exact target.
API build, 111 focused document/target tests, E2E TypeScript and the runner's
gated teardown pass. This covers a real local transaction interleaving;
Nikita's deployed tenant, the provider page and its audience remain unverified.


DPO-03 isolated browser verification, 2026-09-29: all three Confluence
connector Chromium journeys pass in the disposable PostgreSQL/API/web stack
with fake Atlassian. The extended journey verifies that a selected space
change after the Admin reviews a document destination returns 409 without a
stored approval, then a fresh review can approve and persist the exact
reviewed site/space. The runner now supplies a distinct generated integration
encryption key, which the connector needed; 40 runner contract tests, static
Compose validation and E2E TypeScript pass. The stack tears down through its
runner gate. This is local synthetic proof only; the actual space audience,
existing remote pages, reviewed tenant and DPO acceptance remain unverified.


DPO-03 reviewed-destination handoff, 2026-09-29: an Admin opening the Vault
publication control now receives a fresh selected Confluence site/space and
sees its site URL or ID and space name/key. Granting or renewing approval sends
the exact reviewed IDs; validation requires them and the document service
compares them with the connected selection inside the decision transaction.
An absent or changed target refuses approval without changing the document.
The mirror also compares a recorded page's stored site and space with the
selected target, so the dialog blocks an approval it knows the API must reject
while that older copy awaits review.
The later worker gate still refuses a target that changes after approval.
There is no new migration beyond 39. Shared 57, focused API 106, broad API
2,321 (two host-dependent checks excluded), and focused web 50 tests pass;
API/web builds, web test TypeScript and edited web lint pass. No actual tenant,
Confluence audience or provider page was reviewed.


DPO-wide local verification follow-up, 2026-09-29: the Confluence erasure
forwarding test fixture was updated from an obsolete target-reference shape
to the already-enforced canonical one. The broader API run then passed 2,320
tests while excluding the real-PostgreSQL publication-table check and a
Windows child-process CLI check by name; the new migration has separate
disposable PostgreSQL upgrade evidence. This is not a clean unrestricted
full API gate or deployed tenant proof.


DPO-03 destination-bound publication approval, 2026-09-29: migration
`20260929370000_document_publication_approval_destination` records the
approved Confluence site/space on each document and withdraws all legacy true
booleans with a system-attributed audit event because their destinations are
unknown. New approvals and destination changes require an actor, reason and
selected destination. An existing recorded page on another site or space
blocks reapproval and publication pending separate copy review. The enqueue,
retry and worker paths check the binding; the Vault warns on a stale approval
and only offers direct reapproval where no page is recorded. It also warns
when approval is withdrawn but a recorded external page remains. The disposable
PostgreSQL upgrade (64 baseline + 39 DPO migrations), 192 focused API tests,
50 focused web tests, API/web builds, web test TypeScript and edited-file lint
pass. The static migration gate reports no block and a validating-CHECK lock
warning. Coordinate deployment because the reset/CHECK can reject a legacy
old-colour approval write during blue/green overlap. Existing provider pages
are not removed; neither the reviewed tenant nor Confluence audience was
verified. The preceding DPO-03 note records the state before this change.


DPO-03 previous-site and disconnected-copy display, 2026-09-29: the mirror
API now returns nullable site-match and connection-available flags for a
recorded Confluence page. Disconnect retains non-secret site facts, but those
facts no longer yield an active page link. The Vault warns if the current
connection points to another site, is inactive, or lacks a comparable page
site ID; it does not present a cached
visible result as a current healthy copy, and suppresses the failed-job retry
button pending review. The Admin retry route also refuses an inactive publish
destination or a recorded page on another site before queueing. Older API
responses remain unknown; the worker keeps its independent different-site
guard for later changes. API/web builds, 70 focused API tests, 48 focused web tests, web test
TypeScript and edited web-file lint pass; the web tests used the existing
gitignored Windows `tsx` fallback. No provider or live tenant was inspected.
At that checkpoint the publication-approval boolean was not bound to its
reviewed Confluence site/space. The destination-binding change described
above addresses that source-level gap; its migration and live review remain
separate release work.

DPO-03 recorded-page response correction, 2026-09-29: a missing Confluence
site address can suppress `pageUrl` even when the publication row has a page
ID. The Admin mirror response now sends a page-recorded boolean without a
separate raw page-ID field (a valid page URL includes the ID). The browser treats an older response with neither flag nor URL as unknown
and uses that distinction in pending/failed/historical copy wording. A link
is built only if the recorded publication site ID matches the current
connection's site ID, avoiding an old page ID on a newly connected site's
address. The route test covers matching/reconnected sites and Member denial.
API and production web builds, 68 focused API mirror/route tests (14 service
tests), 47 focused web tests, web test TypeScript and edited web-file lint pass.
The API workspace has no ESLint config; its build and focused tests pass.
The ordinary web test runner hit this
Windows host's pre-assertion `tsx`/`uv_os_get_passwd` ENOMEM; the focused web
tests pass using the existing gitignored test-only fallback. This supersedes
the prior URL-based copy claim below. It does not verify remote existence,
Nikita's tenant or deployment.

DPO-03 partial Confluence copy display, 2026-09-29: a failed publish can have
already recorded a page reference. The mirror display now says so instead of
"Not published", distinguishes pending work with a recorded page, and keeps
the separate-review/no-retry wording when the source is no longer CURRENT.
This reflects local recorded state, not remote existence or purge. The 32
focused mirror-copy tests, test TypeScript and edited-file lint pass. Existing
worker mapping already dead-letters withdrawn approval permanently, so no
queue or provider behavior changed. Nikita's page/tenant remains unverified.

DPO-01 Vault download source recheck, 2026-09-29: after storage I/O, the
authenticated route now compares the current tenant document's path and
written provider with those used for the read. A change returns 409 without
bytes or a download-preparation audit event. This complements the existing
visibility, lifecycle and live-session rechecks. The API builds and 34 focused
document-reliability tests pass, including path/provider changes. No live
provider or reviewed tenant was tested; a post-check change remains a bounded
race, and null-provider legacy custody still needs review.

The source-based answer to Nikita's four interface-location questions is
`docs/dpo-reviewer-navigation.md`. It distinguishes Minute Book from AI action
approvals, Governance Audit from Security & Ownership Audit, document
visibility from content classification, and the present authentication/data
controls from retention, recovery and purge gaps. Confirm its routes and role
on Nikita's exact deployed tenant before using it as a live reviewer reply.
No external message has been sent.

DPO reviewed-host follow-up, 2026-09-29: Nikita's 19 September access email
says she signed in to the private Tailscale CharityPilot host to review the
then-deployed demo. A fresh Chrome visit reached its public landing page, but
there was no authenticated CharityPilot browser session. An earlier unsigned
health response also exposed no tenant or build identity. The historical 2
September VM report's single-organisation count cannot identify her 28
September tenant. Jasper does not know the reviewed tenant/environment or
where the separate C1 closure evidence is kept. Do not infer live C1 status,
replay cause, account role or deployment target from this host lead; preserve
the existing source controls and await an authenticated approved evidence path
or the original control record. No live tenant record was accessed.

DPO-04/06 evidence follow-up, 2026-09-29: the minimised approved-snapshot
renderer still outputs only the fields in the private disclosure matrix; its
existing regression test omits internal narratives and approver particulars.
No audience decision or export change was made. A read-only connected work
mailbox search for CharityPilot/C1/admin-email terms found the 28 September
DPO thread and unrelated messages, but no dated C1 closure. Atlassian Rovo
and Linear searches returned policy/general or onboarding results, not the
closure artifact. These bounded searches do not prove absence. The current
tenant, C1 revision and original verification evidence are still needed
before changing the risk or claiming a reviewed external report.

DPO-02 proxy/browser refresh handoff, 2026-09-29: a protected Next.js proxy
request can rotate the shared cookies without changing the browser's local
refresh stamp. If a reactive retry sees no newer stamp, the browser now
probes `/auth/me` while holding its Web Lock, including when the unchanged
stamp is non-null. If the
cookies are current, it does not present the spent refresh token. This also
covers a failed stamp write after a successful browser refresh. The 23
focused coordinator/API tests, test TypeScript, edited-file lint and
production web build pass locally. Simultaneous proxy/browser refreshes,
proactive renewals without shared storage, multi-process proxy races and
Nikita's historical event cause remain open; server replay quarantine was
not weakened and no reviewed-tenant check was made.

DPO-05 queued deletion identity, 2026-09-29: migration 38 makes a storage
deletion job's ID, provider, JSON target, reason and requesting actor
immutable on update. A disposable populated PostgreSQL 16 upgrade through
all 38 DPO migrations rejected direct edits of each protected field,
exercised audited corrected-path dead-letter recovery, then
confirmed that changing the linked retired publication's page ID makes the
worker retry without fake-provider I/O; restoring it permitted processing.
The runner removed its loopback-only container, and the 71 migration-gate
tests pass. This supersedes the 37-migration maximum below. Atlassian
deletion, versions/backups, policy-approved withdrawal, deployment and the
reviewed tenant remain unverified.

DPO-05 queued-target integrity, 2026-09-29: before Confluence provider I/O,
the cleanup worker now compares the queued cloud, page and attachment IDs
with its uniquely linked, same-charity `RETIRED` publication. A changed target
records a retry without a provider call. API build and 246 related tests pass
with the one Windows `uv_os_get_passwd` ENOMEM subprocess test excluded. A
disposable PostgreSQL 16 populated upgrade through all 37 DPO migrations
confirmed a changed queued page ID yielded a retry and zero fake-provider
calls; restoring it yielded a processed job and one fake-provider call. The
Admin audit reflected the attempts; the loopback-only container was removed
and an independent engine listing found none left. This supersedes older
no-PostgreSQL-worker notes. Atlassian deletion, provider versions/backups,
controller-approved withdrawal, deployment and Nikita's tenant remain open.

DPO-05 Confluence source-ID correction, 2026-09-29: migration 26's original
source-document trigger rejected a Confluence erasure job after its Vault
document had been deleted. Migration 37 keeps the live-document/path rule for
ordinary storage jobs and permits a Confluence source ID only when a
same-charity retired publication already carries the exact queued job ID and
retired path. The request reserves a UUID, stamps the publication, inserts
the job and writes the actor audit in one transaction. API build, 185 focused
tests and migration lint pass. A disposable PostgreSQL 16 populated upgrade
through all 37 DPO migrations passed live-document request refusal, linked
job insertion, forged-job refusal, worker refusal when the local document
reappeared, and provider-call eligibility after its removal. Both worker
outcomes appeared in the Admin audit; the container was removed. This
supersedes the prior fake-datastore-only source-ID claim. Atlassian,
backup/version purge, policy-approved withdrawal and Nikita's tenant remain
unverified.

DPO-01/03 migration-36 rehearsal, 2026-09-29: a loopback-only disposable
PostgreSQL 16 upgrade applied 64 baseline and all 36 DPO migrations over two
legacy documents and a deliberately visible working draft. The `NOT VALID`
constraint preserved that existing violation for review, then refused a new
violation and an update of the existing row. The rest of the populated
two-charity source/route rehearsal passed, Prisma reported up to date, and
an independent local-engine check found zero remaining rehearsal containers.
This supersedes the older migration-36-unrun statement below. It does not
classify real files, validate the constraint over Nikita's data, or prove a
production-scale upgrade or deployment.

DPO-05 queued Confluence erasure, 2026-09-29: new explicit deletion jobs carry
the original document ID. The cleanup worker verifies that each job still
links to exactly one of its charity's `RETIRED` publications, checks a populated source ID for
agreement, and refuses provider I/O if the local document exists. Legacy jobs
without a source ID need the same unique publication link. The API builds and 245
related tests pass with one unrelated Windows `tsx` subprocess test excluded;
the unexcluded run fails before that test body on `uv_os_get_passwd` ENOMEM.
The source-ID path has since passed disposable PostgreSQL; Atlassian and Nikita's tenant remain unverified. This guard does
not supply a controller-approved withdrawal path or prove remote/backup purge.

DPO-05 Confluence erasure fence, 2026-09-29: the explicit request now checks
that its charity's document is actually absent even when the publication row
says `RETIRED`. A live document returns 409 without a queued provider deletion,
publication stamp or request audit. API build and 99 focused service/route tests
pass with fake datastores; the request path has since passed disposable PostgreSQL, while Atlassian and the reviewed tenant remain
unverified. This does not create a withdrawal path for formerly published live
files: one publication row per document/provider becomes terminal at `RETIRED`.
The controller-approved removal, hold and retention decision remains open.

C1 closure evidence remains unresolved after a 2026-09-29 read-only search of
local all-ref commit messages and the canonical GitHub repository's issue/PR
titles. The two email-related PR titles found did not identify C1; the merged
general hardening PR body also gave no dated C1 verification. This is a
bounded search, not proof the original fix or separate closure record does
not exist. Do not change the live claim without its evidence and tenant/risk
revision; the private roadmap records the exact search boundary.

DPO-01/03 draft visibility, 2026-09-29: the API, Member list/detail/download,
search, dashboard activity and post-storage download check now exclude working
`DRAFT` files from Member access, including legacy rows incorrectly marked
`MEMBER_VISIBLE`. The Admin Vault disables release of a draft; migration 36
adds a `NOT VALID` database CHECK for new and updated rows. The API and
production web builds, 112 focused API tests, edited UI lint and migration
gate pass. Migration 36 has since passed a disposable PostgreSQL 16 rehearsal, but its application to Nikita's tenant is unverified;
existing violations and file contents still need controller review. Explicit
visibility decisions for other classified lifecycle states remain available.

DPO-05/06 Confluence erasure request, 2026-09-29: the deletion job,
publication stamp and actor-bound request audit event now share one database
transaction. An audit-write failure rolls back the queued job rather than
returning 500 after a destructive request has already committed. The API build
and 97 focused service/route tests pass with rollback-aware fakes. This has not
been exercised against PostgreSQL, Atlassian or Nikita's tenant. The request
still requires a `RETIRED` publication following CharityPilot document
deletion, whereas ordinary Vault DELETE is DRAFT-only. A controller-approved
removal/withdrawal route for formerly published live documents, including
holds and provider-copy disposition, remains open in the private roadmap.

DPO web-suite verification, 2026-09-29: the normal Windows test runner still
stops before assertions on this sandbox's `uv_os_get_passwd` ENOMEM in `tsx`.
A gitignored test-only preload in the private roadmap folder substitutes a
synthetic cache username solely for that exact failure. Five old wiring
assertions were updated to reflect the current Member-only organisation view,
restricted register summaries, minimised compliance wording and accurate
Vault deletion warning. Test TypeScript compiles and all 539 compiled web
tests pass with the preload. This does not certify the normal runner, a hosted
browser journey, or Nikita's reviewed tenant.

DPO-01/05 connector field check, 2026-09-29: the full connector suite found
`Document.storageProvider` unclassified in its closed-personal-data policy.
The generic projection now withholds this internal custody field, and a
regression assertion covers it. The full connector suite passes 395 tests
with four platform skips. This is local filtering evidence, not reviewed
tenant content classification or deployed proof.

DPO accumulated-work verification, 2026-09-29: the root shared/API/web
production build passes. The broad API run exposed a missing shared type for
the new `INTEGRATION_ENVIRONMENT_DECLARED` audit event and two stale report
test fixtures lacking the required preparation-audit writer; these were fixed
without changing the fail-closed route. Focused tests pass 9/9, and the
second API run passes 2,300 of 2,302 tests. Its remaining failures are a
Docker fixture denied by this sandbox and a `tsx` child-process startup that
hit host `uv_os_get_passwd` ENOMEM; excluding those two named cases yields
2,300/2,300. The root production-check run also has two host-dependent
failures (Windows ACL enforcement and Docker on PATH), with 1,090 passes and
two skips. No hosted control is certified by these local checks.

DPO-05 approval-evidence correction, 2026-09-29: the complete 21 March
governance-suite email thread includes Sridevi's express approval of all 31
documents. Jasper's earlier 30 August statement that her assent was missing
was superseded later that day by his version 3 verification, which explains
the five-of-eight-message preview error. The original March Document Retention
Schedule attachment has now been read. See the evidence IDs and category
crosswalk in `.charitypilot-private/ROADMAP.md` and
`.charitypilot-private/data-lifecycle-inventory.md`. This corrects the
historical approval record; CharityPilot still needs current-policy class
mapping and disposal controls before automatic retention or purge.

DPO-02/06 bounded follow-up, 2026-09-29: the no-Web-Locks refresh fallback
still permits a simultaneous two-tab race after both tabs observe an expired
session; no weak browser lease or server replay exception was introduced.
A targeted connected-mailbox C1/admin-email search found only the quoted DPO
feedback and unrelated results, not the dated closure evidence or affected C1
revision. The known 19 September private-host access correspondence does not
identify Nikita's 28 September tenant/revision. The C1 claim was not changed.
The ordinary Vault draft-delete confirmation now states that there is no
deleted-item restore, matching current behavior pending an approved recovery
and retention design.

DPO-05 legacy Vault custody review, 2026-09-29: Owner/Admin can verify an
unproven document's provider from the exact tenant key in both supported active
stores, provided both are available, exactly one contains the key and its byte
size matches the Vault row. A revision-checked provider update and actor-bound
document-control event commit together. A failed or ambiguous check leaves
ordinary deletion blocked. Migration 35 extends the audit kind; API/web builds,
167 focused API tests, 11 connector route-coverage tests and a disposable
PostgreSQL 16 upgrade through 64 baseline plus 35 DPO migrations pass locally.
An isolated Chromium journey also confirms that an unverified legacy file
shows a disabled Delete control and a failed provider check leaves its field
null; the disposable stack tore down cleanly.
The review proves a matching active object at one time, not historical origin,
byte identity, versions/backups, restoration, final purge or a real tenant.
Without access to both providers, including Supabase on local-only hosts, this
automated review cannot establish custody. The operator must not infer the
missing provider from current preference.

DPO-05 Vault provider custody, 2026-09-29: new uploads persist the storage
provider that received their bytes, with an exact match to the attached upload
reservation. Migration 34 backfills only exact attached intent matches and
leaves unknown legacy custody null. Database triggers make a known document
provider immutable and reject a conflicting intent. Download and ordinary
draft deletion use the pinned provider; deletion of an unverified legacy file
returns 409 before queuing or touching storage. The API build, Prisma
validation, 163 focused route/storage/cleanup tests and 71 migration-gate
tests pass. The first sandboxed rehearsal stopped at the Docker pipe with
`EPERM`; an authorised local-pipe retry passed all 34 DPO migrations against
disposable PostgreSQL 16 and proved exact backfill, unmatched-null preservation,
immutable-provider and mismatched-intent refusal. Provider review for null legacy files,
deleted-item restoration, policy-approved purge and deployed-tenant proof
remain open; no production host was changed.

DPO-02 no-Web-Locks reactive fallback, 2026-09-29: a 401-triggered browser
refresh now checks `/auth/me` before using the refresh token when Web Locks are
unavailable. It skips a sequential duplicate after another tab rotates the
cookies and refuses to refresh when the check fails. Proactive renewal still
refreshes. Eight focused tests, test TypeScript, edited-file lint and the
production web build pass locally. Simultaneous tabs without Web Locks can
still race, and this does not explain Nikita's historical events or prove her
deployed tenant. A source/commit search found no C1 closure evidence in this
turn, so do not mark the live control verified.

DPO-06 Confluence publish-target integrity, 2026-09-29: the charity's choice
of a Confluence publish space is now validated against the provider before a
database transaction saves it alongside its actor-bound security event. The
write requires the integration to remain connected to the same site during
the validation interval; a site switch or failed audit refuses/rolls back the
choice. The API build and 109 focused publish-target/integration tests pass,
including stale-site and synthetic audit-failure cases. This has no new
migration, does not reconstruct older choices and has not been exercised
against Nikita's tenant or a real PostgreSQL transaction in this turn.

DPO-06 Confluence citation history, 2026-09-29: adding or removing a cited
Confluence page now writes an actor-bound `CONFLUENCE_REFERENCE` event in the
same database transaction as the reference change. It records the document
and opaque reference IDs but no page title, URL or content. The existing
Owner/Admin document-control history and Governance Audit feed can show it.
Migration 33 extends the constrained event-kind set (33 DPO migrations in this
checkout). API/web builds and 23 focused reference/archive tests pass. The
blue-green migration lint has no block and flags the validating CHECK window. The local
Docker pipe still blocks PostgreSQL rehearsal, so transactional behavior and
the constraint must be proved on a database before release; old changes are
not backfilled. This does not change any Confluence page.

DPO-02 browser fallback, 2026-09-29: a reactive 401 refresh now checks
`/auth/me` under the shared Web Lock when the nonsecret cross-tab rotation
stamp is unavailable. It skips a duplicate refresh after another tab has
rotated cookies and fails closed if the check itself fails. Proactive renewal
still rotates. Six focused tests, test TypeScript, production web build and
edited-file lint pass. Browser paths without Web Locks, Nikita's historical
replay cause and her deployed tenant remain unverified. The optional `tsx`
test preload failed with this host's ENOMEM; direct Node execution of the
compiled tests passed.

DPO-06 Confluence declaration audit, 2026-09-29: changing or clearing the
charity's declared Confluence plan/residency now writes an actor-bound
`INTEGRATION_ENVIRONMENT_DECLARED` security event in the same database
transaction as the setting. Its action is `RECORDED` or `CLEARED`; it also
records the actor, time, request ID and fixed labels, but no declared values. Owner/Admin
Governance Audit includes the metadata event, and the page points to it.
This added migrations 31-32 (32 DPO migrations at that checkpoint). API and production web
builds plus 101 focused integration, audit-feed and subject-constraint tests
pass. The migration lint reports one expected validating-check window warning;
The disposable PostgreSQL rehearsal could not start because access to the
local Docker Desktop Linux named pipe returned `EPERM`; actual PostgreSQL
application and Nikita's deployed tenant remain unverified.
Earlier declaration changes are not reconstructed. This is not C1 closure or
a formal DPO review.

DPO-05/06 Data Requests overview, 2026-09-29: the recent global
`/data-lifecycle/audit` feed no longer selects case evidence references. Its
response now carries event/case IDs, actor, state change and time; the
Owner/Admin individual case history retains the reason and evidence reference.
API build and 14 focused intake tests pass. No stored case evidence or live
tenant was changed. A source recheck found no extra dynamic field in the
minimised approved Compliance Record beyond the private disclosure matrix;
recipient-specific field approval remains open.

DPO-01/06 overview projection, 2026-09-29: every direct Governance Audit
feed now requires an explicit database field selection. Organisation, deadline,
register and report preparation feeds no longer fetch whole rows for the
expandable JSON overview; the merged case-link feed already selects and maps
named fields. The route test checks all 17 direct feeds use a projection, and
the API build plus 12 focused archive tests pass. This prevents future schema
columns appearing by default; detailed histories remain restricted and live
tenant behaviour is unverified.

DPO-01/06 overview minimisation, 2026-09-29: Governance Audit now omits
free-text compliance reasons and data-request evidence references from its
cross-domain event JSON. The controlled compliance audit and individual case
histories retain those fields. API build and 12 focused archive tests pass.
This is source-level minimisation, not a live DPO review. A read-only browser
attempt to open the historically mentioned private Tailscale host was rejected
by automatic approval review because Nikita's actual reviewed environment and
tenant remain unconfirmed; the local Tailscale status pipe also denied access.
Do not bypass that rejection or infer a live target from older correspondence.

DPO-05 schema coverage, 2026-09-29: `docs/architecture/data-lifecycle-model-map.md`
enumerates all 70 current Prisma models in eight groups. Its exact-set test is
part of `test:production-check`, so new schema models require an inventory
update. This is source coverage only. The private
`.charitypilot-private/data-lifecycle-inventory.md` records the off-schema
stores and policy gaps. Ordinary Vault draft deletion still hard-removes the
row and cannot restore it; cleanup-job recovery only retries or acknowledges
byte cleanup. Do not claim approved retention, recoverable deleted items,
provider/backup purge or live DPO proof from this inventory.
The map test and 15 launch-status tests pass. A full production-check run on
this shell has 1,090 passes, two skips and two host-dependent failures: Windows
owner-only ACL publication and a live PATH test with Docker unavailable.
Re-run that full gate on a capable host before treating it as green.

DPO public-production evidence gate, 2026-09-29: machine-readable launch
evidence now requires a separate disposition of Nikita's 2026-09-28 feedback
for the reviewed tenant and exact promoted release SHA. It names all six review
areas, four requested interface locations, first-pass DPO review and remaining
actions. The launch ledger now has 90 checks; older 89-check progress figures
below are dated historical checkpoints. The validator rejects a missing check
or wrong release SHA, while cited live evidence and human judgement remain
necessary. The public checklist now requires every DPO migration in the
promoted release (33 in this checkout), not its obsolete first seven. The
80-test launch-evidence suite, 21 launch-status tests and 180 production
preflight tests pass locally. This gate does not apply to personal-server mode,
record a DPO sign-off, deploy migrations or establish Nikita's tenant.

DPO-05/06 storage-audit minimisation, 2026-09-29: the cross-domain Governance
Audit deletion feed no longer retrieves free-text Confluence erasure reasons;
it retains technical status, actor ID and dates. API build and 12 archive tests
pass. The private lifecycle inventory also identifies the existing seven-day
cleanup for eligible authentication-email delivery-evidence rows. That narrow
operational cutoff does not establish an approved application-wide schedule or
purge related audit, mail-provider, log or backup copies. No live tenant was
changed.

DPO-06 Confluence audit navigation, 2026-09-29: the Owner/Admin Governance Audit
now pages metadata from eight named integration events retained in the Team
security audit. Its charity-bound feed and cursor exclude labels, reasons,
site URLs, document names and arbitrary context; use the restricted Team log
for detail. API and production web builds, 12 archive tests, edited-page lint,
E2E TypeScript and a synthetic PostgreSQL/Chromium Owner journey pass with
gated teardown. Some original writes are best effort after an action, older
events are not backfilled, and an erasure request is not purge proof. The live
tenant remains unknown. See the private roadmap for the exact event scope.

DPO-05/06 case-evidence audit feed, 2026-09-29: Governance Audit now pages
metadata for data-request links to live Vault documents and storage-deletion
jobs, including separate withdrawals. It is Owner/Admin-only, tenant-bound and
omits case reasons, storage paths and provider errors; open the individual
request for controlled reasoned history. API build, 11 archive tests, E2E
TypeScript, edited-page lint and an isolated PostgreSQL/Chromium Owner journey
pass with gated teardown. This uses existing migrations 25/30. It does not
prove case identity, erasure, recovery, backup expiry or Nikita's live tenant.
See the gitignored roadmap for the exact DPO limits.

DPO-05 case-to-live-Vault lineage, 2026-09-29: Owner/Admin Data Requests can
now record an exact live Vault document ID with an actor and reason, then retain
that opaque ID after eligible draft removal. Migration 30 verifies the live
same-charity row at insertion, makes links append-only and permits a separate
append-only withdrawal. The case UI pages these links; MCP excludes the routes.
API/web/MCP builds, 14 focused intake tests, 11 connector coverage tests,
115 isolated-runner safety checks, a two-charity populated 30-migration
PostgreSQL rehearsal and two disposable Chromium Owner journeys pass. The
blue-green gate warns about an index on the newly created empty table. A link
does not establish the requester, authorise erasure, restore the document or
prove external and backup copies are gone. No live tenant was changed.

DPO-04 disclosure review, 2026-09-29: the gitignored
`.charitypilot-private/report-disclosure-matrix.md` records the exact dynamic
field allowlist in the minimised approved-snapshot review draft, the excluded
snapshot/internal-report details, current access and preparation-audit guards,
and decisions required for a recipient-specific release. A fresh API build
and 26 focused export tests pass; no additional renderer field leak was found
in this source review. Aggregate inference, field and recipient approval,
downloaded-copy handling and Nikita's deployed tenant remain unresolved.

DPO-05 source-job discovery, 2026-09-29: Owner/Admin Data Requests now has a
tenant-bound, cursor-paged lookup by exact source Vault document ID. It returns
job status metadata without storage paths or provider errors; selecting a job
only fills the existing reasoned case-link form. Migration 29 adds a concurrent
partial index for non-null source IDs. API/MCP builds, 12 focused case tests,
five connector route-coverage tests, edited web lint, E2E TypeScript and the
blue-green gate pass. An isolated PostgreSQL/Chromium Owner journey found and
linked a synthetic job and checked the browser response excludes storage path
and provider error fields; gated teardown passed. The populated two-document
rehearsal passed 64 baseline and all 29 DPO migrations. Legacy null-source jobs,
subject matching, full erasure and Nikita's live tenant remain open.

DPO-02 replay-timing evidence, 2026-09-29: future replay audit events record
when the presented session was previously revoked. The restricted Owner/Admin
diagnostics validates and displays that time beside the existing request ID,
fingerprint, previous reason and quarantine count. Older events show no value;
no token or new person identifier is stored. Shared/API builds, 50 focused
auth/team tests, edited web lint and E2E TypeScript pass. An isolated
PostgreSQL/Chromium journey compared a synthetic replay event with its source
session row and displayed the timestamp in a separate Owner session; gated
teardown exited 0. The field supports a timing
comparison with restricted logs but does not explain Nikita's historical
events, distinguish a racing client from theft, or prove deployed behavior.

DPO-05 source-document lineage, 2026-09-29: migration 28 adds nullable
`DocumentStorageDeletion.sourceDocumentId`. New ordinary Vault draft removals
write the source document ID into the deletion job in the same transaction as
record removal. A database trigger checks that a non-null source matches a
live document in the same charity at the same storage path when inserted and
prevents later changes. Existing, orphan-cleanup and Confluence jobs remain
unlabelled; no guessed backfill is made. The Owner/Admin Data Request case view
shows the ID for linked jobs without exposing a storage path. This identifies
source lineage, not the data subject, recipient copies, provider versions or
completed erasure. API build, 59 focused API tests, edited web lint, E2E
TypeScript and the static blue-green migration gate pass. One isolated
PostgreSQL/Chromium deletion-and-case journey passed with gated teardown,
including database rejection of a forged source and later ID edit. A separate
representative populated-data upgrade passed 64 baseline and all 28 DPO
migrations with two legacy documents; it is not a full production-data
rehearsal. No live tenant, approved retention period or deleted-item recovery
was verified.

The final disposable recovery-code browser rerun also verified 401 and an intact factor when a different session family tried blank-code removal, followed by successful removal in the recovery-authenticated family. The gated runner exited 0.

DPO-02 proxy validation follow-on, 2026-09-29: concurrent protected-page requests now share only an in-flight `/auth/me` validation for the same hashed API URL, request origin and cookie header in one Next.js process. A completed success is removed so later requests still check revocation; the refresh single-flight and API replay quarantine remain authoritative. The 24-test proxy suite, edited lint and production web build pass. All five isolated PostgreSQL/Chromium DPO review journeys pass together with gated teardown. Two earlier combined browser runs hit a 503 in a longer navigation test before it was split; this passing suite is not evidence of that 503's cause or Nikita's replay cause. Separate processes and the live reviewed tenant remain unverified.

DPO authentication recovery, 2026-09-29: a disposable PostgreSQL/Chromium Owner journey now proves authenticator enrolment, final recovery-code browser sign-in, a recovery-use audit event bound to that active session family, and password-proved MFA removal with the code left blank. The journey exposed a UI request that sent an invalid empty recovery-code string and a database CHECK that rejected the family-bearing audit event. The UI omits an empty code; DPO migration 26 widens only `SECOND_FACTOR_RECOVERY_USED` to permit an optional family ID. The corrected journey and all migrations pass with gated teardown; local E2E TypeScript and edited-page lint pass. The blue-green gate warns that the replacement CHECK validates existing audit rows. This does not prove the reviewed live tenant, role-wide MFA enforcement or recovery after both authenticator and codes are lost.

DPO-05 case linkage, 2026-09-29: Owner/Admin reviewers can associate an unresolved Data Request with an existing same-charity storage-deletion job and record an auditable reason. A wrong association can be withdrawn with a separate immutable reason while the original remains visible. The case view shows current technical job status and primary-object absence evidence without storage paths or provider errors. Migration 25 uses composite tenant foreign keys and append-only triggers. Local API/web/MCP builds, Prisma validation, focused API/connector/reset-safety tests and all four DPO review journeys pass together against disposable PostgreSQL 16/Chromium; the gated runner exited 0. The blue-green gate has no block but warns of a non-concurrent index on existing `DocumentStorageDeletion`; review the deployment lock window. No case disposition, full erasure, policy period, live tenant check or DPO sign-off follows from this link.

Last updated: 2026-09-29 (DPO follow-up; older checkpoints retain their stated dates)

This document exists so a new Codex, Claude, or other coding agent can continue the same CharityPilot production-completion goal without relying on chat memory or a pasted prompt.

## 2026-09-28 DPO demo feedback intake

Data Requests now lets an Owner/Admin find a case by its exact opaque archive reference. The API validates the reference and restricts the query to the current charity; Member access remains denied. Eight focused intake tests, API/production web builds, E2E TypeScript, edited-page lint and a disposable PostgreSQL/Chromium Owner journey pass locally. The browser opened a case outside page one by reference, then paged older cases after a new intake. Lookup does not change review status or prove erasure; see the private lifecycle inventory.

The Admin Data Requests queue now uses tenant-bound cursor paging rather than offsets, so a newly recorded case cannot shift an older case out of the next page. The web deduplicates appended rows and ignores a stale page after refresh. API and production web builds, seven focused intake tests, edited-page lint and E2E TypeScript pass locally. An isolated Chromium Owner journey with 52 seeded cases and a newly inserted 53rd reached the two oldest cases through the real API/UI; its runner exited successfully. A backdated new case still needs a fresh reload; no erasure or retention outcome is implied. The private lifecycle inventory records the boundary.

The Admin Governance Audit overview now selects event metadata instead of full before/after snapshots and narrative reasons for its Minute Book, document, risk, control and compliance feeds. Detailed histories remain on the corresponding controlled record pages. API build and 10 archive tests pass locally. This is response minimisation, not historical erasure, C1 verification or proof on Nikita's dashboard; the private roadmap has the exact field boundaries.

A bounded connected-Drive metadata search on 2026-09-29 found the March retention schedule and pre-3-September board drafts, but no later minutes/resolution filename. That search did not cover the complete 21 March email thread. The thread and later version 3 verification establish approval evidence for the March governance suite, as documented below. Its category periods still need a current-policy reconciliation and CharityPilot-specific controller mapping before app deadlines or disposal.

After an Admin records or withdraws risk-control evidence, or the parent risk register reloads after a revision change, the Registers panel now reloads its control-review attention list. Older in-flight responses cannot replace that newer result. Edited-page lint and a production web build pass. This corrects a locally stale panel, but C1 still needs its actual closure evidence and deployed-tenant reconciliation.

The connector's six governance/deadline removal tool descriptions and missing-reason error now agree with the server's corrected approval prompt: active-record removal, with audit and backup copies possibly retained. The README example is updated. MCP build and 61 focused tool/session tests pass. This is description accuracy only, not erasure or retention enforcement.

The complete isolated Chromium DPO review navigation spec now passes all three Owner/Member journeys together, including the uploaded-draft deletion outcome in Governance Audit; the runner's gated teardown exits successfully. The earlier full-run authentication-unavailable page did not recur. This is disposable local-stack evidence, not a replay-event diagnosis or proof on Nikita's reviewed host.

The connector's destructive-action prompts for six governance/deadline record types now say removal from active records and warn that audit or backup copies may remain; the generic DELETE fallback no longer claims permanent erasure. API build and 46 focused approval/connector tests pass. This is wording accuracy, not a change to record disposal or backup expiry. The blue-green engine's 14-day best-effort local backup pruning is an operational setting, not the missing controller-approved per-class retention schedule. See the private roadmap and data-lifecycle inventory for the remaining DPO-05 decisions and deployment checks.

The Minute Book UI now says a removed act's full snapshot, actor email and reason remain in restricted audit history without automatic expiry. The Confluence connection disclosure calls remote delete/purge an attempt and limits its 404 evidence to the current page endpoint; versions and backups are outside that proof. API build, 87 integration-route tests and edited Minute Book lint pass. Neither change adds erasure or an approved expiry period.

The new storage-deletion attempt feed has a rendered local Owner journey: upload a synthetic draft, remove it through the Vault, then inspect its `PROCESSED` outcome and active-primary-object absence receipt in Governance Audit. The test correlates the document ID to the separate deletion-job ID through the retained upload intent. E2E TypeScript, the focused isolated Chromium test and gated teardown pass. One earlier assertion used the wrong ID despite the captured page showing the event; a later full navigation run encountered a transient authentication-service page before reaching this step, while its Member restriction test passed. The focused journey does not establish deployed behavior, other providers, versions or backup purge.

Migration 24 adds an append-only storage-deletion attempt event captured by a PostgreSQL trigger when a pending deletion schedules a retry, dead-letters, or completes. Its Admin-only Governance Audit feed exposes tenant-scoped outcome metadata, not path or provider errors; the primary-object absence receipt is shown when present. A populated disposable PostgreSQL 16 upgrade through all 24 DPO migrations exercised the trigger, rejection of direct insert/update/delete, Admin and Member reads, and cleanup of its local fixture. API and production web builds, nine focused audit tests, Prisma validation, 50 E2E reset-safety tests and edited-page lint pass. The general PostgreSQL backup fingerprint covers every present table; the static critical-table list remains restricted to tables already present before a blue-green migration. The blue-green gate has no block and warns about index and foreign key creation on a newly created empty table. Earlier attempts are not backfilled, and provider versions, backups, deployment and Nikita's tenant remain unverified.

The existing append-only storage-deletion recovery decisions now have a separate Owner/Admin-only Governance Audit feed. It pages by tenant and decision timestamp, exposing disposition, deletion reference, actor type/user and prior attempt summary while omitting paths, free-text reasons, operator identity and recovery nonce. The deletion queue feed has been labelled as current status because its row is updated through retries; the newer attempt feed covers outcomes from migration 24 onward. This local change does not perform recovery, prove provider purge or establish an approved retention period. Verification is recorded in the private roadmap.

The stale-upload reconciliation queue now stamps each attempt and orders unattempted or less recently attempted `RESERVED` rows first. This prevents a repeatedly failing oldest batch from hiding later orphaned bytes. Migration 23 preserves the database trigger's immutable tenant/path/provider and guarded state transitions. API build, Prisma validation, 40 focused tests and a populated disposable PostgreSQL 16 upgrade through all 23 DPO migrations pass; the real service queued a stale orphan after upgrade. The blue-green gate warns about a normal index build on an existing table. Scheduler deployment, real provider deletion, object versions/backups and Nikita's tenant remain unverified.

The scheduled local Confluence orphan sweep now runs before remote tenant/page reconciliation. A remote listing failure no longer prevents retirement of a missing-document publication; a local-sweep failure raises an operator alert but still lets the remote pass proceed. API build and 120 focused tests pass. No deployed scheduler or provider outcome was checked.

The Confluence orphan-publication retirement sweep now selects missing-document publications before applying its 100-row bound and includes dead-lettered rows with a recorded page. Previously 100 older live rows could indefinitely hide a later orphan after best-effort retirement failed. API build and 118 focused tests pass; a disposable no-network PostgreSQL 16 query returned the late orphan behind 125 live rows and its container was removed. This restores discoverability for an explicit erasure request after the scheduler runs, without performing erasure or proving the deployed provider.

The local Member Vault browser journey now probes the restricted file by its real Owner-uploaded ID. Authenticated Member requests for its detail and download both return 404, while the released file remains downloadable. The targeted isolated Chromium run and gated teardown pass. This is synthetic local proof, not classification of actual files or verification of Nikita's deployed tenant.

A new local-only Chromium journey exercised ordinary two-tab browser refresh on one synthetic Owner session: after the shared access cookie was invalidated, both tabs reached the replay-diagnostics API successfully, one refresh call was made and no `SESSION_REPLAY_DETECTED` row appeared in the disposable tenant. The isolated runner's 115 safety checks and gated teardown passed. This tests one actual browser timing on the local revision; it does not determine the cause of Nikita's historical events, cover every concurrency interleaving or verify her host. The exact deployed event/log correlation remains open.

The rendered Member browser journey now includes two synthetic Vault files: one expressly released for Members and one left at the conservative `RESTRICTED` default. The signed-in Member sees and downloads only the released file; the restricted file is absent from the Vault list. The targeted isolated Chromium test and runner teardown pass. The web API interceptor now unwraps only a single-field `{ data }` wrapper, so unfamiliar paging metadata is also retained; its focused suite passes 13/13 and the production web compiled in the isolated run. This is local synthetic access evidence, not content classification or proof on Nikita's dashboard.

The isolated Chromium journeys now pass for the existing Member governance read boundary, live Admin demotion and document upload/download (three tests), plus a new Owner/Member navigation check for Minute Book, Governance Audit, Data Requests and document access/lifecycle/deletion-hold controls (two tests). The new check exposed an Owner Security & Data crash: the shared web API interceptor unwrapped paginated `{ data, nextCursor }` responses, so the replay-diagnostics panel received an array and tried to read `undefined.length`. The interceptor now preserves cursor pages and its focused regression suite passes 12/12. The five browser tests passed separately against runner-owned synthetic stacks and the runner's gated teardown returned successfully. To run locally on this Windows host, the isolated E2E port contract was moved from excluded port 55434 to free loopback port 3354, its gateway health check was corrected, and the container collector was brought into line with the existing five-service Compose/runtime contract. The 108 E2E safety/attestation tests, static validation and production web build inside the stack passed. This verifies local rendered routes and role restrictions only; Nikita's reviewed host/tenant and its deployed revision remain unknown.

Full Compliance Record exports now require `FULL` personal-data scope as well as Owner/Admin role. The connector hides and refuses its full-report file tool when that session scope is withheld; direct API calls are denied before report reads. A read-only connector is also denied by the API for both report variants, matching the file tool's write-level rule. Both full and minimised report paths now recheck the current tenant-bound, verified Owner/Admin session and connector level after assembly and before the metadata-only preparation audit or HTML delivery. Local API/connector builds and 26 export plus 31 connector file/list tests pass (one Windows symlink skip); the full connector suite passes 394 tests with four platform skips. This narrows an in-flight role/session change window, but the minimised draft's audience and fields still need controller/DPO approval and the exact deployed journey remains unverified.

The connector's `document_download` tool now also requires a `FULL` personal-data session and at least WRITE access. The API enforces both before document/storage access and rechecks them after provider I/O, alongside its existing role, visibility and session checks. API/connector builds, 31 focused document tests and five connector server-list tests pass locally. This does not classify legacy file contents or verify Nikita's deployed tenant.

The 21 March 2026 governance-suite email (`19d10accabf16738`) attached `hOUR Timebank Document Retention Schedule Mar26.docx`. The complete eight-message thread includes Sridevi's explicit approval of all 31 documents at 14:49 (`19d10df42a72ffd9`) and Jasper's confirmation that the resolutions passed at 14:52 (`19d10e1b462de915`). Jasper's 30 August 11:41 email said that assent was missing, but his later [version 3 approval verification](https://docs.google.com/document/d/1v6nyLUsa-Rf1q2HUkeJsK6KwXQD_Z2cG6ja4_0Ejnvw/edit) identifies the truncated Gmail preview and supersedes that conclusion. The attachment sets category periods, including seven years after leaving for former-member records; the subsequent Data Protection Policy V2 discussion calls for category-specific justification, and the 21 September six-policy request does not include a revised schedule. The local statutory-member service stopped deriving its conflicting one-year `retentionDeleteAt` and returns null for legacy dates; stored dates await reconciliation. API build and five focused tests passed. The controller must map current policy versions to CharityPilot data, exceptions and purge evidence before any app expiry rule is enabled.

Vault downloads now append a tenant-scoped, metadata-only preparation event
after post-storage document-existence/current-visibility and live-session/role
checks. The current visibility is used for the role test, closing an Admin
demotion plus file-restriction window during provider I/O.
The Admin Governance Audit pages the events; an audit-write failure withholds
bytes. The twenty-second DPO migration is append-only. API and production web
builds, 82 focused document/archive tests, 50 reset-safety tests, edited-page
lint and a populated disposable PostgreSQL 16 upgrade through all 22 DPO
migrations pass locally; the fixture was removed. The blue-green migration gate
has no block and one new-empty-table index warning. This records preparation,
not client receipt, and does not reconstruct older downloads or settle audit
retention, recipient copies or Nikita's live deployment.

A read-only search of Jasper's connected work correspondence found a 31 August
private-host invitation for hOUR Timebank CLG, giving a lead for the dashboard
Nikita later reviewed. Her 28 September message does not confirm the current
host, tenant or deployed revision. The private roadmap records the lead without
invitation links; no live host was accessed or C1/replay record changed.

A read-only connected Confluence search found a policy page that says hOUR
Timebank should maintain a documented retention schedule and a separate
retention-policy page with no retrievable body. It did not locate a C1
admin-email verification or approved CharityPilot schedule. This is a bounded
search, not evidence of absence across other stores or an approved period.

Security & Data now links every charity role to its own session-family inventory
and revocation control on Team & Permissions, beside personal MFA and password
change. Charity-wide security, audit and data controls remain Owner/Admin-only.
This improves the location Nikita asked for but has not been checked on her
unknown dashboard.

A populated, disposable PostgreSQL 16 upgrade through all 21 DPO migrations
now exercises signed-in Member password change through the real Fastify route.
The first run caught an invalid session-subject field on the audit insert;
removing it fixed the database constraint failure. The repeat passed cookie
clearing, old-session denial, changed password hash, outstanding recovery-link
termination, both active sessions revoked and `PASSWORD_CHANGED` projection.
The loopback-only fixture container was removed. This is local proof; a
rendered browser, deployed tenant and Nikita's environment remain unchecked.

Signed-in charity users can now change their own password on Security & Data.
The route requires their current password and an enrolled second factor,
rechecks the credential under the organisation/user locks, and atomically
invalidates outstanding recovery links and all sessions. A metadata-only
security event is projected as `PASSWORD_CHANGED`; the connector route
inventory explicitly excludes this human credential action. Shared/API/web
and connector builds plus focused password recovery and route-inventory tests
pass locally. This has not been exercised on Nikita's tenant or in a live
browser. The earlier password-recovery navigation note below is superseded for
signed-in change functionality.

Rendering a working Compliance Record, approved snapshot or minimised review draft now writes a metadata-only row to a separate report-preparation audit before returning HTML. It records tenant, actor, year, version, audience and approved snapshot ID when applicable; no report body or evidence goes into the row. A failed audit write withholds the report. The Governance Audit screen labels report events. The twenty-first DPO migration creates the constrained table and append-only trigger, leaving the older compliance enum unchanged to avoid a new-value decode risk during blue-green overlap. API and production web builds, 28 focused export/archive tests, 11 Team UI tests, 50 reset-safety tests and a populated disposable PostgreSQL 16 upgrade through all 21 DPO migrations pass locally. The event proves server preparation, not receipt, client storage or external disclosure; older downloads are not reconstructed and Nikita's tenant remains unverified.

Team role guidance and the security reference now describe Member reads as limited to permitted status/trustee views and explicitly Member-visible documents. Sensitive registers, complaints, conflicts and full reports remain Owner/Admin-only in source. This is a copy correction; real content classification and deployed-role verification remain open.

Future replay events now include a one-way fingerprint of the presented session row and the number of active sessions quarantined by that observation. The Admin diagnostic view shows both, with nulls for older rows and a warning that repeated fingerprints establish only repeated presentation of one spent row. No refresh token, token hash or raw session ID is added to the audit response. Shared/API/web builds, edited-page lint and 50 focused auth/Team tests pass, including a same-row repeat. Nikita's past events cannot gain these fields retroactively; the cause still needs exact deployed-event and restricted-log correlation.

Every charity role can now find its own password-recovery route on Security & Data beside personal authenticator settings. The page follows the existing provider/manual-link recovery workflow and explains that a completed reset signs out existing sessions. This changes navigation only; no new password-change endpoint or live account journey has been verified.

The Team Security & Ownership Audit now pages through retained events in groups of 50 instead of stopping at the newest 20. Each cursor is bound to the tenant and stable event-time/ID order; the service checks the current Owner/Admin role before resolving it. The browser can load older rows, keeps them visible if a later request fails and ignores stale responses after a refresh or role change. The connector also accepts the cursor and filters personal prose inside the paged response when its personal-data gate is closed. Client rows still omit raw context and internal event IDs apart from the opaque next-page cursor. Shared/API/web/connector builds, edited-page lint, 41 focused team tests, 393 passing connector tests (four platform-skipped) and the populated disposable PostgreSQL 16 upgrade through all 20 DPO migrations pass locally. The reviewed tenant is unknown, no live browser check was made, and this does not determine the cause of Nikita's replay events.

The nineteenth and twentieth DPO migrations add `ACTION_APPROVAL_REFUSED` to the security-event enum and its subject constraint. Both browser and connector grant routes now append a self-subject security event after an authenticated Owner/Admin refusal, while returning the same opaque 401. The event records tenant, account, client channel and time, but no offered approval ID, password, summary or inferred failure reason. Focused route/enum/constraint tests pass; the populated disposable PostgreSQL 16 upgrade through all 20 DPO migrations stored a real event and removed its fixture. This begins only after deployment; earlier refusal attempts cannot be reconstructed. It does not diagnose Nikita's replay events or prove her tenant's security log.

The local Admin Governance Audit now lists append-only human connector action-approval events for requests, pending renewals, grants and uses. A database trigger captures transitions from the mutable capability row, and the eighteenth DPO migration backfills retained request/grant/use timestamps without inventing historical renewals or refusals. Reconstructed events are labelled and their original expiry is null because a pending request may have been renewed. A use event means the request passed the approval gate, not that the action succeeded; action outcome remains in its domain/activity history. The Admin-only, tenant-scoped 50-event page selects actor ID, approval/record IDs, route pattern, method, kind, known expiry, provenance and event time; summaries, request digests and session-family IDs are excluded. A disposable PostgreSQL 16 upgrade from the 64 pre-DPO migrations to all 18 DPO migrations passed with a pre-existing approval, live transition capture, provenance checks, append-only and state-rewrite rejection, and Admin/Member API checks. The local Docker container was removed. Earlier events absent from retained approval rows cannot be reconstructed; no deployed evidence from Nikita's dashboard exists.

The isolated E2E database reset inventory now names all 14 DPO-created tables and the missing ConfluenceReference table. Its exact-model and guarded-reset contract suite passes 50/50. This is reset-safety source proof, not a full isolated browser journey.

For the eighteenth migration, the blue-green gate has no blocking finding and warns about the new audit table's index and foreign key. The migration locks approval writes during the backfill so a concurrent grant cannot fall between the historical read and trigger installation. The disposable PostgreSQL rehearsal passed, but production-like approval volume and migration latency remain unmeasured; no live deployment was made.

The private disposable PostgreSQL 16 harness now exercises DPO-01 through real Fastify routes, Prisma and signed browser/MCP-connector session rows after the migrations. Synthetic Admin/Member requests confirmed Member 403 for statutory membership, complaints, conflicts and full export; 404 for restricted document detail/download; list omission until explicit `MEMBER_VISIBLE`; Admin access to seeded restricted records; and loss of restricted read after database role demotion despite an old Admin token. The container was removed. This is local API/database evidence only; it does not inspect actual content, exercise a rendered browser or full connector CLI, identify Nikita's tenant or prove deployed access.

The DPO-06 source follow-on adds a daily production-scheduler scan for latest active risk-control verification claims whose captured risk revision is unknown or differs from the current tenant risk. The scheduler logs only the global count; the tenant-scoped Admin Registers page already identifies each record for review. A failed scan uses the existing sanitized job-failure alert and fails run-once. `RISK_CONTROL_REVIEW_INTERVAL_MS` defaults to 24 hours and is bounded to one hour through seven days in scheduler and production preflight. API build, 27 focused scheduler/observability tests, all 180 production-preflight tests and a disposable PostgreSQL run of the real query pass. This does not establish C1 closure, inspect Nikita's tenant or prove a deployed scheduler.

A source review of DPO-03's remote-copy boundary found that leaving `CURRENT` revokes local external-publication approval and stops new worker publication, but an already processed Confluence page may remain. The existing owner ruling preserves published pages on ordinary deletion, and Confluence erasure is a separate reviewed action. Lifecycle status must not be described as withdrawing or purging an existing remote copy; disposition requires the exact tenant/page and controller review.

On 2026-09-29 an approved local Docker Desktop named-pipe run started a uniquely named, loopback-only disposable PostgreSQL 16 container. `prisma migrate deploy` applied all 81 repository migrations, including all 17 DPO migrations, to an empty database; `prisma migrate status` reported the schema up to date. The container was removed and an independent listing found no remainder. This supersedes older statements below that these migrations had never run on PostgreSQL. This empty-database run alone does not prove an upgrade with populated data or trigger behavior; neither run proves a live provider or deployment to Nikita's unknown tenant. No production database was touched.

A second disposable PostgreSQL 16 run deployed the 64 pre-DPO migrations, seeded a synthetic organisation/Owner and two legacy documents, and then applied all 17 DPO migrations. It verified restricted/unreviewed/unapproved/unheld defaults on those files, rejected publication before CURRENT status, rejected forged upload-intent transitions and accepted a matching live-document attachment. Prisma reported the schema up to date and container removal was verified. The repeatable local harness is private at `.charitypilot-private/dpo-upgrade-rehearsal.cjs`. This representative upgrade narrows the migration gap; it does not cover all legacy row shapes, concurrency, production scale, storage/Confluence providers or the unknown reviewed tenant.

The new optional upload timeout is documented in local/production env examples and architecture notes, and production preflight validates a canonical 100-1800000 ms range when set. The preflight suite passes 179/179 locally after stale source-shape assertions were updated to match current Member-specific query projections and forbidden fake-Atlassian variables were excluded from its required-input derivation. No deployment or live provider was exercised.

Local and Supabase document provider writes now have an abortable operation bound, defaulting to five minutes and capped at 30 minutes if configured. This remains below the one-hour orphan-reservation cleanup threshold. The API build and 30 focused storage/upload-intent tests pass, including a stalled Supabase response that closes its underlying request. This is source proof only; the upload-intent migration, real provider and live cleanup behavior remain unverified.

The connector's document-delete description and the human approval summary now describe removal of an eligible unheld draft, separately tracked primary-file cleanup and separate Confluence copy review. The Confluence erasure approval summary says it requests erasure and may need administrator purge review; fallback summaries do not claim completed purge. API/MCP builds, focused action-summary tests and the connector suite pass locally. This corrects approval wording; it does not change provider behavior or prove permanent erasure.

Data Requests now pages through retained per-case review events in groups of 50, using a cursor bound to the same tenant and case and a stable timestamp/event-ID order. The web screen loads older history and ignores a late response after the reviewer switches cases. API and production web builds and six focused lifecycle tests pass locally. This is access to intake/triage history, not a retention or erasure workflow completion; no live tenant check has run.

The minimised Compliance Record review draft now excludes the internal snapshot ID and hash, while retaining server-side integrity verification of the approved snapshot. Full and minimised HTML responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. API build and seven snapshot-export tests pass locally. The field/audience decision, live browser behavior and disclosure approval remain open; the private roadmap records the remaining questions.

Recovery-code sign-in records the resulting session family in the security audit. An active browser session that signed in with a recovery code within 15 minutes may remove MFA with its account password even if that was the last unused code; an unrelated session cannot use this path. This is source and focused-test evidence, not a PostgreSQL or live-host recovery proof.

An opt-in authenticator is now implemented locally for charity accounts. Each user can begin setup from `/security-data` after entering their password, confirm a six-digit code, and save ten single-use recovery codes. Browser and MCP connector sign-in both require the factor for an enrolled account before a new session is issued; TOTP reuse is blocked by a stored counter, recovery codes are consumed transactionally, and activation/removal revoke the account's existing sessions. Invalid code attempts use a shared five-attempt, 15-minute account budget after the password succeeds. The page is now reachable by Members for their own setting; its charity-wide controls stay Owner/Admin-only. Three security audit event types record activation, removal and recovery use without the codes. Two new migrations create the factor tables and admit the audit events; neither has run against PostgreSQL. Prisma validation, API/MCP and production web builds, focused tests, 2,246 broad API tests (Docker-backed and one local child-process check excluded) and 391 connector tests (four platform skips) pass locally. No role-wide MFA policy, lost-all-codes recovery authority, live browser evidence or DPO sign-off is claimed. A `JWT_SECRET` rotation makes enrolled TOTP secrets unreadable; saved recovery codes remain usable, so rotation requires a recovery and re-enrolment procedure.

The DPO-01 read-surface review found that old action-approval summaries could remain readable to an account after demotion to Member. Browser pending-approval and grant routes, plus connector preview and grant routes, now require the database-derived current Owner/Admin role. A regression test changes the role behind an Admin token and confirms all four routes deny before reading or granting an approval; API build, 34 focused tests, 2,236 broad API tests and 389 connector tests (four platform skips) pass locally. This has not been checked on Nikita's deployed tenant.

Failed-upload cleanup now starts with a provider-pinned `DocumentUploadIntent` saved before bytes are written. Document creation and attachment of that reservation share a transaction. The recurring and standalone cleanup jobs reconcile reservations older than one hour: they preserve a path referenced by a live same-tenant document and otherwise atomically queue provider-pinned deletion. Queue failures leave the reservation for retry and produce a count-only alert; the deletion worker checks again for a live document before erasure. API build, Prisma validation, 101 focused tests and 2,235 broad API tests pass locally, with Docker-backed PostgreSQL proofs and one resource-failing child-process check skipped. The new upload-intent migration and trigger have not run against PostgreSQL, and no live provider or tenant journey was tested. This is not a recovery window, backup purge or retention-policy approval.

Member login, `/auth/me` and invite acceptance now omit registered address, contact email/phone and conditional obligation profile from Member database selections, while Owner/Admin reads retain them. The login credential/lifecycle read fetches only organisation lifecycle before a role-matched public-user read; session issuance verifies the password and rejects a changed role under its principal lock. API build and 48 focused auth/team tests pass locally. This closes the wider internal auth/user read noted in the older checkpoint below at source level only; Nikita's tenant, records and deployed Member journey remain unverified.

A private DPO-01 route-family inventory is now at `.charitypilot-private/member-read-surface-inventory.md`. It maps current Member projections, Owner/Admin-only reads, connector and external-copy boundaries, and the remaining controller decisions. Source inspection found no new confirmed Member data leak in the reviewed route groups; it is not a live access certification. The profile-triggered evidence prompt now checks `CURRENT` lifecycle status itself before counting linked evidence, reinforcing the existing caller filter so historical links cannot satisfy a prompt if a future caller passes mixed records. The production web build and edited-file lint pass locally.

The Admin Registers page now checks the latest claim for each control across the tenant when the page opens and exposes a paged list of active verifications whose captured risk revision is missing or differs from the current risk. Its API joins only the same tenant's risk and claims, binds a pagination cursor to that tenant, and excludes withdrawn controls. The connector excludes this review route and withholds the new risk revision and document deletion-hold fields. The 50 focused register tests, 389 connector tests (four platform skips), API/MCP and production web builds, Prisma validation and edited web lint pass locally. This is a live-on-page review list, not a scheduled background scan or an assessment that the underlying evidence failed. The fourteenth DPO migration is still unapplied, and the reviewed tenant/C1 closure artifact are still unknown.

The DPO-06 control history now captures an integer risk revision with each new verification or withdrawal. A risk edit advances the revision, and the per-risk Admin history prompts evidence review when the latest active verification for a control predates the current risk. Withdrawn and superseded claims remain visible as history without an active review cue; older active claims have no invented revision and are explicitly marked for review. The fourteenth DPO migration supplies revision constraints and a database check on new claims; it has only passed schema validation, not PostgreSQL execution. The API build, 49 focused register tests, production web build, three compiled cue tests and edited web lint pass locally. This is a review cue, not C1 reconciliation, a verdict on control effectiveness or a scheduled stale-control check. Nikita's tenant and original admin-email closure evidence remain unknown.

Ordinary Vault deletion now accepts only unheld `DRAFT` documents. The service rejects all five other lifecycle states before creating a storage-deletion job, and the database delete condition rechecks draft status and hold state so a concurrent classification or hold cannot slip through. The Admin Vault disables Delete for retained or unreviewed evidence and explains the review boundary. This is an interim preservation control, not an approved retention period or a route for authorised permanent erasure. The 103 focused document route/storage/reliability tests, API and production web builds, and edited web lint pass locally. The lifecycle and hold migrations remain unapplied and no PostgreSQL or live tenant behavior has been verified.

New local/Supabase primary-storage deletion attempts now verify that the active path is absent before the storage service reports success. A Supabase remove acknowledgment alone is insufficient: only a subsequent authenticated HEAD 404 passes, while 200/400/error/timeout enters the existing retry/dead-letter path. The worker also rejects an apparent primary eraser success without a valid observation. A new nullable `activeObjectAbsentAt` receipt is written with `PROCESSED` only for new primary-storage observations; old processed rows and Confluence rows retain null. The thirteenth DPO migration adds the guarded receipt and remains unapplied. The 102 focused document/storage tests, 31 erasure/scheduler tests, five archive tests, 13 adjacent reliability tests, Prisma validation and API build pass locally. This is not historical proof, deleted-item recovery, provider-version/backup purge or a live deployment check. The current DELETE still removes bytes immediately; a trash/recovery period requires the controller's retention decision.

The Admin Registers screen now offers paged control-claim history for one risk, optionally filtered by exact control reference. The route binds cursors to the same tenant, risk and filter, while the charity-wide recent list is marked as a 100-entry view. The 23-test register route suite, API/MCP and production web builds, edited web lint and connector route coverage pass locally. The C1 risk and original admin-email closure evidence have not been identified; this path does not assert the control passed, backfill old claims or verify Nikita's deployment. The control-audit migration remains unapplied.

Governance Audit now uses an Owner/Admin-only `/governance-audit/:feed` archive route to page through retained history for eleven existing feeds, 50 rows at a time. A cursor must belong to the same tenant and feed; equal timestamps are ordered by event ID, and control claims use the database sequence. Document visibility and other document-control events have separate feeds. Storage-deletion paths/provider errors and data-request free-text reasons remain out of the overview. Five focused route tests, API/MCP and production web builds, edited web lint and connector route-coverage tests pass locally. This does not backfill older actions, cover every mutation domain, apply the pending DPO migrations, or prove Nikita's deployed interface.

Future replay events now include the presented session row's prior revocation reason in the restricted, allowlisted diagnostic. This separates a previously rotated, logged-out or already-quarantined token at the evidence level; it is not an incident verdict and cannot repair older events. The rotation and diagnostic tests plus shared/API builds pass locally. Nikita's actual events and deployed revision remain unexamined.

The restricted replay diagnostics now include the immutable security-audit event ID and page through older retained events 50 at a time using a tenant-bound timestamp/ID cursor. This lets an authorised reviewer retrieve and correlate an exact event once the reviewed tenant is identified; raw session-family IDs, user IDs, tokens and event context remain excluded. Focused service tests cover Admin access, Member denial and stable paging; shared/API/production web builds pass. It does not diagnose Nikita's observed reuse or restore events already expired from the audit store.

A 2026-09-29 DPO-05 source slice adds a per-document administrative deletion hold, default off, with an Owner/Admin place/release action that requires a reason and current revision. The action writes an actor-bound event in the document control history; ordinary Vault DELETE rejects a held record and conditionally deletes only if it remains unheld at the database write. The Vault shows the hold to Owner/Admin and disables Delete while held. The twelfth DPO migration has not run against PostgreSQL. Focused route tests, Prisma validation and API/MCP/production web builds pass locally. This is not a controller-approved legal hold or retention period, does not stop separate Confluence erasure or independent storage cleanup, and does not add deleted-item recovery or application-wide purge. No live Nikita-tenant check has run; Jasper does not know that tenant or the approved schedule location.

Nikita Serkevich confirmed continuing dashboard access and gave positive first-pass observations, but explicitly **did not provide production sign-off**. Her review raises Member access to sensitive records, repeated session-replay events, document lifecycle, report minimisation, application retention/erasure, and stale C1 verification evidence. She also asked to locate the minute book, application audit trail, document visibility controls, and tenant security/retention administration. The full email, source-level findings, unanswered questions and work order are in the local gitignored `.charitypilot-private/ROADMAP.md`. If that file is absent on another checkout, obtain the controlled private handoff from the owner; do not infer closure from this summary. Carry these points into the full-platform remediation and launch gates, and preserve the separation between source proof, live-instance proof and professional review.

The local first implementation slice restricts full report and conflict/complaint reads to Owner/Admin and adds document visibility, defaulting old and new records to `RESTRICTED`. An Admin may expose one document to Members with a reason; an append-only visibility audit records that decision. Member document list/detail/download and activity filter restricted document metadata; board submissions are now Admin-only and current-document-only. A later interim rule also restricts current Minute Book acts and resolutions to Owner/Admin, excludes them from Member search and navigation, and leaves their final audience/classification decision open. Edit and void histories are Admin-only. This is source and focused-test evidence only: the database migration, managed browser journey, hosted access, existing Confluence copies, remaining personal-data routes, replay-event cause, and DPO review are open. The private roadmap records the exact pending work.

A second local slice adds a conservative document lifecycle (`UNREVIEWED` for existing files, `DRAFT` for uploads), reasoned transitions and document-control history. A separate per-document Confluence publication approval now gates queueing, retry and worker execution; leaving `CURRENT` revokes that approval. Existing published Confluence copies still require inventory and separate withdrawal/erasure decisions. The Compliance Record has a separately labelled minimised **draft** derived only from a verified retained approved snapshot, with a strict field allowlist. Its audience and disclosure fields still require Nikita/Jasper's decision. Focused source tests passed; neither database migration has been applied, and the browser/live journeys have not been verified. Application-wide retention/purge, live replay diagnosis, C1 evidence correction and a unified governance audit remain open. These additions do not change the personal-server operating instructions or constitute DPO or production sign-off.

A follow-on access check found Member BoardMember API responses still selected detailed personal particulars. Member list/detail now project only ordinary trustee evidence, and Search enforces the Member field scope plus conflict/complaint exclusion and document visibility filtering. Focused board/search tests pass locally; the broader data inventory and live Member journey remain open.

The separate statutory membership register `/api/v1/members` was then found to expose postal addresses and former-member entries to signed-in Members. Its GET now requires Owner/Admin; a focused route test confirms Member denial before a database read. This conservative boundary awaits a reviewed register classification.

A further source check found unrestricted Member free text in risk/fundraising records, annual readiness, financial controls and compliance records/sign-off. Their API reads now use explicit Member projections that retain statuses, scores, flags and dates while omitting titles, narratives, names, minute references and editor/approver particulars. The corresponding screens explain the limited view. Owner/Admin reads are unchanged. API build and 41 focused route tests passed; edited web lint passed. This remains an interim coarse boundary pending classification and live verification. The existing web typecheck errors in unrelated test files that assign to readonly `NODE_ENV` remain.

The Minute Book removed-record feed exposed historic titles, deletion reasons and remover emails to Members. Its API and screen now restrict that feed to Owner/Admin. The 29-test governing-acts suite passed. Current acts and resolutions remain Member-readable pending classification.

The Board-submissions API is now Owner/Admin-only because it can carry resolution text and approval particulars even when the linked document is Member-visible. Its document query selects only `CURRENT` lifecycle files, so old or unreviewed files cannot be presented as current board evidence. The 33-test governing-acts suite covers the Member denial and current-only query. Current Minute Book act/resolution reads still need the controller's audience decision.

Minute Book act/resolution create and update now write actor-bound before/after snapshots atomically with each edit to an append-only table. Its Owner/Admin-only, tenant-scoped recent feed appears in Governance Audit and is excluded from the MCP connector. Document board-approval link/assertion changes now also write an actor-bound event in the existing document-control audit transaction. The 32-test governing-acts suite, API build, Prisma validation and connector tests pass. The fourth migration has not been applied to a database; no older edits are backfilled, and other domains still need audit coverage.

Document metadata PATCH now appends an actor-bound event in that same document-control history, recording edited field names and before/after revision times without duplicating names or descriptions. Uploads record the actor and restricted draft state atomically with database creation; an audit failure fails the upload and enters the existing storage cleanup path. Document DELETE now appends an actor-bound `RECORD_DELETE` event before provider cleanup, explicitly describing database removal rather than completed erasure. Governance-standard link and unlink mutations append actor-bound events with the standard ID; a repeated no-op unlink adds no false history. The metadata write is revision-guarded, and the 32-test document route and 32-test storage-cleanup suites cover the events and relevant failure paths. The still-unapplied lifecycle migration was extended with `METADATA`, `UPLOAD`, `RECORD_DELETE`, `STANDARD_LINK` and `STANDARD_UNLINK` event kinds. Legacy changes and other domain mutations remain outside a complete application audit.

DPO-05 now has a private source inventory at `.charitypilot-private/data-lifecycle-inventory.md` and a local Admin-only `/data-lifecycle` intake/triage screen. It records opaque external case references for erasure or retention review, received time, data area and append-only actor/reason/evidence events. OPEN, ASSESSING and DECISION_REQUIRED are deliberately unresolved states; the queue cannot claim deletion, recovery or purge. The fifth migration protects immutable intake facts and ties events to the same tenant at the database boundary. Four focused route tests, API build, Prisma validation, edited web lint and connector tests pass. No policy period, legal hold, deadline, actual deletion/recovery/purge or live/browser proof was added. The five DPO migrations remain unapplied.

Future web and connector replay audit events now carry the server request ID for restricted correlation with API logs, without storing a token. The 27-test auth-isolation suite passed. Existing replay events still require live investigation and cannot acquire this context retroactively.

The MCP connector consumes those same API guards. Its descriptions now state the Member omissions and statutory-register role boundary; its route coverage deliberately excludes the new Admin audit/operational endpoints, and its document field policy classifies the new control flags. The connector contract suite passed locally (388 passed, four platform-skipped).

The next local slice coordinates browser refresh across tabs using Web Locks and a noncredential completion stamp, but the cause of Nikita's live replay events remains unknown. Risk create/edit/delete now records append-only before/after history, while dated control verification has a separate append-only evidence record and Registers UI. C1 has not been marked verified without its original evidence. An Admin-only `/governance-audit` page gathers the newest document, risk, control, compliance, Minute Book edit and storage-deletion records and links to the separate Team security log. This page is a bounded recent view, not a complete historical audit. Storage-deletion history is metadata only; application-wide retention, recovery, legal holds and purge remain open. Five migrations are unapplied; no browser or live-host check has occurred. Focused API suites, API build, Prisma validation and the compiled cross-tab helper tests passed. Web typecheck has only the existing readonly `NODE_ENV` test-file errors. The private roadmap carries the exact remaining evidence and policy inputs.

The subsequent server-proxy slice coalesces only concurrent refresh calls in one Next process for the same credential header and origin, using a digest map key. It does not cache a completed rotation: later reuse still reaches the API replay control. The compiled proxy suite passed 23/23. The cause of Nikita's observed events is still unknown, and multi-replica or trailing-request races remain. Current Minute Book act and resolution reads are Owner/Admin-only pending classification; Member search cannot expose them. The focused governing-act/search suites passed 50/50, and the API build and edited web lint passed. These are local source checks. All five DPO migrations remain unapplied; the available workstation lacked Docker/psql clients and a local PostgreSQL listener for a disposable migration run.

The next DPO-03 source slice adds a sixth migration for tenant-bound `Document.supersededByDocumentId` lineage. Newly classifying a document as `SUPERSEDED` now requires a different `CURRENT` replacement in the same tenant and category; the decision writes a `REPLACEMENT` control event atomically. The Admin Vault offers a paged candidate search and shows recorded successors. Member responses and connector projections withhold the successor ID, which could otherwise disclose a restricted file. The foreign key blocks deleting a referenced replacement. Existing superseded files retain a null link pending individual review. Focused document API suites passed 92/92; the broad API suite passed 2166 tests when Docker-backed and sandbox-failing child-process proofs were excluded, and the connector suite passed 388 with four platform skips. Prisma validation, shared/API/MCP builds and edited web lint passed. At that checkpoint six DPO migrations remained unapplied and no browser or hosted verification had occurred. The later evidence correction at the top of this handoff located the March schedule's approval thread; the CharityPilot-specific mapping, C1 closure evidence and Nikita's exact dashboard tenant/environment remain unknown.

The replacement category is now protected after selection as well: the API refuses category changes on either side of a recorded replacement link, and the sixth migration includes a row-locking database trigger to preserve category agreement under concurrent edits. A constraint refusal maps to a reviewable API conflict. Thirty-nine focused document-route tests, API build and Prisma validation pass locally. The trigger and migration have not run against PostgreSQL, so database concurrency and live behavior are not yet proven.

The next DPO-01 read pass found custom and legacy calculated deadline titles could reach Members through the calendar, direct IDs, Search, dashboard and recent activity. Member queries now allow only current-rule generated records; custom and `LEGACY_UNVERIFIED` records stay Owner/Admin-only pending classification. Member generated-deadline responses also omit descriptions and saved profile/source snapshots, generated keys and replacement IDs. The Member calendar explains the narrower view and connector descriptions match it. Focused deadline/search/dashboard suites passed 35/35, the broad API suite passed 2168 tests with Docker-backed and sandbox-failing child-process proofs excluded, and the connector suite passed 388 with four platform skips. This has not been checked against Nikita's tenant or in a managed browser. The six DPO migrations remain unapplied, and the source-wide Member read inventory is still in progress.

The next DPO-01 check found Member organisation and authenticated-user responses still carried registered address, contact details and conditional obligation facts; for a small charity the address may be a trustee home address. The profile and shared auth/invitation user DTO now return null for those fields to Members, while Owners/Admins retain them. The Member profile route excludes those fields in its database selection; auth/user loading still selects the wider profile internally before response projection. The Member organisation page gives a basic profile without false missing-field prompts. Focused organisation/auth tests passed 34/34; the broad API suite passed 2170 with Docker-backed and sandbox-failing child-process proofs excluded, and the connector suite passed 388 with four platform skips. Edited web lint passed. Live Member behavior and remaining surfaces need review.

For Nikita's fourth interface question, `/security-data` now includes a personal opt-in authenticator setting for every charity user and maps tenant roles, sessions, security events, password recovery, governance audit, data-request intake, document/storage deletion and Confluence copy management for Owners/Admins. It still labels approved application-wide retention enforcement, legal holds, deleted-item recovery and permanent-purge administration as unavailable. Role-wide MFA enforcement is not configured. This is local source/build evidence, not proof that Nikita can see the page on her live dashboard.

A further DPO-01 source check found that the Member compliance sign-off response still carried approved-snapshot IDs and evidence/snapshot hashes, while `/compliance/approval-readiness` exposed standard-level evidence gaps and profile-review flags to Members. The Member sign-off projection now omits the snapshot metadata; approval-readiness is Owner/Admin-only, and Member web screens skip its request. The compiled compliance route suite passed 20/20, the API and production web builds passed, and edited web lint passed. The six DPO migrations remain unapplied; no live role journey, replay investigation or DPO approval was obtained. The workstation has no available Docker or PostgreSQL client for a disposable migration run; CI's migration-deploy step is source-wired but has not run for this checkout.

The next DPO-02 source slice exposes a bounded Owner/Admin replay-diagnostics view in Security & Data. Its API checks the live actor and tenant before selecting the latest 50 `SESSION_REPLAY_DETECTED` events, then returns only time, a short one-way family fingerprint, client/access category and a validated server request ID when available. It withholds raw family IDs, user IDs, tokens and arbitrary audit context; the MCP connector excludes the route. The focused team-lifecycle suite passed 21/21, connector route coverage passed 5/5, and shared/API/MCP and production web builds passed. No historical replay cause can be inferred from the source, older events may have no request ID, and the approved live environment remains unidentified.

A DPO-06 register-history slice adds a seventh migration and a metadata-only, actor-bound action trail for trustee, conflict, complaint and fundraising create/update/delete, plus annual-report and financial-control create/update. Each audit write shares the mutation transaction; deletion leaves the audit row without duplicating personal details or narrative. The Owner/Admin-only `/governance-registers/change-audit` feed appears in Governance Audit and is excluded from the connector. Prisma validation, API/MCP and production web builds passed locally; focused tests now cover all six register classes. No migration was run against PostgreSQL on this workstation; all seven DPO migrations and live/browser review remain open. Earlier actions are not backfilled, and this is not a complete application audit.

A further DPO-01 search pass found that Member search could quote risk titles and fundraising names although the Member register API withheld those fields. Member search now skips those two record classes entirely; the focused search suite passes 16/16, including a Member with a FULL session data-scope flag. This is source-only and leaves the register-by-register audience decision and live role journey open.

The Member dashboard activity feed also exposed compliance editors and document uploaders through actor IDs/names. Member activity now omits those actor fields and avoids fetching the relations; Owner/Admin activity retains them. The combined dashboard/search suite passes 26/26 locally. Document field classification and live Member review remain open.

A further DPO-01 document-card pass found that a Member-visible file still exposed unreviewed description, owner, board-minute reference and uploader ID in list/detail, while search could match the minute reference. Member document queries now select only the shared-card fields and return null for those four metadata fields; closed-scope search and the MCP field policy withhold the minute reference. The authenticated download remains available and Admin detail retains its full metadata. Focused document/search tests pass 41/41, connector field-policy tests 37/37, and the production web build passes. The file itself and other metadata still require a controller classification and live role review.

The dashboard board-alert and compliance-summary database reads now select only the fields their aggregates use, rather than loading full trustee particulars and compliance narratives. The connector's withheld Document scope also excludes the Board-resolution identifier, which could join to the restricted Minute Book. The API build and focused dashboard/compliance suites pass 30/30 locally; live access and controller classification remain open.

A further DPO-06 slice adds metadata-only, actor-bound organisation profile edit history in the same transaction as each successful PATCH. Its eighth DPO migration creates an append-only table; `/organisation/audit` and Governance Audit expose the newest 100 tenant-scoped entries to Owner/Admin, while the connector excludes the route. It records submitted field names and revision times without copying address, contact or obligation values. Forty focused organisation tests, five connector route-coverage tests, Prisma schema validation and API/MCP/production web builds pass locally. The eighth migration has not been applied to PostgreSQL, legacy edits are not backfilled, and the application audit remains incomplete.

Member generated-deadline list/detail/history and dashboard reads now exclude saved generation snapshots, keys, description, profile-review key and successor ID in the database selection. The response still returns null placeholders for these fields through an explicit allowlist. Focused deadline/dashboard suites pass 20/20 locally; the live role journey and controller classification remain open.

Statutory Members register create/edit actions now append actor-bound, metadata-only records in the mutation transaction, visible through the existing Admin register-action feed. A ninth DPO migration permits `MEMBER` events; four focused member audit/privacy tests and the API build pass locally. It has not been applied to PostgreSQL and older actions are not backfilled. The register's pre-existing one-year `retentionDeleteAt` rule remains subject to comparison with the approved retention schedule; no broader retention policy was inferred.

Interactive deadline creation, edits, completion and archival now append metadata-only, actor-bound history in the same transaction. The tenth DPO migration creates the append-only trail and an Owner/Admin `/deadlines/audit` feed in Governance Audit; the connector excludes it. Prisma schema validation, API/MCP/production web builds, focused deadline tests and the broad API run (2,188 passing, with the two environment-dependent checks excluded) pass locally. At that checkpoint automatic calendar reconciliation and reminder delivery were not included; older actions are not backfilled, and the tenth migration has not been run against PostgreSQL.

Organisation-profile edits that regenerate deadlines now append actor-bound `GENERATE` and `SUPERSEDE` entries for changed occurrences in the same serializable transaction. The metadata-only events record state changes, edited field names and revision times without copying titles or profile inputs. The still-unapplied tenth migration allows those action/state pairs. The focused deadline, organisation and governance tests pass 53/53; API build and Prisma schema validation pass locally. Reminder delivery remains in its separate operational history, not this governance feed. No live migration or Nikita-tenant check has run.

The statutory membership edit now validates the resulting entry/cessation date pair inside the transaction even if the user changes only one date. Five focused tests pass locally. Its former one-year `retentionDeleteAt` formula was removed from local source and is not a valid policy mapping; stored historical values await reconciliation. The document dead-letter recovery path is a storage-cleanup retry or acknowledgement, not deleted-item restoration; the private lifecycle inventory distinguishes these states.

The Vault deletion dialog and success message now distinguish immediate record/standard-link removal from separately tracked file cleanup and Confluence copy erasure. This corrects a misleading claim that the file itself was removed when cleanup may have failed and entered retry. Edited web lint passes; no purge or deleted-item recovery claim follows from the UI copy.

The Admin risk-control panel now flags active risks when their recorded review date is due or past due, and counts active risks without a review date. This is a review prompt, not evidence that a control failed or passed; periodic automation is still open. A bounded search of repository docs/source and all-ref commit messages did not find the separate admin-email/C1 closure artifact. A 2026-09-30 local Timebank folder follow-up extracted text from 288 Word files and 241 PDFs; it found the generic March C1 risk row but no later closure receipt, with seven PDFs unreadable by the extractor. The live C1 record, its revision, the relevant tenant and original verification evidence remain unknown, so no C1 status was changed. The date-selection test, production web build and edited-file lint pass locally. The private roadmap records the search and outstanding reconciliation.

Risk-control verification and withdrawal now lock the tenant-scoped risk row before checking the latest claim, and the append-only table has a database-assigned sequence for deterministic event order when timestamps tie. The second withdrawal is rejected after the first. Prisma generation/schema validation, API build and 47 focused register tests pass locally. The third DPO migration is still unapplied; no PostgreSQL concurrency test or C1 correction is claimed.

A later document lifecycle guard prevents new governance-standard links from being created after a document leaves `CURRENT`, even if a status change races the API's earlier check. A database trigger serialises the link insertion with the document row, while existing links remain as historical evidence. The API returns a conflict on the trigger refusal. The API build and 40 focused document-route tests pass locally; the eleventh DPO migration has not run against PostgreSQL. A read-only browser inventory found no open CharityPilot dashboard session on 2026-09-29, so it did not identify Nikita's tenant or verify live replay/C1 records.

The Vault now marks a recorded Confluence copy attached to a non-current document for separate review instead of showing a green published badge. It also avoids a failed-publication retry that the API would reject after lifecycle withdrawal. The copy remains in the guarded status module; 31 focused copy tests, edited-file lint and the production web build pass locally. Existing external pages are not automatically withdrawn or erased, and the live reviewed tenant remains unidentified.

Board approval PATCH no longer creates an audit event for a repeated identical value, and rejects an empty patch before a document read. It still checks a newly supplied resolution against approved Minute Book evidence. Shared/API builds and 36 focused governing-act tests pass locally. This improves audit truth for future changes; it does not repair older history or prove the deployed workflow.

The Data Requests queue's append-only intake and triage events now have a tenant-scoped, Owner/Admin-only recent feed in Governance Audit. Its overview omits free-text reasons; an individual controlled case still shows them. The MCP connector excludes the new endpoint. Five focused intake tests, 11 connector route-coverage tests, API/MCP and production web builds, and edited-page lint pass locally. The feed starts with the unapplied intake migration and does not implement retention periods, legal holds, deletion, recovery or purge.

A further DPO-01 Team read pass found that Members could receive other account holders' email addresses, verification flags and suspended/removed membership rows. The Member Team query now selects active accounts only and omits those contact/verification columns; the UI and connector description reflect the narrower response. Owner/Admin management reads remain complete. Shared/API/MCP and production web builds, 16 focused Team API tests, 20 compiled Team UI/permission tests, 52 connector tests and edited web lint pass locally. This does not complete the Member data inventory or verify the deployed tenant and Nikita's role.

Member risk and fundraising list/detail routes now use database selections containing only their existing Member response fields. Annual-readiness and financial-control Member reads also select only their visible status, flag and date fields, with null placeholders for unclassified narratives, reviewer details and minute references. Owner/Admin reads remain complete. The 22-test register route suite checks these selections, withheld response text and tenant scoping; the 25-test service suite and API build pass. No live role journey or controller-approved classification follows from this source change.

Search now fetches only ID and the columns it is permitted to match or display under the current role/session scope. Previously a Member query could load a whole matched trustee, document or deadline row while returning a safe hit. The 16-test search route suite applies the database selection in its fake delegate and checks every Member query's allowed fields; the API build passes. Sensitive register and Minute Book classes remain excluded from Member search. This is a query boundary, not live-host or DPO verification.

Member compliance record list/detail queries now avoid loading evidence narratives and editor relations, selecting only the fields used by the existing limited response. Member sign-off reads select visible metadata plus only the current snapshot's evidence hash; they do not read the latest historical snapshot or approver details. An approved sign-off still recomputes the current evidence hash internally so `approvalCurrent` remains accurate. Admin reads retain full evidence. The 21-test compliance route suite and seven export-snapshot tests pass with the API build. This is source-only and does not settle the Member audience classification or prove deployed behavior.

The next DPO-01/03 guard closes a new-release gap for legacy documents. The Admin Vault now explains and disables Member release while a file's lifecycle is `UNREVIEWED`; the API returns a conflict for that transition. Migration `20260929250000_unreviewed_member_visibility_guard` adds a `NOT VALID` CHECK that also rejects direct database writes into the unreviewed/Member-visible combination. It enforces new and updated rows without certifying old rows; an existing violating row must be classified or restricted before another update. The focused document route suite passed 48/48, the API build, edited UI lint, E2E TypeScript and static migration gate passed. The focused isolated PostgreSQL/Chromium Owner journey passed with a disabled release button and database CHECK denial; the gated runner exited 0. The earlier combined navigation suite had a repeated authentication-service 503 on reload, so it is not a clean suite result for this edit. Nikita's reviewed tenant, actual contents, controller audience and live migration remain unknown.

A follow-on closes the legacy-read side of that boundary. Member Vault list, detail and download, Search and dashboard activity now exclude `UNREVIEWED` documents even if an old row says `MEMBER_VISIBLE`. Download rechecks lifecycle after storage I/O, and its current-session role check treats that file as restricted. The focused document, search and dashboard suites pass 106/106 with the API build. This protects local source reads but does not classify existing rows, reverse earlier exposure, or constrain external Confluence copies. There is no live-tenant read or deployment proof.

A read-only host check found the historical CharityPilot Tailscale peer online and its unauthenticated HTTPS health and login endpoints responding. Subsequent work-mailbox correspondence confirms Nikita reached that same private host and signed in on 19 September for a light deployed-version review; her 28 September feedback says she still had dashboard access. The exact tenant, role and revision on 28 September remain unverified. The private roadmap records the correspondence IDs and host lead without invitation credentials. The public endpoints expose no tenant or signed-in build identity. Do not use this host as a deployment target or close replay/C1 findings until the tenant and revision are established.

The 2026-09-30 connector mutation follow-up added web-session checks to the Confluence OAuth callback, publish destination, citations, declared environment, erasure request and disconnect, plus Vault publication retry and failed storage-deletion requeue. Their connector tool exclusions alone were not an API boundary. The existing Confluence erasure connector test now expects refusal before approval creation. API build and 181 focused integration/document/recovery route tests pass locally. A further pass added web-session checks to one-time invitation-link retrieval, charity ownership transfer and billing checkout/portal (including aliases); Team/billing tests pass 38/38 and connector route contracts 15/15. Do not treat this as live provider deletion, deployed tenant evidence or DPO acceptance; the private connector boundary map names the intentional exceptions.

## 2026-07-12 private Linux host profile

A separate `private-linux-server` host profile now preserves the option to run
the compiled single-charity appliance on an inexpensive x86-64 Linux VM. It
adds `scripts/Install-CharityPilot.sh`, a Linux preflight, a local Unix-socket
Docker boundary, Linux permission enforcement, release metadata and the
authoritative `docs/personal-server-deployment-linux.md` runbook. It reuses the
existing Caddy/Next.js/Fastify/PostgreSQL topology and encrypted recovery engine;
the Windows and strict public-production profiles remain intact.

Repository contracts are implemented, but Linux has no live certification yet.
Do not claim it ready for irreplaceable records until a clean VM install,
reboot/login, Tailscale director access, off-host recovery, different-VM restore,
failed-resume/replacement wrappers, version-bound update/rollback and exact-SHA
Linux release acceptance pass. The Windows readiness score does not transfer.

## Active Full-Platform Remediation Audit

Before selecting production-completion work, read:

- `docs/platform-remediation-audit-2026-07-10.md`

That document is the authoritative human-maintained remediation ledger for the
2026-07-10 full-platform audit. It records the 669/1000 baseline, every confirmed
repository issue, the strict launch-evidence split, safety constraints, external
blockers, acceptance criteria, and the continuous inspect/fix/verify/commit/push
loop. Do not narrow the goal to the generated platform audit or stop because
local gates are green.

## 2026-07-10 Remediation Checkpoint

The detailed issue contract remains in
`docs/platform-remediation-audit-2026-07-10.md`. The current P0 checkpoint is:

- **P0-01 annual-reporting claim containment - `CI_VERIFIED`.** Commit
  `97f64b0285eb2d19489c062cda52134fda8f9a53` passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29073803773`.
  Local evidence was web `244 / 244`, shared `19 / 19`, web lint/build,
  generated-audit currency, and production tooling `396 / 396`. Named
  accountant/Irish-solicitor approval remains external.
- **P0-02 Resend acceptance/retry semantics - `CI_VERIFIED`.** Commit
  `fbd5ce4` passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29074651622`.
  Local evidence was focused email/degradation/reminder/auth/team/scheduler/
  idempotency tests `73 / 73`, full API `438 / 438`, API build, and production
  tooling `396 / 396`. A real accepted Resend send and verified production
  domain remain external launch evidence.
- **P0-03 duplicate Stripe subscription path - `CI_VERIFIED`.** Implementation
  commit `ce9a5ed9701776bb2a957da647b3620288be173b` plus the launch-counter and
  readiness-test repairs through `7ffc8f862d863f559365668c19550be00d0bb382`
  passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29077589143`.
  The repository now has a one-per-organisation
  `BillingCheckoutAttempt` lease/migration, attempt-bound Stripe idempotency and
  metadata, remote customer/subscription reconciliation, strict terminal-state
  restart rules, expired-session reconciliation, stale/superseded webhook
  protection, authoritative subscription re-retrieval, exact one-item/
  quantity-one price+interval validation, raw Stripe status/cancel scheduling,
  server-owned web capabilities, and a pinned Billing Portal configuration.
  Existing Stripe-managed subscriptions are portal-only; public copy no longer
  promises unverified proration or offers Checkout as a plan-change route.
  Focused API billing/idempotency verification is `50 / 50`; provider-checker
  verification is `13 / 13`; shared is `19 / 19`; web is `248 / 248`; web lint
  and production build pass; and the final full API suite is `454 / 454` after
  all P0-03 tests were integrated. Production tooling is `488 / 488`, the
  reliability report is green with `365 / 365` covered links, and the platform
  audit is current.
- **P0-04 compliance concurrency and immutable board approval -
  `CI_VERIFIED`.** Commit `e03b80a44150c384485b5e47e524b9ee60475f70`
  passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29082113651`.
  Compliance record/sign-off writes now use explicit
  revisions, serializable organisation locking, compare-and-swap updates,
  idempotent replay handling, and append-only full before/after history. Board
  approval is bound to a canonical immutable evidence snapshot and hash;
  approved-record changes invalidate the current pointer while retaining prior
  snapshots for tenant/year-scoped historical export and deliberate reapproval.
  Legacy approvals are truthfully invalidated rather than reconstructed from
  mutable deployment-time data. Current/approved exports verify freshness,
  tenant scope, row metadata and hashes and preserve CSP when opened through the
  authenticated browser client. The frontend serializes autosave, preserves
  newer drafts across old responses and failures, provides safe conflict
  reconciliation, guards dirty navigation, sequences principle loads, and
  never presents stale approval as current. Local evidence is API `477 / 477`,
  web `272 / 272`, shared `23 / 23`, production tooling `488 / 488`, local-Docker
  tooling `43 / 43`, reliability `374 / 374`, lint, production builds, Prisma
  generation/validation, security scans, zero-vulnerability dependency audits,
  refreshed generated audits, and a clean 14-migration deployment plus
  rollback-only trigger/constraint probes on a dedicated throwaway
  `charitypilot_ci` PostgreSQL container.
- **P0-05 destructive E2E isolation - `CI_VERIFIED`.** The repository now
  supplies a managed, UUID-bound disposable E2E stack and fail-closed database
  identity/reset contract. Database, API, and web stay internal-only while a dedicated
  secretless, read-only fixed-route TCP gateway alone publishes the runner's
  loopback ports; its absolute `.invalid.` routes map only to unique internal
  aliases. API builds the shared app image once and web reuses it. The runner
  executes one private validated Compose snapshot and attests immutable built
  image IDs plus exact live container isolation before Playwright. The complete
  gate passed `113 / 113` isolation contracts and `96 / 96` live Playwright
  tests in `9.6m` (`25.0m` for the full fresh-build/test/verified-teardown
  command) against the real disposable PostgreSQL instance and baked production
  web runtime. Exact-project teardown left no Docker/private-state residue and
  preserved the personal web/API/database container IDs. Remote worker seams
  now prove suite-lease presence, reset proves same-session ownership, and the
  outer janitor runs only after exact POSIX group absence; native-Windows remote
  destructive mode is explicitly rejected. The run also exposed and repaired a
  production-relevant shared-proxy-IP `/auth/me` throttle: credential limiting
  is layered with a coarse IP ceiling, authentication/limiting/origin checks use
  one Bearer parser, and the bounded web proxy accepts exact `200`, refreshes or
  redirects only on explicit `401`, and strictly validates both rotation or
  deletion cookies. Wider evidence is API `488 / 488`, web `295 / 295`, shared
  `23 / 23`, production tooling `512 / 512`, local-Docker tooling `44 / 44`,
  reliability `374 / 374`, root lint/build, security scans across `497` files, and zero
  dependency vulnerabilities. The complete slice is published as commit
  `e9f63038a5e8fe0c0680dcc015566dff2525a56b`; CI run `29116192805` and E2E run
  `29116192729` both completed successfully for that exact SHA, with the latter
  passing `96 / 96` Playwright tests in `3.2m`. Release-promotion and deployed
  browser proof remain separate P0-09/launch gates.
- **P0-06 deadline calendar and recurrence integrity - `CI_VERIFIED`.**
  Strict civil-date helpers replace JavaScript month overflow and cover every
  month-end class, leap years, Europe/Dublin DST boundaries, Irish public
  holidays, and Companies Act working-day adjustment. Generated deadlines now
  carry source/input fingerprints, stable rule identity, versions, provenance,
  supersession links, and immutable history; changed inputs create a new
  incomplete successor and revoked confirmations remove the current occurrence
  without deleting history. Company/CRO rules require explicit confirmed facts,
  while contradictions, impossible chronology, future actual events, and unsafe
  date ranges fail closed. Manual due-date/reopen changes advance reminder
  schedule identity, generated occurrences allow only one-way atomic completion,
  and reminder history stores immutable occurrence snapshots. Generated
  completion now requires an explicit irreversible confirmation, current lists
  traverse every API page, and organisation/manual-deadline writes reject stale
  `updatedAt` versions rather than overwriting newer governance facts. The scheduler
  pages all current eligible rows, sends separately to every verified owner,
  revalidates recipient/subscription/occurrence under a proven lock order,
  expires stale pre-I/O reservations atomically, marks `SENDING` before provider
  I/O, and quarantines every crash, timeout, 409, 5xx, malformed, boolean, or
  unknown provider outcome as `UNCERTAIN`. Acceptance-confirmed and
  unknown-acknowledged reconciliation remain dedupe suppressors; only immutable
  proof that the provider never accepted/created the original message permits a
  fresh token/key. The scheduler awaits active work during bounded shutdown, and
  deploy releases residual reservations, quarantines residual provider I/O, and
  blocks startup on unresolved ambiguity. The migration conservatively
  quarantines all legacy reminder states without fabricating provider/timing
  evidence, preserves exact annual-report id/completion/log identity, and fails
  closed on range, tenant, generated-row, AGM-evidence, duplicate, and id-collision
  ambiguity. A real PostgreSQL historical-upgrade fixture exercises eleven
  fail-closed scenarios in CI and release-image publication. Full API/web/shared
  suites are green (`545 / 545`, `313 / 313`, `35 / 35`), Prisma validates, and a
  disposable PostgreSQL 16 proof passed fresh/upgrade migrations, constraint and
  concurrency probes. A non-UTC (`America/Los_Angeles`) live application-path
  probe also proves the fixed civil-date claim binds and snapshots
  `2030-01-15` unchanged. Root lint/build, production tooling `544 / 544`,
  local-Docker contracts `44 / 44`, E2E safety contracts `113 / 113`, security
  scans across `545` staged files, zero-vulnerability dependency audits, generated-audit currency, and
  reliability linkage `396 / 396` is green. A focused managed browser run
  passed the Organisation contrast and migrated-profile save regressions, then
  the complete managed gate passed `113 / 113` isolation contracts and `97 / 97`
  Playwright tests with verified teardown. The complete implementation landed in
  `8474ab1d8b44e016f4782bf5c99302509cbd692f`; final verification SHA
  `096619cf3ee84ae7d3f62826b3510af388defd85` passed GitHub CI run
  `29136095002` and managed E2E run `29136095004`, with the latter reporting
  `97 / 97` ordinary passes in `3.2m` and no flaky tests. Professional rule
  review remains external launch evidence.
- **P0-07 team lifecycle, session families, billing-authority interlocks, and
  authenticated document delivery - `CI_VERIFIED`.** Team members now
  have explicit lifecycle state, optimistic versions, suspend/remove/reactivate
  operations, bounded session-family inventory and revocation, immutable audit
  subject snapshots, exact-one-owner database protection, serializable ownership
  transfer, and a restricted dry-run-first recovery job. Invitation acceptance
  transactionally rechecks lifecycle and subscription access. Refresh/replay/
  logout use ordered family locks so a successor cannot survive a logout race
  and unrelated device families are not over-revoked. Durable Checkout/Portal
  authority grants prevent ownership changes while provider capability is
  unresolved, and provider-start ambiguity cannot be request-locally released.
  Documents are delivered as authenticated API-proxied bytes with post-storage
  session revalidation, bounded I/O, exact storage-path enforcement, and no
  provider URL or object key in the browser. Local evidence is API `658 / 658`,
  web `335 / 335`, shared `40 / 40`, production tooling `545 / 545`, local-Docker
  tooling `44 / 44`, reliability `395 / 395` covered links across `415`
  guarantees, web lint, Prisma validation, and security scans across `576`
  files. The live PostgreSQL upgrade fixture passed lifecycle, owner,
  session-family, tenant, immutable-audit, and fail-closed rollback probes.
  Managed proof passed `113 / 113` isolation contracts, all `18`
  migrations, the real logout-vs-refresh race, the Team/Billing scenarios, and
  a fresh production-build document upload/download journey, with exact
  zero-residue teardown. Implementation commit
  `6fb1bdd29bb862dd43558d4fc09bc7c03f5d68a8` plus CI-repair commit
  `1970995d00d8981f0a0d352ac535f092b4e3b51e` passed exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29146063800`
  and managed E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29146063808`;
  E2E passed `113 / 113` isolation contracts and `103 / 103` Playwright
  scenarios in `3.4m`.
- **P0-08 role authorization and current processing/cookie truth - overall
  `IN_PROGRESS`; completed repository sub-slices `CI_VERIFIED`.** Members now
  have truthful read-only governance affordances across Team, Board, Documents,
  Compliance, Dashboard, Registers, Deadlines, Organisation, and Export while
  retaining legitimate reads, navigation, authenticated document download, and
  export access. Exact stale-role `403`/`FORBIDDEN` responses fail closed without
  redirecting and restore persisted or canonical state where needed. The privacy
  draft now matches PostgreSQL/Prisma, custom authentication, private Supabase
  object storage, stored Stripe state, and implemented Resend messages; the cookie
  UI is a necessary-cookie information notice backed only by local
  acknowledgement. Local proof passed web `351 / 351`, API `662 / 662`, shared
  `40 / 40`, production tooling `546 / 546`, local-Docker tooling `44 / 44`,
  production web build, lint, E2E typecheck, `113 / 113` isolation contracts, and
  `3 / 3` focused plus `105 / 105` complete managed browser scenarios with
  verified teardown and no flaky retry. Implementation commit
  `44ff57b596b0ac6b527a3f338bddc71a095ca2cc` plus final verification/repair SHA
  `42888a41e86bd7235891e82a18623208b921d773` passed exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150323690`
  and E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150323669`;
  E2E passed `113 / 113` contracts and `105 / 105` scenarios in `3.5m`. P0-08
  remains open for trial/plan behavior, deletion and retention workflows, VAT
  treatment, controller/legal-basis/rights/provider/contact decisions,
  operational mailboxes, and professional legal, privacy, and accounting approval.
- **P0-09 executed browser assurance and release protections - overall
  `IN_PROGRESS`; repository-only gate/truth sub-slice `CI_VERIFIED`.** The
  Release Images workflow now calls the reusable managed E2E workflow and makes
  publication depend on its success. The called browser job is read-only;
  package and OIDC write authority is scoped only to the dependent publish job.
  The reliability report and generated ledger now distinguish static E2E-title
  linkage from execution, print `EXECUTED E2E: NOT VERIFIED BY THIS COMMAND`, and
  use `LINKAGE CHECK: COMPLETE` instead of an overall browser `GREEN`. Local
  proof passed production tooling `548 / 548`, API reliability `660 / 660`, web
  reliability `351 / 351`, and `395 / 395` covered-guarantee linkage. Exact-SHA
  CI run `29151170819` and E2E run `29151170810` passed implementation commit
  `62170e55ac3bafe6f7cdd105eace11faaeba5d2c`; E2E passed `113 / 113` contracts
  and `105 / 105` scenarios in `3.5m`. Live branch/ruleset and
  Production-environment protections plus a controlled release run remain
  repository-owner/external work; no GitHub setting was changed and no release
  was triggered merely to test the workflow.
- **P0-10 metadata plus document-byte recovery - overall `IN_PROGRESS`;
  repository proof tooling `CI_VERIFIED`.** The repository now captures a
  source-bound PostgreSQL identity and proves an unchanged dump in an isolated,
  source-environment-matched restore target. A separate owner-only manifest
  generator/verifier reconciles complete document metadata, deletion/recovery
  history, and object bytes by exact key, size, and SHA-256, with bounded
  inventories and no sampling. Launch evidence requires the database and object
  proofs to share the recovery set and dump digest without equating their
  different identity domains. Local proof passed the root gate, API `706 / 706`
  plus isolated live migration `1 / 1`, web `351 / 351`, production tooling
  `746` passed / `0` failed / `2` Windows skips (`748` total), local-Docker
  `44 / 44`, and secret/SAST scans across `597` files. Final SHA
  `0c5b795ec2cbc906a119f7ffd52bd552519d232c` passed exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29163982047`
  and managed E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29163982033`.
  Real production database/object backups, RPO/RTO, retention, monitoring,
  operator evidence, and a non-production joint provider restore remain genuine
  external launch gates.
- **P1-04 document-deletion retry lifecycle - `CI_VERIFIED`.** The bounded
  retry/dead-letter/operator-recovery implementation through
  `8c573e3d0ea3729293201b32e14bafc7d4365ae0` is now reverified by final SHA
  `0c5b795ec2cbc906a119f7ffd52bd552519d232c`. The expanded scheduled-cleanup
  smoke assertion and isolated live-migration test phase passed CI run
  `29163982047`; managed E2E run `29163982033` also passed.
- **P1-09 domain invariants and referential safety - `CI_VERIFIED`.**
  Shared/API/web complete-state validation now prevents reversed
  board terms, contradictory trustee evidence, reversed closed fundraising
  periods, and filed reports without filing dates. Organisation-first locks,
  tenant-scoped composite conflict pointers, transactional history-preserving
  board deletion, five database checks, and narrow Prisma race mapping make the
  same invariants durable. The atomic migration never rewrites governance data
  and ships with a historical failure/remediation/recovery verifier. At this
  checkpoint, production recovery required the P1-09 compatibility line, an
  exact env/image-bound attestation, all 20 checksums captured inside the
  selected digest-pinned image, exact failed history/catalog/data state,
  terminal read-only SQL whose errors cannot be masked, exact resolution, and
  immediate full redeploy. Local proof
  is shared `54 / 54`, API `749 / 749` plus live concurrency `2 / 2`, web
  `369 / 369`, production tooling `791` pass / `0` fail / `2` platform skips,
  personal-server `21 / 21`, local-Docker `44 / 44`,
  lint/build/Prisma/security gates, and a real built-image
  tamper-negative/pristine-positive recovery with an identical before/after
  database fingerprint and zero residue. Implementation commit
  `c71481791b6716a06818c341d130fe25d7f32b7b`, the adjacent Windows fixture
  repair `3aba948962cbacf075d018564385acf972cb7dc5`, and the evidence refresh form
  exact verification SHA `812b9ff83e0407146e50a2dd0e87fea05561addb`.
  GitHub CI run `29168177797` and managed E2E run `29168177757` passed for that
  SHA; E2E passed `113 / 113` runner contracts and `105 / 105` browser scenarios
  in `3.6m`.
- **P1-07A password-recovery integrity - `CI_VERIFIED`.** Password recovery now uses a bounded
  durable request ledger, database-backed keyed identifier/network budgets,
  concurrent-link-safe delivery, a durable versioned Resend worker, atomic
  password/request/session/audit/outbox completion, and a registered-address
  post-reset notice. The recovery root secret is protected by a database
  generation fence, append-only retired-fingerprint history, and a quiesced
  invalidate-before-replace rotation workflow. Migration
  `20260712013000_add_password_recovery_integrity` preserves valid active legacy
  slots exactly once, clears inactive legacy slots without inventing recovery
  evidence, fails closed on active account emails that exceed the durable
  recipient bound, and retires both legacy `User` fields. Current ordinary deploys use
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1`; P1-09 is now
  a restore-only rollback boundary requiring an exact pre-P1-07A backup and the
  checksum-bound, read-only restored-history/P1-07A-absence probe before backup
  or migration. Final local evidence is shared `55 / 55`, API `810 / 810` plus four
  isolated real-PostgreSQL proofs `4 / 4`, web `371 / 371`, production tooling
  `827` passed / `0` failed / `2` expected Windows symbolic-link privilege skips
  (`829` total), personal-server `24 / 24`, local-Docker `45 / 45`, and the final
  local managed disposable E2E gate: runner contracts `113 / 113` plus browser
  scenarios `105 / 105` in `7.6m`, followed by clean isolated teardown. Lint,
  E2E typecheck, Prisma,
  optimized builds, security/dependency, reliability `395 / 395`, historical
  migration, built-image recovery, rollback, and launch-evidence gates also
  passed. Implementation commit
  `1e639c89b49ce5ed27a8ea3b887ef140c7f142b5` first reached CI run
  `29184769464`, which failed only at the fresh scheduled-job image smoke's
  recovery binding; companion managed E2E run `29184769502` passed. The
  follow-up repaired CI/release setup, and a local built-image replay passed
  `migrate -> bind -> scheduler` with zero residue. Exact final verification SHA
  `b2138acfe0b7b7a9127a14667f10a771982a0e3b` then passed CI run
  `29185333589` in `8m24s`, including the repaired scheduled-job image smoke,
  and managed E2E run `29185333588` in `6m41s` with `105 / 105` browser
  scenarios. This is repository publication evidence, not deployment,
  production-provider, legal, or human-policy evidence.
  Parent item P1-07 remains open for MFA, breached-password policy, and the
  remaining reviewed account/ownership-recovery policy.

The retained 2026-07-11 stashed working snapshot predated these later P0-10,
P1-04, P1-09, and P1-07A checkpoints. Its historical production-tooling count
corrections remain in the verification chronology below; this newer security
and recovery evidence remains authoritative for the 2026-07-12 handoff.

P0-03 is not live-provider proof. Before production enablement, the billing
owner must inventory and reconcile Stripe customer/subscription history,
confirm at most one non-terminal subscription per organisation/customer,
expire every legacy open subscription-mode Checkout session created before the
attempt-bound release, prove the exact pinned portal/price/product/cancellation
policy, and exercise purchase, duplicate-click, portal change, cancellation,
terminal restart, and webhook retry/order against the promoted release. Keep
that redacted evidence outside Git.

## Project

- Workspace: `C:\platforms\htdocs\CharityPilot`
- Canonical GitHub repository: `https://github.com/jasperfordesq-ai/charity-governance`
- Default branch: `master`
- Branch policy from the user: work on `master`; do not create feature branches unless explicitly told otherwise.
- Commit policy: commit and push completed work to `origin/master` in small verified increments.

## Current Launch State

Run this first in a fresh session:

```powershell
git status --short --branch
npm run launch:status -- --json
npm run audit:platform:check
node scripts/platform-completion-audit.mjs --json
```

Local personal-use safety before heavy work:

- `npm run personal:ready` is the non-destructive local confidence gate for one-person use on this computer without Stripe, payments, public hosting, or production providers.
- It checks local Docker boot/login/document storage, PostgreSQL backup and restore verification, local document-storage backup, and a personal browser smoke with billing safely disabled when Stripe is absent.
- `npm run test:e2e` owns a separate disposable stack and refuses ambient or
  personal database targets. Do not bypass that runner with direct Playwright or
  weaken its identity checks; the suite intentionally resets only its proven
  disposable tenant/app tables.
- This local safety gate does not replace production provider, deployed HTTPS, legal, pentest, backup/restore, or final signoff evidence.

### Compiled one-charity personal server profiles

The user's immediate operating goal is explicitly separate from the public SaaS
launch: run CharityPilot for one charity on a trusted Windows host or a
supervised x86-64 Linux VM, with optional private access for named directors,
while retaining the existing multi-organisation/provider/public-production work
for a later commercial deployment.

The implemented front door is **Caddy**. Windows uses Docker Desktop/WSL 2;
Linux uses the local native Docker Unix socket. Both run Caddy, the compiled
Next.js server, the compiled Fastify API, PostgreSQL and the document volume.
Caddy alone publishes
`127.0.0.1:8080`, routes `/api/v1/*` to Fastify and all other paths to Next.js.
There is no IIS dependency, no API/database host port, no source bind mount and
no development watcher in this profile. Tailscale Serve may terminate private
HTTPS and proxy to that loopback Caddy port; Funnel and router forwarding are
out of scope/prohibited.

Source-of-truth files:

- `docs/personal-server-deployment.md` - complete Windows/Tailscale/accounts/
  lifecycle/backup/recovery/security/VM-migration runbook;
- `docs/personal-server-deployment-linux.md` - supervised Linux installation,
  security, operation and outstanding live-acceptance contract;
- `compose.personal-server.yml` and `caddy/Caddyfile.personal-server` - isolated
  compiled runtime;
- `.env.personal-server.example` - non-secret field contract; the generated
  `.env.personal-server` is Git-ignored;
- `scripts/Install-CharityPilot.ps1` and `scripts/Install-CharityPilot.sh` -
  host-specific first-install entry points within their documented support
  boundaries;
- `scripts/personal-server.mjs` - internal/shared lifecycle for start, status,
  stop, backup, recovery, account reset and guarded maintenance operations;
- API `personal-server` env/initializer/account utilities - fail-closed private
  startup, empty-database one-charity initialization, manual invitation and
  hash-only one-hour reset links; and
- `AGENTS.md`, `README.md`, and the architecture map - permanent discovery
  pointers and the answer to which web server is used.

Safety invariants:

- routine `start` never builds, migrates or seeds;
- initialization creates one blank organisation, one verified Owner, an active
  Complete entitlement and governance reference data, and refuses nonempty
  Organisation/User state;
- the Owner password and plaintext invitation/reset capabilities are transient
  and are never persisted to `.env.personal-server`; the independent
  `AUTH_RECOVERY_SECRET` root is deliberately persisted only in that ignored,
  operator-protected env file and must be rotated through the documented
  invalidate-before-replace workflow;
- registration and provider-backed email recovery fail closed; directors use
  Owner/Admin-created fragment invitation links and host-issued fragment reset
  links;
- billing UI/public signup are hidden or redirected and provider jobs remain
  disabled, while the strict public-production validator is unchanged;
- the fixed Docker gateway/Caddy addresses form a narrow trusted-proxy chain;
  personal HTTPS refreshes, redirects and CSP use the validated configured
  origin rather than the plaintext internal hop;
- web and Caddy health checks probe the non-redirecting internal `/login` route,
  so they never attempt to follow `/` out to a Tailscale hostname;
- backups quiesce writers, restore-verify PostgreSQL, archive the matching
  document volume, hash both artifacts and restore the prior service state; and
- normal stop/update commands never delete the personal database or document
  volumes.

Original personal-server implementation checkpoint evidence from 2026-07-11:

- API `726 / 726` passed;
- web `363 / 363` passed;
- personal wrapper/Compose contracts `21 / 21` passed;
- default, `personal-init`, and `maintenance` Compose renders passed;
- lint passed; and
- wrapper secret/SAST scans passed across 597 files; and
- the full production-tooling gate passed `746`, failed `0`, with `2`
  Windows-only symbolic-link privilege skips (`748` total).

The first exact push, `0587f637d3b8511127f16e9a0184f05c7291b39b`, reached
CI run `29165538508`. Security, schema, legacy upgrades, migrations,
backup/restore and lint passed, then the API test process exposed that two new
test files had relied on an ambient local `JWT_SECRET` at module import time.
No application assertion failed. The tests were changed to set a test-only
secret before dynamically importing the JWT-dependent modules, matching the
existing route-reliability pattern. A full API rerun with `JWT_SECRET`
deliberately removed then passed `725 / 725` ordinary tests plus the isolated
real-PostgreSQL migration test (`726 / 726` total). The follow-up push/CI result
must be treated as the exact-commit publication proof.

Both public and personal-server native optimized web builds passed. Docker
exported the personal migration and API runner images. A separate web-only
Docker build returned no compile error but did not export its image within a
15-minute bound on the already heavily loaded Docker Desktop daemon. Its
orphaned compose client was stopped, Docker's long-lived service was preserved,
and read-only inspection confirmed no personal containers, volumes or network.
The installer was then changed to build `migrate`, `api` and `web` sequentially;
its 21 safety contracts remained green. Do not describe the personal profile as
live-certified until the web image and real initialization complete.
An attempted `caddy:2-alpine` pull for binary Caddyfile validation failed at the
registry blob download with `EOF`; no Caddy container remained. Static
Caddy/trusted-proxy contracts and all Compose renders passed, but real binary
validation therefore remains part of first initialization.

No real `.env.personal-server`, Owner account, personal data, private Tailscale
route or live personal-server container was created during this implementation.
Before entering real records, initialize from a reviewed clean checkout, run a
real second-device access check, create an encrypted off-host recovery set and
complete the acceptance checklist in the runbook. A private-profile success is
not public-production launch evidence and closes none of the external/provider,
legal, pentest, recovery or final-signoff gates below.

The updater creates a verified pre-update database/document set, but its v1
manifest does not retain old application images or automate destructive schema
rollback. A migration/start failure may intentionally leave writers stopped.
Record the compatible commit/image identity and rehearse the runbook's deliberate
restore procedure before treating updates as production-grade.

Known launch state refreshed on 2026-07-12 from the checked workstation,
current GitHub metadata, and the expanded 89-check evidence schema:

- Phase: `ENV_INCOMPLETE`
- `.env.production` exists but still has 18 counted values needing real
  production data. It also predates P1-07A and lacks the separately required
  `AUTH_RECOVERY_SECRET` and
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1`.
- Production values complete: `9 / 27`.
- Launch evidence ledger exists at `.charitypilot-launch-evidence/production-launch-evidence.json`.
- Machine-readable launch evidence completion: `9 / 89`.
- Strict counted launch gates: `18 / 121` complete (`14.9%`), counting only production values, launch evidence checks, and final signoff roles.
- `approvedForLaunch`: `false`
- Final signoffs approved: `0 / 5`
- Real charity data remains blocked.
- Full-platform audit baseline captured on 2026-07-10 at
  `8809bac3a897afe6078df82142097c3fcc924e8f`; the remediation score was
  `669 / 1000`, while the strict launch-gate score remained `18 / 117`.
- GitHub CI for that audit baseline passed:
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29068890047`.
- Earlier verified release-gate hardening checkpoint preserved by this handoff:
  `cb78eb85bb0127150ad448037b5d03b8060869bf`.
- GitHub CI for that commit passed:
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29021018683`.
- The final P1-07A local production-tooling gate captured by this handoff passed
  on 2026-07-12 with `827` checks passed, `0` failed, and `2` expected Windows
  symbolic-link privilege skips (`829` total). The final local managed
  disposable E2E gate also passed `113 / 113` runner contracts and `105 / 105`
  browser scenarios in `7.6m` with clean isolated teardown. Exact-pushed-SHA
  publication is now complete: implementation commit
  `1e639c89b49ce5ed27a8ea3b887ef140c7f142b5` and final verification SHA
  `b2138acfe0b7b7a9127a14667f10a771982a0e3b`; CI run `29185333589` passed in
  `8m24s` and managed E2E run `29185333588` passed in `6m41s` with `105 / 105`
  browser scenarios. This closes P1-07A repository publication only.
- The preceding local production-tooling checkpoint retained from the stashed
  working snapshot was:
  `npm run test:production-check` passed on 2026-07-11 with `746` checks
  passed, `0` failed, and `2` Windows-only symbolic-link privilege skips (`748`
  total). Older `823`, `791`,
  `746`, `745`, `548 / 548`, `546 / 546`, `545 / 545`, `544 / 544`, `494 / 494`, `488 / 488`, `396 / 396`, `352 / 352`,
  `338 / 338`, and `339 / 339` entries in the verification chronology below are historical
  counts from earlier commits, not the current gate size.
- This handoff may be committed by a later docs-only refresh commit. Treat
  `npm run launch:status -- --json` and its `repositoryState.headSha` as the
  live source of truth for the current checkout before collecting evidence.
- The generated platform audit intentionally keeps repository clean/synced state
  live-only; run `npm run launch:status -- --json` and inspect
  `repositoryState` from the release checkout before collecting launch evidence.
- Fresh public DNS/HTTPS spot check on 2026-07-12 found both canonical
  production hosts unresolved from this workstation:
  `app.charitypilot.ie` and `api.charitypilot.ie`.
- GitHub `production` environment variables currently include
  `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`. That is the only public
  provider origin required by the web image; Supabase remains API/server-only.
  The non-secret `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST` variable is
  now also required by the GitHub environment preflight and remains missing until
  the real managed PostgreSQL hostname is selected.
- `npm run check:production:github-env -- --environment=production` now verifies
  the release-image GitHub environment without reading secret values. Rerun it
  before promotion; the obsolete public Supabase variable is no longer a gate.
- `npm run check:production:github-secrets -- --environment=production` now
  verifies required GitHub `production` secret names without reading secret
  values when GitHub is the approved deployment secret store.
- GitHub `production` environment secrets currently include only the generated
  non-provider entries `JWT_SECRET` and `READINESS_API_KEY`. The live metadata
  refresh on 2026-07-12 therefore lacks seven required names:
  `AUTH_RECOVERY_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `ERROR_ALERT_WEBHOOK_URL`.
- `master` remains unprotected. The GitHub `production` environment permits
  administrator bypass and has no protection rules or deployment branch policy.
  The active immutable personal-release tag ruleset is separate and does not
  satisfy the public-production branch/environment gate.

The 18 missing production values are:

- `TRUSTED_PROXY_ADDRESSES`
- `DATABASE_URL`
- `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID`
- `STRIPE_ESSENTIALS_YEARLY_PRICE_ID`
- `STRIPE_COMPLETE_MONTHLY_PRICE_ID`
- `STRIPE_COMPLETE_YEARLY_PRICE_ID`
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`
- `RESEND_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ERROR_ALERT_WEBHOOK_URL`
- `CHARITYPILOT_API_IMAGE`
- `CHARITYPILOT_WEB_IMAGE`
- `CHARITYPILOT_MIGRATION_IMAGE`

For release image promotion, `npm run launch:status` now also exposes the
GitHub `production` environment variables required before `gh workflow run
release-images.yml --ref master` can produce the `release-image-digests.env`
artifact:

- `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`
- `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST=<managed-postgres-hostname>`

Validate those non-secret GitHub `production` environment variables before
running the image workflow:

```powershell
npm run check:production:github-env -- --environment=production
```

## Non-Negotiable Product Posture

Do not claim CharityPilot is legally guaranteed, "100% legally bombproof", or a substitute for legal advice.

Correct posture:

- review-ready;
- source-cited;
- evidence-led;
- difficult to misuse;
- clear that solicitor, governance, privacy, accounting, safeguarding, employment, and other professional review may be required.

## What Has Been Achieved

### UI/UX and Product Surface

- Full UI/UX revamp has been carried across the main P0 flows:
  - marketing;
  - auth;
  - dashboard;
  - compliance overview;
  - compliance principle detail;
  - documents;
  - deadlines;
  - board;
  - registers;
  - regulator;
  - organisation;
  - team;
  - billing;
  - export;
  - loading, error, empty, disabled, and not-found states.
- Light and dark mode support is present across the app.
- Route files have been decomposed: no route page remains over 450 lines according to the platform audit.
- P0 dashboard routes now use extracted panels, workflow hooks, and shared primitives rather than large monolithic route files.
- Shared UI primitives are in place for:
  - loading states;
  - empty states;
  - error states;
  - locked-feature states;
  - review warnings;
  - inline status;
  - save status;
  - source references;
  - file upload;
  - form alerts;
  - action buttons.
- HeroUI controls are now used for key binary/choice/input surfaces:
  - switches;
  - checkboxes;
  - radio groups;
  - buttons;
  - inputs;
  - file upload.
- Lucide icons have replaced route-local inline SVGs across the main route chrome and key actions.
- Pricing page metadata is ASCII-safe and pricing feature/comparison icons use `lucide-react` directly.
- Marketing blog search uses the shared empty-state primitive for no-result filters; marketing landing signal tiles use shared status panel styling; dashboard annual regulator summary, summary cards, progress cards, deadline lists, and board-alert cards use shared status panel styling; compliance overview summary, principle cards, and detail standard editor cards use shared status panel styling; compliance standard autosave, organisation profile saving, governance register saving, document vault mutations, export board sign-off, and board/deadline/team mutations use the shared save-status primitive; export controls and board-approval panels use shared status panel styling; billing checkout and portal handoffs use shared visible status; billing current-plan summary and plan prices use shared/flat panel treatment instead of nested route-local cards; team permission-denied messages use shared permission hints instead of route-local hidden or bespoke status markup.
- Dashboard mobile navigation has explicit ARIA controls, Escape handling, focus recovery, and focus trapping.
- Breadcrumbs and principle labels are source-backed and meaningful.

### Compliance and Legal-Readiness Model

- Irish compliance source metadata was refreshed against official sources on 2026-07-09.
- The matrix includes source metadata, last-checked dates, professional-review flags, and commencement status.
- The product includes explicit not-yet-commenced monitoring rows for relevant Charities (Amendment) Act 2024 provisions.
- Conditional obligation profile facts were added for:
  - staff/workers;
  - volunteers;
  - public fundraising;
  - child-facing services/safeguarding;
  - personal-data processing/GDPR;
  - premises/events;
  - public-sector context;
  - processors.
- Conditional obligation prompts now surface through documents, deadlines, registers, regulator, export, and organisation workflows.
- Export readiness is broader than missing explanations:
  - missing standard records;
  - missing actions;
  - missing evidence;
  - missing explanations;
  - missing conditional-profile facts;
  - profile-triggered professional-review prompts.
- API-rendered exports include:
  - source/professional-review appendix;
  - not-legal-advice/non-certificate disclaimer;
  - source counts;
  - professional-review flags;
  - not-yet-commenced monitoring metadata.

### Backend, Security, and Reliability

- Tenant isolation, auth/session guards, role guards, plan gates, validation, redaction, document privacy, and billing degradation are covered by tests and tooling.
- Browser auth moved away from localStorage and into HTTP-only cookies.
- Refresh sessions are hashed, revocable, and rotating.
- Password reset and verification tokens are hashed before storage.
- Logout and server-side refresh revocation exist.
- Identifier-aware throttles exist for:
  - email;
  - reset/verify token;
  - refresh token;
  - bearer/access-cookie credentials.
- Stripe customer reconciliation was added:
  - organisation-scoped idempotency key;
  - metadata verification before checkout/portal reuse;
  - stale or wrong-organisation IDs repaired through metadata reconciliation.
- Duplicate-subscription prevention now adds a serializable
  `BillingCheckoutAttempt` lease, customer-wide provider subscription checks,
  attempt-bound webhook validation, authoritative Stripe re-retrieval, exact
  price/interval/quantity enforcement, and a pinned safe portal policy. Checkout
  is restricted to first purchase or provider-confirmed terminal restart;
  Stripe-managed changes are portal-only.
- Document storage paths include UUIDs to avoid same-millisecond filename collisions.
- Document file privacy is preserved through private storage and authenticated API-proxy downloads with post-read session revalidation; storage capabilities never reach the browser.
- Document metadata responses do not expose internal storage object keys.
- Production error handling redacts sensitive values.
- Alert webhook and production checker transcript redaction is in place.
- Backup/restore helper transcript redaction is in place.

### Production and Launch Tooling

- Canonical production origins are aligned:
  - web: `https://app.charitypilot.ie`
  - API: `https://api.charitypilot.ie`
- Production deploy defaults include `compose.production.yml` plus `compose.production-tls.yml`.
- A `--no-tls-proxy` escape hatch exists for managed platform TLS.
- Caddy/TLS runbook, environment template, smoke checks, evidence validators, and release workflow all align around the canonical hostnames.
- Release workflow builds and publishes digest-pinned runtime/migration images.
- Deploy preflight validates digest-pinned images and web build-origin metadata.
- Production deploy and rollback scripts run preflight and public HTTPS smoke checks.
- Launch status output groups missing production values by source:
  - hosting/proxy;
  - PostgreSQL;
  - Stripe;
  - Resend;
  - Supabase;
  - observability;
  - release image promotion.
- Launch status has JSON output for operator dashboards and handoffs.
- Launch status exposes both read-only launch-evidence progress commands and strict launch-evidence validation commands, including JSON variants.
- Launch status exposes the deployed browser QA command set for responsive, accessibility, cross-browser, and iOS Safari evidence collection.
- Launch status exposes the full production check, provider, deploy, rollback, release-run evidence, and final evidence validation command sequence.
- Launch status exposes the final signoff role list, solicitor/governance/privacy review, external pentest, release binding, and review-ready legal posture.
- Launch status keeps the full source-grouped production value checklist visible after `.env.production` exists, while separately listing the currently missing values.
- Strict launch-evidence JSON validation includes the next incomplete checklist items and evidence hints so failing launch-gate output can drive operator work queues.
- Production launch evidence initializes outside the repo root in `.charitypilot-launch-evidence/`.
- Launch evidence status has read-only progress output and strict final validation.
- The platform audit generator records launch evidence state and falls back to direct `.git` metadata reads if shelling out to git is unavailable.
- Release E2E timeout handling is limited to the exact spawned child process
  tree, escalates a stuck POSIX child after a bounded grace period, and keeps
  signal handlers active while the runner tears down and verifies its exact
  pinned-daemon Compose project. It never scans for or stops unrelated Node/npm
  processes on a shared workstation; failed cleanup makes the gate red and
  retains the private recovery inputs.
- Release readiness child gates resolve `npm` and `npx` through explicit Node
  CLI entrypoints on Windows instead of shell execution, keeping launch
  evidence transcripts free of shell-argument deprecation warnings.
- Responsive/accessibility route QA now fails fast when protected-route
  navigation hits a 500, a Next.js/runtime overlay, a login redirect, or a
  browser JavaScript page error while resolving the compliance principle detail
  route. This keeps deployed/browser-QA evidence actionable instead of ending in
  a vague missing-selector timeout.

### Launch Evidence Hardening

The launch evidence model has been tightened substantially:

- Evidence references must use HTTPS URLs on approved hosts.
- Approved references are limited to `*.charitypilot.ie` or the canonical GitHub repository.
- GitHub evidence must point to `github.com/jasperfordesq-ai/charity-governance`.
- Signed URLs and token-bearing query strings are rejected.
- Evidence descriptions and references reject raw secret-looking values.
- Evidence file path errors are redacted.
- Pentest evidence must bind to the promoted `release.commitSha`.
- Deployed browser QA evidence must bind to the promoted `release.commitSha`.
- Final signoff evidence must bind to the promoted `release.commitSha`.
- Final signoff requires five roles:
  - engineering;
  - operations;
  - security;
  - legal/compliance;
  - business.
- Legal/compliance evidence must include solicitor/governance/privacy review.
- Browser QA evidence requires:
  - deployed responsive coverage;
  - deployed accessibility coverage;
  - cross-browser coverage;
  - real iOS Safari or cloud-device proof;
  - full route inventory across desktop/mobile and light/dark.
- Supabase evidence requires a private bucket, service-role upload/download and anonymous-denial proof, backup/PITR evidence, restore-test owner/date/recovery notes, an isolated restore target that is explicitly a non-production restore target, and confirmation that the production project was not overwritten.
- Billing/email evidence requires Stripe webhook event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.
- Evidence chronology now allows the package to be prepared before evidence is collected, while requiring every checklist evidence entry to be captured no later than `finalSignoff.approvedAt`.
- Deploy-smoke evidence hints now match the strict validator:

```powershell
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers
node scripts/smoke-production-deploy.mjs --production-env-file .env.production
Production deploy smoke passed
https://app.charitypilot.ie
https://api.charitypilot.ie
```

## Recent Verification Evidence

Recently successful checks in this workstream:

- P0-09 exact-SHA release-gate and reliability-truth verification
  - Release promotion structurally requires the reusable read-only managed E2E
    job before the write-enabled publishing job can start.
  - Production tooling passed `548 / 548`. The reliability command executed API
    `660 / 660` and web `351 / 351`, found `31` linked Playwright titles, and
    reported `395 / 395` linkage complete while explicitly declining to certify
    E2E execution.
  - Implementation SHA `62170e55ac3bafe6f7cdd105eace11faaeba5d2c` passed CI
    run `29151170819` and E2E run `29151170810`. CI passed root web `351 / 351`,
    API `662 / 662`, shared `40 / 40`, production tooling `548 / 548`, and
    local-Docker tooling `44 / 44`; E2E passed `113 / 113` contracts and
    `105 / 105` scenarios in `3.5m`.
  - A controlled release run and live repository protections remain
    repository-owner/external work.
- P0-08 role/privacy exact-SHA verification
  - Web `351 / 351`, API `662 / 662`, shared `40 / 40`, production tooling
    `546 / 546`, local-Docker tooling `44 / 44`, web lint/build, E2E typecheck,
    and security checks passed.
  - The focused managed run passed `113 / 113` isolation contracts and `3 / 3`
    Playwright scenarios in `54.5s`: real-member route traversal and authenticated
    document-byte download, live Admin-to-Member demotion with an exact API
    denial, and rendered privacy/cookie truth. Teardown left no managed E2E
    container residue.
  - The complete local managed gate passed `113 / 113` contracts and `105 / 105`
    browser scenarios without a flaky retry. Implementation SHA
    `44ff57b596b0ac6b527a3f338bddc71a095ca2cc` plus final repair/verification SHA
    `42888a41e86bd7235891e82a18623208b921d773` passed exact-SHA CI run
    `29150323690` and E2E run `29150323669`; the latter passed `113 / 113`
    contracts and `105 / 105` scenarios in `3.5m`.
  - Deterministic discovery/evidence SHA
    `2734dc167777765ceec297917940615f05770590` passed exact-SHA CI run
    `29150668596` and E2E run `29150668600`. The main CI `Test` step ran all web
    `351 / 351`, API `662 / 662`, and shared `40 / 40`; E2E passed `105 / 105`
    scenarios in `3.7m`.
- P0-07 exact-SHA verification
  - Full suites passed on 2026-07-11: API `658 / 658`, web `335 / 335`, and
    shared `40 / 40`.
  - Production tooling passed `545 / 545`; local-Docker tooling passed
    `44 / 44`; Prisma validation, web lint, and secret/SAST scans across `576`
    files passed.
  - The live P0-07 PostgreSQL upgrade fixture passed lifecycle, owner,
    session-family, tenant, immutable-audit, and atomic rollback probes.
  - The regenerated reliability ledger has `415` guarantees, `395 / 395`
    complete links, and `20` explicit not-applicable rows; exact-SHA E2E is the
    separate browser-execution evidence.
  - Focused managed proof passed the concurrent logout-vs-refresh invariant;
    a fresh current-tree document run passed `113 / 113` isolation contracts,
    the production build, all `18` migrations, and upload/download `1 / 1` in
    Playwright. Both runs proved exact zero-residue teardown.
  - Implementation commit `6fb1bdd29bb862dd43558d4fc09bc7c03f5d68a8`
    plus verification/fix commit `1970995d00d8981f0a0d352ac535f092b4e3b51e`
    passed exact-SHA CI run `29146063800` and E2E run `29146063808`; the
    latter passed `103 / 103` Playwright scenarios in `3.4m`.
- `npm run test:e2e`
  - Passed locally on 2026-07-10 for P0-06 with `113 / 113` isolation contracts
    and `97 / 97` live Playwright tests in `7.0m`; the cached production-image,
    attestation, readiness, test, and verified-teardown command took `11.6m`
    against the UUID-marked disposable PostgreSQL instance. A preceding focused
    managed run also passed the Organisation contrast, migrated-profile save,
    generated-completion, and repeated compliance-select regressions. Exact
    teardown left no runner Docker/private-state residue or personal-stack
    drift. Final SHA `096619cf3ee84ae7d3f62826b3510af388defd85`
    passed CI run `29136095002` and E2E run `29136095004`; the latter reported
    `97 / 97` ordinary passes in `3.2m` with no flaky tests.
- `npm test`
  - Passed on 2026-07-11 with API `545 / 545`, web `313 / 313`, shared
    `35 / 35`, production tooling `544 / 544`, and local-Docker tooling
    `44 / 44`.
- `npm run reliability:report -- --write`
  - Passed on 2026-07-11 with `396 / 396` covered guarantees linked to passing
    test titles. Static linkage alone is not browser execution; E2E runs
    `29116192729` and `29136095004` supply exact-SHA execution for P0-05 and
    P0-06 respectively. P0-09 remains open for
    release-promotion, deployed-browser, and live repository-protection proof.
- `npm run build`, `npm run security:scan`, and both dependency audits
  - Passed on 2026-07-10; all workspaces built, `545` staged files passed secret/SAST
    scans, and both audits reported zero vulnerabilities.
- `node --test apps/api/dist/tests/billing-subscription-integrity.test.js apps/api/dist/tests/billing-reliability.test.js apps/api/dist/tests/billing-reminders-hardening.test.js apps/api/dist/tests/idempotency-reliability.test.js`
  - Passed on 2026-07-10 with `50 / 50` focused P0-03 billing tests.
- `node --test scripts/check-production-providers.test.mjs`
  - Passed on 2026-07-10 with `13 / 13` provider-contract tests covering exact
    prices/product grouping, pinned portal policy, webhook events, and Resend
    domain verification.
- `npm test -w @charitypilot/web`
  - Passed on 2026-07-10 with `248 / 248` tests for the P0-03 checkpoint.
- `npm test -w @charitypilot/shared`
  - Passed on 2026-07-10 with `19 / 19` tests for the P0-03 checkpoint.
- `npm run lint -w @charitypilot/web` and `npm run build -w @charitypilot/web`
  - Passed on 2026-07-10 for the capability-driven billing UI and truthful copy.
- `npm test -w @charitypilot/api`
  - Passed on 2026-07-10 with `454 / 454` tests after all final P0-03 focused
    regressions were integrated.
- `npm run test:production-check`
  - Passed on 2026-07-10 with `488 / 488` production-tooling tests.
- `npm run reliability:report -- --write`
  - Passed on 2026-07-10 with API `454 / 454`, web `248 / 248`, and `365 / 365`
    covered-guarantee links resolved.
- `npm run audit:platform:check`
  - Passed on 2026-07-10; `docs/platform-completion-audit.md` is current.
- `gh run watch 29077589143 --exit-status`
  - Passed on 2026-07-10 for the complete P0-03 implementation and CI-repair
    chain through `7ffc8f862d863f559365668c19550be00d0bb382`.
- `gh run watch 29074651622 --exit-status`
  - Passed on 2026-07-10 for P0-02 commit `fbd5ce4`.
- `gh run watch 29073803773 --exit-status`
  - Passed on 2026-07-10 for P0-01 commit
    `97f64b0285eb2d19489c062cda52134fda8f9a53`.

- Historical direct responsive Playwright proof passed on 2026-07-09 after the
  compliance-detail resolver was hardened. Its old boolean reset command is
  intentionally omitted and retired; repeat only through `npm run test:e2e` or
  the managed focused responsive scripts.
- `node --test scripts/check-local-docker.test.mjs`
  - Passed on 2026-07-09 with 38/38 local Docker and browser-QA wiring checks.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 352/352 production-tooling checks during the
    latest handoff refresh.
  - Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).
- `npm run audit:platform:check`
  - Passed on 2026-07-09 after the same browser-QA diagnostic hardening.
- `node scripts/platform-completion-audit.mjs --json`
  - Read-only machine-readable audit output for route, backend, launch,
    compliance, and next-action handoff automation; it must not rewrite
    `docs/platform-completion-audit.md`.
- `gh run watch 29021018683 --exit-status`
  - Passed on 2026-07-09 for commit `cb78eb8`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after no-shell release gate execution hardening.
- `gh run watch 29020485769 --exit-status`
  - Passed on 2026-07-09 for commit `11b0f5b`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after repo-scoped failed E2E cleanup hardening.
- `gh run watch 29012705817 --exit-status`
  - Passed on 2026-07-09 for commit `0d29887`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after release-ready stack reachability timeout hardening.
- `gh run watch 29010531551 --exit-status`
  - Passed on 2026-07-09 for commit `7c182f3`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after the live-only platform-audit repository-state
    hardening.
- `gh run watch 29001831333 --exit-status`
  - Passed on 2026-07-09 for commit `786d7ff`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, and dependency audit.
- `npm run test -w @charitypilot/web`
  - Passed on 2026-07-09 with 232 web tests after compliance navigation
    confirmation copy/timer-guard hardening.
- Historical direct compliance Playwright proof passed on 2026-07-09 with both
  journeys green. Its direct reset invocation is retired; repeat with
  `npm run test:e2e -- tests/compliance.spec.ts` through the isolated runner.
- `npm run lint -w @charitypilot/web`
  - Passed on 2026-07-09 after the same changes.
- `npm run build -w @charitypilot/web`
  - Passed on 2026-07-09 after the same changes.
- `npm run audit:platform:check`
  - Passed on 2026-07-09 after the same changes.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 338/338 production-tooling checks passing after
    the same changes and the GitHub production environment evidence gate.
    Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).

- `npm test -w @charitypilot/web`
  - 220 web tests passed after public attribution, shared auth status icons, and shared auth loading-state polish.
- `npm run lint -w @charitypilot/web`
  - Passed after the same auth/public trust-surface work.
- `npm run release:ready`
  - Passed on 2026-07-09 at commit `cf683f1` in the latest full local release-gate run recorded by this handoff.
  - Security scan, lint, build, workspace tests, dependency audit, reliability ledger, and 95 Playwright E2E tests passed.
  - Final summary included `OVERALL: GREEN - repository release gates passed`.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 338/338 production-tooling checks passing.
  - Covers production validators, launch evidence validation, provider checker contracts, deployment tooling, backup/restore tooling, and CI/release workflow guards.
  - Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).
- `npm run lint -w @charitypilot/web`
  - Passed after the shared blog empty-state and compliance save-status primitive cleanup.
- `npm run build -w @charitypilot/web`
  - Passed after the same shared-state cleanup.
- `npm run test:production-check`
  - Passed again with 338/338 production-tooling checks after launch-evidence, release-ready, continuation-doc, and GitHub secret-store checker hardening.
  - Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).
- Focused launch-evidence tests
  - Passed after the evidence hardening updates.
- Web wiring tests
  - Passed after the pricing/icon polish.
- `npm run audit:platform`
  - Passed.
- `npm run launch:status -- --json`
  - Passed and still reports the real blockers.

Important limitation:

Local/repo checks do not prove production launch readiness. They must be rerun against the final production config and live HTTPS deployment.

## What Is Left To Do

### External Launch Blockers

These require human/operator/provider access and must not be faked:

1. Fill real production secrets/provider values in `.env.production` or an approved secret store.
2. Configure production hosting, DNS, TLS, reverse proxy, and public HTTPS smoke evidence.
3. Prove PostgreSQL production backup and restore before real charity data.
4. Prove Supabase production private bucket, authenticated service-role read/anonymous-denial behavior, backup, and restore.
5. Configure Stripe live products/prices/webhook.
6. Configure Resend sender domain and live email evidence.
7. Configure observability:
   - logs;
   - uptime checks;
   - readiness checks;
   - alert routing;
   - incident owner;
   - backup owner;
   - escalation path;
   - test alert.
8. Complete solicitor/governance/privacy review.
9. Complete external penetration test.
10. Remediate or formally accept pentest findings.
11. Complete deployed browser QA and accessibility checks.
12. Complete all 89 machine-readable launch evidence checks.
13. Complete final engineering, operations, security, legal/compliance, and business signoffs.

### Launch Evidence Still Open

The evidence ledger is currently `9 / 89`. Those completed checks are local/CI
release-gate basics only; they do not replace real production env validation,
digest-pinned deployment, public HTTPS smoke, rollback, provider, backup/restore,
deployed browser QA, legal, pentest, or final signoff evidence.

The first incomplete evidence checks currently reported by
`npm run launch:status -- --json` are:

- `releaseGate.check-production`
- `releaseGate.github-environment`
- `releaseGate.github-secret-store`
- `releaseGate.deploy-preflight`
- `releaseGate.deploy-production`
- `releaseGate.deploy-smoke`

Do not fill these with local or fake evidence. They need final real production
configuration, GitHub production environment, digest-pinned deployment, and
public HTTPS smoke evidence tied to the promoted release. Re-run launch status
before acting; this ordered list changes as evidence is completed.

### Deployed Browser QA Still Open

Local browser/accessibility checks have been run previously, but deployed production QA remains open.

Required deployed QA must cover:

- public/auth routes;
- dashboard routes;
- desktop;
- mobile;
- light mode;
- dark mode;
- auth flow;
- dashboard flow;
- billing flow;
- document upload;
- authenticated API download without a provider URL or object path;
- logout;
- error states;
- accessibility;
- cross-browser;
- real iOS Safari or cloud-device iOS Safari.

### Legal/Compliance Still Open

The product is review-ready but not legally signed off.

Still required:

- production privacy policy approval;
- terms/service agreement approval;
- retention policy approval;
- support/data deletion contact publication;
- named solicitor review;
- named governance review;
- named privacy review;
- review dates and evidence references outside git.

## Recommended Next Agent Workflow

1. Confirm the baseline:

```powershell
git status --short --branch
git log --oneline -5
npm run launch:status -- --json
```

2. If no real production/provider access is available, continue repo-side closure only:

- search for stale command drift;
- tighten validators;
- improve launch evidence clarity;
- strengthen runbooks;
- run focused tests;
- commit and push.

3. If production/provider access is available, work through this order:

```powershell
npm run check:production -- --production-env-file=.env.production
npm run check:production:github-env -- --environment=production
npm run check:production:github-secrets -- --environment=production
npm run check:production:hosting -- --production-env-file=.env.production
npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA
npm run check:production:database -- --production-env-file=.env.production --recovery-set-id=RECOVERY_SET_ID --expected-source-database-identity-sha256=EXTERNAL_SHA256 --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA --backup-output-dir=/mnt/encrypted/charitypilot/recovery/RECOVERY_SET_ID --keep-backup --json
npm run check:production:supabase -- --production-env-file=.env.production
npm run check:production:providers -- --production-env-file=.env.production
npm run check:production:observability -- --production-env-file=.env.production
npm run deploy:preflight -- --production-env-file=.env.production
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers
npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env --schema-compatibility-attestation-file=/secure/schema-compatibility-attestation.json --backup-output-dir=/secure/charitypilot/rollback-cutovers
npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
```

4. For deployed browser QA, use the commands and evidence slots in:

- `docs/production-browser-qa.md`
- `docs/production-launch-checklist.md`
- `.charitypilot-launch-evidence/production-launch-evidence.json`

5. Commit only repo changes. Do not commit:

- `.env.production`;
- real secrets;
- production launch evidence JSON;
- screenshots with sensitive data;
- pentest reports;
- legal review reports;
- provider credentials;
- backup dumps.

## Percentage Remaining

Strict launch evidence metric:

- `80 / 89` machine-readable launch checks remain.
- Strict counted launch gates are `18 / 121` complete, so `103 / 121`
  counted gates remain. This is an operator progress metric only, not a legal,
  security, operations, or business readiness certification.
- Strict launch evidence is still mostly incomplete because the remaining checks
  include the real production environment, deploy, rollback, provider,
  backup/restore, deployed QA, legal, pentest, and final signoff gates.
- Final signoffs remain `0 / 5`.
- Production values remain `9 / 27` complete, with 18 real provider/hosting/image-promotion values still missing.

Whole-goal estimate:

- Repo-side engineering and UI polish are substantially advanced.
- Actual production launch readiness is still dominated by external provider setup, deployed evidence, legal/privacy/governance review, external security review, backup/restore proof, and final signoffs.
- Evidence-based estimate: about 65-70% of the overall production-completion goal remains, even though the codebase itself is much further along.

Repo-side-only estimate:

- About 10-15% remains, mostly defects that may be discovered by live QA, security review, or production provider checks.

## Final Rule For Future Agents

Do not redefine success around passing local tests. CharityPilot is not launch-ready until the real production environment, live providers, deployed QA, legal/compliance review, external security review, backup/restore evidence, all 89 launch evidence checks, and all five final signoffs are complete and recorded.

### Latest source verification: recovery append optimization

The opt-in prefix optimization passed 2,469 API tests and four real PostgreSQL
migration tests locally. Its rollback regression refuses shortened known history
before a replacement write. It remains inactive and requires independent immutable
entry custody before use. Hosted CI 36744603266 and E2E 36744603344 passed for
preceding f94b03ffc5d66f910fefc4a7ad9f7fe600da355b only; do not attribute those runs
to the later optimization. The live release remains the documented d31ac597.

### Complaint recovery preparation format under development

An inactive candidate serializer now enumerates complaint disposal preparation
facts, including distinct original-removal and later-disposal policy/resolution
dependencies. It refuses unknown fields, foreign/mismatched dependencies and
conflicting facts under one identity. Six focused tests and the API build pass.
It neither persists nor encrypts data, proves freshness, reserves a writer epoch,
nor authorizes a claim. Reason/actor retention still needs the prepared policy
decision before live export. Durable preparation, reservation, database guards,
full decision history and reconciliation integration remain required. This is
not a deployed recovery feature or independent authority acceptance.

The complaint preparation format now also passes source-driven checks against
actual records created by the isolated PostgreSQL migration fixture: timed
retention and later-policy disposal with a released hold. The fixture imports the
TypeScript source in a separate process and explicitly excludes complaint subject
fields. Seven focused tests and the API build pass. A regression corrects handling
of withdrawn resolution evidence under REVIEW_REQUIRED; it remains ineligible as
an AFTER_ANCHOR starting date. These are synthetic local checks, not live policy,
provider, persistence, fencing or full-recovery acceptance.

### Durable complaint preparation storage under verification

A new inactive ComplaintRecoveryPreparation table and internal store preserve
validated candidate facts under a unique charity/operation identity. The table
checks bound identity/digest and active Owner/unclaimed review, rejects update or
delete, and dispatches no work. The store checks active Owner even on exact retries
and refuses changed bytes. Preparations are now included in restore comparisons
and disposable-test reset inventory. The isolated PostgreSQL fixture proves
current-backup preservation and missing-history refusal for an older backup,
plus insert/digest/role/immutability guards. Eight focused tests, six restore
comparison tests and API compilation pass. The broader API suite is still running.
These local database facts are plaintext like their source rows, not external
replay envelopes. No route, claim or worker calls this store. Capture freshness,
external encryption/custody, durable reservation, execution guards and approved
field retention are still required before live use. No migration was deployed.

The durable preparation storage verification has now completed: 2,477 API tests,
four real PostgreSQL migration tests and 88 inventory/reset/backup tests passed.
The lifecycle model map now explicitly includes the preparation and its unresolved
retention boundary. Earlier running-suite notes are superseded by these local
results. Fresh capture, external encryption/reservation and claim guards remain
unfinished; no production migration or activation has occurred.

### Fresh complaint preparation capture implemented locally

The internal preparation store now captures explicitly selected complaint decision
rows and persists them in one ReadCommitted transaction with charity/Owner and primary-record locks.
It refuses withdrawn/claimed reviews and changed or ambiguous current policies.
Retries validate the existing exact binding/digest and return original preparation;
they do not silently recapture newer facts. The public raw-facts persistence method
was removed. Nine focused tests and API compilation pass. These new capture tests
use a transaction double; prior real PostgreSQL proofs cover the format/storage
migration, not the newly added Prisma capture path or its concurrency schedules.
Actual Prisma/PostgreSQL capture and race acceptance remain required. No route,
claim or worker uses this store; external epoch reservation/encryption and live
field-purpose approval remain open.

Real Prisma/PostgreSQL verification reproduced a stale-snapshot race in the prior
Serializable capture: a holder committed preservation while capture waited, yet
capture could retain its earlier snapshot. This was local, inactive code. Capture
now takes the shared charity lock before reading under ReadCommitted, and locks
the primary complaint row explicitly. The integration fixture verifies actual lock
contention, not timing alone. The fixture database has a dynamically allocated
loopback-only port so the real Prisma client can connect; endpoint and binding are
checked and all records are synthetic. This does not alter personal-server ports.
The prior mocked-only capture statement is historical; the corrected PostgreSQL
run is being verified separately. External fencing and live activation remain open.

The corrected full PostgreSQL fixture completed successfully in 72.8 seconds,
including real Prisma capture/reconnect and the preservation race. The race
assertion failed before the isolation/locking correction and now passes. API build
and nine focused tests also passed. This supersedes the running-proof note above;
it does not establish independent host fencing or authorize deployment/erasure.

### Candidate encrypted preparation envelope, inactive

A bounded seal/open module now binds complaint preparation bytes to installation,
charity, operation, epoch, source and wrapping-key identity using the existing
AES-256-GCM primitive in a separate recovery domain. A trusted data-key provider
interface is supplied; no live KMS adapter/key or credentials exist. Build and 38
focused preparation/envelope/crypto tests pass. Caller-owned returned key buffers
are cleared best-effort; runtime/native copies are not claimed erased. Original
envelope persistence and exact retry reconciliation remain required because fresh
encryption changes bytes. No journal publication or production caller uses this
module. Provider deadlines/custody, field-retention approval, execution fencing and
recovery acceptance remain open.

### Immutable candidate-envelope retry path, under verification

Envelope preservation now rereads the winning create-only object and returns its
actual digest; existing envelopes must decrypt to the exact original candidate
facts. Lost acknowledgement retries do not reseal. A separately enabled S3 replay
namespace has a 64KiB budget and distinct same-account replay key identity. Intent
and head limits remain4KiB. Nine focused envelope/storage tests pass, including
mock SDK round-trip; the complete API suite is still running. No live provider,
policy approval, journal publication or execution fence is supplied by this slice.

Envelope preservation passed the full local API run (2,487 tests and four real
PostgreSQL migration tests). Subsequent review added canonical envelope JSON
validation and refusal of late missing-object/precondition responses after S3
operation expiry. The latter has a reproduced red regression. These final guards
have separate focused verification; do not attribute them to the preceding full
suite. No external key provider, live storage policy or execution fencing exists.

Final envelope build and 57 focused preparation/crypto/S3 tests passed, including
both later review guards. This is local evidence only. The original ciphertext
preservation helper and replay namespace remain inactive and non-authorizing.

### Bounded KMS data-key adapter implemented locally

Source now includes an explicit-credential Ireland KMS adapter for fresh AES-256
data keys and exact-key/context unwrap. It bounds calls, rejects wrong identity,
algorithm or size, hides provider error details, and clears transferred plaintext
buffers best-effort, including late responses after timeout. API compilation and
15 focused KMS/envelope tests pass; SDK request signing/serialization uses an
isolated handler. No actual AWS request, key creation or production wiring occurred.
Live permissions/custody and full recovery execution fencing remain unverified.

Combined KMS/S3 adapter recreation now has executable synthetic proof: after lost
write acknowledgement, newly constructed adapters recover the original ciphertext
and digest without generating another key; unavailable key access refuses and
leaves the object unchanged. Build and16 combined/provider/envelope tests pass.
Backing provider state is synthetic, so this does not prove live AWS custody or
VM-loss recovery. Hosted CI36749194751/E2E36749194762 passed for cb6b31b7's earlier
capture repair; they do not verify the newer KMS/envelope changes. No deployment.

## Verified preparation publication integration — local, 30 September 2026

Added publish-verified-complaint-preparation.ts. It validates exact reservation and envelope context, reads existing immutable candidate bytes without a creation fallback, authenticates/decrypts them, compares the canonical facts SHA-256 with the reservation, rechecks the entire control and revision after decryption, then invokes reserved journal publication with the ciphertext digest. Exact retries retain the original journal binding; missing published bytes are not regenerated. It returns no execution authority.

API TypeScript build and four focused publication tests passed, including real encryption/decryption, missing and corrupt bytes, different reserved facts, control changes during decryption, retry retention and the existing lost-publication-acknowledgement case. This addition is local only; live release remains 6afddb4f. No production caller/provider is activated. Remaining: immutable outcome/release protocol, database guards covering all writers, independent provider/custody activation and full host-loss acceptance. See source tests publish-verified-complaint-preparation.test.ts and reserved-recovery-publication.test.ts.

## Transaction-bound complaint outcome — local implementation

Added additive ComplaintRecoveryOutcome migration/schema. An outcome references one unique original preparation and one unique primary claim. The database checks charity, authority, actor and complaint identity, requires the claim transactionId to equal the current transaction, and refuses an outcome while the primary complaint still exists. Transaction/time fields are assigned by the database; UPDATE/DELETE are refused. No ABORTED state or release API is introduced, and the current live claim path is unchanged. This is incomplete inactive integration, not a required execution fence yet.

Prisma generation/build and the focused real PostgreSQL migration test passed. Negative tests cover foreign charity, authority, actor, record, old transactions, surviving primary data, rollback and append-only protection. Restore reconciliation now includes outcome rows, and all six reconciliation tests pass. Full production-migration complaint proof is running in session 91794, log complaint-outcome-migration-proof.log; it now places outcome insertion inside both rollback and competing real claim transactions. No live database or provider was touched.

Earlier commit 64c3295973dfb007b16a6a44655816c4e76bd231 has hosted CI 36759817976 and E2E 36759818106 in progress. Live remains 6afddb4f. Remaining: durable publication receipt and execution state/guards, outcome envelope/publication and exact reservation release, complete writer coverage, independent custody/activation, and server-loss acceptance.

Outcome verification completed: session 69465 exited 0. Full main API suite 2511/2511 and all five separate PostgreSQL checks passed without failures or skips. Production-migration complaint proof and six restore reconciliation tests also passed. Review confirms append-only unique outcome/preparation/claim binding, database-set time/transaction, same-transaction claim enforcement, primary absence, transaction rollback, and explicit restore/reset inventory coverage. The outcome table alone does not require claims to use recovery authority; activation remains forbidden until every execution and dependency writer is guarded.

## Committed outcome evidence reader — verified locally

readCommittedComplaintOutcome now reads a committed outcome through the ordinary Prisma client, validates the original canonical preparation and SHA-256, cross-checks claim/charity/actor/authority/transaction identity, bounds output identifiers, and serializes the bigint transaction identifier without precision loss. Output includes preparationSourceRevision explicitly; it does not claim the preparation release was the claim's execution release. No reason text or disposition plan is emitted. The reader is internal, inactive and returns actionAuthorized=false.

API build and 14 related tests passed; the final field-name assertion also passed from TypeScript source. The full production-migration complaint proof passed in 84 seconds, including the actual Prisma reader, reconnect stability and foreign-charity refusal. Evidence: complaint-outcome-reader-proof.log; session93253 exited0. This is not independently trusted recovery history, outcome publication, execution fencing, reservation release or permission to reopen. Hosted checks and deployment remain separate.

## Encrypted complaint outcome candidate — local implementation

Added strict canonical COMPLAINT_PRIMARY_PURGE_COMMITTED facts and a distinct COMPLAINT_RECOVERY_OUTCOME encrypted envelope. The outcome uses its own authenticated encryption context and outcomes/<installation>/<charity>/<operation>.json namespace; it cannot replace or be read as a preparation. The S3 adapter preserves expected account/key/version checks, bounded reads and create-if-absent writes. Retry opens the original stored bytes and rejects changed facts. A separate verified reader requires a digest from independently verified history and never recreates missing published bytes. Keys are cleared after use; no reason/subject fields are accepted in the typed outcome.

Initial build and 14 related tests passed. Full main API phase2515/2515 passed with zero failures/skips. Final separate PostgreSQL phase remains running in session15726; evidence outcome-envelope-api-suite.log. SDK transport tests are synthetic, not actual AWS custody/acceptance. No live resources or caller are activated; outcome journal publication, reservation release and database execution guards remain incomplete.

Hosted CI36760462585 at38e31416 failed its source inventory check because ComplaintRecoveryOutcome was omitted from docs/architecture/data-lifecycle-model-map.md. Corrected with purpose/retention/recovery qualifications in d2da0fbb and pushed; the exact inventory test passes locally. This does not retroactively turn the failed hosted run green. Follow-up exact hosted checks remain required. Live remains6afddb4f.

Encrypted outcome verification completed: session15726 exited0. Main API2515/2515 and all five separate PostgreSQL checks passed without failures/skips. Review confirmed distinct storage namespace/authenticated kind, canonical typed facts, bound account/key/context, conditional creation, original-byte retry, missing-byte refusal and key clearing. No independent provider, outcome journal publication or execution permission is activated.

## Reserved outcome publication — local integration

Encrypted outcome storage committed/pushed cab759d7 after main API2515/2515 and PostgreSQL5/5 passed. New local journal kind COMPLAINT_OUTCOME_V1 permits exactly one outcome immediately following its same-operation COMPLAINT_PREPARATION_V1 entry; all other duplicate operation uses remain invalid. Older readers reject the new kind. Orphan/out-of-order outcomes are rejected before immutable writes. The reserved method verifies the exact published preparation generation, entry digest and envelope digest, retaining the same writer/epoch/operation/facts reservation through every read/CAS.

publishVerifiedComplaintOutcome authenticates both stored envelopes, verifies the preparation facts digest and matching complaint/authority/actor, checks unchanged control across decryption, and invokes exact reserved publication. No creation fallback, release or execution permission. Both immutable-entry and control-head acknowledgement losses resume the original operation and bytes. Build and38 focused journal/publication tests passed. Full API suite runs in session available from the current tool receipt; log reserved-outcome-publication-api-suite.log. No live activation/deployment of this work.

Remaining: outcome read/recovery integration, durable local execution state and guards, exact release tied to terminal execution, complete writer coverage, independent custody/provider acceptance, old-host isolation and VM-loss acceptance. Original role/file/report/policy/replay/C1/DPO acceptance scope remains open.

## Published outcome evidence reader and final verification

readPublishedComplaintOutcome verifies both journal entries against full current history, requires their adjacent predecessor relationship and same observed head revision, opens both ciphertexts at the independently published digests, checks the exact preparation facts/complaint/authority/actor relationship, and rechecks the head after decryption. Missing bytes and changed head refuse. The returned evidence still has actionAuthorized=false; it does not apply recovery, authorize execution or release the reservation.

Full publication regression suite completed in session51976 with no failures/skips, including all five PostgreSQL checks (reserved-outcome-publication-api-suite.log). The reader was added after that full-suite compile: final build and all38 combined journal/publication/reader tests passed in session64135 (published-outcome-final-tests.log), including lost entry/head acknowledgements, original ciphertext retention, wrong complaint, missing preparation and head-change refusal. No local verification handles remain active for this slice. Hosted gates/deployment remain pending.

The earlier58bf89d0 hosted CI failure was confirmed as the same lifecycle-map omission already corrected by d2da0fbb; it is not a different unexplained failure. Independent outcome publication remains inactive without a real provider. Next required integration is exact reservation release tied to terminal execution, local database guards for every dependent writer, activation/rollback, separate custody and old-host isolation/VM-loss acceptance. Original Nikita acceptance requirements remain intact.

## Committed complaint reservation release — local inactive integration

releaseCommittedComplaintOperation reads the actual committed outcome with an ordinary Prisma client and requires byte-for-byte equality with independently verified published evidence. The current writer/epoch, exact operation/preparation digest, latest outcome head and control revision must remain bound. Only then does the explicit provider release clear the slot. A null-slot retry still verifies the exact latest outcome and local result; absence alone never means success. Another active operation, stale writer, changed head or mismatched local result refuses. Lost acknowledgement remains unknown until exact retry verification.

The S3 release adapter validates the exact latest COMPLAINT_OUTCOME_V1 entry's structure/hash and binding, then conditionally clears only the active operation on the same head.json using its original ETag. Generic compareAndSwapControl still refuses clearing. Source-level provider checks are not full-chain/decryption/commit proof; the service supplies those additional gates. No timeout, abandoned-operation cancellation, force-unlock or writer takeover exists. Existing primary-claim uniqueness and append-only guards supply the terminal primary claim; other action classes and all-writer execution fencing remain unfinished.

Initial build and integrated release tests passed, as did a focused synthetic S3 release test. Additional mismatch/new-operation and concurrent-writer races were added for the full run, active session22342, log committed-release-api-suite.log. Do not start another run while live. No production caller, real provider or deployment is activated. Current live remains6afddb4f; exact634e4240 hosted CI36762012579 and E2E36762012425 were still running at latest check.

Committed-release verification finished: main API2519/2519 and separate PostgreSQL5/5 passed with zero failures/skips (committed-release-api-suite.log). Final focused checks also passed for differing local claim evidence, retry after a later operation acquires the slot, and an S3 writer change between outcome read and conditional clear. Review confirms release preserves writer/epoch/journal generation/digest, requires full independent pair/payload verification plus exact local commit, and returns no execution/reopen permission. This is inactive complaint-primary release support, not all-writer fencing or full recovery readiness.

Hosted E2E36759818106 at64c32959 and E2E36760462540 at38e31416 completed successfully; their exact receipts are retained privately. The latter commit's separate CI remains failed for the lifecycle map omission fixed later. Latest634e4240 hosted checks remain pending. No new live release.
