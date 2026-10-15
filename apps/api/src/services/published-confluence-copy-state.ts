import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { openConfluenceCopyRecoveryFacts, readVerifiedConfluenceCopyRecoveryFacts,
  type ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';

const hash = (body: string) => createHash('sha256').update(body,'utf8').digest('hex');
type Objects = Pick<ConfluenceCopyRecoveryObjects,'readConfluenceCopyState'>;

/** Publish already preserved, authenticated original facts under their exact
 * format-2 reservation. Caller must have committed the local capture before
 * preservation. Missing payloads are never recreated. No execution or release. */
export async function publishVerifiedConfluenceCopyState(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore,
  request: { writerId: string; preparationDigest: string; expectedGeneration: number; expectedDigest: string | null },
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) {
    throw new Error('Confluence copy publication reservation does not match');
  }
  const envelope = await objects.readConfluenceCopyState(context.operationId);
  if (envelope === null) throw new Error('Confluence copy candidate is missing; reconcile original operation');
  const opened = await openConfluenceCopyRecoveryFacts(envelope,context,keys);
  if (hash(opened.body) !== request.preparationDigest) {
    throw new Error('Confluence copy candidate does not match reserved facts');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Confluence copy control changed during payload verification');
  }
  const receipt = await journal.appendReservedConfluenceCopyState({ ...request,
    operationId: context.operationId, writerEpoch: context.writerEpoch, envelopeDigest: hash(envelope) },control);
  return { ...receipt, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
}

/** Authenticates this historical state against the current journal and payload.
 * It does NOT choose the latest state for a review or verify all payloads in the
 * chain, restore SQL rows, check current permission, or authorise reopening. */
export async function readPublishedConfluenceCopyState(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const published = await journal.readPublishedEntry(context.operationId,'CONFLUENCE_COPY_DECISION_STATE_V1',source);
  if (published.entry.installationId !== context.installationId
    || published.entry.organisationId !== context.organisationId) throw new Error('Confluence copy journal binding mismatch');
  const opened = await readVerifiedConfluenceCopyRecoveryFacts(published.entry.factsDigest,context,keys,objects);
  const after = await journal.inspectCurrent(source);
  if (after.revision !== published.revision) throw new Error('Confluence copy authority changed while reading state');
  return { body: opened.body, entryDigest: published.entry.digest,
    envelopeDigest: published.entry.factsDigest, revision: after.revision,
    actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
}
