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
  // Validated by the route's zod schema and then discarded was the review
  // finding this pins: a DPO or regulator asking who authorised destroying
  // a specific page, and why, must get an actual answer from this row.
  assert.equal(mock.created[0].reason, 'Data subject erasure request 2026-41');
  assert.equal(mock.created[0].requestedById, 'user-1');
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

// The test above never exercises the `updateMany` where-clause's own fence
// (`erasureDeletionId: null`): its row already has `erasureDeletionId` set
// before `requestConfluenceErasure` is ever called, so the earlier,
// independent check right after `findFirst`
// (`publication.erasureDeletionId !== null`) throws first every time. A
// mutation that deletes the `updateMany` fence therefore leaves every test
// above green. This test drives the actual race the fence exists for: two
// requests both read the row while `erasureDeletionId` is still null, and
// only one may win the write.
test('a winner that commits between this request\'s read and its own write is not overwritten', async () => {
  const row: Record<string, unknown> = { ...RETIRED_ROW };
  const created: Array<Record<string, unknown>> = [];

  const client = {
    documentPublication: {
      // Always reads the row as it stood when this request STARTED its
      // transaction — `erasureDeletionId: null` — exactly as a real
      // `findFirst` would inside a request that began before the winner's
      // `updateMany` committed.
      findFirst: async () => ({ ...row }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (Object.hasOwn(args.where, 'erasureDeletionId') && row.erasureDeletionId !== args.where.erasureDeletionId) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    documentStorageDeletion: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        // The side effect that models the race: another request's own
        // findFirst-then-updateMany sequence completes and stamps the row
        // BETWEEN this request's `findFirst` (already read, above) and its
        // `updateMany` (below) — the exact window `erasureDeletionId: null`
        // in that `updateMany`'s where clause exists to close.
        row.erasureDeletionId = 'deletion-1';
        return { id: 'deletion-9' };
      },
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(client),
  };

  await assert.rejects(
    requestConfluenceErasure(client as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
  );

  assert.equal(
    row.erasureDeletionId,
    'deletion-1',
    "the winner's stamp must survive; the loser's updateMany must not overwrite it with its own id",
  );
});
