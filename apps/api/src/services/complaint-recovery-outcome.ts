import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prepareComplaintRecoveryFacts, type ComplaintRecoveryFacts } from './complaint-recovery-preparation.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const requestSchema = z.object({ organisationId: identity, installationId: identity, operationId: identity }).strict();

/** Internal evidence reader, not an API or execution permit. Use the ordinary
 * committed database connection, never an in-flight claim transaction. Remote
 * publication and restored-database trust require separate verification. */
export async function readCommittedComplaintOutcome(prisma: PrismaClient, raw: unknown) {
  const request = requestSchema.parse(raw);
  const row = await prisma.complaintRecoveryOutcome.findFirst({
    where: { preparation: request },
    select: { id: true, transactionId: true, recordedAt: true,
      preparation: { select: { id: true, organisationId: true, installationId: true, operationId: true,
        writerEpoch: true, authorizationId: true, actorUserId: true, facts: true, factsDigest: true } },
      claim: { select: { id: true, organisationId: true, authorizationId: true, complaintId: true,
        actorUserId: true, transactionId: true, claimedAt: true } } },
  });
  if (!row) throw new Error('Committed complaint recovery outcome is unavailable');
  const p = row.preparation, c = row.claim;
  const prepared = prepareComplaintRecoveryFacts(JSON.parse(p.facts));
  const facts = JSON.parse(prepared.body) as ComplaintRecoveryFacts;
  if (prepared.body !== p.facts || prepared.digest !== p.factsDigest
    || p.organisationId !== request.organisationId || p.installationId !== request.installationId
    || p.operationId !== request.operationId || facts.organisationId !== p.organisationId
    || facts.installationId !== p.installationId || facts.operationId !== p.operationId
    || facts.writerEpoch !== p.writerEpoch || facts.authorization.id !== p.authorizationId
    || facts.actorUserId !== p.actorUserId || c.organisationId !== p.organisationId
    || c.authorizationId !== p.authorizationId || c.actorUserId !== p.actorUserId
    || c.complaintId !== facts.complaint.id || row.transactionId !== c.transactionId
    || row.transactionId <= 0n || row.transactionId > 9223372036854775807n
    || row.recordedAt.getTime() < c.claimedAt.getTime()) {
    throw new Error('Committed complaint recovery outcome binding mismatch');
  }
  const body = JSON.stringify({ format: 1, action: 'COMPLAINT_PRIMARY_PURGE_COMMITTED',
    ...request, writerEpoch: p.writerEpoch, preparationSourceRevision: facts.sourceRevision,
    preparationId: identity.parse(p.id), preparationDigest: p.factsDigest, outcomeId: identity.parse(row.id),
    claimId: identity.parse(c.id), authorizationId: identity.parse(c.authorizationId), complaintId: identity.parse(c.complaintId),
    actorUserId: identity.parse(c.actorUserId), transactionId: row.transactionId.toString(),
    claimedAt: c.claimedAt.toISOString(), recordedAt: row.recordedAt.toISOString() });
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'), actionAuthorized: false as const };
}
