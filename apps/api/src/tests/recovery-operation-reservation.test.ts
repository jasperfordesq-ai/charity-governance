import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reserveRecoveryOperation, type RecoveryControlStore, type RecoveryControlValue } from '../services/recovery-operation-reservation.js';

const binding = { installationId: 'installation', organisationId: 'charity' };
const request = { ...binding, writerId: 'host-a', writerEpoch: 1, operationId: 'operation-a',
  preparationDigest: 'a'.repeat(64), expectedGeneration: 0, expectedDigest: null };
function fixture() {
  let head: RecoveryControlValue & { revision: string } = { format: 2, ...binding, writerId: 'host-a', writerEpoch: 1,
    generation: 0, digest: null, activeOperation: null, revision: 'version-0' };
  let writes = 0, loseAcknowledgement = false;
  const store: RecoveryControlStore = {
    async readControl() { return structuredClone(head); },
    async compareAndSwapControl(revision, next) {
      if (revision !== head.revision) return false;
      head = { ...structuredClone(next), revision: `version-${++writes}` };
      if (loseAcknowledgement) throw new Error('synthetic lost acknowledgement');
      return true;
    },
  };
  return { store, head: () => head, writes: () => writes,
    loseAck() { loseAcknowledgement = true; } };
}

test('competing recovery operations cannot both reserve the same independent control', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    reserveRecoveryOperation(request, f.store),
    reserveRecoveryOperation({ ...request, operationId: 'operation-b' }, f.store),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.writes(), 1);
  assert.equal(f.head().activeOperation?.operationId, 'operation-a');
});

test('lost acknowledgement resumes exact reservation after caller restart without another write', async () => {
  const f = fixture(); f.loseAck();
  await assert.rejects(reserveRecoveryOperation(request, f.store), /unknown/);
  const retried = await reserveRecoveryOperation(structuredClone(request), f.store);
  assert.equal(retried.replayed, true);
  assert.equal(retried.actionAuthorized, false);
  assert.equal(f.writes(), 1);
  await assert.rejects(reserveRecoveryOperation({ ...request, preparationDigest: 'b'.repeat(64) }, f.store), /occupied/);
});

test('old writer cannot reserve after learning the replacement head; no implicit initialization', async () => {
  const f = fixture();
  f.head().writerId = 'host-b'; f.head().writerEpoch = 2;
  await assert.rejects(reserveRecoveryOperation(request, f.store), /writer/);
  assert.equal(f.writes(), 0);
  for (const invalid of [null, { ...f.head(), format: 1 }, { ...f.head(), expiresAt: '2099-01-01' }]) {
    await assert.rejects(reserveRecoveryOperation(request, { ...f.store,
      async readControl() { return invalid; } }), /control/);
  }
});

test('reservation refuses changed history, charity and a provider that claims a write without retaining it', async () => {
  const f = fixture();
  await assert.rejects(reserveRecoveryOperation({ ...request, organisationId: 'other' }, f.store), /binding/);
  await assert.rejects(reserveRecoveryOperation({ ...request, expectedGeneration: 1, expectedDigest: 'b'.repeat(64) }, f.store), /history/);
  await assert.rejects(reserveRecoveryOperation(request, { ...f.store,
    async compareAndSwapControl() { return true; } }), /not verified/);
  assert.equal(f.writes(), 0);
});
