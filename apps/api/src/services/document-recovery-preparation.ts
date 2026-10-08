import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const controlId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const evidence = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime();
const path = z.string().min(1).max(2048).refine(v => !/[\u0000-\u001f\u007f-\u009f]/.test(v));
const reason = z.string().min(10).max(1000).refine(v => Array.from(v).length <= 500
  && !/[\u0000-\u001f\u007f-\u009f]/.test(v));
const disposition = z.object({ disposition: z.enum(['DISPOSE', 'RETAIN_APPROVED', 'NOT_APPLICABLE']),
  evidenceRef: evidence }).strict();
const policy = z.object({ id, organisationId: id, recordClass: z.literal('VAULT_DRAFT'),
  revision: z.number().int().positive().max(2147483647), state: z.literal('APPROVED'),
  retentionMode: z.enum(['REVIEW_REQUIRED', 'AFTER_ANCHOR']),
  retentionAnchor: z.literal('CREATED_AT').nullable(),
  retentionDays: z.number().int().min(1).max(36525).nullable(),
  // Older signed preparations lack this field; new database rows include null.
  retentionYears: z.number().int().min(1).max(100).nullable().optional(),
  recoveryDays: z.number().int().min(1).max(3650),
  createdById: id, createdAt: time, approvedById: id, approvedAt: time,
  approvalEvidenceRef: evidence }).strict();
const withdrawal = z.object({ id, organisationId: id, policyId: id,
  actorUserId: id, reason, evidenceRef: evidence, occurredAt: time }).strict();
const authorization = z.object({ id, organisationId: id, documentId: id,
  documentRevision: time, policyId: id, actorUserId: id, evidenceRef: evidence,
  reason, storagePath: path, provider: z.enum(['local', 'supabase']), sha256: digest,
  fileSize: z.number().int().nonnegative(), recoveryUntil: time,
  dispositionPlan: z.object({ PRIMARY: disposition.extend({ disposition: z.literal('DISPOSE') }),
    VERSIONS: disposition, CONFLUENCE: disposition, EXPORTS: disposition,
    AUDIT: disposition, BACKUPS: disposition }).strict(), authorizedAt: time }).strict();
const document = z.object({ id, organisationId: id, updatedAt: time, createdAt: time,
  lifecycleStatus: z.literal('DRAFT'), deletedAt: time, deletionHold: z.literal(false),
  approvalAsserted: z.literal(false), approvedByResolutionId: z.null(),
  deletedById: id, removedFromRevision: time, removalEvidenceRef: evidence,
  recoveryPolicyId: id, recoveryUntil: time, recoverySha256: digest,
  fileUrl: path, storageProvider: z.enum(['local', 'supabase']),
  fileSize: z.number().int().nonnegative() }).strict();

/** Candidate decision facts only. The subject bytes and descriptive Vault
 * fields are intentionally excluded. This format is not a claim permit. */
const schema = z.object({ format: z.literal(1), action: z.literal('DOCUMENT_PURGE_PREPARATION'),
  installationId: controlId, organisationId: controlId, operationId: controlId,
  writerEpoch: z.number().int().positive().max(2147483647),
  actorUserId: id, preparedAt: time, sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  document, authorization, policy, removalPolicy: policy,
  removalPolicyWithdrawal: withdrawal.nullable() }).strict().superRefine((v, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Mismatched document recovery dependency' });
  const d = v.document, a = v.authorization;
  if ([d.organisationId, a.organisationId, v.policy.organisationId,
    v.removalPolicy.organisationId].some(value => value !== v.organisationId)) fail();
  if (a.documentId !== d.id || a.actorUserId !== v.actorUserId
    || a.documentRevision !== d.updatedAt || a.policyId !== v.policy.id
    || d.recoveryPolicyId !== v.removalPolicy.id || a.recoveryUntil !== d.recoveryUntil
    || a.storagePath !== d.fileUrl || a.provider !== d.storageProvider
    || a.sha256 !== d.recoverySha256 || a.fileSize !== d.fileSize) fail();
  if (v.policy.id === v.removalPolicy.id && JSON.stringify(v.policy) !== JSON.stringify(v.removalPolicy)) fail();
  if (v.removalPolicyWithdrawal && (v.removalPolicyWithdrawal.organisationId !== v.organisationId
    || v.removalPolicyWithdrawal.policyId !== v.removalPolicy.id
    || v.removalPolicy.id === v.policy.id)) fail();
  for (const p of [v.policy, v.removalPolicy]) {
    if (p.retentionYears != null || (p.retentionMode === 'AFTER_ANCHOR') !== (p.retentionDays !== null)
      || (p.retentionMode === 'AFTER_ANCHOR' ? p.retentionAnchor !== 'CREATED_AT' : p.retentionAnchor !== null)) fail();
  }
});

export type DocumentRecoveryFacts = z.infer<typeof schema>;

/** Returns canonical, bounded bytes for a future encrypted publication.
 * It does not capture, reserve, publish, execute, queue work or authorize
 * reopening. Live field retention still requires P05/P08 approval. */
export function prepareDocumentRecoveryFacts(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid document recovery preparation');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > 32768) throw new Error('Document recovery preparation exceeds its limit');
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'),
    actionAuthorized: false as const };
}
