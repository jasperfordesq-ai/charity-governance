import assert from 'node:assert/strict';
import test from 'node:test';
import { StorageService } from '../services/storage.service.js';
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
