import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { observeConfluenceCitation } from '../services/confluence-citation-observation.js';

function fixture() {
  let reference: Record<string, unknown> | null = { id: 'ref-1', documentId: 'doc-1', cloudId: 'cloud-1',
    pageId: 'page-1', pageVersion: 2, citedAt: new Date('2026-10-01'), updatedAt: new Date('2026-10-01') };
  const calls: string[] = [];
  const prisma = { confluenceReference: { findFirst: async (args: { where: unknown }) => {
    assert.deepEqual(args.where, { id: 'ref-1', organisationId: 'org-1', OR: [
      { referenceKind: 'CONFLUENCE_SOURCE', documentId: null },
      { document: { organisationId: 'org-1', deletedAt: null } },
    ] });
    calls.push('citation'); return reference;
  } } } as unknown as PrismaClient;
  const client = { request: () => { throw new Error('Unexpected HTTP'); } } as unknown as ConfluenceClient;
  const connection = { cloudId: 'cloud-1', generation: 'grant-1', client };
  const deps = {
    getConnection: async () => { calls.push('connection'); return connection as typeof connection | null; },
    getPage: async (_client: ConfluenceClient, id: string): Promise<ConfluencePage | null> => {
      calls.push(id); return id === 'control-1' ? { id, status: 'current' } as ConfluencePage : null;
    },
    isPageInTrash: async () => { calls.push('trash'); return false; },
  };
  const input = { organisationId: 'org-1', referenceId: 'ref-1', controlPageId: 'control-1' };
  return { input, deps, calls, connection, run: () => observeConfluenceCitation(prisma, input, deps),
    setReference: (value: typeof reference) => { reference = value; }, getReference: () => reference };
}

test('cited page observation has no datastore writes or job dependency and preserves permission uncertainty', async () => {
  const f = fixture(); const original = JSON.stringify(f.getReference()); const value = await f.run();
  assert.equal(value.status, 'NOT_OBSERVED'); assert.equal(value.reason, 'ABSENCE_OR_ACCESS_RESTRICTION');
  assert.equal(value.scope, 'CITED_PAGE_ONLY'); assert.equal(value.controlPageReadable, true);
  for (const key of ['attachmentsObserved', 'permanentErasureVerified', 'allCopiesVerified', 'jobCreated',
    'citationUpdated', 'providerMutationIssued', 'actionAuthorized'] as const) assert.equal(value[key], false);
  assert.equal(JSON.stringify(f.getReference()), original);
  assert.deepEqual(f.calls, ['citation', 'connection', 'control-1', 'page-1', 'trash', 'connection', 'citation']);
});
test('missing, foreign or deleted-document citation refuses before provider access', async () => {
  const f = fixture(); f.setReference(null);
  await assert.rejects(f.run(), { code: 'CONFLUENCE_REFERENCE_NOT_FOUND' }); assert.deepEqual(f.calls, ['citation']);
});
test('same control page and malformed identifiers refuse without provider reads', async () => {
  for (const target of ['page-1', '../control']) {
    const f = fixture(); f.input.controlPageId = target; await assert.rejects(f.run()); assert.ok(!f.calls.includes('connection'));
  }
});
for (const mode of ['visible', 'trashed', 'control-unavailable', 'wrong-page', 'provider-error'] as const) {
  test(`cited page handles ${mode} without asserting purge`, async () => {
    const f = fixture();
    if (mode === 'visible') f.deps.getPage = async (_client, id) => ({ id, status: 'current' }) as ConfluencePage;
    if (mode === 'trashed') f.deps.isPageInTrash = async () => true;
    if (mode === 'control-unavailable') f.deps.getPage = async () => null;
    if (mode === 'wrong-page') f.deps.getPage = async (_client, id) => ({ id: id === 'control-1' ? id : 'wrong', status: 'current' }) as ConfluencePage;
    if (mode === 'provider-error') f.deps.isPageInTrash = async () => { throw new Error('private upstream secret'); };
    const value = await f.run();
    assert.equal(value.status, mode === 'visible' ? 'VISIBLE' : mode === 'trashed' ? 'TRASHED' : 'UNKNOWN');
    assert.equal(value.permanentErasureVerified, false); assert.ok(!JSON.stringify(value).includes('secret'));
  });
}
test('absent and changed site/grant cannot supply an observation', async () => {
  for (const mode of ['absent', 'site', 'generation']) {
    const f = fixture(); let reads = 0;
    f.deps.getConnection = async () => mode === 'absent' ? null : { ...f.connection,
      cloudId: mode === 'site' ? 'other' : f.connection.cloudId,
      generation: mode === 'generation' && ++reads > 1 ? 'changed' : f.connection.generation };
    assert.equal((await f.run()).status, 'UNKNOWN');
  }
});
test('unciting, reciting, version changes and deleting the linked document discard in-flight reads', async () => {
  for (const mode of ['removed', 'recited', 'version', 'document-deleted']) {
    const f = fixture(); f.deps.isPageInTrash = async () => {
      f.setReference(mode === 'removed' || mode === 'document-deleted' ? null : { ...f.getReference(),
        ...(mode === 'recited' ? { citedAt: new Date('2026-10-19') } : { pageVersion: 3 }) }); return false;
    };
    assert.equal((await f.run()).reason, 'TARGET_CHANGED');
  }
});
test('bounded cited-page reader refuses a destructive request before transport', async () => {
  const f = fixture(); f.deps.getPage = async client => {
    await client.request({ method: 'DELETE', api: 'v2', path: 'pages/page-1', idempotent: false }); return null;
  };
  assert.equal((await f.run()).reason, 'READ_FAILED');
});
