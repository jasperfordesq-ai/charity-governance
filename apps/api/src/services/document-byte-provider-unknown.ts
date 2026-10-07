import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prepareDocumentRecoveryFacts } from './document-recovery-preparation.js';

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
  writerId: scopeId, writerEpoch: z.number().int().positive().max(2147483647),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/), preparationDigest: digest,
  leaseId: id, deletionId: id, candidateBindingId: id,
  decisionEntryDigest: digest, decisionEnvelopeDigest: digest,
  decisionBodyDigest: digest,
  startedTransactionId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  startedAt: z.string().datetime(),
}).strict();

export function prepareDocumentByteProviderUnknownFacts(raw: unknown) {
  const body = JSON.stringify(factsSchema.parse(raw));
  if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Document byte UNKNOWN facts exceed limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex') };
}

/** A committed marker is possible I/O, even if the process died before its
 * first provider call. This is the bounded local fact for independent
 * UNKNOWN publication; it is not a provider result or an execution permit. */
export async function readCommittedDocumentByteProviderUnknown(prisma: PrismaClient,
  raw: unknown) {
  const request = requestSchema.parse(raw);
  const lease = await prisma.documentByteExecutionLease.findUnique({
    where: { id: request.leaseId },
    include: { candidateBinding: { include: { preparation: true } }, providerAttempt: true },
  });
  const preparation = lease?.candidateBinding.preparation;
  let sourceRevision: string | null = null;
  if (preparation) {
    const prepared = prepareDocumentRecoveryFacts(JSON.parse(preparation.facts));
    if (prepared.body !== preparation.facts || prepared.digest !== preparation.factsDigest) {
      throw new Error('Committed document byte provider start is unavailable or mismatched');
    }
    sourceRevision = JSON.parse(prepared.body).sourceRevision as string;
  }
  if (!lease || !lease.providerAttempt || lease.state !== 'CLAIMED'
    || lease.claimedAt === null || lease.claimTransactionId === null
    || lease.insertTransactionId !== lease.claimTransactionId
    || lease.organisationId !== request.organisationId
    || lease.candidateBinding.installationId !== request.installationId
    || lease.candidateBinding.organisationId !== request.organisationId
    || lease.candidateBinding.operationId !== request.operationId
    || lease.candidateBinding.id !== lease.candidateBindingId
    || lease.candidateBinding.deletionId !== lease.deletionId
    || !preparation || preparation.id !== lease.candidateBinding.preparationId
    || preparation.installationId !== request.installationId
    || preparation.organisationId !== request.organisationId
    || preparation.operationId !== request.operationId
    || preparation.writerEpoch !== lease.candidateBinding.writerEpoch
    || lease.providerAttempt.id !== lease.id
    || lease.providerAttempt.leaseId !== lease.id
    || lease.providerAttempt.organisationId !== lease.organisationId
    || lease.providerAttempt.deletionId !== lease.deletionId
    || lease.providerAttempt.decisionEntryDigest !== lease.decisionEntryDigest
    || lease.providerAttempt.startedTransactionId === lease.claimTransactionId
    || lease.providerAttempt.startedAt.getTime() < lease.claimedAt.getTime()) {
    throw new Error('Committed document byte provider start is unavailable or mismatched');
  }
  const prepared = prepareDocumentByteProviderUnknownFacts({ format: 1,
    action: 'DOCUMENT_PRIMARY_BYTE_PROVIDER_OUTCOME_UNKNOWN',
    installationId: request.installationId,
    organisationId: request.organisationId,
    operationId: request.operationId,
    writerId: lease.candidateBinding.writerId,
    writerEpoch: lease.candidateBinding.writerEpoch,
    sourceRevision, preparationDigest: preparation.factsDigest,
    leaseId: lease.id, deletionId: lease.deletionId,
    candidateBindingId: lease.candidateBindingId,
    decisionEntryDigest: lease.decisionEntryDigest,
    decisionEnvelopeDigest: lease.decisionEnvelopeDigest,
    decisionBodyDigest: lease.decisionBodyDigest,
    startedTransactionId: lease.providerAttempt.startedTransactionId.toString(),
    startedAt: lease.providerAttempt.startedAt.toISOString(),
  });
  return { ...prepared,
    actionAuthorized: false as const };
}
