import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { openDocumentRecoveryPreparation, readVerifiedDocumentRecoveryPreparation,
  type DocumentRecoveryObjects } from './document-recovery-envelope.js';

/** Authenticate the original encrypted candidate and unchanged reservation
 * before journal publication. No missing payload is recreated here. */
export async function publishVerifiedDocumentPreparation(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore,
  request: { writerId: string; preparationDigest: string; expectedGeneration: number;
    expectedDigest: string | null },
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) {
    throw new Error('Document recovery publication reservation does not match');
  }
  const envelope = await objects.readDocumentPreparation(context.operationId);
  if (envelope === null) throw new Error('Document preparation candidate is missing; reconcile original operation');
  const opened = await openDocumentRecoveryPreparation(envelope, context, keys);
  if (createHash('sha256').update(opened.body, 'utf8').digest('hex') !== request.preparationDigest) {
    throw new Error('Document preparation does not match reserved facts');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Document recovery control changed during preparation verification');
  }
  return journal.appendReservedDocumentPreparation({ ...request, operationId: context.operationId,
    writerEpoch: context.writerEpoch,
    envelopeDigest: createHash('sha256').update(envelope, 'utf8').digest('hex') }, control);
}

/** Current independent history and authenticated payload evidence only. It
 * does not authorize the local claim or the storage worker. */
export async function readPublishedDocumentPreparation(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const published = await journal.readPublishedEntry(context.operationId, 'DOCUMENT_PREPARATION_V1', source);
  if (published.entry.installationId !== context.installationId
    || published.entry.organisationId !== context.organisationId) {
    throw new Error('Document preparation journal binding mismatch');
  }
  const opened = await readVerifiedDocumentRecoveryPreparation(published.entry.factsDigest,
    context, keys, objects);
  const after = await journal.inspectCurrent(source);
  if (after.revision !== published.revision) {
    throw new Error('Document recovery authority changed while reading preparation');
  }
  return { body: opened.body, entryDigest: published.entry.digest,
    envelopeDigest: published.entry.factsDigest, revision: after.revision,
    actionAuthorized: false as const };
}
