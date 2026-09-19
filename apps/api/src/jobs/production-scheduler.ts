import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import { DocumentService, type DocumentStorageCleanupResult } from '../services/document.service.js';
import {
  buildOperationalErrorAlertPayload,
  sendErrorAlert,
  type ErrorAlertPayload,
} from '../services/error-alerts.service.js';
import { StorageService } from '../services/storage.service.js';
import { createPrismaOrganisationStorageResolver } from '../services/document-storage-resolution.js';
import {
  createErasureDispatcher,
  createSupabaseEraser,
  type ErasureDispatcher,
} from '../services/document-erasure.js';
import { createConfluenceEraser } from '../services/confluence-erasure.js';
import {
  createConfluencePublisher,
  DocumentPublicationService,
  type ConfluencePublisherDeps,
  type DocumentPublicationRunResult,
  type Publisher,
} from '../services/document-publication.service.js';
import type { ConfluenceConnectionClient } from '../services/confluence-connection.service.js';
import {
  validateAuthDeliveryEnv,
  validateDeadlineRemindersEnv,
  validateDocumentStorageCleanupEnv,
} from '../utils/env.js';
import { serializeErrorForLog } from '../utils/logger.js';
import {
  AuthEmailDeliveryService,
  type AuthEmailDeliveryRunResult,
  type AuthOperatorReviewAlertClaim,
} from '../services/auth-email-delivery.service.js';
import { requireAuthRecoveryControlForRuntime } from '../services/auth-recovery-control.js';

const DEFAULT_DEADLINE_REMINDERS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_DOCUMENT_STORAGE_CLEANUP_LIMIT = 25;
// More often than cleanup: a charity that uploads a governance document is
// waiting to see it mirrored, where a deletion nobody is watching can wait an
// hour. Still an outbox, so the interval is a floor on latency, not a promise.
const DEFAULT_DOCUMENT_PUBLICATION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DOCUMENT_PUBLICATION_LIMIT = 25;
const DEFAULT_AUTH_DELIVERY_INTERVAL_MS = 5 * 1000;
const DEFAULT_AUTH_DELIVERY_BATCH_SIZE = 25;
const DEFAULT_AUTH_DELIVERY_CLEANUP_BATCH_SIZE = 500;
const DEFAULT_AUTH_DELIVERY_STALE_SENDING_MS = 60 * 1000;
const DEFAULT_SCHEDULER_SHUTDOWN_TIMEOUT_MS = 45 * 1000;
const MAX_SCHEDULER_SHUTDOWN_TIMEOUT_MS = 55 * 1000;

type SchedulerEnv = Record<string, string | undefined>;

type SchedulerLogger = {
  info(message: string): void;
  error(message: string, error?: unknown): void;
};

type DeadlineReminderRunner = {
  sendDueReminders(): Promise<void>;
};

type DocumentStorageCleanupRunner = {
  retryPendingStorageDeletions(
    dispatch: ErasureDispatcher,
    limit: number,
  ): Promise<DocumentStorageCleanupResult | { processed: number; failed: number }>;
  markDeadLetterAlertSent?(claim: { claimToken: string; ids: string[] }): Promise<number>;
  releaseDeadLetterAlertClaim?(claim: { claimToken: string; ids: string[] }): Promise<number>;
};

type StorageDeletionRunner = {
  deleteFile(organisationId: string, storagePath: string, signal?: AbortSignal): Promise<void>;
};

type DocumentPublicationRunner = {
  retryPendingPublications(
    publish: Publisher,
    limit: number,
  ): Promise<DocumentPublicationRunResult | { processed: number; failed: number }>;
  markDeadLetterAlertSent?(claim: { claimToken: string; ids: string[] }): Promise<number>;
  releaseDeadLetterAlertClaim?(claim: { claimToken: string; ids: string[] }): Promise<number>;
};

/** Where the publish worker reads the authoritative bytes from. */
type DocumentDownloadRunner = {
  downloadFile(organisationId: string, storagePath: string): Promise<Uint8Array>;
};

