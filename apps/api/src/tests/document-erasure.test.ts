import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../utils/errors.js';
import { DocumentService } from '../services/document.service.js';
import {
  createErasureDispatcher,
  createSupabaseEraser,
  type Eraser,
  type ErasureDispatcher,
  type ErasureTarget,
} from '../services/document-erasure.js';
import {
  buildFallbackPrisma,
  pendingRecord,
  supabaseDispatcher,
} from './document-storage-deletion-fixtures.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

test('a supabase row is routed to the supabase eraser with its storage path', async () => {
  const seen: ErasureTarget[] = [];
  const dispatch: ErasureDispatcher = (provider) =>
    provider === 'supabase'
      ? async (target) => {
          seen.push(target);
        }
      : undefined;
  const mock = buildFallbackPrisma(
    pendingRecord({ provider: 'supabase', storagePath: 'org-1/a.pdf', targetRef: null }),
  );
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(dispatch, 10);

  assert.equal(result.processed, 1);
  assert.deepEqual(seen, [
    { organisationId: 'org-1', storagePath: 'org-1/a.pdf', targetRef: null },
  ]);
  assert.equal(mock.row().state, 'PROCESSED');
});

test('a row carries its target reference to the eraser alongside the storage path', async () => {
  const seen: ErasureTarget[] = [];
  const dispatch = createErasureDispatcher({
    confluence: async (target) => {
      seen.push(target);
    },
  });
  const mock = buildFallbackPrisma(
    pendingRecord({
      provider: 'confluence',
      storagePath: 'org-1/minutes.pdf',
      targetRef: { pageId: '12345', attachmentId: 'att-9' },
    }),
  );
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(dispatch, 10);

  assert.equal(result.processed, 1);
  assert.deepEqual(seen, [
    {
      organisationId: 'org-1',
      storagePath: 'org-1/minutes.pdf',
      targetRef: { pageId: '12345', attachmentId: 'att-9' },
    },
  ]);
});

test('a row whose provider has no eraser dead-letters on the first attempt', async () => {
  const dispatch: ErasureDispatcher = () => undefined;
  const mock = buildFallbackPrisma(pendingRecord({ provider: 'nonesuch' }));
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(dispatch, 10);

  assert.equal(result.newlyDeadLettered, 1);
  assert.equal(result.processed, 0);
  assert.equal(mock.row().state, 'DEAD_LETTER');
  assert.equal(mock.row().terminalReason, 'PROVIDER_NOT_ERASABLE');
  assert.equal(mock.row().attempts, 1);
  assert.equal(mock.row().nextAttemptAt, null);
  // The operator has to be told which provider stranded the bytes; a bare
  // "no eraser" line would send them back to the database to find out.
  assert.match(String(mock.row().lastError), /nonesuch/);
});

// A provider the deployment cannot erase is the same condition whether the
// dispatcher spots it or StorageService refuses one layer down. Retrying cannot
// acquire a storage backend, so neither may burn the five-attempt budget.
for (const code of ['STORAGE_DELETE_PROVIDER_UNSUPPORTED', 'STORAGE_DOWNLOAD_PROVIDER_UNSUPPORTED']) {
  test(`a ${code} refusal dead-letters on the first attempt as PROVIDER_NOT_ERASABLE`, async () => {
    const mock = buildFallbackPrisma(pendingRecord({ provider: 'confluence' }));
    const service = new DocumentService(mock.prisma as never, () => NOW);
    const dispatch = createErasureDispatcher({
      confluence: async () => {
        throw new AppError(501, code, 'No storage backend is configured for this provider.');
      },
    });

    const result = await service.retryPendingStorageDeletions(dispatch, 10);

    assert.equal(result.newlyDeadLettered, 1);
    assert.equal(mock.row().state, 'DEAD_LETTER');
    assert.equal(mock.row().terminalReason, 'PROVIDER_NOT_ERASABLE');
    assert.equal(mock.row().attempts, 1);
  });
}

