import { createHash } from 'node:crypto';
import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type ConfluenceExecutionV2ReleaseStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { ConfluenceExecutionArchiveV2Binding } from './confluence-execution-archive-v2.js';
import { readPublishedConfluenceExecutionV2, type ConfluenceExecutionV2PrefixObjects, type ConfluenceExecutionWriterPolicy } from './confluence-execution-v2-prefix.js';

const noAuthority = { actionAuthorized: false as const, currentHistoryVerified: false as const, independentlyPreserved: false as const, transportStateReconciled: false as const, reopeningAuthorised: false as const };

/** Inactive acknowledgement of this exact archive only. Original digest/binding
 * must come from the durable prepared dispatch, not a freshly recaptured SQL
 * snapshot. That dispatch is not implemented here. Later local decisions still
 * require their own archive; acknowledging old metadata does not approve them
 * or claim latest-local-state coverage, disposal or safe application reopening.
 */
export async function acknowledgeConfluenceExecutionV2Archive(journal: RecoveryAuthorityJournal,
  control: ConfluenceExecutionV2ReleaseStore, expectedFactsDigest: string, raw: ConfluenceExecutionArchiveV2Binding,
  keys: RecoveryDataKeys, objects: ConfluenceExecutionV2PrefixObjects, policy: ConfluenceExecutionWriterPolicy) {
  const trustedPolicy = structuredClone(policy);
  const context = validateRecoveryEnvelopeContext(raw.context), original = validateRecoveryControl(raw.observedControl);
  const before = validateRecoveryControl(await control.readControl());
  if (!/^[a-f0-9]{64}$/.test(expectedFactsDigest) || original.activeOperation !== null
    || before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== original.writerId || before.writerEpoch !== context.writerEpoch
    || (before.activeOperation && (before.activeOperation.operationId !== context.operationId
      || before.activeOperation.preparationDigest !== expectedFactsDigest))) {
    throw new Error('Confluence archive acknowledgement identity does not match original operation');
  }
  const archive = await readPublishedConfluenceExecutionV2(journal,control,raw,keys,objects,trustedPolicy);
  const digest = createHash('sha256').update(archive.body,'utf8').digest('hex');
  const afterVerification = validateRecoveryControl(await control.readControl());
  if (digest !== expectedFactsDigest || !archive.archivePrefixVerified
    || archive.entryGeneration !== before.generation || archive.entryDigest !== before.digest
    || archive.revision !== before.revision || JSON.stringify(afterVerification) !== JSON.stringify(before)) {
    throw new Error('Confluence archive acknowledgement evidence changed');
  }
  if (before.activeOperation === null) return { acknowledged: true as const, replayed: true,
    archivePrefixVerified: true as const, ...noAuthority };
  let written: boolean;
  try {
    written = await control.releaseConfluenceExecutionV2Control(before.revision,{ operationId: context.operationId,
      preparationDigest: expectedFactsDigest, generation: archive.entryGeneration, digest: archive.entryDigest,
      envelopeDigest: archive.envelopeDigest });
  } catch { throw new Error('Confluence archive acknowledgement outcome is unknown; retry the original archive'); }
  const observed = validateRecoveryControl(await control.readControl());
  const { revision: beforeRevision, ...beforeValue } = before;
  const { revision: observedRevision, ...observedValue } = observed;
  if (observedRevision === beforeRevision || JSON.stringify(observedValue) !== JSON.stringify({ ...beforeValue, activeOperation: null })) {
    throw new Error('Confluence archive acknowledgement was not verified; preserve original operation evidence');
  }
  return { acknowledged: true as const, replayed: !written, archivePrefixVerified: true as const, ...noAuthority };
}
