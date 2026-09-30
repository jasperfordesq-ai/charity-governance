import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RecoveryAuthorityJournal, type AuthorityHeadSource } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { readVerifiedRecoveryPreparation, validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys, type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import { readVerifiedHoldPreparation, type HoldPreparationObjects } from './hold-recovery-envelope.js';
import { openCancellation, readVerifiedCancellation, type CancellationObjects, type CancellationOperationKind } from './cancellation-envelope.js';

type Objects = Pick<RecoveryEnvelopeObjects, 'readReplay'> & Pick<HoldPreparationObjects, 'readHoldPreparation'>
  & Pick<CancellationObjects, 'readCancellation'>;
const kindSchema = z.enum(['PRIMARY', 'HOLD']);
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const prepare = (kind: CancellationOperationKind, digest: string, context: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) => kind === 'PRIMARY'
  ? readVerifiedRecoveryPreparation(digest, context, keys, objects)
  : readVerifiedHoldPreparation(digest, context, keys, objects);
function matches(prepared: string, cancelled: string) {
  const prep = JSON.parse(prepared), facts = JSON.parse(cancelled);
  return facts.preparationDigest === hash(prepared) && facts.complaintId === prep.complaint.id;
}

/** Authenticate the original preparation and cancellation before publishing a
 * terminal pair. Local commit provenance is checked separately before release. */
export async function publishVerifiedCancellation(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  request: { operationKind: CancellationOperationKind; writerId: string; preparationDigest: string;
    preparationGeneration: number; preparationEntryDigest: string; preparationEnvelopeDigest: string },
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext), kind = kindSchema.parse(request.operationKind);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) throw new Error('Cancellation reservation mismatch');
  const prepared = await prepare(kind, request.preparationEnvelopeDigest, context, keys, objects);
  if (hash(prepared.body) !== request.preparationDigest) throw new Error('Cancellation preparation facts mismatch');
  const envelope = await objects.readCancellation(context.operationId);
  if (envelope === null) throw new Error('Cancellation candidate is missing');
  const opened = await openCancellation(envelope, context, kind, keys);
  if (!matches(prepared.body, opened.body) || JSON.parse(opened.body).writerId !== request.writerId) {
    throw new Error('Cancellation does not match its preparation or writer');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Cancellation control changed during verification');
  const terminal = { operationId: context.operationId, writerEpoch: context.writerEpoch,
    writerId: request.writerId, preparationDigest: request.preparationDigest,
    preparationGeneration: request.preparationGeneration, preparationEntryDigest: request.preparationEntryDigest,
    preparationEnvelopeDigest: request.preparationEnvelopeDigest, outcomeEnvelopeDigest: hash(envelope) };
  return kind === 'PRIMARY' ? journal.appendReservedComplaintCancellation(terminal, control)
    : journal.appendReservedHoldCancellation(terminal, control);
}

/** Current independent evidence only; no mutation, release or reopen permit. */
export async function readPublishedCancellation(journal: RecoveryAuthorityJournal, source: AuthorityHeadSource,
  rawContext: RecoveryEnvelopeContext, operationKind: CancellationOperationKind, keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext), kind = kindSchema.parse(operationKind);
  const cancelled = await journal.readPublishedEntry(context.operationId,
    kind === 'PRIMARY' ? 'COMPLAINT_CANCELLATION_V1' : 'COMPLAINT_HOLD_CANCELLATION_V1', source);
  const preparation = await journal.readPublishedEntry(context.operationId,
    kind === 'PRIMARY' ? 'COMPLAINT_PREPARATION_V1' : 'COMPLAINT_HOLD_PREPARATION_V1', source);
  if (cancelled.revision !== preparation.revision || cancelled.entry.previousDigest !== preparation.entry.digest
    || cancelled.entry.generation !== preparation.entry.generation + 1
    || cancelled.entry.installationId !== context.installationId || cancelled.entry.organisationId !== context.organisationId) {
    throw new Error('Published cancellation pair mismatch');
  }
  const prepared = await prepare(kind, preparation.entry.factsDigest, context, keys, objects);
  const opened = await readVerifiedCancellation(cancelled.entry.factsDigest, context, kind, keys, objects);
  if (!matches(prepared.body, opened.body)) throw new Error('Published cancellation facts mismatch');
  const after = await journal.inspectCurrent(source);
  if (after.revision !== cancelled.revision) throw new Error('Authority changed while reading cancellation');
  return { body: opened.body, preparationBody: prepared.body, entryDigest: cancelled.entry.digest,
    envelopeDigest: cancelled.entry.factsDigest, revision: after.revision, actionAuthorized: false as const };
}
