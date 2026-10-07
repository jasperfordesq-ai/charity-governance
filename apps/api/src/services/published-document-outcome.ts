import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { readVerifiedDocumentRecoveryPreparation,
  type DocumentRecoveryObjects } from './document-recovery-envelope.js';
import { readCommittedDocumentOutcome } from './document-recovery-outcome.js';
import { openDocumentOutcome, readVerifiedDocumentOutcome,
  type DocumentOutcomeObjects } from './document-outcome-envelope.js';

const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
type Request = { writerId: string; preparationDigest: string; preparationGeneration: number;
  preparationEntryDigest: string; preparationEnvelopeDigest: string };
type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>;

/** Publish only the exact committed local claim result after authenticating
 * both original remote envelopes and the unchanged reserved control. This
 * neither releases the reservation nor asserts byte/copy erasure. */
export async function publishVerifiedDocumentOutcome(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, prisma: PrismaClient, request: Request,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) {
    throw new Error('Document outcome reservation does not match');
  }
  const prepared = await readVerifiedDocumentRecoveryPreparation(request.preparationEnvelopeDigest,
    context, keys, objects);
  if (hash(prepared.body) !== request.preparationDigest) {
    throw new Error('Document outcome preparation facts do not match');
  }
  const candidate = await objects.readDocumentOutcome(context.operationId);
  if (candidate === null) throw new Error('Document outcome candidate is missing');
  const opened = await openDocumentOutcome(candidate, context, keys);
  const committed = await readCommittedDocumentOutcome(prisma, {
    organisationId: context.organisationId, installationId: context.installationId,
    operationId: context.operationId });
  const facts = JSON.parse(opened.body), prep = JSON.parse(prepared.body);
  if (opened.body !== committed.body
    || facts.preparationDigest !== request.preparationDigest
    || facts.preparationGeneration !== request.preparationGeneration
    || facts.preparationEntryDigest !== request.preparationEntryDigest
    || facts.preparationEnvelopeDigest !== request.preparationEnvelopeDigest
    || facts.authorizationId !== prep.authorization.id
    || facts.documentId !== prep.document.id || facts.actorUserId !== prep.actorUserId) {
    throw new Error('Document outcome does not match committed claim and preparation');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Document recovery control changed during outcome verification');
  }
  return journal.appendReservedDocumentOutcome({ ...request, operationId: context.operationId,
    writerEpoch: context.writerEpoch, outcomeEnvelopeDigest: hash(candidate) }, control);
}

/** Independent current-history claim evidence only. It is not a deletion
 * completion receipt, a recovery permit, or a reservation release. */
export async function readPublishedDocumentOutcome(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const outcome = await journal.readPublishedEntry(context.operationId, 'DOCUMENT_OUTCOME_V1', source);
  const preparation = await journal.readPublishedEntry(context.operationId, 'DOCUMENT_PREPARATION_V1', source);
  if (outcome.revision !== preparation.revision
    || outcome.entry.previousDigest !== preparation.entry.digest
    || outcome.entry.generation !== preparation.entry.generation + 1
    || outcome.entry.installationId !== context.installationId
    || outcome.entry.organisationId !== context.organisationId) {
    throw new Error('Published document outcome pair does not match');
  }
  const prepared = await readVerifiedDocumentRecoveryPreparation(preparation.entry.factsDigest,
    context, keys, objects);
  const opened = await readVerifiedDocumentOutcome(outcome.entry.factsDigest,
    context, keys, objects);
  const prep = JSON.parse(prepared.body), facts = JSON.parse(opened.body);
  if (facts.preparationDigest !== hash(prepared.body)
    || facts.preparationGeneration !== preparation.entry.generation
    || facts.preparationEntryDigest !== preparation.entry.digest
    || facts.preparationEnvelopeDigest !== preparation.entry.factsDigest
    || facts.authorizationId !== prep.authorization.id
    || facts.documentId !== prep.document.id || facts.actorUserId !== prep.actorUserId) {
    throw new Error('Published document outcome facts do not match');
  }
  const after = await journal.inspectCurrent(source);
  if (after.revision !== outcome.revision) {
    throw new Error('Recovery authority changed while reading document outcome');
  }
  return { body: opened.body, preparationBody: prepared.body,
    entryDigest: outcome.entry.digest, envelopeDigest: outcome.entry.factsDigest,
    revision: after.revision, actionAuthorized: false as const };
}
