import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../config.js';
import { accountForOrigin } from '../credentials.js';
import { buildToolList } from '../server.js';
import { OPERATOR_TOOLS, OPERATOR_TOOL_NAMES } from '../operator-tools.js';
import { TOOLS } from '../tools.js';
import { FILE_TOOLS } from '../file-tools.js';
import { startServer } from '../server.js';
import { INSTRUCTIONS } from '../instructions.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * The operator realm, from the connector's side.
 *
 * The claim these tests exist to hold is one sentence: a connector signed in
 * as a platform operator can administer every charity and cannot read inside
 * any of them. Everything below is that sentence, checked from a different
 * angle each time.
 */

// ---------------------------------------------------------------------------
// The realm is chosen deliberately, and says no to what it cannot do
// ---------------------------------------------------------------------------

test('the charity realm is the default, so nothing changes for an existing invocation', () => {
  assert.equal(parseArgs(['connect']).realm, 'charity');
});

test('--realm operator is carried through', () => {
  assert.equal(parseArgs(['connect', '--realm', 'operator']).realm, 'operator');
});

test('an unknown realm names the ones that exist', () => {
  assert.throws(
    () => parseArgs(['connect', '--realm', 'admin']),
    /Unknown realm: admin.*charity, operator/s,
  );
});

test('the operator realm refuses a data scope rather than ignoring one', () => {
  // Accepting and ignoring it would leave somebody believing they had
  // connected a session that can read a charity's records.
  for (const argv of [
    ['connect', '--realm', 'operator', '--data-scope', 'full'],
    ['connect', '--realm', 'operator', '--allow-personal-data'],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      /never sees personal data/,
      `${argv.join(' ')} must be refused, not quietly dropped`,
    );
  }
});

test('the operator realm still accepts an explicitly withheld scope', () => {
  // "withheld" is what the realm already is, so asking for it is redundant
  // rather than wrong, and refusing it would be pedantry.
  assert.equal(
    parseArgs(['connect', '--realm', 'operator', '--data-scope', 'withheld']).realm,
    'operator',
  );
});

test('the operator realm refuses document directories and toolsets', () => {
  assert.throws(
    () => parseArgs(['serve', '--realm', 'operator', '--upload-root', '/tmp']),
    /no document tools/,
  );
  assert.throws(
    () => parseArgs(['serve', '--realm', 'operator', '--download-dir', '/tmp']),
    /no document tools/,
  );
  assert.throws(
    () => parseArgs(['serve', '--realm', 'operator', '--toolsets', 'registers']),
    /one fixed tool set/,
  );
});

test('the charity realm is unaffected by all of that', () => {
  const config = parseArgs(['connect', '--data-scope', 'full', '--upload-root', '/tmp']);
  assert.equal(config.realm, 'charity');
  assert.equal(config.dataScope, 'full');
});

// ---------------------------------------------------------------------------
// The credential cannot stand in for the other realm's
// ---------------------------------------------------------------------------

test('each realm has its own keychain entry for the same host', () => {
  const origin = 'https://charitypilot.example';
  const charity = accountForOrigin(origin, 'charity');
  const operator = accountForOrigin(origin, 'operator');

  assert.notEqual(charity, operator, 'one entry for both realms is one credential for both');
  assert.match(operator, /operator/);
});

test('the charity entry is spelled exactly as it was before the operator realm existed', () => {
  // Changing it would sign every existing installation out.
  assert.equal(
    accountForOrigin('https://charitypilot.example'),
    accountForOrigin('https://charitypilot.example', 'charity'),
  );
  assert.equal(
    accountForOrigin('https://charitypilot.example'),
    'refresh-token:https://charitypilot.example',
  );
});

// ---------------------------------------------------------------------------
// The tool surface: what is offered, and what is not
// ---------------------------------------------------------------------------

function namesIn(realm: 'charity' | 'operator', level: 'read' | 'write' | 'admin' = 'admin') {
  return buildToolList(level, { realm }).map((tool) => tool.name);
}

test('the operator realm offers its own tools and session_info, and nothing else', () => {
  const offered = namesIn('operator');
  assert.deepEqual(
    offered.slice().sort(),
    ['session_info', ...OPERATOR_TOOL_NAMES].slice().sort(),
  );
});

test('not one charity tool is offered in the operator realm', () => {
  const offered = new Set(namesIn('operator'));
  const leaked = [...TOOLS, ...FILE_TOOLS]
    .map((tool) => tool.name)
    .filter((name) => offered.has(name));

  assert.deepEqual(leaked, [], 'a charity tool offered here would be the whole wall gone');
});

test('search and fetch are absent too, because both resolve into one charity', () => {
  const offered = new Set(namesIn('operator'));
  assert.equal(offered.has('fetch'), false);
  assert.equal(offered.has('search'), false);
});

test('not one operator tool leaks into the charity realm', () => {
  const offered = new Set(namesIn('charity'));
  const leaked = OPERATOR_TOOL_NAMES.filter((name) => offered.has(name));

  assert.deepEqual(leaked, [], 'a charity session must not reach another charity');
});

