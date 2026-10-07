import { createHash } from 'node:crypto';
import { z } from 'zod';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const rowId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/);
const path = z.string().min(1).max(2048).refine(v => !/[\u0000-\u001f\u007f-\u009f]/.test(v));

/** Fourth-stage facts format. This describes a proposed independent decision,
 * not a worker capability. The future publisher must derive and authenticate
 * every digest, evidence reference and one-use attempt from current authority;
 * merely constructing this body is never enough to execute a byte deletion. */
const schema = z.object({
  format: z.literal(1), action: z.literal('DOCUMENT_PRIMARY_BYTE_EXECUTION_DECISION'),
  installationId: identity, organisationId: identity, operationId: identity,
  writerId: identity, writerEpoch: z.number().int().positive().max(2147483647),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  preparationDigest: digest,
  candidateBodyDigest: digest, candidateEntryDigest: digest,
  candidateEnvelopeDigest: digest, candidateGeneration: z.number().int().positive().max(9999),
  candidateAuthorityDigest: digest, controlRevision: revision,
  outcomeId: rowId, claimId: rowId, deletionId: rowId, authorizationId: rowId,
  documentId: rowId, actorUserId: rowId,
  provider: z.enum(['local', 'supabase']), storagePath: path,
  objectSha256: digest, fileSize: z.number().int().nonnegative(),
  copyDispositionDigest: digest, holdStateDigest: digest, providerInventoryDigest: digest,
  decisionEvidenceRef: rowId,
  oneUseAttemptId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  issuedAt: z.string().datetime(),
}).strict();

export type DocumentByteExecutionDecisionFacts = z.infer<typeof schema>;

export function prepareDocumentByteExecutionDecisionFacts(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid document byte execution decision facts');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > 8192) throw new Error('Document byte execution decision exceeds limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'),
    actionAuthorized: false as const };
}
