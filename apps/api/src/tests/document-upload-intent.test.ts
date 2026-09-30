import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentService } from '../services/document.service.js';
import { StorageService } from '../services/storage.service.js';

test('a failed reservation prevents the local byte write', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'charitypilot-upload-intent-'));
  const previousDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_FILE_STORAGE_DIR;
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_FILE_STORAGE_DIR = root;
  let reserved: { storagePath: string; provider: string } | undefined;
  try {
    await assert.rejects(
      new StorageService().uploadFile('org-1', 'policy.pdf', Buffer.from('%PDF-1.7'), 'application/pdf', async (prepared) => {
        reserved = prepared;
        throw new Error('reservation database unavailable');
      }),
      /reservation database unavailable/,
    );
    assert.equal(reserved?.provider, 'local');
    assert.match(reserved?.storagePath ?? '', /^org-1\/.*policy\.pdf$/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previousDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_FILE_STORAGE_DIR;
    else process.env.LOCAL_FILE_STORAGE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('stale reservations attach committed documents and queue provider-pinned orphan cleanup', async () => {
  const now = new Date('2026-09-29T12:00:00.000Z');
  const intents = [
    { id: 'committed', organisationId: 'org-1', storagePath: 'org-1/live.pdf', provider: 'local', state: 'RESERVED' },
    { id: 'orphan', organisationId: 'org-2', storagePath: 'org-2/orphan.pdf', provider: 'supabase', state: 'RESERVED' },
  ];
  const deletions: Array<Record<string, unknown>> = [];
  const db = {
    documentUploadIntent: {
      async findMany(args: { where: { createdAt: { lte: Date } }; take: number; orderBy: unknown[] }) {
        assert.equal(args.take, 2);
        assert.equal(args.where.createdAt.lte.toISOString(), '2026-09-29T11:00:00.000Z');
        assert.deepEqual(args.orderBy[0], { lastReconcileAttemptAt: { sort: 'asc', nulls: 'first' } });
        return intents.map(({ id }) => ({ id }));
      },
      async findFirst(args: { where: { id: string } }) {
        return intents.find((intent) => intent.id === args.where.id && intent.state === 'RESERVED') ?? null;
      },
      async updateMany(args: { where: { id: string; state: string }; data: { state?: string; documentId?: string; cleanupDeletionId?: string; lastReconcileAttemptAt?: Date } }) {
        const intent = intents.find((row) => row.id === args.where.id && row.state === args.where.state);
        if (!intent) return { count: 0 };
        if (args.data.lastReconcileAttemptAt) {
          assert.equal(args.data.lastReconcileAttemptAt.toISOString(), now.toISOString());
          return { count: 1 };
        }
        if (!args.data.state) assert.fail('settlement must change the reservation state');
        intent.state = args.data.state;
        assert.equal(args.data.state === 'ATTACHED' ? args.data.documentId : args.data.cleanupDeletionId, args.data.state === 'ATTACHED' ? 'doc-live' : 'deletion-1');
        return { count: 1 };
      },
    },
    document: {
      async findFirst(args: { where: { organisationId: string; fileUrl: string } }) {
        return args.where.organisationId === 'org-1' && args.where.fileUrl === 'org-1/live.pdf' ? { id: 'doc-live' } : null;
      },
    },
    documentStorageDeletion: {
      async create(args: { data: Record<string, unknown> }) {
        deletions.push(args.data);
        return { id: 'deletion-1' };
      },
    },
    async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> { return callback(db); },
  };
  const result = await new DocumentService(db as never, () => now).reconcileStaleUploadIntents(2);
  assert.deepEqual(result, { attached: 1, queued: 1, failed: 0 });
  assert.deepEqual(intents.map((intent) => intent.state), ['ATTACHED', 'CLEANUP_PENDING']);
  assert.deepEqual(deletions, [{
    organisationId: 'org-2', storagePath: 'org-2/orphan.pdf', provider: 'supabase',
    targetRef: { source: 'UPLOAD_INTENT', intentId: 'orphan' },
  }]);
});

test('failed cleanup queue insertion leaves a reservation for the next reconciliation', async () => {
  const db = {
    documentUploadIntent: {
      async findMany() { return [{ id: 'orphan' }]; },
      async findFirst() { return { id: 'orphan', organisationId: 'org-1', storagePath: 'org-1/orphan.pdf', provider: 'local' }; },
      async updateMany(args: { data: { lastReconcileAttemptAt?: Date } }) {
        if (args.data.lastReconcileAttemptAt) return { count: 1 };
        assert.fail('reservation must not transition without a deletion row');
      },
    },
    document: { async findFirst() { return null; } },
    documentStorageDeletion: { async create() { throw new Error('database unavailable'); } },
    async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> { return callback(db); },
  };
  const result = await new DocumentService(db as never).reconcileStaleUploadIntents();
  assert.deepEqual(result, { attached: 0, queued: 0, failed: 1 });
});

test('failed old reservations do not starve a later orphaned upload', async () => {
  const createdAt = new Date('2026-09-29T09:00:00.000Z');
  let now = new Date('2026-09-29T12:00:00.000Z');
  const intents = ['broken-1', 'broken-2', 'later-orphan'].map((id) => ({
    id, organisationId: 'org-1', storagePath: `org-1/${id}.pdf`, provider: 'local',
    state: 'RESERVED', createdAt, lastReconcileAttemptAt: null as Date | null,
  }));
  const db = {
    documentUploadIntent: {
      async findMany(args: { take: number }) {
        return intents.filter((row) => row.state === 'RESERVED')
          .sort((a, b) => (a.lastReconcileAttemptAt?.getTime() ?? -1) - (b.lastReconcileAttemptAt?.getTime() ?? -1))
          .slice(0, args.take).map((row) => ({ id: row.id }));
      },
      async findFirst(args: { where: { id: string } }) {
        return intents.find((row) => row.id === args.where.id && row.state === 'RESERVED') ?? null;
      },
      async updateMany(args: { where: { id: string; state: string }; data: { lastReconcileAttemptAt?: Date; state?: string; cleanupDeletionId?: string } }) {
        const row = intents.find((intent) => intent.id === args.where.id && intent.state === args.where.state);
        if (!row) return { count: 0 };
        if (args.data.lastReconcileAttemptAt) row.lastReconcileAttemptAt = args.data.lastReconcileAttemptAt;
        if (args.data.state) row.state = args.data.state;
        return { count: 1 };
      },
    },
    document: { async findFirst() { return null; } },
    documentStorageDeletion: {
      async create(args: { data: { storagePath: string } }) {
        if (!args.data.storagePath.endsWith('/later-orphan.pdf')) throw new Error('provider queue is unavailable for this old object');
        return { id: 'late-deletion' };
      },
    },
    async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> { return callback(db); },
  };
  const service = new DocumentService(db as never, () => now);
  assert.deepEqual(await service.reconcileStaleUploadIntents(2), { attached: 0, queued: 0, failed: 2 });
  now = new Date('2026-09-29T13:00:00.000Z');
  assert.deepEqual(await service.reconcileStaleUploadIntents(2), { attached: 0, queued: 1, failed: 1 });
  assert.equal(intents[2].state, 'CLEANUP_PENDING');
  assert.deepEqual(intents.slice(0, 2).map((row) => row.state), ['RESERVED', 'RESERVED']);
});
