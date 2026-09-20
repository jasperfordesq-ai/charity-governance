import test from 'node:test';
import assert from 'node:assert/strict';
import { requestConfluenceErasure } from '../services/confluence-erasure-request.service.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function buildPrisma(publication: Record<string, unknown> | null) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  let row = publication;

  const client = {
    documentPublication: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        if (row === null) return null;
        for (const [key, value] of Object.entries(args.where)) {
          if (row[key] !== value) return null;
        }
        return row;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updated.push(args);
        if (row === null || args.where.id !== row.id) return { count: 0 };
        if (Object.hasOwn(args.where, 'erasureDeletionId') && row.erasureDeletionId !== null) return { count: 0 };
        row = { ...row, ...args.data };
        return { count: 1 };
      },
    },
    documentStorageDeletion: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'deletion-9' };
      },
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(client),
  };

  return { prisma: client, created, updated, row: () => row };
}

const RETIRED_ROW = {
  id: 'publication-1',
  organisationId: 'org-1',
  provider: 'confluence',
  state: 'RETIRED',
  cloudId: 'cloud-1',
  pageId: 'page-1',
  attachmentId: 'att-1',
  retiredStoragePath: 'org-1/policy.pdf',
  erasureRequestedAt: null,
  erasureDeletionId: null,
};

test('an erasure request enqueues exactly the row the old delete path used to', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW });

  const result = await requestConfluenceErasure(mock.prisma as never, {
    organisationId: 'org-1',
    publicationId: 'publication-1',
    reason: 'Data subject erasure request 2026-41',
    requestedById: 'user-1',
    now: () => NOW,
  });

  assert.equal(result.deletionId, 'deletion-9');
  assert.equal(mock.created.length, 1);
  assert.equal(mock.created[0].provider, 'confluence');
  assert.equal(mock.created[0].storagePath, 'org-1/policy.pdf');
  assert.deepEqual(mock.created[0].targetRef, {
    kind: 'confluence',
    cloudId: 'cloud-1',
    pageId: 'page-1',
    attachmentIds: ['att-1'],
  });
});

test('the request is stamped on the publication so it cannot be made twice', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW });

  await requestConfluenceErasure(mock.prisma as never, {
    organisationId: 'org-1',
    publicationId: 'publication-1',
    reason: 'Data subject erasure request 2026-41',
    requestedById: 'user-1',
    now: () => NOW,
  });

  assert.equal(mock.row()!.erasureDeletionId, 'deletion-9');
  assert.deepEqual(mock.row()!.erasureRequestedAt, NOW);
});

test('a publication belonging to another charity is not found', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, organisationId: 'org-2' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { statusCode?: number; code?: string }) => error.code === 'CONFLUENCE_PUBLICATION_NOT_FOUND',
  );
  assert.equal(mock.created.length, 0);
});

test('a publication that is not retired cannot be erased', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, state: 'PROCESSED' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'CONFLUENCE_PUBLICATION_NOT_FOUND',
  );
  assert.equal(mock.created.length, 0, 'a live document must never have its page destroyed under it');
});

test('a malformed target is refused before any erasure row is written', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, pageId: '  page-1  ' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'ERASURE_TARGET_MALFORMED',
  );
  assert.equal(mock.created.length, 0);
});

test('a second request while the first is still queued is refused', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, erasureRequestedAt: NOW, erasureDeletionId: 'deletion-1' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
  );
  assert.equal(mock.created.length, 0);
});
