import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfluenceClient, ConfluenceRequestSpec } from '../services/confluence-client.js';
import {
  CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES,
  createPage,
  getContentProperty,
  getContentPropertyRecord,
  getPage,
  setContentProperty,
  updatePage,
} from '../services/confluence-pages.js';
import { AppError } from '../utils/errors.js';

const PAGE_ID = '123456';
const SPACE_ID = '98765';
const WEB_BASE = 'https://charity.atlassian.net/wiki';
const WEB_UI = '/spaces/GOV/pages/123456/Data+Protection+Policy';

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

function throwing(error: AppError): Handler {
  return () => {
    throw error;
  };
}

function pageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAGE_ID,
    status: 'current',
    title: 'POL - Data Protection Policy',
    spaceId: SPACE_ID,
    version: { number: 3 },
    _links: { webui: WEB_UI, base: WEB_BASE },
    ...overrides,
  };
}

/** The shapes Task 1 throws, reproduced exactly as this module will meet them. */
function upstreamNotFound(): AppError {
  return new AppError(404, 'CONFLUENCE_NOT_FOUND', 'Confluence request failed with status 404.', {
    status: 404,
  });
}

function upstreamConflict(): AppError {
  return new AppError(409, 'CONFLUENCE_CONFLICT', 'Confluence request failed with status 409.', {
    status: 409,
  });
}

function upstreamReconnectRequired(): AppError {
  return new AppError(
    409,
    'CONFLUENCE_RECONNECT_REQUIRED',
    'Confluence request failed with status 403.',
    { status: 403 },
  );
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

function bodyOf(spec: ConfluenceRequestSpec): Record<string, unknown> {
  assert.ok(spec.body !== null && typeof spec.body === 'object', 'expected a JSON request body');
  return spec.body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The flag the whole phase turns on.
// ---------------------------------------------------------------------------

test('createPage is issued as non-idempotent so a 429 or a dropped connection cannot duplicate a page', async () => {
  const { client, specs } = harness([ok(pageBody())]);

  await createPage(client, {
    spaceId: SPACE_ID,
    title: 'POL - Data Protection Policy',
    bodyStorage: '<p>x</p>',
  });

  assert.equal(specs.length, 1);
  assert.equal(
    specs[0]?.idempotent,
    false,
    'createPage MUST be non-idempotent: a retry after a committed write duplicates a governance document',
  );
});

test('getPage is issued as idempotent so a rate-limited read is retried', async () => {
  const { client, specs } = harness([ok(pageBody())]);

  await getPage(client, PAGE_ID);

  assert.equal(specs.length, 1);
  assert.equal(
    specs[0]?.idempotent,
    true,
    'getPage MUST be idempotent: repeating a read changes nothing',
  );
});

test('updatePage is idempotent only because it carries the version it expects', async () => {
  const { client, specs } = harness([ok(pageBody({ version: { number: 4 } }))]);

  await updatePage(client, {
    pageId: PAGE_ID,
    title: 'POL - Data Protection Policy',
    bodyStorage: '<p>x</p>',
    expectedVersion: 3,
  });

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.idempotent, true);
  const version = bodyOf(spec).version as { number?: unknown };
  assert.ok(
    typeof version?.number === 'number',
    'the update must carry a version number; without it the request is not safe to repeat and must not be marked idempotent',
  );
});

// ---------------------------------------------------------------------------
// createPage
// ---------------------------------------------------------------------------

test('createPage posts the required fields and parses the returned id and version', async () => {
  const { client, specs } = harness([ok(pageBody({ version: { number: 1 } }))]);

  const page = await createPage(client, {
    spaceId: SPACE_ID,
    title: 'POL - Data Protection Policy',
    bodyStorage: '<p>Adopted by the board.</p>',
  });

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.method, 'POST');
  assert.equal(spec.api, 'v2');
  assert.equal(spec.path, 'pages');

  const body = bodyOf(spec);
  assert.equal(body.spaceId, SPACE_ID);
  assert.equal(body.title, 'POL - Data Protection Policy');
  assert.equal(body.status, 'current');
  assert.deepEqual(body.body, {
    representation: 'storage',
    value: '<p>Adopted by the board.</p>',
  });
  assert.ok(!('parentId' in body), 'no parentId should be sent when none was given');

  assert.equal(page.id, PAGE_ID);
  assert.equal(page.version, 1);
  assert.equal(page.spaceId, SPACE_ID);
  assert.equal(page.title, 'POL - Data Protection Policy');
  assert.equal(page.webUrl, `${WEB_BASE}${WEB_UI}`);
});

