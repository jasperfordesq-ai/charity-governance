import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { captureConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_TABLES as names } from '../services/confluence-copy-ledger-snapshot.js';
import { recoveryFactsFixture } from './fixtures/confluence-copy-recovery-facts.js';
import { prepareConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-facts.js';

function fixture() {
  const facts = recoveryFactsFixture(), prepared = prepareConfluenceCopyRecoveryFacts(facts);
  const state = { owner: true, active: true, reads: 0, fail: false,
    sizes: names.map(name => ({ name, count: 1n, bytes: 1024n })),
    rows: [facts.review,
      { id: 'rw-unpublished', organisationId: 'org-a', reviewId: facts.review.id, reason: 'PRIVATE-UNPUBLISHED-WITHDRAWAL' },
      facts.scope, facts.permission,
      { id: 'pw-unpublished', organisationId: 'org-a', permissionId: facts.permission.id, reason: 'Retain original decision' },
      { id: 'capture-a', organisationId: 'org-a', actorUserId: 'owner-a', facts: prepared.body, factsDigest: prepared.digest,
        capturedAt: new Date(facts.capturedAt), recordedAt: new Date('2026-10-15T18:05:01.000Z') },
      { id: 'plan-a', organisationId: 'org-a', captureId: 'capture-a', keyEvidenceRef: 'KEY-EVIDENCE-ORIGINAL',
        expectedDigest: null, expectedGeneration: 0, recordedAt: new Date('2026-10-15T18:06:01.000Z') },
      { id: 'receipt-a', organisationId: 'org-a', planId: 'plan-a', verifiedHeadRevision: 'original-etag',
        recordedAt: new Date('2026-10-15T18:07:01.000Z') },
    ].map(row => [row] as Array<Record<string,unknown>>) };
  const tx: Record<string,unknown> = {
    $queryRaw: async (query: TemplateStringsArray | { sql: string; values: unknown[] }) => {
      if (state.fail) throw new Error('PRIVATE-RAW-DATABASE-ROW');
      if (!Array.isArray(query)) {
        const statement = query as { sql: string; values: unknown[] };
        for (const name of names) assert.ok(statement.sql.includes(`public."${name}"`));
        assert.equal(statement.values.filter(value => value === 'org-a').length,8);
        return structuredClone(state.sizes);
      }
      return [{ now: new Date('2026-10-15T22:00:00.000Z') }];
    },
    user: { findFirst: async ({ where }: { where: Record<string,string> }) => {
      assert.equal(where.role,'OWNER'); assert.equal(where.lifecycleStatus,'ACTIVE');
      return state.owner && where.id === 'owner-a' && where.organisationId === 'org-a' ? { id: 'owner-a' } : null;
    } },
    organisation: { findFirst: async ({ where }: { where: Record<string,string> }) => {
      assert.equal(where.lifecycleStatus,'ACTIVE'); return state.active && where.id === 'org-a' ? { id: 'org-a' } : null;
    } },
  };
  const delegates = ['confluenceRetainedCopyReview','confluenceRetainedCopyReviewWithdrawal','confluenceSyntheticCopyScope',
    'confluenceRetainedCopyPermission','confluenceRetainedCopyPermissionWithdrawal','confluenceCopyRecoveryCapture',
    'confluenceCopyPublicationPlan','confluenceCopyPublicationReceipt'];
  delegates.forEach((name,index) => { tx[name] = { findMany: async ({ where, orderBy, take }: {
    where: { organisationId: string }; orderBy: { id: string }; take: number }) => {
    assert.deepEqual(where,{ organisationId: 'org-a' }); assert.deepEqual(orderBy,{ id: 'asc' }); assert.equal(take,10001);
    state.reads++; return structuredClone(state.rows[index]);
  } }; });
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>, options: unknown) => {
    assert.deepEqual(options,{ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000 }); return fn(tx);
  } };
  const capture = (raw: unknown = { installationId: 'install-a', declaredSourceRevision: 'a'.repeat(40) },
    org = 'org-a', actor = 'owner-a') => captureConfluenceCopyLocalLedger(prisma as never,org,actor,raw);
  return { state, capture, prepared };
}

