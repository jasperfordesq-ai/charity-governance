# Document recovery and purge implementation contract

Status: implementation in progress, 30 September 2026. R1 policy persistence
and removal state are implemented locally; R2-R5 remain open. Other data
classes and downstream stores remain in the full data-lifecycle scope.

Read the checkpoints below as dated implementation history, newest first within
Observed starting point. Statements about missing routes/UI in older checkpoints
are superseded by the later policy-administration and browser-proof checkpoints.
The full frontend typecheck failure mentioned below is now resolved: all web
files, including tests, pass without exclusions; the 30 affected tests pass.

Policy persistence checkpoint: immutable `DataRetentionPolicyRevision` rows
record DRAFT or APPROVED proposals with a class, revision, retention mode and
recovery days. Approval requires complete evidence facts and a currently
active Owner of the same charity; creation permits active Owner/Admin.
Withdrawal is a separate immutable fact requiring the active Owner and locks
the policy row. No policy is seeded, no route exposes approval yet and no
expiry worker consumes these rows. These actor checks do not independently
verify the cited policy evidence. Class identifiers and day bounds are storage
validation, not legal classification or recommended durations. Approval of a
draft will create a new revision rather than rewriting the original.

`npm run test:retention-policy` applies the preceding migration history in a
disposable local PostgreSQL 16 container, preserves a document/upload fixture,
applies the new migration and verifies scoped actors, complete policy facts,
immutable history and withdrawal. The test passes with container removal.
API build, schema validation and 51 model-map/reset-safety checks also pass.
The migration is not deployed. This checkpoint does not prove recovery,
purge/hold races, user-interface behavior or provider/backup disposal.

## Observed starting point

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

Dashboard checkpoint: Deleted Items now opens a six-store disposition form with
no preselected outcomes, approved policy selection, controlled evidence, reason
and an explicit Owner confirmation. Each retained authorization offers separate
cancellation and irreversible primary-disposal review. History is independently
browsable after the document disappears, distinguishes plans/queued work/primary
absence and never calls the whole case erased. Owner-only mutations remain
enforced by the API; Admin history remains available.

`tests/document-purge.spec.ts` passes in the managed disposable stack: actual
upload/removal UI, six-store authorization, early claim 409, cancellation,
synthetic expiry, new authorization, atomic claim, one pending job, idempotent
retry and history after reload. Runner exits 0; the rendered history screenshot
was inspected. The stack has no cleanup worker: this is a queued-handoff proof,
not physical-byte disposal. Expiry is aged only in the guarded disposable DB.
Full frontend and E2E typechecks, edited UI lint, API build and 79 focused API
tests pass. Initial runs exposed ambiguous selector labels and a real Prisma
UnknownRequestError translation gap for P0001 trigger refusals; both were fixed.
One intermediate navigation hit the generic application error screen without
captured cause; it did not recur in the final journey, which captures page errors
and includes the final reload. Do not claim a root cause or closure for that
isolated observation. Next connect a verified disposable cleanup worker and prove
physical bytes, retry/timeout/two-worker behavior and downstream accounting.

Application API checkpoint: browser Owner can POST `/documents/purge-authorizations`
with document ID/revision, policy, six-store plan, reason/evidence and explicit
authority confirmation; POST `/:authorizationId/withdraw` records cancellation;
POST `/:authorizationId/claim` requires `confirmPermanentPurge: true`. Browser
Owner/Admin can GET that history across their charity or filter by documentId,
with a tenant-scoped cursor. History remains available after the record is purged.
These paths inherit document authentication/subscription checks and reject
connectors. Mutations also require ADMIN session access and recheck the active
Owner inside the locked transaction. Review output excludes storage paths,
fingerprints and transaction IDs. A claim retry returns the existing receipt.

The service reads pinned bytes and compares size/SHA-256 before authorization
and before a new claim. This detects a changed file at the check, not a guarantee
against a provider mutation after the read; object/version handling still needs
provider integration proof. Database guards remain final execution authority;
concurrent guard refusal returns a bounded review-conflict message. Focused
service and route tests cover plan validation, actor/tenant refusal, changed
bytes, history bounds, retries and role/channel gates. They use a database
double; the separate real PostgreSQL tests prove database transitions. Combined
persisted API/browser/worker proof and dashboard controls remain outstanding.

