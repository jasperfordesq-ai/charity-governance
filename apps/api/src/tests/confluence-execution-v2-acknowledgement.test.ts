import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedExecutionV2Fixture } from './fixtures/published-confluence-execution-v2.js';
import { acknowledgeConfluenceExecutionV2Archive } from '../services/confluence-execution-v2-acknowledgement.js';
import { reserveRecoveryOperation } from '../services/recovery-operation-reservation.js';

async function fixture() {
  const f = await publishedExecutionV2Fixture(); await f.reserve(); await f.publish();
  const state = { writes: 0, loseAck: false, noWrite: false, mutateWriter: false, peerCleared: false };
  const control = { ...f.control,
    releaseConfluenceExecutionV2Control: async (revision: string, expected: {
      operationId: string; preparationDigest: string; generation: number; digest: string; envelopeDigest: string }) => {
      if (revision !== f.state.current.revision || state.noWrite) return false;
      assert.equal(expected.operationId,f.binding.context.operationId); assert.equal(expected.preparationDigest,f.prepared.digest);
      assert.equal(expected.generation,f.state.current.generation); assert.equal(expected.digest,f.state.current.digest);
      assert.equal(expected.envelopeDigest,f.original.digest);
      state.writes++; f.state.current = { ...f.state.current, activeOperation: null, revision: `acknowledgement-${state.writes}` };
      if (state.mutateWriter) f.state.current.writerId = 'unexpected-writer';
      if (state.loseAck) { state.loseAck = false; throw new Error('Synthetic committed acknowledgement loss'); }
      return !state.peerCleared;
    } };
  const acknowledge = (digest = f.prepared.digest) => acknowledgeConfluenceExecutionV2Archive(
    f.journal,control,digest,f.binding,f.keys,f.objects,f.policy);
  return { f, state, control, acknowledge };
}

test('exact verified archive acknowledgement clears only its slot and permits a later reservation', async () => {
  const h = await fixture(), before = { ...h.f.state.current }, result = await h.acknowledge();
  assert.equal(result.acknowledged,true); assert.equal(result.replayed,false);
  assert.equal(result.currentHistoryVerified,false); assert.equal(result.reopeningAuthorised,false); assert.equal(result.actionAuthorized,false);
  assert.equal(h.f.state.current.activeOperation,null);
  const { revision: _oldRevision, activeOperation: _oldSlot, ...identity } = before;
  const { revision: _newRevision, activeOperation: _newSlot, ...afterIdentity } = h.f.state.current;
  assert.deepEqual(afterIdentity,identity); assert.equal(h.state.writes,1);
  assert.equal((await h.acknowledge()).replayed,true); assert.equal(h.state.writes,1);
  await reserveRecoveryOperation({ installationId: before.installationId, organisationId: before.organisationId,
    writerId: before.writerId, writerEpoch: before.writerEpoch, operationId: 'later-archive', preparationDigest: 'f'.repeat(64),
    expectedGeneration: before.generation, expectedDigest: before.digest },h.control);
  assert.equal((await h.control.readControl()).activeOperation?.operationId,'later-archive');
});

test('lost acknowledgement retries the original verified archive without a second write', async () => {
  const h = await fixture(); h.state.loseAck = true;
  await assert.rejects(h.acknowledge,/unknown/); assert.equal(h.f.state.current.activeOperation,null);
  assert.equal((await h.acknowledge()).replayed,true); assert.equal(h.state.writes,1);
});

for (const scenario of ['wrong-facts','other-slot','other-writer','other-epoch','missing','racing-control'] as const) {
  test(`acknowledgement refuses ${scenario} before clearing any slot`, async () => {
    const h = await fixture();
    if (scenario === 'other-slot') h.f.state.current.activeOperation!.operationId = 'other-operation';
    if (scenario === 'other-writer') h.f.state.current.writerId = 'other-writer';
    if (scenario === 'other-epoch') h.f.state.current.writerEpoch++;
    if (scenario === 'missing') h.f.replace(null);
    if (scenario === 'racing-control') h.f.state.mutateWhileOpen = true;
    await assert.rejects(() => h.acknowledge(scenario === 'wrong-facts' ? 'f'.repeat(64) : undefined));
    assert.equal(h.state.writes,0); assert.notEqual(h.f.state.current.activeOperation,null);
  });
}

test('a null-slot retry still authenticates the archive and cannot clear a newly acquired operation', async () => {
  const h = await fixture(); await h.acknowledge();
  await assert.rejects(() => h.acknowledge('f'.repeat(64))); assert.equal(h.state.writes,1);
  h.f.replace(null);
  await assert.rejects(h.acknowledge); assert.equal(h.state.writes,1);
  h.f.replace(h.f.original.envelope);
  h.f.state.current.activeOperation = { operationId: 'new-operation', preparationDigest: 'a'.repeat(64) };
  await assert.rejects(h.acknowledge); assert.equal(h.f.state.current.activeOperation.operationId,'new-operation');
  assert.equal(h.state.writes,1);
});

test('pending publication is never acknowledged as a completed archive', async () => {
  const h = await fixture();
  h.f.state.current = { ...h.f.state.current, generation: 0, digest: null, revision: 'synthetic-pending-head' };
  await assert.rejects(h.acknowledge); assert.equal(h.state.writes,0); assert.notEqual(h.f.state.current.activeOperation,null);
});

test('a concurrent exact acknowledgement is recognised only by unchanged identity and verified empty-slot readback', async () => {
  const h = await fixture(); h.state.peerCleared = true;
  const result = await h.acknowledge(); assert.equal(result.acknowledged,true); assert.equal(result.replayed,true);
  assert.equal(result.actionAuthorized,false); assert.equal(h.f.state.current.activeOperation,null);
});

test('failed conditional clear and altered readback are never reported as acknowledgement success', async () => {
  const noWrite = await fixture(); noWrite.state.noWrite = true;
  await assert.rejects(noWrite.acknowledge,/verified|unresolved/); assert.notEqual(noWrite.f.state.current.activeOperation,null);
  const changed = await fixture(); changed.state.mutateWriter = true;
  await assert.rejects(changed.acknowledge,/verified|unresolved/);
});
