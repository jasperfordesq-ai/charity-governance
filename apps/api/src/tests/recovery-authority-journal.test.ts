import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { RecoveryAuthorityJournal, type AuthorityObjectStore, type AuthorityCheckpoint } from '../services/recovery-authority-journal.js';

const binding = { installationId: 'install-a', organisationId: 'charity-a' };
const initializationCheckpoint = { ...binding, generation: 0, digest: null };

function fixture(options?: { appendVerification: 'FULL' | 'VERIFIED_PREFIX' }) {
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
    journal: new RecoveryAuthorityJournal(store, binding, initializationCheckpoint, options) };
}
const intent = { operationId: 'operation-a', kind: 'DISPOSAL_INTENT' as const,
  factsDigest: 'a'.repeat(64), expectedGeneration: 0, expectedDigest: null };

function publisherFixture(options?: { appendVerification: 'FULL' | 'VERIFIED_PREFIX' }) {
  const f = fixture(options);
  let head = { ...initializationCheckpoint, digest: null as string | null, revision: 'version-0' };
  let version = 0; let loseAck = false;
  const publisher = {
    async readHead() { return { ...head }; },
    async compareAndSwap(revision: string, next: AuthorityCheckpoint) {
      if (head.revision !== revision) return false;
      head = { ...next, revision: `version-${++version}` };
      if (loseAck) { loseAck = false; throw new Error('lost head acknowledgement'); }
      return true;
    },
  };
  return { ...f, publisher, loseHeadAck() { loseAck = true; }, version: () => version };
}

test('published entry lookup verifies the whole current history and exact operation kind', async () => {
  const f = publisherFixture();
  await f.journal.appendPublished(intent, f.publisher);
  const observed = await f.journal.readPublishedEntry(intent.operationId, intent.kind, f.publisher);
  assert.equal(observed.entry.factsDigest, intent.factsDigest);
  assert.equal(observed.entry.organisationId, binding.organisationId);
  assert.equal(observed.actionAuthorized, false);
  await assert.rejects(() => f.journal.readPublishedEntry('missing', intent.kind, f.publisher), /not published/);
  await assert.rejects(() => f.journal.readPublishedEntry(intent.operationId, 'DISPOSAL_RESULT', f.publisher), /not published/);
  observed.entry.factsDigest = 'b'.repeat(64);
  assert.equal((await f.journal.readPublishedEntry(intent.operationId, intent.kind, f.publisher)).entry.factsDigest, intent.factsDigest);
  await f.journal.append({ ...intent, operationId: 'unpublished', expectedGeneration: 1, expectedDigest: observed.entry.digest });
  await assert.rejects(() => f.journal.readPublishedEntry(intent.operationId, intent.kind, f.publisher), /does not match/);
});

test('published entry lookup refuses a changing head and deleted history', async () => {
  const f = publisherFixture();
  await f.journal.appendPublished(intent, f.publisher);
  const original = f.publisher.readHead;
  let reads = 0;
  f.publisher.readHead = async () => ({ ...await original(), revision: `changed-${++reads}` });
  await assert.rejects(() => f.journal.readPublishedEntry(intent.operationId, intent.kind, f.publisher), /changed/);
  f.publisher.readHead = original;
  f.rows.clear();
  await assert.rejects(() => f.journal.readPublishedEntry(intent.operationId, intent.kind, f.publisher), /does not match/);
});

test('published append retries a committed head after acknowledgement loss without republishing', async () => {
  const f = publisherFixture(); f.loseHeadAck();
  const publish = () => f.journal.appendPublished( intent, f.publisher);
  await assert.rejects(publish, /outcome is unknown/);
  const receipt = await publish();
  assert.equal(receipt.headPublished, true); assert.equal(receipt.actionAuthorized, false);
  assert.equal(receipt.replayed, true); assert.equal(f.version(), 1); assert.equal(f.rows.size, 1);
});

test('published append recovers an intent stored before a crash without creating a second entry', async () => {
  const f = publisherFixture(); f.loseNextAck();
  const publish = () => f.journal.appendPublished( intent, f.publisher);
  await assert.rejects(publish, /outcome is unknown/);
  assert.equal(f.version(), 0); assert.equal(f.rows.size, 1);
  await assert.rejects(async () => f.journal.appendPublished(
    { ...intent, operationId: 'replacement' }, f.publisher), /pending/);
  const receipt = await publish();
  assert.equal(receipt.headPublished, true); assert.equal(f.version(), 1); assert.equal(f.rows.size, 1);
});

