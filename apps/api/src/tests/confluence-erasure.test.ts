import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../utils/errors.js';
import { DocumentService } from '../services/document.service.js';
import {
  createConfluenceEraser,
  type ConfluenceEraserDeps,
  type ConfluenceErasureOperations,
} from '../services/confluence-erasure.js';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { purgeAttachment } from '../services/confluence-attachments.js';
import { purgePage } from '../services/confluence-pages.js';
import { createErasureDispatcher } from '../services/document-erasure.js';
import type { ErasureTarget } from '../services/document-erasure.js';
import { buildFallbackPrisma, pendingRecord } from './document-storage-deletion-fixtures.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

/** Stands in for a live client. No test in this file lets a real request out. */
const CLIENT = {
  request: async () => {
    throw new Error('no test in this file may reach the HTTP core');
  },
} as unknown as ConfluenceClient;

const PAGE: ConfluencePage = {
  id: 'p1',
  title: 'Safeguarding Policy',
  spaceId: 'space-1',
} as ConfluencePage;

function target(attachmentIds: string[] = [], overrides: Record<string, unknown> = {}): ErasureTarget {
  return {
    organisationId: 'org-1',
    storagePath: 'org-1/minutes.pdf',
    targetRef: {
      kind: 'confluence',
      cloudId: 'cloud-1',
      pageId: 'p1',
      attachmentIds,
      ...overrides,
    },
  };
}

function targetWith(attachmentIds: string[]): ErasureTarget {
  return target(attachmentIds);
}

/**
 * Deps whose five primitives record the call they were asked to make, in
 * order. `getPage` answers `null` — the 404 that is the proof of erasure —
 * unless a test overrides it.
 */
function spyDeps(calls: string[], overrides: Partial<ConfluenceErasureOperations> = {}): ConfluenceEraserDeps {
  const record = (name: string) => async (_client: ConfluenceClient, id: string) => {
    calls.push(`${name}:${id}`);
  };
  return {
    connect: async () => CLIENT,
    operations: {
      deleteAttachment: record('deleteAttachment'),
      purgeAttachment: record('purgeAttachment'),
      deletePage: record('deletePage'),
      purgePage: record('purgePage'),
      getPage: async (_client: ConfluenceClient, id: string) => {
        calls.push(`getPage:${id}`);
        return null;
      },
      ...overrides,
    },
  };
}

test('attachments are erased before the page, and each is trashed before it is purged', async () => {
  const calls: string[] = [];
  const eraser = createConfluenceEraser(spyDeps(calls));

  await eraser(targetWith(['a1', 'a2']));

  assert.deepEqual(calls, [
    'deleteAttachment:a1',
    'purgeAttachment:a1',
    'deleteAttachment:a2',
    'purgeAttachment:a2',
    'deletePage:p1',
    'purgePage:p1',
    'getPage:p1',
  ]);
});

test('a 404 on the verification read is the proof of erasure', async () => {
  const calls: string[] = [];
  // `getPage` answers null for a 404 (confluence-pages.ts), which is what the
  // spy deps already do. The attempt resolving is the whole assertion.
  const eraser = createConfluenceEraser(spyDeps(calls));

  await eraser(target());

  assert.deepEqual(calls, ['deletePage:p1', 'purgePage:p1', 'getPage:p1']);
});

test('an attempt fails when the page still reads back after the purge', async () => {
  const calls: string[] = [];
  const eraser = createConfluenceEraser(
    spyDeps(calls, {
      getPage: async () => PAGE,
    }),
  );

  await assert.rejects(
    () => eraser(target()),
    (error: unknown) => {
      const e = error as AppError;
      assert.equal(e.code, 'CONFLUENCE_ERASURE_UNVERIFIED');
      // Not permanent. A page that reads back may be gone on the next attempt,
      // and an Atlassian blip must not become a dead-letter cleared by hand.
      assert.equal(e.statusCode, 502);
      return true;
    },
  );
});

/**
 * The 403 is raised by the real `purgePage` / `purgeAttachment`, not by a stub
 * that returns the code: this pins the *join* between Task 3's translation and
 * this module's propagation. A stub would keep passing if the primitive stopped
 * translating at all.
 */
function forbiddenClient(): ConfluenceClient {
  return {
    request: async () => {
      throw new AppError(
        409,
        'CONFLUENCE_RECONNECT_REQUIRED',
        'Confluence request failed with status 403.',
        { status: 403 },
      );
    },
  } as unknown as ConfluenceClient;
}

