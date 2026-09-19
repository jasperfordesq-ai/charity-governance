import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfluenceClient, ConfluenceRequestSpec } from '../services/confluence-client.js';
import { listSpaces } from '../services/confluence-spaces.js';
import { AppError } from '../utils/errors.js';

const WEB_BASE = 'https://charity.atlassian.net/wiki';

type Handler = (spec: ConfluenceRequestSpec) => { status: number; body: unknown };

type Harness = { client: ConfluenceClient; specs: ConfluenceRequestSpec[] };

/** A `ConfluenceClient` wired to scripted handlers. The last handler repeats. */
function harness(handlers: Handler[]): Harness {
  const specs: ConfluenceRequestSpec[] = [];
  const client: ConfluenceClient = {
    async request(spec) {
      specs.push(spec);
      const handler = handlers[Math.min(specs.length - 1, handlers.length - 1)];
      if (handler === undefined) {
        throw new Error(`No scripted response for ${spec.method} ${spec.path}`);
      }
      return handler(spec);
    },
  };
  return { client, specs };
}

function ok(body: unknown): Handler {
  return () => ({ status: 200, body });
}

/** The shape the v2 `/spaces` endpoint answers with. */
function v2SpacesBody(
  results: Record<string, unknown>[] = [{ id: 'space1', key: 'GOV', name: 'Governance' }],
  links: Record<string, unknown> = { base: WEB_BASE },
): Record<string, unknown> {
  return { results, _links: links };
}

async function rejectsWith(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got: ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

// ---------------------------------------------------------------------------
// The flag the whole phase turns on.
// ---------------------------------------------------------------------------

test('listSpaces is issued as idempotent so a rate-limited read is retried', async () => {
  const { client, specs } = harness([ok(v2SpacesBody())]);

  await listSpaces(client);

  assert.equal(specs[0]?.idempotent, true);
});

// ---------------------------------------------------------------------------
// Only three fields cross the tenant boundary.
// ---------------------------------------------------------------------------

test('listSpaces reads the v2 endpoint and returns only id, key and name', async () => {
  const { client, specs } = harness([
    ok(
      v2SpacesBody([
        {
          id: 'space1',
          key: 'GOV',
          name: 'Governance',
          description: { plain: { value: 'Board minutes and policies' } },
          homepageId: 'page-999',
          status: 'current',
          type: 'global',
          permissions: [{ subject: 'user-1', operation: 'read' }],
        },
      ]),
    ),
  ]);

  const { spaces } = await listSpaces(client);

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.method, 'GET');
  assert.equal(spec.api, 'v2');
  assert.equal(spec.path, 'spaces');
  assert.equal(
    spec.query?.limit,
    '250',
    "v2's maximum page size, and load-bearing for the same reason as confluence-attachments.ts",
  );

  assert.equal(spaces.length, 1);
  assert.deepEqual(Object.keys(spaces[0]!).sort(), ['id', 'key', 'name']);
  assert.deepEqual(spaces[0], { id: 'space1', key: 'GOV', name: 'Governance' });
});

test('a space missing a key is a plain invalid response rather than a silently dropped entry', async () => {
  const { client } = harness([ok(v2SpacesBody([{ id: 'space1', name: 'Governance' }]))]);

  const error = await rejectsWith(() => listSpaces(client));

  assert.equal(error.code, 'CONFLUENCE_RESPONSE_INVALID');
  assert.equal(error.statusCode, 502);
});

test('listSpaces returns an empty list for a site with no spaces', async () => {
  const { client } = harness([ok(v2SpacesBody([]))]);
  assert.deepEqual(await listSpaces(client), { spaces: [] });
});

// ---------------------------------------------------------------------------
// The cursor is followed.
// ---------------------------------------------------------------------------

test('a caller-supplied cursor is sent on the first request', async () => {
  const { client, specs } = harness([ok(v2SpacesBody([]))]);

  await listSpaces(client, 'RESUME-FROM-HERE');

  assert.equal(specs[0]?.query?.cursor, 'RESUME-FROM-HERE');
});

test('listSpaces follows the v2 cursor across pages and merges the results', async () => {
  const first = v2SpacesBody([{ id: 'space1', key: 'GOV', name: 'Governance' }], {
    base: WEB_BASE,
    next: '/wiki/api/v2/spaces?cursor=CURSOR2&limit=250',
  });
  const second = v2SpacesBody([{ id: 'space2', key: 'FIN', name: 'Finance' }]);
  const { client, specs } = harness([ok(first), ok(second)]);

  const { spaces, nextCursor } = await listSpaces(client);

  assert.equal(specs.length, 2);
  assert.equal(specs[1]?.query?.cursor, 'CURSOR2');
  assert.deepEqual(
    spaces.map((space) => space.id),
    ['space1', 'space2'],
  );
  assert.equal(nextCursor, undefined, 'the walk reached the end, so there is nothing left to resume from');
});

// ---------------------------------------------------------------------------
// The walk is bounded.
// ---------------------------------------------------------------------------

test('listSpaces stops following an endless cursor and hands back a resume point instead of hanging', async () => {
  const endless = v2SpacesBody([{ id: 'space1', key: 'GOV', name: 'Governance' }], {
    base: WEB_BASE,
    next: '/wiki/api/v2/spaces?cursor=SAME&limit=250',
  });
  const { client, specs } = harness([ok(endless)]);

  const { spaces, nextCursor } = await listSpaces(client);

  assert.ok(specs.length > 1 && specs.length <= 40, `bounded page count, got ${specs.length}`);
  assert.equal(spaces.length, specs.length, 'every page read before the bound was reached is kept, not discarded');
  assert.equal(
    nextCursor,
    'SAME',
    'the caller gets a cursor to resume from instead of an error, unlike listAttachments',
  );
});

for (const [what, body] of [
  ['no results key at all', { _links: { base: WEB_BASE } }],
  ['a results object rather than a list', { results: {}, _links: { base: WEB_BASE } }],
] as const) {
  test(`listSpaces refuses a response with ${what} rather than reporting none`, async () => {
    const { client } = harness([ok(body)]);

    const error = await rejectsWith(() => listSpaces(client));

    assert.equal(error.code, 'CONFLUENCE_RESPONSE_INVALID');
    assert.equal(error.statusCode, 502);
  });
}
