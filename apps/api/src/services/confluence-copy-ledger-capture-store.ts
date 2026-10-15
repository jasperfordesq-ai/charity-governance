import type { Prisma, PrismaClient, ConfluenceCopyLedgerCapture } from '@prisma/client';
import { z } from 'zod';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { captureConfluenceCopyLocalLedgerInTransaction, prepareConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_MAX_BYTES } from './confluence-copy-ledger-snapshot.js';
import { validateConfluenceCopyLedgerRows } from './confluence-copy-ledger-validation.js';
import { validateRecoveryEnvelopeContext } from './recovery-preparation-envelope.js';
import { validateRecoveryControl } from './recovery-operation-reservation.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const inputSchema = z.object({ installationId: identity, operationId: identity,
  writerEpoch: z.number().int().min(1).max(2147483647), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  keyId: z.string(), observedControl: z.unknown().transform(validateRecoveryControl) }).strict();

/** Inactive durable original transport input only. It captures all eight source
 * tables and saves the original body/binding in ONE RepeatableRead transaction.
 * There is no key generation, object write, reservation, dispatcher or disposal.
 */
export class ConfluenceCopyLedgerCaptureStore {
  constructor(private readonly prisma: PrismaClient) {}

  async prepare(organisationId: string, actorUserId: string, raw: unknown) {
    try {
      const input = inputSchema.parse(raw);
      const context = validateRecoveryEnvelopeContext({ installationId: input.installationId, organisationId,
        operationId: input.operationId, writerEpoch: input.writerEpoch, sourceRevision: input.sourceRevision, keyId: input.keyId });
      const observedControl = input.observedControl;
      if (observedControl.installationId !== context.installationId || observedControl.organisationId !== organisationId
        || observedControl.writerEpoch !== context.writerEpoch || observedControl.activeOperation !== null
        || observedControl.generation >= 10000) throw new Error();
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
        await lockOrganisationForUpdate(tx,organisationId);
        await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
        const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
        const charity = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
        if (!actor || !charity) throw new Error();
        const existing = await tx.confluenceCopyLedgerCapture.findUnique({
          where: { organisationId_operationId: { organisationId, operationId: input.operationId } } });
        if (existing) {
          const saved = validateStoredConfluenceLedgerCapture(existing);
          if (existing.actorUserId !== actorUserId || JSON.stringify(saved.binding.context) !== JSON.stringify(context)
            || JSON.stringify(saved.binding.observedControl) !== JSON.stringify(observedControl)) throw new Error();
          return { ...saved, replayed: true };
        }
        const snapshot = await captureConfluenceCopyLocalLedgerInTransaction(tx,organisationId,actorUserId,{
          installationId: context.installationId, declaredSourceRevision: context.sourceRevision });
        const checked = validateConfluenceCopyLedgerRows(snapshot.body,context);
        const row = await tx.confluenceCopyLedgerCapture.create({ data: { organisationId,
          operationId: context.operationId, actorUserId, context: context as Prisma.InputJsonValue,
          observedControl: observedControl as Prisma.InputJsonValue, facts: snapshot.body, factsDigest: snapshot.digest,
          capturedAt: new Date(checked.ledger.capturedAt) } });
        return { ...validateStoredConfluenceLedgerCapture(row), replayed: false };
      }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 });
    } catch { throw new Error('Original Confluence ledger capture is unresolved; retry the original operation identity'); }
  }
}

export function validateStoredConfluenceLedgerCapture(row: ConfluenceCopyLedgerCapture) {
  try {
    if (typeof row.facts !== 'string' || Buffer.byteLength(row.facts,'utf8') > CONFLUENCE_COPY_LEDGER_MAX_BYTES) throw new Error();
    const context = validateRecoveryEnvelopeContext(row.context), observedControl = validateRecoveryControl(row.observedControl);
    const prepared = prepareConfluenceCopyLocalLedger(JSON.parse(row.facts));
    const checked = validateConfluenceCopyLedgerRows(row.facts,context);
    if (prepared.body !== row.facts || prepared.digest !== row.factsDigest || context.operationId !== row.operationId
      || context.organisationId !== row.organisationId || checked.ledger.actorUserId !== row.actorUserId
      || checked.ledger.capturedAt !== row.capturedAt.toISOString() || row.recordedAt < row.capturedAt
      || observedControl.installationId !== context.installationId || observedControl.organisationId !== row.organisationId
      || observedControl.writerEpoch !== context.writerEpoch || observedControl.activeOperation !== null
      || observedControl.generation >= 10000) throw new Error();
    return { id: row.id, body: row.facts, digest: row.factsDigest, binding: { context, observedControl },
      durableCaptureRecorded: true as const, independentlyPreserved: false as const,
      actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
  } catch { throw new Error('Invalid original Confluence ledger capture'); }
}
