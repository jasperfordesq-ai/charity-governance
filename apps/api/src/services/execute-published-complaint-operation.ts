import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys,
  type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import { readPublishedComplaintPreparation } from './published-complaint-preparation.js';
import { prepareComplaintRecoveryFacts } from './complaint-recovery-preparation.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

/** Inactive complaint-primary integration. No activation, takeover or reopening.
 * The non-expiring remote reservation must remain occupied until the committed
 * outcome is published. Provider IO finishes before the database transaction.
 * Replacing an old writer still requires independent host isolation. */
export async function executePublishedComplaintOperation(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, writerId: string, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Pick<RecoveryEnvelopeObjects, 'readReplay'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId) {
    throw new Error('Complaint recovery execution writer or operation mismatch');
  }
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const published = await readPublishedComplaintPreparation(journal, source, context, keys, objects);
  const prepared = prepareComplaintRecoveryFacts(JSON.parse(published.body));
  const after = validateRecoveryControl(await control.readControl());
  if (prepared.body !== published.body || prepared.digest !== before.activeOperation.preparationDigest
    || published.entryDigest !== before.digest || published.revision !== before.revision
    || JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Complaint recovery execution publication changed');
  }
  return prisma.$transaction(async tx => {
    await lockOrganisationForUpdate(tx, context.organisationId);
    const binding = await tx.complaintRecoveryEnforcement.findUnique({ where: { organisationId: context.organisationId } });
    if (!binding || binding.installationId !== context.installationId || binding.writerId !== writerId
      || binding.writerEpoch !== context.writerEpoch) throw new Error('Complaint recovery execution is not enforced for this writer');
    const preparation = await tx.complaintRecoveryPreparation.findUnique({ where: {
      organisationId_operationId: { organisationId: context.organisationId, operationId: context.operationId } },
      include: { outcome: true, execution: true } });
    if (!preparation || preparation.facts !== published.body || preparation.factsDigest !== prepared.digest
      || preparation.installationId !== context.installationId || preparation.writerEpoch !== context.writerEpoch) {
      throw new Error('Complaint recovery execution local preparation mismatch');
    }
    if (preparation.outcome) {
      if (!preparation.execution || preparation.execution.transactionId !== preparation.outcome.transactionId) {
        throw new Error('Complaint recovery execution outcome has no matching execution');
      }
      return { outcomeId: preparation.outcome.id, replayed: true, actionAuthorized: false as const };
    }
    await tx.complaintRecoveryExecution.create({ data: { preparationId: preparation.id, writerId,
      generation: before.generation, entryDigest: published.entryDigest,
      envelopeDigest: published.envelopeDigest, controlRevision: before.revision } });
    // Existing SQL claim guards recheck current Owner, policy, holds, removal,
    // recovery expiry and retention. Deferred execution constraint requires the
    // outcome below, so any failure rolls the entire deletion/audit back.
    const facts = JSON.parse(prepared.body);
    const claim = await tx.complaintPurgeClaim.create({ data: { organisationId: context.organisationId,
      actorUserId: preparation.actorUserId, authorizationId: preparation.authorizationId, complaintId: facts.complaint.id } });
    const outcome = await tx.complaintRecoveryOutcome.create({ data: { preparationId: preparation.id, claimId: claim.id } });
    return { outcomeId: outcome.id, replayed: false, actionAuthorized: false as const };
  }, { isolationLevel: 'ReadCommitted', timeout: 5000 });
}
