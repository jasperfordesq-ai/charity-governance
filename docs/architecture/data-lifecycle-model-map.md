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
- documents-storage: `Document`, `DocumentUploadIntent`, `DocumentControlAudit`, `DocumentVisibilityAudit`, `DocumentDownloadPreparationAudit`, `ConfluenceReference`, `DocumentStandardLink`, `DocumentStorageDeletion`, `DocumentStorageDeletionRecovery`, `DocumentStorageDeletionAttempt`, `DocumentPublication`
- registers-controls: `BoardMember`, `ConflictRecord`, `RiskRecord`, `RiskChangeAudit`, `RiskControlVerification`, `ComplaintRecord`, `GovernanceRegisterChangeAudit`, `OrganisationChangeAudit`, `FundraisingRecord`, `AnnualReportReadiness`, `FinancialControlReview`, `Member`
- calendar-minutes: `Deadline`, `DeadlineChangeAudit`, `DeadlineReminderLog`, `DeadlineReminderAudit`, `GoverningAct`, `Resolution`, `GoverningActVoid`, `MinuteBookChangeAudit`
- team-billing: `TeamInvite`, `Subscription`, `BillingCheckoutAttempt`, `StripeWebhookEvent`
- data-requests: `DataLifecycleRequest`, `DataLifecycleStorageLink`, `DataLifecycleStorageLinkWithdrawal`, `DataLifecycleDocumentLink`, `DataLifecycleDocumentLinkWithdrawal`, `DataLifecycleReviewEvent`, `DataLifecycleTargetEvent`, `DataLifecycleResponseEvent`, `DataLifecycleCoverageEvent`, `DataRetentionPolicyRevision`, `DataRetentionPolicyWithdrawal`, `DocumentPurgeAuthorization`, `DocumentPurgeAuthorizationWithdrawal`, `DocumentPurgeClaim`, `DocumentPurgeDispositionEvent`
- platform-operators: `PlatformOperator`, `PlatformOperatorRecoveryCode`, `PlatformOperatorSession`, `OperatorActionApproval`
<!-- MODEL_INVENTORY_END -->

| Group | Existing mechanism and boundary to resolve |
| --- | --- |
| Organisation and authentication | Sessions can be revoked. Eligible password-recovery and security-email delivery rows have a narrow seven-day operational cleanup after terminal and alert conditions. That rule does not dispose of users, integration credentials, security history, provider mail, logs or backups. |
| Reference and compliance | Standards and principles are reference material. Compliance records, sign-offs and immutable approved snapshots retain governance evidence; report-preparation events record only preparation. Snapshot, audit and downloaded-copy retention remain undecided. |
| Documents and storage | Ordinary Vault deletion hard-removes only an unheld draft row, queues primary-object cleanup and retains audit/outbox evidence. Dead-letter recovery retries cleanup; it does not restore the document. Confluence copies use a separate explicit erasure request. No trash state, class recovery window, version purge or backup expiry is established. |
| Registers and controls | Individual live-record removals vary; metadata-only action histories and control verifications can outlive live rows. The legacy statutory-member deletion date is no longer derived or exposed as an approved deadline. Per-class holds and disposal remain unapproved. |
| Calendar and Minute Book | Deadline and Minute Book changes have retained histories; removed governing acts retain restricted snapshots. Reminder delivery has operational records and, after migration 46, a metadata-only append-only status/reconciliation transition history. Earlier reminder transitions cannot be reconstructed. No class expiry or recovery path is approved. |
| Team and billing | Invitations have revocation and reissue states. Stripe and local billing records have separate custody and accounting obligations. No broad tenant-closure purge rule is approved. |
| Data requests | Intake, review events, reviewer-entered response targets, evidence-backed reviewer-recorded actual sent times, source-area coverage assessments and evidence associations are retained as an unresolved case history. Each source area is unreviewed until assessed; an assessment does not prove every subject record was found or erased. Past targets have a separate attention queue until an actual response is recorded; targets are not computed statutory deadlines. An actual sent time is not independent delivery proof, a retention-expiry calculation or case closure. A link or technical deletion outcome is not a lawful disposition or complete erasure receipt. |
| Platform operators | Operator credentials, recovery codes, sessions and action approvals are a separate platform control plane; charity Member access does not govern them. Their retention and recovery need their own policy and operational evidence. |

Before approving a schedule, map each group to its purpose, retention anchor and
period, legal-hold exception, deletion owner, recovery window, downstream copies,
backup expiry and proof method. The model check proves only that schema names are
accounted for; it cannot verify any of those decisions or a deployed tenant.
