import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';
import { confluenceCitationObservationSelect, confluenceCitationTargetDigest, liveCitationAnchor } from './confluence-citation-observation.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
export const confluenceSourceInstructionInput = retentionWithdrawalInput.extend({
  clientRequestId: z.string().uuid(), expectedTargetDigest: digest, action: z.enum(['TRASH', 'PURGE']),
  authorityEvidenceRef: evidence, retentionEvidenceRef: evidence, administratorRef: evidence,
  followUpAt: z.string().datetime({ offset: true }), assessmentConfirmed: z.literal(true),
}).strict();
export const confluenceSourceInstructionWithdrawalInput = retentionWithdrawalInput.extend({
  clientRequestId: z.string().uuid(), expectedInstructionDigest: digest,
}).strict();
const citationSchema = z.object({ id, documentId: id.nullable(), cloudId: z.string().min(1).max(160), pageId: id,
  pageVersion: z.number().int().positive(), citedAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
const nonExecution = { providerMutationIssued: z.literal(false), jobCreated: z.literal(false), actionAuthorized: z.literal(false) };
const issueSchema = z.object({ format: z.literal(1), kind: z.literal('CONFLUENCE_SOURCE_INSTRUCTION_V1'),
  clientRequestId: z.string().uuid(), inputDigest: digest, referenceId: id, input: confluenceSourceInstructionInput,
  citation: citationSchema, authorityAssessment: z.literal('OWNER_RECORDED'), ...nonExecution }).strict();
const withdrawalSchema = z.object({ format: z.literal(1), kind: z.literal('CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWAL_V1'),
  clientRequestId: z.string().uuid(), inputDigest: digest, instructionId: id, instructionDigest: digest,
  input: confluenceSourceInstructionWithdrawalInput, ...nonExecution }).strict();
export const sourceInstructionReceiptSchema = issueSchema.extend({ id, actorUserId: id, recordedAt: z.string().datetime() }).strict();
export const sourceInstructionWithdrawalReceiptSchema = withdrawalSchema.extend({ id, actorUserId: id, recordedAt: z.string().datetime() }).strict();
const issuedType = 'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED' as const;
const withdrawnType = 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN' as const;
const select = { id: true, actorUserId: true, occurredAt: true, context: true } as const;
type Row = { id: string; actorUserId: string | null; occurredAt: Date; context: unknown };
type Reader = Pick<Prisma.TransactionClient, 'securityAuditEvent' | 'user'>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => new AppError(409, 'CONFLUENCE_SOURCE_INSTRUCTION_CONFLICT', 'The original instruction, request or cited target differs. Review the original receipt.');
async function owner(client: Pick<Reader, 'user'>, organisationId: string, actorUserId: string) {
  const actor = await client.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE',
    organisation: { is: { lifecycleStatus: 'ACTIVE' } } }, select: { id: true, name: true } });
  if (!actor) throw new AppError(403, 'CONFLUENCE_SOURCE_INSTRUCTION_OWNER_REQUIRED', 'The active charity Owner must record or review this instruction.');
  return actor;
}
export { owner as requireConfluenceInstructionOwner };
export async function lockedOwner(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string) {
  await lockOrganisationForUpdate(tx, organisationId);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR UPDATE`;
  const actor = await owner(tx, organisationId, actorUserId);
  if (await tx.documentRecoveryEnforcement.findUnique({ where: { organisationId }, select: { id: true } })) {
    throw new AppError(409, 'CONFLUENCE_SOURCE_INSTRUCTION_RECOVERY_REQUIRED', 'New instruction decisions require independently recorded recovery evidence.');
  }
  return actor;
}
/** Read after acquiring the decision locks: PostgreSQL now() is transaction
 * start, which can precede a decision committed while this transaction waited. */
export async function sourceInstructionEventTime(tx: Prisma.TransactionClient) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
  if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) throw conflict();
  return clock.now;
}
function issueReceipt(row: Row) {
  const context = issueSchema.parse(row.context);
  if (!row.actorUserId || context.clientRequestId !== context.input.clientRequestId || context.inputDigest !== hash(context.input)
    || context.referenceId !== context.citation.id || context.input.expectedTargetDigest !== confluenceCitationTargetDigest(context.citation)) throw conflict();
  return { id: row.id, actorUserId: row.actorUserId, recordedAt: row.occurredAt.toISOString(), ...context };
}
function withdrawalReceipt(row: Row) {
  const context = withdrawalSchema.parse(row.context);
  if (!row.actorUserId || context.clientRequestId !== context.input.clientRequestId || context.inputDigest !== hash(context.input)
    || context.instructionDigest !== context.input.expectedInstructionDigest) throw conflict();
  return { id: row.id, actorUserId: row.actorUserId, recordedAt: row.occurredAt.toISOString(), ...context };
}
const findRequest = (client: Reader, organisationId: string, type: typeof issuedType | typeof withdrawnType, clientRequestId: string) =>
  client.securityAuditEvent.findFirst({ where: { organisationId, type, context: { path: ['clientRequestId'], equals: clientRequestId } }, select });
async function state(client: Reader, organisationId: string, row: Row) {
  const instruction = issueReceipt(row);
  const withdrawn = await client.securityAuditEvent.findFirst({ where: { organisationId, type: withdrawnType,
    context: { path: ['instructionId'], equals: instruction.id } }, select });
  const withdrawal = withdrawn ? withdrawalReceipt(withdrawn) : null;
  if (withdrawal && (withdrawal.instructionId !== instruction.id || withdrawal.instructionDigest !== instruction.inputDigest
    || Date.parse(withdrawal.recordedAt) < Date.parse(instruction.recordedAt))) throw conflict();
  return { instruction, withdrawal, historicalReceipt: true as const, currentStateVerified: false as const };
}
const originalIssue = (row: Row, actorUserId: string, referenceId: string, inputDigest: string) => {
  const saved = issueReceipt(row);
  if (saved.actorUserId !== actorUserId || saved.referenceId !== referenceId || saved.inputDigest !== inputDigest) throw conflict();
};
const actorLabel = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 160) || 'Owner';

/** A decision record only: no token acquisition, provider action, message or job. */
export async function issueConfluenceSourceInstruction(prisma: PrismaClient,
  input: { organisationId: string; actorUserId: string; referenceId: string; body: unknown }) {
  const body = confluenceSourceInstructionInput.parse(input.body), referenceId = id.parse(input.referenceId), inputDigest = hash(body);
  await owner(prisma, input.organisationId, input.actorUserId);
  const prior = await findRequest(prisma, input.organisationId, issuedType, body.clientRequestId);
  if (prior) { originalIssue(prior, input.actorUserId, referenceId, inputDigest); return state(prisma, input.organisationId, prior); }
  return prisma.$transaction(async tx => {
    const actor = await lockedOwner(tx, input.organisationId, input.actorUserId);
    const existing = await findRequest(tx, input.organisationId, issuedType, body.clientRequestId);
    if (existing) { originalIssue(existing, input.actorUserId, referenceId, inputDigest); return state(tx, input.organisationId, existing); }
    const citation = await tx.confluenceReference.findFirst({ where: { id: referenceId, organisationId: input.organisationId,
      ...liveCitationAnchor(input.organisationId) }, select: confluenceCitationObservationSelect });
    if (!citation || confluenceCitationTargetDigest(citation) !== body.expectedTargetDigest || Date.parse(body.followUpAt) <= Date.now()) throw conflict();
    const context = issueSchema.parse({ format: 1, kind: 'CONFLUENCE_SOURCE_INSTRUCTION_V1', clientRequestId: body.clientRequestId,
      inputDigest, referenceId, input: body, citation: JSON.parse(JSON.stringify(citation)), authorityAssessment: 'OWNER_RECORDED',
      providerMutationIssued: false, jobCreated: false, actionAuthorized: false });
    const occurredAt = await sourceInstructionEventTime(tx);
    if (Date.parse(body.followUpAt) <= occurredAt.getTime()) throw conflict();
    const row = await tx.securityAuditEvent.create({ data: { organisationId: input.organisationId, type: issuedType, occurredAt,
      actorKind: 'USER', actorUserId: input.actorUserId, actorLabel: actorLabel(actor.name),
      subjectLabel: 'Confluence source administrator instruction', reason: body.reason, context: context as Prisma.InputJsonValue }, select });
    return state(tx, input.organisationId, row);
  });
}
export async function readConfluenceSourceInstruction(prisma: Reader, organisationId: string, actorUserId: string, instructionId: string) {
  await owner(prisma, organisationId, actorUserId); id.parse(instructionId);
  const row = z.string().uuid().safeParse(instructionId).success ? await findRequest(prisma, organisationId, issuedType, instructionId)
    : await prisma.securityAuditEvent.findFirst({ where: { id: instructionId, organisationId, type: issuedType }, select });
  if (!row) throw new AppError(404, 'CONFLUENCE_SOURCE_INSTRUCTION_NOT_FOUND', 'No original source instruction was found.');
  return state(prisma, organisationId, row);
}
export async function listConfluenceSourceInstructions(prisma: Reader, organisationId: string, actorUserId: string,
  query: { before?: string; referenceId?: string } = {}) {
  await owner(prisma, organisationId, actorUserId);
  const filter = { organisationId, type: issuedType, ...(query.referenceId
    ? { context: { path: ['referenceId'], equals: id.parse(query.referenceId) } } : {}) };
  const cursor = query.before ? await prisma.securityAuditEvent.findFirst({ where: { ...filter, id: id.parse(query.before) },
    select: { id: true, occurredAt: true } }) : null;
  if (query.before && !cursor) throw conflict();
  const rows = await prisma.securityAuditEvent.findMany({ where: { ...filter, ...(cursor ? { OR: [
    { occurredAt: { lt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
  ] } : {}) }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 26, select });
  return { items: await Promise.all(rows.slice(0, 25).map(row => state(prisma, organisationId, row))),
    nextCursor: rows.length > 25 ? rows[24]!.id : null };
}
export async function withdrawConfluenceSourceInstruction(prisma: PrismaClient,
  input: { organisationId: string; actorUserId: string; instructionId: string; body: unknown }) {
  const body = confluenceSourceInstructionWithdrawalInput.parse(input.body), instructionId = id.parse(input.instructionId), inputDigest = hash(body);
  await owner(prisma, input.organisationId, input.actorUserId);
  return prisma.$transaction(async tx => {
    await lockedOwner(tx, input.organisationId, input.actorUserId);
    const row = await tx.securityAuditEvent.findFirst({ where: { id: instructionId, organisationId: input.organisationId, type: issuedType }, select });
    if (!row) throw new AppError(404, 'CONFLUENCE_SOURCE_INSTRUCTION_NOT_FOUND', 'No original source instruction was found.');
    const current = await state(tx, input.organisationId, row);
    if (current.instruction.inputDigest !== body.expectedInstructionDigest) throw conflict();
    const existing = await findRequest(tx, input.organisationId, withdrawnType, body.clientRequestId);
    if (existing) {
      const saved = withdrawalReceipt(existing);
      if (saved.actorUserId !== input.actorUserId || saved.instructionId !== instructionId || saved.inputDigest !== inputDigest) throw conflict();
      return current;
    }
    if (current.withdrawal) throw new AppError(409, 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN', 'This instruction was already withdrawn. A new decision requires a new reviewed request.');
    const actor = await owner(tx, input.organisationId, input.actorUserId);
    const context = withdrawalSchema.parse({ format: 1, kind: 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWAL_V1', clientRequestId: body.clientRequestId,
      inputDigest, instructionId, instructionDigest: current.instruction.inputDigest, input: body,
      providerMutationIssued: false, jobCreated: false, actionAuthorized: false });
    await tx.securityAuditEvent.create({ data: { organisationId: input.organisationId, type: withdrawnType,
      occurredAt: await sourceInstructionEventTime(tx),
      actorKind: 'USER', actorUserId: input.actorUserId, actorLabel: actorLabel(actor.name),
      subjectLabel: 'Confluence source instruction withdrawal', reason: body.reason, context: context as Prisma.InputJsonValue }, select });
    return state(tx, input.organisationId, row);
  });
}
