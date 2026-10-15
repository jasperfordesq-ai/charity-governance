import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceCopyLedgerCaptureStore } from '../services/confluence-copy-ledger-capture-store.js';
import { CONFLUENCE_COPY_LEDGER_TABLES } from '../services/confluence-copy-ledger-snapshot.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';

function fixture() {
  const input = { installationId: context.installationId, operationId: 'ledger-original', writerEpoch: 1,
    sourceRevision: context.sourceRevision, keyId: context.keyId, observedControl: { format: 2,
      installationId: context.installationId, organisationId: 'org-a', writerId: 'writer-a', writerEpoch: 1,
      generation: 0, digest: null, activeOperation: null, revision: 'observed-head-original' } };
  const state = { owner: true, active: true, reads: 0, loseAck: false, now: new Date('2026-10-15T22:00:00.000Z'),
    saved: null as null | Record<string,unknown> };
  const tx: Record<string,unknown> = {
    $executeRaw: async (sql: TemplateStringsArray) => { assert.equal(sql.join(''),'SET LOCAL synchronous_commit = on'); return 0; },
    $queryRaw: async (sql: TemplateStringsArray | { sql: string }) => !Array.isArray(sql)
      ? CONFLUENCE_COPY_LEDGER_TABLES.map(name => ({ name, count: 0n, bytes: 0n })) : [{ now: state.now }],
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => state.active ? { id: 'org-a' } : null },
    confluenceCopyLedgerCapture: {
      findUnique: async () => structuredClone(state.saved),
      create: async ({ data }: { data: Record<string,unknown> }) => {
        assert.equal(state.saved,null); state.saved = { id: 'durable-capture-a', ...data, recordedAt: state.now };
        return structuredClone(state.saved);
      },
    },
  };
  for (const delegate of ['confluenceRetainedCopyReview','confluenceRetainedCopyReviewWithdrawal','confluenceSyntheticCopyScope',
    'confluenceRetainedCopyPermission','confluenceRetainedCopyPermissionWithdrawal','confluenceCopyRecoveryCapture',
    'confluenceCopyPublicationPlan','confluenceCopyPublicationReceipt']) tx[delegate] = { findMany: async () => { state.reads++; return []; } };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>, options: unknown) => {
    assert.deepEqual(options,{ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 });
    const result = await fn(tx);
    if (state.loseAck) { state.loseAck = false; throw new Error('Synthetic committed database response lost'); }
    return result;
  } };
  return { state, input, service: () => new ConfluenceCopyLedgerCaptureStore(prisma as never) };
}

test('durable original snapshot and binding are recorded before any preservation I/O', async () => {
  const h = fixture(), result = await h.service().prepare('org-a','owner-a',h.input);
  assert.equal(result.durableCaptureRecorded,true); assert.equal(result.independentlyPreserved,false);
  assert.equal(result.actionAuthorized,false); assert.equal(result.reopeningAuthorised,false);
  assert.equal(h.state.reads,8); assert.equal(JSON.parse(result.body).actorUserId,'owner-a');
  assert.equal(result.binding.observedControl.revision,'observed-head-original');
});

test('fresh service instance and lost local commit acknowledgement return original bytes without recapture', async () => {
  const h = fixture(); h.state.loseAck = true;
  await assert.rejects(h.service().prepare('org-a','owner-a',h.input),/unresolved/);
  const original = h.state.saved!.facts; h.state.now = new Date('2026-10-16T22:00:00.000Z');
  const resumed = await h.service().prepare('org-a','owner-a',h.input);
  assert.equal(resumed.body,original); assert.equal(resumed.replayed,true); assert.equal(h.state.reads,8);
});

test('same operation refuses changed key, source, epoch, original observation or actor', async () => {
  const h = fixture(); await h.service().prepare('org-a','owner-a',h.input);
  for (const change of [{ sourceRevision: 'b'.repeat(40) },{ writerEpoch: 2 },
    { keyId: context.keyId.replace('111111111111','222222222222') },
    { observedControl: { ...h.input.observedControl, revision: 'different-observation' } }]) {
    await assert.rejects(h.service().prepare('org-a','owner-a',{ ...h.input, ...change }));
  }
  await assert.rejects(h.service().prepare('org-a','other-owner',h.input));
  assert.equal(h.state.reads,8);
});

test('inactive charity, revoked Owner, occupied observation and caller-supplied body refuse', async () => {
  const h = fixture(); h.state.owner = false; await assert.rejects(h.service().prepare('org-a','member-a',h.input));
  h.state.owner = true; h.state.active = false; await assert.rejects(h.service().prepare('org-a','owner-a',h.input));
  h.state.active = true;
  await assert.rejects(h.service().prepare('org-a','owner-a',{ ...h.input, facts: 'PRIVATE-OVERRIDE' }));
  await assert.rejects(h.service().prepare('org-a','owner-a',{ ...h.input, observedControl: { ...h.input.observedControl,
    activeOperation: { operationId: 'occupied', preparationDigest: 'a'.repeat(64) } } }));
  assert.equal(h.state.saved,null); assert.equal(h.state.reads,0);
});

test('corrupted persisted hash/body/identity never becomes a new capture or a successful retry', async () => {
  for (const key of ['facts','factsDigest','actorUserId','operationId']) {
    const h = fixture(); await h.service().prepare('org-a','owner-a',h.input);
    h.state.saved![key] = 'PRIVATE-CORRUPTED-VALUE';
    await assert.rejects(h.service().prepare('org-a','owner-a',h.input),error => error instanceof Error
      && !error.message.includes('PRIVATE-') && error.cause === undefined);
    assert.equal(h.state.reads,8);
  }
});