type AuthEmailDeliveryRunner = {
  processDueDeliveries(input: {
    limit: number;
    cleanupLimit: number;
    staleSendingMs: number;
  }): Promise<AuthEmailDeliveryRunResult>;
  claimOperatorReviewAlert?(limit: number): Promise<AuthOperatorReviewAlertClaim | null>;
  markOperatorReviewAlertSent?(claim: AuthOperatorReviewAlertClaim): Promise<number>;
  releaseOperatorReviewAlertClaim?(claim: AuthOperatorReviewAlertClaim): Promise<number>;
};

type AlertSender = (payload: ErrorAlertPayload) => Promise<void | boolean>;

export type ProductionSchedulerConfig = {
  deadlineRemindersIntervalMs: number;
  documentStorageCleanupIntervalMs: number;
  documentStorageCleanupLimit: number;
  documentPublicationIntervalMs: number;
  documentPublicationLimit: number;
  authDeliveryIntervalMs: number;
  authDeliveryBatchSize: number;
  authDeliveryCleanupBatchSize: number;
  authDeliveryStaleSendingMs: number;
  shutdownTimeoutMs: number;
  runOnce: boolean;
};

export type ProductionSchedulerRunResult = {
  deadlineRemindersFailed: boolean;
  documentStorageCleanupFailed: boolean;
  documentPublicationFailed: boolean;
  authEmailDeliveryFailed: boolean;
};

