import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { openRecoveryPreparation, validateRecoveryEnvelopeContext,
  type RecoveryEnvelopeContext, type RecoveryDataKeys, type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';

/** Publish an existing candidate only after authenticated decryption proves the
 * reserved facts. Never recreate missing bytes, even on a publication retry.
 * This joins evidence boundaries; it does not authorize database execution. */
export async function publishVerifiedComplaintPreparation(
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  request: { writerId: string; preparationDigest: string; expectedGeneration: number; expectedDigest: string | null },
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<RecoveryEnvelopeObjects, 'readReplay'>,
) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) {
    throw new Error('Recovery publication reservation does not match');
  }
  const envelope = await objects.readReplay(context.operationId);
  if (envelope === null) throw new Error('Recovery preparation candidate is missing; reconcile original operation');
  const opened = await openRecoveryPreparation(envelope, context, keys);
  if (createHash('sha256').update(opened.body, 'utf8').digest('hex') !== request.preparationDigest) {
    throw new Error('Recovery preparation does not match reserved facts');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (after.revision !== before.revision || JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Recovery control changed during preparation verification; retry original operation');
  }
  return journal.appendReservedComplaintPreparation({ ...request, operationId: context.operationId,
    writerEpoch: context.writerEpoch,
    envelopeDigest: createHash('sha256').update(envelope, 'utf8').digest('hex') }, control);
}
