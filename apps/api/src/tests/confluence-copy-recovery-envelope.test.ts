import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareConfluenceCopyRecoveryFacts, assertConfluenceCopyRecoveryProgression } from '../services/confluence-copy-recovery-facts.js';
import { sealConfluenceCopyRecoveryFacts, openConfluenceCopyRecoveryFacts, preserveConfluenceCopyRecoveryFacts,
  readVerifiedConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-envelope.js';
import { recoveryFactsFixture, recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

function keyFixture() {
  const allocated: Buffer[] = [];
  const make = () => { const key = Buffer.alloc(32, 7); allocated.push(key); return key; };
  const keys: RecoveryDataKeys = {
    generate: async () => ({ key: make(), wrappedKey: Buffer.from('synthetic-wrapped-key').toString('base64'), keyId: context.keyId }),
    unwrap: async () => ({ key: make(), keyId: context.keyId }),
  };
  return { keys, allocated };
}
test('complete decision facts round-trip encrypted and generated/unwrapped key buffers are wiped', async () => {
  const { keys, allocated } = keyFixture(); const facts = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const sealed = await sealConfluenceCopyRecoveryFacts(facts.body, context, keys);
  assert.equal(sealed.envelope.includes('Dispose of the exact synthetic remote copy'), false);
  assert.equal(sealed.envelope.includes('C01-PERMISSION'), false);
  assert.equal((await openConfluenceCopyRecoveryFacts(sealed.envelope, context, keys)).body, facts.body);
  assert.ok(allocated.every((key) => key.every((byte) => byte === 0)));
  assert.equal(sealed.actionAuthorized, false);
});
for (const [label, change] of Object.entries({
  wrongOrganisation: (value: typeof context) => ({ ...value, organisationId: 'other-org' }),
  wrongOperation: (value: typeof context) => ({ ...value, operationId: 'other-operation' }),
  wrongEpoch: (value: typeof context) => ({ ...value, writerEpoch: 2 }),
  wrongSource: (value: typeof context) => ({ ...value, sourceRevision: 'b'.repeat(40) }),
  wrongKey: (value: typeof context) => ({ ...value, keyId: value.keyId.replace('111111111111', '222222222222') }),
})) test(`recovery envelope refuses ${label}`, async () => {
  const { keys } = keyFixture(); const facts = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const sealed = await sealConfluenceCopyRecoveryFacts(facts.body, context, keys);
  await assert.rejects(openConfluenceCopyRecoveryFacts(sealed.envelope, change(context), keys));
});
test('tampered ciphertext refuses and still wipes unwrapped key material', async () => {
  const { keys, allocated } = keyFixture(); const facts = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const sealed = await sealConfluenceCopyRecoveryFacts(facts.body, context, keys);
  const raw = JSON.parse(sealed.envelope); raw.sealed.ciphertext = Buffer.from('changed bytes').toString('base64');
  await assert.rejects(openConfluenceCopyRecoveryFacts(JSON.stringify(raw), context, keys));
  assert.ok(allocated.every((key) => key.every((byte) => byte === 0)));
});
test('duplicate JSON keys or plaintext fields cannot be hidden next to an encrypted envelope', async () => {
  const { keys } = keyFixture(); const facts = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const { envelope } = await sealConfluenceCopyRecoveryFacts(facts.body, context, keys);
  await assert.rejects(openConfluenceCopyRecoveryFacts(envelope.replace('{', '{"format":1,'), context, keys));
  await assert.rejects(openConfluenceCopyRecoveryFacts(JSON.stringify({ ...JSON.parse(envelope), plaintext: facts.body }), context, keys));
});
test('unknown write acknowledgement resumes the original object without overwrite', async () => {
  const { keys } = keyFixture(); const facts = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  let stored: string | null = null; let writes = 0;
  const store = { readConfluenceCopyState: async () => stored,
    createConfluenceCopyState: async (_id: string, envelope: string) => { stored = envelope; writes++; throw new Error('Synthetic lost acknowledgement'); } };
  await assert.rejects(preserveConfluenceCopyRecoveryFacts(facts.body, context, keys, store));
  const result = await preserveConfluenceCopyRecoveryFacts(facts.body, context, keys, store);
  assert.equal(result.replayed, true); assert.equal(writes, 1);
  const observed = await readVerifiedConfluenceCopyRecoveryFacts(result.digest, context, keys, store);
  assert.equal(observed.body, facts.body); assert.equal(observed.currentHistoryVerified, false);
  assert.equal(observed.reopeningAuthorised, false);
});
test('changed facts cannot overwrite an already preserved operation identity', async () => {
  const { keys } = keyFixture(); const first = recoveryFactsFixture(); let stored: string | null = null;
  const store = { readConfluenceCopyState: async () => stored,
    createConfluenceCopyState: async (_id: string, envelope: string) => { assert.equal(stored, null); stored = envelope; return true; } };
  await preserveConfluenceCopyRecoveryFacts(prepareConfluenceCopyRecoveryFacts(first).body, context, keys, store);
  first.capturedAt = '2026-10-15T18:06:00.000Z';
  await assert.rejects(preserveConfluenceCopyRecoveryFacts(prepareConfluenceCopyRecoveryFacts(first).body, context, keys, store));
});
test('a missing published object is never recreated from backup facts', async () => {
  const { keys } = keyFixture(); let created = false;
  const store = { readConfluenceCopyState: async () => null,
    createConfluenceCopyState: async () => { created = true; return true; } };
  await assert.rejects(readVerifiedConfluenceCopyRecoveryFacts('a'.repeat(64), context, keys, store));
  assert.equal(created, false);
});
test('an encrypted later withdrawal is retained when compared with an older backup payload', async () => {
  const { keys } = keyFixture(); const objects = new Map<string, string>();
  const store = { readConfluenceCopyState: async (id: string) => objects.get(id) ?? null,
    createConfluenceCopyState: async (id: string, body: string) => { if (objects.has(id)) return false; objects.set(id, body); return true; } };
  const first = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const firstReceipt = await preserveConfluenceCopyRecoveryFacts(first.body, context, keys, store);
  const next = recoveryFactsFixture(); next.operationId = 'state-2'; next.factsRevision = 2;
  next.previousFactsDigest = first.digest; next.capturedAt = '2026-10-15T18:07:00.000Z';
  next.permissionWithdrawal = { id: 'withdrawal-a', organisationId: 'org-a', permissionId: 'permission-a', actorUserId: 'owner-a',
    evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw exact synthetic permission', occurredAt: '2026-10-15T18:06:00.000Z' };
  const nextContext = { ...context, operationId: 'state-2' };
  const second = prepareConfluenceCopyRecoveryFacts(next);
  const secondReceipt = await preserveConfluenceCopyRecoveryFacts(second.body, nextContext, keys, store);
  const recovered = await readVerifiedConfluenceCopyRecoveryFacts(secondReceipt.digest, nextContext, keys, store);
  const result = assertConfluenceCopyRecoveryProgression(first.body, recovered.body);
  assert.ok(JSON.parse(result.body).permissionWithdrawal);
  assert.equal(result.reopeningAuthorised, false);
  await assert.rejects(readVerifiedConfluenceCopyRecoveryFacts(firstReceipt.digest, nextContext, keys, store));
  objects.delete('state-2');
  await assert.rejects(readVerifiedConfluenceCopyRecoveryFacts(secondReceipt.digest, nextContext, keys, store));
  assert.equal(objects.size, 1, 'no fallback recreation from the stale first payload');
});
