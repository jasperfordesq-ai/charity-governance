import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore,
  type RecoveryReleaseStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { prepareDocumentBytePrimaryCompletionFacts } from './document-byte-primary-completion.js';
import { readVerifiedDocumentBytePrimaryCompletion,
  type DocumentBytePrimaryCompletionObjects } from './document-byte-primary-completion-envelope.js';
import { readPublishedDocumentBytePrimaryCompletion } from './published-document-byte-primary-completion.js';
import { readDocumentDisposalCompleteness } from './document-disposal-completeness.js';
import { prepareDocumentDisposalOutcomeFacts } from './document-disposal-outcome.js';
import { preserveDocumentDisposalOutcome, readVerifiedDocumentDisposalOutcome,
  type DocumentDisposalOutcomeObjects } from './document-disposal-outcome-envelope.js';
import type { DocumentByteProviderUnknownObjects } from './document-byte-provider-unknown-envelope.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';
import type { DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import type { DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>
  & DocumentByteProviderUnknownObjects & DocumentBytePrimaryCompletionObjects & DocumentDisposalOutcomeObjects;
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
type Completeness = Awaited<ReturnType<typeof readDocumentDisposalCompleteness>>;

function sourceFor(control: RecoveryControlStore) {
  return { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
}

/** The only outcome body a primary completion and the current copy evidence
 * can produce. Everything in it is derived. */
function outcomeFor(context: RecoveryEnvelopeContext, local: Completeness,
  completion: { body: string; entryDigest: string; envelopeDigest: string }) {
  const facts = JSON.parse(completion.body);
  return prepareDocumentDisposalOutcomeFacts({ format: 1, action: 'DOCUMENT_DISPOSAL_COMPLETE',
    installationId: context.installationId, organisationId: context.organisationId,
    operationId: context.operationId, writerId: facts.writerId, writerEpoch: facts.writerEpoch,
    sourceRevision: facts.sourceRevision, preparationDigest: facts.preparationDigest,
    authorizationId: local.authorizationId, deletionId: local.deletionId,
    completionEntryDigest: completion.entryDigest, completionEnvelopeDigest: completion.envelopeDigest,
    completionBodyDigest: hash(completion.body), completenessDigest: local.digest,
    areas: Object.fromEntries(local.areas.map((a) => [a.area, { plan: a.plan, scopes: a.scopes }])) });
}

/** Read the seventh-stage whole-case outcome. It must be the current head,
 * directly after this operation's primary completion, and agree with it. It
 * stays readable after the operation is released, so a release can be
 * replayed; while the operation is still reserved, the reservation must match. */
export async function readPublishedDocumentDisposalOutcome(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, objects: Objects) {
  const context = validateRecoveryEnvelopeContext(rawContext), source = sourceFor(control);
  const outcome = await journal.readPublishedEntry(context.operationId, 'DOCUMENT_DISPOSAL_OUTCOME_V1', source);
  const completion = await journal.readPublishedEntry(context.operationId,
    'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1', source);
  const current = await journal.inspectCurrent(source);
  // The verified history already places the outcome directly after this
  // operation's completion; what remains is one revision and still the head.
  if (outcome.revision !== completion.revision || current.revision !== outcome.revision
    || current.generation !== outcome.entry.generation) {
    throw new Error('Document disposal outcome is not the current head');
  }
  const [openedOutcome, openedCompletion] = await Promise.all([
    readVerifiedDocumentDisposalOutcome(outcome.entry.factsDigest, context, keys, objects),
    readVerifiedDocumentBytePrimaryCompletion(completion.entry.factsDigest, context, keys, objects),
  ]);
  const facts = JSON.parse(prepareDocumentDisposalOutcomeFacts(JSON.parse(openedOutcome.body)).body);
  const done = JSON.parse(prepareDocumentBytePrimaryCompletionFacts(JSON.parse(openedCompletion.body)).body);
  if (facts.completionEntryDigest !== completion.entry.digest
    || facts.completionEnvelopeDigest !== completion.entry.factsDigest
    || facts.completionBodyDigest !== hash(openedCompletion.body)
    || facts.deletionId !== done.deletionId || facts.writerId !== done.writerId
    || facts.preparationDigest !== done.preparationDigest) {
    throw new Error('Document disposal outcome does not match its authenticated completion');
  }
  const reservation = validateRecoveryControl(await control.readControl());
  if (reservation.revision !== outcome.revision || (reservation.activeOperation !== null
    && (reservation.activeOperation.operationId !== context.operationId
      || reservation.activeOperation.preparationDigest !== facts.preparationDigest
      || reservation.writerId !== facts.writerId))) {
    throw new Error('Document disposal outcome reservation changed');
  }
  return { body: openedOutcome.body, entryDigest: outcome.entry.digest,
    envelopeDigest: outcome.entry.factsDigest, generation: outcome.entry.generation,
    revision: outcome.revision, released: reservation.activeOperation === null,
    actionAuthorized: false as const };
}

/** Publish the whole-case outcome: only after the primary completion is the
 * current head, and only while the local evidence shows every copy area of
 * this authorization resolved. The evidence digest is read again before the
 * append. A lost acknowledgement is recovered by authenticating the published
 * entry against unchanged evidence. Nothing is deleted or released here. */
export async function publishVerifiedDocumentDisposalOutcome(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects, authorizationId: string) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const scope = { organisationId: context.organisationId, authorizationId };
  const local = await readDocumentDisposalCompleteness(prisma, scope);
  // Frozen evidence is what makes one outcome body per operation sound: the
  // body preserved below cannot be outdated by a copy write before the append.
  if (!local.evidenceFrozen) throw new Error('Document disposal outcome requires recovery enforcement');
  try {
    const already = await readPublishedDocumentDisposalOutcome(journal, control, context, keys, objects);
    const facts = JSON.parse(already.body);
    if (facts.completenessDigest !== local.digest || facts.authorizationId !== local.authorizationId) {
      throw new Error('Published document disposal outcome differs from current copy evidence');
    }
    // A review or authority that has fallen due since publication means an
    // unreleased outcome no longer holds; the operation stays reserved.
    if (!already.released && !local.complete) throw new Error('Document disposal is no longer complete');
    return { ...already, replayed: true, actionAuthorized: false as const };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Requested recovery entry is not published') throw error;
  }
  if (!local.complete) {
    const open = local.areas.flatMap((a) => a.unresolved.map((u) => `${a.area}:${u.reason}`));
    throw new Error(`Document disposal is incomplete: ${local.primaryCompletionRecorded ? '' : 'PRIMARY_NOT_COMPLETED '}${open.join(' ')}`.trim());
  }
  const completion = await readPublishedDocumentBytePrimaryCompletion(journal, control, context, keys, objects);
  if (JSON.parse(completion.body).deletionId !== local.deletionId) {
    throw new Error('Document disposal outcome names another deletion than its completion');
  }
  const outcome = outcomeFor(context, local, completion);
  const preserved = await preserveDocumentDisposalOutcome(outcome.body, context, keys, objects);
  const [localAgain, completionAgain] = await Promise.all([
    readDocumentDisposalCompleteness(prisma, scope),
    readPublishedDocumentBytePrimaryCompletion(journal, control, context, keys, objects),
  ]);
  if (!localAgain.complete || localAgain.digest !== local.digest
    || completionAgain.entryDigest !== completion.entryDigest || completionAgain.revision !== completion.revision) {
    throw new Error('Document disposal evidence changed before publication');
  }
  const done = JSON.parse(completion.body);
  const receipt = await journal.appendReservedDocumentDisposalOutcome({
    operationId: context.operationId, writerId: done.writerId, writerEpoch: done.writerEpoch,
    preparationDigest: done.preparationDigest, completionGeneration: completion.generation,
    completionEntryDigest: completion.entryDigest, completionEnvelopeDigest: completion.envelopeDigest,
    outcomeEnvelopeDigest: preserved.digest,
  }, control);
  const published = await readPublishedDocumentDisposalOutcome(journal, control, context, keys, objects);
  if (published.body !== outcome.body || published.entryDigest !== receipt.digest) {
    throw new Error('Published document disposal outcome changed after append');
  }
  return { ...published, replayed: receipt.replayed, actionAuthorized: false as const };
}

/** Release the operation reservation on its published whole-case outcome,
 * only while that outcome is the head, the copy evidence is still exactly
 * what it was published on, and the case is still complete. A released
 * operation is reported again, never re-released. This deletes or retains
 * nothing. */
export async function releaseCompletedDocumentOperation(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryReleaseStore, writerId: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects, authorizationId: string) {
  const context = validateRecoveryEnvelopeContext(rawContext);
  const before = validateRecoveryControl(await control.readControl());
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerId !== writerId || before.writerEpoch !== context.writerEpoch
    || (before.activeOperation && before.activeOperation.operationId !== context.operationId)) {
    throw new Error('Recovery release writer or operation mismatch');
  }
  const published = await readPublishedDocumentDisposalOutcome(journal, control, context, keys, objects);
  const facts = JSON.parse(published.body);
  const local = await readDocumentDisposalCompleteness(prisma,
    { organisationId: context.organisationId, authorizationId });
  const after = validateRecoveryControl(await control.readControl());
  if (published.entryDigest !== before.digest || published.revision !== before.revision
    || JSON.stringify(after) !== JSON.stringify(before) || facts.authorizationId !== authorizationId
    || !local.evidenceFrozen || local.digest !== facts.completenessDigest
    || (before.activeOperation && before.activeOperation.preparationDigest !== facts.preparationDigest)) {
    throw new Error('Recovery release evidence does not match current control');
  }
  // Released only while the outcome still holds. If a review or authority
  // falls due first, the operation stays reserved: fail closed.
  if (before.activeOperation !== null && !local.complete) throw new Error('Document disposal is no longer complete');
  if (before.activeOperation === null) return { released: true as const, replayed: true, actionAuthorized: false as const };
  let written: boolean;
  try {
    written = await control.releaseControl(before.revision, { operationId: context.operationId,
      preparationDigest: facts.preparationDigest, generation: before.generation, digest: published.entryDigest });
  } catch { throw new Error('Recovery release outcome is unknown; retry the original operation'); }
  const observed = validateRecoveryControl(await control.readControl());
  const { revision: oldRevision, ...oldValue } = before, { revision, ...newValue } = observed;
  if (revision === oldRevision || JSON.stringify(newValue) !== JSON.stringify({ ...oldValue, activeOperation: null })) {
    throw new Error('Recovery release was not verified; reconcile current control');
  }
  return { released: true as const, replayed: !written, actionAuthorized: false as const };
}