test('competing published appends cannot publish two intents at the same predecessor', async () => {
  const f = publisherFixture();
  const results = await Promise.allSettled([intent, { ...intent, operationId: 'rival' }].map(input =>
    f.journal.appendPublished( input, f.publisher)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.version(), 1); assert.equal(f.rows.size, 1);
});

test('an old head behind the trusted checkpoint cannot acknowledge even an older operation', async () => {
  const f = publisherFixture(); const first = await f.journal.appendPublished(intent, f.publisher);
  const oldHead = await f.publisher.readHead();
  const second = await f.journal.appendPublished({ ...intent, operationId: 'new-hold',
    expectedGeneration: first.generation, expectedDigest: first.digest }, f.publisher);
  const recovered = new RecoveryAuthorityJournal(f.store, binding,
    { ...binding, generation: second.generation, digest: second.digest });
  f.publisher.readHead = async () => oldHead;
  await assert.rejects(() => recovered.appendPublished(intent, f.publisher), /checkpoint/);
});

test('publication acknowledgement without an observable head advance remains unknown', async () => {
  const f = publisherFixture();
  f.publisher.compareAndSwap = async () => true;
  await assert.rejects(() => f.journal.appendPublished(intent, f.publisher), /outcome is unknown/);
  assert.equal(f.rows.size, 1); assert.equal(f.version(), 0);
});

test('retries after subsequent published decisions retain the original operation identity', async () => {
  const f = publisherFixture(); const first = await f.journal.appendPublished(intent, f.publisher);
  await f.journal.appendPublished({ ...intent, operationId: 'later-preservation', kind: 'PRESERVATION_CHANGE',
    expectedGeneration: first.generation, expectedDigest: first.digest }, f.publisher);
  const retry = await f.journal.appendPublished(intent, f.publisher);
  assert.equal(retry.generation, 1); assert.equal(retry.replayed, true);
  assert.equal(f.version(), 2); assert.equal(f.rows.size, 2);
  await assert.rejects(() => f.journal.appendPublished({ ...intent, factsDigest: 'c'.repeat(64) }, f.publisher), /operation identity/);
});

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

test('the whole journal scan has a deadline even if a store never settles its read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); let reads = 0; let signal: AbortSignal | undefined;
  f.store.read = (_key: string, suppliedSignal?: AbortSignal) => {
    reads++; signal = suppliedSignal;
    return new Promise<string | null>(() => {});
  };
  const result = assert.rejects(() => f.journal.inspect(), /verification deadline/);
  t.mock.timers.tick(30001);
  await result;
  assert.equal(reads, 1);
  assert.equal(signal?.aborted, true);
});

test('a store resolving absence during cancellation cannot turn expiry into a verified empty journal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.store.read = (_key, signal) => new Promise(resolve => {
    signal!.addEventListener('abort', () => resolve(null), { once: true });
  });
  const refusal = assert.rejects(() => f.journal.inspect(), /verification deadline/);
  t.mock.timers.tick(30001);
  await refusal;
});

test('opt-in verified-prefix append uses bounded reads after warming the complete history', async () => {
  const f = publisherFixture({ appendVerification: 'VERIFIED_PREFIX' });
  const originalRead = f.store.read; let reads = 0;
  f.store.read = async (...args) => { reads++; return originalRead(...args); };
  let previous = { generation: 0, digest: null as string | null };
  for (let i = 0; i < 30; i++) {
    reads = 0;
    previous = await f.journal.appendPublished({ ...intent, operationId: `operation-${i}`,
      expectedGeneration: previous.generation, expectedDigest: previous.digest }, f.publisher);
    assert.ok(reads <= 10, `append ${i} used ${reads} object reads`);
  }
  await assert.rejects(() => f.journal.appendPublished({ ...intent, operationId: 'operation-0',
    expectedGeneration: previous.generation, expectedDigest: previous.digest }, f.publisher), /operation identity/);
});