test('a transient provider failure still retries rather than dead-lettering early', async () => {
  const mock = buildFallbackPrisma(pendingRecord());
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(
    supabaseDispatcher(async () => {
      throw new Error('storage unavailable');
    }),
    10,
  );

  assert.equal(result.retryScheduled, 1);
  assert.equal(result.newlyDeadLettered, 0);
  assert.equal(mock.row().state, 'PENDING');
  assert.equal(mock.row().terminalReason, null);
});

test('the dispatcher does not mistake an inherited property for an eraser', () => {
  const dispatch = createErasureDispatcher({});

  assert.equal(dispatch('constructor'), undefined);
  assert.equal(dispatch('toString'), undefined);
  assert.equal(dispatch('__proto__'), undefined);
  assert.equal(dispatch('hasOwnProperty'), undefined);
  assert.equal(dispatch('valueOf'), undefined);
});

test('a row stamped with an inherited property name dead-letters instead of reporting success', async () => {
  const mock = buildFallbackPrisma(pendingRecord({ provider: 'constructor' }));
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(createErasureDispatcher({}), 10);

  assert.equal(result.processed, 0, 'Object.prototype.constructor must never count as an erasure');
  assert.equal(mock.row().state, 'DEAD_LETTER');
  assert.equal(mock.row().terminalReason, 'PROVIDER_NOT_ERASABLE');
});

/**
 * The sibling of the dispatcher's own-property guard, and pinned the same way.
 *
 * `permanentStorageDeletionTerminalReason` in document.service.ts looks an
 * `AppError.code` up in a permanence map. A bare `MAP[error.code]` lookup
 * resolves Object.prototype members, so an error coded `toString` or
 * `constructor` would resolve to a *function* — truthy — and the row would be
 * dead-lettered on its first attempt with a terminal reason that is not a
 * terminal reason at all. A charity's erasure would stop being retried because
 * of a name collision with a built-in.
 *
 * No AppError in the codebase carries such a code today, so this is defensive
 * depth rather than a live path. Depth with nothing pinning it is depth that
 * quietly disappears in the next refactor, which is why it is pinned here.
 */
for (const inheritedCode of ['toString', 'constructor', 'hasOwnProperty', 'valueOf'] as const) {
  test(`an error coded "${inheritedCode}" stays transient instead of resolving an inherited permanence entry`, async () => {
    const mock = buildFallbackPrisma(pendingRecord());
    const service = new DocumentService(mock.prisma as never, () => NOW);

    const result = await service.retryPendingStorageDeletions(
      supabaseDispatcher(async () => {
        throw new AppError(502, inheritedCode, 'upstream refused the delete');
      }),
      10,
    );

    assert.equal(result.newlyDeadLettered, 0, 'Object.prototype members are not permanence entries');
    assert.equal(result.retryScheduled, 1);
    assert.equal(mock.row().state, 'PENDING');
    assert.equal(mock.row().terminalReason, null);
  });
}

test('the dispatcher returns the eraser registered under a provider it does own', () => {
  const erase: Eraser = async () => undefined;
  const dispatch = createErasureDispatcher({ supabase: erase });

  assert.equal(dispatch('supabase'), erase);
  assert.equal(dispatch('confluence'), undefined);
});

test('the supabase eraser unpacks the target into the positional deleteFile call', async () => {
  const calls: Array<{ organisationId: string; storagePath: string; aborted: boolean }> = [];
  const controller = new AbortController();
  const erase = createSupabaseEraser(async (organisationId, storagePath, signal) => {
    calls.push({ organisationId, storagePath, aborted: signal?.aborted ?? true });
  });

  await erase(
    { organisationId: 'org-1', storagePath: 'org-1/policy.pdf', targetRef: { ignored: true } },
    controller.signal,
  );

  assert.deepEqual(calls, [
    { organisationId: 'org-1', storagePath: 'org-1/policy.pdf', aborted: false },
  ]);
});
