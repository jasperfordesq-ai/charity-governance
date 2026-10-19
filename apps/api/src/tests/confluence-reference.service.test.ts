import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  citationStaleness,
  checkConfluenceReference,
  citeConfluencePage,
  listConfluenceReferences,
  removeConfluenceReference,
} from '../services/confluence-reference.service.js';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { AppError } from '../utils/app-error.js';

const CLIENT = {} as ConfluenceClient;
const NOW = new Date('2026-09-21T10:00:00.000Z');

function page(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: 'page-1',
    title: 'Conflicts of Interest Policy',
    spaceId: 'space-1',
    version: 7,
    webUrl: 'https://charity.atlassian.net/wiki/spaces/GOV/pages/page-1',
    ...overrides,
  };
}

function fakePrisma(options: { documentExists?: boolean; recoveryBound?: boolean;
  rows?: Array<Record<string, unknown>> } = {}) {
  const rows = options.rows ?? [];
  const created: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const prisma = {
    async $transaction<T>(callback: (tx: unknown) => Promise<T>) { return callback(prisma); },
    $queryRaw: async () => [{ id: 'org-1' }],
    documentRecoveryEnforcement: {
      findUnique: async () => options.recoveryBound ? { id: 'binding' } : null,
    },
    documentControlAudit: {
      async create(args: { data: Record<string, unknown> }) {
        audits.push(args.data);
        return args.data;
      },
    },
    document: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (options.documentExists === false) return null;
        return { id: args.where.id };
      },
    },
    confluenceReference: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return rows.find((row) => Object.entries(args.where).every(([key, value]) => row[key] === value)) ?? null;
      },
      async findMany(args: { where: Record<string, unknown> }) {
        return rows.filter((row) =>
          Object.entries(args.where).every(([key, value]) => row[key] === value),
        );
      },
      async create(args: { data: Record<string, unknown> }) {
        created.push(args.data);
        return { id: 'ref-1', ...args.data };
      },
      async deleteMany(args: { where: Record<string, unknown> }) {
        deletes.push(args.where);
        const hits = rows.filter((row) =>
          Object.entries(args.where).every(([key, value]) => row[key] === value),
        );
        return { count: hits.length };
      },
    },
  } as never;

  return { prisma, created, deletes, audits };
}

const INPUT = {
  organisationId: 'org-1',
  documentId: 'doc-1',
  cloudId: 'site-1',
  pageId: 'page-1',
  citedById: 'user-1',
  now: NOW,
};

test('upstream citation check observes the real page version without rewriting evidence', async () => {
  const rows = [{ id: 'ref-1', organisationId: 'org-1', documentId: 'doc-1', cloudId: 'site-1',
    pageId: 'page-1', pageVersion: 7, pageTitle: 'Original title', citedAt: NOW }];
  const fake = fakePrisma({ rows });
  const before = JSON.stringify(rows);
  const result = await checkConfluenceReference(fake.prisma, { organisationId: 'org-1', referenceId: 'ref-1', now: NOW }, {
    getConnection: async () => ({ cloudId: 'site-1', generation: 'grant-1', client: CLIENT }),
    getPage: async (_client, pageId) => { assert.equal(pageId, 'page-1'); return page({ version: 9, status: 'current' }); },
  });
  assert.deepEqual(result, { referenceId: 'ref-1', status: 'SUPERSEDED', currentVersion: 9,
    checkedAt: NOW.toISOString(), reason: null });
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual([fake.created, fake.deletes, fake.audits], [[], [], []]);
});

