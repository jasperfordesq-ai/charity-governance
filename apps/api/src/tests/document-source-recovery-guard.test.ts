import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentService } from '../services/document.service.js';

test('storage-provider review refuses recovery binding after provider inspection', async () => {
  let writes = 0;
  let inspected = 0;
  const db = {
    document: {
      findFirst: async () => ({ id: 'doc-1', fileUrl: 'org-1/source.pdf', fileSize: 3, storageProvider: null }),
      update: async () => { writes += 1; return { id: 'doc-1', updatedAt: new Date() }; },
    },
    $queryRaw: async () => [{ id: 'org-1' }],
    documentRecoveryEnforcement: { findUnique: async () => ({ id: 'binding' }) },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  };
  const service = new DocumentService(db as never);
  await assert.rejects(
    () => service.verifyWrittenStorageProvider({
      organisationId: 'org-1', documentId: 'doc-1', actorUserId: 'owner-1', expectedUpdatedAt: new Date(),
    }, async (_path, provider) => {
      inspected += 1;
      return { present: provider === 'local', size: provider === 'local' ? 3 : null };
    }),
    (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 409 && error.code === 'DOCUMENT_SOURCE_RECOVERY_REQUIRED',
  );
  assert.equal(inspected, 2);
  assert.equal(writes, 0);
});