Atomic purge claim checkpoint: `DocumentPurgeClaim` now creates the primary
storage outbox job, appends RECORD_DELETE with PRIMARY_PURGE_PENDING and removes
the recoverable Document in one transaction. The database rechecks active Owner,
matching unwithdrawn authorization, exact revision/object, current policy,
recovery and retention expiry, holds and evidence links under shared locks.
It reads time after waiting for locks; purge eligibility includes the exact
expiry instant. No application route invokes this yet. A committed claim is
the cancellation boundary: withdrawal then refuses to promise recall, restore
has no record to reopen, and even audited corrected-path recovery cannot redirect
the primary job. Existing provider/request/source identity guards remain.

The real PostgreSQL proof covers early recovery/retention refusal, stale binding,
wrong actor, held records, transaction rollback, competing claims producing one
job, and holds/cancellation/restoration winning while a claim waits on a lock.
Its expiry fixtures are aged only in the disposable database with a named trigger
temporarily disabled, then reenabled before authorization/claim; there is no
production clock override. This does not prove physical-byte disposal, the
application API/UI, a two-worker provider race or downstream disposition. Next
wire reviewed authorization/withdrawal/claim endpoints and UI, prove exact bytes
and worker failures/retry, and retain Confluence/version/export/backup evidence.

Purge withdrawal persistence checkpoint: the active same-charity Owner can be
recorded as withdrawing an authorization through a separate immutable fact with
reason, evidence reference and database time. The database serializes on the
organisation/actor and authorization; duplicate withdrawals cannot create two
facts. A future claim must lock the same authorization, reject withdrawal and
make withdrawal refuse once disposal has crossed the irreversible claim point.
That claim does not exist yet. There is no application route or worker consumer.
Withdrawal preserves both the authorization and retained document; it queues
nothing. Real PostgreSQL proof rejects foreign Owner/charity and Admin actors,
serializes two requests to one withdrawal, rejects history rewriting/deletion
and preserves the removed file record and zero cleanup jobs. Restore remains
available. The original test's attempted sole-Owner demotion was correctly
refused by the existing ownership guard; a separate Admin fixture tests denial.

The unpublished purge authorization migration's index naming and ON UPDATE
actions were aligned with the Prisma-generated schema before deployment. The
upgrade proof asserts the new FK actions and index identities explicitly.

Purge authorization persistence checkpoint: `DocumentPurgeAuthorization` is an
immutable Owner decision binding tenant, document revision, policy, provider,
path, hash, size and saved recovery deadline. It requires a six-store plan
(primary, versions, Confluence, exports, audit, backups) with a controlled
evidence reference for each proposed disposal, approved retention or
non-applicability. These are plans, never observations of absence. Approval
can precede the recovery deadline; execution must still wait for both retention
and recovery expiry. Replacement current policies are permitted without changing
the saved recovery deadline. The database locks the active Owner, document and
policy and rejects active/held documents, wrong-object binding and withdrawn
policies. No endpoint, claim, worker consumption or live activation exists yet.
Authorization does not relax the existing hard-delete guard and does not prevent
restoration; a later claim must revalidate revision, holds, current policy,
authority and deadlines atomically. Authorization withdrawal and claim/outbox
integration are still required before exposing a purge workflow.

Real PostgreSQL upgrade proof passes active-record, foreign-Owner, wrong-path,
incomplete-plan, invented-absence, held-record and immutable-history refusals,
then proves that an accepted authorization still cannot hard-delete the document
or create a cleanup job and does not prevent restoration. Existing removal-race
tests also pass; disposable teardown succeeds. Schema validation and all 51
model-inventory/reset-safety tests pass. This is R3 persistence progress only.

Latest retirement/race checkpoint: the obsolete immediate-delete service and
its private retirement helpers are gone. Tests for that removed entry point
were retired; cleanup worker, publication worker and current recovery tests
remain (191 focused tests and API build pass). The two adapted DPO browser
journeys pass case-link preservation and RECORD_REMOVE in Governance Audit with
zero cleanup receipts. Rebuild the actual purge-to-case-storage-job journey in
R3; this checkpoint does not prove that future workflow.

The PostgreSQL proof now starts independent sessions and waits until
pg_stat_activity reports the removal blocked on a lock. When the other session
commits either a deletion hold or a policy withdrawal, removal is rejected;
the active document and zero cleanup jobs are verified. Sessions and container
are cleaned up. These are hold-versus-removal and withdrawal-versus-removal
proofs only, not approval-versus-withdrawal or restore-versus-purge proofs.

