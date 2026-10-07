# Data lifecycle schema coverage

This source map accounts for every Prisma model in `apps/api/prisma/schema.prisma`.
It is a coverage inventory, not an approved retention schedule, legal-hold rule,
deleted-item recovery window or purge instruction. Each model below needs a
controller-approved class disposition before application-wide erasure can be
claimed. Objects, Confluence, mail providers, logs, exports and backups are
outside the Prisma schema and must be inventoried separately. The controlled,
Git-ignored working analysis is in `.charitypilot-private/data-lifecycle-inventory.md`.

The model list between the markers is checked against the schema by
`scripts/data-lifecycle-model-map.test.mjs`; add a new model to exactly one
group when its migration is introduced.

<!-- MODEL_INVENTORY_START -->
- organisation-auth: `Organisation`, `OrganisationIntegration`, `IntegrationCredential`, `IntegrationSecretControl`, `User`, `UserSecondFactor`, `UserSecondFactorRecoveryCode`, `AuthSession`, `BillingAuthorityGrant`, `SecurityAuditEvent`, `ClientActivityEvent`, `AuthActionApproval`, `AuthActionApprovalAudit`, `ConnectorIdempotencyRecord`, `PasswordRecoveryRequest`, `AuthRecoveryRateLimitBucket`, `AuthRecoveryControl`, `AuthRecoveryRetiredSecret`, `AuthSecurityEmailOutbox`
- reference-compliance: `GovernancePrinciple`, `GovernanceStandard`, `ComplianceRecord`, `ComplianceSignoff`, `ComplianceApprovalSnapshot`, `ComplianceAuditEvent`, `ComplianceReportPreparationAudit`
- documents-storage: `Document`, `DocumentUploadIntent`, `DocumentControlAudit`, `DocumentVisibilityAudit`, `DocumentDownloadPreparationAudit`, `ConfluenceReference`, `DocumentStandardLink`, `DocumentStorageDeletion`, `DocumentStorageDeletionRecovery`, `DocumentStorageDeletionAttempt`, `DocumentPublication`, `DocumentPublicationUploadIntent`, `DocumentPublicationPageCreateIntent`
- registers-controls: `BoardMember`, `ConflictRecord`, `RiskRecord`, `RiskChangeAudit`, `RiskControlVerification`, `RiskControlVerificationCounter`, `ComplaintRecord`, `ComplaintResolutionEvidence`, `ComplaintRemoval`, `ComplaintHoldEvent`, `ComplaintPurgeAuthorization`, `ComplaintPurgeAuthorizationWithdrawal`, `ComplaintPurgeClaim`, `ComplaintRecoveryPreparation`, `ComplaintRecoveryOutcome`, `ComplaintRecoveryEnforcement`, `ComplaintRecoveryExecution`, `ComplaintHoldRecoveryPreparation`, `ComplaintHoldRecoveryOutcome`, `ComplaintRecoveryCancellation`, `ComplaintPurgeDispositionEvent`, `ComplaintCopyDispositionAuthority`, `ComplaintCopyHoldEvent`, `GovernanceRegisterChangeAudit`, `OrganisationChangeAudit`, `FundraisingRecord`, `AnnualReportReadiness`, `FinancialControlReview`, `Member`
- calendar-minutes: `Deadline`, `DeadlineChangeAudit`, `DeadlineReminderLog`, `DeadlineReminderAudit`, `GoverningAct`, `Resolution`, `GoverningActVoid`, `MinuteBookChangeAudit`
- team-billing: `TeamInvite`, `Subscription`, `BillingCheckoutAttempt`, `StripeWebhookEvent`
- data-requests: `DataLifecycleRequest`, `DataLifecycleStorageLink`, `DataLifecycleStorageLinkWithdrawal`, `DataLifecycleDocumentLink`, `DataLifecycleDocumentLinkWithdrawal`, `DataLifecycleReviewEvent`, `DataLifecycleTargetEvent`, `DataLifecycleResponseEvent`, `DataLifecycleCoverageEvent`, `DataRetentionPolicyRevision`, `DataRetentionPolicyWithdrawal`, `DocumentPurgeAuthorization`, `DocumentPurgeAuthorizationWithdrawal`, `DocumentPurgeClaim`, `DocumentPurgeDispositionEvent`, `DocumentRecoveryPreparation`, `DocumentRecoveryEnforcement`, `DocumentRecoveryExecution`, `DocumentRecoveryOutcome`, `DocumentBytePermitCandidateBinding`, `DocumentByteExecutionLease`, `DocumentByteProviderAttempt`, `DocumentCopyDispositionAuthority`, `DocumentCopyHoldEvent`
- platform-operators: `PlatformOperator`, `PlatformOperatorRecoveryCode`, `PlatformOperatorSession`, `OperatorActionApproval`
<!-- MODEL_INVENTORY_END -->

