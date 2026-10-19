import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import type { ConfluenceErasureObservationDeps } from './confluence-erasure-observation.js';
import { confluenceErasureReviewInput } from './confluence-erasure-review.js';
import { observeConfluenceCitation, confluenceCitationObservationSelect, confluenceCitationTargetDigest, liveCitationAnchor } from './confluence-citation-observation.js';
import { lockedOwner, readConfluenceSourceInstruction, requireConfluenceInstructionOwner, sourceInstructionEventTime,
  sourceInstructionReceiptSchema, sourceInstructionWithdrawalReceiptSchema } from './confluence-source-instruction.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const confluenceSourceFollowupInput = confluenceErasureReviewInput.innerType().extend({ expectedInstructionDigest: digest })
  .strict().superRefine((value, context) => {
    const report = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'expectedInstructionDigest'));
    const validated = confluenceErasureReviewInput.safeParse(report);
    if (!validated.success) for (const issue of validated.error.issues) context.addIssue(issue);
  });
const observationSchema = z.object({ referenceId: id, targetDigest: digest, checkedAt: z.string().datetime(),
  status: z.enum(['VISIBLE', 'TRASHED', 'NOT_OBSERVED', 'UNKNOWN']), reason: z.string().nullable(),
  controlPageId: id, controlPageReadable: z.boolean(), scope: z.literal('CITED_PAGE_ONLY'),
  attachmentsObserved: z.literal(false), permanentErasureVerified: z.literal(false), allCopiesVerified: z.literal(false),
  jobCreated: z.literal(false), citationUpdated: z.literal(false), providerMutationIssued: z.literal(false), actionAuthorized: z.literal(false) }).strict();
const contextSchema = z.object({ format: z.literal(1), kind: z.literal('CONFLUENCE_SOURCE_FOLLOWUP_V1'),
  clientRequestId: z.string().uuid(), inputDigest: digest, instructionId: id, instructionDigest: digest,
  input: confluenceSourceFollowupInput, instruction: sourceInstructionReceiptSchema,
  withdrawal: sourceInstructionWithdrawalReceiptSchema.nullable(), instructionStateAtReport: z.enum(['RECORDED', 'WITHDRAWN']),
  observation: observationSchema, providerMutationIssued: z.literal(false), jobCreated: z.literal(false), actionAuthorized: z.literal(false),
}).strict();
const type = 'CONFLUENCE_SOURCE_FOLLOWUP_RECORDED' as const;
const select = { id: true, actorUserId: true, occurredAt: true, context: true } as const;
type Row = { id: string; actorUserId: string | null; occurredAt: Date; context: unknown };
type Reader = Pick<Prisma.TransactionClient, 'securityAuditEvent' | 'user'>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => new AppError(409, 'CONFLUENCE_SOURCE_FOLLOWUP_CONFLICT', 'The original report, instruction or exact cited target differs. Review the original receipt.');
function chronology(actionAt: string | null, instructionAt: string, maximumAt: number) {
  if (actionAt && (Date.parse(actionAt) < Date.parse(instructionAt) || Date.parse(actionAt) > maximumAt)) throw conflict();
}
function receipt(row: Row) {
  const context = contextSchema.parse(row.context), instruction = context.instruction, withdrawal = context.withdrawal;
  if (!row.actorUserId || context.inputDigest !== hash(context.input) || context.clientRequestId !== context.input.clientRequestId
    || context.instructionId !== instruction.id || context.instructionDigest !== instruction.inputDigest
    || context.input.expectedInstructionDigest !== instruction.inputDigest || instruction.inputDigest !== hash(instruction.input)
    || instruction.clientRequestId !== instruction.input.clientRequestId || Date.parse(instruction.recordedAt) > row.occurredAt.getTime()
    || instruction.referenceId !== instruction.citation.id || context.observation.referenceId !== instruction.referenceId
    || context.input.expectedTargetDigest !== instruction.input.expectedTargetDigest
    || confluenceCitationTargetDigest(instruction.citation) !== context.observation.targetDigest
    || context.observation.targetDigest !== context.input.expectedTargetDigest
    || context.input.controlPageId !== context.observation.controlPageId
    || context.instructionStateAtReport !== (withdrawal ? 'WITHDRAWN' : 'RECORDED')) throw conflict();
  if (withdrawal && (withdrawal.instructionId !== instruction.id || withdrawal.instructionDigest !== instruction.inputDigest
    || withdrawal.input.expectedInstructionDigest !== instruction.inputDigest || withdrawal.inputDigest !== hash(withdrawal.input)
    || withdrawal.clientRequestId !== withdrawal.input.clientRequestId
    || Date.parse(withdrawal.recordedAt) < Date.parse(instruction.recordedAt)
    || Date.parse(withdrawal.recordedAt) > row.occurredAt.getTime())) throw conflict();
  chronology(context.input.actionReportedAt, instruction.recordedAt, row.occurredAt.getTime());
  return { id: row.id, actorUserId: row.actorUserId, recordedAt: row.occurredAt.toISOString(), ...context,
    historicalReceipt: true as const, currentStateVerified: false as const };
}
const findRequest = (client: Reader, organisationId: string, clientRequestId: string) => client.securityAuditEvent.findFirst({
  where: { organisationId, type, context: { path: ['clientRequestId'], equals: clientRequestId } }, select });
