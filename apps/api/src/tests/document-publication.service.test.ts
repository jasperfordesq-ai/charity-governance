import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AppError } from '../utils/errors.js';
import {
  createConfluencePublisher,
  DocumentPublicationService,
  DOCUMENT_PUBLICATION_MAX_ATTEMPTS,
  publicationErasureTarget,
  publicationFilename,
  type ConfluencePublisherDeps,
  type ConfluencePublishOperations,
  type DocumentPublicationRecord,
  type PublicationOutcome,
  type PublicationSource,
  type Publisher,
} from '../services/document-publication.service.js';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import type { ConfluenceAttachment } from '../services/confluence-attachments.js';
import type { ConfluencePublishTarget } from '../services/confluence-publish-target.service.js';
import { CHARITYPILOT_PROPERTY_KEY, publicationTitle } from '../services/confluence-document-mapping.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');

/** Stands in for a live client. No test in this file lets a real request out. */
const CLIENT = {
  request: async () => {
    throw new Error('no test in this file may reach the HTTP core');
  },
} as unknown as ConfluenceClient;

const TARGET: ConfluencePublishTarget = {
  cloudId: 'cloud-1',
  spaceId: 'space-1',
  spaceKey: 'GOV',
  spaceName: 'Governance',
};

const DOC: PublicationSource = {
  id: 'doc-1',
  name: 'Safeguarding Policy',
  version: 3,
  organisationId: 'org-1',
  category: 'POLICY',
  boardMinuteReference: 'BM-2026-04',
  approvedDate: null,
  nextReviewDate: null,
  storagePath: 'org-1/safeguarding.pdf',
  mimeType: 'application/pdf',
};

const TITLE = publicationTitle(DOC);

const PAGE: ConfluencePage = {
  id: 'page-1',
  title: TITLE,
  spaceId: 'space-1',
  version: 1,
  webUrl: '',
};

