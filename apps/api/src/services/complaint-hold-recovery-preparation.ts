import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const revision = z.number().int().positive().max(2147483647);
const reason = z.string().min(10).max(500).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/);
const evidenceRef = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const decision = { id, revision, recordRevision: revision, actorUserId: id, held: z.boolean(), evidenceRef, reason };
const schema = z.object({ format: z.literal(1), action: z.literal('COMPLAINT_HOLD_PREPARATION'),
  installationId: id, organisationId: id, operationId: id, writerEpoch: revision,
  actorUserId: id, sourceRevision: z.string().regex(/^[a-f0-9]{40}$/), preparedAt: z.string().datetime(),
  complaint: z.object({ id, organisationId: id, revision }).strict(),
  previousHold: z.object({ ...decision, organisationId: id, complaintId: id, occurredAt: z.string().datetime() }).strict().nullable(),
  decision: z.object(decision).strict(),
}).strict().superRefine((value, ctx) => {
  const previous = value.previousHold, next = value.decision;
  if (value.complaint.organisationId !== value.organisationId
    || (previous && (previous.organisationId !== value.organisationId || previous.complaintId !== value.complaint.id
      || previous.recordRevision > value.complaint.revision || previous.id === next.id))
    || next.actorUserId !== value.actorUserId || next.recordRevision !== value.complaint.revision
    || next.revision !== (previous?.revision ?? 0) + 1 || next.held === (previous?.held ?? false)) {
    ctx.addIssue({ code: 'custom', message: 'Mismatched complaint hold dependency' });
  }
});
export type ComplaintHoldRecoveryFacts = z.infer<typeof schema>;

/** Candidate facts only. Does not apply/release a hold, publish or authorize
 * execution. Reasons/actor references require approved custody before export. */
export function prepareComplaintHoldRecoveryFacts(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid complaint hold recovery preparation');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > 8192) throw new Error('Complaint hold preparation exceeds its limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'), actionAuthorized: false as const };
}