test('verified-prefix mode rechecks its boundary and full recovery still reads historical entries', async () => {
  const f = publisherFixture({ appendVerification: 'VERIFIED_PREFIX' });
  const first = await f.journal.appendPublished(intent, f.publisher);
  const second = await f.journal.appendPublished({ ...intent, operationId: 'second',
    expectedGeneration: first.generation, expectedDigest: first.digest }, f.publisher);
  const keys = [...f.rows.keys()];
  const boundary = f.rows.get(keys[1]!)!;
  f.rows.set(keys[1]!, '{}');
  await assert.rejects(() => f.journal.appendPublished({ ...intent, operationId: 'third',
    expectedGeneration: second.generation, expectedDigest: second.digest }, f.publisher));
  f.rows.set(keys[1]!, boundary);
  f.rows.set(keys[0]!, '{}');
  await assert.rejects(() => f.journal.inspectCurrent(f.publisher));
  await assert.rejects(() => f.journal.appendPublished({ ...intent, operationId: 'third',
    expectedGeneration: second.generation, expectedDigest: second.digest }, f.publisher));
});

test('verified-prefix append reads another writer\'s new history and refuses stale expectations', async () => {
  const f = publisherFixture({ appendVerification: 'VERIFIED_PREFIX' });
  const first = await f.journal.appendPublished(intent, f.publisher);
  const other = new RecoveryAuthorityJournal(f.store, binding, initializationCheckpoint);
  const second = await other.appendPublished({ ...intent, operationId: 'other-writer-hold', kind: 'PRESERVATION_CHANGE',
    expectedGeneration: first.generation, expectedDigest: first.digest }, f.publisher);
  await assert.rejects(() => f.journal.appendPublished({ ...intent, operationId: 'stale-intent',
    expectedGeneration: first.generation, expectedDigest: first.digest }, f.publisher), /generation changed/);
  const third = await f.journal.appendPublished({ ...intent, operationId: 'new-review',
    expectedGeneration: second.generation, expectedDigest: second.digest }, f.publisher);
  assert.equal(third.generation, 3); assert.equal(third.actionAuthorized, false);
});

test('verified-prefix mode recovers acknowledgement loss and a fresh instance verifies the old prefix', async () => {
  const f = publisherFixture({ appendVerification: 'VERIFIED_PREFIX' });
  const first = await f.journal.appendPublished(intent, f.publisher);
  f.loseHeadAck();
  const next = { ...intent, operationId: 'second', expectedGeneration: first.generation, expectedDigest: first.digest };
  await assert.rejects(() => f.journal.appendPublished(next, f.publisher), /unknown/);
  assert.equal((await f.journal.appendPublished(next, f.publisher)).replayed, true);
  assert.equal(f.version(), 2);
  f.rows.set([...f.rows.keys()][0]!, '{}');
  const restarted = new RecoveryAuthorityJournal(f.store, binding, initializationCheckpoint,
    { appendVerification: 'VERIFIED_PREFIX' });
  await assert.rejects(() => restarted.appendPublished(next, f.publisher), /Invalid recovery authority/);
});

test('invalidating prefix reuse does not forget a later history already verified in this process', async () => {
  const f = publisherFixture({ appendVerification: 'VERIFIED_PREFIX' });
  const first = await f.journal.appendPublished(intent, f.publisher);
  const oldHead = await f.publisher.readHead();
  await f.journal.appendPublished({ ...intent, operationId: 'later-hold',
    expectedGeneration: first.generation, expectedDigest: first.digest }, f.publisher);
  const keys = [...f.rows.keys()];
  f.rows.set(keys[1]!, '{}');
  await assert.rejects(() => f.journal.inspect());
  f.rows.delete(keys[1]!);
  f.publisher.readHead = async () => oldHead;
  await assert.rejects(() => f.journal.appendPublished({ ...intent, operationId: 'replacement',
    expectedGeneration: first.generation, expectedDigest: first.digest }, f.publisher), /verified history/);
  assert.equal(f.rows.size, 1);
});

