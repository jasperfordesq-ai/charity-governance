import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSessionInfo, SESSION_INFO_TOOL } from '../session-info.js';
import { ApiClient } from '../client.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

function client(answers: Record<string, unknown>): ApiClient {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () => new Response(JSON.stringify({ accessToken: 'a1', refreshToken: 'r2' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  });
  return new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      const body = answers[path];
      return body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
}

const ME = {
  email: 'owner@harness.ie',
  name: 'Owner Person',
  role: 'OWNER',
  organisationId: 'org-1',
  organisation: { name: 'Harness Charity' },
};

test('session_info names the charity, role and level, and withholds the person while the gate is closed', async () => {
  const info = await runSessionInfo(
    client({ '/api/v1/auth/me': ME, '/api/v1/auth/connector/session': { accessLevel: 'WRITE', role: 'OWNER' } }),
    { baseUrl: 'https://example.test', allowPersonalData: false },
  );
  const text = JSON.stringify(info);
  assert.match(text, /Harness Charity/);
  assert.match(text, /"accessLevel":"write"/);
  assert.match(text, /"role":"OWNER"/);
  assert.match(text, /"personalData":"withheld"/);
  assert.ok(!text.includes('owner@harness.ie'));
  assert.ok(!text.includes('Owner Person'));
});

test('with the gate open the person is named', async () => {
  const info = await runSessionInfo(
    client({ '/api/v1/auth/me': ME, '/api/v1/auth/connector/session': { accessLevel: 'READ', role: 'OWNER' } }),
    { baseUrl: 'https://example.test', allowPersonalData: true },
  );
  const text = JSON.stringify(info);
  assert.match(text, /owner@harness.ie/);
  assert.match(text, /"accessLevel":"read"/);
});

test('an API that cannot report the level says so rather than guessing', async () => {
  const info = await runSessionInfo(
    client({ '/api/v1/auth/me': ME }),
    { baseUrl: 'https://example.test', allowPersonalData: false },
  );
  assert.equal((info['session'] as Record<string, unknown>)['accessLevel'], null);
});

test('the tool is read-only and takes no arguments', () => {
  assert.equal(SESSION_INFO_TOOL.annotations.readOnlyHint, true);
  assert.deepEqual((SESSION_INFO_TOOL.inputSchema as { properties: object }).properties, {});
});
