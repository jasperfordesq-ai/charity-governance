import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { prepareComplaintHoldRecoveryFacts } from '../services/complaint-hold-recovery-preparation.js';
import { prepareComplaintCancellationFacts, readCommittedComplaintCancellation } from '../services/complaint-recovery-cancellation.js';

function fixture() {
  const scope = { organisationId: 'charity', installationId: 'installation', operationId: 'operation' };
  const request = { ...scope, operationKind: 'HOLD' };
  const prepared = prepareComplaintHoldRecoveryFacts({ format: 1, action: 'COMPLAINT_HOLD_PREPARATION', ...scope,
    writerEpoch: 1, actorUserId: 'admin', sourceRevision: 'a'.repeat(40), preparedAt: '2026-09-30T12:00:00Z',
    complaint: { id: 'complaint', organisationId: 'charity', revision: 1 }, previousHold: null,
    decision: { id: 'hold', revision: 1, recordRevision: 1, actorUserId: 'admin', held: true,
      evidenceRef: 'HOLD-001', reason: 'Sensitive original preservation reason' } });
  const row = { id: 'cancel', primaryPreparationId: null, primaryPreparation: null,
    holdPreparationId: 'prepared', actorUserId: 'owner', writerId: 'host', reasonCode: 'OPERATOR_CANCELLED',
    evidenceRef: 'CANCEL-001', transactionId: 9007199254740993n, recordedAt: new Date('2026-09-30T12:00:01Z'),
    holdPreparation: { id: 'prepared', ...scope, writerEpoch: 1, actorUserId: 'admin', complaintId: 'complaint',
      facts: prepared.body, factsDigest: prepared.digest, recordedAt: new Date('2026-09-30T12:00:00Z'), outcome: null } };
  let missing = false;
  const prisma = { complaintRecoveryCancellation: { async findFirst(input: { where: unknown }) {
    assert.deepEqual(input.where, { holdPreparation: scope }); return missing ? null : row;
  } } } as unknown as PrismaClient;
  return { row, read: () => readCommittedComplaintCancellation(prisma, request), missing: () => { missing = true; } };
}

test('committed cancellation reader binds original facts without copying private narrative or granting authority', async () => {
  const f = fixture(), result = await f.read();
  assert.deepEqual(await f.read(), result); assert.equal(result.actionAuthorized, false);
  const facts = JSON.parse(result.body);
  assert.equal(facts.operationKind, 'HOLD'); assert.equal(facts.actorUserId, 'owner');
  assert.equal(facts.transactionId, '9007199254740993');
  assert.equal(facts.preparationDigest, f.row.holdPreparation.factsDigest);
  assert.doesNotMatch(result.body, /Sensitive original preservation reason/);
  assert.deepEqual(prepareComplaintCancellationFacts(facts), result);
  assert.throws(() => prepareComplaintCancellationFacts({ ...facts, reason: 'private text' }));
  assert.throws(() => prepareComplaintCancellationFacts({ ...facts, reasonCode: 'invented' }));
  assert.throws(() => prepareComplaintCancellationFacts({ ...facts, transactionId: '9223372036854775808' }));
});

test('cancellation reader refuses missing, substituted, contradictory and malformed committed evidence', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => f.missing(),
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparationId = 'wrong'; },
    (f: ReturnType<typeof fixture>) => { f.row.primaryPreparationId = 'also-primary' as never; },
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparation.outcome = { id: 'executed' } as never; },
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparation.factsDigest = 'b'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparation.organisationId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparation.writerEpoch++; },
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparation.actorUserId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparation.complaintId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.transactionId = 0n; },
    (f: ReturnType<typeof fixture>) => { f.row.recordedAt = new Date('2000-01-01'); },
    (f: ReturnType<typeof fixture>) => { f.row.recordedAt = new Date(NaN); },
    (f: ReturnType<typeof fixture>) => { f.row.holdPreparation.recordedAt = new Date(NaN); },
    (f: ReturnType<typeof fixture>) => { f.row.writerId = 'invalid writer'; },
    (f: ReturnType<typeof fixture>) => { f.row.evidenceRef = 'invalid'; },
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.read); }
});
