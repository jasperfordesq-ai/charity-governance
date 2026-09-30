import test from 'node:test';
import assert from 'node:assert/strict';
import { requestConfluenceErasure } from '../services/confluence-erasure-request.service.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function buildPrisma(publication: Record<string, unknown> | null, liveDocument = false) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  let failAudit = false;
  let row = publication;

  const client = {
    document: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        if (!liveDocument || row === null) return null;
        return args.where.id === row.documentId && args.where.organisationId === row.organisationId
          ? { id: row.documentId }
          : null;
      },
    },
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
        return { id: args.data.id };
      },
    },
    user: {
      findFirst: async () => ({ name: 'Ada Trustee', email: 'ada@example.org' }),
    },
    securityAuditEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (failAudit) throw new Error('Synthetic audit write failure');
        auditEvents.push(args.data);
        return { id: 'audit-1' };
      },
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      const beforeRow = row === null ? null : { ...row };
      const beforeCreated = created.length;
      const beforeUpdated = updated.length;
      const beforeAudit = auditEvents.length;
      try {
        return await callback(client);
      } catch (error) {
        row = beforeRow;
        created.length = beforeCreated;
        updated.length = beforeUpdated;
        auditEvents.length = beforeAudit;
        throw error;
      }
    },
  };

  return { prisma: client, created, updated, auditEvents, row: () => row, failAudit: () => { failAudit = true; } };
}

const RETIRED_ROW = {
  id: 'publication-1',
  organisationId: 'org-1',
  documentId: 'doc-1',
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

  assert.match(result.deletionId, /^[0-9a-f-]{36}$/);
  assert.equal(mock.created.length, 1);
  assert.equal(mock.created[0].id, result.deletionId);
  assert.equal(mock.created[0].provider, 'confluence');
  assert.equal(mock.created[0].sourceDocumentId, 'doc-1');
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
  assert.equal(mock.auditEvents.length, 1);
  assert.equal(mock.auditEvents[0].type, 'CONFLUENCE_ERASURE_REQUESTED');
  assert.equal(mock.auditEvents[0].actorUserId, 'user-1');
  assert.equal(mock.auditEvents[0].actorLabel, 'Ada Trustee');
  assert.deepEqual(mock.auditEvents[0].context, {
    publicationId: 'publication-1',
    storageDeletionId: result.deletionId,
    provider: 'CONFLUENCE',
  });
});

test('a failed audit insert rolls back the erasure request and publication stamp', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW });
  mock.failAudit();

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    /Synthetic audit write failure/,
  );

  assert.equal(mock.created.length, 0);
  assert.equal(mock.row()?.erasureDeletionId, null);
  assert.equal(mock.row()?.erasureRequestedAt, null);
  assert.equal(mock.auditEvents.length, 0);
});

test('the request is stamped on the publication so it cannot be made twice', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW });

  const result = await requestConfluenceErasure(mock.prisma as never, {
    organisationId: 'org-1',
    publicationId: 'publication-1',
    reason: 'Data subject erasure request 2026-41',
    requestedById: 'user-1',
    now: () => NOW,
  });

  assert.equal(mock.row()!.erasureDeletionId, result.deletionId);
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

test('a retired label cannot erase the Confluence copy while its CharityPilot document remains live', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW }, true);

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'CONFLUENCE_DOCUMENT_STILL_PRESENT',
  );
  assert.equal(mock.created.length, 0);
  assert.equal(mock.row()?.erasureDeletionId, null);
  assert.equal(mock.auditEvents.length, 0);
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
    document: {
      findFirst: async () => null,
    },
    documentPublication: {
      // Always reads the row as it stood when this request STARTED its
      // transaction — `erasureDeletionId: null` — exactly as a real
      // `findFirst` would inside a request that began before the winner's
      // `updateMany` committed.
      findFirst: async () => ({ ...row }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        // Another request commits after this one's read but before its write.
        row.erasureDeletionId = 'deletion-1';
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
        return { id: args.data.id };
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
  assert.equal(created.length, 0, 'the losing request never queues its job');
});
