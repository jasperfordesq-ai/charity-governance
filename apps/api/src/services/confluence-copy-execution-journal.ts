import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const requestInput = retentionWithdrawalInput.extend({ claimId: id, requestKey: id, action: z.enum(['TRASH','PURGE']) }).strict();
const outcomeInput = z.object({ requestId: id, requestOutcome: z.enum(['ACKNOWLEDGED','REFUSED','UNRESOLVED']),
  automaticRetryAllowed: z.literal(false), providerAbsenceVerified: z.literal(false), allCopiesVerified: z.literal(false) }).strict();
function unresolved(): never {
  throw new AppError(409,'CONFLUENCE_COPY_EXECUTION_JOURNAL_UNRESOLVED',
    'The journal response could not be confirmed. Reconcile its original request receipt before continuing.');
}

/** Internal, inactive journal. No route/worker calls a provider through it.
 * Application reports are not independently verified provider facts. */
export class ConfluenceCopyExecutionJournalService {
  constructor(private readonly prisma: PrismaClient) {}
  async prepare(organisationId: string, actorUserId: string, raw: unknown) {
    const input = requestInput.parse(raw);
    try {
      const row = await this.prisma.confluenceCopyExecutionRequest.create({ data: { organisationId, actorUserId, ...input } });
      return { id: row.id, requestKey: row.requestKey, action: row.action, phase: row.phase,
        providerIOAuthorised: false as const, currentSourceChecked: false as const };
    } catch { return unresolved(); }
  }
  // Internal persistence must not lose an already-received report because the
  // initiating Owner/permission was revoked. SQL binds the original request;
  // there is no public endpoint and the report cannot grant execution or retry.
  async recordOutcome(organisationId: string, raw: unknown) {
    const input = outcomeInput.parse(raw);
    try {
      const row = await this.prisma.confluenceCopyExecutionOutcome.create({ data: { organisationId, ...input } });
      return { id: row.id, requestOutcome: row.requestOutcome, reportingBasis: 'APPLICATION_REPORT' as const,
        automaticRetryAllowed: false as const, providerAbsenceVerified: false as const,
        allCopiesVerified: false as const, providerIOAuthorised: false as const };
    } catch { return unresolved(); }
  }
  async receipt(organisationId: string, actorUserId: string, requestKey: string) {
    id.parse(requestKey);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM public."Organisation" WHERE id=${organisationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const owner = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      const org = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      if (!owner || !org) throw new AppError(403,'CONFLUENCE_COPY_EXECUTION_OWNER_REQUIRED','An active charity Owner is required.');
      const request = await tx.confluenceCopyExecutionRequest.findUnique({
        where: { organisationId_requestKey: { organisationId, requestKey } },
        select: { id: true, claimId: true, requestKey: true, action: true, phase: true, preparedAt: true,
          outcome: { select: { id: true, requestOutcome: true, reportingBasis: true, reportedAt: true,
            automaticRetryAllowed: true, providerAbsenceVerified: true, allCopiesVerified: true } } },
      });
      return { request, providerIOAuthorised: false as const, currentSourceChecked: false as const, absenceProvesFailure: false as const };
    });
  }
}
