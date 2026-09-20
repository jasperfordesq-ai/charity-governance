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
// Retiring a queued Confluence publication when its document is deleted,
// instead of letting it burn all five attempts against a document
// `readDocument` can no longer find and dead-letter as MAX_ATTEMPTS_EXHAUSTED
// (Task 7) -- and, under the owner's 2026-09-19 ruling, keeping the row
// addressable rather than erasing what it names.
// ---------------------------------------------------------------------------

type PublicationFixture = {
  id: string;
  pageId: string | null;
  attempts: number;
  state: string;
} & Record<string, unknown>;

function buildPublicationCancelPrisma(publication: PublicationFixture | null) {
  // `remove()` reads `cloudId` and `attachmentId` as well, to keep a retired
  // row's identifiers intact. They are defaulted here rather than at every
  // call site because most of these tests are about the retry-stopping half
  // of retirement, not the identifiers themselves — but they must be
  // *present*, since `applyPrismaSelect` refuses to invent a
  // field the production `select` asks for.
  // `claimedAt` joins them for the same reason: retirement reads it to tell
  // "nothing is in flight, deleting the row outright is safe" from "an
  // attempt is mid-publish and its page id has not landed yet".
  let row: PublicationFixture | null = publication
    ? { cloudId: 'cloud-1', attachmentId: null, claimedAt: null, ...publication }
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

test('a publication that already has a pageId is retired, not erased, when its document is deleted', async () => {
  // claimedAt is set deliberately: a worker that recorded its page id and is
  // still mid-attempt is the case where retirement has to take the row away
  // from it, and a fixture that left claimedAt null would assert the clearing
  // trivially — it was already null.
  const mock = buildPublicationCancelPrisma({
    id: 'publication-1',
    pageId: 'page-99',
    attempts: 1,
    state: 'PENDING',
    claimedAt: new Date('2026-09-20T11:59:00.000Z'),
  });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  const row = mock.row();
  assert.notEqual(row, null, 'a publication that named a Confluence page must never be deleted');
  assert.equal(row!.pageId, 'page-99', 'the page id is the only thing that can still address the page');
  assert.equal(row!.cloudId, 'cloud-1', 'a page id without its site names nothing');
  assert.equal(mock.deletes.length, 0);
  assert.equal(row!.state, 'RETIRED');
  assert.ok(row!.retiredAt instanceof Date);
  assert.equal(row!.retiredStoragePath, 'org-1/policy.pdf');
  assert.equal(row!.nextAttemptAt, null, 'nothing retries a retired row');
  assert.equal(row!.claimedAt, null, 'the in-flight attempt loses the row and reports it, rather than finishing silently');
});

test('deleting a document retires an already dead-lettered publication too, once it names a page', async () => {
  // Retirement is not gated on the row's prior state: a page it names is real
  // whatever `state` says, and the document that named it is gone either way.
  // Leaving a DEAD_LETTER row untouched would also leave its operator alert
  // live for a page whose document no longer exists -- exactly the kind of
  // noise retirement exists to stop, whether the row got there by exhausting
  // its retries or by a real publish failure.
  const mock = buildPublicationCancelPrisma({
    id: 'publication-1',
    pageId: 'page-1',
    attempts: 5,
    state: 'DEAD_LETTER',
    terminalReason: 'PERMANENT_PERMISSION_DENIED',
  });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.deletes.length, 0, 'a row naming a page is never deleted outright');
  const row = mock.row();
  assert.notEqual(row, null);
  assert.equal(row!.state, 'RETIRED');
  assert.equal(row!.pageId, 'page-1', 'the page id is the only thing that can still address the page');
});