const ATTACHMENT: ConfluenceAttachment = {
  id: 'att-1',
  title: 'Safeguarding Policy',
  mediaType: 'application/pdf',
  fileSize: 3,
  downloadUrl: '',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function publicationRow(overrides: Partial<DocumentPublicationRecord> = {}): DocumentPublicationRecord {
  return {
    id: 'pub-1',
    organisationId: 'org-1',
    documentId: 'doc-1',
    provider: 'confluence',
    cloudId: null,
    spaceId: null,
    pageId: null,
    attachmentId: null,
    pageTitle: null,
    publishedAt: null,
    state: 'PENDING',
    attempts: 0,
    claimedAt: null,
    nextAttemptAt: new Date('2026-09-19T11:00:00.000Z'),
    deadLetteredAt: null,
    terminalReason: null,
    alertClaimToken: null,
    alertClaimedAt: null,
    alertedAt: null,
    lastError: null,
    lastAttemptAt: null,
    processedAt: null,
    createdAt: new Date('2026-09-19T10:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Projects a fixture row through a Prisma `select`, the way the real client
 * does — the defect class this repository has recorded eight times. A field a
 * production `select` stops asking for disappears from the row the test sees,
 * exactly as it would in production.
 */
function applyPrismaSelect(
  row: DocumentPublicationRecord,
  args?: { select?: Record<string, boolean> } | null,
): Partial<DocumentPublicationRecord> {
  const select = args?.select;
  if (!select) return { ...row };
  const projected: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (!wanted) continue;
    if (!Object.hasOwn(row, field)) {
      throw new Error(
        `Prisma select asked for "${field}", which this fixture row does not define. ` +
          'Add it to the fixture rather than letting the double invent the row shape.',
      );
    }
    projected[field] = (row as Record<string, unknown>)[field];
  }
  return projected as Partial<DocumentPublicationRecord>;
}

/**
 * The fallback (non-raw-SQL) Prisma path the outbox takes when the client
 * exposes neither `$queryRaw` nor `$transaction`. Deliberately the same double
 * shape `document-storage-deletion-fixtures.ts` uses for the sibling outbox.
 */
function buildFallbackPrisma(initial: DocumentPublicationRecord) {
  let row = { ...initial };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const delegate = {
    findMany: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => {
      if (args.where.state === 'PENDING') {
        return row.state === 'PENDING' ? [applyPrismaSelect(row, args)] : [];
      }
      if (args.where.state === 'DEAD_LETTER') {
        return row.state === 'DEAD_LETTER' && row.alertedAt === null
          ? [applyPrismaSelect(row, args)]
          : [];
      }
      return [];
    },
    findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      if (args.where.id !== row.id || args.where.state !== row.state) return null;
      if (Object.hasOwn(args.where, 'claimedAt') && args.where.claimedAt !== row.claimedAt) return null;
      return applyPrismaSelect(row, args);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updates.push(args);
      const idFilter = args.where.id;
      if (typeof idFilter === 'string' && idFilter !== row.id) return { count: 0 };
      if (
        typeof idFilter === 'object' &&
        idFilter !== null &&
        Array.isArray((idFilter as { in?: unknown[] }).in) &&
        !((idFilter as { in: unknown[] }).in).includes(row.id)
      ) {
        return { count: 0 };
      }
      if (args.where.state && args.where.state !== row.state) return { count: 0 };
      if (typeof args.where.attempts === 'number' && args.where.attempts !== row.attempts) return { count: 0 };
      if (Object.hasOwn(args.where, 'claimedAt') && args.where.claimedAt !== row.claimedAt) return { count: 0 };
      if (Object.hasOwn(args.where, 'publishedAt') && args.where.publishedAt !== row.publishedAt) {
        return { count: 0 };
      }
      if (args.where.alertClaimToken && args.where.alertClaimToken !== row.alertClaimToken) {
        return { count: 0 };
      }
      row = { ...row, ...args.data } as DocumentPublicationRecord;
      return { count: 1 };
    },
  };
  return {
    prisma: { documentPublication: delegate },
    updates,
    row: () => row,
  };
}

type SpyOverrides = {
  operations?: Partial<ConfluencePublishOperations>;
  readTarget?: () => Promise<ConfluencePublishTarget | null>;
  readDocument?: () => Promise<PublicationSource>;
  connect?: () => Promise<ConfluenceClient>;
  downloadFile?: () => Promise<Uint8Array>;
  /** Fires on every recorded step, before the step answers. Lets a test abort mid-sequence. */
  onCall?: (name: string) => void;
};

/**
 * Deps whose every seam records the call it was asked to make, in order.
 * Nothing here reaches Confluence, Supabase or Prisma.
 */
function spyDeps(calls: string[], overrides: SpyOverrides = {}): ConfluencePublisherDeps {
  const record = (name: string) => {
    calls.push(name);
    overrides.onCall?.(name);
  };

  return {
    readTarget: async () => {
      record('readTarget');
      return overrides.readTarget ? overrides.readTarget() : TARGET;
    },
    readDocument: async () => {
      record('readDocument');
      return overrides.readDocument ? overrides.readDocument() : DOC;
    },
    connect: async () => {
      record('connect');
      return overrides.connect ? overrides.connect() : CLIENT;
    },
    downloadFile: async () => {
      record('downloadFile');
      return overrides.downloadFile ? overrides.downloadFile() : new Uint8Array([1, 2, 3]);
    },
    operations: {
      findPageByTitle: async (client, spaceId, title) => {
        record(`findPageByTitle:${spaceId}:${title}`);
        return overrides.operations?.findPageByTitle
          ? overrides.operations.findPageByTitle(client, spaceId, title)
          : null;
      },
      createPage: async (client, input) => {
        record(`createPage:${input.spaceId}:${input.title}`);
        return overrides.operations?.createPage
          ? overrides.operations.createPage(client, input)
          : { ...PAGE, title: input.title };
      },
      uploadAttachment: async (client, input) => {
        record(`uploadAttachment:${input.pageId}:${input.filename}`);
        return overrides.operations?.uploadAttachment
          ? overrides.operations.uploadAttachment(client, input)
          : ATTACHMENT;
      },
      setContentProperty: async (client, pageId, key, value) => {
        record(`setContentProperty:${pageId}:${key}`);
        if (overrides.operations?.setContentProperty) {
          await overrides.operations.setContentProperty(client, pageId, key, value);
        }
      },
    },
  };
}

function runPublisher(
  deps: ConfluencePublisherDeps,
  options: {
    row?: DocumentPublicationRecord;
    signal?: AbortSignal;
    recordPage?: (page: { pageId: string }) => Promise<void>;
  } = {},
): Promise<PublicationOutcome> {
  const publisher = createConfluencePublisher(deps);
  return publisher({
    row: options.row ?? publicationRow(),
    signal: options.signal,
    recordPage: options.recordPage ?? (async () => undefined),
  });
}

function appError(error: unknown): AppError {
  assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
  return error;
}

// ---------------------------------------------------------------------------
// The happy path, and the order every other test is a deviation from
// ---------------------------------------------------------------------------

test('a publication creates the page, records it, attaches the file, then writes the property', async () => {
  const calls: string[] = [];
  const outcome = await runPublisher(spyDeps(calls), {
    recordPage: async (page) => {
      calls.push(`recordPage:${page.pageId}`);
    },
  });

  assert.deepEqual(calls, [
    'readTarget',
    'readDocument',
    'connect',
    `findPageByTitle:space-1:${TITLE}`,
    `createPage:space-1:${TITLE}`,
    'recordPage:page-1',
    'downloadFile',
    'uploadAttachment:page-1:Safeguarding Policy',
    `setContentProperty:page-1:${CHARITYPILOT_PROPERTY_KEY}`,
  ]);
  assert.equal(outcome.pageId, 'page-1');
  assert.equal(outcome.cloudId, 'cloud-1');
  assert.equal(outcome.spaceId, 'space-1');
  assert.equal(outcome.attachmentId, 'att-1');
});

test('the outcome carries the erasure target in Phase 5 exact shape', async () => {
  const outcome = await runPublisher(spyDeps([]));

  assert.deepEqual(outcome.targetRef, {
    kind: 'confluence',
    cloudId: 'cloud-1',
    pageId: 'page-1',
    attachmentIds: ['att-1'],
  });
});

test('the page id is recorded before a single byte is uploaded to it', async () => {
  const calls: string[] = [];
  await runPublisher(spyDeps(calls), {
    recordPage: async (page) => {
      calls.push(`recordPage:${page.pageId}`);
    },
  });

  const recorded = calls.indexOf('recordPage:page-1');
  const uploaded = calls.findIndex((call) => call.startsWith('uploadAttachment:'));
  const downloaded = calls.indexOf('downloadFile');
  assert.notEqual(recorded, -1, 'the page must be recorded at all');
  assert.ok(recorded < downloaded, 'the page id must be recorded before the bytes are fetched');
  assert.ok(recorded < uploaded, 'the page id must be recorded before the upload');
});

// ---------------------------------------------------------------------------
// Create-or-adopt: the three ways a page is arrived at, and the one that must
// never happen twice
// ---------------------------------------------------------------------------

test('an existing page with this title is adopted and createPage is never called', async () => {
  const calls: string[] = [];
  const outcome = await runPublisher(
    spyDeps(calls, { operations: { findPageByTitle: async () => PAGE } }),
  );

  assert.equal(outcome.pageId, 'page-1');
  assert.equal(
    calls.filter((call) => call.startsWith('createPage:')).length,
    0,
    'a page that already exists must be adopted, never created a second time',
  );
});

test('a page id the row already records is adopted without any lookup', async () => {
  const calls: string[] = [];
  const outcome = await runPublisher(spyDeps(calls), {
    row: publicationRow({ cloudId: 'cloud-1', pageId: 'page-1', pageTitle: TITLE }),
  });

  assert.equal(outcome.pageId, 'page-1');
  assert.deepEqual(
    calls.filter((call) => call.startsWith('findPageByTitle:') || call.startsWith('createPage:')),
    [],
    'a crash between the create and the attach must resume from the row, not from a search ' +
      'that may not yet see the page — and it must never reach createPage',
  );
});

test('a conflict on create adopts the page a previous attempt made, creating only once', async () => {
  const calls: string[] = [];
  let lookups = 0;
  const outcome = await runPublisher(
    spyDeps(calls, {
      operations: {
        findPageByTitle: async () => {
          lookups += 1;
          // Nothing the first time; the page a previous attempt made on the
          // re-read that follows the 409.
          return lookups === 1 ? null : PAGE;
        },
        createPage: async () => {
          throw new AppError(409, 'CONFLUENCE_CONFLICT', 'Confluence request failed with status 409.');
        },
      },
    }),
  );

  assert.equal(outcome.pageId, 'page-1');
  assert.equal(
    calls.filter((call) => call.startsWith('createPage:')).length,
    1,
    'a 409 must never be answered with a second create',
  );
  assert.equal(
    calls.filter((call) => call.startsWith('findPageByTitle:')).length,
    2,
    'the adopt decision comes from exactly one independent re-read',
  );
});

// ---------------------------------------------------------------------------
// Create-or-adopt against a site that rewrites the title it stores.
//
// Every wiki trims a page title and collapses the whitespace inside it. If the
// title this codebase computes is not already in that form, the store holds
// something else, the next attempt's findPageByTitle searches for a title
// nothing holds, and the deliberately non-idempotent createPage runs again --
// two pages for one board resolution. The defence is in publicationTitle;
// these two tests are the end-to-end proof that it holds where it matters.
//
// Control characters are built with `String.fromCharCode`, never a literal
// escape sequence: such an escape has previously round-tripped into a raw
// control byte on disk instead of staying as escape-sequence text.
// ---------------------------------------------------------------------------

const UNTIDY_DOC: PublicationSource = {
  ...DOC,
  name: `  Safeguarding${String.fromCharCode(10)}${String.fromCharCode(0)}Policy  `,
};

/**
 * A Confluence stand-in that is honest in every respect but one: when
 * `normalisesStoredTitles` is set it stores the trimmed, whitespace-collapsed
 * form of the title it was handed, the way a real page store does. Lookups are
 * honest either way -- an exact match against what is actually stored.
 */
function fakeSite(normalisesStoredTitles: boolean) {
  const pages: Array<{ id: string; title: string }> = [];

  const operations: Partial<ConfluencePublishOperations> = {
    findPageByTitle: async (_client, _spaceId, title) => {
      const found = pages.find((page) => page.title === title);
      return found === undefined ? null : { ...PAGE, id: found.id, title: found.title };
    },
    createPage: async (_client, input) => {
      const stored = normalisesStoredTitles ? input.title.trim().replace(/\s+/g, ' ') : input.title;
      const page = { id: `page-${pages.length + 1}`, title: stored };
      pages.push(page);
      return { ...PAGE, id: page.id, title: page.title };
    },
  };

  return { pages, operations };
}

/**
 * Two attempts for one document whose row never recorded a page id -- the
 * ordinary transport failure this outbox exists for: the create succeeded and
 * the connection dropped before `recordPage` committed. Returns what the site
 * holds afterwards and which page the second attempt settled on.
 */
async function retryAgainstSite(normalisesStoredTitles: boolean) {
  const site = fakeSite(normalisesStoredTitles);
  const deps = () =>
    spyDeps([], { readDocument: async () => UNTIDY_DOC, operations: site.operations });

  const first = await runPublisher(deps());
  const second = await runPublisher(deps());

  return { pages: site.pages, first, second };
}

test('a retried publish of an untidily named document creates only one page on a site that normalises titles', async () => {
  const { pages, first, second } = await retryAgainstSite(true);

  assert.equal(
    pages.length,
    1,
    `one board resolution must never become two pages; the site holds ${JSON.stringify(pages.map((page) => page.id))}`,
  );
  assert.equal(second.pageId, first.pageId, 'the retry must adopt the page the first attempt made');
});

test('CONTROL: the same retry against a site that stores the title verbatim also adopts', async () => {
  // The canary for the test above: if this one ever fails, the harness is
  // broken rather than the behaviour it claims to measure.
  const { pages, first, second } = await retryAgainstSite(false);

  assert.equal(pages.length, 1);
  assert.equal(second.pageId, first.pageId);
});

test('a conflict whose re-read finds nothing is the one unresolved conflict', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      runPublisher(
        spyDeps(calls, {
          operations: {
            findPageByTitle: async () => null,
            createPage: async () => {
              throw new AppError(409, 'CONFLUENCE_CONFLICT', 'Confluence request failed with status 409.');
            },
          },
        }),
      ),
    (error: unknown) => {
      assert.equal(appError(error).code, 'CONFLUENCE_PUBLISH_CONFLICT_UNRESOLVED');
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.startsWith('createPage:')).length, 1);
});

