import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { collectRetainedConfluenceCopyInventory } from '../services/confluence-retained-copy-inventory.js';

const target = { cloudId: '00000000-0000-4000-8000-000000000001',
  siteHostname: 'synthetic-example.atlassian.net', pageId: 'page-1', spaceId: 'space-1' };
const NOW = new Date('2026-10-15T18:00:00.000Z');
function fixture(twoFiles = false) {
  const calls: Array<{ url: URL; token: string | null }> = [];
  const state = {
    pageId: 'page-1', spaceId: 'space-1', status: 'current', pageVersion: 2,
    ids: twoFiles ? ['att-a', 'att-b'] : ['att-a'],
    histories: { 'att-a': [1, 2], 'att-b': [1, 2] } as Record<string, number[]>,
    bytes: { 'att-a:1': 'old', 'att-a:2': 'newest', 'att-b:1': 'one', 'att-b:2': 'two' } as Record<string, string>,
  };
  let onRead: ((url: URL) => void) | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, token: new Headers(init?.headers).get('Authorization') });
    assert.equal(init?.method, 'GET');
    onRead?.(parsed);
    if (parsed.hostname === 'api.media.atlassian.com') {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      const [, attachment, version] = parsed.pathname.split('/');
      const body = state.bytes[`${attachment}:${version}`];
      assert.notEqual(body, undefined);
      return new Response(body, { headers: { 'Content-Length': String(Buffer.byteLength(body!)) } });
    }
    assert.equal(parsed.hostname, 'api.atlassian.com');
    assert.ok(parsed.pathname.startsWith(`/ex/confluence/${target.cloudId}/wiki/`));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-test-token');
    const respond = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (parsed.pathname.endsWith('/pages/page-1')) return respond({ id: state.pageId,
      spaceId: state.spaceId, status: state.status, title: 'Synthetic page', version: { number: state.pageVersion } });
    if (parsed.pathname.endsWith('/pages/page-1/versions')) return respond({ results:
      Array.from({ length: state.pageVersion }, (_, i) => ({ number: i + 1, page: { id: 'page-1' } })) });
    if (parsed.pathname.endsWith('/pages/page-1/attachments')) return respond({ results: state.ids.map((id) => ({
      id, title: `${id}.txt`, fileSize: Buffer.byteLength(state.bytes[`${id}:2`]!), version: { number: 2 },
    })) });
    const history = parsed.pathname.match(/\/attachments\/(att-[ab])\/versions$/);
    if (history) return respond({ results: state.histories[history[1]!]!.map((number) => ({
      number, attachment: { id: history[1] }, createdAt: '2026-10-15T17:00:00.000Z',
    })) });
    const download = parsed.pathname.match(/\/child\/attachment\/(att-[ab])\/download$/);
    if (download) {
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302, headers: {
        Location: `https://api.media.atlassian.com/${download[1]}/${parsed.searchParams.get('version')}`,
      } });
    }
    throw new Error(`Unexpected synthetic path ${parsed.pathname}`);
  };
  const deps = { fetch, getAccessToken: async () => 'synthetic-test-token', now: () => NOW };
  return { calls, state, deps, onRead: (hook: (url: URL) => void) => { onRead = hook; } };
}

