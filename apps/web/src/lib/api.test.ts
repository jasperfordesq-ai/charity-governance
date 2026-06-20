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