test('createPage sends parentId when the caller nests the page', async () => {
  const { client, specs } = harness([ok(pageBody())]);

  await createPage(client, {
    spaceId: SPACE_ID,
    title: 'POL - Data Protection Policy',
    bodyStorage: '<p>x</p>',
    parentId: '777',
  });

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(bodyOf(spec).parentId, '777');
});

test('createPage rejects a response with no usable id rather than returning a page that is not one', async () => {
  const { client } = harness([ok({ title: 'x', spaceId: SPACE_ID, version: { number: 1 } })]);

  const error = await rejectsWith(() =>
    createPage(client, { spaceId: SPACE_ID, title: 'x', bodyStorage: '<p>x</p>' }),
  );
  assert.equal(error.code, 'CONFLUENCE_RESPONSE_INVALID');
});

test('a page with no web link still parses: the page already exists, and failing here would push the caller to retry a create', async () => {
  const { client } = harness([ok(pageBody({ _links: undefined }))]);

  const page = await createPage(client, { spaceId: SPACE_ID, title: 'x', bodyStorage: '<p>x</p>' });
  assert.equal(page.webUrl, '');
  assert.equal(page.id, PAGE_ID);
});

// ---------------------------------------------------------------------------
// getPage
// ---------------------------------------------------------------------------

test('getPage returns the parsed page', async () => {
  const { client, specs } = harness([ok(pageBody())]);

  const page = await getPage(client, PAGE_ID);

  assert.equal(specs[0]?.method, 'GET');
  assert.equal(specs[0]?.path, `pages/${PAGE_ID}`);
  assert.deepEqual(page, {
    id: PAGE_ID,
    title: 'POL - Data Protection Policy',
    spaceId: SPACE_ID,
    version: 3,
    webUrl: `${WEB_BASE}${WEB_UI}`,
  });
});

test('getPage returns null on 404: a missing page is a normal answer to "does this exist"', async () => {
  const { client } = harness([throwing(upstreamNotFound())]);

  assert.equal(await getPage(client, PAGE_ID), null);
});

test('getPage does not swallow anything but a 404', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired())]);

  const error = await rejectsWith(() => getPage(client, PAGE_ID));
  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
});

test('getPage rejects a page id that could address something other than a page', async () => {
  const { client, specs } = harness([ok(pageBody())]);

  const error = await rejectsWith(() => getPage(client, '123/../../spaces'));
  assert.equal(error.code, 'CONFLUENCE_PAGE_ID_INVALID');
  assert.equal(specs.length, 0, 'nothing should be sent for an unusable id');
});

// ---------------------------------------------------------------------------
// updatePage
// ---------------------------------------------------------------------------

test('updatePage pins the update to the version the caller read and returns the new one', async () => {
  const { client, specs } = harness([ok(pageBody({ version: { number: 4 } }))]);

  const page = await updatePage(client, {
    pageId: PAGE_ID,
    title: 'POL - Data Protection Policy (v2)',
    bodyStorage: '<p>Reviewed.</p>',
    expectedVersion: 3,
  });

  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.method, 'PUT');
  assert.equal(spec.path, `pages/${PAGE_ID}`);

  const body = bodyOf(spec);
  assert.equal(body.id, PAGE_ID);
  assert.equal(body.status, 'current');
  assert.equal(body.title, 'POL - Data Protection Policy (v2)');
  assert.deepEqual(body.body, { representation: 'storage', value: '<p>Reviewed.</p>' });
  // Confluence takes the successor of the version the caller expects; sending
  // anything else is what makes a repeat fail instead of applying twice.
  assert.deepEqual(body.version, { number: 4 });

  assert.equal(page.version, 4);
});