export function productionSchedulerConfigFromEnv(env: SchedulerEnv = process.env): ProductionSchedulerConfig {
  return {
    deadlineRemindersIntervalMs: positiveIntegerEnv(
      env.DEADLINE_REMINDERS_INTERVAL_MS,
      DEFAULT_DEADLINE_REMINDERS_INTERVAL_MS,
    ),
    documentStorageCleanupIntervalMs: positiveIntegerEnv(
      env.DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS,
      DEFAULT_DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS,
    ),
    documentStorageCleanupLimit: positiveIntegerEnv(
      env.DOCUMENT_STORAGE_CLEANUP_LIMIT,
      DEFAULT_DOCUMENT_STORAGE_CLEANUP_LIMIT,
    ),
    documentPublicationIntervalMs: positiveIntegerEnv(
      env.DOCUMENT_PUBLICATION_INTERVAL_MS,
      DEFAULT_DOCUMENT_PUBLICATION_INTERVAL_MS,
    ),
    documentPublicationLimit: positiveIntegerEnv(
      env.DOCUMENT_PUBLICATION_LIMIT,
      DEFAULT_DOCUMENT_PUBLICATION_LIMIT,
    ),
    authDeliveryIntervalMs: boundedPositiveIntegerEnv(
      env.AUTH_DELIVERY_INTERVAL_MS,
      DEFAULT_AUTH_DELIVERY_INTERVAL_MS,
      60 * 1000,
    ),
    authDeliveryBatchSize: boundedPositiveIntegerEnv(
      env.AUTH_DELIVERY_BATCH_SIZE,
      DEFAULT_AUTH_DELIVERY_BATCH_SIZE,
      100,
    ),
    authDeliveryCleanupBatchSize: boundedPositiveIntegerEnv(
      env.AUTH_DELIVERY_CLEANUP_BATCH_SIZE,
      DEFAULT_AUTH_DELIVERY_CLEANUP_BATCH_SIZE,
      1_000,
      3,
    ),
    authDeliveryStaleSendingMs: boundedPositiveIntegerEnv(
      env.AUTH_DELIVERY_STALE_SENDING_MS,
      DEFAULT_AUTH_DELIVERY_STALE_SENDING_MS,
      300 * 1000,
    ),
    shutdownTimeoutMs: boundedPositiveIntegerEnv(
      env.PRODUCTION_SCHEDULER_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SCHEDULER_SHUTDOWN_TIMEOUT_MS,
      MAX_SCHEDULER_SHUTDOWN_TIMEOUT_MS,
    ),
    runOnce: env.PRODUCTION_SCHEDULER_RUN_ONCE === 'true',
  };
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function logSchedulerError(logger: SchedulerLogger, message: string, error: unknown): void {
  logger.error(message, serializeErrorForLog(error));
}

export async function runDeadlineReminders(input: {
  deadlineService: DeadlineReminderRunner;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
}): Promise<boolean> {
  try {
    await input.deadlineService.sendDueReminders();
    input.logger.info('[ProductionScheduler] Deadline reminders run completed.');
    return false;
  } catch (error) {
    logSchedulerError(input.logger, '[ProductionScheduler] Deadline reminders run failed.', error);
    await sendJobFailureAlert({
      job: 'deadline-reminders',
      code: 'DEADLINE_REMINDERS_FAILED',
      error,
      logger: input.logger,
      alertSender: input.alertSender,
    });
    return true;
  }
}

export async function runDocumentStorageCleanup(input: {
  documentService: DocumentStorageCleanupRunner;
  storageService: StorageDeletionRunner;
  /**
   * Required, not optional, because the Confluence eraser reads the charity's
   * connection through it. An optional field here would let a future entry
   * point build a dispatcher without one and dead-letter every Confluence
   * erasure; the compiler refuses that instead.
   */
  prisma: ConfluenceConnectionClient;
  documentStorageCleanupLimit: number;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
}): Promise<boolean> {
  try {
    const dispatch = createErasureDispatcher({
      supabase: createSupabaseEraser((organisationId, storagePath, signal) =>
        input.storageService.deleteFile(organisationId, storagePath, signal)),
      // Registered unconditionally, for the same reason
      // `cleanup-document-storage.ts` registers it: a Confluence row is
      // enqueued by the same `remove()` that enqueues a Supabase one, so
      // leaving this unregistered on any deployment would dead-letter every
      // Confluence erasure as PROVIDER_NOT_ERASABLE — a charity's published
      // copy left in place while an operator is told the deployment cannot
      // erase it. This is the entry point that actually runs in production.
      confluence: createConfluenceEraser({ prisma: input.prisma }),
    });
    const result = await input.documentService.retryPendingStorageDeletions(
      dispatch,
      input.documentStorageCleanupLimit,
    );
    input.logger.info(
      `[ProductionScheduler] Document storage cleanup run completed. Processed: ${result.processed}. Retry scheduled: ${'retryScheduled' in result ? result.retryScheduled : result.failed}. Newly dead-lettered: ${'newlyDeadLettered' in result ? result.newlyDeadLettered : 0}.`,
    );
    const deadLetterAlert = 'deadLetterAlert' in result ? result.deadLetterAlert : null;
    if (deadLetterAlert) {
      if (!input.documentService.markDeadLetterAlertSent || !input.documentService.releaseDeadLetterAlertClaim) {
        throw new Error('Document storage cleanup dead-letter alert acknowledgement is unavailable');
      }
      const cleanupFailure = new Error(
        `Document storage cleanup requires operator review for ${deadLetterAlert.ids.length} dead-lettered deletion(s).`,
      );
      cleanupFailure.name = 'DocumentStorageDeletionDeadLettered';
      const delivered = await sendJobFailureAlert({
        job: 'document-storage-cleanup',
        code: 'DOCUMENT_STORAGE_DELETION_DEAD_LETTERED',
        error: cleanupFailure,
        logger: input.logger,
        alertSender: input.alertSender,
        affectedCount: deadLetterAlert.ids.length,
      });
      if (delivered) {
        await input.documentService.markDeadLetterAlertSent(deadLetterAlert);
      } else {
        await input.documentService.releaseDeadLetterAlertClaim(deadLetterAlert);
      }
      return true;
    }
    return false;
  } catch (error) {
    logSchedulerError(input.logger, '[ProductionScheduler] Document storage cleanup run failed.', error);
    await sendJobFailureAlert({
      job: 'document-storage-cleanup',
      code: 'DOCUMENT_STORAGE_CLEANUP_FAILED',
      error,
      logger: input.logger,
      alertSender: input.alertSender,
    });
    return true;
  }
}

/**
 * Publishes the charities' governance documents into their own Confluence
 * sites — the entry point that actually runs in production.
 *
 * **This is the second of two registrations, and it is the one that matters.**
 * `publish-document-mirrors.ts` covers a cron deployment; a deployment running
 * the in-process scheduler runs this. Phase 5 shipped a phase that was dead in
 * production because only one of its two entry points was wired, so each
 * registration is pinned by its own test.
 */
export async function runDocumentPublication(input: {
  publicationService: DocumentPublicationRunner;
  storageService: DocumentDownloadRunner;
  /**
   * Required, not optional, for the same reason `runDocumentStorageCleanup`'s
   * is: the publisher reads the charity's connection, its chosen space and its
   * document through it. An optional field would let a future entry point
   * build a publisher without one, and publish nothing at all.
   */
  prisma: NonNullable<ConfluencePublisherDeps['prisma']>;
  documentPublicationLimit: number;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
}): Promise<boolean> {
  try {
    const publish = createConfluencePublisher({
      prisma: input.prisma,
      // The authoritative Irish copy is where the bytes come from. Confluence
      // is a mirror and is never read back from here.
      downloadFile: (organisationId, storagePath) =>
        input.storageService.downloadFile(organisationId, storagePath),
    });
    const result = await input.publicationService.retryPendingPublications(
      publish,
      input.documentPublicationLimit,
    );
    input.logger.info(
      `[ProductionScheduler] Document publication run completed. Processed: ${result.processed}. Retry scheduled: ${'retryScheduled' in result ? result.retryScheduled : result.failed}. Newly dead-lettered: ${'newlyDeadLettered' in result ? result.newlyDeadLettered : 0}.`,
    );
    const deadLetterAlert = 'deadLetterAlert' in result ? result.deadLetterAlert : null;
    if (deadLetterAlert) {
      if (!input.publicationService.markDeadLetterAlertSent || !input.publicationService.releaseDeadLetterAlertClaim) {
        throw new Error('Document publication dead-letter alert acknowledgement is unavailable');
      }
      const publishFailure = new Error(
        `Document publication requires operator review for ${deadLetterAlert.ids.length} dead-lettered publication(s).`,
      );
      publishFailure.name = 'DocumentPublicationDeadLettered';
      const delivered = await sendJobFailureAlert({
        job: 'document-publication',
        code: 'DOCUMENT_PUBLICATION_DEAD_LETTERED',
        error: publishFailure,
        logger: input.logger,
        alertSender: input.alertSender,
        affectedCount: deadLetterAlert.ids.length,
      });
      if (delivered) {
        await input.publicationService.markDeadLetterAlertSent(deadLetterAlert);
      } else {
        await input.publicationService.releaseDeadLetterAlertClaim(deadLetterAlert);
      }
      return true;
    }
    return false;
  } catch (error) {
    logSchedulerError(input.logger, '[ProductionScheduler] Document publication run failed.', error);
    await sendJobFailureAlert({
      job: 'document-publication',
      code: 'DOCUMENT_PUBLICATION_FAILED',
      error,
      logger: input.logger,
      alertSender: input.alertSender,
    });
    return true;
  }
}

export async function runAuthEmailDelivery(input: {
  deliveryService: AuthEmailDeliveryRunner;
  batchSize: number;
  cleanupBatchSize: number;
  staleSendingMs: number;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
}): Promise<boolean> {
  let result: AuthEmailDeliveryRunResult | undefined;
  let processingError: unknown;
  let alertLifecycleFailed = false;
  try {
    result = await input.deliveryService.processDueDeliveries({
      limit: input.batchSize,
      cleanupLimit: input.cleanupBatchSize,
      staleSendingMs: input.staleSendingMs,
    });
    input.logger.info(
      `[ProductionScheduler] Authentication email delivery run completed. Processed: ${result.processed}. Accepted: ${result.accepted}. Retry scheduled: ${result.retryScheduled}. Terminal rejected: ${result.rejected}. Uncertain: ${result.uncertain}. Key unavailable: ${result.keyUnavailable}. Stale quarantined: ${result.staleQuarantined}. Cleaned: ${result.cleaned}.`,
    );
  } catch (error) {
    logSchedulerError(
      input.logger,
      '[ProductionScheduler] Authentication email delivery run failed.',
      error,
    );
    processingError = error;
  }

  let reviewAlert: AuthOperatorReviewAlertClaim | null = null;
  if (input.deliveryService.claimOperatorReviewAlert) {
    try {
      reviewAlert = await input.deliveryService.claimOperatorReviewAlert(
        input.cleanupBatchSize,
      );
    } catch (error) {
      logSchedulerError(
        input.logger,
        '[ProductionScheduler] Authentication operator-review alert claim failed.',
        error,
      );
      processingError ??= error;
    }
  }

  if (reviewAlert) {
    const canFinalize = input.deliveryService.markOperatorReviewAlertSent &&
      input.deliveryService.releaseOperatorReviewAlertClaim;
    if (!canFinalize) {
      const error = new Error(
        'Authentication operator-review alert acknowledgement is unavailable',
      );
      logSchedulerError(
        input.logger,
        '[ProductionScheduler] Authentication operator-review alert was not sent.',
        error,
      );
      alertLifecycleFailed = true;
    } else {
      const deliveryFailure = new Error(
        `Authentication email delivery requires operator review for ${reviewAlert.affectedCount} persisted terminal outcome(s).`,
      );
      deliveryFailure.name = 'AuthEmailDeliveryFailed';
      const delivered = await sendJobFailureAlert({
        job: 'auth-email-delivery',
        code: 'AUTH_EMAIL_DELIVERY_FAILED',
        error: deliveryFailure,
        logger: input.logger,
        alertSender: input.alertSender,
        affectedCount: reviewAlert.affectedCount,
      });
      try {
        if (delivered) {
          await input.deliveryService.markOperatorReviewAlertSent!(reviewAlert);
        } else {
          await input.deliveryService.releaseOperatorReviewAlertClaim!(reviewAlert);
        }
      } catch (error) {
        logSchedulerError(
          input.logger,
          delivered
            ? '[ProductionScheduler] Authentication operator-review alert acknowledgement failed.'
            : '[ProductionScheduler] Authentication operator-review alert claim release failed.',
          error,
        );
        alertLifecycleFailed = true;
      }
    }
  }

  // Compatibility for injected runners that predate the durable claim contract.
  // The production AuthEmailDeliveryService always uses persisted claims above.
  const currentRunAffectedCount = result
    ? result.rejected + result.uncertain + result.keyUnavailable + result.staleQuarantined
    : 0;
  if (
    currentRunAffectedCount > 0 &&
    !input.deliveryService.claimOperatorReviewAlert
  ) {
    const deliveryFailure = new Error(
      `Authentication email delivery requires operator review for ${currentRunAffectedCount} rejected, uncertain, key-unavailable, or stale-quarantined outcome(s).`,
    );
    deliveryFailure.name = 'AuthEmailDeliveryFailed';
    await sendJobFailureAlert({
      job: 'auth-email-delivery',
      code: 'AUTH_EMAIL_DELIVERY_FAILED',
      error: deliveryFailure,
      logger: input.logger,
      alertSender: input.alertSender,
      affectedCount: currentRunAffectedCount,
    });
  }

  if (processingError !== undefined) {
    await sendJobFailureAlert({
      job: 'auth-email-delivery',
      code: 'AUTH_EMAIL_DELIVERY_FAILED',
      error: processingError,
      logger: input.logger,
      alertSender: input.alertSender,
    });
  }

  return processingError !== undefined ||
    alertLifecycleFailed ||
    currentRunAffectedCount > 0 ||
    reviewAlert !== null;
}

export async function runProductionSchedulerOnce(input: {
  deadlineService: DeadlineReminderRunner;
  documentService: DocumentStorageCleanupRunner;
  publicationService: DocumentPublicationRunner;
  storageService: StorageDeletionRunner & DocumentDownloadRunner;
  authEmailDeliveryService: AuthEmailDeliveryRunner;
  /**
   * Forwarded to {@link runDocumentStorageCleanup}, which needs it to erase
   * Confluence rows, and to {@link runDocumentPublication}, which needs it to
   * publish them.
   */
  prisma: ConfluenceConnectionClient & NonNullable<ConfluencePublisherDeps['prisma']>;
  documentStorageCleanupLimit: number;
  documentPublicationLimit: number;
  authDeliveryBatchSize: number;
  authDeliveryCleanupBatchSize: number;
  authDeliveryStaleSendingMs: number;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
}): Promise<ProductionSchedulerRunResult> {
  const deadlineRemindersFailed = await runDeadlineReminders({
    deadlineService: input.deadlineService,
    logger: input.logger,
    alertSender: input.alertSender,
  });
  const documentStorageCleanupFailed = await runDocumentStorageCleanup({
    documentService: input.documentService,
    storageService: input.storageService,
    prisma: input.prisma,
    documentStorageCleanupLimit: input.documentStorageCleanupLimit,
    logger: input.logger,
    alertSender: input.alertSender,
  });
  const documentPublicationFailed = await runDocumentPublication({
    publicationService: input.publicationService,
    storageService: input.storageService,
    prisma: input.prisma,
    documentPublicationLimit: input.documentPublicationLimit,
    logger: input.logger,
    alertSender: input.alertSender,
  });
  const authEmailDeliveryFailed = await runAuthEmailDelivery({
    deliveryService: input.authEmailDeliveryService,
    batchSize: input.authDeliveryBatchSize,
    cleanupBatchSize: input.authDeliveryCleanupBatchSize,
    staleSendingMs: input.authDeliveryStaleSendingMs,
    logger: input.logger,
    alertSender: input.alertSender,
  });

  return {
    deadlineRemindersFailed,
    documentStorageCleanupFailed,
    documentPublicationFailed,
    authEmailDeliveryFailed,
  };
}

export async function sendJobFailureAlert(input: {
  job: 'deadline-reminders' | 'document-storage-cleanup' | 'document-publication' | 'auth-email-delivery';
  code:
    | 'DEADLINE_REMINDERS_FAILED'
    | 'DOCUMENT_STORAGE_CLEANUP_FAILED'
    | 'DOCUMENT_STORAGE_DELETION_DEAD_LETTERED'
    | 'DOCUMENT_PUBLICATION_FAILED'
    | 'DOCUMENT_PUBLICATION_DEAD_LETTERED'
    | 'AUTH_EMAIL_DELIVERY_FAILED';
  error: unknown;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
  affectedCount?: number;
}): Promise<boolean> {
  const alertSender = input.alertSender ?? sendErrorAlert;
  const payload = buildOperationalErrorAlertPayload({
    job: input.job,
    code: input.code,
    error: input.error,
    affectedCount: input.affectedCount,
  });

  try {
    const delivered = await alertSender(payload);
    return delivered !== false;
  } catch (alertError) {
    logSchedulerError(input.logger, `[ProductionScheduler] Failed to send ${input.job} failure alert.`, alertError);
    return false;
  }
}

export type RecurringJobHandle = {
  stop(): Promise<void>;
};

export function startRecurringJob(input: {
  name: string;
  intervalMs: number;
  run: () => Promise<boolean>;
  logger: SchedulerLogger;
}): RecurringJobHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRun: Promise<void> | undefined;

  const runAndSchedule = () => {
    if (stopped) return;
    const currentRun = (async () => {
      try {
        const failed = await input.run();
        if (failed) {
          input.logger.error(`[ProductionScheduler] ${input.name} reported a failed run.`);
        }
      } catch (error) {
        logSchedulerError(input.logger, `[ProductionScheduler] ${input.name} threw outside its runner.`, error);
      }
    })();
    activeRun = currentRun;
    void currentRun.then(() => {
      if (activeRun === currentRun) activeRun = undefined;
      if (!stopped) {
        timer = setTimeout(runAndSchedule, input.intervalMs);
      }
    });
  };

  input.logger.info(`[ProductionScheduler] ${input.name} scheduled every ${input.intervalMs}ms.`);
  runAndSchedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await activeRun;
    },
  };
}

