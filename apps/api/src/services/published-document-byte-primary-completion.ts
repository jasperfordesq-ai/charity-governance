import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { prepareDocumentByteProviderUnknownFacts } from './document-byte-provider-unknown.js';
import { readVerifiedDocumentByteProviderUnknown,
  type DocumentByteProviderUnknownObjects } from './document-byte-provider-unknown-envelope.js';
import { prepareDocumentBytePrimaryCompletionFacts,
  readRecordedDocumentBytePrimaryObservation } from './document-byte-primary-completion.js';
import { preserveDocumentBytePrimaryCompletion, readVerifiedDocumentBytePrimaryCompletion,
  type DocumentBytePrimaryCompletionObjects } from './document-byte-primary-completion-envelope.js';
import { readPublishedDocumentByteProviderUnknown } from './published-document-byte-provider-unknown.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';
import type { DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import type { DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>
  & DocumentByteProviderUnknownObjects & DocumentBytePrimaryCompletionObjects;
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const ATTEMPT = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function sourceFor(control: RecoveryControlStore) {
  return { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
}

type RecordedObservation = Awaited<ReturnType<typeof readRecordedDocumentBytePrimaryObservation>>;

/** The only completion body a recorded observation and a published UNKNOWN
 * can produce. Everything in it is derived; nothing is caller-supplied. */
function completionFor(context: RecoveryEnvelopeContext, local: RecordedObservation,
  unknown: { body: string; entryDigest: string; envelopeDigest: string }) {
  const marker = JSON.parse(unknown.body);
  return prepareDocumentBytePrimaryCompletionFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_COMPLETION', scope: 'PRIMARY_ACTIVE_OBJECT_ONLY',
    outcome: 'PRIMARY_ACTIVE_OBJECT_ABSENT',
    installationId: context.installationId, organisationId: context.organisationId,
    operationId: context.operationId, writerId: marker.writerId, writerEpoch: marker.writerEpoch,
    sourceRevision: marker.sourceRevision, preparationDigest: marker.preparationDigest,
    leaseId: local.leaseId, deletionId: local.deletionId,
    decisionEntryDigest: local.decisionEntryDigest,
    unknownEntryDigest: unknown.entryDigest, unknownEnvelopeDigest: unknown.envelopeDigest,
    unknownBodyDigest: hash(unknown.body),
    providerObservedAt: local.providerObservedAt.toISOString(),
    observedTransactionId: local.observedTransactionId,
    observationRecordedAt: local.observationRecordedAt.toISOString() });
}

/** Read a sixth-stage independently published primary-object completion. It
 * must be the current head, immediately follow this operation's UNKNOWN, and
 * agree with it. It certifies the primary active object only and never
 * releases the operation reservation or authorizes another provider call. */
export async function readPublishedDocumentBytePrimaryCompletion(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext), source = sourceFor(control);
  const completion = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1', source);
  const unknown = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1', source);
  const decision = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_EXECUTION_DECISION_V1', source);
  const current = await journal.inspectCurrent(source);
  // The verified history already places each stage immediately after its
  // predecessor in the same operation, so completion, UNKNOWN and decision
  // are adjacent. What remains is that all were read at one revision and the
  // completion is still the head.
  if (completion.revision !== unknown.revision || completion.revision !== decision.revision
    || current.revision !== completion.revision || current.generation !== completion.entry.generation) {
    throw new Error('Document byte completion does not follow the current exact UNKNOWN');
  }
  const [openedCompletion, openedUnknown] = await Promise.all([
    readVerifiedDocumentBytePrimaryCompletion(completion.entry.factsDigest, context, keys, objects),
    readVerifiedDocumentByteProviderUnknown(unknown.entry.factsDigest, context, keys, objects),
  ]);
  const facts = JSON.parse(prepareDocumentBytePrimaryCompletionFacts(JSON.parse(openedCompletion.body)).body);
  const marker = JSON.parse(prepareDocumentByteProviderUnknownFacts(JSON.parse(openedUnknown.body)).body);
  if (facts.unknownEntryDigest !== unknown.entry.digest
    || facts.unknownEnvelopeDigest !== unknown.entry.factsDigest
    || facts.unknownBodyDigest !== hash(openedUnknown.body)
    || marker.decisionEntryDigest !== decision.entry.digest
    || marker.decisionEnvelopeDigest !== decision.entry.factsDigest
    || facts.decisionEntryDigest !== marker.decisionEntryDigest
    || facts.leaseId !== marker.leaseId || facts.deletionId !== marker.deletionId
    || facts.observedTransactionId === marker.startedTransactionId
    || Date.parse(facts.providerObservedAt) < Date.parse(marker.startedAt)
    || Date.parse(facts.observationRecordedAt) < Date.parse(facts.providerObservedAt)) {
    throw new Error('Document byte completion does not match its authenticated UNKNOWN');
  }
  // Installation, charity, operation, writer epoch and source revision are
  // bound to the context by both envelopes. Writer and preparation are bound
  // to the reservation here, and the journal admitted the UNKNOWN only under
  // that same reservation.
  const reservation = validateRecoveryControl(await control.readControl());
  if (reservation.revision !== completion.revision
    || reservation.activeOperation?.operationId !== context.operationId
    || reservation.activeOperation.preparationDigest !== facts.preparationDigest
    || reservation.writerId !== facts.writerId || reservation.writerEpoch !== facts.writerEpoch) {
    throw new Error('Document byte completion reservation changed');
  }
  return { body: openedCompletion.body, entryDigest: completion.entry.digest,
    envelopeDigest: completion.entry.factsDigest, generation: completion.entry.generation,
    revision: completion.revision, unknownBody: openedUnknown.body,
    unknownEntryDigest: unknown.entry.digest, unknownEnvelopeDigest: unknown.entry.factsDigest,
    actionAuthorized: false as const };
}

