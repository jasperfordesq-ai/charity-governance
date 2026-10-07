import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { prepareDocumentBytePermitFacts } from './document-byte-permit-facts.js';
import { prepareDocumentByteExecutionDecisionFacts } from './document-byte-execution-decision-facts.js';
import { readVerifiedDocumentByteExecutionDecision,
  type DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';
import { readPublishedDocumentBytePermit } from './published-document-byte-permit.js';
import type { DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>;
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

/** Authenticate the fourth entry, its encrypted body and its exact candidate
 * predecessor against one current independent head. Copy inventory, policy,
 * current local facts and a one-use SQL lease are separate checks. This read
 * never authorizes bytes, even when all fields and hashes match. */
export async function readPublishedDocumentByteExecutionDecision(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const final = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_EXECUTION_DECISION_V1', source);
  const candidate = await readPublishedDocumentBytePermit(journal, control, context, keys, objects);
  if (final.revision !== candidate.revision
    || final.entry.previousDigest !== candidate.entryDigest
    || final.entry.generation !== candidate.generation + 1
    || final.entry.installationId !== context.installationId
    || final.entry.organisationId !== context.organisationId) {
    throw new Error('Document byte execution decision does not follow its candidate');
  }
  const opened = await readVerifiedDocumentByteExecutionDecision(final.entry.factsDigest,
    context, keys, objects);
  const facts = JSON.parse(prepareDocumentByteExecutionDecisionFacts(JSON.parse(opened.body)).body);
  const prior = JSON.parse(prepareDocumentBytePermitFacts(JSON.parse(candidate.body)).body);
  if (facts.candidateBodyDigest !== hash(candidate.body)
    || facts.candidateEntryDigest !== candidate.entryDigest
    || facts.candidateEnvelopeDigest !== candidate.envelopeDigest
    || facts.candidateGeneration !== candidate.generation
    || facts.candidateAuthorityDigest !== prior.currentAuthorityDigest
    || facts.installationId !== prior.installationId
    || facts.organisationId !== prior.organisationId || facts.operationId !== prior.operationId
    || facts.writerId !== prior.writerId || facts.writerEpoch !== prior.writerEpoch
    || facts.sourceRevision !== prior.sourceRevision
    || facts.preparationDigest !== prior.preparationDigest
    || facts.outcomeId !== prior.outcomeId || facts.claimId !== prior.claimId
    || facts.deletionId !== prior.deletionId || facts.authorizationId !== prior.authorizationId
    || facts.documentId !== prior.documentId || facts.actorUserId !== prior.actorUserId
    || facts.provider !== prior.provider || facts.storagePath !== prior.storagePath
    || facts.objectSha256 !== prior.objectSha256 || facts.fileSize !== prior.fileSize) {
    throw new Error('Document byte execution decision does not match the authenticated candidate');
  }
  const current = await journal.inspectCurrent(source);
  if (current.revision !== final.revision || current.generation !== final.entry.generation
    || current.digest !== final.entry.digest) {
    throw new Error('Document byte execution decision is not the current independent head');
  }
  const reservation = validateRecoveryControl(await control.readControl());
  if (reservation.revision !== final.revision
    || reservation.activeOperation?.operationId !== context.operationId
    || reservation.activeOperation.preparationDigest !== facts.preparationDigest
    || reservation.writerId !== facts.writerId || reservation.writerEpoch !== facts.writerEpoch) {
    throw new Error('Document byte execution decision reservation changed');
  }
  return { body: opened.body, candidateBody: candidate.body,
    entryDigest: final.entry.digest, envelopeDigest: final.entry.factsDigest,
    generation: final.entry.generation, revision: final.revision,
    actionAuthorized: false as const };
}
