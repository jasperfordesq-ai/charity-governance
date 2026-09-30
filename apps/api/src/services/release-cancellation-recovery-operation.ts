import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { readCommittedComplaintCancellation } from './complaint-recovery-cancellation.js';
import { readPublishedCancellation } from './published-cancellation.js';
import { validateRecoveryControl, type RecoveryReleaseStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { CancellationObjects, CancellationOperationKind } from './cancellation-envelope.js';
import type { RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import type { HoldPreparationObjects } from './hold-recovery-envelope.js';

/** Release only the exact committed and independently published cancellation.
 * No timeout clearing, takeover or new action is authorized. */
export async function releaseCommittedCancellationOperation(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryReleaseStore, writerId: string, operationKind: CancellationOperationKind, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<HoldPreparationObjects, 'readHoldPreparation'> & Pick<RecoveryEnvelopeObjects, 'readReplay'>
    & Pick<CancellationObjects, 'readCancellation'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== writerId || before.writerEpoch !== context.writerEpoch
    || (before.activeOperation && before.activeOperation.operationId !== context.operationId)) {
    throw new Error('Recovery release writer or operation mismatch');
  }
  const source = { async readHead() {
    const v = validateRecoveryControl(await control.readControl());
    return { installationId: v.installationId, organisationId: v.organisationId,
      generation: v.generation, digest: v.digest, revision: v.revision };
  } };
  const published = await readPublishedCancellation(journal, source, context, operationKind, keys, objects);
  const local = await readCommittedComplaintCancellation(prisma, { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId, operationKind });
  const cancellation = JSON.parse(local.body);
  const after = validateRecoveryControl(await control.readControl());
  if (cancellation.writerId !== writerId || local.body !== published.body || published.entryDigest !== before.digest
    || published.revision !== before.revision || JSON.stringify(after) !== JSON.stringify(before)
    || (before.activeOperation && before.activeOperation.preparationDigest !== cancellation.preparationDigest)) {
    throw new Error('Recovery release evidence does not match current control');
  }
  if (before.activeOperation === null) return { released: true as const, replayed: true, actionAuthorized: false as const };
  let written: boolean;
  try { written = await control.releaseControl(before.revision, { operationId: context.operationId,
    preparationDigest: cancellation.preparationDigest, generation: before.generation, digest: published.entryDigest }); }
  catch { throw new Error('Recovery release outcome is unknown; retry the original operation'); }
  const observed = validateRecoveryControl(await control.readControl());
  const { revision: oldRevision, ...oldValue } = before, { revision, ...newValue } = observed;
  if (revision === oldRevision || JSON.stringify(newValue) !== JSON.stringify({ ...oldValue, activeOperation: null })) {
    throw new Error('Recovery release was not verified; reconcile current control');
  }
  return { released: true as const, replayed: !written, actionAuthorized: false as const };
}
