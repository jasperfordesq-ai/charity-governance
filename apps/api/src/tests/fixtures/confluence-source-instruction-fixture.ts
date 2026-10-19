import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { confluenceCitationTargetDigest } from '../../services/confluence-citation-observation.js';
import { issueConfluenceSourceInstruction, withdrawConfluenceSourceInstruction } from '../../services/confluence-source-instruction.js';
const requestId = '00000000-0000-4000-8000-000000000321';
export function fixture(documentId: string | null = null) {
  let citation: Record<string, unknown> | null = { id: 'ref-1', documentId, cloudId: 'site-1', pageId: 'page-1',
    pageVersion: 3, citedAt: new Date('2026-10-01'), updatedAt: new Date('2026-10-01') };
  let active = true, enforced = false, unknownCommit = false, beforeCommit: (() => void) | undefined;
  let statementClock: Date | null = null;
  type Row = { id: string; organisationId: string; type: string; actorUserId: string; occurredAt: Date; context: Record<string, unknown> };
  const rows: Row[] = [];
  type Where = { organisationId?: string; type?: string; id?: string | { lt: string }; occurredAt?: Date | { lt: Date };
    context?: { path: string[]; equals: string }; OR?: Where[] };
  const matches = (row: Row, where: Where): boolean =>
    (!where.organisationId || row.organisationId === where.organisationId)
    && (!where.type || row.type === where.type)
    && (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id < where.id.lt))
    && (!where.context || row.context[where.context.path[0]!] === where.context.equals)
    && (!where.occurredAt || (where.occurredAt instanceof Date
      ? +row.occurredAt === +where.occurredAt : +row.occurredAt < +where.occurredAt.lt))
    && (!where.OR || where.OR.some(part => matches(row, part)));
  const client = {
    user: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.deepEqual(where, { id: 'owner-1', organisationId: 'org-1', role: 'OWNER', lifecycleStatus: 'ACTIVE',
        organisation: { is: { lifecycleStatus: 'ACTIVE' } } });
      return active ? { id: 'owner-1', name: 'Synthetic Owner' } : null;
    } },
    documentRecoveryEnforcement: { findUnique: async () => enforced ? { id: 'freeze' } : null },
    confluenceReference: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.equal(where.id, 'ref-1'); assert.equal(where.organisationId, 'org-1'); return citation;
    } },
    securityAuditEvent: {
      findFirst: async ({ where }: { where: Where }) => {
        assert.equal(where.organisationId, 'org-1');
        return rows.find(r => matches(r, where)) ?? null;
      },
      findMany: async ({ where, take, orderBy }: { where: Where; take: number; orderBy: unknown }) => {
        assert.equal(where.organisationId, 'org-1');
        assert.deepEqual(orderBy, [{ occurredAt: 'desc' }, { id: 'desc' }]);
        return rows.filter(row => matches(row, where)).sort((a, b) =>
          +b.occurredAt - +a.occurredAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, take);
      },
      create: async ({ data }: { data: Omit<Row, 'id' | 'occurredAt'> & { occurredAt?: Date } }) => {
        const row = { ...data, id: `event-${rows.length + 1}`, occurredAt: data.occurredAt ?? new Date(), context: structuredClone(data.context) };
        rows.push(row); return row;
      },
    },
    $queryRaw: async (parts: TemplateStringsArray) => parts.join('').includes('statement_timestamp')
      ? [{ now: statementClock ?? new Date() }] : [],
  };
  let queue = Promise.resolve();
  const prisma = { ...client, $transaction: async (callback: (tx: typeof client) => Promise<unknown>) => {
    const previous = queue; let release!: () => void; queue = new Promise<void>(r => { release = r; }); await previous;
    try { beforeCommit?.(); const result = await callback(client);
      if (unknownCommit) { unknownCommit = false; throw new Error('Unknown commit'); } return result;
    } finally { release(); }
  } } as unknown as PrismaClient;
  const body = { clientRequestId: requestId, expectedTargetDigest: confluenceCitationTargetDigest(citation), action: 'TRASH',
    authorityEvidenceRef: 'SYNTHETIC-AUTHORITY', retentionEvidenceRef: 'SYNTHETIC-RETENTION', administratorRef: 'SYNTHETIC-ADMIN',
    followUpAt: '2998-01-01T00:00:00Z', evidenceRef: 'SYNTHETIC-DECISION', reason: 'Synthetic reviewed instruction for administrator follow-up', assessmentConfirmed: true };
  const issue = (change: Record<string, unknown> = {}) => issueConfluenceSourceInstruction(prisma,
    { organisationId: 'org-1', actorUserId: 'owner-1', referenceId: 'ref-1', body: { ...body, ...change } });
  const withdraw = (id: string, digest: string, change: Record<string, unknown> = {}) => withdrawConfluenceSourceInstruction(prisma,
    { organisationId: 'org-1', actorUserId: 'owner-1', instructionId: id,
      body: { clientRequestId: '00000000-0000-4000-8000-000000000322', expectedInstructionDigest: digest,
        evidenceRef: 'SYNTHETIC-WITHDRAWAL', reason: 'Synthetic authority withdrawn before administrator action', ...change } });
  return { prisma, rows, issue, withdraw, body, citation: () => citation, remove: () => { citation = null; },
    revoke: () => { active = false; }, enforce: () => { enforced = true; },
    unknown: () => { unknownCommit = true; }, beforeCommit: (fn: () => void) => { beforeCommit = fn; },
    statementClock: (clock: Date) => { statementClock = clock; } };
}
