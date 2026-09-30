import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prepareComplaintRecoveryFacts } from './complaint-recovery-preparation.js';
import { prepareComplaintHoldRecoveryFacts } from './complaint-hold-recovery-preparation.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const scopeSchema = z.object({ organisationId: id, installationId: id, operationId: id }).strict();
const requestSchema = scopeSchema.extend({ operationKind: z.enum(['PRIMARY', 'HOLD']) }).strict();
const schema = requestSchema.extend({ format: z.literal(1), action: z.literal('COMPLAINT_OPERATION_CANCELLED'),
  writerId: id, writerEpoch: z.number().int().positive().max(2147483647),
  preparationSourceRevision: z.string().regex(/^[a-f0-9]{40}$/), preparationId: id,
  preparationDigest: z.string().regex(/^[a-f0-9]{64}$/), cancellationId: id,
  complaintId: id, actorUserId: id, reasonCode: z.enum(['OPERATOR_CANCELLED', 'DEPENDENCIES_CHANGED']),
  evidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
  transactionId: z.string().regex(/^[1-9][0-9]{0,18}$/)
    .refine(v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n),
  recordedAt: z.string().datetime(),
}).strict();

/** Typed minimal serialization; this alone does not establish commit provenance. */
export function prepareComplaintCancellationFacts(raw: unknown) {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error('Invalid complaint cancellation facts');
  const body = JSON.stringify(result.data);
  return { body, digest: createHash('sha256').update(body, 'utf8').digest('hex'), actionAuthorized: false as const };
}

/** Use the committed database client, never the cancelling transaction. No
 * independent publication, slot release, takeover or reopening is authorized. */
export async function readCommittedComplaintCancellation(prisma: PrismaClient, raw: unknown) {
  const { operationKind, ...scope } = requestSchema.parse(raw);
  const row = await prisma.complaintRecoveryCancellation.findFirst({
    where: operationKind === 'PRIMARY' ? { primaryPreparation: scope } : { holdPreparation: scope },
    include: { primaryPreparation: { include: { outcome: true, execution: true } },
      holdPreparation: { include: { outcome: true } } },
  });
  if (!row) throw new Error('Committed complaint cancellation is unavailable');
  const p = operationKind === 'PRIMARY' ? row.primaryPreparation : row.holdPreparation;
  const originalId = operationKind === 'PRIMARY' ? row.primaryPreparationId : row.holdPreparationId;
  const otherId = operationKind === 'PRIMARY' ? row.holdPreparationId : row.primaryPreparationId;
  const otherPreparation = operationKind === 'PRIMARY' ? row.holdPreparation : row.primaryPreparation;
  if (!p || otherId !== null || otherPreparation !== null || originalId !== p.id || p.outcome
    || ('execution' in p && p.execution)) throw new Error('Committed complaint cancellation binding mismatch');
  let prepared;
  try {
    prepared = operationKind === 'PRIMARY' ? prepareComplaintRecoveryFacts(JSON.parse(p.facts))
      : prepareComplaintHoldRecoveryFacts(JSON.parse(p.facts));
  } catch { throw new Error('Committed complaint cancellation preparation is invalid'); }
  const facts = JSON.parse(prepared.body);
  if (prepared.body !== p.facts || prepared.digest !== p.factsDigest
    || p.organisationId !== scope.organisationId || p.installationId !== scope.installationId
    || p.operationId !== scope.operationId || facts.organisationId !== p.organisationId
    || facts.installationId !== p.installationId || facts.operationId !== p.operationId
    || facts.writerEpoch !== p.writerEpoch || facts.actorUserId !== p.actorUserId
    || ('authorizationId' in p && facts.authorization.id !== p.authorizationId)
    || ('complaintId' in p && facts.complaint.id !== p.complaintId)
    || !Number.isFinite(row.recordedAt.getTime()) || !Number.isFinite(p.recordedAt.getTime())
    || row.recordedAt.getTime() < p.recordedAt.getTime()) {
    throw new Error('Committed complaint cancellation binding mismatch');
  }
  return prepareComplaintCancellationFacts({ format: 1, action: 'COMPLAINT_OPERATION_CANCELLED', ...scope, operationKind,
    writerId: row.writerId, writerEpoch: p.writerEpoch, preparationSourceRevision: facts.sourceRevision,
    preparationId: p.id, preparationDigest: p.factsDigest, cancellationId: row.id, complaintId: facts.complaint.id,
    actorUserId: row.actorUserId, reasonCode: row.reasonCode, evidenceRef: row.evidenceRef,
    transactionId: row.transactionId.toString(), recordedAt: row.recordedAt.toISOString() });
}