test('a 5xx on create is not mistaken for a conflict, and provokes no re-read', async () => {
  const calls: string[] = [];
  let lookups = 0;
  await assert.rejects(
    () =>
      runPublisher(
        spyDeps(calls, {
          operations: {
            findPageByTitle: async () => {
              lookups += 1;
              return lookups === 1 ? null : PAGE;
            },
            createPage: async () => {
              throw new AppError(502, 'CONFLUENCE_REQUEST_FAILED', 'Confluence request failed with status 502.');
            },
          },
        }),
      ),
    (error: unknown) => {
      assert.equal(appError(error).code, 'CONFLUENCE_REQUEST_FAILED');
      return true;
    },
  );
  assert.equal(
    lookups,
    1,
    'only a 409 earns the one re-read; every other create failure is transient and the whole ' +
      'attempt is retried, which the adopt-from-the-row path then makes safe',
  );
});

test('the create-or-adopt decision never reads the upstream error body', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'services', 'document-publication.service.ts'),
    'utf8',
  );
  // A 409 is disambiguated by an independent re-read and by nothing else. The
  // containment rule exists because a proxy once put a live authorization code
  // in an error body.
  for (const forbidden of [/error\.details\.\s*body/, /\.body\b/, /responseBody/i]) {
    assert.doesNotMatch(source, forbidden);
  }
});

