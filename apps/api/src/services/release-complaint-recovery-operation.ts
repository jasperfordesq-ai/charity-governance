import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { readCommittedComplaintOutcome } from './complaint-recovery-outcome.js';
import { readPublishedComplaintOutcome } from './published-complaint-outcome.js';
import { validateRecoveryControl, type RecoveryReleaseStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys,
  type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import type { RecoveryOutcomeObjects } from './recovery-outcome-envelope.js';

/** Inactive committed-primary-claim release only. No timeout, cancellation or
 * takeover path. Claims are terminal through existing uniqueness/append-only
 * guards; other action classes require their own execution/outcome protocol. */
export async function releaseCommittedComplaintOperation(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryReleaseStore, writerId: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<RecoveryEnvelopeObjects, 'readReplay'> & Pick<RecoveryOutcomeObjects, 'readOutcome'>) {
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
  const published = await readPublishedComplaintOutcome(journal, source, context, keys, objects);
  const local = await readCommittedComplaintOutcome(prisma, { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId });
  const outcome = JSON.parse(local.body);
  const after = validateRecoveryControl(await control.readControl());
  if (local.body !== published.body || published.entryDigest !== before.digest
    || published.revision !== before.revision || JSON.stringify(after) !== JSON.stringify(before)
    || (before.activeOperation && before.activeOperation.preparationDigest !== outcome.preparationDigest)) {
    throw new Error('Recovery release evidence does not match current control');
  }
  if (before.activeOperation === null) return { released: true as const, replayed: true, actionAuthorized: false as const };
  let written: boolean;
  try { written = await control.releaseControl(before.revision, { operationId: context.operationId,
    preparationDigest: outcome.preparationDigest, generation: before.generation, digest: published.entryDigest }); }
  catch { throw new Error('Recovery release outcome is unknown; retry the original operation'); }
  const observed = validateRecoveryControl(await control.readControl());
  const { revision: oldRevision, ...oldValue } = before, { revision, ...newValue } = observed;
  if (revision === oldRevision || JSON.stringify(newValue) !== JSON.stringify({ ...oldValue, activeOperation: null })) {
    throw new Error('Recovery release was not verified; reconcile current control');
  }
  return { released: true as const, replayed: !written, actionAuthorized: false as const };
}
