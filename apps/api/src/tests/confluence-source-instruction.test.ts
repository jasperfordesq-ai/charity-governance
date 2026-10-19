import test from 'node:test';
import assert from 'node:assert/strict';
import { listConfluenceSourceInstructions, readConfluenceSourceInstruction } from '../services/confluence-source-instruction.js';
import { fixture } from './fixtures/confluence-source-instruction-fixture.js';

test('instruction history pages tied timestamps without duplicates and rejects foreign or mismatched cursors', async () => {
  const f = fixture(); f.statementClock(new Date('2026-10-01T09:00:00Z'));
  for (let i = 1; i <= 28; i++) await f.issue({ clientRequestId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
  const original = f.rows[0]!;
  f.rows.push({ ...original, id: 'foreign-event', organisationId: 'org-other' });
  f.rows.push({ ...original, id: 'other-reference', context: { ...original.context, referenceId: 'other-ref' } });
  f.remove();
  const first = await listConfluenceSourceInstructions(f.prisma, 'org-1', 'owner-1', { referenceId: 'ref-1' });
  assert.equal(first.items.length, 25); assert.ok(first.nextCursor);
  const last = await listConfluenceSourceInstructions(f.prisma, 'org-1', 'owner-1', { referenceId: 'ref-1', before: first.nextCursor });
  assert.equal(last.items.length, 3); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.items, ...last.items].map(item => item.instruction.id)).size, 28);
  for (const before of ['foreign-event', 'other-reference', 'missing']) await assert.rejects(
    listConfluenceSourceInstructions(f.prisma, 'org-1', 'owner-1', { referenceId: 'ref-1', before }),
    { code: 'CONFLUENCE_SOURCE_INSTRUCTION_CONFLICT' });
  f.revoke(); await assert.rejects(listConfluenceSourceInstructions(f.prisma, 'org-1', 'owner-1'), { statusCode: 403 });
});
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
  assert.deepEqual(await readConfluenceSourceInstruction(f.prisma, 'org-1', 'owner-1', f.body.clientRequestId), saved);
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
