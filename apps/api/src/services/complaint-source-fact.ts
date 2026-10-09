import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);
const nullableText = (max: number) => z.string().max(max).nullable();
const revision = z.number().int().positive().max(2147483647);

const record = z.object({
  id, organisationId: id, receivedDate: utc, source: nullableText(200),
  summary: z.string().min(1).max(3000), actionTaken: nullableText(3000),
  outcome: nullableText(3000), status: z.enum(['OPEN', 'MONITORING', 'CLOSED']),
  reviewedByBoard: z.boolean(), boardMinuteReference: nullableText(200),
  revision, removedAt: utc.nullable(), removalId: id.nullable(),
  createdAt: utc, updatedAt: utc,
}).strict().refine(value => (value.removedAt === null) === (value.removalId === null));

const schema = z.object({
  format: z.literal(1), kind: z.literal('COMPLAINT_SOURCE_FACT'),
  installationId: id, organisationId: id, operationId: id,
  writerEpoch: revision, sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  mode: z.enum(['BASELINE', 'CREATE', 'UPDATE']),
  previousRecordRevision: revision.nullable(),
  recordedAt: utc, record,
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'Invalid complaint source transition' });
  if (value.record.organisationId !== value.organisationId
    || value.record.updatedAt < value.record.createdAt) fail();
  if (value.mode === 'CREATE' && (value.previousRecordRevision !== null || value.record.revision !== 1)) fail();
  if (value.mode === 'BASELINE' && value.previousRecordRevision !== null) fail();
  if (value.mode === 'UPDATE' && (value.previousRecordRevision === null
    || value.previousRecordRevision + 1 !== value.record.revision)) fail();
});

export type ComplaintSourceFact = z.infer<typeof schema>;

/** Canonical plaintext candidate for a separately approved, encrypted source
 * stream. No provider, authority head, writer fence or live export uses this.
 * A digest of these bytes cannot by itself establish freshness or retention. */
export function prepareComplaintSourceFact(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid complaint source fact');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > 32768) throw new Error('Complaint source fact exceeds its limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'),
    bindingAuthorized: false as const };
}
