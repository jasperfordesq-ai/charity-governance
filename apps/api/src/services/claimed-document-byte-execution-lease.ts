import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import type { RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';
import type { DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import type { DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';
import { prepareDocumentByteExecutionDecisionFacts } from './document-byte-execution-decision-facts.js';
import { readCurrentDocumentByteAuthority,
  withCurrentDocumentByteAuthorityTransaction } from './document-byte-authority-projection.js';
import { readPublishedDocumentByteExecutionDecision } from './published-document-byte-execution-decision.js';
import { readMatchedClaimedDocumentByteDecision } from './matched-claimed-document-byte-decision.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>;
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

/** Privileged, one-use SQL claim after a separately published independent
 * final decision. The same transaction inserts and consumes the lease; a
 * deferred database constraint refuses an unused READY lease. This does not
 * call a provider or authorize bytes. A changed independent head after
 * commit leaves the claimed job quarantined for review, never released. */
export async function claimVerifiedDocumentByteExecutionLease(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const scope = { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId };
  const before = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  const facts = JSON.parse(prepareDocumentByteExecutionDecisionFacts(JSON.parse(before.body)).body);
  const candidate = JSON.parse(before.candidateBody) as { outcomeEntryDigest: string };
  const firstLocal = await readCurrentDocumentByteAuthority(prisma, scope);
  if (firstLocal.localCopyObservationDigest !== facts.copyDispositionDigest
    || firstLocal.localHoldObservationDigest !== facts.holdStateDigest) {
    throw new Error('Document byte final decision differs from current copy or hold facts');
  }
  const beforeAgain = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  if (JSON.stringify(beforeAgain) !== JSON.stringify(before)) {
    throw new Error('Document byte final decision changed before SQL claim');
  }
  const recorded = await withCurrentDocumentByteAuthorityTransaction(prisma,
    scope, async (tx, local) => {
      if (local.localCopyObservationDigest !== facts.copyDispositionDigest
        || local.localHoldObservationDigest !== facts.holdStateDigest
        || local.digest !== firstLocal.digest) {
        throw new Error('Document byte local authority changed before SQL claim');
      }
      const binding = await tx.documentBytePermitCandidateBinding.findUnique({
        where: { organisationId_operationId: {
          organisationId: scope.organisationId, operationId: scope.operationId } },
      });
      if (!binding || binding.installationId !== scope.installationId
        || binding.organisationId !== scope.organisationId
        || binding.operationId !== scope.operationId
        || binding.writerId !== facts.writerId || binding.writerEpoch !== facts.writerEpoch
        || binding.permitEntryDigest !== facts.candidateEntryDigest
        || binding.permitEnvelopeDigest !== facts.candidateEnvelopeDigest
        || binding.outcomeEntryDigest !== candidate.outcomeEntryDigest
        || binding.controlRevision !== facts.controlRevision
        || binding.currentAuthorityDigest !== facts.candidateAuthorityDigest
        || binding.outcomeId !== facts.outcomeId
        || binding.deletionId !== facts.deletionId || binding.claimId !== facts.claimId
        || binding.provider !== facts.provider || binding.storagePath !== facts.storagePath
        || binding.objectSha256 !== facts.objectSha256 || binding.fileSize !== facts.fileSize) {
        throw new Error('Document byte candidate binding differs from final decision');
      }
      const lease = await tx.documentByteExecutionLease.create({ data: {
        organisationId: scope.organisationId, candidateBindingId: binding.id,
        deletionId: facts.deletionId, decisionEntryDigest: before.entryDigest,
        decisionEnvelopeDigest: before.envelopeDigest,
        decisionBodyDigest: hash(before.body),
        localCopyObservationDigest: local.localCopyObservationDigest,
        localHoldObservationDigest: local.localHoldObservationDigest,
        providerInventoryDigest: facts.providerInventoryDigest,
        attemptHash: hash(facts.oneUseAttemptId),
      }, select: { id: true } });
      const claimed = await tx.$queryRaw<Array<{ claimed: boolean }>>`
        SELECT public."DocumentByteExecutionLease_claim"(${lease.id}, ${facts.oneUseAttemptId}) AS claimed`;
      if (claimed.length !== 1 || claimed[0]?.claimed !== true) {
        throw new Error('Document byte lease SQL claim did not complete');
      }
      return lease.id;
    });
  const matched = await readMatchedClaimedDocumentByteDecision(prisma,
    journal, control, context, keys, objects, recorded, facts.oneUseAttemptId);
  if (matched.decisionEntryDigest !== before.entryDigest) {
    throw new Error('Claimed document byte decision changed after SQL commit');
  }
  return { leaseId: recorded, decisionEntryDigest: matched.decisionEntryDigest,
    actionAuthorized: false as const };
}
