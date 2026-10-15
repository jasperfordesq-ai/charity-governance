import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConfluenceCopyReconciliationPlan, inspectConfluenceCopyReconciliation } from '../services/confluence-copy-reconciliation.js';
import { fixture } from './fixtures/confluence-copy-decision-history.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';

function rows(facts: Awaited<ReturnType<typeof fixture>>['values'][number]) {
  return structuredClone({ reviews: [facts.review], scopes: [facts.scope], permissions: [facts.permission],
    reviewWithdrawals: facts.reviewWithdrawal ? [facts.reviewWithdrawal] : [],
    permissionWithdrawals: facts.permissionWithdrawal ? [facts.permissionWithdrawal] : [] });
}
const empty = () => ({ reviews: [], scopes: [], permissions: [], reviewWithdrawals: [], permissionWithdrawals: [] });

test('older database requires both later withdrawals, never a new permission or deletion', async () => {
  const f = await fixture(), history = await f.read();
  const plan = buildConfluenceCopyReconciliationPlan('org-a',history,rows(f.values[0]!));
  assert.deepEqual(plan.inserts.map(row => row.table),['reviewWithdrawals','permissionWithdrawals']);
  assert.equal(plan.matchingRecords,3); assert.equal(plan.requiresReplay,true);
  assert.equal(plan.actionAuthorized,false); assert.equal(plan.currentHistoryVerified,false); assert.equal(plan.reopeningAuthorised,false);
  assert.deepEqual(plan,buildConfluenceCopyReconciliationPlan('org-a',history,rows(f.values[0]!)));
});

test('blank decisions propose complete dependency order; exact latest database requires no replay', async () => {
  const f = await fixture(), history = await f.read();
  const blank = buildConfluenceCopyReconciliationPlan('org-a',history,empty());
  assert.deepEqual(blank.inserts.map(row => row.table),['reviews','scopes','permissions','reviewWithdrawals','permissionWithdrawals']);
  const current = buildConfluenceCopyReconciliationPlan('org-a',history,rows(f.values[1]!));
  assert.equal(current.requiresReplay,false); assert.equal(current.matchingRecords,5);
  assert.equal(current.reopeningAuthorised,false);
});

test('unknown local withdrawal, immutable conflict, duplicate ID and foreign row refuse without a partial plan', async () => {
  const f = await fixture(), history = await f.read();
  const unknown = rows(f.values[1]!); unknown.permissionWithdrawals[0]!.id = 'unpublished-local-withdrawal';
  await assert.rejects(async () => buildConfluenceCopyReconciliationPlan('org-a',history,unknown), /absent from independent/);
  const conflicting = rows(structuredClone(f.values[1]!)); conflicting.permissions[0]!.evidenceRef = 'OTHER-EVIDENCE';
  assert.throws(() => buildConfluenceCopyReconciliationPlan('org-a',history,conflicting), /contradicts immutable/);
  const duplicate = rows(f.values[0]!); duplicate.reviews.push(duplicate.reviews[0]!);
  assert.throws(() => buildConfluenceCopyReconciliationPlan('org-a',history,duplicate), /scope or identity/);
  const foreign = rows(structuredClone(f.values[0]!)); foreign.reviews[0]!.organisationId = 'org-b';
  assert.throws(() => buildConfluenceCopyReconciliationPlan('org-a',history,foreign), /scope or identity/);
});

test('record object-key order is immaterial but extra fields are never silently dropped', async () => {
  const f = await fixture(), history = await f.read(); const local = rows(f.values[1]!);
  const reordered = JSON.parse(JSON.stringify(local),(_key,value) => value && !Array.isArray(value) && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal(buildConfluenceCopyReconciliationPlan('org-a',history,reordered).requiresReplay,false);
  const extra = rows(structuredClone(f.values[1]!)); Object.assign(extra.permissions[0]!,{ unexpected: 'private-extra' });
  assert.throws(() => buildConfluenceCopyReconciliationPlan('org-a',history,extra), /contradicts immutable/);
});

async function inspectorFixture() {
  const f = await fixture(); const state = { owner: true, active: true, snapshot: rows(structuredClone(f.values[0]!)),
    excessive: false, materialisations: 0, loads: 0 };
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      if (!query.join('?').includes('AS kind')) return [];
      state.loads++;
      return Object.entries(state.snapshot).map(([kind,value]) => ({ kind, count: state.excessive ? 10001n : BigInt(value.length),
        bytes: BigInt(Buffer.byteLength(JSON.stringify(value))) }));
    },
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => state.active ? { id: 'org-a' } : null },
    confluenceRetainedCopyReview: { findMany: async () => { state.materialisations++; return structuredClone(state.snapshot.reviews); } },
    confluenceSyntheticCopyScope: { findMany: async () => structuredClone(state.snapshot.scopes) },
    confluenceRetainedCopyPermission: { findMany: async () => structuredClone(state.snapshot.permissions) },
    confluenceRetainedCopyReviewWithdrawal: { findMany: async () => structuredClone(state.snapshot.reviewWithdrawals) },
    confluenceRetainedCopyPermissionWithdrawal: { findMany: async () => structuredClone(state.snapshot.permissionWithdrawals) },
  };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) };
  const deps = { journal: f.journal, control: f.control, keys: f.keys,
    objects: { readConfluenceCopyState: async (id: string) => f.objects.get(id) ?? null } };
  const inspect = () => inspectConfluenceCopyReconciliation(prisma as never,'org-a','owner-a',deps,[context.keyId]);
  return { f, state, deps, inspect };
}

test('inspection reads scoped SQL snapshots around authenticated history and emits an insert-only proposal', async () => {
  const h = await inspectorFixture(), plan = await h.inspect();
  assert.equal(plan.inserts.length,2); assert.equal(h.state.loads,2); assert.equal(h.state.materialisations,2);
  assert.equal(plan.actionAuthorized,false);
});

test('over-capacity SQL budget refuses before materialising review JSON', async () => {
  const h = await inspectorFixture(); h.state.excessive = true;
  await assert.rejects(h.inspect, /bounded reconciliation capacity/); assert.equal(h.state.materialisations,0);
});

test('changing local decisions or losing active Owner during remote verification refuses inspection', async () => {
  for (const change of ['local','owner','charity'] as const) {
    const h = await inspectorFixture(), unwrap = h.deps.keys.unwrap;
    h.deps.keys.unwrap = async (...args) => {
      const result = await unwrap(...args);
      if (change === 'local') h.state.snapshot = rows(structuredClone(h.f.values[1]!));
      if (change === 'owner') h.state.owner = false;
      if (change === 'charity') h.state.active = false;
      return result;
    };
    await assert.rejects(h.inspect, /changed during independent|requires active/);
  }
});
