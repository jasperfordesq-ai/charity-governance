import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
});

test('server-side protected route refresh sends the deployed web Origin required by the API origin guard', async () => {
  process.env.NODE_ENV = 'production';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';

  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: input.toString(), init });

    if (input.toString().endsWith('/api/v1/auth/me')) {
      return new Response(null, { status: 401 });
    }

    if (input.toString().endsWith('/api/v1/auth/refresh')) {
      return new Response(null, {
        status: 200,
        headers: {
          'Set-Cookie': 'charitypilot_access=rotated; Path=/; HttpOnly; Secure; SameSite=Lax',
        },
      });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  await proxy(new NextRequest('https://app.charitypilot.ie/dashboard', {
    headers: {
      cookie: 'charitypilot_access=expired-access; charitypilot_refresh=valid-refresh',
    },
  }));

  const refreshCall = fetchCalls.find((call) => call.url.endsWith('/api/v1/auth/refresh'));
  assert.ok(refreshCall, 'expected proxy to call the refresh endpoint');
  assert.equal(new Headers(refreshCall.init?.headers).get('Origin'), 'https://app.charitypilot.ie');
});

test('server-side protected route validation fails closed for unapproved production API origins', async () => {
  process.env.NODE_ENV = 'production';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.attacker.example';

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const response = await proxy(new NextRequest('https://app.charitypilot.ie/dashboard', {
    headers: {
      cookie: 'charitypilot_access=sensitive-access; charitypilot_refresh=sensitive-refresh',
    },
  }));

  assert.deepEqual(fetchCalls, []);
  assert.equal(response.headers.get('location'), 'https://app.charitypilot.ie/login?next=%2Fdashboard');
});
