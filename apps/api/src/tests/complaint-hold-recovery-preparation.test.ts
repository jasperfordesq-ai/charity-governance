import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareComplaintHoldRecoveryFacts } from '../services/complaint-hold-recovery-preparation.js';

const sample = () => ({ format: 1, action: 'COMPLAINT_HOLD_PREPARATION', installationId: 'installation',
  organisationId: 'charity', operationId: 'operation', writerEpoch: 1, actorUserId: 'admin',
  sourceRevision: 'a'.repeat(40), preparedAt: '2026-09-30T12:00:00.000Z',
  complaint: { id: 'complaint', organisationId: 'charity', revision: 2 }, previousHold: null as null | {
    id: string; organisationId: string; complaintId: string; revision: number; recordRevision: number;
    actorUserId: string; held: boolean; evidenceRef: string; reason: string; occurredAt: string;
  }, decision: { id: 'new-hold', revision: 1, recordRevision: 2, actorUserId: 'admin', held: true,
    evidenceRef: 'HOLD-001', reason: 'Reviewed synthetic preservation request' } });

test('hold preparation is canonical, bounded and grants no action', () => {
  const value = sample();
  const result = prepareComplaintHoldRecoveryFacts(value);
  assert.deepEqual(prepareComplaintHoldRecoveryFacts(Object.fromEntries(Object.entries(value).reverse())), result);
  assert.equal(result.actionAuthorized, false);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(result.body) < 8192);
});

test('hold preparation refuses foreign scope, actor and revision mismatches', () => {
  for (const alter of [
    (v: ReturnType<typeof sample>) => { v.complaint.organisationId = 'other'; },
    (v: ReturnType<typeof sample>) => { v.decision.actorUserId = 'other'; },
    (v: ReturnType<typeof sample>) => { v.decision.recordRevision = 3; },
    (v: ReturnType<typeof sample>) => { v.decision.revision = 2; },
    (v: ReturnType<typeof sample>) => { v.decision.held = false; },
  ]) {
    const value = sample(); alter(value);
    assert.throws(() => prepareComplaintHoldRecoveryFacts(value), /^Error: Invalid complaint hold recovery preparation$/);
  }
});

test('hold release preserves original decision text and requires alternating exact predecessor', () => {
  const value = sample();
  value.previousHold = { ...value.decision, id: 'previous', organisationId: 'charity', complaintId: 'complaint',
    reason: '  Original preservation evidence  ', occurredAt: '2026-09-29T12:00:00.000Z' };
  value.decision.revision = 2; value.decision.held = false;
  assert.equal(JSON.parse(prepareComplaintHoldRecoveryFacts(value).body).previousHold.reason, value.previousHold.reason);
  value.previousHold.complaintId = 'other';
  assert.throws(() => prepareComplaintHoldRecoveryFacts(value), /Invalid/);
});

test('hold preparation refuses subject content and reports validation generically', () => {
  const value = sample();
  for (const candidate of [{ ...value, narrative: 'SENSITIVE_SENTINEL' },
    { ...value, complaint: { ...value.complaint, summary: 'SENSITIVE_SENTINEL' } },
    { ...value, decision: { ...value.decision, reason: 'SENSITIVE_SENTINEL'.repeat(100) } }]) {
    assert.throws(() => prepareComplaintHoldRecoveryFacts(candidate), error => {
      assert.equal((error as Error).message, 'Invalid complaint hold recovery preparation'); return true;
    });
  }
});
