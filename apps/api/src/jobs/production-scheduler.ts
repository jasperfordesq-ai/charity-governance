import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import { DocumentService } from '../services/document.service.js';
import {
  buildOperationalErrorAlertPayload,
  sendErrorAlert,
  type ErrorAlertPayload,
} from '../services/error-alerts.service.js';
import { StorageService } from '../services/storage.service.js';
import { validateDeadlineRemindersEnv, validateDocumentStorageCleanupEnv } from '../utils/env.js';
import { serializeErrorForLog } from '../utils/logger.js';

const DEFAULT_DEADLINE_REMINDERS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_DOCUMENT_STORAGE_CLEANUP_LIMIT = 25;

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
    deleteFile: (organisationId: string, storagePath: string) => Promise<void>,
    limit: number,
  ): Promise<{ processed: number; failed: number }>;
};

type StorageDeletionRunner = {
  deleteFile(organisationId: string, storagePath: string): Promise<void>;
};

type AlertSender = (payload: ErrorAlertPayload) => Promise<void>;

export type ProductionSchedulerConfig = {
  deadlineRemindersIntervalMs: number;
  documentStorageCleanupIntervalMs: number;
  documentStorageCleanupLimit: number;
  runOnce: boolean;
};

export type ProductionSchedulerRunResult = {
  deadlineRemindersFailed: boolean;
  documentStorageCleanupFailed: boolean;
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
    runOnce: env.PRODUCTION_SCHEDULER_RUN_ONCE === 'true',
  };
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  documentStorageCleanupLimit: number;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
}): Promise<boolean> {
  try {
    const result = await input.documentService.retryPendingStorageDeletions(
      (organisationId, storagePath) => input.storageService.deleteFile(organisationId, storagePath),
      input.documentStorageCleanupLimit,
    );
    input.logger.info(
      `[ProductionScheduler] Document storage cleanup run completed. Processed: ${result.processed}. Failed: ${result.failed}.`,
    );
    if (result.failed > 0) {
      const cleanupFailure = new Error(`Document storage cleanup reported ${result.failed} failed deletion(s).`);
      cleanupFailure.name = 'DocumentStorageCleanupFailure';
      await sendJobFailureAlert({
        job: 'document-storage-cleanup',
        code: 'DOCUMENT_STORAGE_CLEANUP_FAILED',
        error: cleanupFailure,
        logger: input.logger,
        alertSender: input.alertSender,
      });
    }
    return result.failed > 0;
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

export async function runProductionSchedulerOnce(input: {
  deadlineService: DeadlineReminderRunner;
  documentService: DocumentStorageCleanupRunner;
  storageService: StorageDeletionRunner;
  documentStorageCleanupLimit: number;
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
    documentStorageCleanupLimit: input.documentStorageCleanupLimit,
    logger: input.logger,
    alertSender: input.alertSender,
  });

  return { deadlineRemindersFailed, documentStorageCleanupFailed };
}

export async function sendJobFailureAlert(input: {
  job: 'deadline-reminders' | 'document-storage-cleanup';
  code: 'DEADLINE_REMINDERS_FAILED' | 'DOCUMENT_STORAGE_CLEANUP_FAILED';
  error: unknown;
  logger: SchedulerLogger;
  alertSender?: AlertSender;
}): Promise<void> {
  const alertSender = input.alertSender ?? sendErrorAlert;
  const payload = buildOperationalErrorAlertPayload({
    job: input.job,
    code: input.code,
    error: input.error,
  });

  try {
    await alertSender(payload);
  } catch (alertError) {
    logSchedulerError(input.logger, `[ProductionScheduler] Failed to send ${input.job} failure alert.`, alertError);
  }
}

function startRecurringJob(input: {
  name: string;
  intervalMs: number;
  run: () => Promise<boolean>;
  logger: SchedulerLogger;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runAndSchedule = async () => {
    if (stopped) return;
    const failed = await input.run();
    if (failed) {
      input.logger.error(`[ProductionScheduler] ${input.name} reported a failed run.`);
    }
    if (!stopped) {
      timer = setTimeout(() => {
        void runAndSchedule();
      }, input.intervalMs);
    }
  };

  input.logger.info(`[ProductionScheduler] ${input.name} scheduled every ${input.intervalMs}ms.`);
  void runAndSchedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function main(): Promise<void> {
  process.env.NODE_ENV ??= 'production';
  validateDeadlineRemindersEnv();
  validateDocumentStorageCleanupEnv();

  const config = productionSchedulerConfigFromEnv();
  const prisma = new PrismaClient();
  const deadlineService = new DeadlineRemindersService(prisma);
  const documentService = new DocumentService(prisma);
  const storageService = new StorageService();
  const logger: SchedulerLogger = console;

  if (config.runOnce) {
    const result = await runProductionSchedulerOnce({
      deadlineService,
      documentService,
      storageService,
      documentStorageCleanupLimit: config.documentStorageCleanupLimit,
      logger,
    });
    await prisma.$disconnect();
    if (result.deadlineRemindersFailed || result.documentStorageCleanupFailed) {
      process.exitCode = 1;
      return;
    }
    console.log('Production scheduler run-once completed successfully.');
    return;
  }

  const stopDeadlineReminders = startRecurringJob({
    name: 'Deadline reminders',
    intervalMs: config.deadlineRemindersIntervalMs,
    logger,
    run: () => runDeadlineReminders({ deadlineService, logger }),
  });
  const stopDocumentStorageCleanup = startRecurringJob({
    name: 'Document storage cleanup',
    intervalMs: config.documentStorageCleanupIntervalMs,
    logger,
    run: () => runDocumentStorageCleanup({
      documentService,
      storageService,
      documentStorageCleanupLimit: config.documentStorageCleanupLimit,
      logger,
    }),
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`[ProductionScheduler] Received ${signal}; shutting down.`);
    stopDeadlineReminders();
    stopDocumentStorageCleanup();
    await prisma.$disconnect();
    process.exit(0);
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
