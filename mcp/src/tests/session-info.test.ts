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

test('a session that withholds personal data overrides a process that was told otherwise', async () => {
  const info = await runSessionInfo(
    client({
      '/api/v1/auth/me': ME,
      '/api/v1/auth/connector/session': { accessLevel: 'ADMIN', dataScope: 'WITHHELD', role: 'OWNER' },
    }),
    // Started with the flag on. The session says no, and the session holds it.
    { baseUrl: 'https://example.test', allowPersonalData: true },
  );

  const text = JSON.stringify(info);
  assert.match(text, /"dataScope":"withheld"/);
  assert.ok(!text.includes('owner@harness.ie'), 'the flag must not reopen what the session closed');
});

test('a session that allows personal data releases it, whatever the process was told', async () => {
  const info = await runSessionInfo(
    client({
      '/api/v1/auth/me': ME,
      '/api/v1/auth/connector/session': { accessLevel: 'ADMIN', dataScope: 'FULL', role: 'OWNER' },
    }),
    { baseUrl: 'https://example.test', allowPersonalData: false },
  );

  assert.match(JSON.stringify(info), /owner@harness.ie/);
});

// ── which build is on the other end ────────────────────────────────────────

test('session_info reports the API build beside its own', async () => {
  const info = await runSessionInfo(
    client({
      '/api/v1/auth/me': ME,
      '/api/v1/auth/connector/session': { accessLevel: 'WRITE', role: 'OWNER', dataScope: 'WITHHELD' },
      '/api/v1/health': { status: 'ok', build: { version: '0.1.0', revision: 'abc1234' } },
    }),
    { baseUrl: 'https://example.test', allowPersonalData: false },
  );

  const api = info.api as Record<string, unknown>;
  assert.equal(api.version, '0.1.0');
  assert.equal(api.revision, 'abc1234');
  assert.equal(api.note, undefined, 'matching builds need no warning');
});

test('a connector newer than the API says so, because the symptom is otherwise a bare 404', async () => {
  const info = await runSessionInfo(
    client({
      '/api/v1/auth/me': ME,
      '/api/v1/auth/connector/session': { accessLevel: 'WRITE', role: 'OWNER', dataScope: 'WITHHELD' },
      '/api/v1/health': { status: 'ok', build: { version: '0.0.9', revision: null } },
    }),
    { baseUrl: 'https://example.test', allowPersonalData: false },
  );

  const api = info.api as Record<string, unknown>;
  assert.equal(api.version, '0.0.9');
  assert.match(String(api.note), /0\.0\.9/);
  assert.match(String(api.note), /until CharityPilot is updated/);
});

test('an API newer than the connector is not a warning', async () => {
  const info = await runSessionInfo(
    client({
      '/api/v1/auth/me': ME,
      '/api/v1/auth/connector/session': { accessLevel: 'WRITE', role: 'OWNER', dataScope: 'WITHHELD' },
      '/api/v1/health': { status: 'ok', build: { version: '9.9.9', revision: null } },
    }),
    { baseUrl: 'https://example.test', allowPersonalData: false },
  );

  assert.equal((info.api as Record<string, unknown>).note, undefined);
});

test('a build that cannot say which version it is produces no warning at all', async () => {
  for (const health of [undefined, { status: 'ok' }, { status: 'ok', build: { version: null } }]) {
    const answers: Record<string, unknown> = {
      '/api/v1/auth/me': ME,
      '/api/v1/auth/connector/session': { accessLevel: 'WRITE', role: 'OWNER', dataScope: 'WITHHELD' },
    };
    if (health !== undefined) answers['/api/v1/health'] = health;

    const info = await runSessionInfo(client(answers), {
      baseUrl: 'https://example.test',
      allowPersonalData: false,
    });

    const api = info.api as Record<string, unknown>;
    assert.equal(api.version, null);
    assert.equal(api.note, undefined, 'a silent build must not be reported as out of date');
  }
});