function nearCapacityFixture(generation: number) {
  const rows = new Map<string, string>();
  let previousDigest: string | null = null;
  for (let i = 1; i <= generation; i++) {
    const facts: { format: number; installationId: string; organisationId: string;
      generation: number; previousDigest: string | null; operationId: string;
      kind: string; factsDigest: string } = { format: 1, ...binding, generation: i, previousDigest,
      operationId: `prior-${i}`, kind: 'PRESERVATION_CHANGE', factsDigest: 'a'.repeat(64) };
    const digest: string = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    rows.set(`authority/${binding.installationId}/${binding.organisationId}/${String(i).padStart(10, '0')}.json`,
      JSON.stringify({ ...facts, digest }));
    previousDigest = digest;
  }
  let creates = 0;
  const store: AuthorityObjectStore = {
    async read(key) { return rows.get(key) ?? null; },
    async create(key, body) { creates++; if (rows.has(key)) return false; rows.set(key, body); return true; },
  };
  return { rows, store, lastDigest: previousDigest, creates: () => creates,
    journal: new RecoveryAuthorityJournal(store, binding,
      { ...binding, generation, digest: previousDigest }) };
}

test('a cold full current-history scan verifies the complete capacity under bounded read latency', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = nearCapacityFixture(10000);
  const immediate = f.store.read;
  let active = 0; let peak = 0; let reads = 0;
  f.store.read = (key, signal) => new Promise((resolve, reject) => {
    reads++; active++; peak = Math.max(peak, active);
    const finish = () => { active--; signal?.removeEventListener('abort', cancel); };
    const cancel = () => { clearTimeout(timer); finish(); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { finish(); resolve(immediate(key)); }, 50);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  // Start from genesis: the authenticated head, rather than a warm cache or a
  // supplied terminal checkpoint, identifies the range that must be inspected.
  const cold = new RecoveryAuthorityJournal(f.store, binding, initializationCheckpoint);
  let observed: Awaited<ReturnType<typeof cold.inspectCurrent>> | undefined;
  let failure: unknown; let settled = false;
  const scan = cold.inspectCurrent({ readHead: async () => ({ ...binding,
    generation: 10000, digest: f.lastDigest, revision: 'synthetic-head-10000' }) })
    .then(value => { observed = value; }, error => { failure = error; })
    .finally(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let elapsed = 0; !settled && elapsed < 30000; elapsed += 50) {
    t.mock.timers.tick(50);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(settled, true);
  await scan;
  assert.equal(failure, undefined);
  assert.deepEqual(observed, { generation: 10000, digest: f.lastDigest,
    revision: 'synthetic-head-10000', actionAuthorized: false });
  assert.ok(peak > 1 && peak <= 32, `peak reads ${peak}`);
  assert.equal(reads, 10001, 'each entry and the absence probe are read once');
  assert.equal(active, 0);
  assert.equal(f.creates(), 0);
});

test('parallel full verification checks chain order despite reversed read completions', async () => {
  const f = nearCapacityFixture(32);
  const immediate = f.store.read;
  const pending: (() => void)[] = [];
  const completed: number[] = [];
  f.store.read = (key) => {
    const generation = Number(key.split('/').at(-1)!.slice(0, -5));
    if (generation > 32) return immediate(key);
    return new Promise(resolve => {
      pending.push(() => { completed.push(generation); resolve(immediate(key)); });
      if (pending.length === 32) for (const finish of pending.reverse()) finish();
    });
  };
  const observed = await f.journal.inspect();
  assert.equal(completed[0], 32);
  assert.equal(observed.generation, 32);
  assert.equal(observed.digest, f.lastDigest);
  assert.equal(observed.actionAuthorized, false);
});

test('missing or tampered history in a parallel batch never reaches the next batch', async () => {
  for (const replacement of [null, '{}']) {
    const f = nearCapacityFixture(64);
    const key = [...f.rows.keys()][16]!;
    if (replacement === null) f.rows.delete(key); else f.rows.set(key, replacement);
    const immediate = f.store.read;
    let reads = 0;
    f.store.read = async (...args) => { reads++; return immediate(...args); };
    await assert.rejects(() => f.journal.inspect(), /shorter than|Invalid recovery authority/);
    assert.equal(reads, 32);
    assert.equal(f.creates(), 0);
  }
});

test('parallel scan deadline aborts every outstanding read and cannot authorize a partial prefix', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = nearCapacityFixture(64);
  let reads = 0; let cancelled = 0;
  f.store.read = (_key, signal) => new Promise((_resolve, reject) => {
    reads++;
    signal!.addEventListener('abort', () => { cancelled++; reject(new Error('cancelled')); }, { once: true });
  });
  const result = assert.rejects(() => f.journal.inspect(), /verification deadline/);
  t.mock.timers.tick(30001);
  await result;
  assert.equal(reads, 32);
  assert.equal(cancelled, 32);
  assert.equal(f.creates(), 0);
});

test('a failed parallel read cancels its unfinished siblings instead of accepting partial history', async () => {
  const f = nearCapacityFixture(64);
  let cancelled = 0;
  f.store.read = async (key, signal) => {
    if (key.endsWith('0000000017.json')) throw new Error('synthetic provider failure');
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { cancelled++; reject(new Error('cancelled')); }, { once: true });
    });
  };
  await assert.rejects(() => f.journal.inspect(), /unavailable/);
  assert.equal(cancelled, 31);
  assert.equal(f.creates(), 0);
});