for (const [label, attachmentIds, operations] of [
  ['a forbidden page purge', [] as string[], { purgePage }],
  ['a forbidden attachment purge', ['a1'], { purgeAttachment }],
] as const) {
  test(`${label} names the permission the grant is missing`, async () => {
    const calls: string[] = [];
    const eraser = createConfluenceEraser({
      ...spyDeps(calls, operations),
      connect: async () => forbiddenClient(),
    });

    await assert.rejects(
      () => eraser(targetWith([...attachmentIds])),
      (error: unknown) => {
        const e = error as AppError;
        assert.equal(e.code, 'CONFLUENCE_PURGE_FORBIDDEN');
        assert.match(e.message, /administer space|manage.content/i);
        // The operator has to be told the content is not gone, only trashed —
        // otherwise a dead-letter reads as "erased but unproven".
        assert.match(e.message, /trash/i);
        return true;
      },
    );
  });
}

/**
 * Deps that run the **real** five primitives against a site where everything
 * has already gone. This test deliberately does not stub them: it is the one
 * that justifies the sequence keeping no persisted sub-state, and it can only
 * justify that if a primitive that stopped treating a 404 as success would
 * turn it red. Stubs would keep it green through exactly that change.
 */
function depsWhereEverythingIsAlready404(paths: string[]): ConfluenceEraserDeps {
  return {
    connect: async () =>
      ({
        request: async (spec: { method: string; path: string; query?: Record<string, string> }) => {
          paths.push(`${spec.method} ${spec.path}${spec.query?.purge === 'true' ? '?purge=true' : ''}`);
          throw new AppError(404, 'CONFLUENCE_NOT_FOUND', 'Confluence request failed with status 404.', {
            status: 404,
          });
        },
      }) as unknown as ConfluenceClient,
  };
}

test('the sequence restarts cleanly after a crash, because every step is idempotent', async () => {
  const paths: string[] = [];
  const eraser = createConfluenceEraser(depsWhereEverythingIsAlready404(paths));

  await eraser(targetWith(['a1']));

  // Every step 404s and every step treats that as success — which is what
  // makes re-running the whole sequence from the top a valid recovery from a
  // crash at any point inside it.
  assert.deepEqual(paths, [
    'DELETE attachments/a1',
    'DELETE attachments/a1?purge=true',
    'DELETE pages/p1',
    'DELETE pages/p1?purge=true',
    'GET pages/p1',
  ]);
});

/** Records each call and aborts the controller once `after` calls have been made. */
function spyDepsAbortingAfter(
  calls: string[],
  controller: AbortController,
  after: number,
): ConfluenceEraserDeps {
  const deps = spyDeps(calls);
  const wrap = <T>(operation: (client: ConfluenceClient, id: string) => Promise<T>) =>
    async (client: ConfluenceClient, id: string): Promise<T> => {
      const result = await operation(client, id);
      if (calls.length >= after) controller.abort();
      return result;
    };
  const operations = deps.operations as ConfluenceErasureOperations;
  return {
    ...deps,
    operations: {
      deleteAttachment: wrap(operations.deleteAttachment),
      purgeAttachment: wrap(operations.purgeAttachment),
      deletePage: wrap(operations.deletePage),
      purgePage: wrap(operations.purgePage),
      getPage: wrap(operations.getPage),
    },
  };
}

test('an aborted attempt stops issuing calls', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const eraser = createConfluenceEraser(spyDepsAbortingAfter(calls, controller, 1));

  await assert.rejects(() => eraser(targetWith(['a1', 'a2']), controller.signal));

  assert.ok(calls.length < 7, `expected the abort to stop the sequence, got ${calls.join(', ')}`);
});

test('an attempt aborted before it starts issues nothing at all', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => createConfluenceEraser(spyDeps(calls))(targetWith(['a1']), controller.signal),
    (error: unknown) => (error as AppError).code === 'CONFLUENCE_ERASURE_ABORTED',
  );

  assert.deepEqual(calls, []);
});

