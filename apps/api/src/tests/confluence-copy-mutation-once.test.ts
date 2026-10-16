import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfluenceClient } from '../services/confluence-client.js';
import { requestRetainedConfluenceCopyMutationOnce } from '../services/confluence-copy-mutation-once.js';

for (const action of ['TRASH', 'PURGE'] as const) {
  for (const scenario of ['accepted', 'missing', 'forbidden', 'rate-limited', 'server-error', 'timeout', 'redirect', 'unexpected-success'] as const) {
    test(`${action}: ${scenario} never repeats a destructive request or claims erasure`, async () => {
      let calls = 0;
      let sleeps = 0;
      const client = createConfluenceClient({ cloudId: '11111111-2222-3333-4444-555555555555',
        getAccessToken: async () => 'synthetic-fixture-token' }, {
        sleep: async () => { sleeps++; },
        fetch: async (url, init) => {
          calls++;
          const target = new URL(String(url));
          assert.equal(target.origin, 'https://api.atlassian.com');
          assert.equal(target.pathname, '/ex/confluence/11111111-2222-3333-4444-555555555555/wiki/api/v2/pages/491521');
          assert.equal(target.search, action === 'PURGE' ? '?purge=true' : '');
          assert.equal(init?.method, 'DELETE');
          assert.equal(init?.redirect, 'error');
          if (scenario === 'timeout') throw new DOMException('PRIVATE-PROVIDER-DETAIL', 'TimeoutError');
          if (scenario === 'redirect') throw new TypeError('PRIVATE-PROVIDER-DETAIL');
          if (scenario === 'accepted') return new Response(null, { status: 204 });
          const status = { missing: 404, forbidden: 403, 'rate-limited': 429, 'server-error': 503,
            'unexpected-success': 200 }[scenario];
          return new Response(JSON.stringify({ message: 'PRIVATE-PROVIDER-DETAIL' }), {
            status, headers: { 'content-type': 'application/json', 'retry-after': '1' },
          });
        },
      });
      const result = await requestRetainedConfluenceCopyMutationOnce(client, { action, pageId: '491521' });
      assert.equal(calls, 1);
      assert.equal(sleeps, 0);
      assert.equal(result.requestOutcome, scenario === 'accepted' ? 'ACKNOWLEDGED'
        : scenario === 'forbidden' ? 'REFUSED' : 'UNRESOLVED');
      assert.equal(result.automaticRetryAllowed, false);
      assert.equal(result.providerAbsenceVerified, false);
      assert.equal(result.allCopiesVerified, false);
      assert.equal(JSON.stringify(result).includes('PRIVATE-PROVIDER-DETAIL'), false);
      assert.equal(JSON.stringify(result).includes('synthetic-fixture-token'), false);
    });
  }
}

test('invalid target/action or caller-supplied authority never reaches the client', async () => {
  let calls = 0;
  const client = { async request() { calls++; return { status: 204, body: undefined }; } };
  for (const input of [null, {}, { action: 'DELETE', pageId: '491521' },
    ...['', '../491521', '491521/attachments', '491521?purge=true', 'https://example.com', 'x'.repeat(65)]
      .map(pageId => ({ action: 'PURGE', pageId })),
    { action: 'PURGE', pageId: '491521', authorised: true }]) {
    await assert.rejects(requestRetainedConfluenceCopyMutationOnce(client, input));
  }
  assert.equal(calls, 0);
});
