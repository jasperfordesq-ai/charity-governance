import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { readCommittedDocumentOutcome } from './document-recovery-outcome.js';
import { prepareDocumentRecoveryFacts } from './document-recovery-preparation.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const requestSchema = z.object({ installationId: identity, organisationId: identity,
  operationId: identity }).strict();
type Request = z.infer<typeof requestSchema>;
const claimedRequestSchema = requestSchema.extend({
  leaseId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  oneUseAttemptId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
}).strict();
type ClaimedRequest = z.infer<typeof claimedRequestSchema>;
type ClaimedLeaseObservation = {
  decisionEntryDigest: string; decisionEnvelopeDigest: string;
  decisionBodyDigest: string; providerInventoryDigest: string;
  candidateEntryDigest: string; candidateEnvelopeDigest: string;
  outcomeEntryDigest: string; provider: string; storagePath: string;
  objectSha256: string; fileSize: number;
};
type StartedAttemptObservation = { startedAt: string; startedTransactionId: string };
type LocalObservation = { digest: string; localCopyObservationDigest: string;
  localHoldObservationDigest: string; actionAuthorized: false;
  claimedLease?: ClaimedLeaseObservation; startedAttempt?: StartedAttemptObservation };

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  throw new Error('Document byte authority contains unsupported value');
}

function boundedDigest(value: unknown) {
  // Prisma DateTime and BigInt values are converted before canonicalization;
  // no raw projection is returned to callers or written to the journal.
  const plain = JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item));
  const body = canonical(plain);
  if (Buffer.byteLength(body, 'utf8') > 65536) throw new Error('Document byte authority exceeds limit');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** A consistent, bounded local fact observation for a future independent
 * permit publisher. It is not a policy decision, external-copy inventory,
 * proof that every writer takes the organisation lock, or byte authority.
 * A later permit/worker must re-read and compare this exact projection. */
export async function readCurrentDocumentByteAuthority(prisma: PrismaClient, raw: unknown) {
  return withCurrentDocumentByteAuthorityTransaction(prisma, raw, async (_tx, result) => result);
}

/** The callback runs after the same bounded projection with organisation,
 * Owner, authorization and job locks held. No independent network I/O belongs
 * in this serializable transaction. An exception rolls back its writes. */
export async function withCurrentDocumentByteAuthorityTransaction<T>(prisma: PrismaClient,
  raw: unknown, callback: (tx: Prisma.TransactionClient,
    result: LocalObservation) => Promise<T>) {
  const request: Request = requestSchema.parse(raw);
  return withDocumentByteAuthorityTransaction(prisma, request, null, callback);
}

/** Observe a consumed SQL lease after claim. The one-use secret is checked
 * against its stored hash, and copy/hold observations must still match the
 * lease. This is only local post-claim evidence; it does not authenticate the
 * independent head or authorize provider I/O. */
export async function readClaimedDocumentByteAuthority(prisma: PrismaClient, raw: unknown) {
  const claimed = claimedRequestSchema.parse(raw);
  const request = requestSchema.parse({ installationId: claimed.installationId,
    organisationId: claimed.organisationId, operationId: claimed.operationId });
  return withDocumentByteAuthorityTransaction(prisma, request, claimed,
    async (_tx, result) => {
      if (!result.claimedLease) throw new Error('Document byte lease observation is unavailable');
      return { ...result, claimedLease: result.claimedLease };
    });
}

/** Read a durably started provider attempt against the same bounded local
 * authority as the claimed lease. A start marker means possible provider
 * I/O, including after a crash before the call; this observation cannot
 * authorize a call or classify its result. */
export async function readStartedDocumentByteAuthority(prisma: PrismaClient, raw: unknown) {
  const claimed = claimedRequestSchema.parse(raw);
  const request = requestSchema.parse({ installationId: claimed.installationId,
    organisationId: claimed.organisationId, operationId: claimed.operationId });
  return withDocumentByteAuthorityTransaction(prisma, request, claimed,
    async (_tx, result) => {
      if (!result.claimedLease || !result.startedAttempt) {
        throw new Error('Document byte provider start observation is unavailable');
      }
      return { ...result, claimedLease: result.claimedLease,
        startedAttempt: result.startedAttempt };
    }, true);
}

