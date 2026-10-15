import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { validateConfluenceCopyRecoveryCapture } from './confluence-copy-recovery-capture.js';
import { validateRecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { reserveRecoveryOperation, validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { preserveConfluenceCopyRecoveryFacts, type ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';
import { publishVerifiedConfluenceCopyState, readPublishedConfluenceCopyState } from './published-confluence-copy-state.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const inputSchema = z.object({ captureId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), writerId: identity,
  keyId: z.string(), keyEvidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
  expectedGeneration: z.number().int().nonnegative().max(9999),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().refine(v => (v.expectedGeneration === 0) === (v.expectedDigest === null));
type Dependencies = { journal: RecoveryAuthorityJournal; control: RecoveryControlStore;
  keys: RecoveryDataKeys; objects: ConfluenceCopyRecoveryObjects };

/** Inactive metadata publication only. There is no automatic dispatch, release,
 * provider deletion or current-history/reopening authority in this workflow. */
export class ConfluenceCopyPublicationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async prepare(organisationId: string, actorUserId: string, raw: unknown) {
    const input = inputSchema.parse(raw);
    return this.prisma.$transaction(async tx => {
      await this.ownerFence(tx,organisationId,actorUserId);
      const capture = await tx.confluenceCopyRecoveryCapture.findFirst({ where: { id: input.captureId, organisationId } });
      if (!capture) throw new Error('Confluence publication capture not found in charity');
      const facts = validateConfluenceCopyRecoveryCapture(capture);
      validateRecoveryEnvelopeContext({ installationId: facts.installationId, organisationId,
        operationId: facts.operationId, writerEpoch: facts.writerEpoch, sourceRevision: facts.sourceRevision, keyId: input.keyId });
      const existing = await tx.confluenceCopyPublicationPlan.findUnique({ where: { captureId: capture.id } });
      if (existing) {
        if (existing.organisationId !== organisationId || existing.actorUserId !== actorUserId
          || existing.writerId !== input.writerId || existing.keyId !== input.keyId
          || existing.keyEvidenceRef !== input.keyEvidenceRef || existing.expectedGeneration !== input.expectedGeneration
          || existing.expectedDigest !== input.expectedDigest) throw new Error('Confluence publication plan identity changed');
        return { id: existing.id, replayed: true, actionAuthorized: false as const };
      }
      const plan = await tx.confluenceCopyPublicationPlan.create({ data: { ...input, organisationId, actorUserId } });
      return { id: plan.id, replayed: false, actionAuthorized: false as const };
    }, { isolationLevel: 'ReadCommitted' });
  }

  async resume(organisationId: string, actorUserId: string, planId: string, deps: Dependencies) {
    const load = async (tx: Prisma.TransactionClient) => {
      await this.ownerFence(tx,organisationId,actorUserId);
      const row = await tx.confluenceCopyPublicationPlan.findFirst({ where: { id: planId, organisationId },
        include: { capture: true, receipt: true } });
      if (!row) throw new Error('Confluence publication plan not found in charity');
      const facts = validateConfluenceCopyRecoveryCapture(row.capture);
      if (row.capture.organisationId !== organisationId || row.captureId !== row.capture.id) {
        throw new Error('Confluence publication capture binding mismatch');
      }
      const context = validateRecoveryEnvelopeContext({ installationId: facts.installationId, organisationId,
        operationId: facts.operationId, writerEpoch: facts.writerEpoch, sourceRevision: facts.sourceRevision, keyId: row.keyId });
      return { row, context };
    };
    const original = await this.prisma.$transaction(load, { isolationLevel: 'ReadCommitted' });
    const { row, context } = original;
    const request = { writerId: row.writerId, preparationDigest: row.capture.factsDigest,
      expectedGeneration: row.expectedGeneration, expectedDigest: row.expectedDigest };
    const current = validateRecoveryControl(await deps.control.readControl());
    if (current.installationId !== context.installationId || current.organisationId !== organisationId
      || current.writerId !== row.writerId || current.writerEpoch !== context.writerEpoch) {
      throw new Error('Confluence publication writer binding changed');
    }
    let reconciled = false;
    if (current.generation > row.expectedGeneration) {
      // A head-write acknowledgement may have been lost. Authenticate the
      // already-published entry below, without reacquiring or overwriting a slot.
      reconciled = true;
    } else {
      if (row.receipt) throw new Error('Confluence publication history is behind its committed receipt');
      await reserveRecoveryOperation({ installationId: context.installationId, organisationId,
        operationId: context.operationId, writerEpoch: context.writerEpoch, ...request },deps.control);
      const preserved = await preserveConfluenceCopyRecoveryFacts(row.capture.facts,context,deps.keys,deps.objects);
      const published = await publishVerifiedConfluenceCopyState(deps.journal,deps.control,request,context,deps.keys,deps.objects);
      reconciled = preserved.replayed || published.replayed;
    }
    const observed = await readPublishedConfluenceCopyState(deps.journal,deps.control,context,deps.keys,deps.objects);
    if (observed.body !== row.capture.facts || observed.entryGeneration !== row.expectedGeneration + 1) {
      throw new Error('Confluence publication evidence does not match original plan');
    }
    return this.prisma.$transaction(async tx => {
      const latest = await load(tx);
      const { capture: beforeCapture, receipt: _beforeReceipt, ...beforePlan } = row;
      const { capture: latestCapture, receipt: existing, ...latestPlan } = latest.row;
      if (JSON.stringify(beforePlan) !== JSON.stringify(latestPlan)
        || beforeCapture.facts !== latestCapture.facts || beforeCapture.factsDigest !== latestCapture.factsDigest
        || JSON.stringify(context) !== JSON.stringify(latest.context)) {
        throw new Error('Confluence publication local binding changed');
      }
      if (existing) {
        if (existing.planId !== row.id || existing.envelopeDigest !== observed.envelopeDigest || existing.entryDigest !== observed.entryDigest
          || existing.entryGeneration !== observed.entryGeneration || existing.organisationId !== organisationId) {
          throw new Error('Confluence publication receipt changed');
        }
        return this.result(existing.id,true);
      }
      const receipt = await tx.confluenceCopyPublicationReceipt.create({ data: {
        organisationId, planId: row.id, actorUserId, envelopeDigest: observed.envelopeDigest,
        entryGeneration: observed.entryGeneration, entryDigest: observed.entryDigest,
        verifiedHeadRevision: observed.revision,
      } });
      return this.result(receipt.id,reconciled);
    }, { isolationLevel: 'ReadCommitted' });
  }

  private async ownerFence(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string) {
    await lockOrganisationForUpdate(tx,organisationId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
    const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const charity = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    if (!actor || !charity) throw new Error('Confluence publication requires active charity Owner');
  }

  private result(receiptId: string, replayed: boolean) {
    return { receiptId, replayed, actionAuthorized: false as const,
      currentHistoryVerified: false as const, reopeningAuthorised: false as const };
  }
}