// ---------------------------------------------------------------------------
// The target this publish is about to store, validated by the parser that
// will later read it
// ---------------------------------------------------------------------------

test('publicationErasureTarget builds the exact shape Phase 5 reads', () => {
  assert.deepEqual(
    publicationErasureTarget({ cloudId: 'cloud-1', pageId: 'page-1', attachmentId: 'att-1' }),
    { kind: 'confluence', cloudId: 'cloud-1', pageId: 'page-1', attachmentIds: ['att-1'] },
  );
  assert.deepEqual(
    publicationErasureTarget({ cloudId: 'cloud-1', pageId: 'page-1', attachmentId: null }),
    { kind: 'confluence', cloudId: 'cloud-1', pageId: 'page-1', attachmentIds: [] },
  );
});

for (const [label, row] of [
  ['an untrimmed page id', { cloudId: 'cloud-1', pageId: ' page-1 ', attachmentId: null }],
  ['an untrimmed cloud id', { cloudId: 'cloud-1 ', pageId: 'page-1', attachmentId: null }],
  ['an untrimmed attachment id', { cloudId: 'cloud-1', pageId: 'page-1', attachmentId: ' att-1' }],
  ['a missing page id', { cloudId: 'cloud-1', pageId: null, attachmentId: null }],
] as const) {
  test(`publicationErasureTarget refuses ${label}`, () => {
    assert.throws(
      () => publicationErasureTarget(row),
      (error: unknown) => {
        assert.equal(appError(error).code, 'ERASURE_TARGET_MALFORMED');
        return true;
      },
    );
  });
}

test('a page id Confluence returns with surrounding whitespace is refused before it is recorded', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      runPublisher(
        spyDeps(calls, {
          operations: { createPage: async () => ({ ...PAGE, id: ' page-1 ' }) },
        }),
        {
          recordPage: async (page) => {
            calls.push(`recordPage:${page.pageId}`);
          },
        },
      ),
    (error: unknown) => {
      // Refused as a PUBLISH failure, which is recoverable — rather than
      // written down and only refused when a charity asks for erasure, after
      // the authoritative Irish copy is gone.
      assert.equal(appError(error).code, 'ERASURE_TARGET_MALFORMED');
      return true;
    },
  );
  assert.equal(
    calls.some((call) => call.startsWith('recordPage:')),
    false,
    'a target the erasure parser would refuse must never reach the row',
  );
  assert.equal(calls.some((call) => call.startsWith('uploadAttachment:')), false);
});

for (const field of ['cloudId', 'spaceId'] as const) {
  test(`an untrimmed ${field} on the destination fails before a connection is opened`, async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        runPublisher(
          spyDeps(calls, { readTarget: async () => ({ ...TARGET, [field]: ` ${TARGET[field]} ` }) }),
        ),
      (error: unknown) => {
        assert.equal(appError(error).code, 'ERASURE_TARGET_MALFORMED');
        return true;
      },
    );
    assert.equal(
      calls.includes('connect'),
      false,
      'the same reason Phase 5 validates before connecting: nothing is issued from an ' +
        'unvalidated shape',
    );
  });
}

