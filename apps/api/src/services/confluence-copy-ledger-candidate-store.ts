import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, ConfluenceCopyLedgerCandidate, ConfluenceCopyLedgerCapture } from '@prisma/client';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { validateStoredConfluenceLedgerCapture } from './confluence-copy-ledger-capture-store.js';
import { sealConfluenceCopyLedgerArchive, openConfluenceCopyLedgerArchive,
  CONFLUENCE_COPY_LEDGER_MAX_ENVELOPE_BYTES } from './confluence-copy-ledger-envelope.js';
import type { RecoveryDataKeys } from './recovery-preparation-envelope.js';

/** Inactive original ciphertext preparation only. KMS work is outside database
 * locks; the winning immutable row is committed before callers receive bytes.
 * No object lookup/create, reservation, publication or disposal occurs here.
 */
export class ConfluenceCopyLedgerCandidateStore {
  constructor(private readonly prisma: PrismaClient) {}

  async prepare(organisationId: string, actorUserId: string, captureId: string, keys: RecoveryDataKeys) {
    try {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(captureId)) throw new Error();
      const first = await this.transaction(organisationId,actorUserId,captureId,async (_tx,loaded) => loaded);
      if (first.candidate) return { ...await this.authenticate(first,keys), replayed: true };
      const original = validateStoredConfluenceLedgerCapture(first.capture);
      const sealed = await sealConfluenceCopyLedgerArchive(original.body,original.binding,keys);
      const committed = await this.transaction(organisationId,actorUserId,captureId,async (tx,latest) => {
        if (JSON.stringify(latest.capture) !== JSON.stringify(first.capture)) throw new Error();
        if (latest.candidate) return { ...latest, replayed: true };
        const candidate = await tx.confluenceCopyLedgerCandidate.create({ data: { organisationId, captureId, actorUserId,
          envelope: sealed.envelope, envelopeDigest: sealed.digest } });
        return { capture: latest.capture, candidate, replayed: false };
      });
      // Never return an uncommitted or losing candidate after a concurrent prepare.
      return { ...await this.authenticate(committed,keys), replayed: committed.replayed };
    } catch { throw new Error('Original encrypted Confluence ledger candidate is unresolved; retry the original capture'); }
  }

  private async transaction<T>(
    organisationId: string, actorUserId: string, captureId: string,
    change: (tx: Prisma.TransactionClient, latest: Awaited<ReturnType<ConfluenceCopyLedgerCandidateStore['load']>>) => Promise<T>,
  ) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
      const loaded = await this.load(tx,organisationId,actorUserId,captureId);
      return change(tx,loaded);
    },{ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 });
  }

  private async load(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string, captureId: string) {
    await lockOrganisationForUpdate(tx,organisationId);
    await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
    const owner = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const charity = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    if (!owner || !charity) throw new Error();
    const capture = await tx.confluenceCopyLedgerCapture.findFirst({ where: { id: captureId, organisationId } });
    if (!capture || capture.id !== captureId || capture.actorUserId !== actorUserId || capture.organisationId !== organisationId) throw new Error();
    validateStoredConfluenceLedgerCapture(capture);
    const candidate = await tx.confluenceCopyLedgerCandidate.findUnique({ where: { captureId } });
    return { capture, candidate };
  }

  private async authenticate(value: Awaited<ReturnType<ConfluenceCopyLedgerCandidateStore['load']>>, keys: Pick<RecoveryDataKeys,'unwrap'>) {
    if (!value.candidate) throw new Error();
    return validateStoredConfluenceLedgerCandidate(value.capture,value.candidate,keys);
  }
}

export async function validateStoredConfluenceLedgerCandidate(capture: ConfluenceCopyLedgerCapture,
  candidate: ConfluenceCopyLedgerCandidate, keys: Pick<RecoveryDataKeys,'unwrap'>) {
    const original = validateStoredConfluenceLedgerCapture(capture);
    if (candidate.captureId !== capture.id || candidate.organisationId !== capture.organisationId
      || candidate.actorUserId !== capture.actorUserId || candidate.recordedAt < capture.recordedAt
      || typeof candidate.envelope !== 'string' || Buffer.byteLength(candidate.envelope,'utf8') > CONFLUENCE_COPY_LEDGER_MAX_ENVELOPE_BYTES
      || createHash('sha256').update(candidate.envelope).digest('hex') !== candidate.envelopeDigest) throw new Error();
    if ((await openConfluenceCopyLedgerArchive(candidate.envelope,original.binding,keys)).body !== original.body) throw new Error();
    return { id: candidate.id, original, candidate: { envelope: candidate.envelope, digest: candidate.envelopeDigest },
      durableCandidateRecorded: true as const, independentlyPreserved: false as const,
      actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
}
