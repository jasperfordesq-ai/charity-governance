import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { readCommittedComplaintHoldOutcome } from './complaint-hold-recovery-outcome.js';
import { readPublishedHoldOutcome } from './published-hold-outcome.js';
import { validateRecoveryControl, type RecoveryReleaseStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { HoldOutcomeObjects } from './hold-outcome-envelope.js';
import type { HoldPreparationObjects } from './hold-recovery-envelope.js';

/** Inactive committed-hold release only. Authenticates current independent
 * evidence and compares the exact committed local outcome. Never clears stale
 * reservations on timeouts, accepts uncommitted transactions or permits takeover.
 * The original hold/outcome remain immutable; no new action is authorized. */
export async function releaseCommittedHoldOperation(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryReleaseStore, writerId: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<HoldPreparationObjects, 'readHoldPreparation'> & Pick<HoldOutcomeObjects, 'readHoldOutcome'>) {
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
  const published = await readPublishedHoldOutcome(journal, source, context, keys, objects);
  const local = await readCommittedComplaintHoldOutcome(prisma, { installationId: context.installationId,
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
