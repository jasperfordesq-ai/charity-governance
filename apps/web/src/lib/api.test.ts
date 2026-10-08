import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { api, logoutSession } from './api';

// Regression guard for the single-flight token refresh: when several requests
// 401 at once (e.g. a dashboard firing parallel GETs after the access token
// expires) they must share ONE /auth/refresh call. Independent refreshes would
// present the same single-use refresh token and trip the backend reuse detection,
// forcing a logout on a normal page load.

type Cfg = { _retry?: boolean; url?: string };

function ok(config: unknown) {
  return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
}

// A custom adapter must reject non-2xx itself (real adapters do this via
// settle()); merely resolving a 401 response would be treated as success.
function fail401(config: unknown): never {
  const error = new Error('Request failed with status code 401');
  Object.assign(error, {
    isAxiosError: true,
    config,
    response: { data: {}, status: 401, statusText: 'Unauthorized', headers: {}, config },
  });
  throw error;
}

async function withNavigatorLocks<T>(locks: unknown, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = globalThis as unknown as { window?: unknown };
  const previousWindow = globals.window;
  const values = new Map<string, string>();
  globals.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
    location: { origin: 'https://app.charitypilot.ie', pathname: '/documents', search: '', href: '' },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  try { return await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
}

const testLocks = { request: async <T>(_name: string, callback: () => Promise<T>) => callback() };

test('logout rejection never refreshes or retries the credential being revoked', async () => {
  let renewals = 0;
  let requests = 0;
  axios.defaults.adapter = async (config) => { renewals += 1; return ok(config) as never; };
  api.defaults.adapter = async (config) => {
    requests += 1;
    assert.equal(config.url, '/auth/logout');
    return fail401(config);
  };
  await assert.rejects(logoutSession());
  assert.equal(requests, 1);
  assert.equal(renewals, 0);
});

test('concurrent 401s trigger exactly one token refresh (single-flight)', async () => {
  let refreshCount = 0;

  let probeCount = 0;
  // The default axios instance handles both the current-session probe and the
  // refresh POST. Count them separately: treating a probe as a refresh would
  // let this regression test pass while no token was actually rotated.
  axios.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/auth/me')) {
      probeCount += 1;
      return { ...ok(config), status: refreshCount ? 200 : 401 } as never;
    }
    assert.ok(config.url?.endsWith('/auth/refresh'));
    refreshCount += 1;
    return ok(config) as never;
  };

  // The api instance 401s until a request has been retried after the refresh.
  api.defaults.adapter = async (config) => {
    const cfg = config as Cfg;
    if (cfg._retry) return ok(cfg) as never;
    return fail401(cfg);
  };

  const responses = await withNavigatorLocks(testLocks, () => Promise.all([
    api.get('/board-members'), api.get('/deadlines'),
    api.get('/compliance/summary'), api.get('/documents'),
  ]));

  assert.equal(probeCount, 1);
  assert.equal(refreshCount, 1, 'all concurrent 401s must share a single refresh call');
  for (const r of responses) assert.equal(r.status, 200);
});

test('a request that still 401s after a refresh is rejected (no infinite retry loop)', async () => {
  let refreshCount = 0;
  axios.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/auth/me')) return { ...ok(config), status: 401 } as never;
    assert.ok(config.url?.endsWith('/auth/refresh'));
    refreshCount += 1;
    return ok(config) as never; // refresh "succeeds"
  };
  api.defaults.adapter = async (config) => fail401(config); // but requests keep 401ing

  await withNavigatorLocks(testLocks, () => assert.rejects(
    () => api.get('/board-members', { skipAuthRedirect: true }),
    (err: unknown) => (err as { response?: { status?: number } })?.response?.status === 401,
  ));
  // Exactly one refresh attempt, then give up — no infinite refresh/retry loop.
  assert.equal(refreshCount, 1);
});

test('refreshes the session once then retries the original request on a 401', async () => {
  let refreshCount = 0;
  let attempts = 0;
  axios.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/auth/me')) return { ...ok(config), status: 401 } as never;
    assert.ok(config.url?.endsWith('/auth/refresh'));
    refreshCount += 1;
    return ok(config) as never;
  };
  api.defaults.adapter = async (config) => {
    attempts += 1;
    const cfg = config as Cfg;
    return cfg._retry ? (ok(cfg) as never) : fail401(cfg);
  };

  const res = await withNavigatorLocks(testLocks, () => api.get('/auth/me'));
  assert.equal(res.status, 200, 'the retried request succeeds transparently after a refresh');
  assert.equal(refreshCount, 1, 'exactly one refresh');
  assert.equal(attempts, 2, 'the original request is attempted once, then retried once');
});

