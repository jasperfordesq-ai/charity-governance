import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../utils/errors.js';
import {
  DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS,
  DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS,
  DOCUMENT_STORAGE_DELETION_CLAIM_SAFETY_MARGIN_MS,
  DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH,
  DocumentService,
  documentStorageDeletionRetryDelayMs,
} from '../services/document.service.js';
import {
  applyPrismaSelect,
  buildFallbackPrisma,
  pendingRecord,
  supabaseDispatcher,
} from './document-storage-deletion-fixtures.js';
import { DOCUMENT_PUBLICATION_MAX_ATTEMPTS } from '../services/document-publication.service.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

type OrganisationStorageRow = {
  documentStorageProvider: string | null;
  documentStorageAlphaOptIn?: boolean;
};

function buildEnqueueCapturingPrisma(
  created: Array<Record<string, unknown>>,
  organisation: OrganisationStorageRow | null = { documentStorageProvider: 'supabase' },
) {
  const client = {
    organisation: {
      findUnique: async () =>
        organisation
          ? { documentStorageAlphaOptIn: false, ...organisation }
          : null,
    },
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => ({ id: 'doc-1' }),
    },
    documentStorageDeletion: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'deletion-1' };
      },
    },
    documentStorageDeletionRecovery: { create: async () => ({ id: 'recovery-1' }) },
    // `remove()` also cancels a queued Confluence publication now (Task 7).
    // These tests are about the Supabase enqueue only, so there is never one
    // to find.
    documentPublication: { findFirst: async () => null },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(client),
  };
  return client;
}

