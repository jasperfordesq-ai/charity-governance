import assert from 'node:assert/strict';
import test from 'node:test';

import { DocumentService } from '../services/document.service.js';

test('retryPendingStorageDeletions processes pending cleanup records', async () => {
  const deleted: Array<{ organisationId: string; storagePath: string }> = [];
  const updates: unknown[] = [];
  const prisma = {
    documentStorageDeletion: {
      findMany: async (args: unknown) => {
        assert.deepEqual(args, {
          where: { processedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 25,
        });
        return [
          { id: 'deletion-1', organisationId: 'org-1', storagePath: 'org-1/policy.pdf' },
        ];
      },
      update: async (args: unknown) => {
        updates.push(args);
        return {};
      },
    },
  };
  const service = new DocumentService(prisma as never);

  const result = await service.retryPendingStorageDeletions(async (organisationId, storagePath) => {
    deleted.push({ organisationId, storagePath });
  });

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(deleted, [{ organisationId: 'org-1', storagePath: 'org-1/policy.pdf' }]);
  assert.equal((updates[0] as { where: { id: string } }).where.id, 'deletion-1');
  assert.deepEqual((updates[0] as { data: { lastError: string | null } }).data.lastError, null);
  assert.deepEqual((updates[0] as { data: { claimedAt: Date | null } }).data.claimedAt, null);
  assert.ok((updates[0] as { data: { processedAt: Date } }).data.processedAt instanceof Date);
});

test('retryPendingStorageDeletions atomically claims pending cleanup rows with Postgres row locks', async () => {
  const updates: unknown[] = [];
  let transactionCalled = false;
  let query = '';
  let queryValues: unknown[] = [];
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      transactionCalled = true;
      return callback(prisma);
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      query = strings.join('?');
      queryValues = values;
      return [
        { id: 'deletion-1', organisationId: 'org-1', storagePath: 'org-1/policy.pdf' },
      ];
    },
    documentStorageDeletion: {
      update: async (args: unknown) => {
        updates.push(args);
        return {};
      },
    },
  };
  const service = new DocumentService(prisma as never);

  const result = await service.retryPendingStorageDeletions(async () => undefined, 10);

  assert.equal(transactionCalled, true);
  assert.match(query, /UPDATE "DocumentStorageDeletion"/);
  assert.match(query, /SET "claimedAt" = CURRENT_TIMESTAMP/);
  assert.match(query, /FOR UPDATE SKIP LOCKED/);
  assert.match(query, /RETURNING "id", "organisationId", "storagePath"/);
  assert.deepEqual(queryValues, [600000, 10]);
  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.equal((updates[0] as { where: { id: string } }).where.id, 'deletion-1');
});

test('retryPendingStorageDeletions leaves failed cleanup records pending with attempt metadata', async () => {
  const updates: unknown[] = [];
  const prisma = {
    documentStorageDeletion: {
      findMany: async () => [
        { id: 'deletion-1', organisationId: 'org-1', storagePath: 'org-1/policy.pdf' },
      ],
      update: async (args: unknown) => {
        updates.push(args);
        return {};
      },
    },
  };
  const service = new DocumentService(prisma as never);

  const result = await service.retryPendingStorageDeletions(async () => {
    throw new Error('storage unavailable');
  });

  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(updates, [{
    where: { id: 'deletion-1' },
    data: {
      attempts: { increment: 1 },
      lastError: 'storage unavailable',
      claimedAt: null,
    },
  }]);
});
