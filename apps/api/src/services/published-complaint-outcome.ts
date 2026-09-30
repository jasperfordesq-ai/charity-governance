import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal, type AuthorityHeadSource } from './recovery-authority-journal.js';
import { readVerifiedRecoveryPreparation, type RecoveryEnvelopeContext,
  type RecoveryDataKeys, type RecoveryEnvelopeObjects } from './recovery-preparation-envelope.js';
import { readVerifiedRecoveryOutcome, type RecoveryOutcomeObjects } from './recovery-outcome-envelope.js';

/** Read independent evidence only. This neither applies recovery mutations nor
 * releases a reservation. Both payloads must still exist at their published hashes. */
export async function readPublishedComplaintOutcome(journal: RecoveryAuthorityJournal,
  source: AuthorityHeadSource, context: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<RecoveryEnvelopeObjects, 'readReplay'> & Pick<RecoveryOutcomeObjects, 'readOutcome'>) {
  const outcome = await journal.readPublishedEntry(context.operationId, 'COMPLAINT_OUTCOME_V1', source);
  const preparation = await journal.readPublishedEntry(context.operationId, 'COMPLAINT_PREPARATION_V1', source);
  if (outcome.revision !== preparation.revision || outcome.entry.previousDigest !== preparation.entry.digest
    || outcome.entry.generation !== preparation.entry.generation + 1
    || outcome.entry.installationId !== context.installationId || outcome.entry.organisationId !== context.organisationId) {
    throw new Error('Published complaint outcome pair does not match');
  }
  const prepared = await readVerifiedRecoveryPreparation(preparation.entry.factsDigest, context, keys, objects);
  const opened = await readVerifiedRecoveryOutcome(outcome.entry.factsDigest, context, keys, objects);
  const prep = JSON.parse(prepared.body), facts = JSON.parse(opened.body);
  if (facts.preparationDigest !== createHash('sha256').update(prepared.body).digest('hex')
    || facts.authorizationId !== prep.authorization.id || facts.complaintId !== prep.complaint.id
    || facts.actorUserId !== prep.actorUserId) throw new Error('Published complaint outcome facts do not match');
  const after = await journal.inspectCurrent(source);
  if (after.revision !== outcome.revision) throw new Error('Recovery authority changed while reading outcome');
  return { body: opened.body, preparationBody: prepared.body, entryDigest: outcome.entry.digest,
    envelopeDigest: outcome.entry.factsDigest, revision: after.revision, actionAuthorized: false as const };
}