async function enqueuedDeletionData(
  organisation: OrganisationStorageRow | null,
): Promise<Record<string, unknown>> {
  const created: Array<Record<string, unknown>> = [];
  const prisma = buildEnqueueCapturingPrisma(created, organisation);
  const service = new DocumentService(prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(created.length, 1);
  return created[0];
}

test('retryPendingStorageDeletions claims, deletes, and idempotently finalizes a due row', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const deleted: Array<{ organisationId: string; storagePath: string }> = [];
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(supabaseDispatcher(async (organisationId, storagePath) => {
    deleted.push({ organisationId, storagePath });
  }));

  assert.deepEqual(result, {
    processed: 1,
    failed: 0,
    retryScheduled: 0,
    newlyDeadLettered: 0,
    deadLetterAlert: null,
  });
  assert.deepEqual(deleted, [{ organisationId: 'org-1', storagePath: 'org-1/policy.pdf' }]);
  assert.equal(mock.row().state, 'PROCESSED');
  assert.equal(mock.row().processedAt, NOW);
  assert.equal(mock.row().nextAttemptAt, null);
  assert.equal(mock.row().claimedAt, null);
  assert.deepEqual(mock.finds[0], {
    where: {
      state: 'PENDING',
      processedAt: null,
      attempts: { lt: DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS },
      nextAttemptAt: { lte: NOW },
      OR: [
        { claimedAt: null },
        { claimedAt: { lt: new Date(NOW.getTime() - 10 * 60 * 1000) } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: 25,
  });
  assert.deepEqual(mock.updates[0].where, {
    id: 'deletion-1',
    state: 'PENDING',
    processedAt: null,
    attempts: 0,
    nextAttemptAt: { lte: NOW },
    OR: [
      { claimedAt: null },
      { claimedAt: { lt: new Date(NOW.getTime() - 10 * 60 * 1000) } },
    ],
  });

  const secondResult = await service.retryPendingStorageDeletions(supabaseDispatcher(async (organisationId, storagePath) => {
    deleted.push({ organisationId, storagePath });
  }));
  assert.deepEqual(secondResult, {
    processed: 0,
    failed: 0,
    retryScheduled: 0,
    newlyDeadLettered: 0,
    deadLetterAlert: null,
  });
  assert.deepEqual(deleted, [{ organisationId: 'org-1', storagePath: 'org-1/policy.pdf' }]);
});

test('Postgres claim query selects only due bounded pending rows with skip-locked ownership', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const updates: unknown[] = [];
  const claimedAt = new Date('2026-07-11T12:00:00.000Z');
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      queries.push({ sql, values });
      if (sql.includes('"state" = \'PENDING\'')) {
        return [pendingRecord({ claimedAt })];
      }
      return [];
    },
    documentStorageDeletion: {
      updateMany: async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    documentStorageDeletionRecovery: { create: async () => ({ id: 'recovery-1' }) },
  };
  const service = new DocumentService(prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(supabaseDispatcher(async () => undefined), 10);

  const pendingQuery = queries.find(({ sql }) => sql.includes('"state" = \'PENDING\''));
  assert.ok(pendingQuery);
  assert.match(pendingQuery.sql, /"nextAttemptAt" <= CURRENT_TIMESTAMP/);
  assert.match(pendingQuery.sql, /"attempts" < \?/);
  assert.match(pendingQuery.sql, /ORDER BY "nextAttemptAt" ASC, "createdAt" ASC/);
  assert.match(pendingQuery.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(pendingQuery.sql, /RETURNING[\s\S]*"claimedAt"/);
  assert.deepEqual(pendingQuery.values, [DOCUMENT_STORAGE_DELETION_MAX_ATTEMPTS, 600000, 10]);
  assert.equal(updates.length, 1);
  assert.equal(result.processed, 1);
});

test('transient failures schedule deterministic exponential backoff and retain sanitized diagnostics', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const service = new DocumentService(mock.prisma as never, () => NOW);
  const result = await service.retryPendingStorageDeletions(supabaseDispatcher(async () => {
    throw Object.assign(
      new Error('storage unavailable for ops@example.org at org-1/policy.pdf?token=secret-token'),
      { code: 'StorageApiError', status: 503 },
    );
  }));

  assert.equal(result.retryScheduled, 1);
  assert.equal(result.newlyDeadLettered, 0);
  assert.equal(result.deadLetterAlert, null);
  assert.equal(mock.row().state, 'PENDING');
  assert.equal(mock.row().attempts, 1);
  assert.equal(
    (mock.row().nextAttemptAt as Date).getTime(),
    NOW.getTime() + documentStorageDeletionRetryDelayMs(1),
  );
  const lastError = String(mock.row().lastError);
  assert.match(lastError, /code=StorageApiError/);
  assert.match(lastError, /status=503/);
  assert.match(lastError, /\[email\]/);
  assert.match(lastError, /\[storage-path\]/);
  assert.doesNotMatch(lastError, /secret-token|ops@example\.org/);
});

test('retry delay is deterministic, exponential, and capped', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 10].map(documentStorageDeletionRetryDelayMs),
    [5, 10, 20, 40, 80, 360].map((minutes) => minutes * 60 * 1000),
  );
  assert.throws(() => documentStorageDeletionRetryDelayMs(0), /positive integer/);
});

test('the fifth failed attempt becomes a claimed dead letter instead of retrying forever', async () => {
  const mock = buildFallbackPrisma(pendingRecord({ attempts: 4 }));
  const service = new DocumentService(mock.prisma as never, () => NOW);
  const result = await service.retryPendingStorageDeletions(supabaseDispatcher(async () => {
    throw new Error('provider still unavailable');
  }));

  assert.equal(result.retryScheduled, 0);
  assert.equal(result.newlyDeadLettered, 1);
  assert.equal(mock.row().state, 'DEAD_LETTER');
  assert.equal(mock.row().attempts, 5);
  assert.equal(mock.row().nextAttemptAt, null);
  assert.equal(mock.row().deadLetteredAt, NOW);
  assert.equal(mock.row().terminalReason, 'MAX_ATTEMPTS_EXHAUSTED');
  assert.ok(result.deadLetterAlert);
  assert.deepEqual(result.deadLetterAlert?.ids, ['deletion-1']);
  assert.equal(mock.row().alertClaimToken, result.deadLetterAlert?.claimToken);
});

