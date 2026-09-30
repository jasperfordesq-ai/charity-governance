import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { openHoldPreparation, readVerifiedHoldPreparation, type HoldPreparationObjects } from './hold-recovery-envelope.js';

/** Authenticates original candidate bytes before publication. Missing bytes are
 * unresolved, never recreated. Retains reservation; does not apply/release hold. */
export async function publishVerifiedHoldPreparation(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  request: { writerId: string; preparationDigest: string; expectedGeneration: number; expectedDigest: string | null },
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Pick<HoldPreparationObjects, 'readHoldPreparation'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) {
    throw new Error('Hold publication reservation does not match');
  }
  const envelope = await objects.readHoldPreparation(context.operationId);
  if (envelope === null) throw new Error('Hold preparation candidate is missing; reconcile original operation');
  const opened = await openHoldPreparation(envelope, context, keys);
  if (createHash('sha256').update(opened.body).digest('hex') !== request.preparationDigest) {
    throw new Error('Hold preparation does not match reserved facts');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Hold control changed during verification');
  return journal.appendReservedHoldPreparation({ ...request, operationId: context.operationId,
    writerEpoch: context.writerEpoch, envelopeDigest: createHash('sha256').update(envelope).digest('hex') }, control);
}

/** Full published history and exact authenticated payload evidence only. The
 * caller must not interpret this read as permission to execute or reopen. */
export async function readPublishedHoldPreparation(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Pick<HoldPreparationObjects, 'readHoldPreparation'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const published = await journal.readPublishedEntry(context.operationId, 'COMPLAINT_HOLD_PREPARATION_V1', source);
  if (published.entry.installationId !== context.installationId || published.entry.organisationId !== context.organisationId) {
    throw new Error('Hold preparation journal binding mismatch');
  }
  const opened = await readVerifiedHoldPreparation(published.entry.factsDigest, context, keys, objects);
  const after = await journal.inspectCurrent(source);
  if (after.revision !== published.revision) throw new Error('Hold authority changed while reading preparation');
  return { body: opened.body, entryDigest: published.entry.digest, envelopeDigest: published.entry.factsDigest,
    revision: after.revision, actionAuthorized: false as const };
}