test('a version mismatch surfaces as CONFLUENCE_PAGE_VERSION_CONFLICT and tells the caller to re-read', async () => {
  const { client } = harness([throwing(upstreamConflict())]);

  const error = await rejectsWith(() =>
    updatePage(client, { pageId: PAGE_ID, title: 'x', bodyStorage: '<p>x</p>', expectedVersion: 3 }),
  );

  assert.equal(error.code, 'CONFLUENCE_PAGE_VERSION_CONFLICT');
  assert.equal(error.statusCode, 409);
  assert.match(error.message, /re-read/i);

  const details = error.details as Record<string, unknown>;
  assert.equal(details.pageId, PAGE_ID);
  assert.equal(details.expectedVersion, 3);
  // Task 1 surfaces no response body, so the version Confluence actually holds
  // never reaches this module. Inventing one would be worse than omitting it.
  assert.ok(!('foundVersion' in details), 'must not report a version it never received');
});

test('updatePage refuses a version that is not a whole number it can increment', async () => {
  const { client, specs } = harness([ok(pageBody())]);

  const error = await rejectsWith(() =>
    updatePage(client, {
      pageId: PAGE_ID,
      title: 'x',
      bodyStorage: '<p>x</p>',
      expectedVersion: 0.5,
    }),
  );
  assert.equal(error.code, 'CONFLUENCE_PAGE_VERSION_INVALID');
  assert.equal(specs.length, 0);
});

// ---------------------------------------------------------------------------
// Content properties
// ---------------------------------------------------------------------------

/** A tiny Confluence that really stores one content property per key. */
function propertyStore(): Harness {
  const stored = new Map<string, { id: string; key: string; value: unknown; version: number }>();
  let nextId = 1;

  const handler: Handler = (spec) => {
    if (spec.method === 'GET') {
      const key = spec.query?.key ?? '';
      const record = stored.get(key);
      return {
        status: 200,
        body: {
          results: record
            ? [
                {
                  id: record.id,
                  key: record.key,
                  value: record.value,
                  version: { number: record.version },
                },
              ]
            : [],
        },
      };
    }

    const body = spec.body as { key?: string; value?: unknown; version?: { number?: number } };

    if (spec.method === 'POST') {
      const key = String(body.key);
      const record = { id: `prop-${nextId}`, key, value: body.value, version: 1 };
      nextId += 1;
      stored.set(key, record);
      return {
        status: 200,
        body: { id: record.id, key, value: record.value, version: { number: record.version } },
      };
    }

    // PUT: optimistic concurrency, exactly as Confluence enforces it.
    const key = String(body.key);
    const record = stored.get(key);
    if (!record) throw upstreamNotFound();
    if (body.version?.number !== record.version + 1) throw upstreamConflict();
    record.value = body.value;
    record.version += 1;
    return {
      status: 200,
      body: { id: record.id, key, value: record.value, version: { number: record.version } },
    };
  };

  return harness([handler]);
}

test('a content property round-trips', async () => {
  const { client } = propertyStore();
  const metadata = { approvedByResolution: 'RES-2026-014', approvedOn: '2026-03-11' };

  await setContentProperty(client, PAGE_ID, 'charitypilot.governance', metadata);

  assert.deepEqual(await getContentProperty(client, PAGE_ID, 'charitypilot.governance'), metadata);
});

