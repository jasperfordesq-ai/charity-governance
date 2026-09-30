import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { complaintPreparationFixture } from './complaint-preparation-fixture.js';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { openRecoveryPreparation, sealRecoveryPreparation, type RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111';
function fixture() {
  const facts = complaintPreparationFixture();
  const context = { installationId: facts.installationId, organisationId: facts.organisationId,
    operationId: facts.operationId, writerEpoch: facts.writerEpoch, sourceRevision: facts.sourceRevision, keyId };
  const body = prepareComplaintRecoveryFacts(facts).body;
  const retained = new Map<string, Buffer>(); const delivered: Buffer[] = [];
  const keys: RecoveryDataKeys = {
    async generate() {
      const key = randomBytes(32), wrappedKey = randomBytes(48).toString('base64');
      retained.set(wrappedKey, Buffer.from(key)); delivered.push(key); return { key, wrappedKey, keyId };
    },
    async unwrap(wrappedKey) {
      const key = Buffer.from(retained.get(wrappedKey)!); delivered.push(key); return { key, keyId };
    },
  };
  return { context, body, keys, delivered };
}

test('recovery envelope round-trips exact candidate bytes with a separately bound data key', async () => {
  const f = fixture();
  const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  assert.equal(sealed.actionAuthorized, false);
  assert.ok(!sealed.envelope.includes('Synthetic reviewed reason'));
  assert.equal((await openRecoveryPreparation(sealed.envelope, f.context, f.keys)).body, f.body);
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
  const second = await sealRecoveryPreparation(f.body, f.context, f.keys);
  assert.notEqual(second.envelope, sealed.envelope);
  assert.notEqual(second.digest, sealed.digest); // Retries must retain the first envelope, not re-seal.
});

test('every recovery binding component refuses substitution before key access', async () => {
  const f = fixture(); const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  for (const [name, value] of Object.entries({ installationId: 'other', organisationId: 'other', operationId: 'other',
    writerEpoch: 2, sourceRevision: 'b'.repeat(40), keyId: keyId.replace('123456789012', '123456789013') })) {
    const count = f.delivered.length;
    await assert.rejects(() => openRecoveryPreparation(sealed.envelope, { ...f.context, [name]: value }, f.keys),
      { message: 'Recovery preparation could not be decrypted' });
    assert.equal(f.delivered.length, count);
  }
});

test('tampering, truncated tags, noncanonical encoding and oversized envelopes refuse', async () => {
  const f = fixture(); const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  type Stored = { sealed: { tag: string; ciphertext: string; generation: number }; wrappedKey: string; kind: string; extra?: string };
  const mutations = [
    (v: Stored) => { v.sealed.tag = Buffer.alloc(4).toString('base64'); },
    (v: Stored) => { v.sealed.ciphertext = 'AAAA' + v.sealed.ciphertext.slice(4); },
    (v: Stored) => { v.wrappedKey += '\n'; },
    (v: Stored) => { v.sealed.generation++; },
    (v: Stored) => { v.kind = 'INTEGRATION_SECRET'; },
    (v: Stored) => { v.extra = 'unexpected'; },
  ];
  for (const mutate of mutations) {
    const value = JSON.parse(sealed.envelope); mutate(value);
    await assert.rejects(() => openRecoveryPreparation(JSON.stringify(value), f.context, f.keys));
  }
  await assert.rejects(() => openRecoveryPreparation(' '.repeat(65537), f.context, f.keys));
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
});

test('wrapped key bytes are authenticated even if a provider returns the same plaintext key', async () => {
  const f = fixture(); const sealed = await sealRecoveryPreparation(f.body, f.context, f.keys);
  const value = JSON.parse(sealed.envelope); const original = value.wrappedKey;
  const unwrap = f.keys.unwrap;
  f.keys.unwrap = (_wrapped, context) => unwrap(original, context);
  value.wrappedKey = Buffer.from('different wrapping of same data key').toString('base64');
  await assert.rejects(() => openRecoveryPreparation(JSON.stringify(value), f.context, f.keys));
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
});

test('wrong provider key identity clears the returned key and hides underlying errors', async () => {
  const f = fixture(); const key = randomBytes(32);
  f.keys.generate = async () => ({ key, keyId: 'wrong', wrappedKey: 'AAAA' });
  await assert.rejects(() => sealRecoveryPreparation(f.body, f.context, f.keys), error => {
    assert.equal((error as Error).message, 'Recovery preparation could not be encrypted');
    assert.equal((error as Error).cause, undefined); return true;
  });
  assert.ok(key.every(byte => byte === 0));
  f.keys.generate = async () => { throw new Error('sensitive provider details'); };
  await assert.rejects(() => sealRecoveryPreparation(f.body, f.context, f.keys), { message: 'Recovery preparation could not be encrypted' });
});

test('unbound or noncanonical candidate facts are refused before generating a data key', async () => {
  const f = fixture(); let calls = 0;
  f.keys.generate = async () => { calls++; throw new Error('must not run'); };
  const foreign = JSON.parse(f.body); foreign.organisationId = 'foreign';
  for (const body of [JSON.stringify(foreign), f.body + ' ', '{malformed', 'x'.repeat(32769)]) {
    await assert.rejects(() => sealRecoveryPreparation(body, f.context, f.keys));
  }
  assert.equal(calls, 0);
});
