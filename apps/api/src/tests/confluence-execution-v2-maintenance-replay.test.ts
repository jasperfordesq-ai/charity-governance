import assert from 'node:assert/strict';
import test from 'node:test';
import { replayConfluenceExecutionV2Rows } from '../services/confluence-execution-v2-maintenance-replay.js';
import { publishedExecutionV2Fixture } from './fixtures/published-confluence-execution-v2.js';
import { executionLedgerFixture } from './fixtures/confluence-execution-ledger-v2.js';
import { prepareConfluenceExecutionLedgerV2 } from '../services/confluence-execution-ledger-v2.js';
import { sealConfluenceExecutionArchiveV2 } from '../services/confluence-execution-archive-v2.js';

async function setup() {
  const f = await publishedExecutionV2Fixture(), raw = executionLedgerFixture();
  for (const name of ['ConfluenceCopyRecoveryCapture','ConfluenceCopyPublicationPlan','ConfluenceCopyPublicationReceipt']) raw.tables[name] = [];
  Object.assign(f.prepared,prepareConfluenceExecutionLedgerV2(raw,f.binding.context));
  f.replace((await sealConfluenceExecutionArchiveV2(f.prepared.body,f.binding,f.keys)).envelope);
  await f.reserve(); await f.publish();
  f.state.current={...f.state.current,activeOperation:null,revision:"acknowledged-metadata"};
  const state = { rows: structuredClone(raw.tables), roleAllowed: true, failAfterInsert: false,
    loseCommitAck: false, changeHead: false, dropArchive: false, writes: 0 };
  state.rows.ConfluenceRetainedCopyPermissionWithdrawal = [];
  state.rows.ConfluenceCopyExecutionRequest=[];state.rows.ConfluenceCopyExecutionOutcome=[];
  const query = async (sql: TemplateStringsArray,...values: unknown[]) => {
    if (!state.roleAllowed) throw new Error('PRIVATE-MAINTENANCE-ROLE');
    if (sql.join('?').includes('ConfluenceExecutionV2Recovery_rows')) return [{ rows: structuredClone(state.rows) }];
    assert.match(sql.join('?'),/ConfluenceExecutionV2Recovery_replay/);
    assert.equal(values[0],'org-a');
    assert.deepEqual(JSON.parse(values[1] as string),state.rows);
    const inserts = JSON.parse(values[2] as string) as Array<{ table: string; record: Record<string,unknown> }>;
    for (const item of inserts) state.rows[item.table]!.push(item.record as typeof state.rows[string][number]);
    state.writes += inserts.length;
    if (state.failAfterInsert) throw new Error('PRIVATE-ROW-SENTINEL');
    if (state.changeHead) f.state.current.revision = 'newer-independent-head';
    if (state.dropArchive) f.replace(null);
    return [{ inserted: inserts.length }];
  };
  const tx = { $queryRaw: query, $executeRaw: async (sql: TemplateStringsArray) => {
    assert.match(sql.join('?'),/SET LOCAL synchronous_commit = on/); return 0;
  } };
  const prisma = { ...tx, $transaction: async <T>(fn: (client: typeof tx) => Promise<T>,options: unknown) => {
    assert.deepEqual(options,{ isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 300000 });
    const before = structuredClone(state.rows); let committed = false;
    try {
      const result = await fn(tx); committed = true;
      if (state.loseCommitAck) { state.loseCommitAck = false; throw new Error('Unknown synthetic commit'); }
      return result;
    } catch (error) { if (!committed) state.rows = before; throw error; }
  } };
  const replay = () => replayConfluenceExecutionV2Rows(prisma as never,'org-a',f.binding,
    { journal: f.journal, control: f.control, keys: f.keys, objects: f.objects,policy:f.policy });
  return { f,raw,state,replay };
}

test('authenticated archive replays missing original withdrawal with no action or transport authority', async () => {
  const h = await setup(), result = await h.replay();
  assert.equal(result.insertedRecords,3); assert.equal(result.ledgerRowsReconciled,true);
  assert.deepEqual(h.state.rows,h.raw.tables);
  assert.equal(result.actionAuthorized,false); assert.equal(result.reopeningAuthorised,false);
  assert.equal(result.currentHistoryVerified,false); assert.equal(result.transportStateReconciled,false);
  assert.equal((await h.replay()).insertedRecords,0); assert.equal(h.state.writes,3);
});

test('unknown commit retries fresh authenticated evidence without duplicate inserts', async () => {
  const h = await setup(); h.state.loseCommitAck = true;
  await assert.rejects(h.replay,/Confluence execution V2 maintenance replay is unresolved/);
  assert.deepEqual(h.state.rows,h.raw.tables);
  assert.equal((await h.replay()).insertedRecords,0); assert.equal(h.state.writes,3);
});

for (const mode of ['role','late-error','head-change','missing-archive','archive-disappears','foreign-slot','local-only'] as const) test(`maintenance refuses ${mode} with sanitised failure`, async () => {
  const h = await setup();
  if (mode === 'role') h.state.roleAllowed = false;
  if (mode === 'late-error') h.state.failAfterInsert = true;
  if (mode === 'archive-disappears') h.state.dropArchive=true;
  if (mode === 'foreign-slot') h.f.state.current.activeOperation={operationId:'unresolved-other',preparationDigest:'f'.repeat(64)};
  if (mode === 'head-change') h.state.changeHead = true;
  if (mode === 'missing-archive') h.f.replace(null);
  if (mode === 'local-only') h.state.rows.ConfluenceRetainedCopyReview!.push({ ...h.state.rows.ConfluenceRetainedCopyReview![0]!, id: 'unpublished-review' });
  const before = structuredClone(h.state.rows);
  await assert.rejects(h.replay,error => {
    assert.ok(error instanceof Error); assert.equal(error.message,'Confluence execution V2 maintenance replay is unresolved; retry from fresh authenticated archive evidence'); return true;
  });
  assert.deepEqual(h.state.rows,before);
});