function original(row: Row, actorUserId: string, instructionId: string, inputDigest: string) {
  const saved = receipt(row);
  if (saved.actorUserId !== actorUserId || saved.instructionId !== instructionId || saved.inputDigest !== inputDigest) throw conflict();
  return saved;
}
export async function readConfluenceSourceFollowup(prisma: Reader, organisationId: string, actorUserId: string, requestId: string) {
  await requireConfluenceInstructionOwner(prisma, organisationId, actorUserId); id.parse(requestId);
  const row = z.string().uuid().safeParse(requestId).success ? await findRequest(prisma, organisationId, requestId)
    : await prisma.securityAuditEvent.findFirst({ where: { id: requestId, organisationId, type }, select });
  if (!row) throw new AppError(404, 'CONFLUENCE_SOURCE_FOLLOWUP_NOT_FOUND', 'No original source follow-up report was found.');
  return receipt(row);
}
export async function listConfluenceSourceFollowups(prisma: Reader, organisationId: string, actorUserId: string,
  instructionId: string, before?: string) {
  const original = await readConfluenceSourceInstruction(prisma, organisationId, actorUserId, id.parse(instructionId));
  const filter = { organisationId, type, context: { path: ['instructionId'], equals: original.instruction.id } };
  const cursor = before ? await prisma.securityAuditEvent.findFirst({ where: { ...filter, id: id.parse(before) },
    select: { id: true, occurredAt: true } }) : null;
  if (before && !cursor) throw conflict();
  const rows = await prisma.securityAuditEvent.findMany({ where: { ...filter, ...(cursor ? { OR: [
    { occurredAt: { lt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
  ] } : {}) }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 26, select });
  return { items: rows.slice(0, 25).map(receipt), nextCursor: rows.length > 25 ? rows[24]!.id : null };
}
/** Records a fresh read-only observation and an attributable action claim.
 * The instruction/withdrawal snapshots are historical; nothing executes here. */
export async function recordConfluenceSourceFollowup(prisma: PrismaClient,
  input: { organisationId: string; actorUserId: string; instructionId: string; body: unknown },
  deps: Pick<ConfluenceErasureObservationDeps, 'getConnection' | 'getPage' | 'isPageInTrash'>) {
  const body = confluenceSourceFollowupInput.parse(input.body), instructionId = id.parse(input.instructionId), inputDigest = hash(body);
  const before = await readConfluenceSourceInstruction(prisma, input.organisationId, input.actorUserId, instructionId);
  const prior = await findRequest(prisma, input.organisationId, body.clientRequestId);
  if (prior) return original(prior, input.actorUserId, instructionId, inputDigest);
  if (before.instruction.id !== instructionId || before.instruction.inputDigest !== body.expectedInstructionDigest
    || before.instruction.input.expectedTargetDigest !== body.expectedTargetDigest) throw conflict();
  chronology(body.actionReportedAt, before.instruction.recordedAt, Date.now());
  const observation = await observeConfluenceCitation(prisma, { organisationId: input.organisationId,
    referenceId: before.instruction.referenceId, controlPageId: body.controlPageId }, deps);
  if (observation.targetDigest !== body.expectedTargetDigest) throw conflict();
  return prisma.$transaction(async tx => {
    const actor = await lockedOwner(tx, input.organisationId, input.actorUserId);
    const saved = await findRequest(tx, input.organisationId, body.clientRequestId);
    if (saved) return original(saved, input.actorUserId, instructionId, inputDigest);
    const current = await readConfluenceSourceInstruction(tx, input.organisationId, input.actorUserId, instructionId);
    const citation = await tx.confluenceReference.findFirst({ where: { id: current.instruction.referenceId, organisationId: input.organisationId,
      ...liveCitationAnchor(input.organisationId) }, select: confluenceCitationObservationSelect });
    if (current.instruction.inputDigest !== body.expectedInstructionDigest || !citation
      || confluenceCitationTargetDigest(citation) !== observation.targetDigest) throw conflict();
    const context = contextSchema.parse({ format: 1, kind: 'CONFLUENCE_SOURCE_FOLLOWUP_V1', clientRequestId: body.clientRequestId,
      inputDigest, instructionId, instructionDigest: current.instruction.inputDigest, input: body, instruction: current.instruction,
      withdrawal: current.withdrawal, instructionStateAtReport: current.withdrawal ? 'WITHDRAWN' : 'RECORDED', observation,
      providerMutationIssued: false, jobCreated: false, actionAuthorized: false });
    return receipt(await tx.securityAuditEvent.create({ data: { organisationId: input.organisationId, type,
      occurredAt: await sourceInstructionEventTime(tx),
      actorKind: 'USER', actorUserId: input.actorUserId,
      actorLabel: actor.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 160) || 'Owner',
      subjectLabel: 'Confluence source instruction follow-up', reason: body.reason, context: context as Prisma.InputJsonValue }, select }));
  });
}
