import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecoveryAuthorityJournal, type AuthorityObjectStore } from '../services/recovery-authority-journal.js';

const binding = { installationId: 'install-a', organisationId: 'charity-a' };
const initializationCheckpoint = { ...binding, generation: 0, digest: null };

function fixture() {
  const rows = new Map<string, string>();
  let loseAcknowledgement = false;
  const store: AuthorityObjectStore = {
    async read(key) { return rows.get(key) ?? null; },
    async create(key, body) {
      if (rows.has(key)) return false;
      rows.set(key, body);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('network timeout'); }
      return true;
    },
  };
  return { rows, store, loseNextAck() { loseAcknowledgement = true; },
    journal: new RecoveryAuthorityJournal(store, binding, initializationCheckpoint) };
}
const intent = { operationId: 'operation-a', kind: 'DISPOSAL_INTENT' as const,
  factsDigest: 'a'.repeat(64), expectedGeneration: 0, expectedDigest: null };

test('journal records an ordered intent without issuing disposal or reopening permission', async () => {
  const { journal } = fixture();
  const receipt = await journal.append(intent);
  assert.equal(receipt.generation, 1);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.actionAuthorized, false);
  assert.equal((await journal.inspect()).generation, 1);
});

test('lost acknowledgement is safely retried by exact operation identity, even after later entries', async () => {
  const f = fixture(); f.loseNextAck();
  await assert.rejects(() => f.journal.append(intent), /outcome is unknown/);
  const head = await f.journal.inspect();
  await f.journal.append({ ...intent, operationId: 'hold-a', kind: 'PRESERVATION_CHANGE',
    expectedGeneration: head.generation, expectedDigest: head.digest });
  const replay = await f.journal.append(intent);
  assert.equal(replay.generation, 1); assert.equal(replay.replayed, true);
  assert.equal(f.rows.size, 2);
  await assert.rejects(() => f.journal.append({ ...intent, factsDigest: 'b'.repeat(64) }), /operation identity/);
});