Latest policy administration checkpoint: `/documents/policy-revisions` provides
browser-only bounded history and immutable proposal/approval creation for
VAULT_DRAFT; `/:id/withdraw` records Owner withdrawal with reason/evidence.
Service checks use the active same-charity actor, not just the request's role.
Each approval records exact terms and evidence in a new revision and withdraws
previous unwithdrawn approvals in the same transaction. Proposals never activate
rules. Approval/withdrawal take the organisation and actor locks consistently,
then policy locks shared with removal. Existing recovery deadlines are unchanged.

The UI exposes individual-review, permanent-retention and days-from-creation
rules; no days are prefilled. The Owner sees exact terms, supersession behavior,
an evidence field and an authority acknowledgement before approval. This records
authority asserted by the Owner; it does not independently validate the evidence
or constitute DPO/legal approval. Other classes remain R4 work.

The expanded managed browser test passed proposal, approval, retained removal,
replacement approval, unchanged retained deadline, ordinary access denial,
identical-byte restoration and explicit withdrawal. Production build/typecheck
passed; the restore screenshot was inspected in its stable viewport. Withdrawal
lock ordering was strengthened after that browser build; API build and 74 focused
tests pass on final source. A real database concurrency test remains required.
No live migration, policy activation or deployment occurred.

Latest UI checkpoint: the Documents page now offers an Admin-only Deleted Items
panel with bounded pagination, deadlines, hold status, refresh, reasoned restore,
error handling and restricted-sharing notice. It resets the pagination cursor
after restoration because a restored anchor is no longer in Deleted Items.

The managed disposable runner passed `tests/document-recovery.spec.ts` using real
PostgreSQL, compiled web/API, local file storage and Chromium. It proves upload,
approved synthetic-policy removal, retained row/hash, zero cleanup jobs, Owner
ordinary detail/download denial, panel listing, restoration, identical downloaded
bytes, restricted sharing and removal/restore audit. The first run found a panel
response-unwrapping defect; the fixed second run passed with runner exit 0.
Application typecheck (275 files) and the isolated production build/typecheck
passed. A screenshot was inspected, but its capture occurred during modal
animation; capture settings now disable animations and limit the viewport for
future runs. Do not claim a completed visual/accessibility review from it.

The policy was inserted only into the runner-owned synthetic database. Policy
administration, real-database negative/race coverage, old hard-delete code/test
retirement, adapted older DPO browser journeys and R3-R5 remain open. This is
not deployed acceptance and does not close DPO-05.

Latest ordinary-removal checkpoint: DELETE now invokes the recovery service with
a policy ID, controlled removal evidence reference and expected revision. It is
web-admin only and never invokes provider deletion or cleanup creation. The
dialog loads scoped approved/unwithdrawn VAULT_DRAFT policies, requires selection
and cannot proceed without one. None are seeded. Response changes from 204 to
200 with retained-item metadata. Old reason-only requests receive 400; connectors
receive 403. Existing cleanup workers still handle previously authorized jobs.

The obsolete immediate-delete service method remains only for existing direct
tests and needs removal before release. Ten route tests asserting the former
deletion behavior were replaced with the new retained-removal matrix, covering
policy, stale revision, holds, standard/citation/replacement links, lifecycle,
audit failure rollback and zero destructive calls. Current verification: API
build and 69 recovery/route tests pass; 178 frontend wiring tests and a bounded
application typecheck (274 files excluding tests) pass. Full frontend typecheck
fails on unchanged tests assigning readonly NODE_ENV. No browser journey or
deployment is claimed; policy administration and Deleted Items/restore UI remain.

Recovery-service checkpoint: `DocumentRecoveryService` implements transactional
policy-bound removal without cleanup and fingerprint-checked restoration. It
locks the document and policy, checks the expected revision and active actor,
uses database time, withdraws sharing and appends removal/restore audit events.
`20260930030000_document_recovery_fingerprint` requires an immutable SHA-256
while removed and permits the two new audit kinds. Existing unsupported removed
rows without a fingerprint cause migration refusal; no hash is invented.
Browser Admin/Owner endpoints now list Deleted Items and restore with a reason
and expected revision. The removal service is not yet wired to ordinary DELETE;
that route still uses legacy immediate deletion. No dashboard recovery UI or
policy administration is present. Do not deploy this as completed recovery.