test('does not refresh or retry when skipAuthRefresh is set', async () => {
  let refreshCount = 0;
  let attempts = 0;
  axios.defaults.adapter = async (config) => { refreshCount += 1; return ok(config) as never; };
  api.defaults.adapter = async (config) => { attempts += 1; return fail401(config); };

  await assert.rejects(
    () => api.post('/auth/login', { email: 'a@b.com' }, { skipAuthRefresh: true, skipAuthRedirect: true }),
    (err: unknown) => (err as { response?: { status?: number } })?.response?.status === 401,
  );
  // Auth endpoints opt out of the refresh dance so they surface an inline error,
  // not a silent refresh/redirect.
  assert.equal(refreshCount, 0, 'no refresh is attempted');
  assert.equal(attempts, 1, 'the request is tried once and rejected, not retried');
});

test('only successful login or invite acceptance clears an ambiguous sign-out fence', async () => {
  const key = 'charitypilot:session-refresh-stamp';
  const values = new Map([[key, 'logout:possibly-revoked']]);
  const globals = globalThis as unknown as { window?: { localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } } };
  const previousWindow = globals.window;
  globals.window = { localStorage: {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value); },
  } };
  try {
    api.defaults.adapter = async (config) => fail401(config);
    await assert.rejects(api.post('/auth/login', {}, { skipAuthRefresh: true, skipAuthRedirect: true }));
    assert.equal(values.get(key), 'logout:possibly-revoked');

    api.defaults.adapter = async (config) => ok(config) as never;
    await api.post('/auth/login', {});
    assert.match(values.get(key) ?? '', /^login:/);
    values.set(key, 'logout:another-attempt');
    await api.post('/team/accept-invite', {});
    assert.match(values.get(key) ?? '', /^login:/);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('unwraps a single-resource { data } envelope so callers read the resource directly', async () => {
  api.defaults.adapter = async (config) => ({
    data: { data: { id: 'org_1', name: 'Charity' } }, status: 200, statusText: 'OK', headers: {}, config,
  }) as never;

  const res = await api.get('/organisation');
  assert.deepEqual(res.data, { id: 'org_1', name: 'Charity' });
});

test('leaves a paginated { data, total, page } envelope intact', async () => {
  api.defaults.adapter = async (config) => ({
    data: { data: [{ id: 1 }, { id: 2 }], total: 2, page: 1 }, status: 200, statusText: 'OK', headers: {}, config,
  }) as never;

  const res = await api.get('/documents');
  // Pagination metadata must survive — unwrapping it would hide total/page from the UI.
  assert.equal(res.data.total, 2);
  assert.equal(res.data.page, 1);
  assert.deepEqual(res.data.data, [{ id: 1 }, { id: 2 }]);
});

test('leaves a cursor-paginated { data, nextCursor } envelope intact', async () => {
  api.defaults.adapter = async (config) => ({
    data: { data: [{ eventId: 'event_1' }], nextCursor: 'event_1' },
    status: 200, statusText: 'OK', headers: {}, config,
  }) as never;

  const res = await api.get('/team/replay-diagnostics');
  assert.deepEqual(res.data, { data: [{ eventId: 'event_1' }], nextCursor: 'event_1' });
});

test('preserves unfamiliar response metadata beside data', async () => {
  api.defaults.adapter = async (config) => ({
    data: { data: [{ eventId: 'event_1' }], hasMore: true },
    status: 200, statusText: 'OK', headers: {}, config,
  }) as never;

  const res = await api.get('/governance-audit');
  assert.deepEqual(res.data, { data: [{ eventId: 'event_1' }], hasMore: true });
});

// ── the 401 interceptor's own login redirect ────────────────────────────────
//
// `redirectToLoginOnProtectedRoute` is the THIRD place that builds
// `/login?next=…`, after the middleware and the dashboard layout. It had no
// test in either direction, and it built `next` from the raw
// `window.location.search` — so on the Confluence callback path it would carry
// Atlassian's live `?code=…&state=…` into the Location, the address bar, the
// history entry and the proxy access log (whose filter deletes only TOP-LEVEL
// `code`/`state`, never one nested inside `next`).
//
// It does not fire on that path today, because both calls the flow makes set
// `skipAuthRedirect`. That is a per-call-site convention, not a guarantee —
// one future call added without the flag reopens it. These drive the real
// interceptor, through the real axios instance, rather than the function.

const LIVE_CODE = 'LIVE-AUTHORIZATION-CODE';
const LIVE_STATE = 'LIVE-OAUTH-STATE';

type FakeWindow = { location: { origin: string; pathname: string; search: string; href: string } };

/**
 * Install a fake `window` for the duration of one call and collect every
 * `location.href` the interceptor assigns. Returns whatever it navigated to,
 * or null if it deliberately stayed put.
 */
async function navigationFrom(pathname: string, search: string, alreadyRetried = true): Promise<string | null> {
  const assigned: string[] = [];
  const globals = globalThis as unknown as { window?: FakeWindow };
  const originalWindow = globals.window;

  globals.window = {
    location: {
      origin: 'https://app.charitypilot.ie',
      pathname,
      search,
      get href() {
        return `https://app.charitypilot.ie${pathname}${search}`;
      },
      set href(value: string) {
        assigned.push(value);
      },
    },
  };

  try {
    // Most callers exercise the second 401 branch. A no-lock test below lets
    // the interceptor attempt its reactive renewal first.
    await assert.rejects(api.get('/anything', { _retry: alreadyRetried }));
  } finally {
    if (originalWindow === undefined) delete globals.window;
    else globals.window = originalWindow;
  }

  assert.ok(assigned.length <= 1, `at most one navigation, got ${assigned.length}`);
  return assigned[0] ?? null;
}

test('a 401 on a protected route still redirects to login with a usable next', async () => {
  api.defaults.adapter = async (config) => fail401(config);

  const destination = await navigationFrom('/documents', '?view=board');

  assert.equal(
    destination,
    `/login?next=${encodeURIComponent('/documents?view=board')}`,
    'the redirect must survive, and must still carry where the visitor was going',
  );
});

test('without Web Locks an expired 401 redirects to sign-in without a refresh POST', async () => {
  let refreshCount = 0;
  axios.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/auth/me')) return { ...ok(config), status: 401 } as never;
    if (config.url?.endsWith('/auth/refresh')) refreshCount += 1;
    return ok(config) as never;
  };
  api.defaults.adapter = async (config) => fail401(config);
  const destination = await withNavigatorLocks(undefined, () =>
    navigationFrom('/documents', '?view=board', false));
  assert.equal(destination,
    `/login?next=${encodeURIComponent('/documents?view=board')}&session=renewal-unavailable`);
  assert.equal(refreshCount, 0);
});

