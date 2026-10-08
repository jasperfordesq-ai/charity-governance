import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { observeSavedConfluencePageCreate } from '../services/confluence-saved-page-observation.js';
import { AppError } from '../utils/errors.js';

const operationId = '0123456789abcdef0123456789abcdef';
const body = '<p>Disposable policy</p>';
const bodySha256 = createHash('sha256').update(body).digest('hex');

function fixture() {
  const state: { siteId: string; status: string; parentId: string | null;
    title: string; body: string; version: number; reads: number } = {
    siteId: 'cloud-1', status: 'CONNECTED', parentId: 'parent-1',
    title: 'Policy', body, version: 1, reads: 0,
  };
  const prisma = {
    documentPublicationPageCreateIntent: { findFirst: async (args: { where: unknown }) => {
      assert.deepEqual(args.where, { id: operationId, organisationId: 'org-1' });
      return { id: operationId, cloudId: 'cloud-1', spaceId: 'space-1',
        parentPageId: 'parent-1', title: 'Policy', bodySha256 };
    } },
    organisationIntegration: { findUnique: async () => ({
      id: 'integration-1', status: state.status,
      config: { siteId: state.siteId, siteUrl: 'https://charity.atlassian.net/wiki' },
    }) },
  };
  const fetchPage = (async (request: Parameters<typeof fetch>[0]) => {
    const url = String(request);
    assert.match(url, /pages\/page-1\?body-format=storage$/);
    state.reads += 1;
    return new Response(JSON.stringify({ id: 'page-1', spaceId: 'space-1',
      title: state.title, parentId: state.parentId,
      version: { number: state.version },
      body: { storage: { representation: 'storage', value: state.body } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { state, prisma, fetchPage };
}

function observe(f: ReturnType<typeof fixture>, getAccessToken = async () => 'token') {
  return observeSavedConfluencePageCreate(f.prisma as never,
    { organisationId: 'org-1', operationId, pageId: 'page-1' },
    { getAccessToken, fetch: f.fetchPage });
}

test('saved page intent yields only a twice-read content candidate', async () => {
  const f = fixture();
  const result = await observe(f);
  assert.equal(f.state.reads, 2);
  assert.equal(result.pageCreateOperationId, operationId);
  assert.equal(result.bodySha256, bodySha256);
  assert.equal(result.contentCandidate, true);
  assert.equal(result.operationIdentityVerified, false);
  assert.equal(result.actionAuthorized, false);
});

test('wrong target, parent, title or body cannot become a candidate', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.parentId = null; },
    (f: ReturnType<typeof fixture>) => { f.state.title = 'Other'; },
    (f: ReturnType<typeof fixture>) => { f.state.body = '<p>Changed</p>'; },
    (f: ReturnType<typeof fixture>) => { f.state.version = 0; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(() => observe(f), (error: unknown) => error instanceof AppError
      && error.code === 'CONFLUENCE_PAGE_OBSERVATION_CANDIDATE_INVALID');
  }
});

test('site switch during token retrieval refuses provider read', async () => {
  const f = fixture();
  await assert.rejects(() => observe(f, async () => {
    f.state.siteId = 'other-cloud'; return 'token';
  }), (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_PAGE_OBSERVATION_BINDING_INVALID');
  assert.equal(f.state.reads, 0);
});

test('site switch after first page read stops the second read', async () => {
  const f = fixture();
  const original = f.fetchPage;
  f.fetchPage = (async (request: Parameters<typeof fetch>[0]) => {
    const response = await original(request);
    f.state.siteId = 'other-cloud';
    return response;
  }) as typeof fetch;
  await assert.rejects(() => observe(f), (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_PAGE_OBSERVATION_BINDING_INVALID');
  assert.equal(f.state.reads, 1);
});

test('a page changing between reads is rejected', async () => {
  const f = fixture();
  const original = f.fetchPage;
  f.fetchPage = (async (request: Parameters<typeof fetch>[0]) => {
    const response = await original(request);
    if (f.state.reads === 1) f.state.version = 2;
    return response;
  }) as typeof fetch;
  await assert.rejects(() => observe(f), (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_PAGE_OBSERVATION_CANDIDATE_INVALID');
  assert.equal(f.state.reads, 2);
});

test('invalid identity is refused before database and provider reads', async () => {
  const f = fixture();
  await assert.rejects(() => observeSavedConfluencePageCreate(f.prisma as never,
    { organisationId: 'org-1', operationId: 'wrong', pageId: 'page-1' },
    { getAccessToken: async () => 'token', fetch: f.fetchPage }),
  (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_PAGE_OBSERVATION_BINDING_INVALID');
  assert.equal(f.state.reads, 0);
});
