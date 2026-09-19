import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TOOLS, runTool, toolInputSchema } from '../tools.js';
import { WRITE_TOOLS } from '../write-tools.js';
import { buildBody } from '../tool-body.js';
import { ApiClient } from '../client.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');

/** A session that hands out an access token without talking to anything. */
function client(
  fetchImpl: typeof fetch,
): ApiClient {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () =>
      new Response(JSON.stringify({ accessToken: 'a1', refreshToken: 'r2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  return new ApiClient({ session, baseUrl: 'https://example.test', fetchImpl });
}

function jsonOk(body: unknown = { data: { id: 'x' } }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('every write tool names a route the API actually registers', () => {
  const missing: string[] = [];

  for (const tool of WRITE_TOOLS) {
    const withoutPrefix = tool.path.replace('/api/v1/', '');
    const group = withoutPrefix.split('/')[0]!;
    const subPath = `/${withoutPrefix.slice(group.length + 1)}`.replace(/\/$/, '') || '/';

    const source = readFileSync(
      resolve(REPO, 'apps/api/src/routes', group, 'index.ts'),
      'utf8',
    );

    const method = tool.method!.toLowerCase();
    const registered = new RegExp(
      `[A-Za-z]*[Aa]pp\\.${method}(?:<[^(]*>)?\\(\\s*'${subPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
    ).test(source);

    if (!registered) missing.push(`${tool.name}: ${tool.method} ${tool.path}`);
  }

  assert.deepEqual(
    missing,
    [],
    'a write tool pointing at a route that does not exist fails only when somebody tries it',
  );
});

test('no write tool can set a personal-data field', () => {
  // The gate holds these back on the way out. Accepting them on the way in
  // would let an agent put a date of birth or a home address into a register,
  // which is not a thing an agent should be doing on anyone's behalf.
  const withheld = [
    'dateOfBirth',
    'residentialAddress',
    'formerNames',
    'otherDirectorships',
    'email',
  ];

  const offences: string[] = [];
  for (const tool of WRITE_TOOLS) {
    for (const field of tool.body ?? []) {
      if (withheld.includes(field.name)) offences.push(`${tool.name}.${field.name}`);
    }
  }

  assert.deepEqual(offences, []);
});

test('the fields each tool declares exist in the API schema it posts to', () => {
  // The shared request types are hand-written and are not inferred from the
  // schemas, so a field renamed on the API side would otherwise be discovered
  // by a caller rather than by a test.
  const schemaSources = [
    'board-member',
    'compliance',
    'deadline',
    'governance-registers',
    'governing-acts',
  ]
    .map((name) =>
      readFileSync(resolve(REPO, 'packages/shared/src/schemas', `${name}.ts`), 'utf8'),
    )
    .join('\n');

  const unknown: string[] = [];
  for (const tool of WRITE_TOOLS) {
    for (const field of tool.body ?? []) {
      if (!new RegExp(`\\b${field.name}\\s*:`).test(schemaSources)) {
        unknown.push(`${tool.name}.${field.name}`);
      }
    }
  }

  assert.deepEqual(
    unknown,
    [],
    'these fields are not in any shared request schema, so the API will reject or ignore them',
  );
});

test('a field the tool does not declare is refused, not forwarded', () => {
  const tool = WRITE_TOOLS.find((t) => t.name === 'deadline_create')!;

  assert.throws(
    () => buildBody(tool.body!, { title: 'x', dueDate: '2026-01-01', isAdmin: true }),
    /Unknown field "isAdmin"/,
  );
});

test('a required field that is missing is refused before anything is sent', () => {
  const tool = WRITE_TOOLS.find((t) => t.name === 'deadline_create')!;

  assert.throws(() => buildBody(tool.body!, { title: 'x' }), /dueDate is required/);
});

test('an omitted optional field is absent, so a patch cannot blank a column', () => {
  const tool = WRITE_TOOLS.find((t) => t.name === 'board_member_update')!;
  const body = buildBody(tool.body!, { name: 'New Name' });

  assert.deepEqual(body, { name: 'New Name' });
  assert.ok(!('role' in body), 'an untouched column must not be sent as null');
});

test('a date must be a date, and a loose string is refused', () => {
  const tool = WRITE_TOOLS.find((t) => t.name === 'deadline_create')!;

  assert.throws(
    () => buildBody(tool.body!, { title: 'x', dueDate: 'next Tuesday' }),
    /dueDate must be a date/,
  );
  assert.doesNotThrow(() => buildBody(tool.body!, { title: 'x', dueDate: '2026-04-01' }));
});

test('the concurrency stamp must be the value read, not a guess at one', () => {
  const tool = WRITE_TOOLS.find((t) => t.name === 'deadline_update')!;

  assert.throws(
    () => buildBody(tool.body!, { expectedUpdatedAt: '2026-04-01' }),
    /copied exactly as it was read/,
  );
  assert.doesNotThrow(() =>
    buildBody(tool.body!, { expectedUpdatedAt: '2026-04-01T10:00:00.000Z' }),
  );
});

test('a write sends the method, the body and the reason it was given', async () => {
  const seen: Array<{ method: string; url: string; headers: Headers; body: string }> = [];
  const api = client(async (input, init) => {
    seen.push({
      method: String(init?.method),
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    return jsonOk();
  });

  const tool = WRITE_TOOLS.find((t) => t.name === 'deadline_create')!;
  await runTool(tool, api, false, {
    title: 'File the annual return',
    dueDate: '2026-11-04',
    reason: 'The owner asked for it',
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.url, 'https://example.test/api/v1/deadlines');
  assert.equal(seen[0]!.headers.get('x-charitypilot-reason'), 'The owner asked for it');
  assert.deepEqual(JSON.parse(seen[0]!.body), {
    title: 'File the annual return',
    dueDate: '2026-11-04',
  });
});

test('the reason is not smuggled into the body it explains', async () => {
  let body = '';
  const api = client(async (_input, init) => {
    body = String(init?.body);
    return jsonOk();
  });

  const tool = WRITE_TOOLS.find((t) => t.name === 'deadline_create')!;
  await runTool(tool, api, false, {
    title: 'x',
    dueDate: '2026-11-04',
    reason: 'because',
  });

  assert.ok(!Object.keys(JSON.parse(body)).includes('reason'));
});

test('a destructive tool refuses to act without a reason', async () => {
  const api = client(async () => {
    throw new Error('nothing should reach the API');
  });
  const tool = WRITE_TOOLS.find((t) => t.name === 'board_member_delete')!;

  await assert.rejects(
    () => runTool(tool, api, false, { id: 'clx-1' }),
    /removes something permanently/,
  );
});

test('a destructive tool passes the approval identifier on when it has one', async () => {
  let approval: string | null = null;
  const api = client(async (_input, init) => {
    approval = new Headers(init?.headers).get('x-charitypilot-approval');
    return jsonOk({ ok: true });
  });

  const tool = WRITE_TOOLS.find((t) => t.name === 'risk_delete')!;
  await runTool(tool, api, false, {
    id: 'clx-9',
    reason: 'Duplicate entry',
    approvalId: 'apr-7',
  });

  assert.equal(approval, 'apr-7');
});

test('the record a write returns goes through the same gate a read would', async () => {
  const api = client(async () =>
    jsonOk({
      data: {
        id: 'bm-1',
        name: 'Aoife Chairperson',
        role: 'Chair',
        dateOfBirth: '1968-03-14',
        residentialAddress: '1 Example Street',
      },
    }),
  );

  const tool = WRITE_TOOLS.find((t) => t.name === 'board_member_create')!;
  const result = (await runTool(tool, api, false, {
    name: 'Aoife Chairperson',
    role: 'Chair',
    appointedDate: '2024-01-15',
  })) as { data: Record<string, unknown> };

  assert.ok(!('dateOfBirth' in result.data), 'a write is not a way around the policy');
  assert.ok(!('residentialAddress' in result.data));
  assert.equal(result.data['name'], 'Aoife Chairperson');
});

test('a write tool advertises a reason, and a destructive one an approval too', () => {
  const write = toolInputSchema(WRITE_TOOLS.find((t) => t.name === 'deadline_create')!) as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(write.properties['reason']);
  assert.ok(!write.properties['approvalId'], 'nothing here needs approving');
  assert.ok(!(write.required ?? []).includes('reason'));

  const destructive = toolInputSchema(
    WRITE_TOOLS.find((t) => t.name === 'board_member_delete')!,
  ) as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(destructive.properties['approvalId']);
  assert.ok(
    (destructive.required ?? []).includes('reason'),
    'a removal must say why, and the reason is recorded against it',
  );
});

test('a read tool advertises neither, so nothing suggests a read can be approved', () => {
  const read = toolInputSchema(TOOLS.find((t) => t.name === 'compliance_summary')!) as {
    properties: Record<string, unknown>;
  };

  assert.ok(!read.properties['reason']);
  assert.ok(!read.properties['approvalId']);
});

test('the tool list is reads first, then writes, and the names are unique', () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'two tools may not share a name');

  const firstWrite = TOOLS.findIndex((tool) => tool.method !== undefined);
  assert.ok(firstWrite > 0);
  assert.ok(
    TOOLS.slice(firstWrite).every((tool) => tool.method !== undefined),
    'a person scanning the list should meet everything that only looks before anything that changes',
  );
});

test('every destructive tool is administrator level, and every write at least write level', () => {
  for (const tool of WRITE_TOOLS) {
    assert.ok(tool.level, `${tool.name} must declare a level`);
    if (tool.destructive) {
      assert.equal(tool.level, 'admin', `${tool.name} destroys something`);
    } else {
      assert.notEqual(tool.level, 'read', `${tool.name} changes something`);
    }
  }
});
