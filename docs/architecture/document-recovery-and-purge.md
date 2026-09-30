# Document recovery and purge implementation contract

Status: implementation in progress, 30 September 2026. R1 policy persistence
and removal state are implemented locally; R2-R5 remain open. Other data
classes and downstream stores remain in the full data-lifecycle scope.

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