test('permanently forbidden storage paths dead-letter on their first bounded attempt', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const service = new DocumentService(mock.prisma as never, () => NOW);
  const result = await service.retryPendingStorageDeletions(supabaseDispatcher(async () => {
    throw new AppError(403, 'STORAGE_PATH_FORBIDDEN', 'Storage path does not belong to this organisation');
  }));

  assert.equal(result.newlyDeadLettered, 1);
  assert.equal(mock.row().attempts, 1);
  assert.equal(mock.row().state, 'DEAD_LETTER');
  assert.equal(mock.row().terminalReason, 'PERMANENT_STORAGE_PATH_REJECTED');
  assert.ok(result.deadLetterAlert);
});

test('stale workers cannot finalize a row after claim ownership changes', async () => {
  const mock = buildFallbackPrisma(pendingRecord({ claimedAt: new Date('2026-07-11T11:00:00.000Z') }));
  const service = new DocumentService(mock.prisma as never, () => NOW);
  const finalized = await service.markStorageDeletionProcessed(
    'deletion-1',
    new Date('2026-07-11T10:00:00.000Z'),
  );
  assert.equal(finalized, false);
  assert.equal(mock.row().state, 'PENDING');
});

test('dead-letter alert acknowledgement and release are claim-token bound and idempotent', async () => {
  const mock = buildFallbackPrisma(pendingRecord({
    state: 'DEAD_LETTER',
    attempts: 5,
    nextAttemptAt: null,
    claimedAt: null,
    deadLetteredAt: NOW,
    terminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
    alertClaimToken: 'claim-1',
    alertClaimedAt: NOW,
  }));
  const service = new DocumentService(mock.prisma as never, () => NOW);
  assert.equal(await service.markDeadLetterAlertSent({ claimToken: 'wrong', ids: ['deletion-1'] }), 0);
  assert.equal(await service.releaseDeadLetterAlertClaim({ claimToken: 'claim-1', ids: ['deletion-1'] }), 1);
  assert.equal(mock.row().alertClaimToken, null);
  assert.equal(await service.releaseDeadLetterAlertClaim({ claimToken: 'claim-1', ids: ['deletion-1'] }), 0);
});

test('a hung provider deletion is aborted, recorded once, and cannot finalize late', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const service = new DocumentService(mock.prisma as never, () => NOW, 20);
  let suppliedSignal: AbortSignal | undefined;
  let providerResolved = false;

  const result = await service.retryPendingStorageDeletions(
    supabaseDispatcher(async (_organisationId, _storagePath, signal) => {
      suppliedSignal = signal;
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          providerResolved = true;
          resolve();
        }, 60);
      });
    }),
  );

  assert.equal(result.retryScheduled, 1);
  assert.equal(result.processed, 0);
  assert.equal(suppliedSignal?.aborted, true);
  assert.equal(mock.row().attempts, 1);
  assert.equal(mock.row().state, 'PENDING');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(providerResolved, true);
  assert.equal(mock.row().state, 'PENDING');
  assert.equal(mock.row().processedAt, null);
  assert.equal(mock.row().attempts, 1);
});

test('maximum sequential claim batch is derived below the stale lease boundary', async () => {
  assert.equal(DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH, 54);
  assert.ok(
    DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH * DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS <=
      10 * 60 * 1000 - DOCUMENT_STORAGE_DELETION_CLAIM_SAFETY_MARGIN_MS,
  );
  assert.ok(
    (DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH + 1) * DOCUMENT_STORAGE_DELETION_ATTEMPT_TIMEOUT_MS >
      10 * 60 * 1000 - DOCUMENT_STORAGE_DELETION_CLAIM_SAFETY_MARGIN_MS,
  );

  let take = 0;
  const prisma = {
    documentStorageDeletion: {
      findMany: async (args: { take: number; where: { state: string } }) => {
        take = args.where.state === 'PENDING' ? args.take : take;
        return [];
      },
      updateMany: async () => ({ count: 0 }),
    },
    documentStorageDeletionRecovery: { create: async () => ({ id: 'unused' }) },
  };
  const service = new DocumentService(prisma as never, () => NOW);
  await service.retryPendingStorageDeletions(supabaseDispatcher(async () => undefined), 1000);
  assert.equal(take, DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH);
});