| Group | Existing mechanism and boundary to resolve |
| --- | --- |
| Organisation and authentication | Sessions can be revoked. Eligible password-recovery and security-email delivery rows have a narrow seven-day operational cleanup after terminal and alert conditions. That rule does not dispose of users, integration credentials, security history, provider mail, logs or backups. |
| Reference and compliance | Standards and principles are reference material. Compliance records, sign-offs and immutable approved snapshots retain governance evidence; report-preparation events record only preparation. Snapshot, audit and downloaded-copy retention remain undecided. |
| Documents and storage | Current source supports policy-bound recoverable removal of eligible unheld drafts, exact-byte restoration, and separately reviewed purge after the recovery window. Primary-object cleanup and downstream disposition evidence are separate. Dead-letter recovery retries cleanup; it does not restore the document. Confluence copies use a separate explicit erasure request. Real policy approval, deployed acceptance, version disposal and backup expiry remain unproved. |
| Registers and controls | Individual live-record removals vary; metadata-only action histories and control verifications can outlive live rows. The legacy statutory-member deletion date is no longer derived or exposed as an approved deadline. Per-class holds and disposal remain unapproved. |
| Calendar and Minute Book | Deadline and Minute Book changes have retained histories; removed governing acts retain restricted snapshots. Reminder delivery has operational records and, after migration 46, a metadata-only append-only status/reconciliation transition history. Earlier reminder transitions cannot be reconstructed. No class expiry or recovery path is approved. |
| Team and billing | Invitations have revocation and reissue states. Stripe and local billing records have separate custody and accounting obligations. No broad tenant-closure purge rule is approved. |
| Data requests | Intake, review events, reviewer-entered response targets, evidence-backed reviewer-recorded actual sent times, source-area coverage assessments and evidence associations are retained as an unresolved case history. Each source area is unreviewed until assessed; an assessment does not prove every subject record was found or erased. Past targets have a separate attention queue until an actual response is recorded; targets are not computed statutory deadlines. An actual sent time is not independent delivery proof, a retention-expiry calculation or case closure. A link or technical deletion outcome is not a lawful disposition or complete erasure receipt. |
| Platform operators | Operator credentials, recovery codes, sessions and action approvals are a separate platform control plane; charity Member access does not govern them. Their retention and recovery need their own policy and operational evidence. |

`RiskControlVerificationCounter` is a migration-owned operational singleton,
holding only an integer allocation high-water and its fixed key. It is captured
with audit history in a consistent backup. It must not be reset or removed by
per-person or per-charity erasure: other retained audit rows depend on globally
unique ordering. This technical dependency is not a retention period or an
approval to retain the underlying personal records indefinitely. Any terminal
disposal or reconstruction needs a separately reviewed recovery procedure.

Before approving a schedule, map each group to its purpose, retention anchor and
period, legal-hold exception, deletion owner, recovery window, downstream copies,
backup expiry and proof method. The model check proves only that schema names are
accounted for; it cannot verify any of those decisions or a deployed tenant.

`ComplaintRecoveryPreparation` is an inactive candidate recovery store. It holds
explicit complaint decision facts in the private database, including reasons and
actor references, but excludes subject narrative. Its immutable records grant no
disposal or reopening permission. It is included in backup/restore comparisons.
Live capture/export, external encryption and custody, retention and eventual
approved disposal of these records remain unresolved. Append-only enforcement
must not be interpreted as an approved permanent-retention policy.

