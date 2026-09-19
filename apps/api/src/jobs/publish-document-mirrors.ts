import { PrismaClient } from '@prisma/client';
import {
  createConfluencePublisher,
  DocumentPublicationService,
} from '../services/document-publication.service.js';
import { StorageService } from '../services/storage.service.js';
import { createPrismaOrganisationStorageResolver } from '../services/document-storage-resolution.js';
import { validateDocumentStorageCleanupEnv } from '../utils/env.js';
import { logSchedulerError, sendJobFailureAlert } from './production-scheduler.js';

/**
 * The standalone publish worker, for a deployment that runs jobs from cron
 * rather than the in-process scheduler.
 *
 * **Both entry points exist and both must register the publisher.** Phase 5
 * shipped a phase that was dead in production because only one of its two
 * entry points was wired: the code was correct, tested and never ran. This
 * file and `production-scheduler.ts` are pinned separately, so losing either
 * fails its own test.
 *
 * The environment it needs is the document-storage cleanup job's, exactly:
 * a database, a storage backend to read the bytes out of, and an alert
 * webhook. It deliberately reuses that validator rather than declaring a
 * near-identical one, because two validators that were meant to say the same
 * thing are two validators that can come to disagree.
 */

process.env.NODE_ENV ??= 'production';
validateDocumentStorageCleanupEnv();

const prisma = new PrismaClient();
const logger = console;

function publishLimit(): number {
  const configured = Number(process.env.DOCUMENT_PUBLICATION_LIMIT);
  return Number.isInteger(configured) && configured > 0 ? configured : 25;
}

try {
  const publicationService = new DocumentPublicationService(prisma);
  const storageService = new StorageService(createPrismaOrganisationStorageResolver(prisma));
  const publish = createConfluencePublisher({
    prisma,
    // The authoritative Irish copy is the source of the bytes. Confluence is a
    // mirror and never the place they are read back from.
    downloadFile: (organisationId, storagePath) =>
      storageService.downloadFile(organisationId, storagePath),
  });
  const result = await publicationService.retryPendingPublications(publish, publishLimit());

  logger.info(
    `Document publication completed. Processed: ${result.processed}. Retry scheduled: ${result.retryScheduled}. Newly dead-lettered: ${result.newlyDeadLettered}.`,
  );
  if (result.deadLetterAlert) {
    const publishFailure = new Error(
      `Document publication requires operator review for ${result.deadLetterAlert.ids.length} dead-lettered publication(s).`,
    );
    publishFailure.name = 'DocumentPublicationDeadLettered';
    const delivered = await sendJobFailureAlert({
      job: 'document-publication',
      code: 'DOCUMENT_PUBLICATION_DEAD_LETTERED',
      error: publishFailure,
      logger,
      affectedCount: result.deadLetterAlert.ids.length,
    });
    if (delivered) {
      await publicationService.markDeadLetterAlertSent(result.deadLetterAlert);
    } else {
      await publicationService.releaseDeadLetterAlertClaim(result.deadLetterAlert);
    }
    process.exitCode = 1;
  }
} catch (error) {
  logSchedulerError(logger, 'Document publication job failed:', error);
  await sendJobFailureAlert({
    job: 'document-publication',
    code: 'DOCUMENT_PUBLICATION_FAILED',
    error,
    logger,
  });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