async function withDocumentByteAuthorityTransaction<T>(prisma: PrismaClient,
  request: Request, claimed: ClaimedRequest | null,
  callback: (tx: Prisma.TransactionClient,
    result: LocalObservation) => Promise<T>, requireStarted = false) {
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Organisation" WHERE id=${request.organisationId} FOR UPDATE`;
    if (locked.length !== 1) throw new Error('Document byte authority organisation is unavailable');

    const committed = await readCommittedDocumentOutcome(tx as unknown as PrismaClient, request);
    const claim = JSON.parse(committed.body) as {
      writerId: string; writerEpoch: number; authorizationId: string; actorUserId: string;
      documentId: string; claimId: string; deletionId: string;
      preparationId: string; preparationDigest: string;
    };
    // Keep the same organisation -> Owner -> authorization order used by the
    // purge service. A concurrent worker update of the exact job must wait
    // until this observation commits or force a serializable retry.
    const ownerLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "User" WHERE id=${claim.actorUserId}
        AND "organisationId"=${request.organisationId} FOR SHARE`;
    const authorizationLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "DocumentPurgeAuthorization" WHERE id=${claim.authorizationId}
        AND "organisationId"=${request.organisationId} FOR SHARE`;
    const jobLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "DocumentStorageDeletion" WHERE id=${claim.deletionId}
        AND "organisationId"=${request.organisationId} FOR SHARE`;
    if (ownerLock.length !== 1 || authorizationLock.length !== 1 || jobLock.length !== 1) {
      throw new Error('Document byte authority locked record is unavailable');
    }
    const [preparation, organisation, enforcement, actor, authorization, policyRows, job,
      copyAuthorities, copyHolds, dispositionEvents, publications,
      standardLinks, confluenceReferences, lease, providerAttempt] = await Promise.all([
      tx.documentRecoveryPreparation.findFirst({ where: { organisationId: request.organisationId,
        installationId: request.installationId, operationId: request.operationId },
        select: { id: true, facts: true, factsDigest: true } }),
      tx.organisation.findFirst({ where: { id: request.organisationId },
        select: { id: true, lifecycleStatus: true, documentStorageProvider: true } }),
      tx.documentRecoveryEnforcement.findFirst({ where: { organisationId: request.organisationId },
        select: { id: true, installationId: true, writerId: true, writerEpoch: true } }),
      tx.user.findFirst({ where: { id: claim.actorUserId, organisationId: request.organisationId },
        select: { id: true, role: true, lifecycleStatus: true } }),
      tx.documentPurgeAuthorization.findFirst({ where: { id: claim.authorizationId,
        organisationId: request.organisationId },
        include: { withdrawal: { select: { id: true } },
          claim: { select: { id: true, deletionId: true } } } }),
      tx.dataRetentionPolicyRevision.findMany({ where: { organisationId: request.organisationId,
        recordClass: 'VAULT_DRAFT', state: 'APPROVED', withdrawal: { is: null } },
        take: 2 }),
      tx.documentStorageDeletion.findFirst({ where: { id: claim.deletionId,
        organisationId: request.organisationId } }),
      tx.documentCopyDispositionAuthority.findMany({ where: { organisationId: request.organisationId,
        authorizationId: claim.authorizationId }, orderBy: { id: 'asc' }, take: 1001 }),
      tx.documentCopyHoldEvent.findMany({ where: { organisationId: request.organisationId,
        authorizationId: claim.authorizationId }, orderBy: { id: 'asc' }, take: 1001 }),
      tx.documentPurgeDispositionEvent.findMany({ where: { organisationId: request.organisationId,
        authorizationId: claim.authorizationId }, orderBy: { id: 'asc' }, take: 1001 }),
      tx.documentPublication.findMany({ where: { organisationId: request.organisationId,
        documentId: claim.documentId }, orderBy: { id: 'asc' }, take: 1001 }),
      tx.documentStandardLink.count({ where: { documentId: claim.documentId } }),
      tx.confluenceReference.count({ where: { documentId: claim.documentId } }),
      claimed ? tx.documentByteExecutionLease.findUnique({
        where: { id: claimed.leaseId }, include: { candidateBinding: true },
      }) : Promise.resolve(null),
      requireStarted && claimed ? tx.documentByteProviderAttempt.findUnique({
        where: { leaseId: claimed.leaseId },
      }) : Promise.resolve(null),
    ]);
    if (!authorization) throw new Error('Document byte authority authorization is unavailable');
    const [uploadIntents, confluenceUploadIntents, pageCreateIntents,
      liveReferences, matchingCleanupJobs] = await Promise.all([
      tx.documentUploadIntent.findMany({ where: { organisationId: request.organisationId,
        OR: [{ documentId: claim.documentId }, { storagePath: authorization.storagePath }] },
        orderBy: { id: 'asc' }, take: 1001 }),
      // A Confluence upload may have reached Atlassian even when its response
      // was lost. The immutable intent is a separate possible-copy fact.
      tx.documentPublicationUploadIntent.findMany({ where: {
        organisationId: request.organisationId, documentId: claim.documentId },
        orderBy: { id: 'asc' }, take: 1001 }),
      tx.documentPublicationPageCreateIntent.findMany({ where: {
        organisationId: request.organisationId, documentId: claim.documentId },
        orderBy: { id: 'asc' }, take: 1001 }),
      tx.document.count({ where: { organisationId: request.organisationId,
        OR: [{ id: claim.documentId }, { fileUrl: authorization.storagePath }] } }),
      tx.documentStorageDeletion.findMany({ where: {
        organisationId: request.organisationId, provider: authorization.provider,
        storagePath: authorization.storagePath },
      select: { id: true }, take: 2 }),
    ]);
    if (!preparation || preparation.id !== claim.preparationId
      || preparation.factsDigest !== claim.preparationDigest) {
      throw new Error('Document byte authority preparation changed');
    }
    const prepared = prepareDocumentRecoveryFacts(JSON.parse(preparation.facts));
    if (prepared.body !== preparation.facts || prepared.digest !== preparation.factsDigest) {
      throw new Error('Document byte authority preparation changed');
    }
    const original = JSON.parse(prepared.body);
    const { claim: _claim, withdrawal: _withdrawal, ...currentAuthorization } = authorization;
    const currentAuthorizationBody = canonical(JSON.parse(JSON.stringify(currentAuthorization)));
    const currentPolicyBody = policyRows.length === 1
      ? canonical(JSON.parse(JSON.stringify(policyRows[0]))) : null;
    // Preparations signed before retentionYears was added omit that field.
    // The migrated policy row contains null. Treat only that legacy omission
    // as equivalent; a year term or any other policy change still fails.
    const originalPolicy = original.policy as Record<string, unknown>;
    const preparedPolicyBody = canonical(Object.hasOwn(originalPolicy, 'retentionYears')
      ? originalPolicy : { ...originalPolicy, retentionYears: null });
    if (!organisation || organisation.lifecycleStatus !== 'ACTIVE'
      || !enforcement || enforcement.installationId !== request.installationId
      || enforcement.writerId !== claim.writerId || enforcement.writerEpoch !== claim.writerEpoch
      || !actor || actor.role !== 'OWNER' || actor.lifecycleStatus !== 'ACTIVE'
      || !authorization || authorization.withdrawal || authorization.id !== claim.authorizationId
      || authorization.documentId !== claim.documentId || authorization.actorUserId !== claim.actorUserId
      || authorization.claim?.id !== claim.claimId || authorization.claim.deletionId !== claim.deletionId
      || policyRows.length !== 1 || policyRows[0]!.id !== authorization.policyId
      || currentAuthorizationBody !== canonical(original.authorization)
      || currentPolicyBody !== preparedPolicyBody
      || !job || job.state !== 'PENDING' || job.processedAt !== null
      || (claimed ? (
        !lease || lease.state !== 'CLAIMED' || lease.claimedAt === null
        || lease.insertTransactionId !== lease.claimTransactionId
        || lease.organisationId !== request.organisationId
        || lease.deletionId !== claim.deletionId
        || lease.candidateBinding.id !== lease.candidateBindingId
        || lease.candidateBinding.deletionId !== claim.deletionId
        || lease.candidateBinding.claimId !== claim.claimId
        || lease.candidateBinding.organisationId !== request.organisationId
        || lease.candidateBinding.installationId !== request.installationId
        || lease.candidateBinding.operationId !== request.operationId
        || lease.candidateBinding.writerId !== claim.writerId
        || lease.candidateBinding.writerEpoch !== claim.writerEpoch
        || lease.candidateBinding.provider !== job.provider
        || lease.candidateBinding.storagePath !== job.storagePath
        || job.claimedAt?.getTime() !== lease.claimedAt.getTime()
        || job.attempts !== 0 || job.deadLetteredAt !== null
        || lease.attemptHash !== createHash('sha256')
          .update(claimed.oneUseAttemptId, 'utf8').digest('hex')
      ) : job.claimedAt !== null)
      || job.targetRef !== null
      || job.sourceDocumentId !== claim.documentId
      || job.storagePath !== authorization.storagePath || job.provider !== authorization.provider
      || matchingCleanupJobs.length !== 1 || matchingCleanupJobs[0]?.id !== claim.deletionId
      || liveReferences !== 0 || standardLinks !== 0 || confluenceReferences !== 0
      || [copyAuthorities, copyHolds, dispositionEvents, publications, uploadIntents,
        confluenceUploadIntents, pageCreateIntents]
        .some(rows => rows.length > 1000)) {
      throw new Error('Document byte authority changed or cannot be bounded');
    }
    // Format 3 also includes possible page creates. Older leases and
    // independent facts fail their digest comparison until republished.
    const digest = boundedDigest({ format: 3, ...request,
      committedOutcomeDigest: committed.digest, organisation, enforcement, actor,
      authorization, policy: policyRows[0], job, copyAuthorities, copyHolds,
      dispositionEvents, publications, uploadIntents, confluenceUploadIntents,
      pageCreateIntents,
      matchingCleanupJobs,
      liveReferences, standardLinks, confluenceReferences });
    // Separate, bounded observations make later copy and hold reconciliation
    // testable without treating the whole local projection as a disposition
    // approval. They cover only rows visible in this transaction. Neither
    // digest inventories provider versions, exports, backups or independent
    // history, and neither is itself a byte-execution decision.
    const localCopyObservationDigest = boundedDigest({ format: 3, ...request,
      authorizationId: claim.authorizationId,
      authorizedDispositionPlan: authorization.dispositionPlan,
      copyAuthorities, dispositionEvents,
      publications, uploadIntents, confluenceUploadIntents, pageCreateIntents,
      matchingCleanupJobs, liveReferences,
      confluenceReferences });
    const localHoldObservationDigest = boundedDigest({ format: 1, ...request,
      authorizationId: claim.authorizationId, policy: policyRows[0],
      authorizationWithdrawal: authorization.withdrawal,
      preparedDocumentDeletionHold: original.document.deletionHold,
      copyHolds });
    if (claimed && (lease?.localCopyObservationDigest !== localCopyObservationDigest
      || lease?.localHoldObservationDigest !== localHoldObservationDigest)) {
      throw new Error('Document byte lease copy or hold authority changed');
    }
    if (requireStarted && (!claimed || !lease || !providerAttempt
      || providerAttempt.id !== lease.id || providerAttempt.leaseId !== lease.id
      || providerAttempt.organisationId !== request.organisationId
      || providerAttempt.deletionId !== claim.deletionId
      || providerAttempt.decisionEntryDigest !== lease.decisionEntryDigest
      || providerAttempt.startedTransactionId === lease.claimTransactionId
      || providerAttempt.startedAt.getTime() < lease.claimedAt!.getTime())) {
      throw new Error('Document byte provider start differs from claimed lease');
    }
    const claimedLease: ClaimedLeaseObservation | undefined = claimed && lease ? {
      decisionEntryDigest: lease.decisionEntryDigest,
      decisionEnvelopeDigest: lease.decisionEnvelopeDigest,
      decisionBodyDigest: lease.decisionBodyDigest,
      providerInventoryDigest: lease.providerInventoryDigest,
      candidateEntryDigest: lease.candidateBinding.permitEntryDigest,
      candidateEnvelopeDigest: lease.candidateBinding.permitEnvelopeDigest,
      outcomeEntryDigest: lease.candidateBinding.outcomeEntryDigest,
      provider: lease.candidateBinding.provider,
      storagePath: lease.candidateBinding.storagePath,
      objectSha256: lease.candidateBinding.objectSha256,
      fileSize: lease.candidateBinding.fileSize,
    } : undefined;
    const startedAttempt: StartedAttemptObservation | undefined = requireStarted && providerAttempt ? {
      startedAt: providerAttempt.startedAt.toISOString(),
      startedTransactionId: providerAttempt.startedTransactionId.toString(),
    } : undefined;
    return callback(tx, { digest, localCopyObservationDigest,
      localHoldObservationDigest, claimedLease, startedAttempt,
      actionAuthorized: false as const });
  }, { isolationLevel: 'Serializable', timeout: 30000 });
}
