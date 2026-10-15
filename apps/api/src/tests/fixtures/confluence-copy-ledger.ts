import { prepareConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_TABLES } from '../../services/confluence-copy-ledger-snapshot.js';
import { prepareConfluenceCopyRecoveryFacts } from '../../services/confluence-copy-recovery-facts.js';
import { states } from './confluence-copy-decision-history.js';
import { recoveryContextFixture as context } from './confluence-copy-recovery-facts.js';

export function ledgerFixture() {
  const [first,last] = states();
  const captures = [first!,last!].map((facts,index) => {
    const prepared = prepareConfluenceCopyRecoveryFacts(facts);
    return { id: `capture-${index + 1}`, organisationId: 'org-a', reviewId: facts.review.id,
      installationId: facts.installationId, operationId: facts.operationId, writerEpoch: facts.writerEpoch,
      sourceRevision: facts.sourceRevision, actorUserId: 'owner-a', factsRevision: facts.factsRevision,
      previousFactsDigest: facts.previousFactsDigest, capturedAt: facts.capturedAt, facts: prepared.body,
      factsDigest: prepared.digest, recordedAt: facts.capturedAt };
  });
  const tables: Record<string,Array<Record<string,unknown>>> = Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map(name => [name,[]]));
  tables.ConfluenceRetainedCopyReview = [last!.review]; tables.ConfluenceSyntheticCopyScope = [last!.scope!];
  tables.ConfluenceRetainedCopyPermission = [last!.permission!];
  tables.ConfluenceRetainedCopyReviewWithdrawal = [last!.reviewWithdrawal!];
  tables.ConfluenceRetainedCopyPermissionWithdrawal = [last!.permissionWithdrawal!];
  tables.ConfluenceCopyRecoveryCapture = captures;
  tables.ConfluenceCopyPublicationPlan = [{ id: 'plan-1', organisationId: 'org-a', captureId: 'capture-1', actorUserId: 'owner-a',
    writerId: 'writer-a', keyId: context.keyId, keyEvidenceRef: 'C01-KEY', expectedGeneration: 0, expectedDigest: null,
    recordedAt: '2026-10-15T18:05:01.000Z' }];
  tables.ConfluenceCopyPublicationReceipt = [{ id: 'receipt-1', organisationId: 'org-a', planId: 'plan-1', actorUserId: 'owner-a',
    envelopeDigest: 'b'.repeat(64), entryGeneration: 1, entryDigest: 'c'.repeat(64), verifiedHeadRevision: 'original-observation',
    recordedAt: '2026-10-15T18:05:02.000Z' }];
  const raw = { format: 1, kind: 'CONFLUENCE_COPY_LOCAL_LEDGER_V1', installationId: context.installationId,
    organisationId: context.organisationId, actorUserId: 'owner-a', declaredSourceRevision: context.sourceRevision,
    capturedAt: '2026-10-15T22:00:00.000Z', tables };
  return { raw, captures, body: () => prepareConfluenceCopyLocalLedger(raw).body };
}
