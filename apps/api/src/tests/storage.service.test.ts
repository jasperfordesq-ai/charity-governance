import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { StorageService, withReadinessTimeout } from '../services/storage.service.js';
import { AppError } from '../utils/errors.js';
import type { OrganisationStorageResolver } from '../services/document-storage-resolution.js';

const STORAGE_OPERATION_FAILED_MESSAGE = 'Document storage operation failed. Please try again later.';

type GuardedStorageService = {
  downloadFile(organisationId: string, storagePath: string): Promise<Buffer>;
  deleteFile(organisationId: string, storagePath: string): Promise<void>;
};

async function assertForbiddenStoragePath(action: () => Promise<unknown>) {
  await assert.rejects(
    action,
    (err) => {
      assert.equal(err instanceof AppError, true);
      const appError = err as AppError;
      assert.equal(appError.statusCode, 403);
      assert.equal(appError.code, 'STORAGE_PATH_FORBIDDEN');
      return true;
    },
  );
}

test('downloadFile rejects storage paths outside the organisation prefix before storage access', async () => {
  const service = new StorageService() as unknown as GuardedStorageService;

  await assertForbiddenStoragePath(() => service.downloadFile('org-a', 'org-b/policy.pdf'));
  await assertForbiddenStoragePath(() => service.downloadFile('org-a', '../org-a/policy.pdf'));
  await assertForbiddenStoragePath(() => service.downloadFile('org-a', 'org-a'));
});

test('deleteFile rejects storage paths outside the organisation prefix before storage access', async () => {
  const service = new StorageService() as unknown as GuardedStorageService;

  await assertForbiddenStoragePath(() => service.deleteFile('org-a', 'org-b/policy.pdf'));
  await assertForbiddenStoragePath(() => service.deleteFile('org-a', '../org-a/policy.pdf'));
  await assertForbiddenStoragePath(() => service.deleteFile('org-a', 'org-a'));
});

test('readiness timeout returns null when a dependency check stalls', async () => {
  let lateResolved = false;
  const result = await withReadinessTimeout(
    new Promise((resolve) => setTimeout(() => {
      lateResolved = true;
      resolve('late');
    }, 100)),
    10,
  );

  assert.equal(result, null);
  assert.equal(lateResolved, false);
});

