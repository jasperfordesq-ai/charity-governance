import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal, type AuthorityHeadSource } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext,
  type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { openHoldOutcome, readVerifiedHoldOutcome, type HoldOutcomeObjects } from './hold-outcome-envelope.js';
import { readVerifiedHoldPreparation, type HoldPreparationObjects } from './hold-recovery-envelope.js';

/** Authenticate both immutable payloads before publishing their exact journal
 * relationship. No creation fallback, execution permit or reservation release. */
export async function publishVerifiedHoldOutcome(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  request: { writerId: string; preparationDigest: string; preparationGeneration: number;
    preparationEntryDigest: string; preparationEnvelopeDigest: string },
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<HoldPreparationObjects, 'readHoldPreparation'> & Pick<HoldOutcomeObjects, 'readHoldOutcome'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== request.writerId || before.writerEpoch !== context.writerEpoch
    || before.activeOperation?.operationId !== context.operationId
    || before.activeOperation.preparationDigest !== request.preparationDigest) {
    throw new Error('Recovery outcome reservation does not match');
  }
  // The journal method below independently verifies that this expected envelope
  // digest belongs to the exact published preparation; no local digest is trusted alone.
  const prepared = await readVerifiedHoldPreparation(request.preparationEnvelopeDigest, context, keys, objects);
  if (createHash('sha256').update(prepared.body).digest('hex') !== request.preparationDigest) {
    throw new Error('Recovery outcome preparation facts do not match');
  }
  const envelope = await objects.readHoldOutcome(context.operationId);
  if (envelope === null) throw new Error('Recovery outcome candidate is missing');
  const opened = await openHoldOutcome(envelope, context, keys);
  const prep = JSON.parse(prepared.body), outcome = JSON.parse(opened.body);
  if (!matchingDecision(prep, outcome, request.preparationDigest)) {
    throw new Error('Hold outcome does not match its preparation');
  }
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Recovery control changed during outcome verification');
  return journal.appendReservedHoldOutcome({ ...request, operationId: context.operationId,
    writerEpoch: context.writerEpoch, outcomeEnvelopeDigest: createHash('sha256').update(envelope).digest('hex') }, control);
}

/** Read independent evidence only. This neither applies recovery mutations nor
 * releases a reservation. Both payloads must still exist at their published hashes. */
export async function readPublishedHoldOutcome(journal: RecoveryAuthorityJournal,
  source: AuthorityHeadSource, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  objects: Pick<HoldPreparationObjects, 'readHoldPreparation'> & Pick<HoldOutcomeObjects, 'readHoldOutcome'>) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const outcome = await journal.readPublishedEntry(context.operationId, 'COMPLAINT_HOLD_OUTCOME_V1', source);
  const preparation = await journal.readPublishedEntry(context.operationId, 'COMPLAINT_HOLD_PREPARATION_V1', source);
  if (outcome.revision !== preparation.revision || outcome.entry.previousDigest !== preparation.entry.digest
    || outcome.entry.generation !== preparation.entry.generation + 1
    || outcome.entry.installationId !== context.installationId || outcome.entry.organisationId !== context.organisationId) {
    throw new Error('Published complaint outcome pair does not match');
  }
  const prepared = await readVerifiedHoldPreparation(preparation.entry.factsDigest, context, keys, objects);
  const opened = await readVerifiedHoldOutcome(outcome.entry.factsDigest, context, keys, objects);
  const prep = JSON.parse(prepared.body), facts = JSON.parse(opened.body);
  if (!matchingDecision(prep, facts, createHash('sha256').update(prepared.body).digest('hex'))) {
    throw new Error('Published hold outcome facts do not match');
  }
  const after = await journal.inspectCurrent(source);
  if (after.revision !== outcome.revision) throw new Error('Recovery authority changed while reading outcome');
  return { body: opened.body, preparationBody: prepared.body, entryDigest: outcome.entry.digest,
    envelopeDigest: outcome.entry.factsDigest, revision: after.revision, actionAuthorized: false as const };
}

/** Called only with facts already parsed by the authenticated envelope readers. */
function matchingDecision(prep: { complaint: { id: string }; actorUserId: string;
  decision: { id: string; revision: number; recordRevision: number; held: boolean } },
  outcome: { preparationDigest: string; complaintId: string; actorUserId: string;
    holdEventId: string; holdRevision: number; recordRevision: number; held: boolean }, digest: string) {
  return outcome.preparationDigest === digest && outcome.complaintId === prep.complaint.id
    && outcome.actorUserId === prep.actorUserId && outcome.holdEventId === prep.decision.id
    && outcome.holdRevision === prep.decision.revision && outcome.recordRevision === prep.decision.recordRevision
    && outcome.held === prep.decision.held;
}
