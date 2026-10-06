import assert from 'node:assert/strict';
import test from 'node:test';
import { ComplaintRetentionService } from '../services/complaint-retention.service.js';

test('complaint retention uses only the latest matching resolution and a single current class policy', async () => {
  const now = new Date('2026-09-30T12:00:00Z');
  let complaint: any = { id: 'complaint', revision: 4, status: 'CLOSED', receivedDate: new Date('2026-01-01') };
  let evidence: any = { id: 'evidence', revision: 3, recordRevision: 4, state: 'RECORDED', resolvedAt: new Date('2026-09-20T12:00:00Z') };
  let policies: any[] = [];
  let held = false;
  let enforced = false;
  const policy = { id: 'policy', retentionMode: 'AFTER_ANCHOR', retentionAnchor: 'RESOLVED_AT', retentionDays: 10 };
  const tx = {
    complaintHoldEvent: { findFirst: async () => ({ held }) },
    $queryRaw: async (strings: TemplateStringsArray) => strings.join('').includes('statement_timestamp') ? [{ now }] : [{ id: 'org' }],
    complaintRecord: { findFirst: async ({ where }: any) => { assert.deepEqual(where, { id: 'complaint', organisationId: 'org', removedAt: null }); return complaint; } },
    complaintResolutionEvidence: { findFirst: async ({ where, orderBy }: any) => {
      assert.deepEqual(where, { organisationId: 'org', complaintId: 'complaint' });
      assert.deepEqual(orderBy, { revision: 'desc' }); return evidence;
    } },
    dataRetentionPolicyRevision: { findMany: async ({ where, take }: any) => {
      assert.deepEqual(where, { organisationId: 'org', recordClass: 'COMPLAINT', state: 'APPROVED', withdrawal: { is: null } });
      assert.equal(take, 2); return policies;
    } },
    complaintRecoveryEnforcement: { findUnique: async () => enforced ? { id: 'binding' } : null },
  };
  const service = new ComplaintRetentionService({ $transaction: async (callback: (tx: any) => unknown) => callback(tx) } as never);
  const state = async () => { const result = await service.assess('org', 'complaint'); assert.equal(result.removalAuthorized, false); return result; };
  assert.equal((await state()).state, 'POLICY_REVIEW_REQUIRED');
  policies = [policy, policy];
  assert.equal((await state()).state, 'POLICY_REVIEW_REQUIRED');
  policies = [policy];
  const elapsed = await state();
  assert.equal(elapsed.state, 'READY_FOR_REMOVAL_REVIEW');
  assert.equal(elapsed.retentionUntil?.getTime(), now.getTime());
  enforced = true;
  assert.equal((await state()).state, 'INDEPENDENT_RECOVERY_REQUIRED');
  enforced = false;
  policy.retentionDays = 11;
  assert.equal((await state()).state, 'RETENTION_NOT_REACHED');
  policy.retentionAnchor = 'CREATED_AT';
  assert.equal((await state()).state, 'POLICY_REVIEW_REQUIRED');
  policy.retentionAnchor = 'RESOLVED_AT';
  evidence.state = 'WITHDRAWN';
  assert.equal((await state()).state, 'RESOLUTION_REVIEW_REQUIRED');
  evidence.state = 'RECORDED'; evidence.recordRevision = 3;
  assert.equal((await state()).state, 'RESOLUTION_REVIEW_REQUIRED');
  evidence.recordRevision = 4; evidence.resolvedAt = new Date('2999-01-01');
  assert.equal((await state()).state, 'RESOLUTION_REVIEW_REQUIRED');
  evidence = null;
  assert.equal((await state()).state, 'RESOLUTION_REVIEW_REQUIRED');
  complaint.status = 'OPEN';
  assert.equal((await state()).state, 'COMPLAINT_OPEN');
  policy.retentionMode = 'PERMANENT';
  assert.equal((await state()).state, 'PERMANENT_RETENTION');
  policy.retentionMode = 'REVIEW_REQUIRED'; complaint.status = 'CLOSED';
  assert.equal((await state()).state, 'INDIVIDUAL_REVIEW_REQUIRED');
  enforced = true;
  assert.equal((await state()).state, 'INDEPENDENT_RECOVERY_REQUIRED');
  enforced = false;
  held = true;
  assert.equal((await state()).state, 'ADMINISTRATIVE_HOLD');
  complaint = null;
  await assert.rejects(service.assess('org', 'complaint'), /not found/);
});
