import type { Prisma, PrismaClient, ConfluenceCopyLedgerCandidate, ConfluenceCopyLedgerCapture } from '@prisma/client';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { validateStoredExecutionV2Candidate } from './confluence-execution-v2-store.js';
import { preservePreparedConfluenceExecutionArchiveV2, readConfluenceExecutionArchiveV2,
  type ConfluenceExecutionArchiveV2Objects } from './confluence-execution-archive-v2.js';
import { verifyConfluenceExecutionV2Candidate, publishVerifiedConfluenceExecutionV2,
  type ConfluenceExecutionV2PrefixObjects, type ConfluenceExecutionWriterPolicy } from './confluence-execution-v2-prefix.js';
import { acknowledgeConfluenceExecutionV2Archive } from './confluence-execution-v2-acknowledgement.js';
import { ConfluenceExecutionV2ProgressStore } from './confluence-execution-v2-progress-store.js';
import { reserveRecoveryOperation, validateRecoveryControl, type ConfluenceExecutionV2ReleaseStore } from './recovery-operation-reservation.js';
import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import type { RecoveryDataKeys } from './recovery-preparation-envelope.js';

type Dependencies = { journal: RecoveryAuthorityJournal; control: ConfluenceExecutionV2ReleaseStore;
  keys: RecoveryDataKeys; objects: ConfluenceExecutionArchiveV2Objects & ConfluenceExecutionV2PrefixObjects; policy: ConfluenceExecutionWriterPolicy };
type Loaded = { row: ConfluenceCopyLedgerCandidate & { capture: ConfluenceCopyLedgerCapture }; progress: Array<{ id: string }> };

/** Inactive metadata coordinator for one saved original candidate. No source
 * recapture, encryption, provider-content deletion or recovery/reopen authority.
 * One committed upload-attempt row permits only its successful first caller to
 * invoke creation. Lost attempt commit or missing bytes after an unknown upload
 * require reconciliation, never an automatic second create or timeout unlock.
 */
export class ConfluenceExecutionV2Dispatcher {
  constructor(private readonly prisma: PrismaClient) {}

