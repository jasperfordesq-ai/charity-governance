import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prepareComplaintHoldRecoveryFacts, type ComplaintHoldRecoveryFacts } from './complaint-hold-recovery-preparation.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const requestSchema = z.object({ organisationId: id, installationId: id, operationId: id }).strict();
const revision = z.number().int().positive().max(2147483647);
const outcomeSchema = z.object({ format: z.literal(1), action: z.literal('COMPLAINT_HOLD_COMMITTED'),
  ...requestSchema.shape, writerEpoch: revision,
  preparationSourceRevision: z.string().regex(/^[a-f0-9]{40}$/), preparationId: id,
  preparationDigest: z.string().regex(/^[a-f0-9]{64}$/), outcomeId: id,
  holdEventId: id, complaintId: id, actorUserId: id,
  holdRevision: revision, recordRevision: revision, held: z.boolean(),
  transactionId: z.string().regex(/^[1-9][0-9]{0,18}$/)
    .refine(v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n),
  occurredAt: z.string().datetime(), recordedAt: z.string().datetime(),
}).strict().refine(v => Date.parse(v.recordedAt) >= Date.parse(v.occurredAt));

/** Typed serialization only. Database provenance must be established separately. */
export function prepareComplaintHoldOutcomeFacts(raw: unknown) {
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid complaint hold outcome facts');
  const body = JSON.stringify(parsed.data);
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'), actionAuthorized: false as const };
}

/** Read only through a committed database connection. This minimal receipt is
 * not independent publication, permission to release a reservation or reopen. */
export async function readCommittedComplaintHoldOutcome(prisma: PrismaClient, raw: unknown) {
  const request = requestSchema.parse(raw);
  const row = await prisma.complaintHoldRecoveryOutcome.findFirst({ where: { preparation: request },
    include: { preparation: true, holdEvent: true } });
  if (!row) throw new Error('Committed complaint hold outcome is unavailable');
  const p = row.preparation, h = row.holdEvent;
  const prepared = prepareComplaintHoldRecoveryFacts(JSON.parse(p.facts));
  const facts = JSON.parse(prepared.body) as ComplaintHoldRecoveryFacts;
  if (prepared.body !== p.facts || prepared.digest !== p.factsDigest
    || p.organisationId !== request.organisationId || p.installationId !== request.installationId
    || p.operationId !== request.operationId || facts.organisationId !== p.organisationId
    || facts.installationId !== p.installationId || facts.operationId !== p.operationId
    || facts.writerEpoch !== p.writerEpoch || facts.actorUserId !== p.actorUserId
    || facts.complaint.id !== p.complaintId || h.organisationId !== p.organisationId
    || h.complaintId !== p.complaintId || row.preparationId !== p.id || row.holdEventId !== h.id
    || Object.entries(facts.decision).some(([key, value]) => h[key as keyof typeof h] !== value)
    || row.transactionId <= 0n || row.transactionId > 9223372036854775807n
    || !Number.isFinite(h.occurredAt.getTime()) || !Number.isFinite(row.recordedAt.getTime())
    || row.recordedAt.getTime() < h.occurredAt.getTime()) {
    throw new Error('Committed complaint hold outcome binding mismatch');
  }
  return prepareComplaintHoldOutcomeFacts({ format: 1, action: 'COMPLAINT_HOLD_COMMITTED', ...request,
    writerEpoch: p.writerEpoch, preparationSourceRevision: facts.sourceRevision,
    preparationId: id.parse(p.id), preparationDigest: p.factsDigest, outcomeId: id.parse(row.id),
    holdEventId: id.parse(h.id), complaintId: id.parse(h.complaintId), actorUserId: id.parse(h.actorUserId),
    holdRevision: h.revision, recordRevision: h.recordRevision, held: h.held,
    transactionId: row.transactionId.toString(), occurredAt: h.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString() });
}
