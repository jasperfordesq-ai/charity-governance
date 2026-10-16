import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';
import { prepareRetainedConfluenceCopyReview } from './confluence-retained-copy-review.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
export const syntheticScopeInput = z.object({
  organisationId: id, approvedById: id, reviewId: id, expectedSnapshotSha256: hash,
  evidenceRef: evidence, disposalPolicyEvidenceRef: evidence,
  expiresAt: z.string().datetime({ precision: 3 }),
}).strict();
function refuse(): never {
  throw new AppError(409, 'CONFLUENCE_SYNTHETIC_SCOPE_REVIEW_REQUIRED',
    'An exact current synthetic review, active Owner and maintenance table-owner connection are required.');
}

/** Maintenance-only registration. Preview is read-only; exact confirmation
 * permits one immutable scope insert, never a permission or provider action.
 * The existing SQL guard repeats source/Owner/role/time checks on insertion.
 */
export async function registerSyntheticConfluenceScope(prisma: PrismaClient, raw: unknown, confirmation?: string) {
  const input = syntheticScopeInput.parse(raw);
  if (confirmation !== undefined) hash.parse(confirmation);
  return prisma.$transaction(async tx => {
    const [db] = await tx.$queryRaw<Array<{ maintenance: boolean; now: Date; database: string;
      dbRole: string; address: string | null; port: number | null }>>`
      SELECT current_user=session_user AND current_user=pg_get_userbyid(c.relowner) AS maintenance,
        timezone('UTC',statement_timestamp())::timestamp(3) AS now,
        current_database() AS database,current_user AS "dbRole",inet_server_addr()::text AS address,inet_server_port() AS port
      FROM pg_class c WHERE c.oid='public."ConfluenceSyntheticCopyScope"'::regclass`;
    if (!db || db.maintenance !== true || !(db.now instanceof Date) || !Number.isFinite(db.now.getTime())) refuse();
    await tx.$queryRaw`SELECT id FROM public."Organisation" WHERE id=${input.organisationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${input.approvedById} AND "organisationId"=${input.organisationId} FOR UPDATE`;
    const organisation = await tx.organisation.findFirst({ where: { id: input.organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const owner = await tx.user.findFirst({ where: { id: input.approvedById, organisationId: input.organisationId,
      role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    if (!organisation || !owner || await tx.documentRecoveryEnforcement.findUnique({ where: { organisationId: input.organisationId } })) refuse();
    await tx.$queryRaw`SELECT id FROM public."ConfluenceRetainedCopyReview"
      WHERE id=${input.reviewId} AND "organisationId"=${input.organisationId} FOR UPDATE`;
    const row = await tx.confluenceRetainedCopyReview.findFirst({ where: { id: input.reviewId, organisationId: input.organisationId }, include: { withdrawal: true } });
    if (!row || row.withdrawal) refuse();
    const candidate = prepareRetainedConfluenceCopyReview(row.review, db.now);
    const expiry = Date.parse(input.expiresAt);
    if (candidate.review.snapshot.organisationId !== input.organisationId || candidate.review.reviewerId !== input.approvedById
      || candidate.snapshotSha256 !== row.snapshotSha256 || candidate.snapshotSha256 !== input.expectedSnapshotSha256
      || expiry <= db.now.getTime() || expiry > db.now.getTime() + 3600000 || expiry > Date.parse(candidate.review.expiresAt)) refuse();
    await tx.$queryRaw`SELECT public."ConfluenceCopyPermission_current_review"(${input.reviewId},${input.organisationId})::text AS checked`;
    const databaseFingerprint = createHash('sha256').update(JSON.stringify({ database: db.database,
      role: db.dbRole, address: db.address, port: db.port })).digest('hex');
    const plan = { kind: 'REGISTER_SYNTHETIC_CONFLUENCE_SCOPE' as const, databaseFingerprint,
      ...input, classification: 'SYNTHETIC_ONLY' as const, providerIOAuthorised: false as const };
    const confirmationSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    const existing = await tx.confluenceSyntheticCopyScope.findFirst({ where: { reviewId: input.reviewId, organisationId: input.organisationId } });
    if (existing) {
      if (existing.snapshotSha256 !== input.expectedSnapshotSha256 || existing.classification !== 'SYNTHETIC_ONLY'
        || existing.evidenceRef !== input.evidenceRef || existing.disposalPolicyEvidenceRef !== input.disposalPolicyEvidenceRef
        || existing.approvedById !== input.approvedById || existing.expiresAt.getTime() !== expiry) refuse();
      return { ...plan, state: 'ALREADY_REGISTERED' as const, scopeId: existing.id, confirmationSha256 };
    }
    if (confirmation === undefined) return { ...plan, state: 'PREVIEW' as const, confirmationSha256 };
    if (confirmation !== confirmationSha256) throw new AppError(409, 'CONFLUENCE_SYNTHETIC_SCOPE_CONFIRMATION_CHANGED', 'Preview this exact database and scope again.');
    const scope = await tx.confluenceSyntheticCopyScope.create({ data: {
      organisationId: input.organisationId, reviewId: input.reviewId, approvedById: input.approvedById,
      snapshotSha256: input.expectedSnapshotSha256, evidenceRef: input.evidenceRef,
      disposalPolicyEvidenceRef: input.disposalPolicyEvidenceRef, classification: 'SYNTHETIC_ONLY', expiresAt: new Date(input.expiresAt),
    } });
    return { ...plan, state: 'REGISTERED' as const, scopeId: scope.id, confirmationSha256 };
  }, { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 });
}
