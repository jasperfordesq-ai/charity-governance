import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const controlId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(2048).refine(v => !/[\u0000-\u001f\u007f-\u009f]/.test(v));

/** A candidate for independent publication. Its hashes must be checked
 * against current history and current local authority before publication.
 * The body cannot by itself authorize a storage worker or provider call. */
const schema = z.object({
  format: z.literal(1), action: z.literal('DOCUMENT_PRIMARY_BYTE_PERMIT_CANDIDATE'),
  installationId: controlId, organisationId: controlId, operationId: controlId,
  writerId: controlId, writerEpoch: z.number().int().positive().max(2147483647),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  preparationDigest: digest, preparationEntryDigest: digest,
  preparationEnvelopeDigest: digest, preparationGeneration: z.number().int().positive().max(9998),
  outcomeBodyDigest: digest, outcomeEntryDigest: digest, outcomeEnvelopeDigest: digest,
  outcomeGeneration: z.number().int().positive().max(9999),
  controlRevision: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/),
  currentAuthorityDigest: digest,
  outcomeId: id, claimId: id, deletionId: id, authorizationId: id,
  documentId: id, actorUserId: id,
  provider: z.enum(['local', 'supabase']), storagePath: path,
  objectSha256: digest, fileSize: z.number().int().nonnegative(),
  issuedAt: z.string().datetime(),
}).strict().refine(v => v.outcomeGeneration === v.preparationGeneration + 1);

export type DocumentBytePermitFacts = z.infer<typeof schema>;

export function prepareDocumentBytePermitFacts(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid document byte permit candidate facts');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > 8192) throw new Error('Document byte permit candidate exceeds limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'),
    actionAuthorized: false as const };
}