test('a malformed target is refused before any connection is opened', async () => {
  const calls: string[] = [];
  let connected = false;
  const eraser = createConfluenceEraser({
    ...spyDeps(calls),
    connect: async () => {
      connected = true;
      return CLIENT;
    },
  });

  await assert.rejects(
    () => eraser({ organisationId: 'org-1', storagePath: 'org-1/minutes.pdf', targetRef: { kind: 'confluence' } }),
    (error: unknown) => (error as AppError).code === 'ERASURE_TARGET_MALFORMED',
  );

  assert.equal(connected, false, 'a row that names nothing must not open a connection');
  assert.deepEqual(calls, []);
});

// Both are the connection itself being unusable, and neither improves on
// retry. The third row is the one that keeps the guard honest.
for (const [label, thrown, expectedCode] of [
  ['a disconnected charity', new AppError(404, 'INTEGRATION_NOT_FOUND', 'x'), 'CONFLUENCE_NOT_CONNECTED'],
  ['a dead grant', new AppError(409, 'CONFLUENCE_RECONNECT_REQUIRED', 'x'), 'CONFLUENCE_NOT_CONNECTED'],
  ['a refresh already in flight', new AppError(409, 'CONFLUENCE_REFRESH_IN_PROGRESS', 'x'), 'CONFLUENCE_REFRESH_IN_PROGRESS'],
] as const) {
  test(`${label} surfaces as ${expectedCode}`, async () => {
    const calls: string[] = [];
    const eraser = createConfluenceEraser({
      ...spyDeps(calls),
      connect: async () => {
        throw thrown;
      },
    });

    await assert.rejects(
      () => eraser(target()),
      (error: unknown) => {
        assert.equal((error as AppError).code, expectedCode);
        return true;
      },
    );

    assert.deepEqual(calls, []);
  });
}

// ---------------------------------------------------------------------------
// The permanent-failure predicate, exercised through the engine that uses it.
//
// `isPermanentStorageDeletionFailure` is module-private in document.service.ts
// and stays that way: widening a sensitive module's surface for test
// convenience is how that surface stops meaning anything. What matters is the
// row's observable outcome, which is what these assert — the same way Task 2
// tests the same engine.
// ---------------------------------------------------------------------------

for (const [label, thrown, expectedState] of [
  ['a forbidden purge', new AppError(403, 'CONFLUENCE_PURGE_FORBIDDEN', 'x'), 'DEAD_LETTER'],
  ['a malformed target', new AppError(500, 'ERASURE_TARGET_MALFORMED', 'x'), 'DEAD_LETTER'],
  ['no live connection', new AppError(409, 'CONFLUENCE_NOT_CONNECTED', 'x'), 'DEAD_LETTER'],
  // The two that give the three above their meaning. A predicate returning
  // true for everything would satisfy the first three and quietly turn a
  // five-minute Atlassian outage into a dead-letter cleared by hand.
  ['an unverified erasure', new AppError(502, 'CONFLUENCE_ERASURE_UNVERIFIED', 'x'), 'PENDING'],
  ['an upstream outage', new AppError(503, 'CONFLUENCE_UPSTREAM', 'x'), 'PENDING'],
  ['an aborted attempt', new AppError(504, 'CONFLUENCE_ERASURE_ABORTED', 'x'), 'PENDING'],
] as const) {
  test(`${label} leaves the row ${expectedState}`, async () => {
    const mock = buildFallbackPrisma(pendingRecord({ provider: 'confluence' }));
    const service = new DocumentService(mock.prisma as never, () => NOW);

    await service.retryPendingStorageDeletions(
      createErasureDispatcher({
        confluence: async () => {
          throw thrown;
        },
      }),
      10,
    );

    assert.equal(mock.row().state, expectedState);
    assert.equal(mock.row().attempts, 1);
  });
}

test('a dead-lettered Confluence erasure never counts as processed', async () => {
  const mock = buildFallbackPrisma(pendingRecord({ provider: 'confluence' }));
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(
    createErasureDispatcher({
      confluence: async () => {
        throw new AppError(403, 'CONFLUENCE_PURGE_FORBIDDEN', 'the grant lacks administer space');
      },
    }),
    10,
  );

  assert.equal(result.processed, 0, 'a refused purge must never be recorded as an erasure');
  assert.equal(result.newlyDeadLettered, 1);
  assert.equal(mock.row().processedAt, null);
  assert.equal(mock.row().nextAttemptAt, null);
});

// ---------------------------------------------------------------------------
// The operator recovery route, which is Supabase-only.
// ---------------------------------------------------------------------------