// ---------------------------------------------------------------------------
// Nowhere to publish, and nowhere safe to republish
// ---------------------------------------------------------------------------

test('an organisation with no chosen space has nowhere to publish', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runPublisher(spyDeps(calls, { readTarget: async () => null })),
    (error: unknown) => {
      assert.equal(appError(error).code, 'CONFLUENCE_PUBLISH_DESTINATION_MISSING');
      return true;
    },
  );
  assert.equal(calls.includes('connect'), false);
});

test('a connection that cannot be opened is a publish that cannot be retried into working', async () => {
  for (const code of ['INTEGRATION_NOT_FOUND', 'CONFLUENCE_RECONNECT_REQUIRED']) {
    await assert.rejects(
      () =>
        runPublisher(
          spyDeps([], {
            connect: async () => {
              throw new AppError(409, code, 'x');
            },
          }),
        ),
      (error: unknown) => {
        assert.equal(appError(error).code, 'CONFLUENCE_NOT_CONNECTED');
        return true;
      },
    );
  }
});

test('a row recorded on another site is never republished over', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      runPublisher(spyDeps(calls), {
        row: publicationRow({ cloudId: 'cloud-OLD', pageId: 'page-1' }),
      }),
    (error: unknown) => {
      assert.equal(appError(error).code, 'CONFLUENCE_PUBLISH_SITE_CHANGED');
      return true;
    },
  );
  assert.equal(
    calls.includes('connect'),
    false,
    'republishing would strand the first page with nothing recording where it is',
  );
});

test('a claim lost mid-attempt stops the sequence before the upload', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      runPublisher(spyDeps(calls), {
        recordPage: async () => {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_CLAIM_LOST', 'x');
        },
      }),
    (error: unknown) => {
      assert.equal(appError(error).code, 'DOCUMENT_PUBLICATION_CLAIM_LOST');
      return true;
    },
  );
  assert.equal(calls.includes('downloadFile'), false);
  assert.equal(calls.some((call) => call.startsWith('uploadAttachment:')), false);
});

// ---------------------------------------------------------------------------
// A 403 on a write names what is missing; a 401 stays transient
// ---------------------------------------------------------------------------

const FORBIDDEN = new AppError(403, 'CONFLUENCE_RECONNECT_REQUIRED', 'Confluence request failed with status 403.', {
  status: 403,
});
const UNAUTHORIZED = new AppError(401, 'CONFLUENCE_RECONNECT_REQUIRED', 'Confluence request failed with status 401.', {
  status: 401,
});

for (const [label, operations] of [
  ['creating a page', { createPage: async () => { throw FORBIDDEN; } }],
  ['attaching a file', { uploadAttachment: async () => { throw FORBIDDEN; } }],
  ['writing the content property', { setContentProperty: async () => { throw FORBIDDEN; } }],
] as ReadonlyArray<[string, Partial<ConfluencePublishOperations>]>) {
  test(`a 403 ${label} names the space whose permission is missing`, async () => {
    await assert.rejects(
      () => runPublisher(spyDeps([], { operations })),
      (error: unknown) => {
        const failure = appError(error);
        assert.equal(failure.code, 'CONFLUENCE_PUBLISH_FORBIDDEN');
        assert.match(failure.message, /GOV/, 'the operator has to know which space to fix');
        return true;
      },
    );
  });
}

for (const [label, operations] of [
  ['creating a page', { createPage: async () => { throw UNAUTHORIZED; } }],
  ['attaching a file', { uploadAttachment: async () => { throw UNAUTHORIZED; } }],
] as ReadonlyArray<[string, Partial<ConfluencePublishOperations>]>) {
  test(`a 401 ${label} is left alone, because a token can expire mid-attempt`, async () => {
    await assert.rejects(
      () => runPublisher(spyDeps([], { operations })),
      (error: unknown) => {
        assert.equal(appError(error).code, 'CONFLUENCE_RECONNECT_REQUIRED');
        return true;
      },
    );
  });
}

// ---------------------------------------------------------------------------
// The abort, pinned at every call site separately
//
// Removing six guards at once cannot distinguish "every site is guarded" from
// "at least one is" — a real finding in Phase 5, so each guard has its own
// test and its own expected prefix.
// ---------------------------------------------------------------------------

