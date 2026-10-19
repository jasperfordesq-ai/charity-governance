import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { confluenceCitationTargetDigest } from '../services/confluence-citation-observation.js';
import { issueConfluenceSourceInstruction, readConfluenceSourceInstruction, withdrawConfluenceSourceInstruction } from '../services/confluence-source-instruction.js';

const requestId = '00000000-0000-4000-8000-000000000321';
function fixture(documentId: string | null = null) {
  let citation: Record<string, unknown> | null = { id: 'ref-1', documentId, cloudId: 'site-1', pageId: 'page-1',
    pageVersion: 3, citedAt: new Date('2026-10-01'), updatedAt: new Date('2026-10-01') };
  let active = true, enforced = false, unknownCommit = false, beforeCommit: (() => void) | undefined;
  type Row = { id: string; organisationId: string; type: string; actorUserId: string; occurredAt: Date; context: Record<string, unknown> };
  const rows: Row[] = [];
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
      findFirst: async ({ where }: { where: { organisationId: string; type: string; id?: string; context?: { path: string[]; equals: string } } }) => {
        assert.equal(where.organisationId, 'org-1');
        return rows.find(r => r.type === where.type && (where.id ? r.id === where.id :
          r.context[where.context!.path[0]!] === where.context!.equals)) ?? null;
      },
      create: async ({ data }: { data: Omit<Row, 'id' | 'occurredAt'> }) => {
        const row = { ...data, id: `event-${rows.length + 1}`, occurredAt: new Date(), context: structuredClone(data.context) };
        rows.push(row); return row;
      },
    },
    $queryRaw: async () => [],
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
    unknown: () => { unknownCommit = true; }, beforeCommit: (fn: () => void) => { beforeCommit = fn; } };
}

