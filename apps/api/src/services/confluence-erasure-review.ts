import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';
import { confluenceErasureTargetDigest, observeConfluenceErasure, type ConfluenceErasureObservationDeps } from './confluence-erasure-observation.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const confluenceErasureReviewInput = retentionWithdrawalInput.extend({
  clientRequestId: z.string().uuid(), expectedTargetDigest: digest, controlPageId: id,
  actionReport: z.enum(['NOT_REPORTED', 'TRASH_REPORTED', 'PURGE_REPORTED']),
  actionEvidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/).nullable(),
  actionReportedAt: z.string().datetime({ offset: true }).nullable(), evidenceReviewed: z.literal(true),
}).strict().superRefine((value, context) => {
  if ((value.actionReport !== 'NOT_REPORTED') !== (value.actionEvidenceRef !== null && value.actionReportedAt !== null)
    || (value.actionReport === 'NOT_REPORTED' && (value.actionEvidenceRef !== null || value.actionReportedAt !== null))) {
    context.addIssue({ code: 'custom', message: 'Reported actions require their own evidence reference and time.' });
  }
});
const observationSchema = z.object({
  deletionId: id, targetDigest: digest, checkedAt: z.string().datetime(),
  status: z.enum(['VISIBLE', 'TRASHED', 'NOT_OBSERVED', 'UNKNOWN']), reason: z.string().nullable(),
  controlPageId: id, controlPageReadable: z.boolean(), scope: z.literal('RECORDED_TARGET_IDS_ONLY'),
  permanentErasureVerified: z.literal(false), allCopiesVerified: z.literal(false), jobUpdated: z.literal(false),
  providerMutationIssued: z.literal(false), actionAuthorized: z.literal(false),
}).strict();
const contextSchema = z.object({
  format: z.literal(1), kind: z.literal('CONFLUENCE_ERASURE_REVIEW_V1'), clientRequestId: z.string().uuid(),
  inputDigest: digest, deletionId: id, input: confluenceErasureReviewInput,
  instruction: z.object({ requestedAt: z.string().datetime(), requestedById: z.string().nullable(), reason: z.string().nullable() }).strict(),
  observation: observationSchema, operatorReportOnly: z.literal(true), actionAuthorized: z.literal(false),
}).strict();
const type = 'CONFLUENCE_ERASURE_REVIEW_RECORDED' as const;
const select = { id: true, actorUserId: true, occurredAt: true, context: true } as const;
const conflict = () => new AppError(409, 'CONFLUENCE_REVIEW_CONFLICT', 'The original request or recorded target differs. Refresh the review history.');
type Reader = Pick<Prisma.TransactionClient, 'securityAuditEvent' | 'user'>;
async function owner(client: Pick<Reader, 'user'>, organisationId: string, actorUserId: string) {
  const actor = await client.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE',
    organisation: { is: { lifecycleStatus: 'ACTIVE' } } }, select: { id: true, name: true } });
  if (!actor) throw new AppError(403, 'CONFLUENCE_REVIEW_OWNER_REQUIRED', 'The active charity Owner must record this review.');
  return actor;
}
function receipt(row: { id: string; actorUserId: string | null; occurredAt: Date; context: unknown }) {
  const context = contextSchema.parse(row.context);
  const originalDigest = createHash('sha256').update(JSON.stringify(context.input)).digest('hex');
  if (context.clientRequestId !== context.input.clientRequestId || context.inputDigest !== originalDigest
    || context.deletionId !== context.observation.deletionId || context.input.expectedTargetDigest !== context.observation.targetDigest
    || context.input.controlPageId !== context.observation.controlPageId) throw conflict();
  return { id: row.id, actorUserId: row.actorUserId, recordedAt: row.occurredAt.toISOString(), ...context, historicalReceipt: true, currentStateVerified: false };
}
const find = (client: Reader, organisationId: string, clientRequestId: string) => client.securityAuditEvent.findFirst({
  where: { organisationId, type, context: { path: ['clientRequestId'], equals: clientRequestId } }, select,
});

export async function readConfluenceErasureReview(prisma: PrismaClient, organisationId: string, actorUserId: string, clientRequestId: string) {
  await owner(prisma, organisationId, actorUserId);
  id.parse(clientRequestId);
  const row = z.string().uuid().safeParse(clientRequestId).success
    ? await find(prisma, organisationId, clientRequestId)
    : await prisma.securityAuditEvent.findFirst({ where: { id: clientRequestId, organisationId, type }, select });
  if (!row) throw new AppError(404, 'CONFLUENCE_REVIEW_NOT_FOUND', 'No original review receipt was found.');
  return receipt(row);
}

/** A local append-only report. Neither an operator claim nor a provider read
 * authorises disposal, proves hidden content absent or closes a deletion job. */
export async function recordConfluenceErasureReview(prisma: PrismaClient,
  input: { organisationId: string; actorUserId: string; deletionId: string; body: unknown }, deps: ConfluenceErasureObservationDeps) {
  const body = confluenceErasureReviewInput.parse(input.body), deletionId = id.parse(input.deletionId);
  if (body.actionReportedAt && Date.parse(body.actionReportedAt) > Date.now()) throw conflict();
  const inputDigest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const original = (row: NonNullable<Awaited<ReturnType<typeof find>>>) => {
    const saved = receipt(row);
    if (saved.inputDigest !== inputDigest || saved.deletionId !== deletionId || saved.actorUserId !== input.actorUserId) throw conflict();
    return saved;
  };
  await owner(prisma, input.organisationId, input.actorUserId);
  const existing = await find(prisma, input.organisationId, body.clientRequestId);
  if (existing) return original(existing);
  const observation = await observeConfluenceErasure(prisma, { organisationId: input.organisationId, deletionId, controlPageId: body.controlPageId }, deps);
  if (observation.targetDigest !== body.expectedTargetDigest) throw conflict();
  return prisma.$transaction(async tx => {
    await lockOrganisationForUpdate(tx, input.organisationId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${input.actorUserId} AND "organisationId"=${input.organisationId} FOR UPDATE`;
    const actor = await owner(tx, input.organisationId, input.actorUserId);
    const saved = await find(tx, input.organisationId, body.clientRequestId);
    if (saved) return original(saved);
    const target = await tx.documentStorageDeletion.findFirst({ where: { id: deletionId, organisationId: input.organisationId, provider: 'confluence' },
      select: { targetRef: true, createdAt: true, requestedById: true, reason: true } });
    if (!target || confluenceErasureTargetDigest(target.targetRef) !== observation.targetDigest) throw conflict();
    const context = contextSchema.parse({ format: 1, kind: 'CONFLUENCE_ERASURE_REVIEW_V1', clientRequestId: body.clientRequestId,
      inputDigest, deletionId, input: body, instruction: { requestedAt: target.createdAt.toISOString(), requestedById: target.requestedById, reason: target.reason },
      observation, operatorReportOnly: true, actionAuthorized: false });
    const row = await tx.securityAuditEvent.create({ data: { organisationId: input.organisationId, type, actorKind: 'USER', actorUserId: input.actorUserId,
      actorLabel: actor.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 160) || 'Owner',
      subjectLabel: 'Confluence erasure review report', reason: body.reason, context: context as Prisma.InputJsonValue }, select });
    return receipt(row);
  });
}
