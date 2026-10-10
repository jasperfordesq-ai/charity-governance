import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import type { RecoveryControlStore } from './recovery-operation-reservation.js';
import type { RecoveryEnvelopeContext, RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';
import type { DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import type { DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';
import { prepareDocumentByteExecutionDecisionFacts } from './document-byte-execution-decision-facts.js';
import { readPublishedDocumentByteExecutionDecision } from './published-document-byte-execution-decision.js';
import { readMatchedStartedDocumentByteDecision } from './matched-claimed-document-byte-decision.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>;

/** Record that the primary active object was observed absent after a durable
 * start marker, while the exact independent decision is still the current
 * head. This is one bounded provider observation, not an all-copy erasure
 * result: the deletion job stays PENDING, the byte fence is unchanged and the
 * result never authorizes completion. An observation after the UNKNOWN entry
 * has been published needs a separate reconciliation path. */
export async function recordVerifiedDocumentBytePrimaryAbsence(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  context: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects,
  leaseId: string, providerObservedAt: Date) {
  if (!(providerObservedAt instanceof Date) || !Number.isFinite(providerObservedAt.getTime())) {
    throw new Error('Document byte provider observation time is invalid');
  }
  const decision = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  const facts = JSON.parse(prepareDocumentByteExecutionDecisionFacts(
    JSON.parse(decision.body)).body);
  const started = await readMatchedStartedDocumentByteDecision(prisma,
    journal, control, context, keys, objects, leaseId, facts.oneUseAttemptId);
  if (started.decisionEntryDigest !== decision.entryDigest) {
    throw new Error('Document byte decision changed before provider observation');
  }
  const recorded = await prisma.$queryRaw<Array<{ recorded: boolean }>>`
    SELECT public."DocumentByteProviderObservation_recordAbsent"(${leaseId},
      ${facts.oneUseAttemptId}, ${providerObservedAt.toISOString()}::timestamptz) AS recorded`;
  if (recorded.length !== 1 || recorded[0]?.recorded !== true) {
    throw new Error('Document byte provider observation did not commit');
  }
  const after = await readMatchedStartedDocumentByteDecision(prisma,
    journal, control, context, keys, objects, leaseId, facts.oneUseAttemptId);
  if (after.decisionEntryDigest !== decision.entryDigest) {
    throw new Error('Document byte decision changed after provider observation');
  }
  const observation = await prisma.documentByteProviderObservation.findUnique({
    where: { leaseId },
  });
  if (!observation || observation.attemptId !== leaseId || observation.id !== leaseId
    || observation.providerObservedAt.getTime() < Date.parse(after.startedAttempt.startedAt)
    || observation.decisionEntryDigest !== decision.entryDigest
    || observation.outcome !== 'PRIMARY_ACTIVE_OBJECT_ABSENT'
    || observation.providerObservedAt.getTime() !== providerObservedAt.getTime()) {
    throw new Error('Document byte provider observation is unavailable or mismatched');
  }
  return { leaseId, decisionEntryDigest: decision.entryDigest,
    outcome: 'PRIMARY_ACTIVE_OBJECT_ABSENT' as const,
    providerObservedAt: observation.providerObservedAt,
    recordedAt: observation.recordedAt, actionAuthorized: false as const };
}