`DocumentRecoveryPreparation` is an inactive, append-only candidate store for
bounded document disposal decision facts. It contains actor/reason, policy,
removal, exact object identity and disposition-plan metadata, but no document
bytes or descriptive Vault fields. It has no live capture route. The separate
`DocumentRecoveryEnforcement`, `DocumentRecoveryExecution` and
`DocumentRecoveryOutcome` models are an inactive SQL claim/job transaction
protocol. They conditionally reject claims that lack a matching local execution
and require a same-transaction outcome, but do not authenticate remote
publication, fence storage-byte deletion or cover every copy writer. A separate
source-only document-outcome reader and encrypted publication path now binds a
committed primary claim and queued deletion job to a reserved independent
journal entry. It has no live caller and asserts neither byte nor copy erasure;
the reservation cannot be released by this document-outcome kind. Their
retention and independent custody require P05/P08 decisions. The later
`DocumentBytePermitCandidateBinding` is an owner-only, append-only local
lineage record for a candidate and exact claim/target. It does not itself
authenticate remote publication. It has no
production caller and does not authorize a worker. The later
`DocumentByteExecutionLease` binds a final-decision digest and one-use
capability hash to that candidate. The restricted runtime can consume the
capability only through an exact SQL claim function; it cannot write the lease
table. The claim still has no provider-byte caller or independent pre-provider
head check. `DocumentByteProviderAttempt` is a separate append-only,
one-use marker for a committed claimed lease. It records that provider I/O
was about to start, not whether it reached the provider or removed bytes.
The runtime can create it only through the exact capability-checked SQL
function; no production worker calls it yet. Restore snapshot format 6
hashes this marker, format 5 covers leases without it, format 4 covers the
candidate binding without a lease, and format 3 covers the older schema.
Mixed formats refuse reconciliation. None of these rows alone is permission
to reopen after host loss.

The later document byte-fence migration refuses activation while an older
purge job is unfinished and refuses direct updates to a purge-claim deletion
job once enforcement is active. It serializes both paths on the organisation
row. This is deliberately fail-closed: the storage worker has no verified
independent byte-execution permit yet, so binding enforcement must remain
inactive until that permit, copy-writer coverage and host-loss controls pass.


`ComplaintRecoveryOutcome` binds one original preparation to one committed
primary complaint claim in the same database transaction. It retains identifiers,
transaction identity and a database timestamp; the claim and preparation retain
related decision evidence. It is append-only and covered by restore comparison.
No live workflow currently writes it. Retention/custody decisions, independent
outcome publication, execution fencing and reservation release remain incomplete;
its presence does not prove disposal of copies or permission to reopen a restore.

`ComplaintRecoveryEnforcement` retains the unique charity/installation/writer
binding used by the inactive complaint execution gate. It cannot be removed or
changed through ordinary writes. Application rollback must leave it in place;
activation and replacement are unsupported until the wider recovery gates pass.
`ComplaintRecoveryExecution` records the exact preparation, observed publication
digests/revision, writer and transaction identity. Its deferred database constraint
requires a matching claim and outcome in that same transaction. It is append-only
and both models are included in restore comparison. A restored binding or stored
receipt alone proves neither current independent authority nor permission to
reopen. Retention and custody decisions remain pending; no permanent retention
policy is implied by these technical integrity requirements.

`ComplaintHoldRecoveryPreparation` preserves an immutable candidate apply/release
decision, exact preceding hold evidence, actor and source revisions. It excludes
the complaint narrative and does not itself change a hold. Capture requires a
current Admin or Owner and fresh complaint/hold revisions under charity locking.
The model is included in restore comparison and disposable reset inventory.
Reasons and actor references still require retention/custody approval before
external publication. Encryption/publication, execution and recovery replay for
this action remain unfinished; a preparation is not proof of an applied hold.

`ComplaintHoldRecoveryOutcome` applies the exact prepared transition and records
its outcome in one local transaction. Its trigger invokes the ordinary hold
guards, rechecks the exact preceding decision and sets the event ID, transaction
ID and time itself. Failed insertion rolls back the hold; outcomes are immutable.
The committed reader binds every decision field but omits free-text reasons from
its minimal receipt. This inactive internal primitive is not a remote execution
gate: independent publication, reservation handling, all-writer enforcement and
replay remain required. No normal hold caller or activation path uses it yet.

`ComplaintRecoveryCancellation` is immutable local terminal evidence for exactly
one original primary or hold preparation. Current role and writer checks plus
charity-lock serialization prevent cancellation and prepared execution from both
committing. It belongs in backup/restore comparison and disposable reset inventory.
It does not clear a remote reservation or establish independent recovery custody.

Cancellation/execution guards require Read Committed isolation so reads performed
after waiting on the charity lock observe the competing committed terminal state.
Repeatable Read and Serializable requests are rejected explicitly; the existing
internal execution services already use Read Committed. This restriction is
checked at SQL boundaries, not merely asserted by a service caller.
