import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../tools.js';
import {
  createLevelResolver,
  fetchSessionPosture,
  permits,
  refusalFor,
  toolsFor,
} from '../session-level.js';
import { buildToolList } from '../server.js';
import { ApiClient } from '../client.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

function clientReturning(response: () => Response): ApiClient {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () =>
      new Response(JSON.stringify({ accessToken: 'a1', refreshToken: 'r2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  return new ApiClient({ session, baseUrl: 'https://example.test', fetchImpl: async () => response() });
}

test('a read-level session is offered no tool that changes anything', () => {
  const offered = toolsFor('read', TOOLS);

  assert.ok(offered.length > 0, 'a read session must still be able to read');
  assert.deepEqual(
    offered.filter((tool) => tool.method !== undefined).map((tool) => tool.name),
    [],
  );
});

test('a write-level session is offered the writes but not the removals', () => {
  const names = toolsFor('write', TOOLS).map((tool) => tool.name);

  assert.ok(names.includes('deadline_update'));
  assert.ok(!names.includes('board_member_delete'), 'deleting needs administrator access');
});

test('an administrator-level session is offered everything the gate allows', () => {
  // The level and the gate are independent: the level says how much authority
  // the session carries, the gate says whether personal data may travel.
  assert.equal(toolsFor('admin', TOOLS, true).length, TOOLS.length);
  assert.ok(toolsFor('admin', TOOLS, false).length < TOOLS.length);
});

test('a write whose fields the gate withholds is not offered while it is closed', () => {
  const closed = toolsFor('admin', TOOLS, false).map((tool) => tool.name);
  const open = toolsFor('admin', TOOLS, true).map((tool) => tool.name);

  assert.ok(
    open.includes('conflict_create'),
    'a conflict record names a person and a matter; those fields are the record',
  );
  assert.ok(!closed.includes('conflict_create'));
});

test('the advertised list narrows with the level', () => {
  assert.ok(buildToolList('read').length < buildToolList('write').length);
  assert.ok(buildToolList('write').length < buildToolList('admin').length);
});

test('the refusal says what would have to change, and that a person must do it', () => {
  const tool = TOOLS.find((t) => t.name === 'board_member_delete')!;
  const message = refusalFor('write', tool);

  assert.match(message, /needs a session with admin access/);
  assert.match(message, /this one has write access/);
  assert.match(message, /Nothing was sent/);
  assert.match(message, /connect --access-level admin/);
});

test('the level is read from the API, not from the flag the connector was started with', async () => {
  const client = clientReturning(() =>
    new Response(JSON.stringify({ accessLevel: 'READ', role: 'OWNER' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  const posture = await fetchSessionPosture(client);

  assert.deepEqual(posture, { accessLevel: 'read', role: 'OWNER' });
});

test('an API that cannot answer leaves the level unknown rather than guessing', async () => {
  const client = clientReturning(() => new Response('{}', { status: 404 }));

  assert.equal(
    await fetchSessionPosture(client),
    null,
    'an older API must not stop the connector starting',
  );
});

test('a level the connector does not recognise is treated as unknown', async () => {
  const client = clientReturning(() =>
    new Response(JSON.stringify({ accessLevel: 'SUPERUSER' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  assert.equal(await fetchSessionPosture(client), null);
});

test('permits is ordinal, so each level includes the ones below it', () => {
  const read = TOOLS.find((t) => t.name === 'compliance_summary')!;
  const write = TOOLS.find((t) => t.name === 'deadline_create')!;
  const destroy = TOOLS.find((t) => t.name === 'risk_delete')!;

  assert.equal(permits('read', read), true);
  assert.equal(permits('read', write), false);
  assert.equal(permits('read', destroy), false);

  assert.equal(permits('write', read), true);
  assert.equal(permits('write', write), true);
  assert.equal(permits('write', destroy), false);

  assert.equal(permits('admin', read), true);
  assert.equal(permits('admin', write), true);
  assert.equal(permits('admin', destroy), true);
});

test('an unknown posture is not cached, so a later answer replaces the fallback', async () => {
  const answers: Array<{ accessLevel: 'read' | 'write' | 'admin'; role: string } | null> = [null, { accessLevel: 'read', role: 'MEMBER' }];
  let asked = 0;
  const level = createLevelResolver(async () => { asked += 1; return answers.shift() ?? null; }, 'write');

  assert.equal(await level(), 'write', 'the fallback stands in while the API cannot answer');
  assert.equal(await level(), 'read', 'the next call asks again and gets the real level');
  assert.equal(await level(), 'read');
  assert.equal(asked, 2, 'once known, the level is not fetched again');
});
