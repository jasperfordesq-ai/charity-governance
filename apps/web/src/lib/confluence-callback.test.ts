import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';
import {
  classifyConfluenceCallbackFailure,
  completeConfluenceCallback,
} from './confluence-callback';

function ok(siteUrl = 'https://example.atlassian.net/wiki') {
  return { siteUrl };
}

function axiosError(status: number, code?: string) {
  const error = new Error(`Request failed with status code ${status}`);
  Object.assign(error, {
    isAxiosError: true,
    response: { status, data: code ? { code } : {} },
  });
  return error;
}

function unauthorised() {
  return axiosError(401);
}

function serverError() {
  return axiosError(500);
}

test('the session is refreshed before the code is posted', async () => {
  const order: string[] = [];
  const outcome = await completeConfluenceCallback(
    { code: 'c', state: 's' },
    {
      refresh: async () => {
        order.push('refresh');
      },
      post: async () => {
        order.push('post');
        return ok();
      },
    },
  );
  assert.deepEqual(order, ['refresh', 'post']);
  assert.equal(outcome.kind, 'connected');
});

test('a failed refresh still reports a session problem rather than a generic failure', async () => {
  const outcome = await completeConfluenceCallback(
    { code: 'c', state: 's' },
    { refresh: async () => { throw unauthorised(); }, post: async () => ok() },
  );
  assert.equal(outcome.kind, 'session-expired');
});

test('a failed refresh never even reaches the post — the code is not spent on a dead session', async () => {
  let postCalled = false;
  await completeConfluenceCallback(
    { code: 'c', state: 's' },
    {
      refresh: async () => { throw unauthorised(); },
      post: async () => {
        postCalled = true;
        return ok();
      },
    },
  );
  assert.equal(postCalled, false);
});

test('neither the code nor the state appears in any outcome message', async () => {
  const outcome = await completeConfluenceCallback(
    { code: 'SECRET-CODE', state: 'SECRET-STATE' },
    { refresh: async () => {}, post: async () => { throw serverError(); } },
  );
  const rendered = JSON.stringify(outcome);
  assert.ok(!rendered.includes('SECRET-CODE'));
  assert.ok(!rendered.includes('SECRET-STATE'));
});

test('neither the code nor the state appears in the session-expired outcome either', async () => {
  const outcome = await completeConfluenceCallback(
    { code: 'ANOTHER-SECRET-CODE', state: 'ANOTHER-SECRET-STATE' },
    { refresh: async () => { throw unauthorised(); }, post: async () => ok() },
  );
  const rendered = JSON.stringify(outcome);
  assert.ok(!rendered.includes('ANOTHER-SECRET-CODE'));
  assert.ok(!rendered.includes('ANOTHER-SECRET-STATE'));
});

test('a 401 surviving the post (session died again after refresh) is a session problem, not "failed"', async () => {
  const outcome = await completeConfluenceCallback(
    { code: 'c', state: 's' },
    { refresh: async () => {}, post: async () => { throw unauthorised(); } },
  );
  assert.equal(outcome.kind, 'session-expired');
});

test('an invalid/foreign state is reported distinctly from a generic failure', () => {
  const outcome = classifyConfluenceCallbackFailure(axiosError(400, 'CONFLUENCE_OAUTH_STATE_INVALID'));
  assert.equal(outcome.kind, 'state-invalid');
});

test('a spent authorization code is reported distinctly, and tells the administrator to restart', () => {
  const outcome = classifyConfluenceCallbackFailure(axiosError(400, 'ATLASSIAN_OAUTH_TOKEN_FAILED'));
  assert.equal(outcome.kind, 'code-spent');
  if (outcome.kind === 'code-spent') {
    assert.match(outcome.message, /restart/i);
    assert.doesNotMatch(outcome.message, /\btry again\b/i);
  }
});

test('an unrecognised failure falls back to the generic outcome', () => {
  const outcome = classifyConfluenceCallbackFailure(serverError());
  assert.equal(outcome.kind, 'failed');
});