export async function waitForRecurringJobsToStop(
  handles: RecurringJobHandle[],
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const stopped = Promise.all(handles.map((handle) => handle.stop())).then(() => true as const);
  const result = await Promise.race([stopped, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function main(): Promise<void> {
  process.env.NODE_ENV ??= 'production';
  validateDeadlineRemindersEnv();
  validateDocumentStorageCleanupEnv();
  validateAuthDeliveryEnv();

  const config = productionSchedulerConfigFromEnv();
  const prisma = new PrismaClient();
  await requireAuthRecoveryControlForRuntime(prisma);
  const deadlineService = new DeadlineRemindersService(prisma);
  const documentService = new DocumentService(prisma);
  const publicationService = new DocumentPublicationService(prisma);
  const storageService = new StorageService(createPrismaOrganisationStorageResolver(prisma));
  const authEmailDeliveryService = new AuthEmailDeliveryService(prisma);
  const logger: SchedulerLogger = console;

  if (config.runOnce) {
    const result = await runProductionSchedulerOnce({
      deadlineService,
      documentService,
      publicationService,
      storageService,
      authEmailDeliveryService,
      prisma,
      documentStorageCleanupLimit: config.documentStorageCleanupLimit,
      documentPublicationLimit: config.documentPublicationLimit,
      authDeliveryBatchSize: config.authDeliveryBatchSize,
      authDeliveryCleanupBatchSize: config.authDeliveryCleanupBatchSize,
      authDeliveryStaleSendingMs: config.authDeliveryStaleSendingMs,
      logger,
    });
    await prisma.$disconnect();
    if (
      result.deadlineRemindersFailed ||
      result.documentStorageCleanupFailed ||
      result.documentPublicationFailed ||
      result.authEmailDeliveryFailed
    ) {
      process.exitCode = 1;
      return;
    }
    logger.info('Production scheduler run-once completed successfully.');
    return;
  }

  const deadlineRemindersJob = startRecurringJob({
    name: 'Deadline reminders',
    intervalMs: config.deadlineRemindersIntervalMs,
    logger,
    run: () => runDeadlineReminders({ deadlineService, logger }),
  });
  const documentStorageCleanupJob = startRecurringJob({
    name: 'Document storage cleanup',
    intervalMs: config.documentStorageCleanupIntervalMs,
    logger,
    run: () => runDocumentStorageCleanup({
      documentService,
      storageService,
      prisma,
      documentStorageCleanupLimit: config.documentStorageCleanupLimit,
      logger,
    }),
  });
  const documentPublicationJob = startRecurringJob({
    name: 'Document publication',
    intervalMs: config.documentPublicationIntervalMs,
    logger,
    run: () => runDocumentPublication({
      publicationService,
      storageService,
      prisma,
      documentPublicationLimit: config.documentPublicationLimit,
      logger,
    }),
  });
  const authEmailDeliveryJob = startRecurringJob({
    name: 'Authentication email delivery',
    intervalMs: config.authDeliveryIntervalMs,
    logger,
    run: () => runAuthEmailDelivery({
      deliveryService: authEmailDeliveryService,
      batchSize: config.authDeliveryBatchSize,
      cleanupBatchSize: config.authDeliveryCleanupBatchSize,
      staleSendingMs: config.authDeliveryStaleSendingMs,
      logger,
    }),
  });

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info(`[ProductionScheduler] Received ${signal}; shutting down.`);
    const stopped = await waitForRecurringJobsToStop(
      [deadlineRemindersJob, documentStorageCleanupJob, documentPublicationJob, authEmailDeliveryJob],
      config.shutdownTimeoutMs,
    );
    if (!stopped) {
      logger.error(
        '[ProductionScheduler] Graceful shutdown timed out with an active job; cutover preparation must quarantine any residual delivery state.',
      );
    }
    await prisma.$disconnect();
    process.exit(stopped ? 0 : 1);
  };

  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });
  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
