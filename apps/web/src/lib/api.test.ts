import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { api } from './api';

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

test('concurrent 401s trigger exactly one token refresh (single-flight)', async () => {
  let refreshCount = 0;

  // The default axios instance handles the /auth/refresh POST.
  axios.defaults.adapter = async (config) => {
    refreshCount += 1;
    return ok(config) as never;
  };

  // The api instance 401s until a request has been retried after the refresh.
  api.defaults.adapter = async (config) => {
    const cfg = config as Cfg;
    if (cfg._retry) return ok(cfg) as never;
    return fail401(cfg);
  };

  const responses = await Promise.all([
    api.get('/board-members'),
    api.get('/deadlines'),
    api.get('/compliance/summary'),
    api.get('/documents'),
  ]);

  assert.equal(refreshCount, 1, 'all concurrent 401s must share a single refresh call');
  for (const r of responses) assert.equal(r.status, 200);
});

test('a request that still 401s after a refresh is rejected (no infinite retry loop)', async () => {
  let refreshCount = 0;
  axios.defaults.adapter = async (config) => {
    refreshCount += 1;
    return ok(config) as never; // refresh "succeeds"
  };
  api.defaults.adapter = async (config) => fail401(config); // but requests keep 401ing

  await assert.rejects(
    () => api.get('/board-members', { skipAuthRedirect: true }),
    (err: unknown) => (err as { response?: { status?: number } })?.response?.status === 401,
  );
  // Exactly one refresh attempt, then give up — no infinite refresh/retry loop.
  assert.equal(refreshCount, 1);
});

test('refreshes the session once then retries the original request on a 401', async () => {
  let refreshCount = 0;
  let attempts = 0;
  axios.defaults.adapter = async (config) => { refreshCount += 1; return ok(config) as never; };
  api.defaults.adapter = async (config) => {
    attempts += 1;
    const cfg = config as Cfg;
    return cfg._retry ? (ok(cfg) as never) : fail401(cfg);
  };

  const res = await api.get('/auth/me');
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
