import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { type HoldPreparationObjects } from './hold-recovery-envelope.js';
import { readPublishedHoldPreparation } from './published-hold-preparation.js';
import { prepareComplaintHoldRecoveryFacts } from './complaint-hold-recovery-preparation.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

/** Inactive internal orchestration, not all-writer enforcement or activation.
 * Verify the reserved independent preparation before the local transaction.
 * The reservation remains occupied until a separately verified outcome release.
 * No provider IO is performed inside database locks. Safe writer replacement
 * still needs independent original-host isolation; no takeover is implemented. */
export async function executePublishedComplaintHold(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, writerId: string, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Pick<HoldPreparationObjects, 'readHoldPreparation'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId) {
    throw new Error('Hold execution writer or operation mismatch');
  }
  const published = await readPublishedHoldPreparation(journal, control, context, keys, objects);
  const prepared = prepareComplaintHoldRecoveryFacts(JSON.parse(published.body));
  const after = validateRecoveryControl(await control.readControl());
  if (prepared.body !== published.body || prepared.digest !== before.activeOperation.preparationDigest
    || published.entryDigest !== before.digest || published.revision !== before.revision
    || JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Hold execution publication changed');
  }
  return prisma.$transaction(async tx => {
    await lockOrganisationForUpdate(tx, context.organisationId);
    const binding = await tx.complaintRecoveryEnforcement.findUnique({ where: { organisationId: context.organisationId } });
    if (!binding || binding.installationId !== context.installationId || binding.writerId !== writerId
      || binding.writerEpoch !== context.writerEpoch) throw new Error('Hold execution is not bound to this writer');
    const preparation = await tx.complaintHoldRecoveryPreparation.findUnique({ where: {
      organisationId_operationId: { organisationId: context.organisationId, operationId: context.operationId } },
      include: { outcome: true } });
    if (!preparation || preparation.facts !== published.body || preparation.factsDigest !== prepared.digest
      || preparation.installationId !== context.installationId || preparation.writerEpoch !== context.writerEpoch) {
      throw new Error('Hold execution local preparation mismatch');
    }
    if (preparation.outcome) {
      return { outcomeId: preparation.outcome.id, replayed: true, actionAuthorized: false as const };
    }
    // SQL applies the exact captured transition and current role/revision checks
    // atomically with this immutable outcome. Failure leaves neither record.
    const outcome = await tx.complaintHoldRecoveryOutcome.create({ data: { preparationId: preparation.id } });
    return { outcomeId: outcome.id, replayed: false, actionAuthorized: false as const };
  }, { isolationLevel: 'ReadCommitted', timeout: 5000 });
}
