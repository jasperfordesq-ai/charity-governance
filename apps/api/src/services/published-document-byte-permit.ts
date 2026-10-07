import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { readVerifiedDocumentRecoveryPreparation,
  type DocumentRecoveryObjects } from './document-recovery-envelope.js';
import { readVerifiedDocumentOutcome,
  type DocumentOutcomeObjects } from './document-outcome-envelope.js';
import { readVerifiedDocumentBytePermit,
  openDocumentBytePermit, preserveDocumentBytePermit,
  type DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import { prepareDocumentBytePermitFacts } from './document-byte-permit-facts.js';
import { readCurrentDocumentByteAuthority } from './document-byte-authority-projection.js';
import { readPublishedDocumentOutcome } from './published-document-outcome.js';

const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>;
type PublishObjects = Objects & Pick<DocumentBytePermitObjects, 'createDocumentBytePermit'>;

/** Bind a candidate derived from the authenticated committed claim and a
 * current local fact projection. The journal entry is deliberately inert:
 * this does not assess all copies, create a database permit, or authorize a
 * worker. An unknown append result keeps the same operation and candidate. */
export async function publishVerifiedDocumentBytePermitCandidate(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: PublishObjects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const localScope = { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId };
  const outcome = await readPublishedDocumentOutcome(journal, control, context, keys, objects);
  const claim = JSON.parse(outcome.body), prep = JSON.parse(outcome.preparationBody);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId
    || before.organisationId !== context.organisationId
    || before.writerId !== claim.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== claim.preparationDigest
    || claim.writerEpoch !== context.writerEpoch
    || claim.preparationSourceRevision !== context.sourceRevision) {
    throw new Error('Document byte permit reservation or claim changed');
  }
  // An acknowledgement can be lost after the independent CAS. Retry only by
  // authenticating the already-published entry and current local authority.
  if (before.generation === outcome.generation + 1) {
    const matched = await readMatchedDocumentBytePermitAuthority(prisma,
      journal, control, context, keys, objects);
    return { ...matched, replayed: true, actionAuthorized: false as const };
  }
  if (before.generation !== outcome.generation || before.digest !== outcome.entryDigest
    || before.revision !== outcome.revision) {
    throw new Error('Document byte permit predecessor is not current');
  }
  const first = await readCurrentDocumentByteAuthority(prisma, localScope);
  const existing = await objects.readDocumentBytePermit(context.operationId);
  const issuedAt = existing === null ? new Date().toISOString()
    : JSON.parse((await openDocumentBytePermit(existing, context, keys)).body).issuedAt;
  const candidate = prepareDocumentBytePermitFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_PERMIT_CANDIDATE',
    ...localScope, writerId: claim.writerId, writerEpoch: context.writerEpoch,
    sourceRevision: context.sourceRevision,
    preparationDigest: claim.preparationDigest,
    preparationEntryDigest: outcome.preparationEntryDigest,
    preparationEnvelopeDigest: outcome.preparationEnvelopeDigest,
    preparationGeneration: outcome.preparationGeneration,
    outcomeBodyDigest: hash(outcome.body), outcomeEntryDigest: outcome.entryDigest,
    outcomeEnvelopeDigest: outcome.envelopeDigest,
    outcomeGeneration: outcome.generation, controlRevision: before.revision,
    currentAuthorityDigest: first.digest,
    outcomeId: claim.outcomeId, claimId: claim.claimId, deletionId: claim.deletionId,
    authorizationId: claim.authorizationId, documentId: claim.documentId,
    actorUserId: claim.actorUserId, provider: prep.authorization.provider,
    storagePath: prep.authorization.storagePath,
    objectSha256: prep.authorization.sha256, fileSize: prep.authorization.fileSize,
    issuedAt });
  const preserved = await preserveDocumentBytePermit(candidate.body, context, keys, objects);
  const opened = await readVerifiedDocumentBytePermit(preserved.digest, context, keys, objects);
  if (opened.body !== candidate.body) throw new Error('Document byte permit candidate changed');
  const [outcomeAgain, second] = await Promise.all([
    readPublishedDocumentOutcome(journal, control, context, keys, objects),
    readCurrentDocumentByteAuthority(prisma, localScope),
  ]);
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(outcomeAgain) !== JSON.stringify(outcome)
    || JSON.stringify(after) !== JSON.stringify(before)
    || second.digest !== first.digest) {
    throw new Error('Document byte permit authority changed before publication');
  }
  const receipt = await journal.appendReservedDocumentBytePermit({
    operationId: context.operationId, writerId: claim.writerId,
    writerEpoch: context.writerEpoch, preparationDigest: claim.preparationDigest,
    outcomeGeneration: outcome.generation, outcomeEntryDigest: outcome.entryDigest,
    outcomeEnvelopeDigest: outcome.envelopeDigest,
    permitEnvelopeDigest: preserved.digest,
  }, control);
  const published = await readPublishedDocumentBytePermit(journal, control,
    context, keys, objects);
  if (published.body !== candidate.body || published.envelopeDigest !== preserved.digest
    || published.entryDigest !== receipt.digest) {
    throw new Error('Published document byte permit did not match the candidate');
  }
  const matched = await readMatchedDocumentBytePermitAuthority(prisma,
    journal, control, context, keys, objects);
  return { ...matched, replayed: receipt.replayed, actionAuthorized: false as const };
}

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

type PublishedRead = Awaited<ReturnType<typeof readPublishedDocumentBytePermit>>;
type LocalRead = Awaited<ReturnType<typeof readCurrentDocumentByteAuthority>>;

/** Bracket a local observation with authenticated independent reads, then
 * recheck the local facts. This is a comparison, never a byte-execution
 * permit: the database transition and worker must repeat current checks. */
export async function compareDocumentBytePermitAuthority(
  readPublished: () => Promise<PublishedRead>, readLocal: () => Promise<LocalRead>) {
  const before = await readPublished();
  const facts = JSON.parse(prepareDocumentBytePermitFacts(JSON.parse(before.body)).body);
  const first = await readLocal();
  if (first.digest !== facts.currentAuthorityDigest) {
    throw new Error('Published document byte permit differs from current local authority');
  }
  const after = await readPublished();
  if (after.revision !== before.revision || after.entryDigest !== before.entryDigest
    || after.envelopeDigest !== before.envelopeDigest || after.body !== before.body) {
    throw new Error('Published document byte permit changed during local authority read');
  }
  const second = await readLocal();
  if (second.digest !== first.digest) {
    throw new Error('Document byte authority changed during independent permit read');
  }
  return { currentAuthorityDigest: second.digest, entryDigest: after.entryDigest,
    revision: after.revision, actionAuthorized: false as const };
}

/** Fixed production composition: callers cannot substitute an unauthenticated
 * independent read or a fabricated local projection. */
export async function readMatchedDocumentBytePermitAuthority(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  context: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects) {
  const localScope = { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId };
  return compareDocumentBytePermitAuthority(
    () => readPublishedDocumentBytePermit(journal, control, context, keys, objects),
    () => readCurrentDocumentByteAuthority(prisma, localScope));
}