  async resume(organisationId: string, actorUserId: string, candidateId: string, deps: Dependencies) {
    try {
      deps = {...deps,policy:structuredClone(deps.policy)};
      const load = () => this.fence(organisationId,actorUserId,candidateId,async (_tx,value) => value);
      const first = await load(), saved = await validateStoredExecutionV2Candidate(first.row.capture,first.row,deps.keys);
      const { context, observedControl: original } = saved.original.binding;
      const current = validateRecoveryControl(await deps.control.readControl());
      if (current.installationId !== context.installationId || current.organisationId !== organisationId
        || current.writerId !== original.writerId || current.writerEpoch !== context.writerEpoch
        || current.generation < original.generation || current.generation > original.generation + 1) throw new Error();
      const request = { operationId: context.operationId, writerId: original.writerId, writerEpoch: context.writerEpoch,
        preparationDigest: saved.original.digest, envelopeDigest: saved.candidate.digest,
        expectedGeneration: original.generation, expectedDigest: original.digest };
      const sameLocal = async () => {
        const value = await load(); if (JSON.stringify(value.row) !== JSON.stringify(first.row)) throw new Error(); return value;
      };
      const externalControl = deps.control;
      // No database lock spans provider IO. Recheck current local authority
      // before control changes and archive creation, after asynchronous proofs.
      deps = { ...deps,control: {
        readControl: externalControl.readControl.bind(externalControl),
        compareAndSwapControl: async (revision,next) => { await sameLocal(); return externalControl.compareAndSwapControl(revision,next); },
        releaseConfluenceExecutionV2Control: async (revision,expected) => {
          await sameLocal(); return externalControl.releaseConfluenceExecutionV2Control(revision,expected);
        },
      } };
      if (current.generation === original.generation) {
        if (current.digest !== original.digest || first.progress.length) throw new Error();
        await sameLocal();
        await reserveRecoveryOperation({ installationId: context.installationId, organisationId,
          ...requestWithoutEnvelope(request) },deps.control);
        // Authenticate saved candidate and every supported predecessor payload
        // BEFORE upload. Local candidate bytes here are not remote-presence proof.
        const preparedObjects: ConfluenceExecutionV2PrefixObjects = {
          readConfluenceCopyStateHistory: deps.objects.readConfluenceCopyStateHistory.bind(deps.objects),
          readConfluenceCopyLedgerHistory: deps.objects.readConfluenceCopyLedgerHistory.bind(deps.objects),
          readExecutionLedgerV2At: deps.objects.readExecutionLedgerV2At.bind(deps.objects),
          readExecutionLedgerV2: async supplied => supplied.operationId === context.operationId
            ? saved.candidate.envelope : deps.objects.readExecutionLedgerV2(supplied),
        };
        const prefix = await verifyConfluenceExecutionV2Candidate(deps.journal,deps.control,saved.original.digest,
          saved.original.binding,deps.keys,preparedObjects,deps.policy);
        let mayCreate = false;
        if (!prefix.candidateEntryPresent && !prefix.candidateHeadPublished) {
          const reserved = validateRecoveryControl(await deps.control.readControl());
          mayCreate = await this.fence(organisationId,actorUserId,candidateId,async (tx,latest) => {
            if (JSON.stringify(latest.row) !== JSON.stringify(first.row) || latest.progress.length) throw new Error();
            const existing = await tx.confluenceCopyLedgerUploadAttempt.findUnique({ where: { candidateId } });
            if (existing) {
              const prior = validateRecoveryControl(existing.observedControl);
              const { revision: _priorRevision, ...identity } = prior;
              const { revision: _originalRevision, ...originalIdentity } = original;
              if (existing.organisationId !== organisationId || existing.actorUserId !== actorUserId || existing.candidateId !== candidateId
                || existing.recordedAt < first.row.recordedAt || JSON.stringify(identity) !== JSON.stringify({ ...originalIdentity,
                  activeOperation: { operationId: context.operationId, preparationDigest: saved.original.digest } })) throw new Error();
              return false;
            }
            await tx.confluenceCopyLedgerUploadAttempt.create({ data: { organisationId, candidateId, actorUserId,
              observedControl: reserved as Prisma.InputJsonValue } });
            return true;
          });
        }
        const history = await deps.journal.readConfluenceExecutionV2AppendHistory(request,deps.control);
        await sameLocal();
        if (mayCreate && !history.candidateEntry && !history.candidateHeadPublished) {
          const guardedObjects = {
            readExecutionLedgerV2: deps.objects.readExecutionLedgerV2.bind(deps.objects),
            createExecutionLedgerV2: async (supplied: typeof context, envelope: string) => {
              const latestPrefix = await verifyConfluenceExecutionV2Candidate(deps.journal,deps.control,saved.original.digest,
                saved.original.binding,deps.keys,preparedObjects,deps.policy);
              if (latestPrefix.candidateEntryPresent || latestPrefix.candidateHeadPublished) throw new Error();
              await sameLocal();
              const latestHistory = await deps.journal.readConfluenceExecutionV2AppendHistory(request,deps.control);
              if (latestHistory.candidateEntry || latestHistory.candidateHeadPublished) throw new Error();
              return deps.objects.createExecutionLedgerV2(supplied,envelope);
            },
          };
          await preservePreparedConfluenceExecutionArchiveV2(saved.original,saved.candidate,deps.keys,guardedObjects);
        } else {
          const opened = await readConfluenceExecutionArchiveV2(saved.candidate.digest,saved.original.binding,deps.keys,deps.objects);
          if (opened.body !== saved.original.body) throw new Error();
        }
        await sameLocal();
        await publishVerifiedConfluenceExecutionV2(deps.journal,deps.control,saved.original.digest,saved.original.binding,deps.keys,deps.objects,deps.policy);
      }
      const progress = new ConfluenceExecutionV2ProgressStore(this.prisma);
      const published = await progress.observe(organisationId,actorUserId,candidateId,'PUBLISHED',deps);
      await sameLocal();
      await acknowledgeConfluenceExecutionV2Archive(deps.journal,deps.control,saved.original.digest,saved.original.binding,deps.keys,deps.objects,deps.policy);
      const acknowledged = await progress.observe(organisationId,actorUserId,candidateId,'ACKNOWLEDGED',deps);
      return { publicationReceiptId: published.receiptId, acknowledgementReceiptId: acknowledged.receiptId,
        metadataDispatchAcknowledged: true as const, actionAuthorized: false as const,
        currentHistoryVerified: false as const, independentlyPreserved: false as const, transportStateReconciled: false as const, reopeningAuthorised: false as const };
    } catch { throw new Error('Confluence ledger metadata dispatch is unresolved; retain the original candidate and reconcile its attempt'); }
  }

  private async fence<T>(organisationId: string, actorUserId: string, candidateId: string,
    change: (tx: Prisma.TransactionClient, value: Loaded) => Promise<T>) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(candidateId)) throw new Error();
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
      await lockOrganisationForUpdate(tx,organisationId);
      await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const owner = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      const charity = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      const row = await tx.confluenceCopyLedgerCandidate.findFirst({ where: { id: candidateId, organisationId }, include: { capture: true } });
      if (!owner || !charity || !row || row.id !== candidateId || row.organisationId !== organisationId || row.actorUserId !== actorUserId) throw new Error();
      const progress = await tx.confluenceCopyLedgerProgress.findMany({ where: { candidateId }, select: { id: true } });
      return change(tx,{ row, progress });
    },{ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 });
  }
}

function requestWithoutEnvelope<T extends { envelopeDigest: string }>(request: T) {
  const { envelopeDigest: _envelope, ...reservation } = request; return reservation;
}
