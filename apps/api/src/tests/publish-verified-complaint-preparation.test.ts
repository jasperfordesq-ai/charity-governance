import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { complaintPreparationFixture } from './complaint-preparation-fixture.js';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { sealRecoveryPreparation, type RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { type RecoveryControlValue } from '../services/recovery-operation-reservation.js';
import { publishVerifiedComplaintPreparation } from '../services/publish-verified-complaint-preparation.js';
import { publishVerifiedComplaintOutcome } from '../services/publish-verified-complaint-outcome.js';
import { prepareComplaintOutcomeFacts } from '../services/complaint-recovery-outcome.js';
import { sealRecoveryOutcome } from '../services/recovery-outcome-envelope.js';
import { readPublishedComplaintOutcome } from '../services/published-complaint-outcome.js';
import { releaseCommittedComplaintOperation } from '../services/release-complaint-recovery-operation.js';
import type { PrismaClient } from '@prisma/client';

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
  return { rows, keys, request, current: () => current, candidate, journal, control, context, facts,
    readReplay: async () => envelope,
    loseAck: () => { loseAck = true; },
    replaceWithEquivalent: async () => { envelope = (await sealRecoveryPreparation(body, context, keys)).envelope; },
    replace: (value: string | null) => { envelope = value; },
    changeControl: () => { current = { ...current, revision: 'external-change' }; },
    publish: () => publishVerifiedComplaintPreparation(journal, control, request, context, keys,
      { async readReplay() { return envelope; } }) };
}

test('verified outcome publication joins both envelopes and keeps the operation reserved', async () => {
  for (const scenario of ['valid', 'foreign-claim', 'missing-preparation', 'changed-control']) {
    const f = await fixture(), preparation = await f.publish();
    const body = prepareComplaintOutcomeFacts({ format: 1, action: 'COMPLAINT_PRIMARY_PURGE_COMMITTED',
      organisationId: f.context.organisationId, installationId: f.context.installationId, operationId: f.context.operationId,
      writerEpoch: f.context.writerEpoch, preparationSourceRevision: f.context.sourceRevision,
      preparationId: 'prepared', preparationDigest: f.request.preparationDigest, outcomeId: 'outcome', claimId: 'claim',
      authorizationId: f.facts.authorization.id, complaintId: scenario === 'foreign-claim' ? 'other' : f.facts.complaint.id,
      actorUserId: f.facts.actorUserId, transactionId: '123', claimedAt: '2026-09-30T20:00:00.000Z', recordedAt: '2026-09-30T20:00:01.000Z' }).body;
    const outcome = await sealRecoveryOutcome(body, f.context, f.keys);
    if (scenario === 'missing-preparation') f.replace(null);
    if (scenario === 'changed-control') {
      const unwrap = f.keys.unwrap;
      f.keys.unwrap = async (...args) => { const value = await unwrap(...args); f.changeControl(); return value; };
    }
    const publish = () => publishVerifiedComplaintOutcome(f.journal, f.control, {
      writerId: f.request.writerId, preparationDigest: f.request.preparationDigest,
      preparationGeneration: preparation.generation, preparationEntryDigest: preparation.digest,
      preparationEnvelopeDigest: f.candidate.digest }, f.context, f.keys,
      { readReplay: f.readReplay, async readOutcome() { return outcome.envelope; } });
    if (scenario !== 'valid') {
      await assert.rejects(publish); assert.equal(f.rows.size, 1); continue;
    }
    f.loseAck(); await assert.rejects(publish, /unknown/);
    const bytes = [...f.rows.values()];
    assert.equal((await publish()).replayed, true);
    assert.equal(f.current().generation, 2);
    assert.equal(f.current().activeOperation?.operationId, f.context.operationId);
    assert.equal(JSON.parse(bytes[1]!).factsDigest, outcome.digest);
    assert.deepEqual([...f.rows.values()], bytes);
    const source = { async readHead() { const v = f.current(); return { installationId: v.installationId,
      organisationId: v.organisationId, generation: v.generation, digest: v.digest, revision: v.revision }; } };
    const objects = { readReplay: f.readReplay, async readOutcome() { return outcome.envelope; } };
    const read = () => readPublishedComplaintOutcome(f.journal, source, f.context, f.keys, objects);
    assert.equal((await read()).body, body);
    assert.equal((await read()).actionAuthorized, false);
    let hasLocalOutcome = false, localClaimId = 'claim';
    const prisma = { complaintRecoveryOutcome: { async findFirst() { return hasLocalOutcome ? {
      id: 'outcome', transactionId: 123n, recordedAt: new Date('2026-09-30T20:00:01Z'),
      preparation: { id: 'prepared', organisationId: f.context.organisationId, installationId: f.context.installationId,
        operationId: f.context.operationId, writerEpoch: f.context.writerEpoch, authorizationId: f.facts.authorization.id,
        actorUserId: f.facts.actorUserId, facts: prepareComplaintRecoveryFacts(f.facts).body, factsDigest: f.request.preparationDigest },
      claim: { id: localClaimId, organisationId: f.context.organisationId, authorizationId: f.facts.authorization.id,
        complaintId: f.facts.complaint.id, actorUserId: f.facts.actorUserId, transactionId: 123n,
        claimedAt: new Date('2026-09-30T20:00:00Z') },
    } : null; } } } as unknown as PrismaClient;
    const releaseStore = { ...f.control, async releaseControl(revision: string) {
      const { revision: _revision, ...value } = f.current();
      return f.control.compareAndSwapControl(revision, { ...value, activeOperation: null });
    } };
    const release = () => releaseCommittedComplaintOperation(prisma, f.journal, releaseStore,
      f.request.writerId, f.context, f.keys, objects);
    await assert.rejects(release, /unavailable/);
    assert.notEqual(f.current().activeOperation, null);
    hasLocalOutcome = true;
    localClaimId = 'different-committed-claim';
    await assert.rejects(release, /evidence does not match/);
    assert.notEqual(f.current().activeOperation, null); localClaimId = 'claim';
    f.loseAck(); await assert.rejects(release, /unknown/);
    assert.equal(f.current().activeOperation, null);
    assert.deepEqual(await release(), { released: true, replayed: true, actionAuthorized: false });
    f.current().activeOperation = { operationId: 'new-operation', preparationDigest: 'b'.repeat(64) };
    await assert.rejects(release, /writer or operation/); f.current().activeOperation = null;
    await assert.rejects(() => releaseCommittedComplaintOperation(prisma, f.journal, releaseStore,
      'old-writer', f.context, f.keys, objects), /writer or operation/);
    const unwrap = f.keys.unwrap;
    f.keys.unwrap = async (...args) => { const value = await unwrap(...args); f.changeControl(); return value; };
    await assert.rejects(read, /changed while reading/);
    f.keys.unwrap = unwrap;
    f.replace(null); await assert.rejects(read, /unresolved/);
  }
});

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