Focused service tests use an actual temporary local file with a transactional
database double: bytes survive removal/restoration, a hold survives restoration,
and missing/changed files, expired windows, missing policies, linked/held records,
inactive actors and stale revisions are refused. Separately the real PostgreSQL
migration proof rejects missing/rewritten recovery fingerprints. Neither test
is a combined real-database HTTP journey or a concurrency proof. Continue by
replacing ordinary DELETE, wiring reviewed policy selection and the UI, then
exercise full persisted journeys and purge races.

Verification for this checkpoint: API build, all 77 recovery-service/document-route
tests, and the disposable PostgreSQL migration proof pass. The route tests include
Member and connector denial, bounded listing and invalid restore-input rejection.

Recovery-state checkpoint: additive migration
`20260930020000_document_recoverable_state` retains removed rows with scoped
policy, actor, revision, evidence and deadline facts. It rejects held or linked
draft removal, invalid/withdrawn policy, altered content, premature hard deletion
and new citation/replacement references. Restore-state transitions preserve
restricted sharing and holds. Ordinary Vault, search, activity, evidence-selection,
download and publication reads exclude removed rows; ordinary mirror lookup
filters before fetching publication details. Custody checks and quota still
include retained rows, so cleanup cannot mistake trash for unreferenced storage.

The real PostgreSQL proof now exercises removal/restoration state, preserved
path/size, no cleanup job, reference rejection and policy withdrawal. It does
not verify physical bytes or concurrent transitions. API build and the earlier
804 focused tests pass; after the mirror fix, all 73 document-route tests pass.
No removal/restore API or UI is exposed, no policy is activated, and neither
new migration is deployed. Continue R2 and the remaining R1 publication-fixture
coverage; these foundations do not complete the recovery contract.

`DocumentService.remove` transactionally removes an eligible, unheld DRAFT
record and enqueues a provider-pinned `DocumentStorageDeletion`. The DELETE
route immediately attempts byte deletion; the worker retries later. Its
recovery operation retries cleanup and cannot restore an item. Existing
guards preserve held/linked evidence and reject unknown storage custody.

The design must replace ordinary removal with recoverable removal for the
configured scope. Retention approval and final erasure remain separate from
recovery. No recovery duration is silently activated by a deployment.

## State and authorization contract

1. Introduce tenant-bound, versioned policy facts: supported record class,
   retention rule/anchor or permanent disposition, recovery interval, approval
   actor/time and controlled evidence reference. Draft or withdrawn policy
   cannot authorize a destructive transition. Policy revisions are retained.
2. For Vault recovery, keep the Document row and bytes while in Deleted Items.
   Add removal actor/time, policy revision, original revision and recovery
   deadline. Deletion status is separate from content lifecycle; HISTORICAL
   and RETIRED do not mean trashed or purgeable. Existing rows stay active.
3. Removal checks exact tenant, Admin web session, expected revision, eligible
   retention/disposition authority, known provider, holds and link rules in a
   transaction. Withdraw Member/publication approval. Append the audit event.
   Do not enqueue byte cleanup. A missing approved policy gives an actionable
   refusal rather than falling back to the old immediate deletion path.
4. Deleted items are excluded from ordinary list, detail, download, search,
   activity, compliance/evidence selections, publication, connector reads and
   mutations. An Admin-only paged Deleted Items route exposes controlled
   metadata. Preview/download, if provided, is separately audited and cannot
   be mistaken for restoring Member access. Cross-tenant lookups return 404.
5. Restore checks tenant, role, revision, recovery deadline, current hold and
   purge state under a row lock. Confirm the exact pinned object exists before
   presenting successful recovery. Preserve document identity/content and
   history; require fresh sharing and external-publication review. Missing
   bytes produce a recovery failure, never a success with a broken link.
6. Purge eligibility requires the approved class rule, reached retention and
   recovery boundaries, explicit authority, no active hold and a disposition
   plan for all applicable stores. Take the same row lock used by restore and
   hold transitions. Capture the authorized provider/path and audit scope in
   an atomic outbox transition before removing recoverable data. Once claimed,
   restore is unavailable. Crash/retry must not duplicate or redirect work.
