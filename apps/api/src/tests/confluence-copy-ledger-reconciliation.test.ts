import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConfluenceCopyLedgerReconciliationPlan, inspectConfluenceCopyLedgerReconciliation } from '../services/confluence-copy-ledger-reconciliation.js';
import { ledgerFixture } from './fixtures/confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { CONFLUENCE_COPY_LEDGER_TABLES as names } from '../services/confluence-copy-ledger-snapshot.js';
import { publishedLedgerFixture } from './fixtures/published-confluence-copy-ledger.js';
import { prepareConfluenceCopyLocalLedger } from '../services/confluence-copy-ledger-snapshot.js';
import { sealConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';

function fixture() {
  const f = ledgerFixture();
  const archive = { body: f.body(), archiveAtObservedHead: true as const, ledgerRowsVerified: true as const,
    entryGeneration: 4, entryDigest: 'd'.repeat(64), envelopeDigest: 'e'.repeat(64), revision: 'observed-head' };
  return { f, archive, local: structuredClone(f.raw.tables) };
}

test('all eight tables propose missing original records in dependency order without authority', () => {
  const h = fixture();
  const local = Object.fromEntries(names.map(name => [name, []]));
  const plan = buildConfluenceCopyLedgerReconciliationPlan(context,h.archive,local);
  assert.deepEqual(plan.inserts.map(row => row.table), [names[0],names[2],names[3],names[1],names[4],names[5],names[5],names[6],names[7]]);
  assert.equal(plan.matchingRecords,0); assert.equal(plan.requiresReplay,true);
  assert.equal(plan.actionAuthorized,false); assert.equal(plan.currentHistoryVerified,false); assert.equal(plan.reopeningAuthorised,false);
  assert.equal(plan.transportStateReconciled,false);
  assert.deepEqual(h.local,h.f.raw.tables);
});

test('older database restores withdrawal and publication bookkeeping without new decisions', () => {
  const h = fixture();
  for (const name of [names[1],names[4],names[5],names[6],names[7]]) h.local[name] = [];
  const plan = buildConfluenceCopyLedgerReconciliationPlan(context,h.archive,h.local);
  assert.equal(plan.matchingRecords,3);
  assert.deepEqual(plan.inserts.map(row => row.table),[names[1],names[4],names[5],names[5],names[6],names[7]]);
  assert.deepEqual(plan.inserts.at(-1)?.record,h.f.raw.tables[names[7]]![0]);
  assert.equal(plan.inserts.at(-1)?.record.verifiedHeadRevision,'original-observation');
});

test('matching immutable rows with reordered keys/rows produce no replay and stable digest', () => {
  const h = fixture(); const first = buildConfluenceCopyLedgerReconciliationPlan(context,h.archive,h.local);
  const reordered = JSON.parse(JSON.stringify(h.local),(_key,value) => value && !Array.isArray(value) && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  reordered[names[5]].reverse();
  const second = buildConfluenceCopyLedgerReconciliationPlan(context,h.archive,reordered);
  assert.deepEqual(first,second); assert.equal(first.matchingRecords,9); assert.equal(first.requiresReplay,false);
});

for (const name of names) test(`local-only or altered ${name} never gets dropped or overwritten`, () => {
  const h = fixture(); h.local[name]![0]!.id = 'unpublished-local-evidence';
  assert.throws(() => buildConfluenceCopyLedgerReconciliationPlan(context,h.archive,h.local));
  const changed = fixture(); changed.local[name]![0]!.unexpected = 'private-original-value';
  assert.throws(() => buildConfluenceCopyLedgerReconciliationPlan(context,changed.archive,changed.local));
});

test('missing/extra tables, duplicates, foreign tenants and invalid remote relationships refuse', () => {
  for (const change of [
    (h: ReturnType<typeof fixture>) => { delete h.local[names[0]]; },
    (h: ReturnType<typeof fixture>) => { h.local.ConfluenceCopyLedgerUploadAttempt = []; },
    (h: ReturnType<typeof fixture>) => { h.local[names[0]]!.push(h.local[names[0]]![0]!); },
    (h: ReturnType<typeof fixture>) => { h.local[names[0]]![0]!.organisationId = 'org-b'; },
    (h: ReturnType<typeof fixture>) => { h.f.raw.tables[names[6]]![0]!.captureId = 'absent'; h.archive.body = h.f.body(); },
  ]) { const h = fixture(); change(h); assert.throws(() => buildConfluenceCopyLedgerReconciliationPlan(context,h.archive,h.local)); }
  const h = fixture(); assert.throws(() => buildConfluenceCopyLedgerReconciliationPlan({ ...context, organisationId: 'org-b' },h.archive,h.local));
});

async function inspectionFixture() {
  const f = await publishedLedgerFixture();
  const raw = ledgerFixture().raw;
  for (const name of [names[5],names[6],names[7]]) raw.tables[name] = [];
  Object.assign(f.prepared,prepareConfluenceCopyLocalLedger(raw));
  f.replace((await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys)).envelope);
  await f.reserve(); await f.publish();
  const state = { owner: true, active: true, loads: 0, materialisations: 0, excessive: false,
    local: structuredClone(raw.tables), afterRead: () => {} };
  const tx: Record<string,unknown> = {
    $queryRaw: async (query: { sql?: string }) => {
      if (query.sql) return names.map(name => ({ name, count: BigInt(state.excessive ? 10001 : state.local[name]!.length), bytes: 1024n }));
      return [{ now: new Date('2026-10-16T00:00:00.000Z') }];
    },
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => state.active ? { id: 'org-a' } : null },
  };
  const delegates = ['confluenceRetainedCopyReview','confluenceRetainedCopyReviewWithdrawal','confluenceSyntheticCopyScope',
    'confluenceRetainedCopyPermission','confluenceRetainedCopyPermissionWithdrawal','confluenceCopyRecoveryCapture',
    'confluenceCopyPublicationPlan','confluenceCopyPublicationReceipt'];
  delegates.forEach((name,index) => { tx[name] = { findMany: async () => {
    state.materialisations++; return structuredClone(state.local[names[index]!]);
  } }; });
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
    state.loads++; return fn(tx);
  } };
  const objects = { readConfluenceCopyLedger: async () => {
    const result = await f.objects.readConfluenceCopyLedger(); state.afterRead(); return result;
  } };
  const inspect = () => inspectConfluenceCopyLedgerReconciliation(prisma as never,'org-a','owner-a',f.binding,
    { journal: f.journal, control: f.control, keys: f.keys, objects });
  return { f, state, inspect };
}

