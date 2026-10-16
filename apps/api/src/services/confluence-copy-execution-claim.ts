import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const input = retentionWithdrawalInput.extend({ permissionId: id, operationId: id,
  expectedSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Durable local consumption only. Every new claim remains quarantined, has
 * no provider authority and must acquire independently recoverable execution
 * history/current provider proof before a future coordinator can send anything.
 */
export class ConfluenceCopyExecutionClaimService {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(organisationId: string, actorUserId: string, raw: unknown) {
    const parsed = input.parse(raw);
    try {
      const row = await this.prisma.confluenceCopyExecutionClaim.create({ data: {
        organisationId, actorUserId, permissionId: parsed.permissionId,
        operationId: parsed.operationId, snapshotSha256: parsed.expectedSnapshotSha256,
        evidenceRef: parsed.evidenceRef, reason: parsed.reason,
      } });
      return { id: row.id, operationId: row.operationId, phase: row.phase,
        providerIOAuthorised: false as const, currentSourceChecked: false as const };
    } catch {
      throw new AppError(409, 'CONFLUENCE_COPY_EXECUTION_CLAIM_UNRESOLVED',
        'The permission could not be consumed. Reconcile the operation receipt before continuing.');
    }
  }

  // Lookup reconciles a lost commit response; it never repeats consumption or
  // certifies current authority. Active Owner and tenant checks occur together.
  async receipt(organisationId: string, actorUserId: string, operationId: string) {
    id.parse(operationId);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM public."Organisation" WHERE id=${organisationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const owner = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      const org = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      if (!owner || !org) throw new AppError(403, 'CONFLUENCE_COPY_EXECUTION_OWNER_REQUIRED', 'An active charity Owner is required.');
      const claim = await tx.confluenceCopyExecutionClaim.findUnique({
        where: { organisationId_operationId: { organisationId, operationId } },
        select: { id: true, operationId: true, permissionId: true, phase: true, claimedAt: true },
      });
      return { claim, providerIOAuthorised: false as const, currentSourceChecked: false as const };
    });
  }
}
