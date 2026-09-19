import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfluenceClient, ConfluenceRequestSpec } from '../services/confluence-client.js';
import {
  CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES,
  createPage,
  deletePage,
  getContentProperty,
  getContentPropertyRecord,
  getPage,
  purgePage,
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

test('a create whose response has no usable id says the page EXISTS and must not be reissued', async () => {
  const { client } = harness([ok({ title: 'x', spaceId: SPACE_ID, version: { number: 1 } })]);

  const error = await rejectsWith(() =>
    createPage(client, { spaceId: SPACE_ID, title: 'x', bodyStorage: '<p>x</p>' }),
  );

  // By this point Confluence has answered 2xx: the page is in the charity's
  // space. A generic "bad response" would read as "nothing happened", and a
  // publish pipeline acting on that creates the page a second time. Same code
  // the HTTP core uses for the same class of loss one layer down.
  assert.equal(error.code, 'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE');
  assert.match(error.message, /WAS created/);
  assert.match(error.message, /do not reissue/i);
});

test('a page response with no usable space id is refused, on a read and on a create alike', async () => {
  // The module header claims strictness "on everything the caller cannot
  // proceed without"; `spaceId` is in the returned type and in the same strict
  // block as `id` and `version`, and only those two were defended. A page
  // object whose space cannot be read is not one a publish pipeline can file,
  // search or audit against.
  const withoutSpace = { id: PAGE_ID, title: 'x', version: { number: 1 } };

  const readError = await rejectsWith(() => getPage(harness([ok(withoutSpace)]).client, PAGE_ID));
  assert.equal(readError.code, 'CONFLUENCE_RESPONSE_INVALID');
  assert.match(readError.message, /space id/i);

  // And on a create the strictness holds while the label changes: the page
  // exists by then, so the caller must not be told nothing happened.
  const createError = await rejectsWith(() =>
    createPage(harness([ok(withoutSpace)]).client, {
      spaceId: SPACE_ID,
      title: 'x',
      bodyStorage: '<p>x</p>',
    }),
  );
  assert.equal(createError.code, 'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE');
  assert.match(createError.message, /space id/i);
});

test('a read or an update with an unusable response stays a plain bad-response error', async () => {
  // Nothing was written on either path, so there is nothing to reconcile: a
  // get changes nothing, and a rejected update is caught by its own version.
  const unusable = { title: 'x', spaceId: SPACE_ID, version: { number: 1 } };

  const readError = await rejectsWith(() => getPage(harness([ok(unusable)]).client, PAGE_ID));
  assert.equal(readError.code, 'CONFLUENCE_RESPONSE_INVALID');

  const updateError = await rejectsWith(() =>
    updatePage(harness([ok(unusable)]).client, {
      pageId: PAGE_ID,
      title: 'x',
      bodyStorage: '<p>x</p>',
      expectedVersion: 1,
    }),
  );
  assert.equal(updateError.code, 'CONFLUENCE_RESPONSE_INVALID');
});

test('an update conflict names both causes it could be and denies neither an application nor a rename', async () => {
  // `updatePage` catches CONFLUENCE_CONFLICT unconditionally, and it sends a
  // `title` as well as a version. Confluence uses 409 for a duplicate title in
  // a space — the reason `createPage` deliberately leaves its 409
  // untranslated — and the HTTP core surfaces no response body, so this module
  // cannot tell a stale version from a colliding title. It must not pick one.
  //
  // And it must not deny an application either: the call is `idempotent: true`,
  // so a 502 from a gateway that had already passed the write on is retried,
  // the retry meets a genuine 409, and "your version was not applied by this
  // call" is then false — it was applied, by this call, on the first attempt.
  // Recovery is safe either way; the statement was not, and a pipeline can
  // branch on a statement.
  const { client } = harness([throwing(upstreamConflict())]);

  const error = await rejectsWith(() =>
    updatePage(client, { pageId: PAGE_ID, title: 'x', bodyStorage: '<p>x</p>', expectedVersion: 3 }),
  );

  assert.equal(error.code, 'CONFLUENCE_PAGE_VERSION_CONFLICT');
  assert.match(error.message, /version 3/, 'the version that was sent is the one fact this module holds');
  assert.match(error.message, /title/i, 'the duplicate-title cause must be named');
  assert.match(error.message, /re-read/i);

  for (const claim of [
    'somebody else changed it first',
    'was not applied',
    'no longer at version',
    'nothing was written',
  ]) {
    assert.equal(
      error.message.toLowerCase().includes(claim.toLowerCase()),
      false,
      `"${claim}" asserts something this module cannot know`,
    );
  }
});

test('a 409 on create is NOT relabelled as a version conflict: Confluence also uses it for a duplicate title', async () => {
  const { client } = harness([throwing(upstreamConflict())]);

  const error = await rejectsWith(() =>
    createPage(client, { spaceId: SPACE_ID, title: 'POL - Data Protection Policy', bodyStorage: '<p>x</p>' }),
  );

  // Telling the caller "someone else edited this page, re-read and retry"
  // would send it round a loop that can never resolve: there is no page to
  // re-read and nothing in conflict to find.
  assert.equal(error.code, 'CONFLUENCE_CONFLICT');
});

test('a 409 when creating a content property is not relabelled either', async () => {
  const { client } = harness([ok({ results: [] }), throwing(upstreamConflict())]);

  const error = await rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', { a: 1 }));
  assert.equal(error.code, 'CONFLUENCE_CONFLICT');
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

test('a rejected identifier is the caller error it is, never a 5xx that pages the on-call', async () => {
  const { client, specs } = propertyStore();

  // A 5xx in this codebase logs at error level and fires the production alert
  // webhook. These ids arrive from requests and database rows, so a 500 here
  // would let anyone page the on-call by sending a malformed one. The core's
  // own path guard is a backstop behind this, not the boundary.
  const rejected = await Promise.all([
    rejectsWith(() => getPage(client, 'not a page id')),
    rejectsWith(() => updatePage(client, { pageId: 'a/b', title: 'x', bodyStorage: '', expectedVersion: 1 })),
    rejectsWith(() =>
      updatePage(client, { pageId: PAGE_ID, title: 'x', bodyStorage: '', expectedVersion: 0 }),
    ),
    rejectsWith(() => getContentProperty(client, 'a/b', 'k')),
    rejectsWith(() => setContentProperty(client, PAGE_ID, 'has spaces', { a: 1 })),
    rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', { a: 1 }, 0)),
    // These two are the likeliest of all to fire on real charity data — an
    // oversized governance-metadata blob is a data condition, not a
    // programming error — so they are the best placed to page the on-call
    // repeatedly if they were ever 5xx.
    rejectsWith(() =>
      setContentProperty(client, PAGE_ID, 'k', { note: 'x'.repeat(CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES) }),
    ),
    rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', () => undefined)),
  ]);

  for (const error of rejected) {
    assert.ok(
      error.statusCode >= 400 && error.statusCode < 500,
      `expected a client error, got ${error.statusCode} for ${error.code}`,
    );
  }
  assert.equal(specs.length, 0, 'none of these may reach Confluence');
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

test('updatePage translates a genuine conflict only, not everything that arrives with status 409', async () => {
  // The core maps an expired grant to statusCode 409 as well, deliberately, so
  // that apps/web does not mistake it for a dead CharityPilot session. A
  // translation that discriminated on status rather than code would tell a
  // charity whose Confluence grant has died to "re-read the page and retry" —
  // forever, because re-reading will never fix a revoked authorization.
  const { client } = harness([throwing(upstreamReconnectRequired())]);
  assert.equal(upstreamReconnectRequired().statusCode, 409, 'the premise of this test');

  const error = await rejectsWith(() =>
    updatePage(client, { pageId: PAGE_ID, title: 'x', bodyStorage: '<p>x</p>', expectedVersion: 3 }),
  );
  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
});

test('a content property update translates a genuine conflict only, not every status 409', async () => {
  const { client } = harness([
    ok({ results: [{ id: 'prop-1', key: 'k', value: { a: 1 }, version: { number: 1 } }] }),
    throwing(upstreamReconnectRequired()),
  ]);

  const error = await rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', { a: 2 }));
  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
});

test('a property conflict raised by Confluence reports no version, because none was received', async () => {
  const { client } = harness([
    ok({ results: [{ id: 'prop-1', key: 'k', value: { a: 1 }, version: { number: 1 } }] }),
    throwing(upstreamConflict()),
  ]);

  const error = await rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', { a: 2 }));

  assert.equal(error.code, 'CONFLUENCE_CONTENT_PROPERTY_VERSION_CONFLICT');
  const details = error.details as Record<string, unknown>;
  // The number from the lookup is precisely the one Confluence has just
  // declared stale. Reporting it would be inventing a found version.
  assert.ok(!('foundVersion' in details), 'must not report a version it never received');
});

test('a lookup that answers with a different property is refused, not written over', async () => {
  const { client, specs } = harness([
    ok({ results: [{ id: 'prop-9', key: 'somebody.elses.key', value: {}, version: { number: 4 } }] }),
  ]);

  const error = await rejectsWith(() => setContentProperty(client, PAGE_ID, 'k', { a: 1 }));
  assert.equal(error.code, 'CONFLUENCE_RESPONSE_INVALID');
  assert.equal(specs.length, 1, 'the unrelated property must not be PUT over');
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
// Erasure
// ---------------------------------------------------------------------------

test('deletePage and purgePage are issued as idempotent, unlike createPage', async () => {
  const { client, specs } = harness([ok(undefined), ok(undefined)]);

  await deletePage(client, PAGE_ID);
  await purgePage(client, PAGE_ID);

  assert.equal(specs.length, 2);
  assert.equal(
    specs[0]?.idempotent,
    true,
    'deletePage MUST be idempotent: a retried delete cannot duplicate anything, because absence is the goal',
  );
  assert.equal(
    specs[1]?.idempotent,
    true,
    'purgePage MUST be idempotent for the same reason',
  );
});

test('purge=true is requested on the purge call and on no other', async () => {
  const { client, specs } = harness([ok(undefined), ok(undefined)]);

  await deletePage(client, PAGE_ID);
  await purgePage(client, PAGE_ID);

  assert.equal(specs.length, 2);
  assert.equal(specs[0]?.method, 'DELETE');
  assert.equal(specs[0]?.path, `pages/${PAGE_ID}`);
  assert.equal(specs[0]?.query, undefined, 'delete must not purge');

  assert.equal(specs[1]?.method, 'DELETE');
  assert.equal(specs[1]?.path, `pages/${PAGE_ID}`);
  assert.deepEqual(specs[1]?.query, { purge: 'true' }, 'purge must ask for it explicitly');
});

test('a 404 from deletePage is an accomplished erasure, not a failure', async () => {
  const { client } = harness([throwing(upstreamNotFound())]);

  // Resolves. The absence 404 reports is the point of calling this at all.
  await deletePage(client, PAGE_ID);
});

test('a 404 from purgePage is an accomplished erasure, not a failure', async () => {
  const { client } = harness([throwing(upstreamNotFound())]);

  await purgePage(client, PAGE_ID);
});

test('deletePage does not swallow anything but a 404', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired())]);

  const error = await rejectsWith(() => deletePage(client, PAGE_ID));
  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
});

test('a forbidden purge names the permission the grant is missing, and says the page is only in the trash', async () => {
  const { client } = harness([throwing(upstreamReconnectRequired())]);

  const error = await rejectsWith(() => purgePage(client, PAGE_ID));

  assert.equal(error.code, 'CONFLUENCE_PURGE_FORBIDDEN');
  assert.equal(error.statusCode, 403);
  assert.match(error.message, /manage\/content/i);
  assert.match(error.message, /trash/i);
  assert.equal((error.details as Record<string, unknown>).permissionRequired, 'space manage/content');
});

test('a 401 on purge is left as a reconnect, not relabelled as forbidden: reconnecting cannot fix a missing permission, but it does fix an expired token', async () => {
  const { client } = harness([
    throwing(
      new AppError(409, 'CONFLUENCE_RECONNECT_REQUIRED', 'Confluence request failed with status 401.', {
        status: 401,
      }),
    ),
  ]);

  const error = await rejectsWith(() => purgePage(client, PAGE_ID));
  assert.equal(error.code, 'CONFLUENCE_RECONNECT_REQUIRED');
});

test('deletePage and purgePage reject a page id that could address something other than a page', async () => {
  const { client, specs } = harness([ok(undefined)]);

  const deleteError = await rejectsWith(() => deletePage(client, '123/../../spaces'));
  assert.equal(deleteError.code, 'CONFLUENCE_PAGE_ID_INVALID');

  const purgeError = await rejectsWith(() => purgePage(client, '123/../../spaces'));
  assert.equal(purgeError.code, 'CONFLUENCE_PAGE_ID_INVALID');

  assert.equal(specs.length, 0, 'nothing should be sent for an unusable id');
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

test('a missing page is not reported as an unset property: they are different answers', async () => {
  const { client } = harness([throwing(upstreamNotFound())]);

  // `null` means "not set on a page that exists". A pipeline told `null` for a
  // page that has been deleted would conclude the metadata merely needs
  // writing, and discover the truth much further downstream.
  const error = await rejectsWith(() => getContentProperty(client, PAGE_ID, 'charitypilot.governance'));
  assert.equal(error.code, 'CONFLUENCE_NOT_FOUND');
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

test('a version precondition on a property that has been deleted is refused, and nothing is created', async () => {
  // The neighbouring test covers a version that MISMATCHES. This is the case
  // where the property is gone: a publish job read `charitypilot.governance`
  // at version 3, and before it wrote, another worker or a Confluence admin
  // deleted it.
  //
  // The refusal is what keeps the precondition meaningful. Without it the
  // lookup finds nothing, the create path runs, and the value is written as a
  // brand-new property at version 1 — silently undoing somebody's deletion
  // while the caller believes it wrote under a version precondition. The
  // assertion that no POST was issued is therefore the one that matters here;
  // the 409 alone would stay green with the damage done.
  const { client, specs } = propertyStore();

  const error = await rejectsWith(() =>
    setContentProperty(client, PAGE_ID, 'charitypilot.governance', { nextReview: '2028-03-11' }, 3),
  );

  assert.equal(error.code, 'CONFLUENCE_CONTENT_PROPERTY_VERSION_CONFLICT');
  assert.equal(error.statusCode, 409);
  assert.equal(
    specs.some((spec) => spec.method === 'POST'),
    false,
    'a stale precondition must never fall through to a create',
  );
  assert.equal(specs.length, 1, 'only the read that discovered the deletion should have been issued');
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
