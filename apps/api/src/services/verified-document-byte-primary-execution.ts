import type { PrismaClient } from '@prisma/client';
import { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import type { RecoveryControlStore } from './recovery-operation-reservation.js';
import type { RecoveryEnvelopeContext, RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { DocumentRecoveryObjects } from './document-recovery-envelope.js';
import type { DocumentOutcomeObjects } from './document-outcome-envelope.js';
import type { DocumentBytePermitObjects } from './document-byte-permit-envelope.js';
import type { DocumentByteExecutionDecisionObjects } from './document-byte-execution-decision-envelope.js';
import type { DocumentByteProviderUnknownObjects } from './document-byte-provider-unknown-envelope.js';
import type { Eraser, ErasureDispatcher } from './document-erasure.js';
import { prepareDocumentByteExecutionDecisionFacts } from './document-byte-execution-decision-facts.js';
import { readPublishedDocumentByteExecutionDecision } from './published-document-byte-execution-decision.js';
import { readMatchedStartedDocumentByteDecision } from './matched-claimed-document-byte-decision.js';
import { claimVerifiedDocumentByteExecutionLease } from './claimed-document-byte-execution-lease.js';
import { startVerifiedDocumentByteProviderAttempt } from './verified-document-byte-provider-start.js';
import { recordVerifiedDocumentBytePrimaryAbsence } from './verified-document-byte-provider-observation.js';
import { publishVerifiedDocumentByteProviderUnknown } from './published-document-byte-provider-unknown.js';

type Objects = Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>
  & Pick<DocumentOutcomeObjects, 'readDocumentOutcome'>
  & Pick<DocumentBytePermitObjects, 'readDocumentBytePermit'>
  & Pick<DocumentByteExecutionDecisionObjects, 'readDocumentByteExecutionDecision'>
  & DocumentByteProviderUnknownObjects;

/** The attempt guard refuses a start more than 120 seconds after the claim.
 * The provider call itself is bounded well inside that window. */
export const PROTECTED_PRIMARY_DELETION_TIMEOUT_MS = 10_000;

export type ProtectedPrimaryDeletionUnknownReason =
  | 'START_OUTCOME_UNREADABLE' | 'PRE_IO_RECHECK_FAILED' | 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT'
  | 'NO_ABSENCE_OBSERVATION' | 'OBSERVATION_NOT_RECORDED';

export type ProtectedPrimaryDeletionResult =
  | { outcome: 'PRIMARY_ABSENCE_OBSERVED'; leaseId: string; providerCalled: true;
      providerObservedAt: Date; actionAuthorized: false }
  | { outcome: 'UNKNOWN'; leaseId: string; providerCalled: boolean;
      reason: ProtectedPrimaryDeletionUnknownReason; unknownPublished: boolean;
      actionAuthorized: false };

async function boundedErase(erase: Eraser, target: Parameters<Eraser>[0], timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Protected primary deletion timed out'), { timedOut: true }));
    }, timeoutMs);
  });
  try {
    // Promise.race observes the losing attempt's late rejection, so a slow
    // eraser that fails after the timeout cannot become an unhandled rejection.
    return await Promise.race([
      Promise.resolve().then(() => erase(target, controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One protected primary-byte deletion attempt, end to end:
 * - claim the one-use lease;
 * - durably mark the provider start;
 * - re-authenticate the current independent decision immediately before I/O;
 * - call the eraser once for the decision's exact target;
 * - record the primary-absence observation.
 *
 * Every failure after the start marker is UNKNOWN. It is published to the
 * independent journal where possible and is never retried here. Nothing in
 * this function changes the deletion job, and its result never authorizes
 * completion. It cannot run without an active recovery enforcement, which
 * nothing in production creates. */
export async function executeVerifiedDocumentBytePrimaryDeletion(prisma: PrismaClient,
  journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  context: RecoveryEnvelopeContext, keys: RecoveryDataKeys, objects: Objects,
  dispatch: ErasureDispatcher, timeoutMs = PROTECTED_PRIMARY_DELETION_TIMEOUT_MS,
): Promise<ProtectedPrimaryDeletionResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > PROTECTED_PRIMARY_DELETION_TIMEOUT_MS) {
    throw new TypeError(`Protected primary deletion timeout must be 10-${PROTECTED_PRIMARY_DELETION_TIMEOUT_MS} ms`);
  }
  const decision = await readPublishedDocumentByteExecutionDecision(journal,
    control, context, keys, objects);
  const facts = JSON.parse(prepareDocumentByteExecutionDecisionFacts(
    JSON.parse(decision.body)).body);
  // The eraser is chosen from the decided provider, never supplied loose,
  // so another backend's absence can never be recorded against this one.
  const erase = dispatch(facts.provider);
  if (!erase) throw new Error(`No eraser is registered for decided provider "${facts.provider}"`);
  // A failure before the start marker commits leaves no possible I/O, so it
  // surfaces as an error.
  const { leaseId } = await claimVerifiedDocumentByteExecutionLease(prisma,
    journal, control, context, keys, objects);

  const unknown = async (reason: ProtectedPrimaryDeletionUnknownReason,
    providerCalled: boolean): Promise<ProtectedPrimaryDeletionResult> => {
    let unknownPublished = false;
    try {
      await publishVerifiedDocumentByteProviderUnknown(prisma, journal, control,
        context, keys, objects, leaseId);
      unknownPublished = true;
    } catch {
      // The committed start marker remains the durable local UNKNOWN fact;
      // publication can be repeated by its own idempotent path.
    }
    return { outcome: 'UNKNOWN', leaseId, providerCalled, reason,
      unknownPublished, actionAuthorized: false };
  };

  try {
    await startVerifiedDocumentByteProviderAttempt(prisma, journal, control,
      context, keys, objects, leaseId);
  } catch (error) {
    // The start service re-reads authority after committing its marker. If
    // that marker exists, the failure is post-start: UNKNOWN, provider not called.
    let marker: unknown;
    try {
      marker = await prisma.documentByteProviderAttempt.findUnique({ where: { leaseId } });
    } catch {
      // Whether the marker committed cannot be read. Keep the lease as an
      // uncertain attempt rather than losing it in a thrown error.
      return unknown('START_OUTCOME_UNREADABLE', false);
    }
    if (!marker) throw error;
    return unknown('PRE_IO_RECHECK_FAILED', false);
  }

  try {
    const recheck = await readMatchedStartedDocumentByteDecision(prisma, journal,
      control, context, keys, objects, leaseId, facts.oneUseAttemptId);
    if (recheck.decisionEntryDigest !== decision.entryDigest) {
      return unknown('PRE_IO_RECHECK_FAILED', false);
    }
  } catch {
    return unknown('PRE_IO_RECHECK_FAILED', false);
  }

  let absentAt: Date | void;
  try {
    absentAt = await boundedErase(erase, { organisationId: facts.organisationId,
      storagePath: facts.storagePath, targetRef: null }, timeoutMs);
  } catch (error) {
    const timedOut = error instanceof Error && (error as { timedOut?: boolean }).timedOut === true;
    return unknown(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR', true);
  }
  if (!(absentAt instanceof Date) || !Number.isFinite(absentAt.getTime())) {
    return unknown('NO_ABSENCE_OBSERVATION', true);
  }
  try {
    const observed = await recordVerifiedDocumentBytePrimaryAbsence(prisma, journal,
      control, context, keys, objects, leaseId, absentAt);
    return { outcome: 'PRIMARY_ABSENCE_OBSERVED', leaseId, providerCalled: true,
      providerObservedAt: observed.providerObservedAt, actionAuthorized: false };
  } catch {
    return unknown('OBSERVATION_NOT_RECORDED', true);
  }
}