test('an enqueued deletion names the supabase provider with no target reference', async () => {
  const data = await enqueuedDeletionData({ documentStorageProvider: 'supabase' });

  assert.equal(data.provider, 'supabase');
  assert.equal(data.targetRef ?? null, null);
});

test('an enqueued deletion for a local organisation names the local provider, not supabase', async () => {
  const data = await enqueuedDeletionData({ documentStorageProvider: 'local' });

  assert.equal(
    data.provider,
    'local',
    'a local organisation must not enqueue a row labelled supabase; Task 2 dispatches on this value',
  );
  assert.equal(data.targetRef ?? null, null);
});

test('an organisation with no recorded provider falls back to the deployment default', async () => {
  // Both halves pin DOCUMENT_STORAGE_DRIVER rather than reading whatever the
  // suite happens to leave in the environment, so this asserts the fallback and
  // not an ambient coincidence.
  const previous = process.env.DOCUMENT_STORAGE_DRIVER;
  const withDriver = async (driver: string | undefined) => {
    if (driver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = driver;
    const data = await enqueuedDeletionData({ documentStorageProvider: null });
    return data.provider;
  };

  try {
    assert.equal(await withDriver('local'), 'local');
    assert.equal(await withDriver(undefined), 'supabase');
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = previous;
  }
});

test('a document whose organisation names an unerasable provider can still be deleted', async () => {
  // The reviewer's reproduction. An organisation recorded as a provider the
  // registry does not know, or as an alpha provider it never opted into, must
  // not make its documents undeletable: the enqueue has to succeed and stamp
  // the provider verbatim, so the erasure pipeline fails visibly on it and an
  // operator sees it. Throwing here instead would strand the bytes with nothing
  // recorded anywhere.
  for (const provider of ['legacy-s3', 'confluence']) {
    const data = await enqueuedDeletionData({
      documentStorageProvider: provider,
      documentStorageAlphaOptIn: false,
    });
    assert.equal(data.provider, provider);
  }
});

// ---------------------------------------------------------------------------
// Task 7: cancelling a queued Confluence publication when its document is
// deleted, instead of letting it burn all five attempts against a document
// `readDocument` can no longer find and dead-letter as MAX_ATTEMPTS_EXHAUSTED.
// ---------------------------------------------------------------------------

type PublicationFixture = {
  id: string;
  pageId: string | null;
  attempts: number;
  state: string;
} & Record<string, unknown>;

function buildPublicationCancelPrisma(publication: PublicationFixture | null) {
  // `remove()` now reads `cloudId` and `attachmentId` as well, to build the
  // Confluence erasure target (Task 8). They are defaulted here rather than at
  // every call site because these tests are about cancellation, not erasure —
  // but they must be *present*, since `applyPrismaSelect` refuses to invent a
  // field the production `select` asks for.
  let row: PublicationFixture | null = publication
    ? { cloudId: 'cloud-1', attachmentId: null, ...publication }
    : null;
  const finds: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];

  const documentPublication = {
    findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
      finds.push(args);
      if (row === null) return null;
      if (Object.hasOwn(args.where, 'documentId') && args.where.documentId !== 'doc-1') return null;
      return applyPrismaSelect(row, args);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updates.push(args);
      if (row === null || args.where.id !== row.id) return { count: 0 };
      if (Object.hasOwn(args.where, 'state') && args.where.state !== row.state) return { count: 0 };
      row = { ...row, ...args.data } as PublicationFixture;
      return { count: 1 };
    },
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      deletes.push(args);
      if (row === null || args.where.id !== row.id) return { count: 0 };
      if (Object.hasOwn(args.where, 'pageId') && args.where.pageId !== row.pageId) return { count: 0 };
      row = null;
      return { count: 1 };
    },
  };

  const client = {
    organisation: {
      findUnique: async () => ({ documentStorageProvider: 'supabase', documentStorageAlphaOptIn: false }),
    },
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => ({ id: 'doc-1' }),
    },
    documentStorageDeletion: { create: async () => ({ id: 'deletion-1' }) },
    documentPublication,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(client),
  };

  return { prisma: client, finds, updates, deletes, row: () => row };
}