test('capture replay proposal follows revision lineage rather than arbitrary record ID order', () => {
  const h = fixture();
  h.f.raw.tables[names[5]]![0]!.id = 'z-first-revision';
  h.f.raw.tables[names[5]]![1]!.id = 'a-later-revision';
  h.f.raw.tables[names[6]]![0]!.captureId = 'z-first-revision';
  h.archive.body = h.f.body();
  const plan = buildConfluenceCopyLedgerReconciliationPlan(context,h.archive,Object.fromEntries(names.map(name => [name,[]])));
  assert.deepEqual(plan.inserts.filter(row => row.table === names[5]).map(row => row.record.id),['z-first-revision','a-later-revision']);
});

test('Owner inspection authenticates encrypted archive and current journal with before/after database reads', async () => {
  const h = await inspectionFixture(); h.state.local[names[4]] = [];
  const before = [...h.f.rows.values()], control = structuredClone(h.f.state.current);
  const plan = await h.inspect();
  assert.equal(h.state.loads,2); assert.equal(h.state.materialisations,16);
  assert.deepEqual(plan.inserts.map(row => row.table),[names[4]]);
  assert.deepEqual([...h.f.rows.values()],before); assert.deepEqual(h.f.state.current,control);
  assert.equal(plan.reopeningAuthorised,false); assert.equal(plan.transportStateReconciled,false);
});

for (const mode of ['revoked-before','revoked-during','inactive','too-large','local-change','missing-archive','head-change'] as const) {
  test(`inspection refuses ${mode}, preserving local evidence and sanitising errors`, async () => {
    const h = await inspectionFixture();
    if (mode === 'revoked-before') h.state.owner = false;
    if (mode === 'inactive') h.state.active = false;
    if (mode === 'too-large') h.state.excessive = true;
    if (mode === 'missing-archive') h.f.replace(null);
    if (mode === 'revoked-during') h.state.afterRead = () => { h.state.owner = false; };
    if (mode === 'local-change') h.state.afterRead = () => { h.state.local[names[4]] = []; };
    if (mode === 'head-change') h.state.afterRead = () => { h.f.state.current.revision = 'changed-head'; };
    await assert.rejects(h.inspect,/Complete Confluence ledger reconciliation is unresolved/);
    if (['revoked-before','inactive','too-large'].includes(mode)) assert.equal(h.state.materialisations,0);
  });
}