test('a 401 on the Confluence callback never redirects, and never leaks the code', async () => {
  api.defaults.adapter = async (config) => fail401(config);

  const destination = await navigationFrom(
    '/integrations/confluence/callback',
    `?code=${LIVE_CODE}&state=${LIVE_STATE}`,
  );

  assert.equal(
    destination,
    null,
    'the callback page renews the session itself — the interceptor must not redirect it away',
  );
});

test('a 401 on any protected route strips code and state out of next', async () => {
  api.defaults.adapter = async (config) => fail401(config);

  const destination = await navigationFrom(
    '/documents',
    `?view=board&code=${LIVE_CODE}&state=${LIVE_STATE}`,
  );

  assert.ok(destination, 'a protected route must still reach /login');
  assert.equal(
    destination.includes(LIVE_CODE),
    false,
    `no single-use secret may be nested inside next: ${destination}`,
  );
  assert.equal(destination.includes(LIVE_STATE), false, destination);
  assert.equal(destination, `/login?next=${encodeURIComponent('/documents?view=board')}`);
});

test('a 401 on a public route redirects nowhere at all', async () => {
  api.defaults.adapter = async (config) => fail401(config);

  assert.equal(await navigationFrom('/login', ''), null);
  assert.equal(await navigationFrom('/', ''), null);
});

test('skipAuthRedirect still suppresses the redirect entirely', async () => {
  api.defaults.adapter = async (config) => fail401(config);

  const assigned: string[] = [];
  const globals = globalThis as unknown as { window?: FakeWindow };
  const originalWindow = globals.window;
  globals.window = {
    location: {
      origin: 'https://app.charitypilot.ie',
      pathname: '/documents',
      search: '?view=board',
      get href() {
        return 'https://app.charitypilot.ie/documents?view=board';
      },
      set href(value: string) {
        assigned.push(value);
      },
    },
  };

  try {
    await assert.rejects(api.get('/anything', { _retry: true, skipAuthRedirect: true }));
  } finally {
    if (originalWindow === undefined) delete globals.window;
    else globals.window = originalWindow;
  }

  assert.deepEqual(assigned, [], 'skipAuthRedirect must keep working as the opt-out it is');
});

