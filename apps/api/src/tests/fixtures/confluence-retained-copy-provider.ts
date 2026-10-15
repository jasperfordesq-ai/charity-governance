import assert from 'node:assert/strict';

export const target = { cloudId: '00000000-0000-4000-8000-000000000001',
  siteHostname: 'synthetic-example.atlassian.net', pageId: 'page-1', spaceId: 'space-1' };
export const NOW = new Date('2026-10-15T18:00:00.000Z');
export function providerFixture(twoFiles = false) {
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