test('verifyBucket returns false when the configured document bucket is public', async () => {
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
    STORAGE_READINESS_TIMEOUT_MS: process.env.STORAGE_READINESS_TIMEOUT_MS,
  };

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/storage/v1/bucket/documents') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'documents', name: 'documents', public: true }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected test server to listen on a TCP port');
  }

  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.STORAGE_READINESS_TIMEOUT_MS = '1000';

  try {
    const service = new StorageService();

    assert.equal(await service.verifyBucket(), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('local storage driver writes, downloads, and deletes files without Supabase', async () => {
  const originalEnv = {
    API_URL: process.env.API_URL,
    DOCUMENT_STORAGE_DRIVER: process.env.DOCUMENT_STORAGE_DRIVER,
    LOCAL_FILE_STORAGE_DIR: process.env.LOCAL_FILE_STORAGE_DIR,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
  };
  const storageDir = await mkdtemp(join(tmpdir(), 'charitypilot-local-storage-'));

  process.env.API_URL = 'http://localhost:3002';
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_FILE_STORAGE_DIR = storageDir;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;

  try {
    const service = new StorageService();
    assert.equal(service.isConfigured(), true);
    assert.equal(await service.verifyBucket(), true);

    const uploaded = await service.uploadFile(
      'org-local',
      'Board Minutes June 2026.PDF',
      Buffer.from('%PDF-1.7\nlocal file'),
      'application/pdf',
    );

    assert.match(
      uploaded.storagePath,
      /^org-local\/\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-board-minutes-june-2026\.pdf$/,
    );
    assert.equal(
      await readFile(join(storageDir, uploaded.storagePath), 'utf8'),
      '%PDF-1.7\nlocal file',
    );

    const file = await service.readLocalFile('org-local', uploaded.storagePath);
    assert.equal(file.toString('utf8'), '%PDF-1.7\nlocal file');
    const downloaded = await service.downloadFile('org-local', uploaded.storagePath);
    assert.equal(downloaded.toString('utf8'), '%PDF-1.7\nlocal file');

    const dotted = await service.uploadFile(
      'org-local',
      'Board..Minutes.pdf',
      Buffer.from('dotted filename'),
      'application/pdf',
    );
    assert.match(dotted.storagePath, /-board\.\.minutes\.pdf$/);
    assert.equal(
      (await service.downloadFile('org-local', dotted.storagePath)).toString('utf8'),
      'dotted filename',
    );
    await service.deleteFile('org-local', dotted.storagePath);

    await service.deleteFile('org-local', uploaded.storagePath);
    await assert.rejects(() => readFile(join(storageDir, uploaded.storagePath)));
  } finally {
    await rm(storageDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Supabase byte download aborts within the configured bound and returns no bytes', async () => {
  const originalEnv = {
    DOCUMENT_STORAGE_DRIVER: process.env.DOCUMENT_STORAGE_DRIVER,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
    STORAGE_DOWNLOAD_TIMEOUT_MS: process.env.STORAGE_DOWNLOAD_TIMEOUT_MS,
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1024',
    });
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

  delete process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.STORAGE_DOWNLOAD_TIMEOUT_MS = '100';

  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => new StorageService().downloadFile('org-timeout', 'org-timeout/stalled.pdf'),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'STORAGE_DOWNLOAD_FAILED');
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2_000, 'download timeout must bound the API request');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Supabase deletion aborts the underlying request within the configured bound', async () => {
  const originalEnv = {
    DOCUMENT_STORAGE_DRIVER: process.env.DOCUMENT_STORAGE_DRIVER,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
    STORAGE_DELETE_TIMEOUT_MS: process.env.STORAGE_DELETE_TIMEOUT_MS,
  };
  let requestClosed = false;
  const server = createServer((request, response) => {
    request.on('close', () => {
      requestClosed = true;
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

  delete process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.STORAGE_DELETE_TIMEOUT_MS = '100';

  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => new StorageService().deleteFile('org-timeout', 'org-timeout/stalled.pdf'),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'STORAGE_DELETE_FAILED');
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 1_000, 'delete timeout must bound the provider request');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(requestClosed, true, 'the timed fetch must close the underlying provider request');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('uploadFile generates unique storage paths for same-name uploads', async () => {
  const originalEnv = {
    DOCUMENT_STORAGE_DRIVER: process.env.DOCUMENT_STORAGE_DRIVER,
    LOCAL_FILE_STORAGE_DIR: process.env.LOCAL_FILE_STORAGE_DIR,
  };
  const storageDir = await mkdtemp(join(tmpdir(), 'charitypilot-local-storage-'));

  process.env.DOCUMENT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_FILE_STORAGE_DIR = storageDir;

  try {
    const service = new StorageService();
    const [first, second] = await Promise.all([
      service.uploadFile('org-local', 'Board Minutes.pdf', Buffer.from('one'), 'application/pdf'),
      service.uploadFile('org-local', 'Board Minutes.pdf', Buffer.from('two'), 'application/pdf'),
    ]);

    assert.notEqual(first.storagePath, second.storagePath);
    assert.match(first.storagePath, /^org-local\/\d+-[0-9a-f-]+-board-minutes\.pdf$/);
    assert.match(second.storagePath, /^org-local\/\d+-[0-9a-f-]+-board-minutes\.pdf$/);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('an organisation pinned to local storage uses local storage even when the deployment default is supabase', async () => {
  const previousDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_FILE_STORAGE_DIR;
  const root = await mkdtemp(join(tmpdir(), 'charitypilot-per-tenant-'));

  // Deployment default is supabase (driver unset); the organisation overrides it.
  delete process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.LOCAL_FILE_STORAGE_DIR = root;

  const resolver: OrganisationStorageResolver = async () => ({ provider: 'local', alphaOptIn: false });

  try {
    const service = new StorageService(resolver);
    const uploaded = await service.uploadFile('org-pinned', 'policy.pdf', Buffer.from('pinned'), 'application/pdf');

    assert.equal(uploaded.storagePath.startsWith('org-pinned/'), true);
    const roundTripped = await service.downloadFile('org-pinned', uploaded.storagePath);
    assert.equal(roundTripped.toString(), 'pinned');

    await service.deleteFile('org-pinned', uploaded.storagePath);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_FILE_STORAGE_DIR;
    else process.env.LOCAL_FILE_STORAGE_DIR = previousRoot;
  }
});

test('the organisation prefix guard still runs before any resolved provider is used', async () => {
  const resolver: OrganisationStorageResolver = async () => ({ provider: 'local', alphaOptIn: false });
  const service = new StorageService(resolver) as unknown as GuardedStorageService;

  await assertForbiddenStoragePath(() => service.downloadFile('org-a', 'org-b/policy.pdf'));
  await assertForbiddenStoragePath(() => service.deleteFile('org-a', '../org-a/policy.pdf'));
});

// ---------------------------------------------------------------------------
// Extension 1: a failing resolver must not leak a raw error onto document paths.
// ---------------------------------------------------------------------------

test('a resolver that rejects with a plain Error surfaces as AppError 500 STORAGE_PROVIDER_RESOLUTION_FAILED', async () => {
  const explodingResolver: OrganisationStorageResolver = async () => {
    throw new Error('connection to the database was lost');
  };
  const service = new StorageService(explodingResolver);

  await assert.rejects(
    () => service.uploadFile('org-x', 'f.pdf', Buffer.from('x'), 'application/pdf'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      const appError = error as AppError;
      assert.equal(appError.statusCode, 500);
      assert.equal(appError.code, 'STORAGE_PROVIDER_RESOLUTION_FAILED');
      assert.equal(appError.message, STORAGE_OPERATION_FAILED_MESSAGE);
      return true;
    },
  );
});

test('a resolver that rejects with an AppError surfaces unchanged (the alpha gate is meaningful, not infrastructure failure)', async () => {
  // A provider id the registry does not know produces a real, deliberate
  // AppError (STORAGE_PROVIDER_UNKNOWN) from resolveProviderForOrganisation's
  // registry check — this must reach the caller untouched, not be rewrapped.
  const unknownProviderResolver: OrganisationStorageResolver = async () => ({
    provider: 'a-provider-nobody-registered',
    alphaOptIn: false,
  });
  const service = new StorageService(unknownProviderResolver);

  await assert.rejects(
    () => service.uploadFile('org-x', 'f.pdf', Buffer.from('x'), 'application/pdf'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      const appError = error as AppError;
      assert.equal(appError.statusCode, 400);
      assert.equal(appError.code, 'STORAGE_PROVIDER_UNKNOWN');
      assert.notEqual(appError.message, STORAGE_OPERATION_FAILED_MESSAGE);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Extension 2: the delete path's cancellation check must not go stale across
// the (now awaited) provider resolution.
// ---------------------------------------------------------------------------

test('deleteFile re-checks the abort signal after provider resolution and never touches storage once aborted', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'charitypilot-abort-recheck-'));
  const storagePath = 'org-abort/file.pdf';
  const filePath = join(storageDir, 'org-abort', 'file.pdf');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, 'still here');

  const controller = new AbortController();
  let resolverCalled = false;
  const resolverThatAbortsMidFlight: OrganisationStorageResolver = async () => {
    resolverCalled = true;
    controller.abort();
    return { provider: 'local', alphaOptIn: false };
  };

  const originalDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const originalRoot = process.env.LOCAL_FILE_STORAGE_DIR;
  process.env.LOCAL_FILE_STORAGE_DIR = storageDir;

  try {
    const service = new StorageService(resolverThatAbortsMidFlight);

    await assert.rejects(
      () => service.deleteFile('org-abort', storagePath, controller.signal),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        const appError = error as AppError;
        assert.equal(appError.statusCode, 500);
        assert.equal(appError.code, 'STORAGE_DELETE_FAILED');
        assert.equal(appError.message, STORAGE_OPERATION_FAILED_MESSAGE);
        return true;
      },
    );

    assert.equal(resolverCalled, true, 'the resolver must have run for the abort to happen mid-flight');
    // The file must still be there: the stale check would have let the delete through.
    assert.equal((await readFile(filePath)).toString('utf8'), 'still here');
  } finally {
    await rm(storageDir, { recursive: true, force: true });
    if (originalDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = originalDriver;
    if (originalRoot === undefined) delete process.env.LOCAL_FILE_STORAGE_DIR;
    else process.env.LOCAL_FILE_STORAGE_DIR = originalRoot;
  }
});
