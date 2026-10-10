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
import { readCommittedDocumentByteProviderUnknown } from './document-byte-provider-unknown.js';
import { readPublishedDocumentByteProviderUnknown } from './published-document-byte-provider-unknown.js';
import type { DocumentByteProviderUnknownObjects } from './document-byte-provider-unknown-envelope.js';

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

/** Reconciliation after a crash: once the independent UNKNOWN is the current
 * head, record a later primary-absence observation only while that published
 * UNKNOWN still equals the committed local marker on both sides of the call.
 * The one-use capability is checked by SQL against the claimed lease. The
 * UNKNOWN stays the head, and nothing here retries, finalizes or authorizes. */
export async function recordReconciledDocumentBytePrimaryAbsence(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  context: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Objects & DocumentByteProviderUnknownObjects,
  leaseId: string, oneUseAttemptId: string, providerObservedAt: Date) {
  if (!(providerObservedAt instanceof Date) || !Number.isFinite(providerObservedAt.getTime())) {
    throw new Error('Document byte provider observation time is invalid');
  }
  const request = { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId, leaseId };
  const readBoth = async () => {
    const published = await readPublishedDocumentByteProviderUnknown(journal,
      control, context, keys, objects);
    const local = await readCommittedDocumentByteProviderUnknown(prisma, request);
    if (published.body !== local.body) {
      throw new Error('Published document byte UNKNOWN differs from local marker');
    }
    return published;
  };
  const before = await readBoth();
  const facts = JSON.parse(before.body);
  const recorded = await prisma.$queryRaw<Array<{ recorded: boolean }>>`
    SELECT public."DocumentByteProviderObservation_recordAbsent"(${leaseId},
      ${oneUseAttemptId}, ${providerObservedAt.toISOString()}::timestamptz) AS recorded`;
  if (recorded.length !== 1 || recorded[0]?.recorded !== true) {
    throw new Error('Document byte provider observation did not commit');
  }
  // Re-authenticating the head is the after-check: it must still be this
  // operation's only UNKNOWN entry and equal the committed local marker.
  const after = await readBoth();
  const observation = await prisma.documentByteProviderObservation.findUnique({
    where: { leaseId },
  });
  if (!observation || observation.attemptId !== leaseId || observation.id !== leaseId
    || observation.deletionId !== facts.deletionId
    || observation.decisionEntryDigest !== facts.decisionEntryDigest
    || observation.outcome !== 'PRIMARY_ACTIVE_OBJECT_ABSENT'
    || observation.providerObservedAt.getTime() < Date.parse(facts.startedAt)
    || observation.providerObservedAt.getTime() !== providerObservedAt.getTime()) {
    throw new Error('Document byte provider observation is unavailable or mismatched');
  }
  return { leaseId, unknownEntryDigest: after.entryDigest,
    decisionEntryDigest: facts.decisionEntryDigest as string,
    outcome: 'PRIMARY_ACTIVE_OBJECT_ABSENT' as const,
    providerObservedAt: observation.providerObservedAt,
    recordedAt: observation.recordedAt, actionAuthorized: false as const };
}