test('a Confluence publication retirement failure never fails the document deletion', async () => {
  const mock = buildPublicationCancelPrisma(null);
  const readPublication = mock.prisma.documentPublication.findFirst;
  // Retirement is the only read `remove()` makes of `DocumentPublication` now,
  // and it is entirely best-effort: the page is being kept either way, so a
  // failure here can only ever cost some bookkeeping, never the deletion the
  // user actually asked for. Failing on the `state` select is how the single
  // locked-read fallback (no publication exists here to find) is made to blow
  // up, to prove that.
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
// The owner's ruling of 2026-09-19: an ordinary deletion erases only the
// Irish (Supabase) copy. Confluence is a mirror, but the mirror is no longer
// destroyed by this path — the page and its attachments are left exactly
// where they are, and only an explicit, separately authorised erasure
// (Task 4) may take them down.
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
    claimedAt: null,
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

test('deleting a mirrored document erases the Irish copy and leaves the Confluence page alone', async () => {
  const mock = buildDualErasurePrisma(
    publishedPublication({ attachmentId: 'att-1', attempts: 0, state: 'PROCESSED' }),
  );
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.equal(mock.created.length, 1, 'exactly one erasure row: the Supabase copy');
  assert.equal(mock.created[0].provider, 'supabase');
  assert.equal(
    mock.created.some((row) => row.provider === 'confluence'),
    false,
    'an ordinary deletion must never enqueue a Confluence erasure',
  );
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

// Every one of these rows names a real page in the charity's Confluence and
// none of them is `PROCESSED`. Under the old erasure gate that distinction
// mattered (`pageId !== null`, never `state === 'PROCESSED'`); under
// retirement it still must not matter — whatever this row's local state says,
// the page it names is left alone, never erased.
const unprocessedButPaged: Array<[string, Partial<PublishedPublicationFixture>]> = [
  ['dead-lettered after its page was created', { state: 'DEAD_LETTER', attempts: 5, attachmentId: null }],
  [
    'retired mid-flight because its document was deleted',
    { state: 'PENDING', attempts: DOCUMENT_PUBLICATION_MAX_ATTEMPTS, attachmentId: null },
  ],
  ['still pending its first attempt after the page was recorded', { state: 'PENDING', attempts: 0 }],
];

for (const [situation, overrides] of unprocessedButPaged) {
  test(`a publication ${situation} still has its Confluence copy left alone`, async () => {
    const mock = buildDualErasurePrisma(publishedPublication(overrides));
    const service = new DocumentService(mock.prisma as never, () => NOW);

    await service.remove('org-1', 'doc-1');

    assert.equal(mock.created.length, 1, 'only the Supabase copy is ever erased on an ordinary deletion');
    assert.equal(mock.created[0].provider, 'supabase');
    assert.equal(
      mock.created.some((row) => row.provider === 'confluence'),
      false,
      'the page exists in the charity site whatever this row state says, and an ordinary deletion must never touch it',
    );
  });
}

// ---------------------------------------------------------------------------
// The delete window: a page created while a document is being deleted.
//
// The publish worker writes `pageId` from its own transaction, so a delete
// path that merely *looked* at `pageId` was racing it. `retireConfluencePublication`'s
// two passes each take a `FOR UPDATE` lock on the publication row and decide
// from the value read under it, the same claim mechanics
// `claimPendingStorageDeletions` uses — and that closes the race for a write
// that is *already blocked* on one of those locks when the other pass takes
// it: it lands the instant the lock releases, and the next pass sees it.
//
// What these two passes do NOT close is the far more common shape of the
// race: a worker still inside Confluence's `createPage` HTTP call, with no
// database write issued yet to block on anything. Both passes below see
// `pageId` still null for that case and can only park the row -- this file's
// tests below confirm exactly that, in isolation. It is closed one file over:
// `document-publication.service.ts`'s `retirePublicationIfDocumentGone` runs
// immediately after the worker's own write finally lands, whenever that is,
// and retires the row itself if the document is gone by then. So a row this
// suite shows leaving `remove()` still `PENDING` is not stranded in the real
// system -- it is retired moments later, by the other half of this lifecycle,
// which `document-publication.service.test.ts` covers.
//
// The double below is the smallest thing that can show the two outcomes THIS
// file's two-pass mechanism produces: a real row lock has exactly two effects
// that matter here, and it models both. A write issued while the lock is held
// waits, and it lands the instant the holder commits.
// ---------------------------------------------------------------------------

/** Where the worker's `attachPublicationPage` write is issued. */
type DeleteWindowMoment = 'after-the-delete-transaction-read' | 'after-the-cancellation-read';

function buildDeleteWindowPrisma(moment: DeleteWindowMoment) {
  const created: Array<Record<string, unknown>> = [];
  let publication: Record<string, unknown> | null = {
    id: 'publication-1',
    cloudId: null,
    pageId: null,
    attachmentId: null,
    attempts: 0,
    state: 'PENDING',
    // Claimed: a worker is mid-attempt on this row right now, which is the
    // only way a page can appear during the deletion at all.
    claimedAt: new Date('2026-07-11T11:59:00.000Z'),
  };
  let lockHeld = false;
  let blocked: Array<() => void> = [];
  let lockedReads = 0;

  // `attachPublicationPage`, as the UPDATE it is: it must wait for the row
  // lock, and if the row is gone by the time it runs it matches nothing --
  // which is the `claimLost` the worker reports.
  const workerRecordsThePage = () => {
    const write = () => {
      if (publication === null) return;
      publication = { ...publication, cloudId: 'cloud-1', pageId: 'page-1' };
    };
    if (lockHeld) blocked.push(write);
    else write();
  };

  const commit = () => {
    lockHeld = false;
    const waiting = blocked;
    blocked = [];
    for (const write of waiting) write();
  };

  const client = {
    organisation: {
      findUnique: async () => ({ documentStorageProvider: 'supabase', documentStorageAlphaOptIn: false }),
    },
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => ({ id: 'doc-1' }),
    },
    documentStorageDeletion: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'deletion-' + String(created.length) };
      },
    },
    documentPublication: {
      findFirst: async () => {
        throw new Error(
          'every read of the publication row on the delete path must be a locked read, not a plain findFirst',
        );
      },
      // Applies `data` for real, unlike a stub that only counts the call: the
      // retirement tests below need to see whether a row actually reached
      // `RETIRED`, not merely that some update was attempted.
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (publication === null || args.where.id !== publication.id) return { count: 0 };
        publication = { ...publication, ...args.data };
        return { count: 1 };
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        if (publication === null || args.where.id !== publication.id) return { count: 0 };
        if (Object.hasOwn(args.where, 'pageId') && args.where.pageId !== publication.pageId) {
          return { count: 0 };
        }
        publication = null;
        return { count: 1 };
      },
    },
    // The `SELECT ... FOR UPDATE`. Taking the lock is what makes a concurrent
    // write wait; the caller gets the snapshot as it stood at this instant.
    $queryRaw: async (strings: TemplateStringsArray) => {
      // The lock is the whole point, so the double refuses to stand in for a
      // read that does not take one. Without this the model below would
      // happily "lock" for a plain SELECT and prove nothing.
      assert.match(
        strings.join(' ? '),
        /FOR UPDATE/,
        'the publication row must be read FOR UPDATE, or the worker is not excluded at all',
      );
      lockedReads += 1;
      lockHeld = true;
      const snapshot = publication === null ? [] : [publication];
      if (moment === 'after-the-delete-transaction-read' && lockedReads === 1) workerRecordsThePage();
      if (moment === 'after-the-cancellation-read' && lockedReads === 2) workerRecordsThePage();
      return snapshot;
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      try {
        return await callback(client);
      } finally {
        commit();
      }
    },
  };

  return { prisma: client, created, publication: () => publication };
}

