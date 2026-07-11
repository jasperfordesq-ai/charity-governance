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
    (organisationId, storagePath, signal) => storageService.deleteFile(organisationId, storagePath, signal),
    cleanupLimit(),
  );

  logger.info(
    `Document storage cleanup completed. Processed: ${result.processed}. Retry scheduled: ${result.retryScheduled}. Newly dead-lettered: ${result.newlyDeadLettered}.`,
  );
  if (result.deadLetterAlert) {
    const cleanupFailure = new Error(
      `Document storage cleanup requires operator review for ${result.deadLetterAlert.ids.length} dead-lettered deletion(s).`,
    );
    cleanupFailure.name = 'DocumentStorageDeletionDeadLettered';
    const delivered = await sendJobFailureAlert({
      job: 'document-storage-cleanup',
      code: 'DOCUMENT_STORAGE_DELETION_DEAD_LETTERED',
      error: cleanupFailure,
      logger,
      affectedCount: result.deadLetterAlert.ids.length,
    });
    if (delivered) {
      await documentService.markDeadLetterAlertSent(result.deadLetterAlert);
    } else {
      await documentService.releaseDeadLetterAlertClaim(result.deadLetterAlert);
    }
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
