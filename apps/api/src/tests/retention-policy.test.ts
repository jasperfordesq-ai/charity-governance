import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { RetentionPolicyService } from '../services/retention-policy.service.js';

const draft = { state: 'DRAFT', retentionMode: 'REVIEW_REQUIRED', retentionDays: null, recoveryDays: 30 };
const approved = { ...draft, state: 'APPROVED', authorityConfirmed: true, approvalEvidenceRef: 'POLICY-001' };
function fixture() {
  let rows: any[] = [];
  let withdrawals: any[] = [];
  let role = 'OWNER';
  let failCreate = false;
  const locks: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('statement_timestamp')) return [{ now: new Date('2026-09-30T12:00:00Z') }];
      locks.push(sql);
      if (sql.includes('SELECT p.id')) return rows.filter(row => row.organisationId === values[0]
        && row.state === 'APPROVED' && !withdrawals.some(w => w.policyId === row.id)).map(row => ({ id: row.id }));
      return [{ id: 'locked' }];
    },
    user: { findFirst: async ({ where }: any) => where.organisationId === 'org-a'
      && (typeof where.role === 'string' ? where.role === role : where.role.in.includes(role)) ? { id: 'actor-a' } : null },
    dataRetentionPolicyRevision: {
      findFirst: async ({ where }: any) => {
        const row = [...rows].reverse().find(row => row.organisationId === where.organisationId
          && (!where.id || row.id === where.id) && (!where.state || row.state === where.state));
        return row ? { ...row, withdrawal: withdrawals.find(w => w.policyId === row.id) ?? null } : null;
      },
      create: async ({ data }: any) => {
        if (failCreate) throw new Error('Write unavailable');
        const row = { id: `policy-${rows.length + 1}`, ...data }; rows.push(row); return row;
      },
    },
    dataRetentionPolicyWithdrawal: { create: async ({ data }: any) => {
      const row = { id: `withdrawal-${withdrawals.length + 1}`, ...data }; withdrawals.push(row); return row;
    } },
  };
  const prisma = { $transaction: async (callback: (tx: any) => Promise<unknown>) => {
    const savedRows = rows.slice(); const savedWithdrawals = withdrawals.slice();
    try { return await callback(tx); } catch (error) { rows = savedRows; withdrawals = savedWithdrawals; throw error; }
  } } as unknown as PrismaClient;
  return { service: new RetentionPolicyService(prisma), locks,
    get rows() { return rows; }, get withdrawals() { return withdrawals; },
    setRole: (next: string) => { role = next; }, fail: () => { failCreate = true; } };
}

test('policy revisions preserve draft facts; a new approval withdraws older approvals atomically', async () => {
  const f = fixture();
  await f.service.create('org-a', 'actor-a', draft);
  await f.service.create('org-a', 'actor-a', approved);
  await f.service.create('org-a', 'actor-a', { ...approved, recoveryDays: 45, approvalEvidenceRef: 'POLICY-002' });
  assert.deepEqual(f.rows.map(row => [row.revision, row.state, row.recoveryDays]), [[1, 'DRAFT', 30], [2, 'APPROVED', 30], [3, 'APPROVED', 45]]);
  assert.equal(f.rows[0].approvedById, undefined);
  assert.equal(f.withdrawals.length, 1);
  assert.equal(f.withdrawals[0].policyId, 'policy-2');
  assert.equal(f.withdrawals[0].evidenceRef, 'POLICY-002');
  assert.match(f.withdrawals[0].reason, /revision 3/);
  assert.ok(f.locks.some(sql => sql.includes('Organisation') && sql.includes('FOR UPDATE')));
  assert.ok(f.locks.some(sql => sql.includes('FOR UPDATE OF p')));
});

test('failed replacement approval does not leave the existing policy withdrawn', async () => {
  const f = fixture();
  await f.service.create('org-a', 'actor-a', approved);
  f.fail();
  await assert.rejects(f.service.create('org-a', 'actor-a', approved), /Write unavailable/);
  assert.equal(f.rows.length, 1);
  assert.equal(f.withdrawals.length, 0);
});

test('Admin may propose but cannot approve or withdraw; foreign actor and Member are refused', async () => {
  const f = fixture();
  await f.service.create('org-a', 'actor-a', approved);
  f.setRole('ADMIN');
  await f.service.create('org-a', 'actor-a', draft);
  await assert.rejects(f.service.create('org-a', 'actor-a', approved), (error: any) => error.statusCode === 403);
  await assert.rejects(f.service.withdraw('org-a', 'actor-a', 'policy-1', { evidenceRef: 'WITHDRAW-001', reason: 'Review revised disposal authority.' }),
    (error: any) => error.statusCode === 403);
  f.setRole('MEMBER');
  await assert.rejects(f.service.create('org-a', 'actor-a', draft), (error: any) => error.statusCode === 403);
  f.setRole('OWNER');
  await assert.rejects(f.service.create('foreign', 'actor-a', approved), (error: any) => error.statusCode === 403);
  assert.equal(f.rows.length, 2);
  assert.equal(f.withdrawals.length, 0);
});

test('withdrawal is scoped, evidence-bound and cannot be repeated or applied to a draft', async () => {
  const f = fixture();
  await f.service.create('org-a', 'actor-a', approved);
  const input = { evidenceRef: 'WITHDRAW-001', reason: 'Review revised disposal authority.' };
  await assert.rejects(f.service.withdraw('foreign', 'actor-a', 'policy-1', input), (error: any) => error.statusCode === 404);
  await f.service.withdraw('org-a', 'actor-a', 'policy-1', input);
  await assert.rejects(f.service.withdraw('org-a', 'actor-a', 'policy-1', input), (error: any) => error.statusCode === 409);
  await f.service.create('org-a', 'actor-a', draft);
  await assert.rejects(f.service.withdraw('org-a', 'actor-a', 'policy-2', input), (error: any) => error.statusCode === 404);
});

test('approval cannot omit authority or evidence, and periods cannot be silently inferred', async () => {
  const f = fixture();
  for (const input of [{ ...approved, authorityConfirmed: false }, { ...approved, approvalEvidenceRef: '' },
    { ...draft, recoveryDays: 0 }, { ...draft, retentionMode: 'AFTER_ANCHOR' },
    { ...draft, retentionDays: 30 }, { ...draft, recordClass: 'COMPLAINTS' }]) {
    await assert.rejects(f.service.create('org-a', 'actor-a', input));
  }
  assert.equal(f.rows.length, 0);
  assert.equal(f.locks.length, 0);
});
