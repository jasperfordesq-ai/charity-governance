import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { readVerifiedDocumentRecoveryPreparation,
  type DocumentRecoveryObjects } from './document-recovery-envelope.js';
import { readVerifiedDocumentOutcome,
  type DocumentOutcomeObjects } from './document-outcome-envelope.js';
import { readVerifiedDocumentBytePermit,
  type DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import { prepareDocumentBytePermitFacts } from './document-byte-permit-facts.js';

const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>;

/** Authenticate the candidate against a single current independent history.
 * This does not prove current database policy/copy authority, a worker lease,
 * provider result, or permission to delete bytes. */
export async function readPublishedDocumentBytePermit(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const permit = await journal.readPublishedEntry(context.operationId, 'DOCUMENT_BYTE_PERMIT_V1', source);
  const outcome = await journal.readPublishedEntry(context.operationId, 'DOCUMENT_OUTCOME_V1', source);
  const preparation = await journal.readPublishedEntry(context.operationId, 'DOCUMENT_PREPARATION_V1', source);
  if (permit.revision !== outcome.revision || outcome.revision !== preparation.revision
    || permit.entry.previousDigest !== outcome.entry.digest
    || outcome.entry.previousDigest !== preparation.entry.digest
    || permit.entry.generation !== outcome.entry.generation + 1
    || outcome.entry.generation !== preparation.entry.generation + 1
    || [permit.entry, outcome.entry, preparation.entry].some(entry =>
      entry.installationId !== context.installationId || entry.organisationId !== context.organisationId)) {
    throw new Error('Published document byte permit chain does not match');
  }
  const prepared = await readVerifiedDocumentRecoveryPreparation(preparation.entry.factsDigest,
    context, keys, objects);
  const openedOutcome = await readVerifiedDocumentOutcome(outcome.entry.factsDigest,
    context, keys, objects);
  const openedPermit = await readVerifiedDocumentBytePermit(permit.entry.factsDigest,
    context, keys, objects);
  const facts = JSON.parse(prepareDocumentBytePermitFacts(JSON.parse(openedPermit.body)).body);
  const prep = JSON.parse(prepared.body), claim = JSON.parse(openedOutcome.body);
  if (facts.preparationDigest !== hash(prepared.body)
    || facts.preparationEntryDigest !== preparation.entry.digest
    || facts.preparationEnvelopeDigest !== preparation.entry.factsDigest
    || facts.preparationGeneration !== preparation.entry.generation
    || facts.outcomeBodyDigest !== hash(openedOutcome.body)
    || facts.outcomeEntryDigest !== outcome.entry.digest
    || facts.outcomeEnvelopeDigest !== outcome.entry.factsDigest
    || facts.outcomeGeneration !== outcome.entry.generation
    || claim.preparationDigest !== facts.preparationDigest
    || claim.preparationEntryDigest !== facts.preparationEntryDigest
    || claim.preparationEnvelopeDigest !== facts.preparationEnvelopeDigest
    || claim.preparationGeneration !== facts.preparationGeneration
    || claim.installationId !== facts.installationId
    || claim.organisationId !== facts.organisationId || claim.operationId !== facts.operationId
    || claim.writerId !== facts.writerId || claim.writerEpoch !== facts.writerEpoch
    || claim.preparationSourceRevision !== facts.sourceRevision
    || claim.outcomeId !== facts.outcomeId || claim.claimId !== facts.claimId
    || claim.deletionId !== facts.deletionId || claim.authorizationId !== facts.authorizationId
    || claim.documentId !== facts.documentId || claim.actorUserId !== facts.actorUserId
    || prep.authorization.id !== facts.authorizationId
    || prep.document.id !== facts.documentId || prep.actorUserId !== facts.actorUserId
    || prep.authorization.provider !== facts.provider
    || prep.authorization.storagePath !== facts.storagePath
    || prep.authorization.sha256 !== facts.objectSha256
    || prep.authorization.fileSize !== facts.fileSize) {
    throw new Error('Published document byte permit does not match the committed claim and target');
  }
  const after = await journal.inspectCurrent(source);
  if (after.revision !== permit.revision) {
    throw new Error('Recovery authority changed while reading document byte permit');
  }
  const current = validateRecoveryControl(await control.readControl());
  if (current.revision !== permit.revision
    || current.activeOperation?.operationId !== context.operationId
    || current.activeOperation.preparationDigest !== facts.preparationDigest
    || current.writerId !== facts.writerId || current.writerEpoch !== facts.writerEpoch) {
    throw new Error('Document byte permit reservation changed');
  }
  return { body: openedPermit.body, outcomeBody: openedOutcome.body,
    preparationBody: prepared.body, entryDigest: permit.entry.digest,
    envelopeDigest: permit.entry.factsDigest, revision: after.revision,
    actionAuthorized: false as const };
}
