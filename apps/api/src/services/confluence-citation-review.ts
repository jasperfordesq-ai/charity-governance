import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { confluenceErasureReviewInput } from './confluence-erasure-review.js';
import { observeConfluenceCitation, confluenceCitationObservationSelect, confluenceCitationTargetDigest } from './confluence-citation-observation.js';
import type { ConfluenceErasureObservationDeps } from './confluence-erasure-observation.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const citationSchema = z.object({ id, documentId: id, cloudId: z.string().min(1).max(160), pageId: id,
  pageVersion: z.number().int().positive(), citedAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
const contextSchema = z.object({
  format: z.literal(1), kind: z.literal('CONFLUENCE_CITATION_REVIEW_V1'), clientRequestId: z.string().uuid(),
  inputDigest: digest, referenceId: id, input: confluenceErasureReviewInput, citation: citationSchema,
  instruction: z.null(),
  observation: z.object({ referenceId: id, targetDigest: digest, checkedAt: z.string().datetime(),
    status: z.enum(['VISIBLE', 'TRASHED', 'NOT_OBSERVED', 'UNKNOWN']), reason: z.string().nullable(),
    controlPageId: id, controlPageReadable: z.boolean(), scope: z.literal('CITED_PAGE_ONLY'),
    attachmentsObserved: z.literal(false), permanentErasureVerified: z.literal(false), allCopiesVerified: z.literal(false),
    jobCreated: z.literal(false), citationUpdated: z.literal(false), providerMutationIssued: z.literal(false), actionAuthorized: z.literal(false),
  }).strict(), operatorReportOnly: z.literal(true), actionAuthorized: z.literal(false),
}).strict();
const type = 'CONFLUENCE_CITATION_REVIEW_RECORDED' as const;
const select = { id: true, actorUserId: true, occurredAt: true, context: true } as const;
const conflict = () => new AppError(409, 'CONFLUENCE_CITATION_REVIEW_CONFLICT', 'The original request or cited target differs. Refresh the review.');
type Reader = Pick<Prisma.TransactionClient, 'securityAuditEvent' | 'user'>;
async function owner(client: Pick<Reader, 'user'>, organisationId: string, actorUserId: string) {
  const actor = await client.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE',
    organisation: { is: { lifecycleStatus: 'ACTIVE' } } }, select: { id: true, name: true } });
  if (!actor) throw new AppError(403, 'CONFLUENCE_REVIEW_OWNER_REQUIRED', 'The active charity Owner must record this review.');
  return actor;
}
function receipt(row: { id: string; actorUserId: string | null; occurredAt: Date; context: unknown }) {
  const context = contextSchema.parse(row.context);
  if (context.clientRequestId !== context.input.clientRequestId
    || context.inputDigest !== createHash('sha256').update(JSON.stringify(context.input)).digest('hex')
    || context.referenceId !== context.citation.id || context.referenceId !== context.observation.referenceId
    || confluenceCitationTargetDigest(context.citation) !== context.observation.targetDigest
    || context.input.expectedTargetDigest !== context.observation.targetDigest
    || context.input.controlPageId !== context.observation.controlPageId) throw conflict();
  return { id: row.id, actorUserId: row.actorUserId, recordedAt: row.occurredAt.toISOString(), ...context,
    historicalReceipt: true, currentStateVerified: false };
}
const find = (client: Reader, organisationId: string, clientRequestId: string) => client.securityAuditEvent.findFirst({
  where: { organisationId, type, context: { path: ['clientRequestId'], equals: clientRequestId } }, select,
});
export async function readConfluenceCitationReview(prisma: PrismaClient, organisationId: string, actorUserId: string, requestId: string) {
  await owner(prisma, organisationId, actorUserId); id.parse(requestId);
  const row = z.string().uuid().safeParse(requestId).success ? await find(prisma, organisationId, requestId)
    : await prisma.securityAuditEvent.findFirst({ where: { id: requestId, organisationId, type }, select });
  if (!row) throw new AppError(404, 'CONFLUENCE_REVIEW_NOT_FOUND', 'No original citation review receipt was found.');
  return receipt(row);
}

/** Reports preserve citation identity and a fresh observation. No deletion
 * instruction is inferred from a citation or an operator's action claim. */
export async function recordConfluenceCitationReview(prisma: PrismaClient,
  input: { organisationId: string; actorUserId: string; referenceId: string; body: unknown },
  deps: Pick<ConfluenceErasureObservationDeps, 'getConnection' | 'getPage' | 'isPageInTrash'>) {
  const body = confluenceErasureReviewInput.parse(input.body), referenceId = id.parse(input.referenceId);
  if (body.actionReportedAt && Date.parse(body.actionReportedAt) > Date.now()) throw conflict();
  const inputDigest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const original = (row: NonNullable<Awaited<ReturnType<typeof find>>>) => {
    const saved = receipt(row);
    if (saved.inputDigest !== inputDigest || saved.referenceId !== referenceId || saved.actorUserId !== input.actorUserId) throw conflict();
    return saved;
  };
  await owner(prisma, input.organisationId, input.actorUserId);
  const existing = await find(prisma, input.organisationId, body.clientRequestId);
  if (existing) return original(existing);
  const observation = await observeConfluenceCitation(prisma, { organisationId: input.organisationId,
    referenceId, controlPageId: body.controlPageId }, deps);
  if (observation.targetDigest !== body.expectedTargetDigest) throw conflict();
  return prisma.$transaction(async tx => {
    await lockOrganisationForUpdate(tx, input.organisationId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${input.actorUserId} AND "organisationId"=${input.organisationId} FOR UPDATE`;
    const actor = await owner(tx, input.organisationId, input.actorUserId);
    const saved = await find(tx, input.organisationId, body.clientRequestId);
    if (saved) return original(saved);
    const citation = await tx.confluenceReference.findFirst({ where: { id: referenceId, organisationId: input.organisationId,
      document: { organisationId: input.organisationId, deletedAt: null } }, select: confluenceCitationObservationSelect });
    if (!citation || confluenceCitationTargetDigest(citation) !== observation.targetDigest) throw conflict();
    const context = contextSchema.parse({ format: 1, kind: 'CONFLUENCE_CITATION_REVIEW_V1', clientRequestId: body.clientRequestId,
      inputDigest, referenceId, input: body, citation: JSON.parse(JSON.stringify(citation)), instruction: null,
      observation, operatorReportOnly: true, actionAuthorized: false });
    return receipt(await tx.securityAuditEvent.create({ data: { organisationId: input.organisationId, type,
      actorKind: 'USER', actorUserId: input.actorUserId,
      actorLabel: actor.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 160) || 'Owner',
      subjectLabel: 'Confluence cited-page review report', reason: body.reason, context: context as Prisma.InputJsonValue }, select }));
  });
}
