import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { lockOrganisationForUpdate } from './organisation-lock.js';

// Complete local history, including unpublished decisions and publication
// bookkeeping that cannot be reconstructed from decision-state envelopes.
export const CONFLUENCE_COPY_LEDGER_TABLES = Object.freeze([
  'ConfluenceRetainedCopyReview', 'ConfluenceRetainedCopyReviewWithdrawal',
  'ConfluenceSyntheticCopyScope', 'ConfluenceRetainedCopyPermission',
  'ConfluenceRetainedCopyPermissionWithdrawal', 'ConfluenceCopyRecoveryCapture',
  'ConfluenceCopyPublicationPlan', 'ConfluenceCopyPublicationReceipt',
] as const);
const binding = z.object({ installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  declaredSourceRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export const CONFLUENCE_COPY_LEDGER_MAX_BYTES = 128 * 1024 * 1024;
const MAX_BYTES = CONFLUENCE_COPY_LEDGER_MAX_BYTES;
const MAX_ROWS = 10000;
const row = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  organisationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/) }).passthrough();
const ledgerSchema = z.object({ format: z.literal(1), kind: z.literal('CONFLUENCE_COPY_LOCAL_LEDGER_V1'),
  ...binding.shape, organisationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  actorUserId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), capturedAt: z.string().datetime({ precision: 3 }),
  tables: z.record(z.array(row).max(MAX_ROWS)),
}).strict();

function canonical(value: unknown): string {
  const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v)
      .sort(([a],[b]) => a < b ? -1 : a === b ? 0 : 1).map(([key,item]) => [key,order(item)])) : v;
  return JSON.stringify(order(value));
}

/** Structural complete-ledger validation only, not semantic decision approval,
 * an authenticated provider head, source attestation or restore authority. */
export function prepareConfluenceCopyLocalLedger(raw: unknown) {
  try {
    const wire = JSON.stringify(raw);
    if (Buffer.byteLength(wire,'utf8') > MAX_BYTES) throw new Error();
    const ledger = ledgerSchema.parse(JSON.parse(wire));
    if (Object.keys(ledger.tables).length !== CONFLUENCE_COPY_LEDGER_TABLES.length
      || CONFLUENCE_COPY_LEDGER_TABLES.some(name => !Object.hasOwn(ledger.tables,name))) throw new Error();
    for (const group of Object.values(ledger.tables)) {
      if (new Set(group.map(value => value.id)).size !== group.length
        || group.some(value => value.organisationId !== ledger.organisationId)) throw new Error();
    }
    const body = canonical(ledger);
    if (Buffer.byteLength(body,'utf8') > MAX_BYTES) throw new Error();
    return { body, digest: createHash('sha256').update(body,'utf8').digest('hex'), ledger };
  } catch { throw new Error('Invalid or over-capacity complete Confluence local ledger'); }
}

/** Internal confidential snapshot only. No provider write, persistence, journal
 * publication, authenticated freshness, restore or execution follows. Caller
 * declares installation/source; a supported host coordinator must attest them.
 * Do not log the returned body or treat its unkeyed digest as authentication.
 */
export async function captureConfluenceCopyLocalLedger(prisma: PrismaClient, organisationId: string,
  actorUserId: string, raw: unknown) {
  try {
    const input = binding.parse(raw);
    return await prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx,organisationId);
      await tx.$queryRaw`SELECT id FROM public."User" WHERE id=${actorUserId}
        AND "organisationId"=${organisationId} FOR SHARE`;
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId,
        role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      const charity = await tx.organisation.findFirst({ where: { id: organisationId,
        lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      if (!actor || !charity) throw new Error();

      // Fixed identifiers only; all row selection values remain parameters.
      // Preflight before transferring potentially large review/capture bodies.
      const sizes = await tx.$queryRaw<Array<{ name: string; count: bigint; bytes: bigint }>>(Prisma.join(
        CONFLUENCE_COPY_LEDGER_TABLES.map(name => Prisma.sql`SELECT ${name}::text AS name,
          count(*) AS count, coalesce(sum(octet_length(to_jsonb(t)::text)),0)::bigint AS bytes
          FROM ${Prisma.raw(`public."${name}"`)} t WHERE "organisationId"=${organisationId}`), ' UNION ALL '));
      if (sizes.length !== CONFLUENCE_COPY_LEDGER_TABLES.length
        || new Set(sizes.map(row => row.name)).size !== sizes.length
        || sizes.some(row => !CONFLUENCE_COPY_LEDGER_TABLES.some(name => name === row.name)
          || row.count < 0n || row.count > BigInt(MAX_ROWS) || row.bytes < 0n)
        || sizes.reduce((sum,row) => sum + row.bytes,0n) > 120n * 1024n * 1024n) throw new Error();

      const query = { where: { organisationId }, orderBy: { id: 'asc' as const }, take: MAX_ROWS + 1 };
      const rows = await Promise.all([
        tx.confluenceRetainedCopyReview.findMany(query), tx.confluenceRetainedCopyReviewWithdrawal.findMany(query),
        tx.confluenceSyntheticCopyScope.findMany(query), tx.confluenceRetainedCopyPermission.findMany(query),
        tx.confluenceRetainedCopyPermissionWithdrawal.findMany(query), tx.confluenceCopyRecoveryCapture.findMany(query),
        tx.confluenceCopyPublicationPlan.findMany(query), tx.confluenceCopyPublicationReceipt.findMany(query),
      ]);
      for (const [index,group] of rows.entries()) {
        const size = sizes.find(row => row.name === CONFLUENCE_COPY_LEDGER_TABLES[index]);
        if (!size || group.length > MAX_ROWS || BigInt(group.length) !== size.count
          || new Set(group.map(row => row.id)).size !== group.length
          || group.some(row => row.organisationId !== organisationId)) throw new Error();
      }
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT timezone('UTC',clock_timestamp())::timestamp(3) AS now`;
      if (!clock || !Number.isFinite(clock.now.getTime())) throw new Error();
      const wire = JSON.stringify({ format: 1, kind: 'CONFLUENCE_COPY_LOCAL_LEDGER_V1', ...input,
        organisationId, actorUserId, capturedAt: clock.now.toISOString(),
        tables: Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map((name,index) => [name,rows[index]])) });
      if (Buffer.byteLength(wire,'utf8') > MAX_BYTES) throw new Error();
      // Prisma dates serialize first, then keys are ordered without dropping
      // scalar metadata or changing the original canonical facts string.
      const { body, digest } = prepareConfluenceCopyLocalLedger(JSON.parse(wire));
      return { body, digest,
        scope: 'CONFLUENCE_LOCAL_LEDGER_ONLY' as const,
        tableCounts: Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map((name,index) => [name,rows[index]!.length])),
        independentlyPreserved: false as const, currentHistoryVerified: false as const,
        actionAuthorized: false as const, reopeningAuthorised: false as const };
    }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 });
  } catch {
    // SQL errors can contain whole governance rows; expose no raw cause.
    throw new Error('Confluence local ledger capture is unresolved; preserve existing evidence and retry');
  }
}
