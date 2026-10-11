import { createHash } from 'node:crypto';
import { z } from 'zod';
import { COPY_AREAS } from './document-disposal-completeness.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const scopeId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const areaSummary = z.object({ plan: z.enum(['DISPOSE', 'RETAIN_APPROVED', 'NOT_APPLICABLE']),
  scopes: z.number().int().nonnegative().max(1000) }).strict();
const area = z.enum(COPY_AREAS);
const scopeRef = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const instant = z.string().datetime();
// The evidence the case closed on, in full, so the independent record can
// replay it after a restore loses the local rows. Controlled references only;
// never free-text reasons or actor identities.
const observation = z.object({ id, area, scopeRef, revision: z.number().int().positive(),
  status: z.enum(['VERIFIED_ABSENT', 'RETAINED_APPROVED', 'NOT_APPLICABLE']), observedAt: instant,
  nextReviewAt: instant.nullable(), evidenceRef: scopeRef, copyAuthorityId: id.nullable() }).strict();
const authority = z.object({ id, area, scopeRef, revision: z.number().int().positive(),
  state: z.literal('AUTHORIZED'), disposition: z.enum(['DISPOSE', 'RETAIN_APPROVED', 'NOT_APPLICABLE']),
  validUntil: instant, evidenceRef: scopeRef }).strict();

/** The whole-case outcome: the primary file's reconciled completion, and
 * every copy area resolved against the evidence the completeness digest
 * binds, which it carries in full (controlled references and times, never
 * free-text reasons, paths or file content). It carries no judgement time, so
 * the same evidence always produces the same body; whether the case was
 * complete was judged when it was published. */
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
  observations: z.array(observation).max(200),
  authorities: z.array(authority).max(200),
}).strict();

/** Bounded so the encrypted outcome stays one object; a larger case is refused
 * rather than published without its evidence. */
export const MAX_DISPOSAL_OUTCOME_BYTES = 8000;

export function prepareDocumentDisposalOutcomeFacts(raw: unknown) {
  const body = JSON.stringify(factsSchema.parse(raw));
  if (Buffer.byteLength(body, 'utf8') > MAX_DISPOSAL_OUTCOME_BYTES) {
    throw new Error('Document disposal outcome facts exceed limit');
  }
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex') };
}
