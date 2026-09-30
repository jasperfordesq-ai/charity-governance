import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { readVerifiedRecoveryPreparation, validateRecoveryEnvelopeContext,
  type RecoveryEnvelopeContext, type RecoveryDataKeys, type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import { openRecoveryOutcome, type RecoveryOutcomeObjects } from './recovery-outcome-envelope.js';

/** Authenticate both immutable payloads before publishing their exact journal
 * relationship. No creation fallback, execution permit or reservation release. */
export async function publishVerifiedComplaintOutcome(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  request: { writerId: string; preparationDigest: string; preparationGeneration: number;
    preparationEntryDigest: string; preparationEnvelopeDigest: string },
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<RecoveryEnvelopeObjects, 'readReplay'> & Pick<RecoveryOutcomeObjects, 'readOutcome'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) {
    throw new Error('Recovery outcome reservation does not match');
  }
  // The journal method below independently verifies that this expected envelope
  // digest belongs to the exact published preparation; no local digest is trusted alone.
  const prepared = await readVerifiedRecoveryPreparation(request.preparationEnvelopeDigest, context, keys, objects);
  if (createHash('sha256').update(prepared.body).digest('hex') !== request.preparationDigest) {
    throw new Error('Recovery outcome preparation facts do not match');
  }
  const envelope = await objects.readOutcome(context.operationId);
  if (envelope === null) throw new Error('Recovery outcome candidate is missing');
  const opened = await openRecoveryOutcome(envelope, context, keys);
  const prep = JSON.parse(prepared.body), outcome = JSON.parse(opened.body);
  if (outcome.preparationDigest !== request.preparationDigest || outcome.authorizationId !== prep.authorization.id
    || outcome.complaintId !== prep.complaint.id || outcome.actorUserId !== prep.actorUserId) {
    throw new Error('Recovery outcome does not match its preparation');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Recovery control changed during outcome verification');
  return journal.appendReservedComplaintOutcome({ ...request, operationId: context.operationId,
    writerEpoch: context.writerEpoch, outcomeEnvelopeDigest: createHash('sha256').update(envelope).digest('hex') }, control);
}
