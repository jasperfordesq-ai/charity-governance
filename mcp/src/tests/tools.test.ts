import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, runTool } from '../tools.js';
import { buildToolList } from '../server.js';
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

test('no advertised input schema mentions organisationId', () => {
  // Walks what clients are actually told they may send, which is generated,
  // rather than a field on the registry literal that no longer exists.
  for (const tool of buildToolList()) {
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

// GET /api/v1/board-members does not return a bare array. The route handler
// returns BoardMemberService#list's result directly (no sendSuccess wrapper),
// which is the paginated envelope: { data, total, page, pageSize, hasMore }.
// A stub that returns a bare array here would hide exactly the bug FIX 2
// exists to catch — applyFieldPolicy dropping "data" itself because none of
// the five envelope keys are in SAFE_FIELDS.BoardMember.
function boardMembersEnvelope() {
  return {
    data: [{ id: 'b1', name: 'A', role: 'Chair', dateOfBirth: '1970-01-01' }],
    total: 1,
    page: 1,
    pageSize: 50,
    hasMore: false,
  };
}

test('a tool carrying a gated model applies the field policy', async () => {
  const tool = TOOLS.find((t) => t.name === 'board_register');
  assert.ok(tool, 'board_register must exist');

  const result = await runTool(
    tool,
    clientReturning(boardMembersEnvelope()),
    false,
  ) as { data: Record<string, unknown>[] };

  assert.ok(!('dateOfBirth' in result.data[0]!), 'the gate must apply through runTool');
});

test('the gate can be opened deliberately', async () => {
  const tool = TOOLS.find((t) => t.name === 'board_register')!;
  const result = await runTool(
    tool,
    clientReturning(boardMembersEnvelope()),
    true,
  ) as { data: Record<string, unknown>[] };

  assert.equal(result.data[0]!.dateOfBirth, '1970-01-01');
});

test('the paginated envelope survives the gate: pagination fields kept, records filtered', async () => {
  const tool = TOOLS.find((t) => t.name === 'board_register')!;
  const result = await runTool(
    tool,
    clientReturning(boardMembersEnvelope()),
    false,
  ) as Record<string, unknown> & { data: Record<string, unknown>[] };

  assert.equal(result.total, 1);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50);
  assert.equal(result.hasMore, false);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]!.name, 'A');
  assert.ok(!('dateOfBirth' in result.data[0]!), 'record fields inside the envelope must still be filtered');
});

test('with the gate open, the envelope is returned untouched', async () => {
  const tool = TOOLS.find((t) => t.name === 'board_register')!;
  const envelope = boardMembersEnvelope();
  const result = await runTool(tool, clientReturning(envelope), true);
  assert.deepEqual(result, envelope);
});

test('governing_acts withholds resolution text and the conflict-record join key', async () => {
  const tool = TOOLS.find((t) => t.name === 'governing_acts');
  assert.ok(tool, 'governing_acts must exist');
  assert.equal(tool!.model, 'GoverningAct');

  const act = {
    id: 'ga1', organisationId: 'o1', kind: 'BOARD_MEETING', status: 'APPROVED',
    actDate: '2026-01-01', reference: 'M-1', title: 'January board meeting',
    notes: 'Off-the-record discussion naming a trustee',
    resolutions: [
      { id: 'r1', text: 'Resolved to approve the accounts', abstentions: 'Jane Doe abstained', conflictRecordId: 'cr1' },
    ],
  };

  // A bare array here, like the board-members fix, would miss that
  // GET /api/v1/governing-acts is wrapped by sendSuccess as { data: [...] }.
  const result = await runTool(tool!, clientReturning({ data: [act] }), false) as { data: Record<string, unknown>[] };
  const [out] = result.data;

  assert.ok(out, 'the act must survive filtering');
  assert.equal(out!.id, 'ga1');
  assert.equal(out!.reference, 'M-1');
  assert.equal(out!.status, 'APPROVED');
  assert.ok(!('notes' in out!), 'the free-text notes field must be withheld');
  assert.ok(!('resolutions' in out!), 'resolution text (and the conflictRecordId it carries) must not reach the model');
});

test('governing_acts returns resolutions when the gate is opened', async () => {
  const tool = TOOLS.find((t) => t.name === 'governing_acts')!;
  const act = {
    id: 'ga1', organisationId: 'o1', kind: 'BOARD_MEETING', status: 'APPROVED',
    actDate: '2026-01-01', reference: 'M-1', title: 'January board meeting',
    notes: 'Off-the-record discussion naming a trustee',
    resolutions: [{ id: 'r1', text: 'Resolved to approve the accounts' }],
  };

  const result = await runTool(tool, clientReturning({ data: [act] }), true) as { data: Record<string, unknown>[] };
  assert.deepEqual(result.data[0], act);
});
