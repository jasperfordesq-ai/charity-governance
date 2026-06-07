import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { StorageService, withReadinessTimeout } from '../services/storage.service.js';
import { AppError } from '../utils/errors.js';

type GuardedStorageService = {
  getSignedUrl(organisationId: string, storagePath: string, expiresIn?: number): Promise<string>;
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

test('getSignedUrl rejects storage paths outside the organisation prefix before storage access', async () => {
  const service = new StorageService() as unknown as GuardedStorageService;

  await assertForbiddenStoragePath(() => service.getSignedUrl('org-a', 'org-b/policy.pdf'));
  await assertForbiddenStoragePath(() => service.getSignedUrl('org-a', '../org-a/policy.pdf'));
  await assertForbiddenStoragePath(() => service.getSignedUrl('org-a', 'org-a'));
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
