import assert from 'node:assert/strict';
import test from 'node:test';
import { replayConfluenceCopyDecisionRows } from '../services/confluence-copy-maintenance-replay.js';
import { fixture } from './fixtures/confluence-copy-decision-history.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';

async function setup() {
  const f = await fixture();
  const first = f.values[0]!;
  const state = { rows: { reviews: [first.review], scopes: [first.scope], permissions: [first.permission],
    reviewWithdrawals: [] as NonNullable<typeof first.reviewWithdrawal>[],
    permissionWithdrawals: [] as NonNullable<typeof first.permissionWithdrawal>[] },
    roleAllowed: true, failAfterInsert: false, changeHead: false, loseCommitAck: false, calls: 0 };
  const query = async (sql: TemplateStringsArray, ...values: unknown[]) => {
    if (!state.roleAllowed) throw new Error('PRIVATE-DATABASE-ROLE-SENTINEL');
    if (sql.join('?').includes('ConfluenceCopyRecovery_rows')) return [{ rows: structuredClone(state.rows) }];
    assert.match(sql.join('?'),/ConfluenceCopyRecovery_replay/); state.calls++;
    assert.equal(values[0],'org-a');
    assert.deepEqual(JSON.parse(String(values[1])),state.rows,'local rows must match exact pre-verification snapshot');
    const inserts = JSON.parse(String(values[2])) as Array<{ table: keyof typeof state.rows; record: never }>;
    for (const item of inserts) state.rows[item.table].push(item.record);
    if (state.failAfterInsert) throw new Error('PRIVATE-FAILING-REVIEW-CONTENT');
    if (state.changeHead) f.state.current.revision = 'changed-during-sql';
    return [{ inserted: inserts.length }];
  };
  const tx = { $queryRaw: query };
  const prisma = { ...tx, $transaction: async <T>(fn: (client: typeof tx) => Promise<T>, options: { isolationLevel: string; timeout: number }) => {
    assert.equal(options.isolationLevel,'ReadCommitted'); assert.equal(options.timeout,30000);
    const before = structuredClone(state.rows);
    let result: T;
    try { result = await fn(tx); } catch (error) { state.rows = before; throw error; }
    if (state.loseCommitAck) { state.loseCommitAck = false; throw new Error('Synthetic committed acknowledgement lost'); }
    return result;
  } };
  const deps = { journal: f.journal, control: f.control, keys: f.keys,
    objects: { readConfluenceCopyState: async (id: string) => f.objects.get(id) ?? null } };
  const replay = () => replayConfluenceCopyDecisionRows(prisma as never,'org-a',deps,[context.keyId]);
  return { state, f, deps, replay };
}

test('fresh authenticated history applies both missing withdrawals atomically without reopen authority', async () => {
  const h = await setup(), result = await h.replay();
  assert.equal(result.insertedRecords,2); assert.equal(result.decisionRowsReconciled,true);
  assert.equal(h.state.rows.reviewWithdrawals[0]?.id,'rw-a'); assert.equal(h.state.rows.permissionWithdrawals[0]?.id,'pw-a');
  assert.equal(result.actionAuthorized,false); assert.equal(result.currentHistoryVerified,false); assert.equal(result.reopeningAuthorised,false);
  const retry = await h.replay(); assert.equal(retry.replayed,true); assert.equal(retry.insertedRecords,0);
});

test('unknown commit acknowledgement retries fresh history and current rows instead of reinserting', async () => {
  const h = await setup(); h.state.loseCommitAck = true; await assert.rejects(h.replay,/unresolved/);
  assert.equal(h.state.rows.permissionWithdrawals.length,1);
  const result = await h.replay(); assert.equal(result.replayed,true); assert.equal(result.insertedRecords,0);
});

test('late SQL error or changed independent head rolls back all proposed rows and sanitises private errors', async () => {
  for (const failure of ['sql','head'] as const) {
    const h = await setup(); h.state.failAfterInsert = failure === 'sql'; h.state.changeHead = failure === 'head';
    await assert.rejects(h.replay,error => error instanceof Error && error.message ===
      'Confluence maintenance replay is unresolved; retry from fresh independent history');
    assert.equal(h.state.rows.reviewWithdrawals.length,0); assert.equal(h.state.rows.permissionWithdrawals.length,0);
  }
});

test('runtime/role refusal and missing latest payload cause no replay writes', async () => {
  const denied = await setup(); denied.state.roleAllowed = false; await assert.rejects(denied.replay,/unresolved/); assert.equal(denied.state.calls,0);
  const missing = await setup(); missing.f.objects.delete('state-2'); await assert.rejects(missing.replay,/unresolved/); assert.equal(missing.state.calls,0);
});

test('a newer unpublished local withdrawal is never overwritten by remote replay', async () => {
  const h = await setup(); h.state.rows.permissionWithdrawals.push({ ...h.f.values[1]!.permissionWithdrawal!, id: 'local-newer-withdrawal' });
  await assert.rejects(h.replay,/unresolved/); assert.equal(h.state.calls,0);
  assert.equal(h.state.rows.permissionWithdrawals[0]?.id,'local-newer-withdrawal');
});
