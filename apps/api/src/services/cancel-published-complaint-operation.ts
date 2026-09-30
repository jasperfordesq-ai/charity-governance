import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys,
  type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import type { HoldPreparationObjects } from './hold-recovery-envelope.js';
import { readPublishedComplaintPreparation } from './published-complaint-preparation.js';
import { readPublishedHoldPreparation } from './published-hold-preparation.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const requestSchema = z.object({ operationKind: z.enum(['PRIMARY', 'HOLD']), writerId: id, actorUserId: id,
  reasonCode: z.enum(['OPERATOR_CANCELLED', 'DEPENDENCIES_CHANGED']),
  evidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/) }).strict();

/** Inactive cancellation of an exact published preparation. No reservation
 * release or takeover. Remote verification completes before the local lock;
 * SQL serializes cancellation against any previously paused execution. */
export async function cancelPublishedComplaintOperation(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, raw: unknown, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<RecoveryEnvelopeObjects, 'readReplay'> & Pick<HoldPreparationObjects, 'readHoldPreparation'>) {
  const request = requestSchema.parse(raw), context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId) {
    throw new Error('Cancellation writer or operation mismatch');
  }
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const published = request.operationKind === 'PRIMARY'
    ? await readPublishedComplaintPreparation(journal, source, context, keys, objects)
    : await readPublishedHoldPreparation(journal, control, context, keys, objects);
  const digest = createHash('sha256').update(published.body).digest('hex');
  const after = validateRecoveryControl(await control.readControl());
  if (digest !== before.activeOperation.preparationDigest || published.entryDigest !== before.digest
    || published.revision !== before.revision || JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Cancellation publication changed');
  }
  return prisma.$transaction(async tx => {
    await lockOrganisationForUpdate(tx, context.organisationId);
    const binding = await tx.complaintRecoveryEnforcement.findUnique({ where: { organisationId: context.organisationId } });
    if (!binding || binding.installationId !== context.installationId || binding.writerId !== request.writerId
      || binding.writerEpoch !== context.writerEpoch) throw new Error('Cancellation is not bound to this writer');
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${request.actorUserId} AND "organisationId"=${context.organisationId} FOR SHARE`;
    const actor = await tx.user.findFirst({ where: { id: request.actorUserId, organisationId: context.organisationId,
      lifecycleStatus: 'ACTIVE', role: { in: request.operationKind === 'PRIMARY' ? ['OWNER'] : ['OWNER', 'ADMIN'] } }, select: { id: true } });
    if (!actor) throw new Error('Cancellation requires current charity authority');
    const where = { organisationId_operationId: { organisationId: context.organisationId, operationId: context.operationId } };
    const preparation = request.operationKind === 'PRIMARY'
      ? await tx.complaintRecoveryPreparation.findUnique({ where, include: { cancellation: true, outcome: true, execution: true } })
      : await tx.complaintHoldRecoveryPreparation.findUnique({ where, include: { cancellation: true, outcome: true } });
    if (!preparation || preparation.facts !== published.body || preparation.factsDigest !== digest
      || preparation.installationId !== context.installationId || preparation.writerEpoch !== context.writerEpoch) {
      throw new Error('Cancellation local preparation mismatch');
    }
    if (preparation.outcome || ('execution' in preparation && preparation.execution)) {
      throw new Error('Executed recovery operation cannot be cancelled');
    }
    const existing = preparation.cancellation;
    if (existing) {
      if (existing.actorUserId !== request.actorUserId || existing.writerId !== request.writerId
        || existing.reasonCode !== request.reasonCode || existing.evidenceRef !== request.evidenceRef) {
        throw new Error('Cancellation identity changed');
      }
      return { cancellationId: existing.id, replayed: true, actionAuthorized: false as const };
    }
    const row = await tx.complaintRecoveryCancellation.create({ data: {
      ...(request.operationKind === 'PRIMARY' ? { primaryPreparationId: preparation.id } : { holdPreparationId: preparation.id }),
      actorUserId: request.actorUserId, writerId: request.writerId, reasonCode: request.reasonCode, evidenceRef: request.evidenceRef } });
    return { cancellationId: row.id, replayed: false, actionAuthorized: false as const };
  }, { isolationLevel: 'ReadCommitted', timeout: 5000 });
}
