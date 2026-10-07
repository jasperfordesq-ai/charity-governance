import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { prepareDocumentByteProviderUnknownFacts,
  readCommittedDocumentByteProviderUnknown } from './document-byte-provider-unknown.js';
import { preserveDocumentByteProviderUnknown,
  readVerifiedDocumentByteProviderUnknown,
  type DocumentByteProviderUnknownObjects } from './document-byte-provider-unknown-envelope.js';
import { prepareDocumentByteExecutionDecisionFacts } from './document-byte-execution-decision-facts.js';
import { readVerifiedDocumentByteExecutionDecision,
  type DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';
import { prepareDocumentBytePermitFacts } from './document-byte-permit-facts.js';
import { readVerifiedDocumentBytePermit, type DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import { readPublishedDocumentByteExecutionDecision } from './published-document-byte-execution-decision.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>
  & DocumentByteProviderUnknownObjects;
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

function sourceFor(control: RecoveryControlStore) {
  return { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
}

/** Read a fifth-stage independently published uncertainty, including its
 * authenticated decision and candidate lineage. This is neither a provider
 * result nor authority to retry or finalize a deletion. */
export async function readPublishedDocumentByteProviderUnknown(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext), source = sourceFor(control);
  const unknown = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1', source);
  const decision = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_EXECUTION_DECISION_V1', source);
  const candidate = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_PERMIT_V1', source);
  const current = await journal.inspectCurrent(source);
  if (unknown.revision !== decision.revision || unknown.revision !== candidate.revision
    || current.revision !== unknown.revision || current.generation !== unknown.entry.generation
    || current.digest !== unknown.entry.digest
    || unknown.entry.previousDigest !== decision.entry.digest
    || unknown.entry.generation !== decision.entry.generation + 1
    || decision.entry.previousDigest !== candidate.entry.digest
    || decision.entry.generation !== candidate.entry.generation + 1) {
    throw new Error('Document byte UNKNOWN does not follow the current exact decision');
  }
  const [openedUnknown, openedDecision, openedCandidate] = await Promise.all([
    readVerifiedDocumentByteProviderUnknown(unknown.entry.factsDigest, context, keys, objects),
    readVerifiedDocumentByteExecutionDecision(decision.entry.factsDigest, context, keys, objects),
    readVerifiedDocumentBytePermit(candidate.entry.factsDigest, context, keys, objects),
  ]);
  const facts = JSON.parse(prepareDocumentByteProviderUnknownFacts(JSON.parse(openedUnknown.body)).body);
  const prior = JSON.parse(prepareDocumentByteExecutionDecisionFacts(JSON.parse(openedDecision.body)).body);
  const candidateFacts = JSON.parse(prepareDocumentBytePermitFacts(JSON.parse(openedCandidate.body)).body);
  if (facts.decisionEntryDigest !== decision.entry.digest
    || facts.decisionEnvelopeDigest !== decision.entry.factsDigest
    || facts.decisionBodyDigest !== hash(openedDecision.body)
    || facts.installationId !== context.installationId
    || facts.organisationId !== context.organisationId || facts.operationId !== context.operationId
    || facts.writerId !== prior.writerId || facts.writerEpoch !== prior.writerEpoch
    || facts.sourceRevision !== prior.sourceRevision
    || facts.preparationDigest !== prior.preparationDigest
    || facts.deletionId !== prior.deletionId
    || prior.candidateBodyDigest !== hash(openedCandidate.body)
    || prior.candidateEntryDigest !== candidate.entry.digest
    || prior.candidateEnvelopeDigest !== candidate.entry.factsDigest
    || prior.candidateGeneration !== candidate.entry.generation
    || prior.candidateAuthorityDigest !== candidateFacts.currentAuthorityDigest
    || prior.installationId !== candidateFacts.installationId
    || prior.organisationId !== candidateFacts.organisationId
    || prior.operationId !== candidateFacts.operationId
    || prior.writerId !== candidateFacts.writerId
    || prior.writerEpoch !== candidateFacts.writerEpoch
    || prior.sourceRevision !== candidateFacts.sourceRevision
    || prior.preparationDigest !== candidateFacts.preparationDigest
    || prior.outcomeId !== candidateFacts.outcomeId
    || prior.claimId !== candidateFacts.claimId
    || prior.deletionId !== candidateFacts.deletionId
    || prior.authorizationId !== candidateFacts.authorizationId
    || prior.documentId !== candidateFacts.documentId
    || prior.actorUserId !== candidateFacts.actorUserId
    || prior.provider !== candidateFacts.provider
    || prior.storagePath !== candidateFacts.storagePath
    || prior.objectSha256 !== candidateFacts.objectSha256
    || prior.fileSize !== candidateFacts.fileSize) {
    throw new Error('Document byte UNKNOWN does not match its authenticated decision');
  }
  const reservation = validateRecoveryControl(await control.readControl());
  if (reservation.revision !== unknown.revision
    || reservation.activeOperation?.operationId !== context.operationId
    || reservation.activeOperation.preparationDigest !== facts.preparationDigest
    || reservation.writerId !== facts.writerId || reservation.writerEpoch !== facts.writerEpoch) {
    throw new Error('Document byte UNKNOWN reservation changed');
  }
  return { body: openedUnknown.body, entryDigest: unknown.entry.digest,
    envelopeDigest: unknown.entry.factsDigest, generation: unknown.entry.generation,
    revision: unknown.revision, actionAuthorized: false as const };
}

/** Convert a committed one-use SQL start marker into a fifth-stage durable
 * independent UNKNOWN. A lost append acknowledgement is recovered only by
 * authenticating the already-published current entry and the same local
 * marker. No provider call, retry or final disposition is performed. */
export async function publishVerifiedDocumentByteProviderUnknown(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Objects, leaseId: string) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const request = { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId, leaseId };
  const local = await readCommittedDocumentByteProviderUnknown(prisma, request);
  try {
    const already = await readPublishedDocumentByteProviderUnknown(journal,
      control, context, keys, objects);
    if (already.body !== local.body) throw new Error('Published document byte UNKNOWN differs from local marker');
    return { ...already, replayed: true, actionAuthorized: false as const };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Requested recovery entry is not published') throw error;
  }
  const decision = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  const facts = JSON.parse(local.body);
  if (facts.decisionEntryDigest !== decision.entryDigest
    || facts.decisionEnvelopeDigest !== decision.envelopeDigest
    || facts.decisionBodyDigest !== hash(decision.body)
    || facts.writerEpoch !== context.writerEpoch
    || facts.sourceRevision !== context.sourceRevision) {
    throw new Error('Committed document byte UNKNOWN differs from current independent decision');
  }
  const preserved = await preserveDocumentByteProviderUnknown(local.body, context, keys, objects);
  const [localAgain, decisionAgain] = await Promise.all([
    readCommittedDocumentByteProviderUnknown(prisma, request),
    readPublishedDocumentByteExecutionDecision(journal, control, context, keys, objects),
  ]);
  if (localAgain.body !== local.body || decisionAgain.entryDigest !== decision.entryDigest
    || decisionAgain.revision !== decision.revision) {
    throw new Error('Document byte UNKNOWN authority changed before publication');
  }
  const receipt = await journal.appendReservedDocumentByteProviderUnknown({
    operationId: context.operationId, writerId: facts.writerId,
    writerEpoch: facts.writerEpoch, preparationDigest: facts.preparationDigest,
    decisionGeneration: decision.generation, decisionEntryDigest: decision.entryDigest,
    decisionEnvelopeDigest: decision.envelopeDigest,
    unknownEnvelopeDigest: preserved.digest,
  }, control);
  const published = await readPublishedDocumentByteProviderUnknown(journal,
    control, context, keys, objects);
  if (published.body !== local.body || published.entryDigest !== receipt.digest
    || published.envelopeDigest !== preserved.digest) {
    throw new Error('Published document byte UNKNOWN changed after append');
  }
  return { ...published, replayed: receipt.replayed, actionAuthorized: false as const };
}
