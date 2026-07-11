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

const NOW = new Date('2026-07-11T12:00:00.000Z');

function pendingRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deletion-1',
    organisationId: 'org-1',
    storagePath: 'org-1/policy.pdf',
    state: 'PENDING',
    attempts: 0,
    claimedAt: null,
    nextAttemptAt: new Date('2026-07-11T11:00:00.000Z'),
    deadLetteredAt: null,
    terminalReason: null,
    alertClaimToken: null,
    alertClaimedAt: null,
    alertedAt: null,
    lastError: null,
    lastAttemptAt: null,
    processedAt: null,
    createdAt: new Date('2026-07-11T10:00:00.000Z'),
    ...overrides,
  };
}

function buildFallbackPrisma(initial: ReturnType<typeof pendingRecord>) {
  let row = { ...initial };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const delegate = {
    findMany: async (args: { where: Record<string, unknown> }) => {
      if (args.where.state === 'PENDING') return row.state === 'PENDING' ? [{ ...row }] : [];
      if (args.where.state === 'DEAD_LETTER') return row.state === 'DEAD_LETTER' ? [{ ...row }] : [];
      return [];
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      if (args.where.id !== row.id || args.where.state !== row.state) return null;
      if (Object.hasOwn(args.where, 'claimedAt') && args.where.claimedAt !== row.claimedAt) return null;
      return { ...row };
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updates.push(args);
      if (
        args.where.id &&
        args.where.id !== row.id &&
        !(typeof args.where.id === 'object' && args.where.id !== null &&
          Array.isArray((args.where.id as { in?: unknown }).in) &&
          ((args.where.id as { in: unknown[] }).in).includes(row.id))
      ) return { count: 0 };
      if (args.where.state && args.where.state !== row.state) return { count: 0 };
      if (typeof args.where.attempts === 'number' && args.where.attempts !== row.attempts) return { count: 0 };
      if (Object.hasOwn(args.where, 'claimedAt') && args.where.claimedAt !== row.claimedAt) return { count: 0 };
      if (args.where.alertClaimToken && args.where.alertClaimToken !== row.alertClaimToken) return { count: 0 };
      row = { ...row, ...args.data };
      return { count: 1 };
    },
  };
  return {
    prisma: {
      documentStorageDeletion: delegate,
      documentStorageDeletionRecovery: { create: async () => ({ id: 'recovery-1' }) },
    },
    updates,
    row: () => row,
  };
}

test('retryPendingStorageDeletions claims, deletes, and idempotently finalizes a due row', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const deleted: Array<{ organisationId: string; storagePath: string }> = [];
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(async (organisationId, storagePath) => {
    deleted.push({ organisationId, storagePath });
  });

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

  const result = await service.retryPendingStorageDeletions(async () => undefined, 10);

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
  const result = await service.retryPendingStorageDeletions(async () => {
    throw Object.assign(
      new Error('storage unavailable for ops@example.org at org-1/policy.pdf?token=secret-token'),
      { code: 'StorageApiError', status: 503 },
    );
  });

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
  const result = await service.retryPendingStorageDeletions(async () => {
    throw new Error('provider still unavailable');
  });

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
  const result = await service.retryPendingStorageDeletions(async () => {
    throw new AppError(403, 'STORAGE_PATH_FORBIDDEN', 'Storage path does not belong to this organisation');
  });

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
    async (_organisationId, _storagePath, signal) => {
      suppliedSignal = signal;
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          providerResolved = true;
          resolve();
        }, 60);
      });
    },
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
  await service.retryPendingStorageDeletions(async () => undefined, 1000);
  assert.equal(take, DOCUMENT_STORAGE_DELETION_MAX_CLAIM_BATCH);
});
