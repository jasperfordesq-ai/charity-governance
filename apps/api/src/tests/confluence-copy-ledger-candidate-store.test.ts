import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ConfluenceCopyLedgerCandidateStore } from '../services/confluence-copy-ledger-candidate-store.js';
import { ledgerFixture } from './fixtures/confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { preservePreparedConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

function fixture() {
  const facts = ledgerFixture().body(), recordedAt = new Date('2026-10-15T22:00:01.000Z');
  const capture = { id: 'capture-a', organisationId: 'org-a', actorUserId: 'owner-a', operationId: context.operationId,
    context, facts, factsDigest: createHash('sha256').update(facts).digest('hex'), capturedAt: new Date('2026-10-15T22:00:00.000Z'), recordedAt,
    observedControl: { format: 2, installationId: context.installationId, organisationId: 'org-a', writerId: 'writer-a',
      writerEpoch: 1, generation: 2, digest: 'b'.repeat(64), activeOperation: null, revision: 'original-head' } };
  const state = { owner: true, active: true, generations: 0, loseCommit: false, writes: 0,
    candidate: null as null | Record<string,unknown>, onGenerate: async () => {} };
  const tx = {
    $executeRaw: async () => 0, $queryRaw: async () => [],
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => state.active ? { id: 'org-a' } : null },
    confluenceCopyLedgerCapture: { findFirst: async () => structuredClone(capture) },
    confluenceCopyLedgerCandidate: {
      findUnique: async () => structuredClone(state.candidate),
      create: async ({ data }: { data: Record<string,unknown> }) => {
        assert.equal(state.candidate,null); state.writes++;
        state.candidate = { id: 'candidate-a', ...data, recordedAt: new Date('2026-10-15T22:00:02.000Z') };
        return structuredClone(state.candidate);
      },
    },
  };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>, options: unknown) => {
    assert.deepEqual(options,{ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 });
    const result = await fn(tx);
    if (state.loseCommit && state.candidate) { state.loseCommit = false; throw new Error('PRIVATE-COMMIT-LOST'); }
    return result;
  } };
  const keys: RecoveryDataKeys = { generate: async () => { state.generations++; await state.onGenerate();
    return { key: Buffer.alloc(32,7), keyId: context.keyId, wrappedKey: 'dGVzdA==' }; },
    unwrap: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId }) };
  return { state, capture, keys, service: () => new ConfluenceCopyLedgerCandidateStore(prisma as never) };
}

test('candidate is committed before it is returned and a new store returns exact original encryption', async () => {
  const h = fixture(), first = await h.service().prepare('org-a','owner-a','capture-a',h.keys);
  assert.equal(first.durableCandidateRecorded,true); assert.equal(first.independentlyPreserved,false);
  assert.equal(first.actionAuthorized,false); assert.equal(first.currentHistoryVerified,false); assert.equal(first.reopeningAuthorised,false);
  assert.equal(h.state.candidate!.envelope,first.candidate.envelope);
  const second = await h.service().prepare('org-a','owner-a','capture-a',h.keys);
  assert.equal(second.replayed,true); assert.deepEqual(second.candidate,first.candidate);
  assert.equal(h.state.generations,1); assert.equal(h.state.writes,1);
});

test('lost local commit response retries saved bytes without generating a new key', async () => {
  const h = fixture(); h.state.loseCommit = true;
  await assert.rejects(h.service().prepare('org-a','owner-a','capture-a',h.keys),/unresolved/);
  const saved = h.state.candidate!.envelope;
  const retry = await h.service().prepare('org-a','owner-a','capture-a',h.keys);
  assert.equal(retry.candidate.envelope,saved); assert.equal(h.state.generations,1);
});

test('Owner revoked during key generation refuses persistence and exposes no prepared candidate', async () => {
  const h = fixture(); h.state.onGenerate = async () => { h.state.owner = false; };
  await assert.rejects(h.service().prepare('org-a','owner-a','capture-a',h.keys));
  assert.equal(h.state.candidate,null); assert.equal(h.state.writes,0);
});

test('foreign actor/tenant, inactive charity and corrupted original refuse before generation', async () => {
  for (const mutate of [(h: ReturnType<typeof fixture>) => { h.state.active = false; },
    (h: ReturnType<typeof fixture>) => { h.capture.actorUserId = 'other'; },
    (h: ReturnType<typeof fixture>) => { h.capture.organisationId = 'other'; },
    (h: ReturnType<typeof fixture>) => { h.capture.factsDigest = '0'.repeat(64); }]) {
    const h = fixture(); mutate(h); await assert.rejects(h.service().prepare('org-a','owner-a','capture-a',h.keys));
    assert.equal(h.state.generations,0); assert.equal(h.state.writes,0);
  }
});

test('corrupt saved ciphertext/hash/binding cannot be resealed as a recovery shortcut', async () => {
  for (const key of ['envelope','envelopeDigest','actorUserId','captureId','organisationId']) {
    const h = fixture(); await h.service().prepare('org-a','owner-a','capture-a',h.keys);
    h.state.candidate![key] = 'PRIVATE-CORRUPT';
    await assert.rejects(h.service().prepare('org-a','owner-a','capture-a',h.keys),error =>
      error instanceof Error && !error.message.includes('PRIVATE-') && error.cause === undefined);
    assert.equal(h.state.generations,1); assert.equal(h.state.writes,1);
  }
});

test('saved candidate composes with exact-byte external retry after losing the upload response', async () => {
  const h = fixture(), saved = await h.service().prepare('org-a','owner-a','capture-a',h.keys);
  let stored: string | null = null, writes = 0;
  const objects = { readConfluenceCopyLedger: async () => stored,
    createConfluenceCopyLedger: async (_id: string,bytes: string) => { stored = bytes; writes++; throw new Error('PRIVATE-UPLOAD-LOST'); } };
  await assert.rejects(preservePreparedConfluenceCopyLedgerArchive(saved.original,saved.candidate,h.keys,objects));
  const restarted = await h.service().prepare('org-a','owner-a','capture-a',h.keys);
  const result = await preservePreparedConfluenceCopyLedgerArchive(restarted.original,restarted.candidate,h.keys,objects);
  assert.equal(result.digest,saved.candidate.digest); assert.equal(writes,1); assert.equal(h.state.generations,1);
});

test('a concurrent committed candidate wins over the newly generated unpublished encryption', async () => {
  const h = fixture(), concurrent = fixture();
  const winner = await concurrent.service().prepare('org-a','owner-a','capture-a',concurrent.keys);
  h.state.onGenerate = async () => { h.state.candidate = structuredClone(concurrent.state.candidate); };
  const result = await h.service().prepare('org-a','owner-a','capture-a',h.keys);
  assert.deepEqual(result.candidate,winner.candidate); assert.equal(result.replayed,true);
  assert.equal(h.state.writes,0); assert.equal(h.state.generations,1);
});
