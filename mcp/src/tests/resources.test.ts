import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOVERNANCE_CODE_URI,
  REGULATOR_GUIDANCE_URI,
  RESOURCES,
  RESOURCE_TEMPLATES,
  readResource,
} from '../resources.js';
import { REFERENCE_SCHEME } from '../references.js';
import { ApiClient } from '../client.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';
import { ConnectorError } from '../errors.js';

function client(answers: Record<string, unknown>): { api: ApiClient; paths: string[] } {
  const paths: string[] = [];
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () => new Response(
      JSON.stringify({ accessToken: 'a1', refreshToken: 'r2' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });

  const api = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      const body = answers[path];
      return body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
    },
  });
  return { api, paths };
}

const neverDispatched = async (): Promise<never> => {
  throw new Error('no record should have been read');
};

test('the listing offers reference data and nothing else', () => {
  assert.deepEqual(
    RESOURCES.map((resource) => resource.uri).sort(),
    [GOVERNANCE_CODE_URI, REGULATOR_GUIDANCE_URI].sort(),
  );

  for (const resource of RESOURCES) {
    assert.ok(resource.name.length > 0, `${resource.uri} needs a name`);
    assert.ok(resource.title.length > 0, `${resource.uri} needs a title`);
    assert.ok(resource.description.length > 20, `${resource.uri} needs a description`);
    assert.equal(resource.mimeType, 'application/json');
  }
});

test('records are a template rather than a listing, because there may be thousands', () => {
  assert.equal(RESOURCE_TEMPLATES.length, 1);
  assert.ok(
    RESOURCE_TEMPLATES[0]!.uriTemplate.startsWith(REFERENCE_SCHEME),
    'the template must use the same references search hands out',
  );
});

test('the Governance Code resource reads the principles, with this charity’s status', async () => {
  const { api, paths } = client({
    '/api/v1/compliance/principles': { data: [{ number: 1, title: 'Advancing the purpose' }] },
  });

  const read = await readResource(GOVERNANCE_CODE_URI, api, neverDispatched);

  assert.deepEqual(paths, ['/api/v1/compliance/principles']);
  assert.equal(read.uri, GOVERNANCE_CODE_URI);
  assert.equal(read.mimeType, 'application/json');
  assert.match(read.text, /Advancing the purpose/);
});

test('the guidance resource reads the regulator matrix', async () => {
  const { api, paths } = client({
    '/api/v1/compliance/guidance': { lastChecked: '2026-07-09', entries: [] },
  });

  const read = await readResource(REGULATOR_GUIDANCE_URI, api, neverDispatched);

  assert.deepEqual(paths, ['/api/v1/compliance/guidance']);
  assert.match(read.text, /2026-07-09/);
});

// The property that keeps a resource from becoming a way around the guards.
test('reading a record as a resource goes through the tool dispatch, not the client', async () => {
  const { api, paths } = client({ '/api/v1/documents/doc-1': { data: { id: 'doc-1' } } });
  const dispatched: { tool: string; args: Record<string, string> }[] = [];

  const read = await readResource(
    `${REFERENCE_SCHEME}document/doc-1`,
    api,
    async (tool, args) => {
      dispatched.push({ tool, args });
      return { data: { id: 'doc-1', name: 'Safeguarding policy' } };
    },
  );

  assert.deepEqual(dispatched, [{ tool: 'document', args: { id: 'doc-1' } }]);
  assert.deepEqual(paths, [], 'the resource must not reach the API around the dispatch');
  assert.match(read.text, /Safeguarding policy/);
});

test('a uri that is not a CharityPilot resource is refused', async () => {
  const { api } = client({});

  await assert.rejects(
    () => readResource('https://example.test/secrets', api, neverDispatched),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'RESOURCE_UNKNOWN');
      return true;
    },
  );
});

test('a record reference that names no kind is refused by the same rule tools use', async () => {
  const { api } = client({});

  await assert.rejects(
    () => readResource(`${REFERENCE_SCHEME}payroll/p-1`, api, neverDispatched),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'REFERENCE_INVALID');
      return true;
    },
  );
});

test('reading a resource only ever reads', async () => {
  // The reason resources need no access level and no approval. Asserted on
  // the request that actually goes out, not on the intention.
  const methods: string[] = [];
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () => new Response(
      JSON.stringify({ accessToken: 'a1', refreshToken: 'r2' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const api = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  for (const resource of RESOURCES) {
    await readResource(resource.uri, api, neverDispatched);
  }

  assert.deepEqual(new Set(methods), new Set(['GET']), methods.join(', '));
  assert.equal(methods.length, RESOURCES.length);
});