test('upstream check scopes the citation before any provider access', async () => {
  const fake = fakePrisma({ rows: [{ id: 'foreign', organisationId: 'org-2' }] });
  let reads = 0;
  await assert.rejects(checkConfluenceReference(fake.prisma, { organisationId: 'org-1', referenceId: 'foreign' }, {
    getConnection: async () => { reads++; return null; },
  }), (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_REFERENCE_NOT_FOUND');
  assert.equal(reads, 0);
});

test('upstream check preserves uncertainty and never reads another site', async () => {
  for (const mode of ['disconnected', 'site-changed', 'grant-changed', 'missing', 'trashed', 'regressed', 'error', 'wrong-page'] as const) {
    const fake = fakePrisma({ rows: [{ id: 'ref-1', organisationId: 'org-1', documentId: 'doc-1',
      cloudId: 'site-1', pageId: 'page-1', pageVersion: 7 }] });
    let reads = 0; let connections = 0;
    const result = await checkConfluenceReference(fake.prisma, { organisationId: 'org-1', referenceId: 'ref-1' }, {
      getConnection: async () => { connections++;
        return mode === 'disconnected' ? null : { cloudId: mode === 'site-changed' ? 'other' : 'site-1',
          generation: mode === 'grant-changed' && connections > 1 ? 'grant-2' : 'grant-1', client: CLIENT };
      },
      getPage: async () => { reads++;
        if (mode === 'error') throw new Error('private provider details must not escape');
        if (mode === 'missing') return null;
        return page({ version: mode === 'regressed' ? 6 : 7,
          status: mode === 'trashed' ? 'trashed' : 'current', id: mode === 'wrong-page' ? 'different' : 'page-1' });
      },
    });
    assert.equal(result.status, 'UNKNOWN', mode);
    assert.equal(result.currentVersion, null, mode);
    assert.equal(reads, ['disconnected', 'site-changed'].includes(mode) ? 0 : 1, mode);
    assert.doesNotMatch(JSON.stringify(result), /private provider/);
    assert.deepEqual([fake.created, fake.deletes, fake.audits], [[], [], []]);
  }
});

test('a lower, invalid or absent current version cannot prove the cited version current', () => {
  for (const version of [6, 0, -1, NaN, Infinity, 7.5, null]) {
    assert.equal(citationStaleness({ pageVersion: 7 }, version), 'UNKNOWN');
  }
});

test('a document removed while its Confluence page is being read cannot acquire a new citation', async () => {
  const options = { documentExists: true };
  const fake = fakePrisma(options);
  await assert.rejects(citeConfluencePage(fake.prisma, CLIENT, INPUT, {
    getPage: async () => { options.documentExists = false; return page(); },
  }), (error: unknown) => error instanceof AppError && error.code === 'DOCUMENT_NOT_FOUND');
  assert.equal(fake.created.length, 0);
  assert.equal(fake.audits.length, 0);
});

test('citing a page records the version it was cited at', async () => {
  const fake = fakePrisma();

  const reference = await citeConfluencePage(fake.prisma, CLIENT, INPUT, {
    getPage: async () => page(),
  });

  // A citation without a version is not evidence: "this page" decays silently
  // as the page is edited, "this page at version 7 on this date" does not.
  assert.equal(reference.pageVersion, 7);
  assert.equal(reference.pageTitle, 'Conflicts of Interest Policy');
  assert.equal(reference.citedAt, NOW.toISOString());
  assert.equal(fake.created[0].citedById, 'user-1');
  assert.deepEqual(fake.audits[0], {
    organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1',
    kind: 'CONFLUENCE_REFERENCE', previous: 'UNLINKED', next: 'CITED:ref-1',
    reason: 'Confluence page citation added.',
  });
  assert.doesNotMatch(JSON.stringify(fake.audits[0]), /Conflicts of Interest Policy|atlassian\.net|page-1/);
});

test('recovery binding refuses citation changes before provider read or local mutation', async () => {
  const fake = fakePrisma({ recoveryBound: true,
    rows: [{ id: 'ref-1', organisationId: 'org-1', documentId: 'doc-1' }] });
  let providerReads = 0;
  const blocked = (error: unknown) => error instanceof AppError
    && error.code === 'CONFLUENCE_REFERENCE_RECOVERY_REQUIRED';
  await assert.rejects(citeConfluencePage(fake.prisma, CLIENT, INPUT, {
    getPage: async () => { providerReads += 1; return page(); },
  }), blocked);
  await assert.rejects(removeConfluenceReference(fake.prisma, {
    organisationId: 'org-1', referenceId: 'ref-1', actorUserId: 'user-1',
  }), blocked);
  assert.equal(providerReads, 0);
  assert.deepEqual(fake.created, []);
  assert.deepEqual(fake.deletes, []);
  assert.deepEqual(fake.audits, []);
});

test('the page is READ before it is cited, and a page that is not there is refused', async () => {
  const fake = fakePrisma();

  await assert.rejects(
    () => citeConfluencePage(fake.prisma, CLIENT, INPUT, { getPage: async () => null }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'CONFLUENCE_PAGE_NOT_FOUND');
      return true;
    },
  );

  // A citation pointing at nothing would be discovered by whoever went looking
  // for the evidence, which is exactly the moment it must not fail.
  assert.deepEqual(fake.created, []);
  assert.deepEqual(fake.audits, []);
});

test('a document belonging to another charity cannot be cited against', async () => {
  const fake = fakePrisma({ documentExists: false });
  let read = 0;

  await assert.rejects(
    () =>
      citeConfluencePage(fake.prisma, CLIENT, INPUT, {
        getPage: async () => {
          read += 1;
          return page();
        },
      }),
    /Document not found/,
  );

  // Refused before Confluence is touched at all.
  assert.equal(read, 0);
  assert.deepEqual(fake.created, []);
});

test('a page id that is not a plain identifier is refused before anything is read', async () => {
  const fake = fakePrisma();

  for (const pageId of ['../../admin', 'page/1', 'page?x=1', '']) {
    await assert.rejects(
      () =>
        citeConfluencePage(fake.prisma, CLIENT, { ...INPUT, pageId }, { getPage: async () => page() }),
      /plain identifier/,
      `for ${pageId}`,
    );
  }
});

test('the site is recorded with the page, because an id means nothing without it', async () => {
  const fake = fakePrisma();

  await citeConfluencePage(fake.prisma, CLIENT, INPUT, { getPage: async () => page() });

  assert.equal(fake.created[0].cloudId, 'site-1');
});

test('a page with no title still yields a usable citation', async () => {
  const fake = fakePrisma();

  const reference = await citeConfluencePage(fake.prisma, CLIENT, INPUT, {
    getPage: async () => page({ title: '' }),
  });

  // A missing display title is not a reason to refuse to record evidence.
  assert.equal(reference.pageTitle, 'page-1');
});

test('citations are listed newest first and scoped to the organisation', async () => {
  const fake = fakePrisma({
    rows: [
      { id: 'a', organisationId: 'org-1', documentId: 'doc-1', cloudId: 's', pageId: 'p1', pageTitle: 't', pageVersion: 1, citedAt: NOW },
      { id: 'b', organisationId: 'org-2', documentId: 'doc-1', cloudId: 's', pageId: 'p2', pageTitle: 't', pageVersion: 1, citedAt: NOW },
    ],
  });

  const references = await listConfluenceReferences(fake.prisma, {
    organisationId: 'org-1',
    documentId: 'doc-1',
  });

  assert.deepEqual(references.map((r) => r.id), ['a']);
});

test('removing a citation is scoped to the organisation and records the document change', async () => {
  const fake = fakePrisma({ rows: [{ id: 'ref-1', organisationId: 'org-1', documentId: 'doc-1' }] });

  const foreign = await removeConfluenceReference(fake.prisma, {
    organisationId: 'org-2', referenceId: 'ref-1', actorUserId: 'user-2',
  });
  assert.equal(foreign, false);
  assert.equal(fake.audits.length, 0);

  const removed = await removeConfluenceReference(fake.prisma, {
    organisationId: 'org-1',
    referenceId: 'ref-1',
    actorUserId: 'user-1',
  });

  assert.equal(removed, true);
  assert.deepEqual(fake.deletes[0], { id: 'ref-1', organisationId: 'org-1', documentId: 'doc-1' });
  assert.deepEqual(fake.audits[0], {
    organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'user-1',
    kind: 'CONFLUENCE_REFERENCE', previous: 'CITED:ref-1', next: 'UNLINKED',
    reason: 'Confluence page citation removed; the page was not changed.',
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

test('a page edited since it was cited reads as superseded, not as wrong', () => {
  assert.equal(citationStaleness({ pageVersion: 7 }, 9), 'SUPERSEDED');
  assert.equal(citationStaleness({ pageVersion: 7 }, 7), 'CURRENT');
  assert.equal(citationStaleness({ pageVersion: 7 }, null), 'UNKNOWN');
});

test('a page that has somehow gone backwards is not reported as superseded', () => {
  // Confluence versions do not decrease, so this is a reading we do not
  // understand rather than evidence that has moved on. An unexplained
  // observed regression cannot establish that the cited version is current.
  assert.equal(citationStaleness({ pageVersion: 7 }, 3), 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// The property the whole module exists for.
// ---------------------------------------------------------------------------

test('nothing in this module can write to, or delete, a cited page', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'services', 'confluence-reference.service.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // A cited page is the charity's own content, in their own site, written by
  // their people. CharityPilot's relationship is read-only. A
  // future edit that imported any write operation here would be reaching into
  // somebody else's document, and this is the guard that would stop it.
  for (const forbidden of [
    'createPage',
    'updatePage',
    'deletePage',
    'purgePage',
    'setContentProperty',
    'setContentState',
    'addPageLabels',
    'uploadAttachment',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `confluence-reference.service.ts must never reach ${forbidden}: a cited page is not ours`,
    );
  }

  // And it does read one, or the citation would record a version it never saw.
  assert.ok(code.includes('getPage'));
});
