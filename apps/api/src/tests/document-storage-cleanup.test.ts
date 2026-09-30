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
  buildFallbackPrisma,
  pendingRecord,
  supabaseDispatcher,
} from './document-storage-deletion-fixtures.js';
import { createErasureDispatcher } from '../services/document-erasure.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');
test('retryPendingStorageDeletions claims, deletes, and idempotently finalizes a due row', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const deleted: Array<{ organisationId: string; storagePath: string }> = [];
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(supabaseDispatcher(async (organisationId, storagePath) => {
    deleted.push({ organisationId, storagePath });
    return NOW;
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
    return NOW;
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

test('a primary-storage absence observation is bound to the processed outbox row', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const verifiedAt = new Date('2026-07-11T11:59:58.000Z');
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(
    supabaseDispatcher(async () => verifiedAt),
  );

  assert.equal(result.processed, 1);
  assert.equal(mock.row().state, 'PROCESSED');
  assert.equal(mock.row().activeObjectAbsentAt?.getTime(), verifiedAt.getTime());
  assert.equal(mock.row().processedAt?.getTime(), NOW.getTime());
});

test('a primary-storage eraser without an absence observation stays pending for retry', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(
    createErasureDispatcher({ supabase: async () => undefined }),
  );

  assert.equal(result.processed, 0);
  assert.equal(result.retryScheduled, 1);
  assert.equal(mock.row().state, 'PENDING');
  assert.equal(mock.row().activeObjectAbsentAt, null);
  assert.equal(mock.row().processedAt, null);
  assert.match(mock.row().lastError ?? '', /STORAGE_DELETE_UNVERIFIED/);
});

test('cleanup never erases bytes still referenced by a live document', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  let eraserCalled = false;
  mock.prisma.document.findFirst = async (args: unknown) => {
    assert.deepEqual((args as { where: unknown }).where, {
      organisationId: 'org-1', fileUrl: 'org-1/policy.pdf',
    });
    return { id: 'live-document' };
  };
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(
    supabaseDispatcher(async () => { eraserCalled = true; return NOW; }),
  );

  assert.equal(eraserCalled, false);
  assert.equal(result.retryScheduled, 1);
  assert.equal(mock.row().state, 'PENDING');
  assert.match(mock.row().lastError ?? '', /STORAGE_TARGET_STILL_REFERENCED/);
});

test('cleanup defers erasure when the live-reference check is unavailable', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  let eraserCalled = false;
  mock.prisma.document.findFirst = async () => { throw new Error('document read unavailable'); };
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(
    supabaseDispatcher(async () => { eraserCalled = true; return NOW; }),
  );

  assert.equal(eraserCalled, false);
  assert.equal(result.retryScheduled, 1);
  assert.equal(mock.row().state, 'PENDING');
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
    document: { findFirst: async () => null },
    documentStorageDeletion: {
      updateMany: async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    documentStorageDeletionRecovery: { create: async () => ({ id: 'recovery-1' }) },
  };
  const service = new DocumentService(prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(supabaseDispatcher(async () => NOW), 10);

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
      return NOW;
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
  await service.retryPendingStorageDeletions(supabaseDispatcher(async () => NOW), 1000);
  assert.equal(take, DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH);
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
          new Promise<Date>((_resolve, reject) => {
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
