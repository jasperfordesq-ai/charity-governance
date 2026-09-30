import assert from 'node:assert/strict';
import test from 'node:test';
import { ComplaintRecoveryService } from '../services/complaint-recovery.service.js';

function fixture() {
  const now = new Date('2026-09-30T12:00:00Z');
  const f = {
    actor: true,
    row: { id: 'complaint', organisationId: 'org', revision: 4, status: 'CLOSED', summary: 'Private complaint narrative',
      reviewedByBoard: false, boardMinuteReference: null, removedAt: null, removal: null } as any,
    policies: [{ id: 'policy', retentionMode: 'AFTER_ANCHOR', retentionAnchor: 'RESOLVED_AT', retentionDays: 1 }] as any[],
    evidence: { id: 'evidence', revision: 2, recordRevision: 4, state: 'RECORDED', resolvedAt: new Date('2026-09-01') } as any,
    decisions: [] as any[], audits: [] as any[], writes: 0,
  };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => strings.join('').includes('statement_timestamp') ? [{ now }] : [{ id: 'locked' }],
    user: { findFirst: async ({ where }: any) => {
      assert.deepEqual(where, { id: 'actor', organisationId: 'org', lifecycleStatus: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } });
      return f.actor ? { id: 'actor' } : null;
    } },
    complaintRecord: {
      findFirst: async ({ where }: any) => {
        assert.equal(where.organisationId, 'org'); assert.equal(where.id, 'complaint');
        return f.row;
      },
      update: async ({ where, data }: any) => {
        assert.deepEqual(where, { id: 'complaint', organisationId: 'org' });
        f.writes++; f.row = { ...f.row, ...data, revision: f.row.revision + 1,
          removal: data.removalId ? f.decisions.find(row => row.id === data.removalId) : null };
        return f.row;
      },
    },
    dataRetentionPolicyRevision: { findMany: async ({ where }: any) => {
      assert.deepEqual(where, { organisationId: 'org', recordClass: 'COMPLAINT', state: 'APPROVED', withdrawal: { is: null } });
      return f.policies;
    } },
    complaintResolutionEvidence: { findFirst: async () => f.evidence },
    complaintRemoval: { create: async ({ data }: any) => {
      const decision = { id: 'removal', ...data, occurredAt: now, recoveryUntil: new Date('2026-10-30T12:00:00Z') };
      f.decisions.push(decision); return decision;
    } },
    governanceRegisterChangeAudit: { create: async ({ data }: any) => { f.audits.push(data); return data; } },
  };
  return { f, service: new ComplaintRecoveryService({ $transaction: async (work: (value: any) => unknown) => work(tx) } as never) };
}
const input = { organisationId: 'org', complaintId: 'complaint', actorUserId: 'actor', expectedRevision: 4,
  expectedEvidenceRevision: 2, policyId: 'policy', evidenceRef: 'REMOVAL-001', reason: 'Reviewed controlled removal authority' };

test('complaint removal and restoration preserve content and record the actor without copying narratives', async () => {
  const { service, f } = fixture();
  await service.remove(input);
  assert.equal(f.row.removalId, 'removal');
  assert.equal(f.decisions[0].resolutionEvidenceId, 'evidence');
  assert.equal(f.decisions[0].recordRevision, 4);
  await service.restore({ ...input, expectedRevision: 5 });
  assert.equal(f.row.removedAt, null); assert.equal(f.row.removalId, null);
  assert.equal(f.row.summary, 'Private complaint narrative');
  assert.deepEqual(f.audits.map(row => [row.actorUserId, row.previousStatus, row.nextStatus]), [
    ['actor', 'ACTIVE', 'RECOVERABLE'], ['actor', 'RECOVERABLE', 'ACTIVE'],
  ]);
  assert.doesNotMatch(JSON.stringify(f.audits), /Private complaint narrative|Reviewed controlled removal authority/);
});

test('complaint recovery refuses missing authority, stale revisions, board evidence and expired recovery', async () => {
  for (const change of [
    (f: any) => { f.actor = false; },
    (f: any) => { f.row = null; },
    (f: any) => { f.row.revision++; },
    (f: any) => { f.row.reviewedByBoard = true; },
    (f: any) => { f.row.status = 'OPEN'; },
    (f: any) => { f.policies = []; },
    (f: any) => { f.policies.push(f.policies[0]); },
    (f: any) => { f.policies[0].retentionMode = 'PERMANENT'; },
    (f: any) => { f.policies[0].retentionDays = null; },
    (f: any) => { f.policies[0].retentionAnchor = null; },
    (f: any) => { f.evidence.revision++; },
    (f: any) => { f.evidence.recordRevision--; },
    (f: any) => { f.evidence.state = 'WITHDRAWN'; },
    (f: any) => { f.evidence.resolvedAt = new Date('2999-01-01'); },
  ]) {
    const { service, f } = fixture(); change(f);
    await assert.rejects(service.remove(input));
    assert.equal(f.writes, 0); assert.equal(f.decisions.length, 0); assert.equal(f.audits.length, 0);
  }
  const { service, f } = fixture();
  f.row.removedAt = new Date('2026-08-01');
  f.row.removal = { recoveryUntil: new Date('2026-09-30T12:00:00Z') };
  await assert.rejects(service.restore(input), /recovery window has expired/);
  assert.equal(f.writes, 0); assert.equal(f.audits.length, 0);
});