/** Reconcile a published UNKNOWN with a recorded primary-absence observation
 * into one encrypted independent completion entry. The UNKNOWN must be the
 * current head and equal the committed local marker. A lost append
 * acknowledgement is recovered only by authenticating the already-published
 * entry against the same local facts. Nothing here changes the deletion job. */
export async function publishVerifiedDocumentBytePrimaryCompletion(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Objects, leaseId: string) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const request = { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId, leaseId };
  const local = await readRecordedDocumentBytePrimaryObservation(prisma, request);
  try {
    const already = await readPublishedDocumentBytePrimaryCompletion(journal,
      control, context, keys, objects);
    const expected = completionFor(context, local, { body: already.unknownBody,
      entryDigest: already.unknownEntryDigest, envelopeDigest: already.unknownEnvelopeDigest });
    if (already.unknownBody !== local.unknownBody || already.body !== expected.body) {
      throw new Error('Published document byte completion differs from local observation');
    }
    return { ...already, replayed: true, actionAuthorized: false as const };
  } catch (error) {
    if (error instanceof Error && error.message === 'Recovery authority history does not match its current head') {
      return resumePendingCompletion(journal, control, context, keys, objects, local);
    }
    if (!(error instanceof Error) || error.message !== 'Requested recovery entry is not published') throw error;
  }
  const unknown = await readPublishedDocumentByteProviderUnknown(journal,
    control, context, keys, objects);
  if (unknown.body !== local.unknownBody) {
    throw new Error('Published document byte UNKNOWN differs from local marker');
  }
  const facts = completionFor(context, local, unknown);
  const preserved = await preserveDocumentBytePrimaryCompletion(facts.body, context, keys, objects);
  const [localAgain, unknownAgain] = await Promise.all([
    readRecordedDocumentBytePrimaryObservation(prisma, request),
    readPublishedDocumentByteProviderUnknown(journal, control, context, keys, objects),
  ]);
  if (completionFor(context, localAgain, unknownAgain).body !== facts.body
    || unknownAgain.revision !== unknown.revision) {
    throw new Error('Document byte completion authority changed before publication');
  }
  const marker = JSON.parse(unknown.body);
  const receipt = await journal.appendReservedDocumentBytePrimaryCompletion({
    operationId: context.operationId, writerId: marker.writerId,
    writerEpoch: marker.writerEpoch, preparationDigest: marker.preparationDigest,
    unknownGeneration: unknown.generation, unknownEntryDigest: unknown.entryDigest,
    unknownEnvelopeDigest: unknown.envelopeDigest, completionEnvelopeDigest: preserved.digest,
  }, control);
  const published = await readPublishedDocumentBytePrimaryCompletion(journal,
    control, context, keys, objects);
  if (published.body !== facts.body || published.entryDigest !== receipt.digest
    || published.envelopeDigest !== preserved.digest) {
    throw new Error('Published document byte completion changed after append');
  }
  return { ...published, replayed: receipt.replayed, actionAuthorized: false as const };
}

/** The completion entry was written but the head never advanced. The
 * verified history already places it directly after this operation's UNKNOWN.
 * Resume only if that UNKNOWN equals the local marker and the pending envelope
 * is exactly the completion the local observation produces; the journal then
 * republishes that same entry. */