const ABORT_SITES: ReadonlyArray<{
  name: string;
  abortOn: string | null;
  expected: readonly string[];
  operations?: Partial<ConfluencePublishOperations>;
}> = [
  { name: 'before the destination is read', abortOn: null, expected: [] },
  { name: 'before the document is read', abortOn: 'readTarget', expected: ['readTarget'] },
  {
    name: 'before the connection is opened',
    abortOn: 'readDocument',
    expected: ['readTarget', 'readDocument'],
  },
  {
    name: 'before the page is looked up',
    abortOn: 'connect',
    expected: ['readTarget', 'readDocument', 'connect'],
  },
  {
    name: 'before the page is created',
    abortOn: `findPageByTitle:space-1:${TITLE}`,
    expected: ['readTarget', 'readDocument', 'connect', `findPageByTitle:space-1:${TITLE}`],
  },
  {
    name: 'before the conflict re-read',
    abortOn: `createPage:space-1:${TITLE}`,
    expected: [
      'readTarget',
      'readDocument',
      'connect',
      `findPageByTitle:space-1:${TITLE}`,
      `createPage:space-1:${TITLE}`,
    ],
    operations: {
      createPage: async () => {
        throw new AppError(409, 'CONFLUENCE_CONFLICT', 'Confluence request failed with status 409.');
      },
    },
  },
  {
    name: 'before the bytes are fetched, but never before the page is recorded',
    abortOn: `createPage:space-1:${TITLE}`,
    expected: [
      'readTarget',
      'readDocument',
      'connect',
      `findPageByTitle:space-1:${TITLE}`,
      `createPage:space-1:${TITLE}`,
      'recordPage:page-1',
    ],
  },
  {
    name: 'before the file is uploaded',
    abortOn: 'downloadFile',
    expected: [
      'readTarget',
      'readDocument',
      'connect',
      `findPageByTitle:space-1:${TITLE}`,
      `createPage:space-1:${TITLE}`,
      'recordPage:page-1',
      'downloadFile',
    ],
  },
  {
    name: 'before the content property is written',
    abortOn: 'uploadAttachment:page-1:Safeguarding Policy',
    expected: [
      'readTarget',
      'readDocument',
      'connect',
      `findPageByTitle:space-1:${TITLE}`,
      `createPage:space-1:${TITLE}`,
      'recordPage:page-1',
      'downloadFile',
      'uploadAttachment:page-1:Safeguarding Policy',
    ],
  },
];

for (const site of ABORT_SITES) {
  test(`an abort stops the publish ${site.name}`, async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    if (site.abortOn === null) controller.abort();

    await assert.rejects(
      () =>
        runPublisher(
          spyDeps(calls, {
            operations: site.operations,
            onCall: (name) => {
              if (name === site.abortOn) controller.abort();
            },
          }),
          {
            signal: controller.signal,
            recordPage: async (page) => {
              calls.push(`recordPage:${page.pageId}`);
            },
          },
        ),
      (error: unknown) => {
        assert.equal(appError(error).code, 'CONFLUENCE_PUBLISH_ABORTED');
        return true;
      },
    );

    assert.deepEqual(calls, [...site.expected]);
  });
}

// ---------------------------------------------------------------------------
// The attachment filename, which a retry depends on being the same
// ---------------------------------------------------------------------------

test('the attachment filename is a pure function of the document', () => {
  assert.equal(publicationFilename(DOC), 'Safeguarding Policy');
  assert.equal(publicationFilename(DOC), publicationFilename({ id: DOC.id, name: DOC.name }));
});

test('the attachment filename survives a name Confluence would refuse', () => {
  assert.equal(
    publicationFilename({ id: 'doc-9', name: 'minutes/2026\\April.pdf' }),
    'minutes-2026-April.pdf',
  );
  // A name that sanitises to nothing still has to produce a filename, or the
  // upload fails permanently on a document a charity was allowed to name.
  assert.equal(publicationFilename({ id: 'doc-9', name: '   ' }), 'charitypilot-document-doc-9');
  assert.equal(publicationFilename({ id: 'doc-9', name: '..' }), 'charitypilot-document-doc-9');
  assert.ok(publicationFilename({ id: 'doc-9', name: 'x'.repeat(400) }).length <= 255);
});

// ---------------------------------------------------------------------------
// The outbox: what each failure does to the row
// ---------------------------------------------------------------------------

function outcome(): PublicationOutcome {
  return {
    cloudId: 'cloud-1',
    spaceId: 'space-1',
    pageId: 'page-1',
    pageTitle: TITLE,
    attachmentId: 'att-1',
    targetRef: { kind: 'confluence', cloudId: 'cloud-1', pageId: 'page-1', attachmentIds: ['att-1'] },
  };
}

function failingPublisher(error: unknown): Publisher {
  return async () => {
    throw error;
  };
}

test('a successful publication records where it went and is marked processed', async () => {
  const mock = buildFallbackPrisma(publicationRow());
  const service = new DocumentPublicationService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingPublications(async () => outcome(), 10);

  assert.equal(result.processed, 1);
  const row = mock.row();
  assert.equal(row.state, 'PROCESSED');
  assert.deepEqual(row.publishedAt, NOW);
  assert.equal(row.cloudId, 'cloud-1');
  assert.equal(row.pageId, 'page-1');
  assert.equal(row.attachmentId, 'att-1');
  assert.equal(row.nextAttemptAt, null);
});

test('the page is written to the row with publishedAt still null, mid-attempt', async () => {
  const mock = buildFallbackPrisma(publicationRow());
  const service = new DocumentPublicationService(mock.prisma as never, () => NOW);

  // A publisher that records the page and then fails, which is exactly the
  // crash the next attempt must adopt from rather than create over.
  await service.retryPendingPublications(async ({ recordPage }) => {
    await recordPage({ cloudId: 'cloud-1', spaceId: 'space-1', pageId: 'page-1', pageTitle: TITLE });
    throw new AppError(502, 'CONFLUENCE_UPSTREAM', 'x');
  }, 10);

  const row = mock.row();
  assert.equal(row.pageId, 'page-1');
  assert.equal(row.cloudId, 'cloud-1');
  assert.equal(
    row.publishedAt,
    null,
    'publishedAt is what distinguishes a recorded page from a finished publication, and the ' +
      'database CHECK depends on the distinction',
  );
  assert.equal(row.state, 'PENDING');
});

