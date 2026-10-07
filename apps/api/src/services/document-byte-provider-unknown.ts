import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const scopeId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({
  installationId: scopeId, organisationId: scopeId, operationId: scopeId,
  leaseId: id,
}).strict();
const factsSchema = z.object({
  format: z.literal(1),
  action: z.literal('DOCUMENT_PRIMARY_BYTE_PROVIDER_OUTCOME_UNKNOWN'),
  installationId: scopeId, organisationId: scopeId, operationId: scopeId,
  leaseId: id, deletionId: id, candidateBindingId: id,
  decisionEntryDigest: digest, decisionEnvelopeDigest: digest,
  startedTransactionId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  startedAt: z.string().datetime(),
}).strict();

/** A committed marker is possible I/O, even if the process died before its
 * first provider call. This is the bounded local fact for future independent
 * UNKNOWN publication; it is not a provider result or an execution permit. */
export async function readCommittedDocumentByteProviderUnknown(prisma: PrismaClient,
  raw: unknown) {
  const request = requestSchema.parse(raw);
  const lease = await prisma.documentByteExecutionLease.findUnique({
    where: { id: request.leaseId },
    include: { candidateBinding: true, providerAttempt: true },
  });
  if (!lease || !lease.providerAttempt || lease.state !== 'CLAIMED'
    || lease.claimedAt === null || lease.claimTransactionId === null
    || lease.insertTransactionId !== lease.claimTransactionId
    || lease.organisationId !== request.organisationId
    || lease.candidateBinding.installationId !== request.installationId
    || lease.candidateBinding.organisationId !== request.organisationId
    || lease.candidateBinding.operationId !== request.operationId
    || lease.candidateBinding.id !== lease.candidateBindingId
    || lease.candidateBinding.deletionId !== lease.deletionId
    || lease.providerAttempt.id !== lease.id
    || lease.providerAttempt.leaseId !== lease.id
    || lease.providerAttempt.organisationId !== lease.organisationId
    || lease.providerAttempt.deletionId !== lease.deletionId
    || lease.providerAttempt.decisionEntryDigest !== lease.decisionEntryDigest
    || lease.providerAttempt.startedTransactionId === lease.claimTransactionId
    || lease.providerAttempt.startedAt.getTime() < lease.claimedAt.getTime()) {
    throw new Error('Committed document byte provider start is unavailable or mismatched');
  }
  const prepared = factsSchema.parse({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_PROVIDER_OUTCOME_UNKNOWN',
    installationId: request.installationId,
    organisationId: request.organisationId,
    operationId: request.operationId,
    leaseId: lease.id, deletionId: lease.deletionId,
    candidateBindingId: lease.candidateBindingId,
    decisionEntryDigest: lease.decisionEntryDigest,
    decisionEnvelopeDigest: lease.decisionEnvelopeDigest,
    startedTransactionId: lease.providerAttempt.startedTransactionId.toString(),
    startedAt: lease.providerAttempt.startedAt.toISOString(),
  });
  const body = JSON.stringify(prepared);
  if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Document byte UNKNOWN facts exceed limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'),
    actionAuthorized: false as const };
}