test('a read-level operator session is offered nothing that changes anything', () => {
  const offered = new Set(namesIn('operator', 'read'));
  const changers = OPERATOR_TOOLS.filter((tool) => tool.method).map((tool) => tool.name);

  assert.ok(changers.length >= 3, 'fixture assumption: there are write tools to withhold');
  for (const name of changers) {
    assert.equal(offered.has(name), false, `${name} changes things and must not be offered`);
  }
  assert.equal(offered.has('tenant_list'), true, 'the read tools must still be there');
});

test('a write-level operator session is offered the writes but not the closure', () => {
  const offered = new Set(namesIn('operator', 'write'));
  assert.equal(offered.has('tenant_create'), true);
  assert.equal(offered.has('tenant_configure'), true);
  assert.equal(
    offered.has('tenant_lifecycle'),
    false,
    'closing a charity asks for a level chosen deliberately at connect',
  );
});

// ---------------------------------------------------------------------------
// The tools themselves cannot reach a charity's records
// ---------------------------------------------------------------------------

test('every operator tool addresses the owner realm and nothing else', () => {
  for (const tool of OPERATOR_TOOLS) {
    assert.ok(
      tool.path.startsWith('/api/v1/owner/'),
      `${tool.name} points at ${tool.path}, which is outside the operator realm`,
    );
  }
});

test('no operator tool declares a model or shape, because none returns records about anyone', () => {
  // The charity tools name the model whose personal fields the gate filters.
  // An operator tool that named one would be returning records about people,
  // which is the thing this realm does not do — so the absence is the check.
  for (const tool of OPERATOR_TOOLS) {
    assert.equal(tool.model, undefined, `${tool.name} names a record model`);
    assert.equal(tool.shape, undefined, `${tool.name} names a record shape`);
    assert.ok(
      tool.noRecordsBecause,
      `${tool.name} must say in writing why it carries no records about anyone`,
    );
  }
});

test('tenant_lifecycle is the only destructive tool, and it needs admin', () => {
  const lifecycle = OPERATOR_TOOLS.find((tool) => tool.name === 'tenant_lifecycle');
  assert.ok(lifecycle);
  assert.equal(lifecycle.destructive, true);
  assert.equal(lifecycle.level, 'admin');

  for (const tool of OPERATOR_TOOLS) {
    if (tool.name === 'tenant_lifecycle') continue;
    assert.notEqual(tool.destructive, true, `${tool.name} is marked destructive unexpectedly`);
  }
});

test('every operator change requires a reason that is recorded', () => {
  for (const tool of OPERATOR_TOOLS) {
    if (!tool.method || tool.name === 'tenant_create') continue;
    const reason = tool.body?.find((field) => field.name === 'reason');
    assert.ok(reason, `${tool.name} changes a charity and must record why`);
    assert.equal(reason.required, true, `${tool.name}'s reason must not be optional`);
  }
});

test('tenant_lifecycle requires the version it read, so it cannot act on a stale view', () => {
  const lifecycle = OPERATOR_TOOLS.find((tool) => tool.name === 'tenant_lifecycle');
  const version = lifecycle?.body?.find((field) => field.name === 'expectedLifecycleVersion');
  assert.ok(version, 'closing a charity on a stale read is how the wrong charity gets closed');
  assert.equal(version.required, true);
});

// ---------------------------------------------------------------------------
// What the client is told on initialize, in each realm

/**
 * Drives a real `initialize` against a real server over a linked in-memory
 * transport pair, and returns what the client was told about this server.
 *
 * Nothing here is stubbed but the transport: the instructions asserted on are
 * the bytes a client actually receives, not a constant read back out of the
 * module that defines it.
 */
async function instructionsSeenByClient(realm: 'charity' | 'operator'): Promise<string> {
  const config = parseArgs([
    'serve', '--realm', realm, '--profile', 'local', '--base-url', 'http://localhost:3002',
  ]);
  const session = new Session({
    baseUrl: config.baseUrl,
    store: createMemoryStore('refresh'),
    realm,
    fetchImpl: async () => new Response('{}', { status: 500 }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startServer(config, session, serverTransport);

  const client = new Client({ name: 'harness', version: '0' });
  await client.connect(clientTransport);
  const instructions = client.getInstructions() ?? '';
  await client.close();
  return instructions;
}

test('the operator realm never tells a client it is inside one charity', async () => {
  const instructions = await instructionsSeenByClient('operator');

  assert.notEqual(
    instructions,
    INSTRUCTIONS,
    'the operator realm was handed the charity realm\'s instructions',
  );
  // Each of these is a statement that is FALSE in this realm. An agent told
  // any of them starts from a wrong belief about what it is connected to, and
  // reads its first refusal as a bug rather than as the boundary.
  for (const falsehood of [
    'governance records of one Irish charity',
    'personal-data gate',
    'page and pageSize',
    'acts as the signed-in person',
  ]) {
    assert.ok(
      !instructions.includes(falsehood),
      `the operator realm is told "${falsehood}", which is not true of it`,
    );
  }
  assert.match(instructions, /platform operator/i);
});

test('the charity realm still gets the instructions it always had', async () => {
  assert.equal(await instructionsSeenByClient('charity'), INSTRUCTIONS);
});