test('parallel current-history verification still refuses a wrong digest or moving head', async () => {
  for (const changing of [false, true]) {
    const f = nearCapacityFixture(32);
    const cold = new RecoveryAuthorityJournal(f.store, binding, initializationCheckpoint);
    let reads = 0;
    await assert.rejects(() => cold.inspectCurrent({ readHead: async () => ({ ...binding,
      generation: 32, digest: changing ? f.lastDigest : 'b'.repeat(64),
      revision: changing ? `revision-${++reads}` : 'wrong-digest',
    }) }), changing ? /changed during verification/ : /does not match its current head/);
    assert.equal(f.creates(), 0);
  }
});

test('cold published appends and pending-entry recovery use their authenticated history range', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = nearCapacityFixture(650);
  const immediate = f.store.read;
  let peak = 0; let active = 0;
  f.store.read = (key, signal) => new Promise((resolve, reject) => {
    active++; peak = Math.max(peak, active);
    const finish = () => { active--; signal?.removeEventListener('abort', cancel); };
    const cancel = () => { clearTimeout(timer); finish(); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { finish(); resolve(immediate(key)); }, 50);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  let head = { ...binding, generation: 650, digest: f.lastDigest, revision: 'initial-650' };
  const publisher = {
    async readHead() { return { ...head }; },
    async compareAndSwap(revision: string, next: AuthorityCheckpoint) {
      if (revision !== head.revision) return false;
      head = { ...next, revision: `generation-${next.generation}` }; return true;
    },
  };
  const cold = new RecoveryAuthorityJournal(f.store, binding, initializationCheckpoint);
  const request = { ...intent, expectedGeneration: 650, expectedDigest: f.lastDigest };
  let failure: unknown; let settled = false;
  const work = (async () => {
    const published = await cold.appendPublished(request, publisher);
    assert.equal(published.generation, 651);
    assert.equal(published.headPublished, true);
    assert.equal(published.actionAuthorized, false);
    assert.equal(f.creates(), 1);
    // A separate crash-state head fixture models stored-before-publication;
    // the actual publisher above is never rolled back. Start from genesis.
    const pendingSource = { readHead: async () => ({ ...binding,
      generation: 650, digest: f.lastDigest, revision: 'pending-fixture-650' }) };
    const restarted = new RecoveryAuthorityJournal(f.store, binding, initializationCheckpoint);
    const pending = await restarted.readPendingEntry(intent.operationId, intent.kind, pendingSource);
    assert.equal(pending.pending.digest, published.digest);
    assert.equal(pending.pending.generation, 651);
    assert.equal(pending.actionAuthorized, false);
  })().catch(error => { failure = error; }).finally(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let elapsed = 0; !settled && elapsed < 120000; elapsed += 50) {
    t.mock.timers.tick(50);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(settled, true);
  await work;
  assert.equal(failure, undefined);
  assert.ok(peak > 1 && peak <= 32);
  assert.equal(active, 0);
});

test('near capacity refuses a new document chain before storing its preparation', async () => {
  const f = nearCapacityFixture(9994);
  await assert.rejects(() => f.journal.append({ ...intent,
    operationId: 'document-near-capacity', kind: 'DOCUMENT_PREPARATION_V1',
    expectedGeneration: 9994, expectedDigest: f.lastDigest,
  }), /capacity/);
  assert.equal(f.creates(), 0);
  assert.equal(f.rows.size, 9994);
});

test('a document chain admitted at the boundary can occupy its seven reserved entries', async () => {
  const f = nearCapacityFixture(9993);
  let generation = 9993;
  let digest = f.lastDigest!;
  for (const kind of ['DOCUMENT_PREPARATION_V1', 'DOCUMENT_OUTCOME_V1', 'DOCUMENT_BYTE_PERMIT_V1',
    'DOCUMENT_BYTE_EXECUTION_DECISION_V1', 'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1',
    'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1', 'DOCUMENT_DISPOSAL_OUTCOME_V1'] as const) {
    if (kind === 'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1') {
      // A completion can never skip the UNKNOWN it reconciles.
      await assert.rejects(() => f.journal.append({ ...intent, operationId: 'document-at-capacity',
        kind: 'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1', expectedGeneration: generation, expectedDigest: digest }),
      /exact predecessor/);
    }
    if (kind === 'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1') {
      // The whole-case outcome can never skip the primary completion.
      await assert.rejects(() => f.journal.append({ ...intent, operationId: 'document-at-capacity',
        kind: 'DOCUMENT_DISPOSAL_OUTCOME_V1', expectedGeneration: generation, expectedDigest: digest }),
      /exact predecessor/);
    }
    const receipt = await f.journal.append({ ...intent, operationId: 'document-at-capacity', kind,
      expectedGeneration: generation, expectedDigest: digest });
    generation = receipt.generation; digest = receipt.digest;
  }
  assert.equal(generation, 10000);
  assert.equal(f.creates(), 7);
  assert.equal((await f.journal.inspect()).digest, digest);
});

test('the last slot remains available for a standalone decision but not a complaint chain', async () => {
  const f = nearCapacityFixture(9999);
  const digest = f.lastDigest!;
  for (const kind of ['DISPOSAL_INTENT', 'COMPLAINT_PREPARATION_V1', 'COMPLAINT_HOLD_PREPARATION_V1'] as const) {
    await assert.rejects(() => f.journal.append({ ...intent, operationId: `new-${kind}`, kind,
      expectedGeneration: 9999, expectedDigest: digest }), /capacity/);
  }
  assert.equal(f.creates(), 0);
  const decision = await f.journal.append({ ...intent, operationId: 'standalone-final',
    kind: 'PRESERVATION_CHANGE', expectedGeneration: 9999, expectedDigest: digest });
  assert.equal(decision.generation, 10000);
  assert.equal(f.creates(), 1);
});

test('a pending entry is returned only when it is the exact next entry for that operation and kind', async () => {
  const f = publisherFixture();
  const first = await f.journal.appendPublished(intent, f.publisher);
  await assert.rejects(() => f.journal.readPendingEntry(intent.operationId, intent.kind, f.publisher),
    /No exact pending/, 'nothing beyond the head');
  // An intent stored without its head moving: what a crash between the two leaves.
  const next = { ...intent, operationId: 'operation-b', expectedGeneration: 1, expectedDigest: first.digest };
  await f.journal.append(next);
  const read = await f.journal.readPendingEntry('operation-b', intent.kind, f.publisher);
  assert.deepEqual([read.pending.generation, read.pending.operationId, read.head?.digest, read.actionAuthorized],
    [2, 'operation-b', first.digest, false]);
  await assert.rejects(() => f.journal.readPendingEntry('operation-a', intent.kind, f.publisher), /No exact pending/);
  await assert.rejects(() => f.journal.readPendingEntry('operation-b', 'DISPOSAL_RESULT', f.publisher), /No exact pending/);
  // Two entries beyond the head are not one exact pending entry.
  const pendingDigest = read.pending.digest;
  await f.journal.append({ ...intent, operationId: 'operation-c', expectedGeneration: 2, expectedDigest: pendingDigest });
  await assert.rejects(() => f.journal.readPendingEntry('operation-b', intent.kind, f.publisher), /No exact pending/);
});

test('a pending entry read refuses a head that moves while it reads', async () => {
  const f = publisherFixture();
  const first = await f.journal.appendPublished(intent, f.publisher);
  await f.journal.append({ ...intent, operationId: 'operation-b', expectedGeneration: 1, expectedDigest: first.digest });
  const original = f.publisher.readHead;
  let reads = 0;
  f.publisher.readHead = async () => ({ ...await original(), revision: `changed-${++reads}` });
  await assert.rejects(() => f.journal.readPendingEntry('operation-b', intent.kind, f.publisher), /changed/);
  f.publisher.readHead = original;
  assert.equal((await f.journal.readPendingEntry('operation-b', intent.kind, f.publisher)).pending.operationId, 'operation-b');
});
