import { canonicalRetainedConfluenceCopyReviewEvidence, SYNTHETIC_COPY_PERMISSION_ATTESTATION } from '../../services/confluence-retained-copy-review.js';

export function recoveryFactsFixture() {
  const review = {
    scope: 'SYNTHETIC_ONLY', primaryDisposition: 'RETAIN', copyDisposition: 'PURGE', reviewerId: 'owner-a',
    evidenceRef: 'C01-REVIEW', retentionDecisionRef: 'C01-RETAIN', holdReviewRef: 'C01-HOLD',
    inventoryEvidenceRef: 'C01-INVENTORY', syntheticEvidenceRef: 'C01-SYNTHETIC',
    reviewedAt: '2026-10-15T18:00:00.000Z', expiresAt: '2026-10-15T20:00:00.000Z',
    snapshot: { organisationId: 'org-a', documentId: 'doc-a', sourceRevision: '2026-10-15T17:00:00.000Z', sourceSha256: 'a'.repeat(64),
      lifecycleStatus: 'RETIRED', deletionHold: false, externalPublicationApproved: false, publicationId: 'pub-a',
      publicationRevision: '2026-10-15T17:01:00.000Z', publicationState: 'RETIRED', cloudId: '00000000-0000-4000-8000-000000000001',
      siteOrigin: 'https://synthetic-example.atlassian.net', spaceId: 'space-a', pageId: 'page-a',
      inventory: { observedAt: '2026-10-15T17:59:00.000Z', status: 'CURRENT', complete: true,
        currentPageVersion: 1, pageVersions: [1], attachments: [] as Array<{ id: string; currentVersion: number;
          versions: Array<{ number: number; sha256: string; sizeBytes: number }> }> } },
  };
  const { snapshotSha256 } = canonicalRetainedConfluenceCopyReviewEvidence(review);
  return {
    format: 1, kind: 'CONFLUENCE_COPY_DECISION_STATE_V1', installationId: 'install-a', organisationId: 'org-a', operationId: 'state-1',
    writerEpoch: 1, sourceRevision: 'a'.repeat(40), factsRevision: 1, previousFactsDigest: null as string | null,
    capturedAt: '2026-10-15T18:05:00.000Z',
    review: { id: 'review-a', organisationId: 'org-a', documentId: 'doc-a', publicationId: 'pub-a', reviewerId: 'owner-a',
      snapshotSha256, review, reviewedAt: review.reviewedAt, expiresAt: review.expiresAt, authorisesProviderIO: false,
      recordedAt: '2026-10-15T18:00:00.000Z' },
    reviewWithdrawal: null as null | { id: string; organisationId: string; reviewId: string; actorUserId: string; evidenceRef: string; reason: string; occurredAt: string },
    scope: { id: 'scope-a', organisationId: 'org-a', reviewId: 'review-a', snapshotSha256, classification: 'SYNTHETIC_ONLY',
      evidenceRef: 'C01-SCOPE', disposalPolicyEvidenceRef: 'C01-COPY-POLICY', approvedById: 'owner-a', registeredByDbRole: 'maintenance',
      registeredAt: '2026-10-15T18:01:00.000Z', expiresAt: '2026-10-15T19:30:00.000Z' },
    permission: { id: 'permission-a', organisationId: 'org-a', reviewId: 'review-a', scopeId: 'scope-a', snapshotSha256, actorUserId: 'owner-a',
      integrationId: 'integration-a', connectionGeneration: '2026-10-15T16:00:00.000Z', evidenceRef: 'C01-PERMISSION',
      reason: 'Dispose of the exact synthetic remote copy', attestation: SYNTHETIC_COPY_PERMISSION_ATTESTATION,
      scopeEvidenceRef: 'C01-SCOPE', disposalPolicyEvidenceRef: 'C01-COPY-POLICY', classification: 'OWNER_ATTESTED_SYNTHETIC',
      issuedAt: '2026-10-15T18:02:00.000Z', expiresAt: '2026-10-15T19:00:00.000Z' },
    permissionWithdrawal: null as null | { id: string; organisationId: string; permissionId: string; actorUserId: string; evidenceRef: string; reason: string; occurredAt: string },
  };
}
export const recoveryContextFixture = { installationId: 'install-a', organisationId: 'org-a', operationId: 'state-1',
  writerEpoch: 1, sourceRevision: 'a'.repeat(40), keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111' };
