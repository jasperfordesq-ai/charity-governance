import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { readCommittedDocumentByteProviderUnknown } from './document-byte-provider-unknown.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const scopeId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({
  installationId: scopeId, organisationId: scopeId, operationId: scopeId,
  leaseId: id,
}).strict();
const factsSchema = z.object({
  format: z.literal(1),
  action: z.literal('DOCUMENT_PRIMARY_BYTE_COMPLETION'),
  // Only the primary active object. Versions, Confluence copies, exports and
  // backups need their own reconciliation before any all-copy result.
  scope: z.literal('PRIMARY_ACTIVE_OBJECT_ONLY'),
  outcome: z.literal('PRIMARY_ACTIVE_OBJECT_ABSENT'),
  installationId: scopeId, organisationId: scopeId, operationId: scopeId,
  writerId: scopeId, writerEpoch: z.number().int().positive().max(2147483647),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/), preparationDigest: digest,
  leaseId: id, deletionId: id, decisionEntryDigest: digest,
  unknownEntryDigest: digest, unknownEnvelopeDigest: digest, unknownBodyDigest: digest,
  providerObservedAt: z.string().datetime(),
  observedTransactionId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  observationRecordedAt: z.string().datetime(),
}).strict();

export function prepareDocumentBytePrimaryCompletionFacts(raw: unknown) {
  const body = JSON.stringify(factsSchema.parse(raw));
  if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Document byte completion facts exceed limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex') };
}

/** The committed local facts a completion must reconcile: the start marker
 * (as its UNKNOWN body) and a recorded primary-absence observation for the
 * same claimed lease, deletion and decision. Neither is a permit; this reads
 * them so the independent completion can be bound to both. */
export async function readRecordedDocumentBytePrimaryObservation(prisma: PrismaClient, raw: unknown) {
  const request = requestSchema.parse(raw);
  const unknown = await readCommittedDocumentByteProviderUnknown(prisma, request);
  const marker = JSON.parse(unknown.body);
  const observation = await prisma.documentByteProviderObservation.findUnique({
    where: { leaseId: request.leaseId },
  });
  if (!observation || observation.id !== request.leaseId || observation.leaseId !== request.leaseId
    || observation.attemptId !== request.leaseId
    || observation.organisationId !== request.organisationId
    || observation.deletionId !== marker.deletionId
    || observation.decisionEntryDigest !== marker.decisionEntryDigest
    || observation.outcome !== 'PRIMARY_ACTIVE_OBJECT_ABSENT'
    || observation.observedTransactionId.toString() === marker.startedTransactionId
    || observation.providerObservedAt.getTime() < Date.parse(marker.startedAt)
    || observation.recordedAt.getTime() < observation.providerObservedAt.getTime()) {
    throw new Error('Recorded document byte observation is unavailable or mismatched');
  }
  return { unknownBody: unknown.body, leaseId: request.leaseId,
    deletionId: observation.deletionId as string,
    decisionEntryDigest: observation.decisionEntryDigest as string,
    providerObservedAt: observation.providerObservedAt,
    observedTransactionId: observation.observedTransactionId.toString(),
    observationRecordedAt: observation.recordedAt,
    actionAuthorized: false as const };
}