test('instruction binds both citation shapes and records an assessment, without provider execution authority', async () => {
  for (const documentId of [null, 'doc-1']) {
    const f = fixture(documentId), state = await f.issue();
    assert.equal(state.instruction.citation.documentId, documentId);
    assert.equal(state.instruction.input.authorityEvidenceRef, 'SYNTHETIC-AUTHORITY');
    assert.equal(state.instruction.authorityAssessment, 'OWNER_RECORDED');
    assert.equal(state.instruction.providerMutationIssued, false); assert.equal(state.instruction.actionAuthorized, false);
    assert.equal(state.instruction.jobCreated, false); assert.equal(state.withdrawal, null); assert.equal(f.rows.length, 1);
  }
});
test('lost acknowledgement and concurrent original retries preserve one instruction', async () => {
  const f = fixture(); f.unknown(); await assert.rejects(f.issue(), /Unknown commit/);
  const saved = await f.issue(); assert.equal(f.rows.length, 1);
  assert.deepEqual(await f.issue(), saved);
  const g = fixture(), states = await Promise.all([g.issue(), g.issue()]);
  assert.deepEqual(states[0], states[1]); assert.equal(g.rows.length, 1);
  await assert.rejects(f.issue({ action: 'PURGE' }), { code: 'CONFLUENCE_SOURCE_INSTRUCTION_CONFLICT' });
});
test('withdrawal is append-only; retries and historical reads never reactivate after unciting', async () => {
  const f = fixture(), issued = await f.issue(), snapshot = structuredClone(f.rows[0]);
  const state = await f.withdraw(issued.instruction.id, issued.instruction.inputDigest);
  assert.ok(state.withdrawal);
  assert.equal(state.withdrawal.instructionId, issued.instruction.id);
  assert.deepEqual(f.rows[0], snapshot); assert.equal(f.rows.length, 2);
  assert.deepEqual(await f.withdraw(issued.instruction.id, issued.instruction.inputDigest), state);
  f.remove(); assert.deepEqual(await f.issue(), state);
  assert.deepEqual(await readConfluenceSourceInstruction(f.prisma, 'org-1', 'owner-1', issued.instruction.id), state);
  await assert.rejects(f.withdraw(issued.instruction.id, issued.instruction.inputDigest, { reason: 'Changed withdrawal narrative with reused identity' }),
    { code: 'CONFLUENCE_SOURCE_INSTRUCTION_CONFLICT' });
  await assert.rejects(f.withdraw(issued.instruction.id, issued.instruction.inputDigest,
    { clientRequestId: '00000000-0000-4000-8000-000000000323' }), { code: 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN' });
});
test('role loss, missing anchor, stale digest and recovery freeze refuse before a decision commits', async () => {
  for (const mode of ['role', 'removed', 'freeze', 'digest']) {
    const f = fixture(); f.beforeCommit(() => { if (mode === 'role') f.revoke(); if (mode === 'removed') f.remove(); if (mode === 'freeze') f.enforce(); });
    await assert.rejects(f.issue(mode === 'digest' ? { expectedTargetDigest: '0'.repeat(64) } : {}));
    assert.equal(f.rows.length, 0);
  }
});
test('withdrawal refuses a foreign or changed instruction and enforces current Owner/recovery state', async () => {
  for (const mode of ['missing', 'digest', 'owner', 'freeze']) {
    const f = fixture(), state = await f.issue();
    if (mode === 'owner') f.revoke(); if (mode === 'freeze') f.enforce();
    await assert.rejects(f.withdraw(mode === 'missing' ? 'foreign-event' : state.instruction.id,
      mode === 'digest' ? '0'.repeat(64) : state.instruction.inputDigest)); assert.equal(f.rows.length, 1);
  }
});
test('forged authority/target, invalid evidence and elapsed follow-up are rejected', async () => {
  for (const change of [{ actionAuthorized: true }, { citation: {} }, { assessmentConfirmed: false },
    { authorityEvidenceRef: '' }, { administratorRef: 'person@example.invalid' }, { followUpAt: '2000-01-01T00:00:00Z' }]) {
    const f = fixture(); await assert.rejects(f.issue(change)); assert.equal(f.rows.length, 0);
  }
});
test('historical receipt corruption and current caller revocation fail closed', async () => {
  const f = fixture(), state = await f.issue();
  f.rows[0]!.context.inputDigest = '0'.repeat(64);
  await assert.rejects(readConfluenceSourceInstruction(f.prisma, 'org-1', 'owner-1', state.instruction.id));
  const g = fixture(), good = await g.issue(); g.revoke();
  await assert.rejects(readConfluenceSourceInstruction(g.prisma, 'org-1', 'owner-1', good.instruction.id));
});

test('lost and concurrent withdrawal acknowledgements preserve one immutable withdrawal', async () => {
  const f = fixture(), issued = await f.issue(); f.unknown();
  await assert.rejects(f.withdraw(issued.instruction.id, issued.instruction.inputDigest), /Unknown commit/);
  const recovered = await f.withdraw(issued.instruction.id, issued.instruction.inputDigest);
  assert.ok(recovered.withdrawal); assert.equal(f.rows.length, 2);
  const g = fixture(), original = await g.issue();
  const states = await Promise.all([g.withdraw(original.instruction.id, original.instruction.inputDigest),
    g.withdraw(original.instruction.id, original.instruction.inputDigest)]);
  assert.deepEqual(states[0], states[1]); assert.equal(g.rows.length, 2);
});
test('receipt parsing restores canonical JSON field order without weakening request binding', async () => {
  const f = fixture(), issued = await f.issue();
  for (const field of ['input', 'citation']) {
    f.rows[0]!.context[field] = Object.fromEntries(Object.entries(f.rows[0]!.context[field] as object).reverse());
  }
  assert.deepEqual(await f.issue(), issued);
  f.rows[0]!.actorUserId = 'another-owner';
  await assert.rejects(f.issue(), { code: 'CONFLUENCE_SOURCE_INSTRUCTION_CONFLICT' });
});
