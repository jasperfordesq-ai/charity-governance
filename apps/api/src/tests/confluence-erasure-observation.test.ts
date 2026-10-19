import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { observeConfluenceErasure, type ConfluenceErasureObservationDeps } from '../services/confluence-erasure-observation.js';

function fixture() {
  const target = { kind: 'confluence', cloudId: 'cloud-1', pageId: 'page-1', attachmentIds: ['file-1'] };
  let row: { id: string; targetRef: unknown } | null = { id: 'job-1', targetRef: target };
  const calls: string[] = [];
  const client = { request: () => { throw new Error('Unexpected HTTP operation'); } } as unknown as ConfluenceClient;
  const connection = { cloudId: 'cloud-1', generation: 'original', client };
  const prisma = { documentStorageDeletion: { findFirst: async (args: { where: unknown }) => {
    assert.deepEqual(args.where, { id: 'job-1', organisationId: 'org-1', provider: 'confluence' });
    calls.push('scoped-row'); return row;
  } } } as unknown as PrismaClient;
  const deps: ConfluenceErasureObservationDeps = {
    getConnection: async () => { calls.push('connection'); return connection; },
    getPage: async (_client, id) => { calls.push('page:' + id); return id === 'control-1'
      ? { id, status: 'current' } as ConfluencePage : null; },
    isPageInTrash: async () => { calls.push('page-trash'); return false; },
    getAttachment: async () => { calls.push('attachment'); return false; },
    listTrashedAttachmentIds: async () => { calls.push('attachment-trash'); return []; },
  };
  const input = { organisationId: 'org-1', deletionId: 'job-1', controlPageId: 'control-1' };
  return { target, connection, calls, deps, input, run: () => observeConfluenceErasure(prisma, input, deps), setRow: (value: typeof row) => { row = value; } };
}
test('recorded-target non-observation retains permission uncertainty and never grants completion', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.status, 'NOT_OBSERVED'); assert.equal(result.reason, 'ABSENCE_OR_ACCESS_RESTRICTION');
  assert.equal(result.controlPageReadable, true);
  for (const key of ['permanentErasureVerified', 'allCopiesVerified', 'jobUpdated', 'providerMutationIssued', 'actionAuthorized'] as const) assert.equal(result[key], false);
  assert.deepEqual(f.calls, ['scoped-row', 'connection', 'page:control-1', 'page:page-1', 'page-trash', 'attachment', 'attachment-trash', 'connection', 'scoped-row']);
});
test('foreign or missing recorded target refuses before connection', async () => {
  const f = fixture(); f.setRow(null); await assert.rejects(f.run(), { code: 'CONFLUENCE_ERASURE_TARGET_NOT_FOUND' }); assert.deepEqual(f.calls, ['scoped-row']);
});
test('same-page control and unbounded or duplicate targets refuse before provider access', async () => {
  for (const change of ['control', 'oversized', 'duplicate', 'path']) {
    const f = fixture();
    if (change === 'control') f.input.controlPageId = f.target.pageId;
    if (change === 'oversized') f.target.attachmentIds = Array.from({ length: 101 }, (_, i) => `a${i}`);
    if (change === 'duplicate') f.target.attachmentIds = ['a', 'a'];
    if (change === 'path') f.target.pageId = '../page';
    await assert.rejects(f.run()); assert.deepEqual(f.calls, ['scoped-row']);
  }
});
test('missing or changed-site connection does not read provider content', async () => {
  for (const connection of [null, { cloudId: 'other', generation: 'new', client: fixture().connection.client }]) {
    const f = fixture(); f.deps.getConnection = async () => connection;
    assert.equal((await f.run()).status, 'UNKNOWN'); assert.deepEqual(f.calls, ['scoped-row']);
  }
});
test('unavailable legitimate control stops before target reads', async () => {
  const f = fixture(); f.deps.getPage = async () => null;
  assert.equal((await f.run()).reason, 'CONTROL_UNAVAILABLE'); assert.deepEqual(f.calls, ['scoped-row', 'connection']);
});
for (const object of ['page', 'attachment', 'page-trash', 'attachment-trash']) {
  test(`visible ${object} cannot become a missing-target observation`, async () => {
    const f = fixture();
    if (object === 'page') f.deps.getPage = async (_client, id) => ({ id, status: 'current' }) as ConfluencePage;
    if (object === 'attachment') f.deps.getAttachment = async () => true;
    if (object === 'page-trash') f.deps.isPageInTrash = async () => true;
    if (object === 'attachment-trash') f.deps.listTrashedAttachmentIds = async () => ['file-1'];
    assert.equal((await f.run()).status, object.includes('trash') ? 'TRASHED' : 'VISIBLE');
  });
}
test('changed generation discards a completed read', async () => {
  const f = fixture(); let n = 0; f.deps.getConnection = async () => ({ ...f.connection, generation: ++n === 1 ? 'old' : 'new' });
  assert.equal((await f.run()).reason, 'CONNECTION_CHANGED');
});
test('provider failures stay unknown and do not expose exception details', async () => {
  const f = fixture(); f.deps.listTrashedAttachmentIds = async () => { throw new Error('secret provider URL'); };
  const result = await f.run(); assert.equal(result.reason, 'READ_FAILED'); assert.ok(!JSON.stringify(result).includes('secret'));
});
test('the observation reader refuses destructive provider operations before HTTP', async () => {
  const f = fixture();
  f.deps.getPage = async client => {
    await client.request({ method: 'DELETE', api: 'v2', path: 'pages/page-1', idempotent: false });
    throw new Error('Must not reach this point');
  };
  assert.equal((await f.run()).reason, 'READ_FAILED');
});
test('changed recorded target discards observations', async () => {
  const f = fixture(); f.deps.listTrashedAttachmentIds = async () => { f.setRow({ id: 'job-1', targetRef: { ...f.target, pageId: 'changed' } }); return []; };
  assert.equal((await f.run()).reason, 'TARGET_CHANGED');
});
