import { createHash } from 'node:crypto';
import { z } from 'zod';
import { COPY_AREAS } from './document-disposal-completeness.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const scopeId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const areaSummary = z.object({ plan: z.enum(['DISPOSE', 'RETAIN_APPROVED', 'NOT_APPLICABLE']),
  scopes: z.number().int().nonnegative().max(1000) }).strict();

/** The whole-case outcome: the primary file's reconciled completion, and
 * every copy area resolved against the evidence the completeness digest
 * binds. Counts and digests only: no path, scope reference, reason or
 * evidence text. It carries no time, so the same evidence always produces the
 * same body; whether the case was complete was judged when it was published. */
const factsSchema = z.object({
  format: z.literal(1),
  action: z.literal('DOCUMENT_DISPOSAL_COMPLETE'),
  installationId: scopeId, organisationId: scopeId, operationId: scopeId,
  writerId: scopeId, writerEpoch: z.number().int().positive().max(2147483647),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/), preparationDigest: digest,
  authorizationId: id, deletionId: id,
  completionEntryDigest: digest, completionEnvelopeDigest: digest, completionBodyDigest: digest,
  completenessDigest: digest,
  areas: z.object(Object.fromEntries(COPY_AREAS.map((name) => [name, areaSummary])) as
    Record<typeof COPY_AREAS[number], typeof areaSummary>).strict(),
}).strict();

export function prepareDocumentDisposalOutcomeFacts(raw: unknown) {
  const body = JSON.stringify(factsSchema.parse(raw));
  if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Document disposal outcome facts exceed limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex') };
}
