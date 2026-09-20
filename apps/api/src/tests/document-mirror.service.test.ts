import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mirrorForDocument,
  mirrorsForDocuments,
  retryFailedPublication,
} from '../services/document-mirror.service.js';

const SITE = 'https://charity.atlassian.net';

type Row = Record<string, unknown>;

function fakePrisma(rows: Row[]) {
  const updates: Array<{ where: Row; data: Row }> = [];
  const queries: Row[] = [];
  const prisma = {
    documentPublication: {
      async findMany(args: { where: Row }) {
        queries.push(args.where);
        const wanted = (args.where.documentId as { in?: string[] } | undefined)?.in ?? [];
        return rows.filter(
          (row) =>
            row.organisationId === args.where.organisationId &&
            row.provider === args.where.provider &&
            wanted.includes(row.documentId as string),
        );
      },
      async updateMany(args: { where: Row; data: Row }) {
        updates.push(args);
        const hits = rows.filter((row) =>
          Object.entries(args.where).every(([key, value]) => row[key] === value),
        );
        for (const row of hits) Object.assign(row, args.data);
        return { count: hits.length };
      },
    },
  } as never;
  return { prisma, updates, queries, rows };
}

function publicationRow(overrides: Row = {}): Row {
  return {
    documentId: 'doc-1',
    organisationId: 'org-1',
    provider: 'confluence',
    state: 'PROCESSED',
    cloudId: 'site-1',
    pageId: 'page-1',
    pageTitle: 'Safeguarding Policy',
    remoteState: 'VISIBLE',
    remoteTitle: 'Safeguarding Policy',
    remoteVersion: 3,
    lastReconciledAt: new Date('2026-09-20T09:00:00.000Z'),
    reconcileError: null,
    ...overrides,
  };
}

test('every id asked for comes back, so a missing row is never ambiguous', async () => {
  const { prisma } = fakePrisma([publicationRow()]);

  const mirrors = await mirrorsForDocuments(prisma, {
    organisationId: 'org-1',
    documentIds: ['doc-1', 'doc-2', 'doc-3'],
    siteUrl: SITE,
  });

  assert.deepEqual([...mirrors.keys()].sort(), ['doc-1', 'doc-2', 'doc-3']);
  // A document with no publication row has a truthful answer, not a gap the
  // caller has to interpret.
  assert.equal(mirrors.get('doc-2')?.publication, 'NOT_PUBLISHED');
  assert.equal(mirrors.get('doc-1')?.publication, 'PUBLISHED');
});

test('a list is one query, not one per document', async () => {
  const { prisma, queries } = fakePrisma([publicationRow()]);

  await mirrorsForDocuments(prisma, {
    organisationId: 'org-1',
    documentIds: ['doc-1', 'doc-2', 'doc-3', 'doc-4'],
  });

  assert.equal(queries.length, 1, 'a documents page must not become an N+1');
});

test('no documents means no query at all', async () => {
  const { prisma, queries } = fakePrisma([publicationRow()]);

  const mirrors = await mirrorsForDocuments(prisma, { organisationId: 'org-1', documentIds: [] });

  assert.equal(mirrors.size, 0);
  assert.equal(queries.length, 0);
});

test('the read is scoped to the organisation, not to the document id alone', async () => {
  const { prisma, queries } = fakePrisma([publicationRow({ organisationId: 'org-2' })]);

  const mirrors = await mirrorsForDocuments(prisma, {
    organisationId: 'org-1',
    documentIds: ['doc-1'],
  });

  assert.equal(queries[0].organisationId, 'org-1');
  // Another charity's row must not reach this charity's screen.
  assert.equal(mirrors.get('doc-1')?.publication, 'NOT_PUBLISHED');
});

test('dead-lettered reads as FAILED, because "dead letter" means nothing to a trustee', async () => {
  const { prisma } = fakePrisma([publicationRow({ state: 'DEAD_LETTER' })]);

  const mirror = await mirrorForDocument(prisma, { organisationId: 'org-1', documentId: 'doc-1' });

  assert.equal(mirror.publication, 'FAILED');
});