test('a successful post reports the connected site', async () => {
  const outcome = await completeConfluenceCallback(
    { code: 'c', state: 's' },
    { refresh: async () => {}, post: async () => ok('https://charity.atlassian.net/wiki') },
  );
  assert.deepEqual(outcome, { kind: 'connected', siteUrl: 'https://charity.atlassian.net/wiki' });
});

// The default wiring is what actually runs in the browser. Asserted through a
// captured adapter rather than a real network call, the way `api.test.ts`
// already asserts other `api` instance behaviour.
//
// NOTE what this test can and cannot see. The adapter receives the config
// axios has already MERGED with the instance defaults, and `lib/api.ts`
// defaults `withCredentials: true` — so this test catches a wrong explicit
// value but NOT a deleted line. The test below it asserts the config as it is
// PASSED to `api.post`, which is the case the comment in
// `confluence-callback.ts` actually claims to defend.
test('the default post sends credentials and never triggers a second, unordered refresh', async () => {
  type CapturedConfig = {
    withCredentials?: boolean;
    skipAuthRefresh?: boolean;
    skipAuthRedirect?: boolean;
    url?: string;
    data?: unknown;
  };

  const originalAdapter = api.defaults.adapter;
  const captured: CapturedConfig[] = [];

  api.defaults.adapter = async (config) => {
    captured.push(config as CapturedConfig);
    return { data: { siteUrl: 'https://x.atlassian.net/wiki' }, status: 200, statusText: 'OK', headers: {}, config };
  };

  try {
    const outcome = await completeConfluenceCallback(
      { code: 'SECRET-CODE', state: 'SECRET-STATE' },
      { refresh: async () => {} },
    );
    assert.equal(outcome.kind, 'connected');
  } finally {
    api.defaults.adapter = originalAdapter;
  }

  assert.equal(captured.length, 1, 'the post must have reached the adapter exactly once');
  const config = captured[0];
  assert.equal(config.withCredentials, true);
  assert.equal(config.skipAuthRefresh, true);
  assert.equal(config.skipAuthRedirect, true);
  assert.equal(config.url, '/integrations/confluence/callback');
  assert.deepEqual(config.data && JSON.parse(config.data as string), { code: 'SECRET-CODE', state: 'SECRET-STATE' });
});

// `withCredentials` is pinned explicitly (see confluence-callback.ts) because
// it must survive on its own even if `lib/api.ts`'s own default ever changes:
// FRONTEND_URL and NEXT_PUBLIC_API_URL can be different hosts on the hosted
// profile, so this call is cross-origin, and a cookie-authenticated request
// that silently drops its cookies fails in exactly the way this page exists
// to prevent.
//
// So it is asserted against the config as PASSED, not as merged. Deleting any
// one of the three lines from the request config must fail here — a merged
// config cannot show that, because the instance default supplies the value
// again on its way through.
test('the post pins its own request config rather than inheriting the instance defaults', async () => {
  const originalPost = api.post;
  const passed: Array<{ url: unknown; data: unknown; config: unknown }> = [];

  (api as unknown as { post: unknown }).post = async (
    url: unknown,
    data: unknown,
    config: unknown,
  ) => {
    passed.push({ url, data, config });
    return { data: { siteUrl: 'https://x.atlassian.net/wiki' } };
  };

  try {
    const outcome = await completeConfluenceCallback(
      { code: 'SECRET-CODE', state: 'SECRET-STATE' },
      { refresh: async () => {} },
    );
    assert.equal(outcome.kind, 'connected');
  } finally {
    (api as unknown as { post: unknown }).post = originalPost;
  }

  assert.equal(passed.length, 1, 'the post must have been called exactly once');
  assert.equal(passed[0].url, '/integrations/confluence/callback');
  assert.deepEqual(passed[0].data, { code: 'SECRET-CODE', state: 'SECRET-STATE' });
  // An exact shape: a missing key fails, a wrong value fails, and an extra
  // key that quietly re-enables the interceptor's own refresh fails too.
  assert.deepEqual(passed[0].config, {
    withCredentials: true,
    skipAuthRefresh: true,
    skipAuthRedirect: true,
  });
});