7. Primary-file absence is one outcome. Track versions, managed Confluence
   copies, recipient exports, logs/audit and backups separately as unreviewed,
   retained with approved authority, pending disposal, verified absent or
   failed. Record evidence and observation time. A completed primary job must
   never set an application-wide `erased` result.
8. Preserve the existing separate Confluence-erasure authorization. Removing
   or restoring a Vault entry must not silently delete or republish a remote
   page. Retained references must remain discoverable during recovery/purge.
9. Policy edits cannot silently accelerate an existing deletion deadline.
   Suspension/withdrawal prevents new purge claims; separately review already
   claimed external work. Record a precise point beyond which a remote action
   cannot be recalled instead of promising cancellation.
10. Backup restore must reconcile retained purge instructions before reopening
    access. Do not erase current recovery sets during the build or infer that
    a host's pruning interval covers manually copied/off-host sets.

## Implementation sequence

| Slice | Deliverable | Required proof before release |
| --- | --- | --- |
| R1 Policy and recovery persistence | Additive policy/removal state and constraints, inactive for existing tenants, immutable approval facts | Real PostgreSQL migration over existing document/publication/upload-intent fixtures; reject inconsistent tenant/state/deadline combinations |
| R2 Recoverable Vault workflow | Ordinary remove-to-trash, Deleted Items list, guarded restore, exact-byte preservation and audit | Owner/Admin UI journey; Member/direct/connector denial; all ordinary read surfaces exclude trash; successful restore and missing-byte failure |
| R3 Purge workflow | Explicit disposition authorization, retention/recovery/hold checks, atomic claim, provider-pinned worker and failures | Real database races: restore versus purge, hold versus claim, repeated request, two workers; crash/retry and provider timeout tests |
| R4 Other records and stores | Apply approved class rules to remaining model groups; provider/version/Confluence and backup/export disposition tracking | Per-store evidence; full subject/case coverage; no false completion with an unresolved target |
| R5 Deployment and acceptance | Exact release, migration rehearsal, backup, deploy, synthetic live verification, review pack | Successful restore and purge using disposable test records; retained real records and no unapproved policy activation; reviewer acceptance recorded separately |

These slices are sequencing, not reduced completion criteria. R2 alone cannot
close DPO-05. A policy table or a passed migration cannot be described as a
working restore facility.

## Integration inventory to verify

Primary direct Document reads/writes currently occur in `routes/documents`,
`document.service`, `document-publication.service`, `confluence-reference`,
`confluence-copy-inventory`, `data-lifecycle`, `governing-act`, `activity` and
`action-summary`. Also inspect relation-based reads, raw SQL, search,
dashboard, exports and connector projections; a text search for the direct
delegate is not a complete access inventory. Retained compliance snapshots
must not be silently rewritten when a linked source is removed.

The upload-intent reconciler and cleanup worker currently protect any live
Document with the same tenant/path. A trashed row must continue that byte
protection until the purge claim atomically authorizes removal. Publication
workers must refuse deleted items even if an earlier approval was cached.
Review the database link/hold triggers as well as the service checks.

## Acceptance tests

- Removing a permitted synthetic item preserves exact file bytes and its
  required metadata; no cleanup job is created before purge authorization.
- No approved policy: no transition, queue row or byte deletion. Existing
  rows do not acquire invented retention/recovery dates during migration.
- Trash is inaccessible through every ordinary Member, Admin and connector
  surface except the explicit restricted review/restore workflow.
- Same filename, path collision, foreign tenant, stale revision and changed
  policy are checked independently. Cursor scope cannot cross charities.
- Restore returns the same identity and exact bytes before the deadline,
  retains history and does not revive prior visibility/publication approval.
- At the boundary, use server/database time consistently; document inclusive
  or exclusive deadline semantics. A missing object cannot be restored.
- Only one of restore and purge wins a concurrent race; a hold placed before
  the purge claim prevents cleanup. Provider dispatch uses the saved scope.
- Failure before commit produces no orphan destructive job. Failure after
  claim can retry with audit evidence and cannot switch providers.
- Purging primary storage leaves the case incomplete while any applicable
  downstream target lacks disposition evidence. Backup restoration cannot
  make an already purged record available again without reconciliation.
- Existing approved snapshots and historical evidence retain their required
  integrity. Any later lawful audit minimisation needs its own authorized,
  narrowly scoped design; ordinary application writes stay append-only.

No live policy, file classification or destructive action is authorized by
this specification itself.