test('never checked is distinct from checked-and-unknown', async () => {
  const { prisma } = fakePrisma([
    publicationRow({ documentId: 'never', remoteState: null, lastReconciledAt: null }),
    publicationRow({ documentId: 'refused', remoteState: 'UNKNOWN', reconcileError: 'CONFLUENCE_PAGE_FORBIDDEN' }),
  ]);

  const mirrors = await mirrorsForDocuments(prisma, {
    organisationId: 'org-1',
    documentIds: ['never', 'refused'],
  });

  // Null remote means the reconcile job has not reached this page; UNKNOWN
  // means the site refused to say. Collapsing them would have a charity chase a
  // permissions problem that does not exist.
  assert.equal(mirrors.get('never')?.remote, null);
  assert.equal(mirrors.get('refused')?.remote?.state, 'UNKNOWN');
  assert.equal(mirrors.get('refused')?.remote?.reconcileError, 'CONFLUENCE_PAGE_FORBIDDEN');
});

test('the page link is the stable redirect, which survives a rename', async () => {
  const { prisma } = fakePrisma([publicationRow()]);

  const mirror = await mirrorForDocument(prisma, {
    organisationId: 'org-1',
    documentId: 'doc-1',
    siteUrl: SITE,
  });

  // `/spaces/KEY/pages/...` breaks when a page is renamed or moved between
  // spaces; `viewpage.action?pageId=` is Confluence's own stable redirect.
  assert.equal(mirror.pageUrl, `${SITE}/wiki/pages/viewpage.action?pageId=page-1`);
});

test('no site url means no link, rather than a broken one', async () => {
  const { prisma } = fakePrisma([publicationRow()]);

  const mirror = await mirrorForDocument(prisma, { organisationId: 'org-1', documentId: 'doc-1' });

  assert.equal(mirror.pageUrl, null);
});

test('a row with no page id has no link', async () => {
  const { prisma } = fakePrisma([publicationRow({ state: 'PENDING', pageId: null })]);

  const mirror = await mirrorForDocument(prisma, {
    organisationId: 'org-1',
    documentId: 'doc-1',
    siteUrl: SITE,
  });

  assert.equal(mirror.publication, 'PENDING');
  assert.equal(mirror.pageUrl, null);
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

test('a failed publication is re-queued, and not as a first publication', async () => {
  const { prisma, rows } = fakePrisma([publicationRow({ state: 'DEAD_LETTER', attempts: 5 })]);

  const retried = await retryFailedPublication(prisma, {
    organisationId: 'org-1',
    documentId: 'doc-1',
  });

  assert.equal(retried, true);
  assert.equal(rows[0].state, 'PENDING');
  assert.equal(rows[0].attempts, 0);
  // The row already names a page, and the CHECK refuses a re-queue that claims
  // to be a CREATE.
  assert.equal(rows[0].reason, 'METADATA');
  assert.notEqual(rows[0].requeuedAt, undefined);
});

test('a retired publication is never revived by a retry', async () => {
  const { prisma, rows } = fakePrisma([publicationRow({ state: 'RETIRED' })]);

  const retried = await retryFailedPublication(prisma, {
    organisationId: 'org-1',
    documentId: 'doc-1',
  });

  // Reviving it would republish a document the charity deleted, which is
  // exactly what the owner's 2026-09-19 ruling forbids.
  assert.equal(retried, false);
  assert.equal(rows[0].state, 'RETIRED');
});

test('an already-queued publication is not re-queued, which would reset its backoff', async () => {
  const { prisma, rows } = fakePrisma([publicationRow({ state: 'PENDING', attempts: 3 })]);

  const retried = await retryFailedPublication(prisma, {
    organisationId: 'org-1',
    documentId: 'doc-1',
  });

  assert.equal(retried, false);
  assert.equal(rows[0].attempts, 3, 'a backoff protecting a rate-limited upstream must survive');
});

test('a retry cannot reach another organisation row', async () => {
  const { prisma, rows } = fakePrisma([
    publicationRow({ state: 'DEAD_LETTER', organisationId: 'org-2' }),
  ]);

  const retried = await retryFailedPublication(prisma, {
    organisationId: 'org-1',
    documentId: 'doc-1',
  });

  assert.equal(retried, false);
  assert.equal(rows[0].state, 'DEAD_LETTER');
});
