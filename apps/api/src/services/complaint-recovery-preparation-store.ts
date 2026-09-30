import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prepareComplaintRecoveryFacts, type ComplaintRecoveryFacts } from './complaint-recovery-preparation.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const captureInput = z.object({ installationId: identity, operationId: identity,
  writerEpoch: z.number().int().positive().max(2147483647), authorizationId: identity,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
const policySelect = { id: true, organisationId: true, recordClass: true, revision: true, state: true,
  retentionMode: true, retentionAnchor: true, retentionDays: true, recoveryDays: true,
  createdById: true, createdAt: true, approvedById: true, approvedAt: true, approvalEvidenceRef: true } as const;
const provenanceSelect = { actorUserId: true, evidenceRef: true, reason: true } as const;
const resolutionSelect = { id: true, organisationId: true, complaintId: true, revision: true, recordRevision: true,
  ...provenanceSelect, state: true, resolvedAt: true, occurredAt: true } as const;

/** Internal inactive preparation storage, not an execution fence.
 * Wiring requires external reservation and approval
 * of retained fields. The private database copy is plaintext like its source rows;
 * external publication must use the separate approved encryption/custody path. */
export class ComplaintRecoveryPreparationStore {
  constructor(private readonly prisma: PrismaClient) {}

  private async owner(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string) {
    await lockOrganisationForUpdate(tx, organisationId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
    const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId,
      lifecycleStatus: 'ACTIVE', role: 'OWNER' }, select: { id: true } });
    if (!actor) throw new Error('Recovery preparation requires active charity Owner');
  }

  /** Fresh explicitly selected facts and insertion share one charity-locked
   * transaction. Retry returns original facts, not a newly captured timestamp.
   * Epoch is recorded only; this method does not independently reserve it. */
  async capture(organisationId: string, actorUserId: string, raw: unknown) {
    const input = captureInput.parse(raw);
    return this.prisma.$transaction(async tx => {
      await this.owner(tx, organisationId, actorUserId);
      const existing = await tx.complaintRecoveryPreparation.findUnique({
        where: { organisationId_operationId: { organisationId, operationId: input.operationId } } });
      if (existing) {
        const prepared = prepareComplaintRecoveryFacts(JSON.parse(existing.facts));
        const facts = JSON.parse(prepared.body) as ComplaintRecoveryFacts;
        if (prepared.body !== existing.facts || prepared.digest !== existing.factsDigest
          || facts.organisationId !== organisationId || facts.actorUserId !== actorUserId
          || facts.operationId !== input.operationId || facts.installationId !== input.installationId
          || facts.writerEpoch !== input.writerEpoch || facts.sourceRevision !== input.sourceRevision
          || facts.authorization.id !== input.authorizationId) throw new Error('Recovery operation identity changed');
        return { id: existing.id, digest: existing.factsDigest, replayed: true, actionAuthorized: false as const };
      }
      const auth = await tx.complaintPurgeAuthorization.findFirst({ where: { id: input.authorizationId, organisationId },
        select: { id: true, organisationId: true, complaintId: true, recordRevision: true, holdRevision: true,
          removalId: true, policyId: true, ...provenanceSelect, recoveryUntil: true, authorizedAt: true,
          dispositionPlan: true, claim: { select: { id: true } }, withdrawal: { select: { id: true } } } });
      if (!auth || auth.claim || auth.withdrawal || auth.actorUserId !== actorUserId) {
        throw new Error('Recovery preparation requires unclaimed unwithdrawn Owner review');
      }
      const { claim: _claim, withdrawal: _withdrawal, ...authorization } = auth;
      const complaint = await tx.complaintRecord.findFirst({ where: { id: auth.complaintId, organisationId },
        select: { id: true, organisationId: true, revision: true, status: true, removedAt: true,
          removalId: true, reviewedByBoard: true, boardMinuteReference: true } });
      const removal = await tx.complaintRemoval.findFirst({ where: { id: auth.removalId, organisationId },
        select: { id: true, organisationId: true, complaintId: true, recordRevision: true, ...provenanceSelect,
          policyId: true, resolutionEvidenceId: true, occurredAt: true, recoveryUntil: true } });
      if (!complaint || !removal) throw new Error('Recovery preparation source is missing');
      const currentPolicies = await tx.dataRetentionPolicyRevision.findMany({ where: { organisationId,
        recordClass: 'COMPLAINT', state: 'APPROVED', withdrawal: { is: null } }, take: 2, select: policySelect });
      if (currentPolicies.length !== 1 || currentPolicies[0]!.id !== auth.policyId) {
        throw new Error('Recovery preparation policy changed');
      }
      const removalPolicy = await tx.dataRetentionPolicyRevision.findFirst({
        where: { id: removal.policyId, organisationId }, select: policySelect });
      const resolution = await tx.complaintResolutionEvidence.findFirst({ where: { complaintId: complaint.id, organisationId },
        orderBy: { revision: 'desc' }, select: resolutionSelect });
      const removalResolution = removal.resolutionEvidenceId ? await tx.complaintResolutionEvidence.findFirst({
        where: { id: removal.resolutionEvidenceId, organisationId }, select: resolutionSelect }) : null;
      const latestHold = await tx.complaintHoldEvent.findFirst({ where: { complaintId: complaint.id, organisationId },
        orderBy: { revision: 'desc' }, select: { id: true, organisationId: true, complaintId: true, revision: true,
          recordRevision: true, ...provenanceSelect, held: true, occurredAt: true } });
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC',clock_timestamp())::timestamp(3) AS now`;
      const facts = { format: 1, action: 'COMPLAINT_PURGE_PREPARATION', ...input, organisationId, actorUserId,
        preparedAt: clock!.now, complaint, authorization, policy: currentPolicies[0], removalPolicy,
        removal, resolution, removalResolution, latestHold };
      const { authorizationId: _authorizationId, ...payload } = facts;
      return this.persistInTransaction(tx, organisationId, actorUserId, JSON.parse(JSON.stringify(payload)));
    }, { isolationLevel: 'Serializable' });
  }

  private async persistInTransaction(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string, raw: unknown) {
      const prepared = prepareComplaintRecoveryFacts(raw);
      const facts = JSON.parse(prepared.body) as ComplaintRecoveryFacts;
      const where = { organisationId_operationId: { organisationId, operationId: facts.operationId } };
      const existing = await tx.complaintRecoveryPreparation.findUnique({ where });
      if (existing) {
        // Exact bytes, not only a claimed digest; re-encryption or a new timestamp
        // cannot silently replace the meaning of this operation identity.
        if (existing.facts !== prepared.body || existing.factsDigest !== prepared.digest) {
          throw new Error('Recovery operation already has different preparation facts');
        }
        return { id: existing.id, digest: existing.factsDigest, replayed: true, actionAuthorized: false as const };
      }
      const row = await tx.complaintRecoveryPreparation.create({ data: { organisationId,
        installationId: facts.installationId, operationId: facts.operationId, writerEpoch: facts.writerEpoch,
        authorizationId: facts.authorization.id, actorUserId, facts: prepared.body, factsDigest: prepared.digest },
        select: { id: true, factsDigest: true } });
      return { id: row.id, digest: row.factsDigest, replayed: false, actionAuthorized: false as const };
  }
}