test('collects exact page/version inventory and real streamed hashes without granting authority', async () => {
  const h = fixture(true);
  const result = await collectRetainedConfluenceCopyInventory(target, h.deps);
  assert.deepEqual(result.inventory.pageVersions, [1, 2]);
  assert.equal(result.inventory.attachments.length, 2);
  assert.deepEqual(result.inventory.attachments[0]?.versions, [
    { number: 1, sha256: createHash('sha256').update('old').digest('hex'), sizeBytes: 3 },
    { number: 2, sha256: createHash('sha256').update('newest').digest('hex'), sizeBytes: 6 },
  ]);
  assert.equal(result.downloadedBytes, 24, 'budget includes repeated current-version reads for both files');
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.allCopiesVerified, false);
  assert.equal(result.sourceVerified, false);
  assert.equal(result.inventory.observedAt, NOW.toISOString());
  assert.ok(h.calls.filter((c) => c.url.hostname === 'api.media.atlassian.com').every((c) => c.token === null));
});
test('a current page with no attachments has an explicit empty inventory', async () => {
  const h = fixture(); h.state.ids = [];
  const result = await collectRetainedConfluenceCopyInventory(target, h.deps);
  assert.deepEqual(result.inventory.attachments, []);
  assert.equal(result.downloadedBytes, 0);
});
for (const [label, change] of Object.entries({
  wrongPage: (h: ReturnType<typeof fixture>) => { h.state.pageId = 'other-page'; },
  wrongSpace: (h: ReturnType<typeof fixture>) => { h.state.spaceId = 'other-space'; },
  archived: (h: ReturnType<typeof fixture>) => { h.state.status = 'archived'; },
  trashed: (h: ReturnType<typeof fixture>) => { h.state.status = 'trashed'; },
  duplicateAttachment: (h: ReturnType<typeof fixture>) => { h.state.ids.push('att-a'); },
})) {
  test(`collector refuses ${label} before any attachment byte request`, async () => {
    const h = fixture(); change(h);
    await assert.rejects(collectRetainedConfluenceCopyInventory(target, h.deps));
    assert.equal(h.calls.filter((c) => c.url.hostname === 'api.media.atlassian.com').length, 0);
  });
}
test('aggregate byte budget covers later attachments and every repeat read', async () => {
  const h = fixture(true);
  await assert.rejects(collectRetainedConfluenceCopyInventory({ ...target, maxTotalBytes: 20 }, h.deps));
});
test('attachment-count limit refuses before any download rather than truncating', async () => {
  const h = fixture(true);
  await assert.rejects(collectRetainedConfluenceCopyInventory({ ...target, maxAttachments: 1 }, h.deps));
  assert.equal(h.calls.filter((c) => c.url.pathname.endsWith('/download')).length, 0);
});
test('a new page version during attachment read invalidates the full collection', async () => {
  const h = fixture();
  h.onRead((url) => { if (url.hostname === 'api.media.atlassian.com') h.state.pageVersion = 3; });
  await assert.rejects(collectRetainedConfluenceCopyInventory(target, h.deps));
});
test('an added attachment during byte read invalidates the full collection', async () => {
  const h = fixture();
  h.onRead((url) => { if (url.hostname === 'api.media.atlassian.com') h.state.ids = ['att-a', 'att-b']; });
  await assert.rejects(collectRetainedConfluenceCopyInventory(target, h.deps));
});
test('earlier attachment history is revisited after later attachment downloads', async () => {
  const h = fixture(true);
  h.onRead((url) => { if (url.hostname === 'api.media.atlassian.com' && url.pathname === '/att-b/1') h.state.histories['att-a'] = [2]; });
  await assert.rejects(collectRetainedConfluenceCopyInventory(target, h.deps));
});
test('changed bytes under an unchanged current version are refused', async () => {
  const h = fixture(); let reads = 0;
  h.onRead((url) => {
    if (url.hostname === 'api.media.atlassian.com' && url.pathname === '/att-a/2' && ++reads === 2) h.state.bytes['att-a:2'] = 'LATEST';
  });
  await assert.rejects(collectRetainedConfluenceCopyInventory(target, h.deps));
});
test('provider permission denial is an error, not an empty inventory', async () => {
  const h = fixture();
  await assert.rejects(collectRetainedConfluenceCopyInventory(target, { ...h.deps,
    fetch: async () => new Response('{}', { status: 403 }) }));
});
test('invalid input and pre-cancellation do not request credentials or data', async () => {
  const h = fixture(); let tokens = 0;
  const deps = { ...h.deps, getAccessToken: async () => { tokens++; return 'synthetic'; } };
  await assert.rejects(collectRetainedConfluenceCopyInventory({ ...target, pageId: '../other' }, deps));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectRetainedConfluenceCopyInventory(target, { ...deps, signal: controller.signal }));
  assert.equal(h.calls.length, 0); assert.equal(tokens, 0);
});
test('cancellation during byte read stops collection without a successful result', async () => {
  const h = fixture(); const controller = new AbortController(); let callsAtAbort = 0;
  h.onRead((url) => { if (url.hostname === 'api.media.atlassian.com') {
    callsAtAbort = h.calls.length; controller.abort();
  } });
  await assert.rejects(collectRetainedConfluenceCopyInventory(target, { ...h.deps, signal: controller.signal }));
  assert.equal(h.calls.length, callsAtAbort);
});
