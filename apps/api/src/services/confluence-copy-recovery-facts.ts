import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalRetainedConfluenceCopyReviewEvidence, SYNTHETIC_COPY_PERMISSION_ATTESTATION } from './confluence-retained-copy-review.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const controlId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime({ precision: 3 });
const evidence = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const reason = z.string().min(10).max(1000).refine((v) => Array.from(v).length <= 500 && !/[\u0000-\u001f\u007f-\u009f]/.test(v));
const review = z.object({ id, organisationId: id, documentId: id, publicationId: id, reviewerId: id,
  snapshotSha256: hash, review: z.unknown().transform((v) => canonicalRetainedConfluenceCopyReviewEvidence(v).review),
  reviewedAt: time, expiresAt: time, authorisesProviderIO: z.literal(false), recordedAt: time }).strict();
const reviewWithdrawal = z.object({ id, organisationId: id, reviewId: id, actorUserId: id,
  evidenceRef: evidence, reason, occurredAt: time }).strict();
const scope = z.object({ id, organisationId: id, reviewId: id, snapshotSha256: hash,
  classification: z.literal('SYNTHETIC_ONLY'), evidenceRef: evidence, disposalPolicyEvidenceRef: evidence,
  approvedById: id, registeredByDbRole: z.string().min(1).max(63).refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v)),
  registeredAt: time, expiresAt: time }).strict();
const permission = z.object({ id, organisationId: id, reviewId: id, scopeId: id, snapshotSha256: hash,
  actorUserId: id, integrationId: id, connectionGeneration: time, evidenceRef: evidence, reason,
  attestation: z.literal(SYNTHETIC_COPY_PERMISSION_ATTESTATION),
  scopeEvidenceRef: evidence, disposalPolicyEvidenceRef: evidence,
  classification: z.literal('OWNER_ATTESTED_SYNTHETIC'), issuedAt: time, expiresAt: time }).strict();
const permissionWithdrawal = z.object({ id, organisationId: id, permissionId: id, actorUserId: id,
  evidenceRef: evidence, reason, occurredAt: time }).strict();
const schema = z.object({ format: z.literal(1), kind: z.literal('CONFLUENCE_COPY_DECISION_STATE_V1'),
  installationId: controlId, organisationId: controlId, operationId: controlId,
  writerEpoch: z.number().int().positive().max(2147483647), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  factsRevision: z.number().int().positive().max(10000), previousFactsDigest: hash.nullable(), capturedAt: time,
  review, reviewWithdrawal: reviewWithdrawal.nullable(), scope: scope.nullable(), permission: permission.nullable(),
  permissionWithdrawal: permissionWithdrawal.nullable(),
}).strict().superRefine((v, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid linked Confluence recovery facts' });
  if ((v.factsRevision === 1) !== (v.previousFactsDigest === null)) fail();
  const r = v.review, s = v.scope, p = v.permission, rw = v.reviewWithdrawal, pw = v.permissionWithdrawal;
  const parsed = canonicalRetainedConfluenceCopyReviewEvidence(r.review);
  if (parsed.snapshotSha256 !== r.snapshotSha256 || r.review.snapshot.organisationId !== v.organisationId
    || r.review.snapshot.documentId !== r.documentId || r.review.snapshot.publicationId !== r.publicationId
    || r.review.reviewerId !== r.reviewerId || r.review.reviewedAt !== r.reviewedAt || r.review.expiresAt !== r.expiresAt
    || r.recordedAt < r.reviewedAt) fail();
  for (const row of [r, rw, s, p, pw]) if (row && row.organisationId !== v.organisationId) fail();
  if (rw && (rw.reviewId !== r.id || rw.occurredAt < r.recordedAt)) fail();
  if (s && (s.reviewId !== r.id || s.snapshotSha256 !== r.snapshotSha256 || s.registeredAt < r.recordedAt
    || s.expiresAt > r.expiresAt || s.expiresAt <= s.registeredAt || (rw && s.registeredAt > rw.occurredAt))) fail();
  if (p && (!s || p.reviewId !== r.id || p.scopeId !== s.id || p.snapshotSha256 !== r.snapshotSha256
    || p.scopeEvidenceRef !== s.evidenceRef || p.disposalPolicyEvidenceRef !== s.disposalPolicyEvidenceRef
    || p.issuedAt < s.registeredAt || p.expiresAt > s.expiresAt || p.expiresAt <= p.issuedAt
    || p.connectionGeneration > p.issuedAt || (rw && p.issuedAt > rw.occurredAt))) fail();
  if (pw && (!p || pw.permissionId !== p.id || pw.occurredAt < p.issuedAt)) fail();
  for (const recorded of [r.recordedAt, rw?.occurredAt, s?.registeredAt, p?.issuedAt, pw?.occurredAt]) {
    if (recorded && recorded > v.capturedAt) fail();
  }
});

