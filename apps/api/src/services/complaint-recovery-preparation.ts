import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const revision = z.number().int().positive().max(2147483647);
const time = z.string().datetime(); // Canonical UTC only; never silently rewrite evidence.
const evidence = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const reason = z.string().min(10).max(1000).refine(v => Array.from(v).length <= 500
  && !/[\u0000-\u001f\u007f-\u009f]/.test(v));
const provenance = { actorUserId: id, evidenceRef: evidence, reason };
const scoped = { id, organisationId: id };
const policy = z.object({ ...scoped, recordClass: z.literal('COMPLAINT'), revision,
  state: z.literal('APPROVED'), retentionMode: z.enum(['REVIEW_REQUIRED', 'AFTER_ANCHOR']),
  retentionAnchor: z.literal('RESOLVED_AT').nullable(), retentionDays: z.number().int().min(1).max(36525).nullable(),
  recoveryDays: z.number().int().min(1).max(3650), createdById: id, createdAt: time,
  approvedById: id, approvedAt: time, approvalEvidenceRef: evidence,
}).strict();
const removal = z.object({ ...scoped, complaintId: id, recordRevision: revision,
  ...provenance, policyId: id, resolutionEvidenceId: id.nullable(), occurredAt: time, recoveryUntil: time,
}).strict();
const resolution = z.object({ ...scoped, complaintId: id, revision, recordRevision: revision,
  ...provenance, state: z.enum(['RECORDED', 'WITHDRAWN']), resolvedAt: time.nullable(), occurredAt: time,
}).strict().refine(v => (v.state === 'RECORDED') === (v.resolvedAt !== null));
const hold = z.object({ ...scoped, complaintId: id, revision, recordRevision: revision,
  ...provenance, held: z.literal(false), occurredAt: time,
}).strict();
const area = z.object({ disposition: z.enum(['DISPOSE', 'RETAIN_APPROVED', 'NOT_APPLICABLE']), evidenceRef: evidence }).strict();
const authorization = z.object({ ...scoped, complaintId: id, recordRevision: revision,
  holdRevision: revision.or(z.literal(0)), removalId: id, policyId: id, ...provenance,
  recoveryUntil: time, authorizedAt: time,
  dispositionPlan: z.object({ PRIMARY: area.extend({ disposition: z.literal('DISPOSE') }),
    SNAPSHOTS: area, EXPORTS: area, AUDIT: area, BACKUPS: area, OTHER_COPIES: area }).strict(),
}).strict();

/** Inactive candidate format for the first disposal preparation, NOT the complete
 * recovery history. Reason/actor retention requires policy approval before live
 * export. No subject narrative or whole database record is accepted. */
const schema = z.object({ format: z.literal(1), action: z.literal('COMPLAINT_PURGE_PREPARATION'),
  installationId: id, organisationId: id, operationId: id, writerEpoch: revision,
  actorUserId: id, preparedAt: time, sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  complaint: z.object({ id, organisationId: id, revision, status: z.literal('CLOSED'),
    removedAt: time, removalId: id, reviewedByBoard: z.literal(false), boardMinuteReference: z.null() }).strict(),
  authorization, policy, removalPolicy: policy, removal, removalResolution: resolution.nullable(), resolution: resolution.nullable(), latestHold: hold.nullable(),
}).strict().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const row of [v.complaint, v.authorization, v.policy, v.removalPolicy, v.removal, v.removalResolution, v.resolution, v.latestHold]) {
    if (row && row.organisationId !== v.organisationId) fail('Foreign recovery dependency');
  }
  const a = v.authorization, r = v.removal, p = v.policy, c = v.complaint;
  if (p.id === v.removalPolicy.id && JSON.stringify(p) !== JSON.stringify(v.removalPolicy)) {
    fail('Conflicting versions of one policy identity');
  }
  if (v.resolution && v.removalResolution && v.resolution.id === v.removalResolution.id
    && JSON.stringify(v.resolution) !== JSON.stringify(v.removalResolution)) {
    fail('Conflicting versions of one resolution identity');
  }
  if (a.complaintId !== c.id || r.complaintId !== c.id || a.recordRevision !== c.revision
    || a.removalId !== r.id || c.removalId !== r.id || a.policyId !== p.id
    || r.policyId !== v.removalPolicy.id || a.actorUserId !== v.actorUserId || a.recoveryUntil !== r.recoveryUntil
    || c.removedAt !== r.occurredAt) fail('Mismatched recovery dependency');
  if (a.holdRevision !== (v.latestHold?.revision ?? 0)
    || (v.latestHold && (v.latestHold.complaintId !== c.id || v.latestHold.recordRevision > c.revision))) {
    fail('Mismatched hold dependency');
  }
  for (const p of [v.policy, v.removalPolicy]) if ((p.retentionMode === 'AFTER_ANCHOR') !== (p.retentionDays !== null)
    || (p.retentionMode === 'AFTER_ANCHOR' ? p.retentionAnchor !== 'RESOLVED_AT' : p.retentionAnchor !== null)) {
    fail('Inconsistent policy terms');
  }
  if (v.resolution && (v.resolution.complaintId !== c.id
    || (p.retentionMode === 'AFTER_ANCHOR' && (v.resolution.recordRevision !== r.recordRevision
      || v.resolution.state !== 'RECORDED')))) fail('Mismatched resolution dependency');
  if (v.removalResolution && (v.removalResolution.id !== r.resolutionEvidenceId
    || v.removalResolution.complaintId !== c.id || v.removalResolution.recordRevision !== r.recordRevision
    || v.removalResolution.state !== 'RECORDED')) fail('Mismatched original resolution dependency');
  if ((r.resolutionEvidenceId !== null) !== (v.removalResolution !== null)
    || (p.retentionMode === 'AFTER_ANCHOR' && !v.resolution)) fail('Missing resolution dependency');
});

/** Produces bounded canonical candidate bytes only. Does not persist, encrypt,
 * publish, prove current policy/hold status, reserve an epoch, or authorize a claim. */
export function prepareComplaintRecoveryFacts(raw: unknown) {
  const parsed = schema.safeParse(raw);
  // Avoid exposing validation paths or user-supplied subject values in ordinary logs.
  if (!parsed.success) throw new Error('Invalid complaint recovery preparation');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > 32768) throw new Error('Complaint recovery preparation exceeds its limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'),
    actionAuthorized: false as const };
}
