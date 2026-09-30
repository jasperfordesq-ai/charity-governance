import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { complaintPreparationFixture } from './complaint-preparation-fixture.js';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { readCommittedComplaintOutcome } from '../services/complaint-recovery-outcome.js';

function fixture() {
  const facts = complaintPreparationFixture(), prepared = prepareComplaintRecoveryFacts(facts);
  const request = { organisationId: facts.organisationId, installationId: facts.installationId, operationId: facts.operationId };
  const row = { id: 'outcome', transactionId: 9007199254740993n, recordedAt: new Date('2026-09-30T20:00:01.000Z'),
    preparation: { id: 'preparation', ...request, writerEpoch: facts.writerEpoch,
      authorizationId: facts.authorization.id, actorUserId: facts.actorUserId, facts: prepared.body, factsDigest: prepared.digest },
    claim: { id: 'claim', organisationId: facts.organisationId, authorizationId: facts.authorization.id,
      complaintId: facts.complaint.id, actorUserId: facts.actorUserId, transactionId: 9007199254740993n,
      claimedAt: new Date('2026-09-30T20:00:00.000Z') } };
  let missing = false;
  const prisma = { complaintRecoveryOutcome: { async findFirst(input: { where: unknown }) {
    assert.deepEqual(input.where, { preparation: request }); return missing ? null : row;
  } } } as unknown as PrismaClient;
  return { row, read: () => readCommittedComplaintOutcome(prisma, request), missing: () => { missing = true; } };
}

test('committed outcome reader emits stable bounded evidence without copying preparation narratives', async () => {
  const f = fixture(), result = await f.read();
  assert.deepEqual(await f.read(), result);
  const facts = JSON.parse(result.body);
  assert.equal(facts.transactionId, '9007199254740993');
  assert.equal(facts.action, 'COMPLAINT_PRIMARY_PURGE_COMMITTED');
  assert.equal(facts.preparationSourceRevision, JSON.parse(f.row.preparation.facts).sourceRevision);
  assert.equal(facts.sourceRevision, undefined);
  assert.equal(result.actionAuthorized, false);
  assert.equal(facts.preparationDigest, f.row.preparation.factsDigest);
  assert.equal(result.body.includes('reason'), false);
  assert.equal(result.body.includes('dispositionPlan'), false);
});

test('committed outcome reader refuses absent, altered and mismatched evidence', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => f.missing(),
    (f: ReturnType<typeof fixture>) => { f.row.claim.transactionId++; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.organisationId = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.actorUserId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.claim.complaintId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.row.preparation.factsDigest = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.row.recordedAt = new Date('2000-01-01'); },
    (f: ReturnType<typeof fixture>) => { f.row.id = 'x'.repeat(161); },
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.read); }
});
