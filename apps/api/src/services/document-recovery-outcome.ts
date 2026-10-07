import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prepareDocumentRecoveryFacts, type DocumentRecoveryFacts } from './document-recovery-preparation.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const controlIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({ organisationId: controlIdentity,
  installationId: controlIdentity, operationId: controlIdentity }).strict();
const transactionId = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= 9223372036854775807n);
const outcomeSchema = z.object({ format: z.literal(1),
  action: z.literal('DOCUMENT_PRIMARY_PURGE_CLAIM_COMMITTED'),
  ...requestSchema.shape, writerId: controlIdentity,
  writerEpoch: z.number().int().positive().max(2147483647),
  preparationSourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  preparationId: identity, preparationDigest: digest,
  preparationGeneration: z.number().int().positive().max(10000),
  preparationEntryDigest: digest, preparationEnvelopeDigest: digest,
  controlRevision: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/),
  outcomeId: identity, claimId: identity, deletionId: identity,
  authorizationId: identity, documentId: identity, actorUserId: identity,
  transactionId, claimedAt: z.string().datetime(), recordedAt: z.string().datetime(),
}).strict().refine(value => Date.parse(value.recordedAt) >= Date.parse(value.claimedAt));

/** Exact bounded serialization of the local claim result. This is evidence
 * of a committed primary-row deletion and queued byte job, not byte or copy
 * erasure, independent publication or permission to reopen. */
export function prepareDocumentOutcomeFacts(raw: unknown) {
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid document claim outcome facts');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > 8192) throw new Error('Document claim outcome exceeds its limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'),
    actionAuthorized: false as const };
}

/** Read through a committed database connection, never the claim transaction.
 * The source database still needs independent current-history verification
 * before its result can be published or trusted after host loss. */
export async function readCommittedDocumentOutcome(prisma: PrismaClient, raw: unknown) {
  const request = requestSchema.parse(raw);
  const row = await prisma.documentRecoveryOutcome.findFirst({
    where: { preparation: request },
    select: { id: true, transactionId: true, recordedAt: true,
      preparation: { select: { id: true, organisationId: true, installationId: true,
        operationId: true, writerEpoch: true, authorizationId: true, actorUserId: true,
        facts: true, factsDigest: true,
        execution: { select: { writerId: true, generation: true, entryDigest: true,
          envelopeDigest: true, controlRevision: true, transactionId: true } } } },
      claim: { select: { id: true, organisationId: true, authorizationId: true,
        documentId: true, deletionId: true, actorUserId: true,
        transactionId: true, claimedAt: true,
        deletion: { select: { id: true, organisationId: true, sourceDocumentId: true,
          storagePath: true, provider: true } } } } },
  });
  if (!row) throw new Error('Committed document claim outcome is unavailable');
  const p = row.preparation, c = row.claim, e = p.execution, job = c.deletion;
  const prepared = prepareDocumentRecoveryFacts(JSON.parse(p.facts));
  const facts = JSON.parse(prepared.body) as DocumentRecoveryFacts;
  if (prepared.body !== p.facts || prepared.digest !== p.factsDigest
    || p.organisationId !== request.organisationId || p.installationId !== request.installationId
    || p.operationId !== request.operationId || facts.organisationId !== p.organisationId
    || facts.installationId !== p.installationId || facts.operationId !== p.operationId
    || facts.writerEpoch !== p.writerEpoch || facts.authorization.id !== p.authorizationId
    || facts.actorUserId !== p.actorUserId || !e || e.transactionId !== row.transactionId
    || c.organisationId !== p.organisationId || c.authorizationId !== p.authorizationId
    || c.actorUserId !== p.actorUserId || c.documentId !== facts.document.id
    || c.transactionId !== row.transactionId || job.id !== c.deletionId
    || job.organisationId !== c.organisationId || job.sourceDocumentId !== c.documentId
    || job.storagePath !== facts.authorization.storagePath
    || job.provider !== facts.authorization.provider
    || row.transactionId <= 0n || row.transactionId > 9223372036854775807n
    || row.recordedAt.getTime() < c.claimedAt.getTime()) {
    throw new Error('Committed document claim outcome binding mismatch');
  }
  return prepareDocumentOutcomeFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_PURGE_CLAIM_COMMITTED', ...request,
    writerId: e.writerId, writerEpoch: p.writerEpoch,
    preparationSourceRevision: facts.sourceRevision,
    preparationId: identity.parse(p.id), preparationDigest: p.factsDigest,
    preparationGeneration: e.generation,
    preparationEntryDigest: e.entryDigest,
    preparationEnvelopeDigest: e.envelopeDigest,
    controlRevision: e.controlRevision,
    outcomeId: identity.parse(row.id), claimId: identity.parse(c.id),
    deletionId: identity.parse(c.deletionId),
    authorizationId: identity.parse(c.authorizationId),
    documentId: identity.parse(c.documentId), actorUserId: identity.parse(c.actorUserId),
    transactionId: row.transactionId.toString(),
    claimedAt: c.claimedAt.toISOString(), recordedAt: row.recordedAt.toISOString() });
}
