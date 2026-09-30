import { RecoveryAuthorityJournal, type AuthorityHeadSource } from './recovery-authority-journal.js';
import { readVerifiedRecoveryPreparation, type RecoveryEnvelopeContext,
  type RecoveryDataKeys, type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';

/** COMPLAINT_PREPARATION_V1 explicitly binds factsDigest to the exact encrypted
 * envelope bytes. Older generic journal kinds are not reinterpreted as payloads.
 * This reads evidence only; reservation, writer fencing and replay application
 * remain separate prerequisites. No production action calls this reader. */
export async function readPublishedComplaintPreparation(journal: RecoveryAuthorityJournal,
  source: AuthorityHeadSource, context: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, store: Pick<RecoveryEnvelopeObjects, 'readReplay'>) {
  const observed = await journal.readPublishedEntry(context.operationId, 'COMPLAINT_PREPARATION_V1', source);
  if (observed.entry.installationId !== context.installationId
    || observed.entry.organisationId !== context.organisationId) throw new Error('Recovery preparation journal binding mismatch');
  const opened = await readVerifiedRecoveryPreparation(observed.entry.factsDigest, context, keys, store);
  // Decryption may have taken time. Do not return a snapshot whose independently
  // observed head changed while the payload was being fetched/opened.
  const after = await journal.inspectCurrent(source);
  if (after.revision !== observed.revision) throw new Error('Recovery authority changed while reading preparation');
  return { body: opened.body, entryDigest: observed.entry.digest,
    envelopeDigest: observed.entry.factsDigest, revision: after.revision, actionAuthorized: false as const };
}