test('deleting a document with no queued Confluence publication leaves nothing to clean up', async () => {
  const mock = buildPublicationCancelPrisma(null);
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.updates.length, 0);
  assert.equal(mock.deletes.length, 0);
});

test('a publication with no pageId is cancelled outright when its document is deleted', async () => {
  const mock = buildPublicationCancelPrisma({
    id: 'publication-1',
    pageId: null,
    attempts: 0,
    state: 'PENDING',
  });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.row(), null, 'nothing was ever created in Confluence, so the row is deleted outright');
  assert.equal(mock.deletes.length, 1);
  assert.equal(mock.updates.length, 0);
});

test('a publication that already has a pageId keeps its identifiers and stops being retried', async () => {
  const mock = buildPublicationCancelPrisma({
    id: 'publication-1',
    pageId: 'page-99',
    attempts: 1,
    state: 'PENDING',
  });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  const row = mock.row();
  assert.notEqual(row, null, 'a publication that already named a Confluence page must never be deleted');
  // Task 8's dual erasure reads this id later; losing it orphans the page.
  assert.equal(row!.pageId, 'page-99');
  assert.equal(mock.deletes.length, 0);
  // No seventh DocumentPublicationTerminalReason is invented for a
  // cancellation: state and terminalReason are left exactly as they were.
  assert.equal(row!.state, 'PENDING');
  assert.equal(row!.terminalReason, undefined);
  // But it must never be picked up by the retry loop again.
  assert.ok(
    (row!.attempts as number) >= DOCUMENT_PUBLICATION_MAX_ATTEMPTS,
    'attempts must be pushed to or past the retry ceiling',
  );
  assert.ok(row!.nextAttemptAt instanceof Date);
  assert.ok(
    (row!.nextAttemptAt as Date).getUTCFullYear() >= 9999,
    'nextAttemptAt must be pushed far enough away to survive a future rise in the attempt ceiling',
  );
  assert.match(String(row!.lastError), /[Cc]ancelled/);
});

test('deleting a document does not disturb a publication that is already dead-lettered for a real failure', async () => {
  const mock = buildPublicationCancelPrisma({
    id: 'publication-1',
    pageId: 'page-1',
    attempts: 5,
    state: 'DEAD_LETTER',
    terminalReason: 'PERMANENT_PERMISSION_DENIED',
  });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.updates.length, 0, 'an already-terminal row is left alone; there is nothing left to cancel');
  assert.equal(mock.deletes.length, 0);
  const row = mock.row();
  assert.equal(row!.terminalReason, 'PERMANENT_PERMISSION_DENIED');
});

test('a Confluence publication cancellation failure never fails the document deletion', async () => {
  const mock = buildPublicationCancelPrisma(null);
  const readPublication = mock.prisma.documentPublication.findFirst;
  // `remove()` reads `DocumentPublication` twice now, for two different jobs
  // with two different failure policies, so this double fails exactly one of
  // them: the cancellation read, identified by the `state` it selects. Task 8's
  // erasure read is deliberately *not* best-effort — see the test below.
  mock.prisma.documentPublication.findFirst = async (args: {
    where: Record<string, unknown>;
    select?: Record<string, unknown>;
  }) => {
    if (args.select && Object.hasOwn(args.select, 'state')) {
      throw new Error('documentPublication lookup exploded');
    }
    return readPublication(args);
  };
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const service = new DocumentService(mock.prisma as never, () => NOW);
    const result = await service.remove('org-1', 'doc-1');
    assert.equal(result.storageDeletionId, 'deletion-1');
  } finally {
    console.error = originalConsoleError;
  }
});


