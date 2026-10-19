import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { listConfluenceSourceFollowups, recordConfluenceSourceFollowup, readConfluenceSourceFollowup } from '../services/confluence-source-followup.js';
import { fixture as instructionFixture } from './fixtures/confluence-source-instruction-fixture.js';

async function fixture(documentId: string | null = null) {
  const f = instructionFixture(documentId), issued = await f.issue();
  f.rows[0]!.occurredAt = new Date('2026-10-01T09:00:00Z');
  let reads = 0;
  const connection = { cloudId: 'site-1', generation: 'synthetic-original', client: {} as ConfluenceClient };
  const deps = { getConnection: async () => connection as typeof connection | null,
    getPage: async (_client: ConfluenceClient, id: string): Promise<ConfluencePage | null> => {
      reads++; return id === 'control-1' ? { id, status: 'current' } as ConfluencePage : null;
    }, isPageInTrash: async () => true };
  const body = { clientRequestId: '00000000-0000-4000-8000-000000000411',
    expectedInstructionDigest: issued.instruction.inputDigest, expectedTargetDigest: f.body.expectedTargetDigest,
    controlPageId: 'control-1', actionReport: 'TRASH_REPORTED', actionEvidenceRef: 'SYNTHETIC-ACTION',
    actionReportedAt: '2026-10-02T10:00:00Z', evidenceReviewed: true,
    evidenceRef: 'SYNTHETIC-FOLLOWUP', reason: 'Synthetic administrator action report and separate provider observation' };
  const record = (change: Record<string, unknown> = {}) => recordConfluenceSourceFollowup(f.prisma,
    { organisationId: 'org-1', actorUserId: 'owner-1', instructionId: issued.instruction.id, body: { ...body, ...change } }, deps);
  return { ...f, issued, deps, body, record, reads: () => reads };
}

