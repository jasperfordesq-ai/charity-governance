import { PrismaClient } from '@prisma/client';
import { DocumentService } from '../services/document.service.js';
import { StorageService } from '../services/storage.service.js';
import { validateDocumentStorageCleanupEnv } from '../utils/env.js';
import { logSchedulerError, sendJobFailureAlert } from './production-scheduler.js';

process.env.NODE_ENV ??= 'production';
validateDocumentStorageCleanupEnv();

const prisma = new PrismaClient();
const logger = console;

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

  logger.info(`Document storage cleanup completed. Processed: ${result.processed}. Failed: ${result.failed}.`);
  if (result.failed > 0) {
    const cleanupFailure = new Error(`Document storage cleanup reported ${result.failed} failed deletion(s).`);
    cleanupFailure.name = 'DocumentStorageCleanupFailure';
    await sendJobFailureAlert({
      job: 'document-storage-cleanup',
      code: 'DOCUMENT_STORAGE_CLEANUP_FAILED',
      error: cleanupFailure,
      logger,
    });
    process.exitCode = 1;
  }
} catch (error) {
  logSchedulerError(logger, 'Document storage cleanup job failed:', error);
  await sendJobFailureAlert({
    job: 'document-storage-cleanup',
    code: 'DOCUMENT_STORAGE_CLEANUP_FAILED',
    error,
    logger,
  });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
