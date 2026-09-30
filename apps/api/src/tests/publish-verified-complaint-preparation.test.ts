import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { complaintPreparationFixture } from './complaint-preparation-fixture.js';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { sealRecoveryPreparation, type RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { type RecoveryControlValue } from '../services/recovery-operation-reservation.js';
import { publishVerifiedComplaintPreparation } from '../services/publish-verified-complaint-preparation.js';

async function fixture() {
  const facts = complaintPreparationFixture();
  const body = prepareComplaintRecoveryFacts(facts).body;
  const binding = { installationId: facts.installationId, organisationId: facts.organisationId };
  const context = { ...binding, operationId: facts.operationId, writerEpoch: facts.writerEpoch,
    sourceRevision: facts.sourceRevision,
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  const keys: RecoveryDataKeys = {
    async generate() { return { key: Buffer.alloc(32, 7), keyId: context.keyId, wrappedKey: Buffer.from('synthetic').toString('base64') }; },
    async unwrap() { return { key: Buffer.alloc(32, 7), keyId: context.keyId }; },
  };
  const candidate = await sealRecoveryPreparation(body, context, keys);
  let envelope: string | null = candidate.envelope;
  const request = { writerId: 'host-a', preparationDigest: createHash('sha256').update(body).digest('hex'),
    expectedGeneration: 0, expectedDigest: null };
  let current: RecoveryControlValue & { revision: string } = { format: 2, ...binding,
    writerId: request.writerId, writerEpoch: context.writerEpoch, generation: 0, digest: null,
    activeOperation: { operationId: context.operationId, preparationDigest: request.preparationDigest }, revision: 'v0' };
  let version = 0, loseAck = false;
  const control = { async readControl() { return structuredClone(current); },
    async compareAndSwapControl(revision: string, next: RecoveryControlValue) {
      if (revision !== current.revision) return false;
      current = { ...next, revision: `v${++version}` };
      if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); }
      return true;
    } };
  const rows = new Map<string, string>();
  const journal = new RecoveryAuthorityJournal({ async read(key) { return rows.get(key) ?? null; },
    async create(key, value) { if (rows.has(key)) return false; rows.set(key, value); return true; },
  }, binding, { ...binding, generation: 0, digest: null });
  return { rows, keys, request, current: () => current, candidate,
    loseAck: () => { loseAck = true; },
    replaceWithEquivalent: async () => { envelope = (await sealRecoveryPreparation(body, context, keys)).envelope; },
    replace: (value: string | null) => { envelope = value; },
    changeControl: () => { current = { ...current, revision: 'external-change' }; },
    publish: () => publishVerifiedComplaintPreparation(journal, control, request, context, keys,
      { async readReplay() { return envelope; } }) };
}

test('verified publication binds exact decrypted facts and winning ciphertext, retaining reservation on retry', async () => {
  const f = await fixture();
  const result = await f.publish();
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.headPublished, true);
  assert.equal(JSON.parse([...f.rows.values()][0]!).factsDigest, f.candidate.digest);
  assert.equal(f.current().activeOperation?.preparationDigest, f.request.preparationDigest);
  assert.equal((await f.publish()).replayed, true);
  f.replace(null);
  await assert.rejects(f.publish, /missing/);
  assert.equal(f.rows.size, 1);
});

test('publication acknowledgement loss retains the original binding and rejects re-encrypted replacement', async () => {
  const f = await fixture();
  f.loseAck();
  await assert.rejects(f.publish, /unknown/);
  const originalRows = [...f.rows.values()];
  assert.equal(f.current().generation, 1);
  assert.equal((await f.publish()).replayed, true);
  await f.replaceWithEquivalent();
  await assert.rejects(f.publish, /different facts/);
  assert.deepEqual([...f.rows.values()], originalRows);
  assert.equal(f.current().activeOperation?.preparationDigest, f.request.preparationDigest);
});

test('missing, corrupt, mismatched facts and control changes during decryption publish nothing', async () => {
  for (const scenario of ['missing', 'corrupt', 'facts', 'control']) {
    const f = await fixture();
    if (scenario === 'missing') f.replace(null);
    if (scenario === 'corrupt') f.replace(f.candidate.envelope.replace('ciphertext', 'invalid'));
    if (scenario === 'facts') {
      f.request.preparationDigest = 'a'.repeat(64);
      f.current().activeOperation!.preparationDigest = f.request.preparationDigest;
    }
    if (scenario === 'control') {
      const unwrap = f.keys.unwrap;
      f.keys.unwrap = async (...args) => { const key = await unwrap(...args); f.changeControl(); return key; };
    }
    await assert.rejects(f.publish);
    assert.equal(f.rows.size, 0, scenario);
    assert.equal(f.current().generation, 0, scenario);
  }
});
