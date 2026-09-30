import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { readCommittedComplaintOutcome } from './complaint-recovery-outcome.js';
import { readCommittedComplaintHoldOutcome } from './complaint-hold-recovery-outcome.js';
import { preserveRecoveryOutcome, type RecoveryOutcomeObjects } from './recovery-outcome-envelope.js';
import { preserveHoldOutcome, type HoldOutcomeObjects } from './hold-outcome-envelope.js';
import { publishVerifiedComplaintOutcome } from './publish-verified-complaint-outcome.js';
import { publishVerifiedHoldOutcome } from './published-hold-outcome.js';
import { releaseCommittedComplaintOperation } from './release-complaint-recovery-operation.js';
import { releaseCommittedHoldOperation } from './release-hold-recovery-operation.js';
import { readPublishedComplaintPreparation } from './published-complaint-preparation.js';
import { readPublishedHoldPreparation } from './published-hold-preparation.js';
import { validateRecoveryControl, type RecoveryReleaseStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys,
  type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import type { HoldPreparationObjects } from './hold-recovery-envelope.js';

type Kind = 'PRIMARY' | 'HOLD';
type Objects = RecoveryOutcomeObjects & HoldOutcomeObjects & Pick<RecoveryEnvelopeObjects, 'readReplay'>
  & Pick<HoldPreparationObjects, 'readHoldPreparation'>;

/** Complete an existing committed primary or hold outcome for the same writer.
 * No claim or hold mutation is executed here. Published terminal evidence is
 * never reconstructed if its exact bytes are missing. */
export async function resumeCommittedComplaintOutcome(prisma: PrismaClient, journal: RecoveryAuthorityJournal,
  control: RecoveryReleaseStore, writerId: string, kind: Kind, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  if (kind !== 'PRIMARY' && kind !== 'HOLD') throw new Error('Unsupported recovery outcome kind');
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== writerId || before.writerEpoch !== context.writerEpoch
    || (before.activeOperation && before.activeOperation.operationId !== context.operationId)) {
    throw new Error('Recovery outcome resume writer or operation mismatch');
  }
  const scope = { installationId: context.installationId, organisationId: context.organisationId,
    operationId: context.operationId };
  const local = kind === 'PRIMARY' ? await readCommittedComplaintOutcome(prisma, scope)
    : await readCommittedComplaintHoldOutcome(prisma, scope);
  const facts = JSON.parse(local.body);
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const preparation = kind === 'PRIMARY'
    ? await readPublishedComplaintPreparation(journal, source, context, keys, objects)
    : await readPublishedHoldPreparation(journal, control, context, keys, objects);
  const after = validateRecoveryControl(await control.readControl());
  if (facts.preparationDigest !== createHash('sha256').update(preparation.body).digest('hex')
    || preparation.revision !== before.revision || JSON.stringify(after) !== JSON.stringify(before)
    || (before.activeOperation && before.activeOperation.preparationDigest !== facts.preparationDigest)) {
    throw new Error('Recovery outcome resume evidence or control mismatch');
  }
  if (before.digest === preparation.entryDigest) {
    if (!before.activeOperation) throw new Error('Recovery preparation has no reservation');
    if (kind === 'PRIMARY') await preserveRecoveryOutcome(local.body, context, keys, objects);
    else await preserveHoldOutcome(local.body, context, keys, objects);
    const request = { writerId, preparationDigest: facts.preparationDigest,
      preparationGeneration: before.generation, preparationEntryDigest: preparation.entryDigest,
      preparationEnvelopeDigest: preparation.envelopeDigest };
    if (kind === 'PRIMARY') await publishVerifiedComplaintOutcome(journal, control, request, context, keys, objects);
    else await publishVerifiedHoldOutcome(journal, control, request, context, keys, objects);
  }
  return kind === 'PRIMARY'
    ? releaseCommittedComplaintOperation(prisma, journal, control, writerId, context, keys, objects)
    : releaseCommittedHoldOperation(prisma, journal, control, writerId, context, keys, objects);
}
