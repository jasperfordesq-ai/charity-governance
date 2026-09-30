import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { prepareComplaintHoldRecoveryFacts } from '../services/complaint-hold-recovery-preparation.js';
import { readCommittedComplaintHoldOutcome } from '../services/complaint-hold-recovery-outcome.js';

function fixture() {
  const request = { organisationId: 'charity', installationId: 'installation', operationId: 'operation' };
  const decision = { id: 'hold', revision: 1, recordRevision: 2, actorUserId: 'admin', held: true,
    evidenceRef: 'EVIDENCE-001', reason: 'Private preservation reasoning' };
  const facts = { format: 1, action: 'COMPLAINT_HOLD_PREPARATION', ...request, writerEpoch: 1,
    actorUserId: 'admin', sourceRevision: 'a'.repeat(40), preparedAt: '2026-09-30T12:00:00.000Z',
    complaint: { id: 'complaint', organisationId: 'charity', revision: 2 }, previousHold: null, decision };
  const prepared = prepareComplaintHoldRecoveryFacts(facts);
  const row = { id: 'outcome', preparationId: 'preparation', holdEventId: 'hold', transactionId: 9007199254740993n,
    recordedAt: new Date('2026-09-30T12:00:02.000Z'),
    preparation: { id: 'preparation', ...request, complaintId: 'complaint', actorUserId: 'admin', writerEpoch: 1,
      facts: prepared.body, factsDigest: prepared.digest },
    holdEvent: { ...decision, organisationId: 'charity', complaintId: 'complaint', occurredAt: new Date('2026-09-30T12:00:01.000Z') } };
  let missing = false;
  const prisma = { complaintHoldRecoveryOutcome: { async findFirst(input: { where: unknown }) {
    assert.deepEqual(input.where, { preparation: request }); return missing ? null : row;
  } } } as unknown as PrismaClient;
  return { row, read: () => readCommittedComplaintHoldOutcome(prisma, request), missing: () => { missing = true; } };
}

test('hold outcome reader returns minimal stable committed evidence without an action permit', async () => {
  const f = fixture(), result = await f.read();
  assert.deepEqual(await f.read(), result);
  assert.equal(result.actionAuthorized, false);
  const facts = JSON.parse(result.body);
  assert.equal(facts.transactionId, '9007199254740993');
  assert.equal(facts.held, true);
  assert.equal(facts.action, 'COMPLAINT_HOLD_COMMITTED');
  assert.equal(result.body.includes(f.row.holdEvent.reason), false);
  assert.equal(result.body.includes(f.row.holdEvent.evidenceRef), false);
});

test('hold outcome reader refuses missing, substituted, foreign and inconsistent evidence', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => f.missing(),
    (f: ReturnType<typeof fixture>) => { f.row.preparation.factsDigest = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.row.holdEvent.organisationId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.holdEvent.actorUserId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.holdEvent.reason = 'Substituted preservation reason'; },
    (f: ReturnType<typeof fixture>) => { f.row.holdEvent.evidenceRef = 'OTHER-001'; },
    (f: ReturnType<typeof fixture>) => { f.row.holdEvent.held = false; },
    (f: ReturnType<typeof fixture>) => { f.row.holdEvent.revision++; },
    (f: ReturnType<typeof fixture>) => { f.row.preparation.writerEpoch++; },
    (f: ReturnType<typeof fixture>) => { f.row.preparationId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.transactionId = 0n; },
    (f: ReturnType<typeof fixture>) => { f.row.recordedAt = new Date('2000-01-01'); },
    (f: ReturnType<typeof fixture>) => { f.row.holdEvent.occurredAt = new Date(NaN); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(f.read); }
});