// ---------------------------------------------------------------------------
// Task 8: dual erasure. Confluence is a mirror, so a mirrored document has two
// copies and deleting it must enqueue two erasure rows — the Supabase one
// unchanged, and a `confluence` one naming the page.
// ---------------------------------------------------------------------------

type PublishedPublicationFixture = {
  id: string;
  cloudId: string | null;
  pageId: string | null;
  attachmentId: string | null;
  attempts: number;
  state: string;
} & Record<string, unknown>;

function publishedPublication(
  overrides: Partial<PublishedPublicationFixture> = {},
): PublishedPublicationFixture {
  return {
    id: 'publication-1',
    cloudId: 'cloud-1',
    pageId: 'page-1',
    attachmentId: 'attachment-1',
    attempts: 1,
    state: 'PROCESSED',
    ...overrides,
  };
}

function buildDualErasurePrisma(publication: PublishedPublicationFixture | null) {
  const created: Array<Record<string, unknown>> = [];
  let documentDeleted = false;

  const client = {
    organisation: {
      findUnique: async () => ({ documentStorageProvider: 'supabase', documentStorageAlphaOptIn: false }),
    },
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => {
        documentDeleted = true;
        return { id: 'doc-1' };
      },
    },
    documentStorageDeletion: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: `deletion-${created.length}` };
      },
    },
    documentPublication: {
      // `applyPrismaSelect` is what stops this double inventing a row shape: a
      // field the production `select` asks for and the fixture does not define
      // throws here rather than arriving as `undefined`.
      findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
        publication === null ? null : applyPrismaSelect(publication, args),
      updateMany: async () => ({ count: 1 }),
      deleteMany: async () => ({ count: 1 }),
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(client),
  };

  return { prisma: client, created, documentDeleted: () => documentDeleted };
}

test('deleting a mirrored document enqueues an erasure row for each copy', async () => {
  const mock = buildDualErasurePrisma(publishedPublication());
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.created.length, 2, 'two copies exist, so two erasure rows must exist');
  assert.equal(mock.created[0].provider, 'supabase');
  assert.equal(mock.created[0].targetRef, undefined, 'the Supabase row is unchanged');
  assert.equal(mock.created[1].provider, 'confluence');
  assert.equal(mock.created[1].organisationId, 'org-1');
  // Carried so an operator reading a dead-letter list can tell which document
  // the row is for. It is not how the row is addressed — `targetRef` is.
  assert.equal(mock.created[1].storagePath, 'org-1/policy.pdf');
  assert.deepEqual(mock.created[1].targetRef, {
    kind: 'confluence',
    cloudId: 'cloud-1',
    pageId: 'page-1',
    attachmentIds: ['attachment-1'],
  });
});

test('a published page with nothing attached to it yet still names an empty attachment list', async () => {
  // The create-then-attach window. The page exists in the charity's site, so it
  // is owed erasure; fabricating an attachment id for it would make the eraser
  // issue a delete against something that never existed.
  const mock = buildDualErasurePrisma(publishedPublication({ attachmentId: null, state: 'PENDING' }));
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.created.length, 2);
  assert.deepEqual(mock.created[1].targetRef, {
    kind: 'confluence',
    cloudId: 'cloud-1',
    pageId: 'page-1',
    attachmentIds: [],
  });
});

test('a document that was never published to Confluence enqueues only the Supabase row', async () => {
  const mock = buildDualErasurePrisma(null);
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.created.length, 1);
  assert.equal(mock.created[0].provider, 'supabase');
});

test('a publication that never recorded a pageId enqueues only the Supabase row', async () => {
  // Nothing was ever created in the charity's site. A Confluence row here would
  // dead-letter against a page that never existed: noise that trains an
  // operator to ignore alerts.
  const mock = buildDualErasurePrisma(
    publishedPublication({ cloudId: null, pageId: null, attachmentId: null, state: 'PENDING', attempts: 0 }),
  );
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.created.length, 1);
  assert.equal(mock.created[0].provider, 'supabase');
});

