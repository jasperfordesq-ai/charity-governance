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
  let row: PublicationFixture | null = publication ? { ...publication } : null;
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
  mock.prisma.documentPublication.findFirst = async () => {
    throw new Error('documentPublication lookup exploded');
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