test('follow-up history binds the original instruction, pages ties and refuses unrelated cursors', async () => {
  const f = await fixture(); f.statementClock(new Date('2026-10-03T09:00:00Z'));
  for (let i = 1; i <= 28; i++) await f.record({ clientRequestId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
  const row = f.rows[1]!;
  f.rows.push({ ...row, id: 'foreign-report', organisationId: 'org-other' });
  f.rows.push({ ...row, id: 'other-instruction', context: { ...row.context, instructionId: 'not-this-instruction' } });
  f.remove(); const reads = f.reads();
  const first = await listConfluenceSourceFollowups(f.prisma, 'org-1', 'owner-1', f.issued.instruction.input.clientRequestId);
  assert.equal(first.items.length, 25); assert.ok(first.nextCursor);
  const last = await listConfluenceSourceFollowups(f.prisma, 'org-1', 'owner-1', f.issued.instruction.id, first.nextCursor);
  assert.equal(last.items.length, 3); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.items, ...last.items].map(item => item.id)).size, 28);
  assert.equal(f.reads(), reads);
  for (const before of ['foreign-report', 'other-instruction', f.issued.instruction.id]) await assert.rejects(
    listConfluenceSourceFollowups(f.prisma, 'org-1', 'owner-1', f.issued.instruction.id, before),
    { code: 'CONFLUENCE_SOURCE_FOLLOWUP_CONFLICT' });
});
test('follow-up links an actual instruction for both anchors while keeping action claims and observation distinct', async () => {
  for (const documentId of [null, 'doc-1']) {
    const f = await fixture(documentId), report = await f.record();
    assert.equal(report.instructionId, f.issued.instruction.id); assert.equal(report.instruction.citation.documentId, documentId);
    assert.equal(report.input.actionReport, 'TRASH_REPORTED'); assert.equal(report.observation.status, 'TRASHED');
    assert.equal(report.withdrawal, null); assert.equal(report.actionAuthorized, false);
    assert.equal(report.observation.permanentErasureVerified, false); assert.equal(report.jobCreated, false);
    assert.equal(report.currentStateVerified, false); assert.equal(f.rows.length, 2);
  }
});
test('lost acknowledgement and concurrent retries preserve one original report without another provider read', async () => {
  const f = await fixture(); f.unknown(); await assert.rejects(f.record(), /Unknown commit/);
  const reads = f.reads(), recovered = await f.record(); assert.equal(f.reads(), reads); assert.equal(f.rows.length, 2);
  assert.deepEqual(await f.record(), recovered);
  const g = await fixture(), reports = await Promise.all([g.record(), g.record()]);
  assert.deepEqual(reports[0], reports[1]); assert.equal(g.rows.length, 2);
});
test('saved report survives unciting and a later withdrawal without rewriting its historical snapshot', async () => {
  const f = await fixture(), saved = await f.record();
  await f.withdraw(f.issued.instruction.id, f.issued.instruction.inputDigest); f.remove(); const reads = f.reads();
  assert.deepEqual(await f.record(), saved); assert.equal(f.reads(), reads);
  assert.deepEqual(await readConfluenceSourceFollowup(f.prisma, 'org-1', 'owner-1', saved.id), saved);
  assert.deepEqual(await readConfluenceSourceFollowup(f.prisma, 'org-1', 'owner-1', f.body.clientRequestId), saved);
  await assert.rejects(f.record({ reason: 'Changed report reuses an original request identity' }), { code: 'CONFLUENCE_SOURCE_FOLLOWUP_CONFLICT' });
});
test('withdrawal during observation is captured at report commit and never grants action authority', async () => {
  const f = await fixture(), originalRead = f.deps.getPage; let withdrawn = false;
  f.deps.getPage = async (client, id) => {
    if (id === 'page-1' && !withdrawn) { withdrawn = true; await f.withdraw(f.issued.instruction.id, f.issued.instruction.inputDigest); }
    return originalRead(client, id);
  };
  const report = await f.record(); assert.ok(report.withdrawal); assert.equal(report.actionAuthorized, false);
  assert.equal(report.withdrawal.instructionId, f.issued.instruction.id);
});
test('a post-lock database timestamp orders a report after a withdrawal committed during its wait', async () => {
  const f = await fixture();
  await f.withdraw(f.issued.instruction.id, f.issued.instruction.inputDigest);
  const withdrawalTime = new Date(Date.now() + 2000);
  f.rows[1]!.occurredAt = withdrawalTime;
  f.statementClock(new Date(withdrawalTime.getTime() + 1));
  const report = await f.record({ actionReport: 'NOT_REPORTED', actionEvidenceRef: null, actionReportedAt: null });
  assert.ok(report.withdrawal);
  assert.ok(Date.parse(report.recordedAt) >= Date.parse(report.withdrawal.recordedAt));
});
test('changed instructions, old/future action times and forged authority refuse before provider reads', async () => {
  for (const change of [{ expectedInstructionDigest: '0'.repeat(64) }, { expectedTargetDigest: '0'.repeat(64) },
    { actionReportedAt: '2026-09-01T00:00:00Z' }, { actionReportedAt: '2999-01-01T00:00:00Z' },
    { actionAuthorized: true }, { actionEvidenceRef: null }, { evidenceReviewed: false }]) {
    const f = await fixture(); await assert.rejects(f.record(change)); assert.equal(f.reads(), 0); assert.equal(f.rows.length, 1);
  }
});
test('role loss, recovery binding and local removal before commit refuse the new report', async () => {
  for (const mode of ['role', 'recovery', 'removed']) {
    const f = await fixture(); f.beforeCommit(() => mode === 'role' ? f.revoke() : mode === 'recovery' ? f.enforce() : f.remove());
    await assert.rejects(f.record()); assert.equal(f.rows.length, 1);
  }
});
test('provider unavailable is unknown; a saved original or observation cannot be rebound', async () => {
  const f = await fixture(); f.deps.getConnection = async () => null; const report = await f.record();
  assert.equal(report.observation.status, 'UNKNOWN'); assert.equal(report.observation.allCopiesVerified, false);
  const row = f.rows.find(r => r.id === report.id)!;
  (row.context.instruction as { inputDigest: string }).inputDigest = '0'.repeat(64);
  await assert.rejects(readConfluenceSourceFollowup(f.prisma, 'org-1', 'owner-1', report.id));
});
