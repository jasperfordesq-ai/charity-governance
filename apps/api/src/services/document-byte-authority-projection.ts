import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { readCommittedDocumentOutcome } from './document-recovery-outcome.js';
import { prepareDocumentRecoveryFacts } from './document-recovery-preparation.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const requestSchema = z.object({ installationId: identity, organisationId: identity,
  operationId: identity }).strict();
type Request = z.infer<typeof requestSchema>;

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
    result: { digest: string; actionAuthorized: false }) => Promise<T>) {
  const request: Request = requestSchema.parse(raw);
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
      standardLinks, confluenceReferences] = await Promise.all([
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
    ]);
    if (!authorization) throw new Error('Document byte authority authorization is unavailable');
    const [uploadIntents, liveReferences] = await Promise.all([
      tx.documentUploadIntent.findMany({ where: { organisationId: request.organisationId,
        OR: [{ documentId: claim.documentId }, { storagePath: authorization.storagePath }] },
        orderBy: { id: 'asc' }, take: 1001 }),
      tx.document.count({ where: { organisationId: request.organisationId,
        OR: [{ id: claim.documentId }, { fileUrl: authorization.storagePath }] } }),
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
    if (!organisation || organisation.lifecycleStatus !== 'ACTIVE'
      || !enforcement || enforcement.installationId !== request.installationId
      || enforcement.writerId !== claim.writerId || enforcement.writerEpoch !== claim.writerEpoch
      || !actor || actor.role !== 'OWNER' || actor.lifecycleStatus !== 'ACTIVE'
      || !authorization || authorization.withdrawal || authorization.id !== claim.authorizationId
      || authorization.documentId !== claim.documentId || authorization.actorUserId !== claim.actorUserId
      || authorization.claim?.id !== claim.claimId || authorization.claim.deletionId !== claim.deletionId
      || policyRows.length !== 1 || policyRows[0]!.id !== authorization.policyId
      || currentAuthorizationBody !== canonical(original.authorization)
      || currentPolicyBody !== canonical(original.policy)
      || !job || job.state !== 'PENDING' || job.processedAt !== null || job.claimedAt !== null
      || job.targetRef !== null
      || job.sourceDocumentId !== claim.documentId
      || job.storagePath !== authorization.storagePath || job.provider !== authorization.provider
      || liveReferences !== 0 || standardLinks !== 0 || confluenceReferences !== 0
      || [copyAuthorities, copyHolds, dispositionEvents, publications, uploadIntents]
        .some(rows => rows.length > 1000)) {
      throw new Error('Document byte authority changed or cannot be bounded');
    }
    const digest = boundedDigest({ format: 1, ...request,
      committedOutcomeDigest: committed.digest, organisation, enforcement, actor,
      authorization, policy: policyRows[0], job, copyAuthorities, copyHolds,
      dispositionEvents, publications, uploadIntents,
      liveReferences, standardLinks, confluenceReferences });
    return callback(tx, { digest, actionAuthorized: false as const });
  }, { isolationLevel: 'Serializable', timeout: 30000 });
}