test('complete local ledger preserves unpublished withdrawals and exact original capture/plan/receipt metadata', async () => {
  const h = fixture(), result = await h.capture(), ledger = JSON.parse(result.body);
  assert.deepEqual(Object.keys(ledger.tables).sort(),[...names].sort());
  for (const [index,name] of names.entries()) assert.deepEqual(ledger.tables[name],JSON.parse(JSON.stringify(h.state.rows[index])));
  assert.equal(ledger.tables.ConfluenceCopyRecoveryCapture[0].facts,h.prepared.body);
  assert.equal(ledger.tables.ConfluenceCopyRecoveryCapture[0].recordedAt,'2026-10-15T18:05:01.000Z');
  assert.equal(ledger.tables.ConfluenceCopyPublicationReceipt[0].verifiedHeadRevision,'original-etag');
  assert.equal(ledger.tables.ConfluenceRetainedCopyReviewWithdrawal[0].id,'rw-unpublished');
  assert.equal(result.digest,createHash('sha256').update(result.body).digest('hex'));
  assert.deepEqual(result.tableCounts,Object.fromEntries(names.map(name => [name,1])));
  for (const flag of ['independentlyPreserved','currentHistoryVerified','actionAuthorized','reopeningAuthorised'] as const) assert.equal(result[flag],false);
  assert.equal(result.scope,'CONFLUENCE_LOCAL_LEDGER_ONLY'); assert.equal(h.state.reads,8);
});

test('inactive charity, revoked Owner, Member and other-charity requests fail before any history transfer', async () => {
  for (const mode of ['inactive','revoked','member','foreign']) {
    const h = fixture(); h.state.active = mode !== 'inactive'; h.state.owner = mode !== 'revoked';
    await assert.rejects(h.capture(undefined,mode === 'foreign' ? 'org-b' : 'org-a',mode === 'member' ? 'member-a' : 'owner-a'),/capture is unresolved/);
    assert.equal(h.state.reads,0);
  }
});

test('declared binding is strict and never accepts caller-supplied table bodies', async () => {
  for (const raw of [{ installationId: '', declaredSourceRevision: 'a'.repeat(40) },
    { installationId: 'install-a', declaredSourceRevision: 'not-a-release' },
    { installationId: 'install-a', declaredSourceRevision: 'a'.repeat(40), tables: {} }]) {
    const h = fixture(); await assert.rejects(h.capture(raw),/capture is unresolved/); assert.equal(h.state.reads,0);
  }
});

test('incomplete, duplicate or over-capacity SQL inventory refuses before downloading rows', async () => {
  for (const change of [(h: ReturnType<typeof fixture>) => { h.state.sizes.pop(); },
    (h: ReturnType<typeof fixture>) => { h.state.sizes[7]!.name = names[0]; },
    (h: ReturnType<typeof fixture>) => { h.state.sizes[0]!.count = 10001n; },
    (h: ReturnType<typeof fixture>) => { h.state.sizes[0]!.bytes = 121n * 1024n * 1024n; },
    (h: ReturnType<typeof fixture>) => { h.state.sizes[0]!.bytes = -1n; }]) {
    const h = fixture(); change(h); await assert.rejects(h.capture(),/capture is unresolved/); assert.equal(h.state.reads,0);
  }
});

test('foreign, duplicate or count-mismatched transferred rows refuse without returning partial evidence', async () => {
  for (const change of [(h: ReturnType<typeof fixture>) => { h.state.rows[7]![0]!.organisationId = 'org-b'; },
    (h: ReturnType<typeof fixture>) => { h.state.rows[7]!.push(h.state.rows[7]![0]!); h.state.sizes[7]!.count = 2n; },
    (h: ReturnType<typeof fixture>) => { h.state.rows[7] = []; }]) {
    const h = fixture(); change(h); await assert.rejects(h.capture(),/capture is unresolved/);
  }
});

test('capture errors do not disclose raw database or governance content', async () => {
  const h = fixture(); h.state.fail = true;
  await assert.rejects(h.capture(),error => error instanceof Error && !error.message.includes('PRIVATE-') && error.cause === undefined);
});