for (const moment of [
  'after-the-delete-transaction-read',
  'after-the-cancellation-read',
] as const) {
  test(`a page recorded ${moment} is retired rather than erased`, async () => {
    const mock = buildDeleteWindowPrisma(moment);
    const service = new DocumentService(mock.prisma as never, () => NOW);

    await service.remove('org-1', 'doc-1');

    // True whichever side of the lock the race lands on: retirement never
    // creates a `confluence` erasure row, so a page recorded mid-race is
    // never touched, only ever left alone.
    assert.deepEqual(
      mock.created.map((row) => row.provider),
      ['supabase'],
      'an ordinary deletion never enqueues a Confluence erasure, however the race lands',
    );
  });
}

test('a page recorded before the second locked read is retired, not left dangling', async () => {
  // The one race `retireConfluencePublication` closes: a write blocked on the
  // first pass's lock lands the instant that pass commits, so the second pass
  // sees the page id it recorded and retires it — rather than leaving a page
  // whose row still thinks nothing was ever created.
  const mock = buildDeleteWindowPrisma('after-the-delete-transaction-read');
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  const row = mock.publication();
  assert.notEqual(row, null);
  assert.equal(row!.pageId, 'page-1');
  assert.equal(row!.state, 'RETIRED');
  assert.equal(row!.claimedAt, null);
});