/**
 * Both directions, in one table.
 *
 * A predicate answering "permanent" to everything would satisfy every
 * dead-letter row below while turning a five-minute Atlassian blip into
 * dead-letters a human clears by hand — so the transient half is not optional
 * decoration, it is the half that gives the other half meaning.
 */
for (const [label, thrown, expectedState, expectedReason] of [
  [
    'no live connection',
    new AppError(409, 'CONFLUENCE_NOT_CONNECTED', 'x'),
    'DEAD_LETTER',
    'PERMANENT_CONNECTION_UNAVAILABLE',
  ],
  [
    'no chosen destination',
    new AppError(409, 'CONFLUENCE_PUBLISH_DESTINATION_MISSING', 'x'),
    'DEAD_LETTER',
    'PERMANENT_CONNECTION_UNAVAILABLE',
  ],
  [
    'a forbidden write',
    new AppError(403, 'CONFLUENCE_PUBLISH_FORBIDDEN', 'x'),
    'DEAD_LETTER',
    'PERMANENT_PERMISSION_DENIED',
  ],
  [
    'an unresolved conflict',
    new AppError(409, 'CONFLUENCE_PUBLISH_CONFLICT_UNRESOLVED', 'x'),
    'DEAD_LETTER',
    'PERMANENT_CONFLICT_UNRESOLVED',
  ],
  [
    'an ambiguous title',
    new AppError(409, 'CONFLUENCE_PAGE_TITLE_AMBIGUOUS', 'x'),
    'DEAD_LETTER',
    'PERMANENT_CONFLICT_UNRESOLVED',
  ],
  [
    'a page recorded on another site',
    new AppError(409, 'CONFLUENCE_PUBLISH_SITE_CHANGED', 'x'),
    'DEAD_LETTER',
    'PERMANENT_CONFLICT_UNRESOLVED',
  ],
  [
    'an over-ceiling content property',
    new AppError(400, 'CONFLUENCE_CONTENT_PROPERTY_TOO_LARGE', 'x'),
    'DEAD_LETTER',
    'PERMANENT_CONTENT_PROPERTY_REJECTED',
  ],
  [
    'an unserialisable content property',
    new AppError(400, 'CONFLUENCE_CONTENT_PROPERTY_INVALID', 'x'),
    'DEAD_LETTER',
    'PERMANENT_CONTENT_PROPERTY_REJECTED',
  ],
  [
    'a target the erasure parser refuses',
    new AppError(500, 'ERASURE_TARGET_MALFORMED', 'x'),
    'DEAD_LETTER',
    'PERMANENT_TARGET_REF_REJECTED',
  ],
  // The transient half. Every one of these clears on its own.
  ['a 5xx from Atlassian', new AppError(502, 'CONFLUENCE_REQUEST_FAILED', 'x'), 'PENDING', null],
  ['a rate limit', new AppError(429, 'CONFLUENCE_RATE_LIMITED', 'x'), 'PENDING', null],
  [
    'a rate limit on an unsafe retry',
    new AppError(429, 'CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY', 'x'),
    'PENDING',
    null,
  ],
  ['an unreachable host', new AppError(503, 'CONFLUENCE_UNREACHABLE', 'x'), 'PENDING', null],
  [
    'an indeterminate write',
    new AppError(504, 'CONFLUENCE_REQUEST_INDETERMINATE', 'x'),
    'PENDING',
    null,
  ],
  ['a 401 on one request', new AppError(401, 'CONFLUENCE_RECONNECT_REQUIRED', 'x'), 'PENDING', null],
  [
    'a refresh already in flight',
    new AppError(409, 'CONFLUENCE_REFRESH_IN_PROGRESS', 'x'),
    'PENDING',
    null,
  ],
  ['an aborted attempt', new AppError(504, 'CONFLUENCE_PUBLISH_ABORTED', 'x'), 'PENDING', null],
  ['a lost claim', new AppError(409, 'DOCUMENT_PUBLICATION_CLAIM_LOST', 'x'), 'PENDING', null],
  ['a document that has gone', new AppError(404, 'DOCUMENT_NOT_FOUND', 'x'), 'PENDING', null],
  ['a storage read that failed', new AppError(500, 'STORAGE_DOWNLOAD_FAILED', 'x'), 'PENDING', null],
] as ReadonlyArray<[string, AppError, string, string | null]>) {
  test(`${label} leaves the publication ${expectedState}`, async () => {
    const mock = buildFallbackPrisma(publicationRow());
    const service = new DocumentPublicationService(mock.prisma as never, () => NOW);

    const result = await service.retryPendingPublications(failingPublisher(thrown), 10);

    const row = mock.row();
    assert.equal(row.state, expectedState);
    assert.equal(row.terminalReason, expectedReason);
    assert.equal(row.attempts, 1);
    assert.equal(result.processed, 0);
    assert.equal(row.publishedAt, null, 'a failed publish must never be recorded as published');
  });
}