// The gate is `pageId !== null`, never `state === 'PROCESSED'`. Each of these
// rows names a real page in the charity's Confluence and none of them is
// `PROCESSED`; a `PROCESSED` gate would skip every one of them and leave a page
// nobody can find and nobody can erase.
const unprocessedButPaged: Array<[string, Partial<PublishedPublicationFixture>]> = [
  ['dead-lettered after its page was created', { state: 'DEAD_LETTER', attempts: 5, attachmentId: null }],
  [
    'cancelled mid-flight because its document was deleted',
    { state: 'PENDING', attempts: DOCUMENT_PUBLICATION_MAX_ATTEMPTS, attachmentId: null },
  ],
  ['still pending its first attempt after the page was recorded', { state: 'PENDING', attempts: 0 }],
];

for (const [situation, overrides] of unprocessedButPaged) {
  test(`a publication ${situation} still has its Confluence copy erased`, async () => {
    const mock = buildDualErasurePrisma(publishedPublication(overrides));
    const service = new DocumentService(mock.prisma as never, () => NOW);

    await service.remove('org-1', 'doc-1');

    assert.equal(mock.created.length, 2);
    assert.equal(mock.created[1].provider, 'confluence');
    assert.equal(
      (mock.created[1].targetRef as { pageId: string }).pageId,
      'page-1',
      'the page exists in the charity site whatever this row state says',
    );
  });
}

test('a malformed Confluence erasure target fails the deletion while the document still exists', async () => {
  // `parseConfluenceErasureTarget` is the arbiter and its refusal is permanent,
  // so the target is built through it rather than beside it. A bad target has to
  // fail now, while the document and both its copies are still there and an
  // operator can act — not later, after the Supabase copy is already gone and
  // the row dead-letters blaming the wrong phase.
  const mock = buildDualErasurePrisma(publishedPublication({ pageId: ' page-1' }));
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await assert.rejects(
    () => service.remove('org-1', 'doc-1'),
    (error: unknown) => {
      assert.equal((error as AppError).code, 'ERASURE_TARGET_MALFORMED');
      return true;
    },
  );

  assert.equal(mock.documentDeleted(), false, 'the document must survive a target the eraser would refuse');
});

test('a failed read of the publication row fails the deletion rather than orphaning the page', async () => {
  // The counterpart to the cancellation test above, and the reason the two
  // reads cannot share one failure policy. Cancelling a queued publication is
  // best-effort: the worst a failure costs is some retry noise. Deciding
  // whether a Confluence copy exists is not — if that read fails and the
  // document is deleted anyway, the only record of where the page is goes with
  // it, and the page can never be found or erased.
  const mock = buildDualErasurePrisma(publishedPublication());
  mock.prisma.documentPublication.findFirst = async () => {
    throw new Error('documentPublication lookup exploded');
  };
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await assert.rejects(() => service.remove('org-1', 'doc-1'), /documentPublication lookup exploded/);
  assert.equal(mock.documentDeleted(), false);
});

test('a late rejection from a timed-out storage deletion attempt is observed rather than left unhandled', async () => {
  // An eraser that ignores its abort signal keeps running past the deadline and
  // may reject when nothing is awaiting it. In Node that terminates the process,
  // so one slow erasure that eventually fails would take down the scheduler that
  // was about to process every other row. `Promise.race` attaches a rejection
  // handler to every entrant, which is what makes this safe today; this test is
  // what stops a refactor removing that property silently.
  const mock = buildFallbackPrisma(pendingRecord());
  const service = new DocumentService(mock.prisma as never, () => NOW, 20);

  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', observe);

  try {
    const result = await service.retryPendingStorageDeletions(
      supabaseDispatcher(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error('the provider failed, long after the deadline')), 60);
          }),
      ),
    );

    assert.equal(result.retryScheduled, 1);
    assert.equal(mock.row().state, 'PENDING');

    // Past the late rejection, then a full turn of the loop: Node only reports a
    // rejection as unhandled once the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], 'the losing attempt rejection must be observed and discarded');
  } finally {
    process.off('unhandledRejection', observe);
  }
});
