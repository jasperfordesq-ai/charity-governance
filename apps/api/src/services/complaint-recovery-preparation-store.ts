import type { PrismaClient } from '@prisma/client';
import { prepareComplaintRecoveryFacts, type ComplaintRecoveryFacts } from './complaint-recovery-preparation.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

/** Internal inactive preparation storage. Not a source-capture API or execution
 * fence. Wiring requires fresh source capture, external reservation and approval
 * of retained fields. The private database copy is plaintext like its source rows;
 * external publication must use the separate approved encryption/custody path. */
export class ComplaintRecoveryPreparationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async persist(organisationId: string, actorUserId: string, raw: unknown) {
    const prepared = prepareComplaintRecoveryFacts(raw);
    const facts = JSON.parse(prepared.body) as ComplaintRecoveryFacts;
    if (facts.organisationId !== organisationId || facts.actorUserId !== actorUserId) {
      throw new Error('Recovery preparation scope mismatch');
    }
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId,
        lifecycleStatus: 'ACTIVE', role: 'OWNER' }, select: { id: true } });
      if (!actor) throw new Error('Recovery preparation requires active charity Owner');
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
    });
  }
}