export type ConfluenceCopyRecoveryFacts = z.infer<typeof schema>;
// Covers the complete bounded review contract, including its maximum version
// inventory. The evidence is metadata/digests, never primary or provider bytes.
export const CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES = 16 * 1024 * 1024;

export function prepareConfluenceCopyRecoveryFacts(raw: unknown) {
  try {
    const value = schema.parse(raw);
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body, 'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES) throw new Error();
    return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'), actionAuthorized: false as const };
  } catch { throw new Error('Invalid complete Confluence copy recovery facts'); }
}

/** Replaying consecutive authenticated facts must retain every committed
 * record and withdrawal. This is not proof of a current/complete history;
 * the caller must independently authenticate the full chain and live head.
 */
export function assertConfluenceCopyRecoveryProgression(previous: string, next: string) {
  try {
    if (typeof previous !== 'string' || typeof next !== 'string'
      || Buffer.byteLength(previous, 'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES
      || Buffer.byteLength(next, 'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES) throw new Error();
    const a = prepareConfluenceCopyRecoveryFacts(JSON.parse(previous));
    const b = prepareConfluenceCopyRecoveryFacts(JSON.parse(next));
    if (a.body !== previous || b.body !== next) throw new Error('Noncanonical Confluence recovery facts');
    const old = JSON.parse(previous) as ConfluenceCopyRecoveryFacts;
    const current = JSON.parse(next) as ConfluenceCopyRecoveryFacts;
    if (old.installationId !== current.installationId || old.organisationId !== current.organisationId
      || old.writerEpoch !== current.writerEpoch || old.operationId === current.operationId
      || old.factsRevision + 1 !== current.factsRevision || current.previousFactsDigest !== a.digest
      || current.capturedAt < old.capturedAt || JSON.stringify(old.review) !== JSON.stringify(current.review)) {
      throw new Error('Confluence recovery state lineage changed');
    }
    const recordedTimes = { reviewWithdrawal: current.reviewWithdrawal?.occurredAt,
      scope: current.scope?.registeredAt, permission: current.permission?.issuedAt,
      permissionWithdrawal: current.permissionWithdrawal?.occurredAt };
    for (const key of ['reviewWithdrawal', 'scope', 'permission', 'permissionWithdrawal'] as const) {
      if (old[key] !== null && JSON.stringify(old[key]) !== JSON.stringify(current[key])) {
        throw new Error('Confluence recovery state dropped or rewrote committed evidence');
      }
      if (old[key] === null && current[key] !== null
        && (!recordedTimes[key] || recordedTimes[key]! < old.capturedAt)) {
        throw new Error('Confluence recovery state introduced an earlier omitted record');
      }
    }
    return { body: b.body, digest: b.digest, actionAuthorized: false as const,
      currentHistoryVerified: false as const, reopeningAuthorised: false as const };
  } catch { throw new Error('Invalid Confluence recovery state progression'); }
}