const DEAD_LETTER = {
  id: 'deletion-1',
  organisationId: 'org-1',
  storagePath: 'org-1/rejected.pdf',
  provider: 'supabase',
  targetRef: null as unknown,
  state: 'DEAD_LETTER',
  attempts: 1,
  lastError: 'x',
  lastAttemptAt: new Date('2026-07-11T11:00:00.000Z'),
  nextAttemptAt: null,
  claimedAt: null,
  deadLetteredAt: new Date('2026-07-11T11:00:00.000Z'),
  terminalReason: 'PROVIDER_NOT_ERASABLE',
  alertClaimToken: null,
  alertClaimedAt: null,
  alertedAt: null,
  processedAt: null,
  createdAt: new Date('2026-07-11T09:00:00.000Z'),
};

function recoveryPrisma(overrides: Record<string, unknown> = {}) {
  const row = { ...DEAD_LETTER, ...overrides };
  let update: { data?: Record<string, unknown> } | undefined;
  const prisma: Record<string, unknown> = {
    documentStorageDeletion: {
      updateMany: async (args: { data?: Record<string, unknown> }) => {
        update = args;
        return { count: 1 };
      },
    },
    documentStorageDeletionRecovery: { create: async () => ({ id: 'recovery-1' }) },
  };
  prisma.$queryRaw = async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM "Organisation"')) return [{ id: 'org-1' }];
    if (sql.includes('AS "liveDocument"')) return [{ liveDocument: false, otherDeletion: false }];
    return [row];
  };
  prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma);
  return { prisma, update: () => update };
}

const OPERATOR = {
  actorType: 'PLATFORM_OPERATOR' as const,
  operatorIdentity: 'Jane Recovery Operator',
};
const REASON = 'Reviewed provider evidence authorizes this recovery.';

test('a corrected storage path is refused for a Confluence dead-letter', async () => {
  const mock = recoveryPrisma({ provider: 'confluence', targetRef: { kind: 'confluence' } });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await assert.rejects(
    () =>
      service.recoverDeadLetterStorageDeletion({
        organisationId: 'org-1',
        deletionId: 'deletion-1',
        actor: OPERATOR,
        reason: REASON,
        disposition: 'REQUEUE_CORRECTED_PATH',
        correctedStoragePath: 'org-1/corrected.pdf',
      }),
    (error: unknown) => {
      const e = error as AppError;
      assert.equal(e.code, 'CORRECTED_STORAGE_PATH_PROVIDER_UNSUPPORTED');
      // The operator has to be told which provider refused, and what to do
      // instead, or the refusal is just a wall.
      assert.match(e.message, /confluence/i);
      return true;
    },
  );

  assert.equal(mock.update(), undefined, 'a refused recovery must not touch the row');
});

test('a corrected storage path is still accepted for a Supabase dead-letter', async () => {
  const mock = recoveryPrisma();
  const service = new DocumentService(mock.prisma as never, () => NOW);

  const result = await service.recoverDeadLetterStorageDeletion({
    organisationId: 'org-1',
    deletionId: 'deletion-1',
    actor: OPERATOR,
    reason: REASON,
    disposition: 'REQUEUE_CORRECTED_PATH',
    correctedStoragePath: 'org-1/corrected.pdf',
  });

  assert.equal(result.status, 'PENDING');
  assert.equal(mock.update()?.data?.storagePath, 'org-1/corrected.pdf');
});

// The guard is on the Supabase *vocabulary*, not on the provider as such: the
// two dispositions that carry no storage path stay open to a Confluence row,
// and the externally-remediated one is precisely the recovery flow for content
// a human with space-admin rights emptied out of the site's trash.
for (const [disposition, expectedStatus] of [
  ['REQUEUE_UNCHANGED', 'PENDING'],
  ['COMPLETE_EXTERNALLY_REMEDIATED', 'PROCESSED'],
] as const) {
  test(`${disposition} remains available for a Confluence dead-letter`, async () => {
    const mock = recoveryPrisma({ provider: 'confluence', targetRef: { kind: 'confluence' } });
    const service = new DocumentService(mock.prisma as never, () => NOW);

    const result = await service.recoverDeadLetterStorageDeletion({
      organisationId: 'org-1',
      deletionId: 'deletion-1',
      actor: OPERATOR,
      reason: REASON,
      disposition,
    });

    assert.equal(result.status, expectedStatus);
  });
}