test('a transient failure on the last permitted attempt exhausts rather than retries forever', async () => {
  const mock = buildFallbackPrisma(
    publicationRow({ attempts: DOCUMENT_PUBLICATION_MAX_ATTEMPTS - 1 }),
  );
  const service = new DocumentPublicationService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingPublications(
    failingPublisher(new AppError(502, 'CONFLUENCE_REQUEST_FAILED', 'x')),
    10,
  );

  assert.equal(result.newlyDeadLettered, 1);
  assert.equal(mock.row().state, 'DEAD_LETTER');
  assert.equal(mock.row().terminalReason, 'MAX_ATTEMPTS_EXHAUSTED');
  assert.equal(mock.row().nextAttemptAt, null);
});

test('an attempt that outruns its bound is a failed attempt, not a failed job', async () => {
  const mock = buildFallbackPrisma(publicationRow());
  const service = new DocumentPublicationService(mock.prisma as never, () => NOW, 20);

  const result = await service.retryPendingPublications(
    async ({ signal }) =>
      new Promise<PublicationOutcome>((_resolve, reject) => {
        // Never settles on its own: only the runner's abort ends it, which is
        // the case a publisher that ignored the signal would hang the job on.
        signal?.addEventListener('abort', () => reject(new AppError(504, 'CONFLUENCE_PUBLISH_ABORTED', 'x')));
      }),
    10,
  );

  assert.equal(result.processed, 0);
  assert.equal(mock.row().state, 'PENDING');
  assert.equal(mock.row().attempts, 1);
});

test('a late rejection from a timed-out publish attempt is observed rather than left unhandled', async () => {
  // A publisher that ignores its abort signal keeps running past the deadline
  // and may reject when nothing is awaiting it. In Node that terminates the
  // process, so one slow publish that eventually fails would take down the
  // scheduler that was about to process every other row. `Promise.race`
  // attaches a rejection handler to every entrant, which is what makes this
  // safe today; this test is what stops a refactor removing that property
  // silently -- and it is why the runner carries no separate `.catch()`.
  const mock = buildFallbackPrisma(publicationRow());
  const service = new DocumentPublicationService(mock.prisma as never, () => NOW, 20);

  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', observe);

  try {
    const result = await service.retryPendingPublications(
      () =>
        new Promise<PublicationOutcome>((_resolve, reject) => {
          setTimeout(() => reject(new Error('the publisher failed, long after the deadline')), 60);
        }),
      10,
    );

    assert.equal(result.processed, 0);
    assert.equal(mock.row().state, 'PENDING');

    // Past the late rejection, then a full turn of the loop: Node only reports
    // a rejection as unhandled once the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], 'the losing attempt rejection must be observed and discarded');
  } finally {
    process.off('unhandledRejection', observe);
  }
});

test('a dead-lettered publication is claimed for exactly one operator alert', async () => {
  const mock = buildFallbackPrisma(publicationRow());
  const service = new DocumentPublicationService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingPublications(
    failingPublisher(new AppError(403, 'CONFLUENCE_PUBLISH_FORBIDDEN', 'x')),
    10,
  );

  assert.ok(result.deadLetterAlert, 'a dead letter nobody is told about is a dead letter nobody clears');
  assert.deepEqual(result.deadLetterAlert?.ids, ['pub-1']);
  assert.equal(await service.markDeadLetterAlertSent(result.deadLetterAlert!), 1);
  assert.deepEqual(mock.row().alertedAt, NOW);
  assert.equal(mock.row().alertClaimToken, null);
});

// ---------------------------------------------------------------------------
// Both entry points, one test per registration.
//
// Phase 5 shipped a phase that was dead in production because only one of its
// two entry points was wired. A single test asserting both would go red either
// way, telling an operator that *a* registration was lost without telling them
// which — and the two have different consequences: losing the standalone job
// breaks a cron deployment, losing the scheduler breaks the one that actually
// runs in production.
//
// Read from source rather than imported: both files are top-level scripts, and
// importing either would open a Prisma connection and run the job.
// ---------------------------------------------------------------------------

function jobSource(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'jobs', file), 'utf8');
}

test('publish-document-mirrors.ts builds the Confluence publisher', () => {
  assert.match(
    jobSource('publish-document-mirrors.ts'),
    /createConfluencePublisher\(\{[\s\S]*?\bdownloadFile:/,
    'the standalone job must build a publisher with a downloadFile, or a cron deployment ' +
      'publishes nothing at all',
  );
});

test('publish-document-mirrors.ts runs the publication outbox', () => {
  assert.match(
    jobSource('publish-document-mirrors.ts'),
    /retryPendingPublications\(\s*publish/,
    'building a publisher and never running it publishes nothing',
  );
});

test('production-scheduler.ts builds the Confluence publisher', () => {
  assert.match(
    jobSource('production-scheduler.ts'),
    /createConfluencePublisher\(\{[\s\S]*?\bdownloadFile:/,
    'the in-process scheduler is the entry point that actually runs in production; without ' +
      'this registration the whole publish pipeline is dead there',
  );
});

test('production-scheduler.ts schedules the document publication job', () => {
  assert.match(
    jobSource('production-scheduler.ts'),
    /startRecurringJob\(\{\s*name: 'Document publication'[\s\S]*?run: \(\) => runDocumentPublication\(/,
    'a runner nothing schedules never runs',
  );
});

test('production-scheduler.ts waits for the publication job on shutdown', () => {
  assert.match(
    jobSource('production-scheduler.ts'),
    /waitForRecurringJobsToStop\(\s*\[[^\]]*documentPublicationJob/,
    'a job left out of the shutdown list keeps uploading while the process exits',
  );
});