test('concurrent operations at the same predecessor cannot both append', async () => {
  const { journal, rows } = fixture();
  const results = await Promise.allSettled([journal.append(intent), journal.append({ ...intent, operationId: 'other' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(rows.size, 1);
});

test('stale predecessors, tampered data and foreign bindings fail closed', async () => {
  const f = fixture(); await f.journal.append(intent);
  await assert.rejects(() => f.journal.append({ ...intent, operationId: 'new-op' }), /generation changed/);
  const [key, body] = [...f.rows.entries()][0]!;
  for (const change of [{ factsDigest: 'b'.repeat(64) }, { organisationId: 'charity-b' }, { extra: true }]) {
    f.rows.set(key, JSON.stringify({ ...JSON.parse(body), ...change }));
    await assert.rejects(() => f.journal.inspect(), /Invalid recovery authority/);
  }
});

test('unavailable authority and invalid caller facts never become an empty successful journal', async () => {
  const f = fixture();
  f.store.read = async () => { throw new Error('offline'); };
  await assert.rejects(() => f.journal.inspect(), /unavailable/);
  await assert.rejects(() => f.journal.append({ ...intent, factsDigest: 'not-a-digest' }));
  assert.equal(f.rows.size, 0);
});

test('an acknowledged write that is not readable is an unknown outcome, not success', async () => {
  const store: AuthorityObjectStore = { read: async () => null, create: async () => true };
  const journal = new RecoveryAuthorityJournal(store, binding, initializationCheckpoint);
  await assert.rejects(() => journal.append(intent), /outcome is unknown/);
});

test('a separately retained checkpoint rejects lost tail and missing history after restart', async () => {
  const f = fixture();
  const first = await f.journal.append(intent);
  const second = await f.journal.append({ ...intent, operationId: 'hold-after-backup',
    kind: 'PRESERVATION_CHANGE', expectedGeneration: first.generation, expectedDigest: first.digest });
  const checkpoint = { installationId: 'install-a', organisationId: 'charity-a',
    generation: second.generation, digest: second.digest };
  const recovered = new RecoveryAuthorityJournal(f.store, binding, checkpoint);
  assert.equal((await recovered.inspect()).generation, 2);
  f.rows.delete([...f.rows.keys()][1]!);
  await assert.rejects(() => recovered.inspect(), /checkpoint/);
  await assert.rejects(() => recovered.append({ ...intent, operationId: 'replacement',
    expectedGeneration: first.generation, expectedDigest: first.digest }), /checkpoint/);
  assert.equal(f.rows.size, 1);
  f.rows.clear();
  await assert.rejects(() => recovered.inspect(), /checkpoint/);
});

test('a valid but different chain cannot replace the separately retained checkpoint', async () => {
  const original = fixture(); const saved = await original.journal.append(intent);
  const replacement = fixture();
  await replacement.journal.append({ ...intent, factsDigest: 'b'.repeat(64) });
  const recovered = new RecoveryAuthorityJournal(replacement.store, binding,
    { ...binding, generation: saved.generation, digest: saved.digest });
  await assert.rejects(() => recovered.inspect(), /checkpoint/);
});

test('checkpoint custody requires explicit identity and a consistent generation/digest pair', () => {
  const f = fixture();
  assert.throws(() => Reflect.construct(RecoveryAuthorityJournal, [f.store, binding]));
  for (const checkpoint of [
    { ...initializationCheckpoint, organisationId: 'another-charity' },
    { ...initializationCheckpoint, installationId: 'another-installation' },
    { ...initializationCheckpoint, generation: 1 },
    { ...initializationCheckpoint, digest: 'a'.repeat(64) },
  ]) {
    assert.throws(() => new RecoveryAuthorityJournal(f.store, binding, checkpoint));
  }
  assert.equal(f.rows.size, 0);
});

test('a checkpoint permits valid later history but never authorizes an action', async () => {
  const f = fixture(); const saved = await f.journal.append(intent);
  const recovered = new RecoveryAuthorityJournal(f.store, binding,
    { ...binding, generation: saved.generation, digest: saved.digest });
  const next = await recovered.append({ ...intent, operationId: 'later-hold',
    kind: 'PRESERVATION_CHANGE', expectedGeneration: saved.generation, expectedDigest: saved.digest });
  assert.equal(next.generation, 2);
  assert.equal(next.actionAuthorized, false);
  assert.deepEqual(await recovered.inspect(), { generation: 2, digest: next.digest, actionAuthorized: false });
});

test('current-head verification refuses truncation after an older trusted checkpoint', async () => {
  const f = fixture(); const first = await f.journal.append(intent);
  const second = await f.journal.append({ ...intent, operationId: 'new-hold',
    expectedGeneration: first.generation, expectedDigest: first.digest });
  const source = { readHead: async () => ({ ...binding, generation: second.generation,
    digest: second.digest, revision: 'revision-2' }) };
  f.rows.delete([...f.rows.keys()][1]!);
  await assert.rejects(async () => f.journal.inspectCurrent(source), /current head/);
});

test('current-head verification returns only a non-authorizing stable observation', async () => {
  const f = fixture(); const saved = await f.journal.append(intent); let reads = 0;
  const source = { readHead: async () => {
    reads++;
    return { ...binding, generation: saved.generation, digest: saved.digest, revision: 'revision-1' };
  } };
  const result = await f.journal.inspectCurrent(source);
  assert.equal(reads, 2);
  assert.deepEqual(result, { generation: saved.generation, digest: saved.digest,
    revision: 'revision-1', actionAuthorized: false });
});

test('head changes during verification invalidate the observation even with the same digest', async () => {
  const f = fixture(); const saved = await f.journal.append(intent); let reads = 0;
  const source = { readHead: async () => ({ ...binding, generation: saved.generation,
    digest: saved.digest, revision: `revision-${++reads}` }) };
  await assert.rejects(async () => f.journal.inspectCurrent(source), /changed/);
});

test('missing, foreign, malformed and unavailable current head never become an empty authority', async () => {
  const f = fixture();
  for (const head of [null, { ...initializationCheckpoint, revision: '' },
    { ...initializationCheckpoint, organisationId: 'foreign', revision: 'revision-1' },
    { ...initializationCheckpoint, revision: 'revision-1', unexpected: true }]) {
    await assert.rejects(async () => f.journal.inspectCurrent(
      { readHead: async () => head }), /current head/);
  }
  await assert.rejects(async () => f.journal.inspectCurrent(
    { readHead: async () => { throw new Error('offline'); } }), /unavailable/);
});

test('unpublished journal suffixes and loss of the second head read refuse verification', async () => {
  const f = fixture(); const first = await f.journal.append(intent);
  const head = { ...binding, generation: first.generation, digest: first.digest, revision: 'revision-1' };
  await f.journal.append({ ...intent, operationId: 'not-yet-published',
    expectedGeneration: first.generation, expectedDigest: first.digest });
  await assert.rejects(() => f.journal.inspectCurrent({ readHead: async () => head }), /current head/);
  f.rows.delete([...f.rows.keys()][1]!);
  let reads = 0;
  await assert.rejects(() => f.journal.inspectCurrent({ readHead: async () => {
    if (++reads === 2) throw new Error('connection lost');
    return head;
  } }), /unavailable/);
});
