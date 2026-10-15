import assert from 'node:assert/strict';
import test from 'node:test';
import { listConfluencePageVersions } from '../services/confluence-page-versions.js';
import type { ConfluenceClient, ConfluenceRequestSpec, ConfluenceResponse } from '../services/confluence-client.js';

const row = (number: number, id = 'page-1') => ({ number, page: { id } });
function client(responses: ConfluenceResponse[]) {
  const requests: ConfluenceRequestSpec[] = [];
  return { requests, client: { request: async (spec) => {
    requests.push(spec); const response = responses.shift();
    if (!response) throw new Error('Unexpected provider request'); return response;
  } } as ConfluenceClient };
}
test('page versions follow body and header cursors on a fixed exact-page path', async () => {
  const h = client([
    { status: 200, body: { results: [row(3)], _links: { next: 'https://evil.example/other?cursor=A' } } },
    { status: 200, body: { results: [row(1)] }, linkHeader: '</ignored?cursor=B>; rel="next"' },
    { status: 200, body: { results: [row(2)] } },
  ]);
  assert.deepEqual(await listConfluencePageVersions(h.client, 'page-1'), [1, 2, 3]);
  assert.deepEqual(h.requests.map((r) => r.path), Array(3).fill('pages/page-1/versions'));
  assert.deepEqual(h.requests.map((r) => r.query?.cursor), [undefined, 'A', 'B']);
  assert.ok(h.requests.every((r) => r.method === 'GET' && r.idempotent));
});
for (const [label, responses] of Object.entries({
  empty: [{ status: 200, body: { results: [] } }],
  missing: [{ status: 200, body: {} }],
  wrongPage: [{ status: 200, body: { results: [row(1, 'other')] } }],
  invalidVersion: [{ status: 200, body: { results: [row(0)] } }],
  duplicate: [{ status: 200, body: { results: [row(1), row(1)] } }],
  malformedNext: [{ status: 200, body: { results: [row(1)], _links: { next: '/no-cursor' } } }],
  ambiguousCursor: [{ status: 200, body: { results: [row(1)], _links: { next: '/?cursor=A&cursor=B' } } }],
  conflictingCursors: [{ status: 200, body: { results: [row(1)], _links: { next: '/?cursor=A' } }, linkHeader: '</?cursor=B>; rel="next"' }],
  repeatCursor: [
    { status: 200, body: { results: [row(1)], _links: { next: '/?cursor=A' } } },
    { status: 200, body: { results: [row(2)], _links: { next: '/?cursor=A' } } },
  ],
  errorStatus: [{ status: 403, body: { results: [row(1)] } }],
})) {
  test(`page inventory refuses ${label}`, async () => {
    await assert.rejects(listConfluencePageVersions(client(responses).client, 'page-1'),
      (e: { code?: string }) => e.code === 'CONFLUENCE_PAGE_VERSION_INVENTORY_INVALID');
  });
}
test('bounded inventory refuses a continuation without truncating or making another request', async () => {
  const h = client([{ status: 200, body: { results: [row(1)], _links: { next: '/?cursor=A' } } }]);
  await assert.rejects(listConfluencePageVersions(h.client, 'page-1', 1));
  assert.equal(h.requests.length, 1);
});
test('pagination shared with attachment inventories refuses duplicate cursor parameters', async () => {
  const { listAttachments } = await import('../services/confluence-attachments.js');
  const h = client([{ status: 200, body: { results: [], _links: { next: '/?cursor=A&cursor=B' } } }]);
  await assert.rejects(listAttachments(h.client, 'page-1'), (e: { code?: string }) => e.code === 'CONFLUENCE_RESPONSE_INVALID');
  assert.equal(h.requests.length, 1);
});
test('invalid input and cancellation stop before any request', async () => {
  const h = client([]);
  await assert.rejects(listConfluencePageVersions(h.client, '../other'));
  await assert.rejects(listConfluencePageVersions(h.client, undefined as never));
  await assert.rejects(listConfluencePageVersions(h.client, 'page-1', 1001));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listConfluencePageVersions(h.client, 'page-1', 10, controller.signal));
  assert.equal(h.requests.length, 0);
});