test('a publication holding a live claim is never destroyed out from under the attempt', async () => {
  // A write landing after this method's second locked read is not caught by
  // this call, so the row never reaches `RETIRED` here -- see the section
  // comment above for where it is caught instead. What this call still must
  // guarantee on its own is the safety property: the row survives long enough
  // for the page id the in-flight attempt is about to write to land
  // somewhere. Destroying it would leave a page with no record of it
  // anywhere, which is worse than a retirement finishing one file later than
  // this one.
  const mock = buildDeleteWindowPrisma('after-the-cancellation-read');
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  const row = mock.publication();
  assert.notEqual(row, null, 'the row naming the page must not be deleted while an attempt is in flight');
  assert.equal(row!.pageId, 'page-1');
});

test('a page id recorded between the retirement read and its delete is not destroyed', async () => {
  // The `pageId: null` guard on the outright delete, on its own. A client
  // that cannot issue the locked read -- a double, here -- falls back to a
  // plain one, and then this guard is the only thing between a recorded page
  // id and being destroyed outright: the "a page id learned and then lost"
  // failure the whole pipeline is built around.
  const created: Array<Record<string, unknown>> = [];
  let publication: Record<string, unknown> | null = {
    id: 'publication-1',
    cloudId: null,
    pageId: null,
    attachmentId: null,
    attempts: 0,
    state: 'PENDING',
    claimedAt: null,
  };

  const client = {
    organisation: {
      findUnique: async () => ({ documentStorageProvider: 'supabase', documentStorageAlphaOptIn: false }),
    },
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', fileUrl: 'org-1/policy.pdf' }),
      delete: async () => ({ id: 'doc-1' }),
    },
    documentStorageDeletion: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'deletion-' + String(created.length) };
      },
    },
    documentPublication: {
      findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const snapshot = publication === null ? null : applyPrismaSelect(publication, args);
        // The retirement read selects `state`. The worker records the page
        // immediately after it, before the delete below runs.
        if (args.select && Object.hasOwn(args.select, 'state') && publication !== null) {
          publication = { ...publication, cloudId: 'cloud-1', pageId: 'page-1' };
        }
        return snapshot;
      },
      updateMany: async () => ({ count: 1 }),
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        if (publication === null || args.where.id !== publication.id) return { count: 0 };
        if (Object.hasOwn(args.where, 'pageId') && args.where.pageId !== publication.pageId) {
          return { count: 0 };
        }
        publication = null;
        return { count: 1 };
      },
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(client),
  };

  const service = new DocumentService(client as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  assert.notEqual(publication, null, 'the only record of where the page is must survive retirement');
  assert.equal(publication!.pageId, 'page-1');
});

// The malformed-target test that used to live here (a bad Confluence erasure
// target failing the deletion) is gone outright: nothing on this path builds
// an erasure target any more. That coverage moves to Task 4, where erasure
// targets are built again, for the explicit erasure action.

test('a failed read of the publication row no longer fails the document deletion', async () => {
  const mock = buildPublicationCancelPrisma({ id: 'publication-1', pageId: 'page-1', attempts: 0, state: 'PENDING' });
  mock.prisma.documentPublication.findFirst = async () => {
    throw new Error('publication read failed');
  };
  const service = new DocumentService(mock.prisma as never, () => NOW);

  // The document deletion is the user's action and must always work. Retirement
  // is bookkeeping about a page that is being left in place either way, so its
  // failure is logged and swallowed — unlike the old erasure enqueue, which
  // held the deletion hostage because a missed row meant an unerasable orphan.
  await service.remove('org-1', 'doc-1');
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
