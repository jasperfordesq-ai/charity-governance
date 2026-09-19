import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, runTool } from '../tools.js';
import { ApiClient } from '../client.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

function clientReturning(payload: unknown): ApiClient {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'charitypilot_access=a1; Path=/');
      headers.append('set-cookie', 'charitypilot_refresh=r2; Path=/');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    },
  });
  return new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  });
}

test('no tool input schema mentions organisationId', () => {
  for (const tool of TOOLS) {
    const serialised = JSON.stringify(tool.inputSchema);
    assert.ok(
      !serialised.includes('organisationId'),
      `${tool.name} accepts an organisationId; the tenant must be derived, never supplied`,
    );
  }
});

test('every tool targets an /api/v1 read path', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.path.startsWith('/api/v1/'), `${tool.name} has a suspicious path`);
  }
});

test('tool names are unique', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('a tool carrying a gated model applies the field policy', async () => {
  const tool = TOOLS.find((t) => t.name === 'board_register');
  assert.ok(tool, 'board_register must exist');

  const result = await runTool(
    tool,
    clientReturning([{ id: 'b1', name: 'A', role: 'Chair', dateOfBirth: '1970-01-01' }]),
    false,
  ) as Record<string, unknown>[];

  assert.ok(!('dateOfBirth' in result[0]!), 'the gate must apply through runTool');
});

test('the gate can be opened deliberately', async () => {
  const tool = TOOLS.find((t) => t.name === 'board_register')!;
  const result = await runTool(
    tool,
    clientReturning([{ id: 'b1', name: 'A', role: 'Chair', dateOfBirth: '1970-01-01' }]),
    true,
  ) as Record<string, unknown>[];

  assert.equal(result[0]!.dateOfBirth, '1970-01-01');
});
