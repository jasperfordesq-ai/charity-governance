import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import type { RecoveryControlStore } from './recovery-operation-reservation.js';
import type { RecoveryEnvelopeContext, RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';
import type { DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import type { DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';
import { prepareDocumentByteExecutionDecisionFacts } from './document-byte-execution-decision-facts.js';
import { readClaimedDocumentByteAuthority } from './document-byte-authority-projection.js';
import { readPublishedDocumentByteExecutionDecision } from './published-document-byte-execution-decision.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>;
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

/** Compare the consumed local SQL lease with the authenticated current final
 * decision on both sides of the serializable local reads. The lease and
 * independent journal cannot share one transaction: this observation is
 * deliberately not a provider I/O permit. A future worker needs its own
 * immediate pre-provider check and UNKNOWN-result state machine. */
export async function readMatchedClaimedDocumentByteDecision(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  context: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects,
  leaseId: string, oneUseAttemptId: string) {
  const first = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  const facts = JSON.parse(prepareDocumentByteExecutionDecisionFacts(JSON.parse(first.body)).body);
  if (facts.oneUseAttemptId !== oneUseAttemptId) {
    throw new Error('Document byte decision attempt differs from claimed capability');
  }
  const scope = { installationId: facts.installationId,
    organisationId: facts.organisationId, operationId: facts.operationId,
    leaseId, oneUseAttemptId };
  const local = await readClaimedDocumentByteAuthority(prisma, scope);
  const lease = local.claimedLease;
  if (lease.decisionEntryDigest !== first.entryDigest
    || lease.decisionEnvelopeDigest !== first.envelopeDigest
    || lease.decisionBodyDigest !== hash(first.body)
    || lease.candidateEntryDigest !== facts.candidateEntryDigest
    || lease.candidateEnvelopeDigest !== facts.candidateEnvelopeDigest
    || lease.outcomeEntryDigest !== JSON.parse(first.candidateBody).outcomeEntryDigest
    || lease.providerInventoryDigest !== facts.providerInventoryDigest
    || lease.provider !== facts.provider || lease.storagePath !== facts.storagePath
    || lease.objectSha256 !== facts.objectSha256 || lease.fileSize !== facts.fileSize
    || local.localCopyObservationDigest !== facts.copyDispositionDigest
    || local.localHoldObservationDigest !== facts.holdStateDigest) {
    throw new Error('Claimed document byte lease differs from current independent decision');
  }
  const localAgain = await readClaimedDocumentByteAuthority(prisma, scope);
  const second = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  if (second.body !== first.body || second.candidateBody !== first.candidateBody
    || second.entryDigest !== first.entryDigest
    || second.envelopeDigest !== first.envelopeDigest
    || second.generation !== first.generation || second.revision !== first.revision
    || JSON.stringify(localAgain) !== JSON.stringify(local)) {
    throw new Error('Claimed document byte decision or local authority changed while reading');
  }
  return { decisionEntryDigest: first.entryDigest,
    localAuthorityDigest: local.digest, actionAuthorized: false as const };
}