test('setting an existing property updates it under its own version and is safe to repeat', async () => {
  const { client, specs } = propertyStore();

  await setContentProperty(client, PAGE_ID, 'charitypilot.governance', { nextReview: '2027-03-11' });
  await setContentProperty(client, PAGE_ID, 'charitypilot.governance', { nextReview: '2028-03-11' });

  const put = specs.find((spec) => spec.method === 'PUT');
  assert.ok(put, 'the second set should update rather than create');
  assert.equal(put.idempotent, true, 'a versioned property update is safe to repeat');
  assert.deepEqual((put.body as { version: unknown }).version, { number: 2 });

  const create = specs.find((spec) => spec.method === 'POST');
  assert.equal(create?.idempotent, false, 'creating a property is not safe to repeat');

  assert.deepEqual(await getContentProperty(client, PAGE_ID, 'charitypilot.governance'), {
    nextReview: '2028-03-11',
  });
});

test('getContentProperty returns null when the property has never been set', async () => {
  const { client } = propertyStore();

  assert.equal(await getContentProperty(client, PAGE_ID, 'charitypilot.governance'), null);
  assert.equal(await getContentPropertyRecord(client, PAGE_ID, 'charitypilot.governance'), null);
});

test('getContentProperty returns null when the page itself is gone', async () => {
  const { client } = harness([throwing(upstreamNotFound())]);

  assert.equal(await getContentProperty(client, PAGE_ID, 'charitypilot.governance'), null);
});

test('a stale expected version is refused before anything is written', async () => {
  const { client, specs } = propertyStore();

  await setContentProperty(client, PAGE_ID, 'charitypilot.governance', { nextReview: '2027-03-11' });
  const afterCreate = specs.length;

  const error = await rejectsWith(() =>
    setContentProperty(client, PAGE_ID, 'charitypilot.governance', { nextReview: '2028-03-11' }, 7),
  );

  assert.equal(error.code, 'CONFLUENCE_CONTENT_PROPERTY_VERSION_CONFLICT');
  assert.match(error.message, /re-read/i);
  assert.equal(
    specs.length,
    afterCreate + 1,
    'only the read that discovered the conflict should have been issued',
  );
});

test('an oversized content property is refused before any request is made', async () => {
  const { client, specs } = propertyStore();
  const oversized = { note: 'x'.repeat(CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES) };

  const error = await rejectsWith(() =>
    setContentProperty(client, PAGE_ID, 'charitypilot.governance', oversized),
  );

  assert.equal(error.code, 'CONFLUENCE_CONTENT_PROPERTY_TOO_LARGE');
  assert.equal(
    specs.length,
    0,
    'nothing may be sent: the caller can act on this, a 400 from Atlassian cannot',
  );
  assert.match(error.message, /charitypilot\.governance/);

  const details = error.details as Record<string, unknown>;
  assert.equal(details.key, 'charitypilot.governance');
  assert.equal(details.limitBytes, CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES);
  assert.ok(
    typeof details.bytes === 'number' && details.bytes > CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES,
  );
  assert.ok(
    !JSON.stringify(error.details).includes('xxxxxxxxxx'),
    'the value itself must not be replayed into the error',
  );
});

test('a property whose size is measured in bytes, not characters, is still caught', async () => {
  const { client, specs } = propertyStore();
  // Three bytes per character in UTF-8: a character count would pass this.
  const value = { note: '€'.repeat(11 * 1024) };

  const error = await rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', value));
  assert.equal(error.code, 'CONFLUENCE_CONTENT_PROPERTY_TOO_LARGE');
  assert.equal(specs.length, 0);
});

test('a property value that is not serialisable is refused before any request', async () => {
  const { client, specs } = propertyStore();
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const error = await rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', circular));
  assert.equal(error.code, 'CONFLUENCE_CONTENT_PROPERTY_INVALID');
  assert.equal(specs.length, 0);
});

test('a property key that could address another resource is refused before any request', async () => {
  const { client, specs } = propertyStore();

  const error = await rejectsWith(() =>
    setContentProperty(client, PAGE_ID, '../../pages', { a: 1 }),
  );
  assert.equal(error.code, 'CONFLUENCE_PROPERTY_KEY_INVALID');
  assert.equal(specs.length, 0);
});
