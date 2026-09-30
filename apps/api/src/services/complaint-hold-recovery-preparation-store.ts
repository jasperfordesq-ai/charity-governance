import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { complaintHoldInput } from './complaint-hold.service.js';
import { prepareComplaintHoldRecoveryFacts, type ComplaintHoldRecoveryFacts } from './complaint-hold-recovery-preparation.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const inputSchema = complaintHoldInput.extend({ installationId: id, operationId: id,
  writerEpoch: z.number().int().positive().max(2147483647), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict();

export class ComplaintHoldRecoveryPreparationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async capture(organisationId: string, complaintId: string, actorUserId: string, raw: unknown) {
    const input = inputSchema.parse(raw);
    id.parse(organisationId); id.parse(complaintId); id.parse(actorUserId);
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId, lifecycleStatus: 'ACTIVE',
        role: { in: ['OWNER', 'ADMIN'] } }, select: { id: true } });
      if (!actor) throw new Error('Hold preparation requires active charity administrator');
      const existing = await tx.complaintHoldRecoveryPreparation.findUnique({ where: {
        organisationId_operationId: { organisationId, operationId: input.operationId } } });
      if (existing) {
        const prepared = prepareComplaintHoldRecoveryFacts(JSON.parse(existing.facts));
        const facts = JSON.parse(prepared.body) as ComplaintHoldRecoveryFacts;
        if (prepared.body !== existing.facts || prepared.digest !== existing.factsDigest
          || facts.organisationId !== organisationId || facts.complaint.id !== complaintId || facts.actorUserId !== actorUserId
          || facts.installationId !== input.installationId || facts.operationId !== input.operationId
          || facts.writerEpoch !== input.writerEpoch || facts.sourceRevision !== input.sourceRevision
          || facts.complaint.revision !== input.expectedRecordRevision || (facts.previousHold?.revision ?? 0) !== input.expectedHoldRevision
          || facts.decision.held !== input.held || facts.decision.evidenceRef !== input.evidenceRef || facts.decision.reason !== input.reason) {
          throw new Error('Hold recovery operation identity changed');
        }
        return { id: existing.id, digest: existing.factsDigest, replayed: true, actionAuthorized: false as const };
      }
      await tx.$queryRaw`SELECT id FROM "ComplaintRecord" WHERE id=${complaintId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const complaint = await tx.complaintRecord.findFirst({ where: { id: complaintId, organisationId },
        select: { id: true, organisationId: true, revision: true } });
      const previousHold = await tx.complaintHoldEvent.findFirst({ where: { complaintId, organisationId },
        orderBy: { revision: 'desc' }, select: { id: true, organisationId: true, complaintId: true, revision: true,
          recordRevision: true, actorUserId: true, held: true, evidenceRef: true, reason: true, occurredAt: true } });
      if (!complaint || complaint.revision !== input.expectedRecordRevision
        || (previousHold?.revision ?? 0) !== input.expectedHoldRevision || (previousHold?.held ?? false) === input.held) {
        throw new Error('Hold recovery preparation dependencies changed');
      }
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC',clock_timestamp())::timestamp(3) AS now`;
      const facts = { format: 1, action: 'COMPLAINT_HOLD_PREPARATION', installationId: input.installationId,
        organisationId, operationId: input.operationId, writerEpoch: input.writerEpoch, actorUserId,
        sourceRevision: input.sourceRevision, preparedAt: clock!.now, complaint, previousHold,
        decision: { id: randomUUID(), revision: input.expectedHoldRevision + 1, recordRevision: complaint.revision,
          actorUserId, held: input.held, evidenceRef: input.evidenceRef, reason: input.reason } };
      const prepared = prepareComplaintHoldRecoveryFacts(JSON.parse(JSON.stringify(facts)));
      const row = await tx.complaintHoldRecoveryPreparation.create({ data: { organisationId, complaintId, actorUserId,
        installationId: input.installationId, operationId: input.operationId, writerEpoch: input.writerEpoch,
        facts: prepared.body, factsDigest: prepared.digest }, select: { id: true, factsDigest: true } });
      return { id: row.id, digest: row.factsDigest, replayed: false, actionAuthorized: false as const };
    }, { isolationLevel: 'ReadCommitted', timeout: 5000 });
  }
}
