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
import { readMatchedClaimedDocumentByteDecision,
  readMatchedStartedDocumentByteDecision } from './matched-claimed-document-byte-decision.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>;

/** Persist the one-use possible-I/O marker only after the current independent
 * decision still matches the claimed local lease. A crash after the marker
 * leaves an UNKNOWN attempt for reconciliation; this never calls a provider
 * or authorizes byte removal. */
export async function startVerifiedDocumentByteProviderAttempt(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  context: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects,
  leaseId: string) {
  const decision = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  const facts = JSON.parse(prepareDocumentByteExecutionDecisionFacts(
    JSON.parse(decision.body)).body);
  const claimed = await readMatchedClaimedDocumentByteDecision(prisma,
    journal, control, context, keys, objects, leaseId, facts.oneUseAttemptId);
  if (claimed.decisionEntryDigest !== decision.entryDigest) {
    throw new Error('Document byte decision changed before provider start');
  }
  const started = await prisma.$queryRaw<Array<{ started: boolean }>>`
    SELECT public."DocumentByteProviderAttempt_start"(${leaseId}, ${facts.oneUseAttemptId}) AS started`;
  if (started.length !== 1 || started[0]?.started !== true) {
    throw new Error('Document byte provider start marker did not commit');
  }
  const observed = await readMatchedStartedDocumentByteDecision(prisma,
    journal, control, context, keys, objects, leaseId, facts.oneUseAttemptId);
  if (observed.decisionEntryDigest !== decision.entryDigest) {
    throw new Error('Document byte decision changed after provider start');
  }
  return { leaseId, decisionEntryDigest: observed.decisionEntryDigest,
    startedAttempt: observed.startedAttempt, actionAuthorized: false as const };
}
