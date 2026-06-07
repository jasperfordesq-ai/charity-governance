import { PrismaClient } from '@prisma/client';
import { DocumentService } from '../services/document.service.js';
import { StorageService } from '../services/storage.service.js';
import { validateDocumentStorageCleanupEnv } from '../utils/env.js';

process.env.NODE_ENV ??= 'production';
validateDocumentStorageCleanupEnv();

const prisma = new PrismaClient();

function cleanupLimit(): number {
  const configured = Number(process.env.DOCUMENT_STORAGE_CLEANUP_LIMIT);
  return Number.isInteger(configured) && configured > 0 ? configured : 25;
}

try {
  const documentService = new DocumentService(prisma);
  const storageService = new StorageService();
  const result = await documentService.retryPendingStorageDeletions(
    (organisationId, storagePath) => storageService.deleteFile(organisationId, storagePath),
    cleanupLimit(),
  );

  console.log(`Document storage cleanup completed. Processed: ${result.processed}. Failed: ${result.failed}.`);
  if (result.failed > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Document storage cleanup job failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