async function resumePendingCompletion(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, context: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Objects, local: RecordedObservation) {
  const { pending, head } = await journal.readPendingEntry(context.operationId,
    'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1', sourceFor(control));
  if (!head) throw new Error('Pending document byte completion has no UNKNOWN before it');
  const openedUnknown = await readVerifiedDocumentByteProviderUnknown(head.factsDigest, context, keys, objects);
  // The local marker is immutable, but a writer holding the keys could have
  // published a different UNKNOWN; a completion of that is never resumed.
  if (openedUnknown.body !== local.unknownBody) {
    throw new Error('Published document byte UNKNOWN differs from local marker');
  }
  const expected = completionFor(context, local, { body: openedUnknown.body,
    entryDigest: head.digest, envelopeDigest: head.factsDigest });
  const opened = await readVerifiedDocumentBytePrimaryCompletion(pending.factsDigest, context, keys, objects);
  if (opened.body !== expected.body) {
    throw new Error('Pending document byte completion differs from local observation');
  }
  const marker = JSON.parse(openedUnknown.body);
  await journal.appendReservedDocumentBytePrimaryCompletion({
    operationId: context.operationId, writerId: marker.writerId,
    writerEpoch: marker.writerEpoch, preparationDigest: marker.preparationDigest,
    unknownGeneration: head.generation, unknownEntryDigest: head.digest,
    unknownEnvelopeDigest: head.factsDigest, completionEnvelopeDigest: pending.factsDigest,
  }, control);
  const published = await readPublishedDocumentBytePrimaryCompletion(journal,
    control, context, keys, objects);
  return { ...published, replayed: true, actionAuthorized: false as const };
}

/** Apply a published completion locally: one capability-checked SQL call
 * inserts the completion row and moves the exact claimed job to PROCESSED in
 * one transaction, which the byte fence permits for nothing else. The
 * published completion is authenticated as the current head before and after.
 * A completed lease is reported again, never re-applied. The recovery
 * operation stays reserved: other copies are not covered by this. */
export async function finalizeVerifiedDocumentBytePrimaryCompletion(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects,
  leaseId: string, oneUseAttemptId: string) {
  if (!ATTEMPT.test(oneUseAttemptId)) throw new Error('Invalid document byte attempt capability');
  const context = validateRecoveryEnvelopeContext(rawContext);
  const request = { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId, leaseId };
  const published = await readPublishedDocumentBytePrimaryCompletion(journal,
    control, context, keys, objects);
  const facts = JSON.parse(published.body);
  const local = await readRecordedDocumentBytePrimaryObservation(prisma, request);
  if (facts.leaseId !== leaseId || local.unknownBody !== published.unknownBody
    || completionFor(context, local, { body: published.unknownBody,
      entryDigest: published.unknownEntryDigest,
      envelopeDigest: published.unknownEnvelopeDigest }).body !== published.body) {
    throw new Error('Published document byte completion differs from local observation');
  }
  const bodyDigest = hash(published.body);
  const existing = await prisma.documentBytePrimaryCompletion.findUnique({ where: { leaseId } });
  let replayed = existing !== null;
  if (!existing) {
    try {
      const recorded = await prisma.$queryRaw<Array<{ recorded: boolean }>>`
        SELECT public."DocumentBytePrimaryCompletion_record"(${leaseId}, ${oneUseAttemptId},
          ${published.entryDigest}, ${published.envelopeDigest}, ${bodyDigest}) AS recorded`;
      if (recorded.length !== 1 || recorded[0]?.recorded !== true) {
        throw new Error('Document byte completion did not commit');
      }
    } catch (error) {
      // An overlapping call may have completed this lease first. Its row is
      // then checked below exactly like a replay; anything else is refused.
      if (!(await prisma.documentBytePrimaryCompletion.findUnique({ where: { leaseId } }))) throw error;
      replayed = true;
    }
  }
  const after = await readPublishedDocumentBytePrimaryCompletion(journal,
    control, context, keys, objects);
  if (after.entryDigest !== published.entryDigest) {
    throw new Error('Document byte completion changed after local completion');
  }
  const row = await prisma.documentBytePrimaryCompletion.findUnique({ where: { leaseId } });
  const job = await prisma.documentStorageDeletion.findUnique({ where: { id: facts.deletionId },
    select: { organisationId: true, state: true, processedAt: true, activeObjectAbsentAt: true } });
  if (!row || row.id !== leaseId || row.leaseId !== leaseId || row.observationId !== leaseId
    || row.organisationId !== context.organisationId || row.deletionId !== facts.deletionId
    || row.decisionEntryDigest !== facts.decisionEntryDigest
    || row.completionEntryDigest !== published.entryDigest
    || row.completionEnvelopeDigest !== published.envelopeDigest
    || row.completionBodyDigest !== bodyDigest || row.scope !== 'PRIMARY_ACTIVE_OBJECT_ONLY'
    || !job || job.organisationId !== context.organisationId || job.state !== 'PROCESSED'
    || job.processedAt === null || job.processedAt.getTime() < row.recordedAt.getTime()
    || job.activeObjectAbsentAt?.getTime() !== Date.parse(facts.providerObservedAt)) {
    throw new Error('Document byte completion is unavailable or mismatched');
  }
  return { leaseId, deletionId: row.deletionId, scope: 'PRIMARY_ACTIVE_OBJECT_ONLY' as const,
    completionEntryDigest: published.entryDigest, processedAt: job.processedAt,
    replayed, operationReservationReleased: false as const, actionAuthorized: false as const };
}
