import type { Prisma, PrismaClient } from '@prisma/client';
import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { validateStoredConfluenceLedgerCandidate } from './confluence-copy-ledger-candidate-store.js';
import { readPublishedConfluenceCopyLedger } from './published-confluence-copy-ledger.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import type { RecoveryDataKeys } from './recovery-preparation-envelope.js';
import type { ConfluenceCopyLedgerObjects } from './confluence-copy-ledger-envelope.js';
import type { ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';

type Stage = 'PUBLISHED' | 'ACKNOWLEDGED';
type Dependencies = { journal: RecoveryAuthorityJournal; control: Pick<RecoveryControlStore,'readControl'>;
  keys: RecoveryDataKeys; objects: Pick<ConfluenceCopyLedgerObjects,'readConfluenceCopyLedger'>
    & Partial<Pick<ConfluenceCopyRecoveryObjects,'readConfluenceCopyState'>> };

/** Inactive observer only: no object creation, reservation, journal append or
 * slot release. Every retry reauthenticates independent evidence, even when a
 * matching historical local receipt exists. Not a current-state/reopen gate.
 */
export class ConfluenceCopyLedgerProgressStore {
  constructor(private readonly prisma: PrismaClient) {}

  async observe(organisationId: string, actorUserId: string, candidateId: string, stage: Stage, deps: Dependencies) {
    try {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(candidateId) || !['PUBLISHED','ACKNOWLEDGED'].includes(stage)) throw new Error();
      const first = await this.transaction(organisationId,actorUserId,candidateId,async (_tx,row) => row);
      const saved = await validateStoredConfluenceLedgerCandidate(first.capture,first,deps.keys);
      const archive = await readPublishedConfluenceCopyLedger(deps.journal,deps.control,saved.original.binding,deps.keys,deps.objects);
      const current = validateRecoveryControl(await deps.control.readControl());
      if (archive.body !== saved.original.body || archive.envelopeDigest !== saved.candidate.digest
        || current.installationId !== saved.original.binding.context.installationId || current.organisationId !== organisationId
        || current.writerEpoch !== saved.original.binding.context.writerEpoch || current.writerId !== saved.original.binding.observedControl.writerId
        || archive.entryGeneration !== current.generation || archive.entryDigest !== current.digest || archive.revision !== current.revision
        || (current.activeOperation && (current.activeOperation.operationId !== saved.original.binding.context.operationId
          || current.activeOperation.preparationDigest !== saved.original.digest))
        || (stage === 'ACKNOWLEDGED' && current.activeOperation !== null)) throw new Error();
      return await this.transaction(organisationId,actorUserId,candidateId,async (tx,latest) => {
        if (JSON.stringify(first) !== JSON.stringify(latest)) throw new Error();
        if (stage === 'ACKNOWLEDGED') {
          const published = await tx.confluenceCopyLedgerProgress.findUnique({ where: { candidateId_stage: { candidateId, stage: 'PUBLISHED' } } });
          if (!published || published.organisationId !== organisationId || published.actorUserId !== actorUserId
            || published.entryGeneration !== archive.entryGeneration || published.entryDigest !== archive.entryDigest
            || published.envelopeDigest !== archive.envelopeDigest) throw new Error();
        }
        const existing = await tx.confluenceCopyLedgerProgress.findUnique({ where: { candidateId_stage: { candidateId, stage } } });
        if (existing) {
          if (existing.organisationId !== organisationId || existing.actorUserId !== actorUserId
            || existing.entryGeneration !== archive.entryGeneration || existing.entryDigest !== archive.entryDigest
            || existing.envelopeDigest !== archive.envelopeDigest) throw new Error();
          return this.result(existing.id,stage,true);
        }
        const row = await tx.confluenceCopyLedgerProgress.create({ data: { organisationId, actorUserId, candidateId, stage,
          entryGeneration: archive.entryGeneration, entryDigest: archive.entryDigest, envelopeDigest: archive.envelopeDigest,
          observedRevision: archive.revision } });
        return this.result(row.id,stage,false);
      });
    } catch { throw new Error('Confluence ledger progress observation is unresolved; retain the original candidate'); }
  }

  private async transaction<T>(organisationId: string, actorUserId: string, candidateId: string,
    change: (tx: Prisma.TransactionClient, row: Awaited<ReturnType<ConfluenceCopyLedgerProgressStore['load']>>) => Promise<T>) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
      const row = await this.load(tx,organisationId,actorUserId,candidateId);
      return change(tx,row);
    },{ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 });
  }

  private async load(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string, candidateId: string) {
    await lockOrganisationForUpdate(tx,organisationId);
    await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
    const owner = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const charity = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const row = await tx.confluenceCopyLedgerCandidate.findFirst({ where: { id: candidateId, organisationId }, include: { capture: true } });
    if (!owner || !charity || !row || row.id !== candidateId || row.organisationId !== organisationId || row.actorUserId !== actorUserId) throw new Error();
    return row;
  }

  private result(receiptId: string, stage: Stage, replayed: boolean) {
    return { receiptId, stage, replayed, historicalObservationRecorded: true as const,
      actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
  }
}
