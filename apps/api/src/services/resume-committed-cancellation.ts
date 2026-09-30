import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { readCommittedComplaintCancellation } from './complaint-recovery-cancellation.js';
import { preserveCancellation, type CancellationObjects, type CancellationOperationKind } from './cancellation-envelope.js';
import { publishVerifiedCancellation } from './published-cancellation.js';
import { releaseCommittedCancellationOperation } from './release-cancellation-recovery-operation.js';
import { readPublishedComplaintPreparation } from './published-complaint-preparation.js';
import { readPublishedHoldPreparation } from './published-hold-preparation.js';
import { validateRecoveryControl, type RecoveryReleaseStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys,
  type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import type { HoldPreparationObjects } from './hold-recovery-envelope.js';

/** Same-writer completion of an already committed cancellation. Never cancels,
 * executes, replays restored records or takes over another writer. Published
 * terminal evidence is read as-is: missing published bytes are not recreated. */
export async function resumeCommittedCancellation(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryReleaseStore, writerId: string, operationKind: CancellationOperationKind,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: CancellationObjects & Pick<RecoveryEnvelopeObjects, 'readReplay'>
    & Pick<HoldPreparationObjects, 'readHoldPreparation'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== writerId || before.writerEpoch !== context.writerEpoch
    || (before.activeOperation && before.activeOperation.operationId !== context.operationId)) {
    throw new Error('Cancellation resume writer or operation mismatch');
  }
  const local = await readCommittedComplaintCancellation(prisma, { installationId: context.installationId,
    organisationId: context.organisationId, operationId: context.operationId, operationKind });
  const facts = JSON.parse(local.body);
  if (facts.writerId !== writerId) throw new Error('Cancellation resume committed writer mismatch');
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const preparation = operationKind === 'PRIMARY'
    ? await readPublishedComplaintPreparation(journal, source, context, keys, objects)
    : await readPublishedHoldPreparation(journal, control, context, keys, objects);
  const after = validateRecoveryControl(await control.readControl());
  if (facts.preparationDigest !== createHash('sha256').update(preparation.body).digest('hex')
    || preparation.revision !== before.revision || JSON.stringify(after) !== JSON.stringify(before)
    || (before.activeOperation && before.activeOperation.preparationDigest !== facts.preparationDigest)) {
    throw new Error('Cancellation resume evidence or control mismatch');
  }
  if (before.digest === preparation.entryDigest) {
    if (!before.activeOperation) throw new Error('Cancellation preparation has no reservation');
    await preserveCancellation(local.body, context, keys, objects);
    await publishVerifiedCancellation(journal, control, { operationKind, writerId,
      preparationDigest: facts.preparationDigest, preparationGeneration: before.generation,
      preparationEntryDigest: preparation.entryDigest, preparationEnvelopeDigest: preparation.envelopeDigest },
    context, keys, objects);
  }
  // A terminal head must pass the complete release verifier. Do not interpret
  // arbitrary later history, missing objects or provider errors as preparation.
  return releaseCommittedCancellationOperation(prisma, journal, control, writerId, operationKind, context, keys, objects);
}
