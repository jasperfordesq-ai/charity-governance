import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  productionSchedulerConfigFromEnv,
  runDeadlineReminders,
  runDocumentStorageCleanup,
  runProductionSchedulerOnce,
} from '../jobs/production-scheduler.js';
import type { ErrorAlertPayload } from '../services/error-alerts.service.js';

const ORIGINAL_ENV = { ...process.env };
const API_SRC = join(process.cwd(), 'src');

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

test('productionSchedulerConfigFromEnv resolves scheduler intervals and cleanup limit', () => {
  const config = productionSchedulerConfigFromEnv({
    DEADLINE_REMINDERS_INTERVAL_MS: '120000',
    DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS: '60000',
    DOCUMENT_STORAGE_CLEANUP_LIMIT: '7',
    PRODUCTION_SCHEDULER_RUN_ONCE: 'true',
  });

  assert.deepEqual(config, {
    deadlineRemindersIntervalMs: 120000,
    documentStorageCleanupIntervalMs: 60000,
    documentStorageCleanupLimit: 7,
    runOnce: true,
  });
});

test('productionSchedulerConfigFromEnv falls back to safe defaults for invalid numeric values', () => {
  const config = productionSchedulerConfigFromEnv({
    DEADLINE_REMINDERS_INTERVAL_MS: '0',
    DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS: '-1',
    DOCUMENT_STORAGE_CLEANUP_LIMIT: 'not-a-number',
  });

  assert.deepEqual(config, {
    deadlineRemindersIntervalMs: 24 * 60 * 60 * 1000,
    documentStorageCleanupIntervalMs: 60 * 60 * 1000,
    documentStorageCleanupLimit: 25,
    runOnce: false,
  });
});

test('production job entrypoints use the scheduler logger contract instead of direct console.log', () => {
  const jobFiles = [
    'jobs/send-deadline-reminders.ts',
    'jobs/cleanup-document-storage.ts',
    'jobs/production-scheduler.ts',
  ];

  for (const file of jobFiles) {
    const source = readFileSync(join(API_SRC, file), 'utf8');
    assert.doesNotMatch(source, /console\.log\(/, `${file} should route production messages through logger.info`);
  }
});

test('production reminder runtime avoids direct console.log calls', () => {
  const runtimeFiles = [
    'jobs/send-deadline-reminders.ts',
    'jobs/cleanup-document-storage.ts',
    'jobs/production-scheduler.ts',
    'services/deadline-reminders.service.ts',
    'utils/cron.ts',
  ];

  for (const file of runtimeFiles) {
    const source = readFileSync(join(API_SRC, file), 'utf8');
    assert.doesNotMatch(source, /console\.log\(/, `${file} should use a logger contract or operator CLI logging`);
  }
});

test('production notification services use logger contracts instead of direct console calls', () => {
  const notificationFiles = ['services/email.service.ts'];

  for (const file of notificationFiles) {
    const source = readFileSync(join(API_SRC, file), 'utf8');
    assert.doesNotMatch(
      source,
      /console\.(?:log|warn|error)\(/,
      `${file} should route operational logging through an injectable logger contract`,
    );
  }
});

test('runProductionSchedulerOnce runs reminders and document cleanup without overlapping API startup', async () => {
  const events: string[] = [];
  const deleted: Array<{ organisationId: string; storagePath: string }> = [];
  const deadlineService = {
    async sendDueReminders() {
      events.push('deadline-reminders');
    },
  };
  const storageService = {
    async deleteFile(organisationId: string, storagePath: string) {
      deleted.push({ organisationId, storagePath });
    },
  };
  const documentService = {
    async retryPendingStorageDeletions(
      deleteFile: (organisationId: string, storagePath: string) => Promise<void>,
      limit: number,
    ) {
      events.push(`document-cleanup:${limit}`);
      await deleteFile('org-1', 'org-1/policy.pdf');
      return { processed: 1, failed: 0 };
    },
  };
  const logs: string[] = [];

  const result = await runProductionSchedulerOnce({
    deadlineService,
    documentService,
    storageService,
    documentStorageCleanupLimit: 7,
    logger: {
      info(message: string) {
        logs.push(message);
      },
      error(message: string) {
        logs.push(message);
      },
    },
  });

  assert.deepEqual(events, ['deadline-reminders', 'document-cleanup:7']);
  assert.deepEqual(deleted, [{ organisationId: 'org-1', storagePath: 'org-1/policy.pdf' }]);
  assert.deepEqual(result, {
    deadlineRemindersFailed: false,
    documentStorageCleanupFailed: false,
  });
  assert.ok(logs.some((message) => message.includes('Deadline reminders run completed')));
  assert.ok(logs.some((message) => message.includes('Document storage cleanup run completed')));
});

test('runDeadlineReminders sends a sanitized operational alert when the production reminder run fails', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  const alerts: ErrorAlertPayload[] = [];
  const logs: Array<{ message: string; error?: unknown }> = [];
  const failed = await runDeadlineReminders({
    deadlineService: {
      async sendDueReminders() {
        throw new Error('SMTP provider failed token=raw-token user@example.org org-1/private-policy.pdf');
      },
    },
    logger: {
      info(message: string) {
        logs.push({ message });
      },
      error(message: string, error?: unknown) {
        logs.push({ message, error });
      },
    },
    alertSender: async (payload) => {
      alerts.push(payload);
    },
  });

  assert.equal(failed, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].service, 'charitypilot-api');
  assert.equal(alerts[0].method, 'JOB');
  assert.equal(alerts[0].url, '/jobs/deadline-reminders');
  assert.equal(alerts[0].statusCode, 500);
  assert.equal(alerts[0].code, 'DEADLINE_REMINDERS_FAILED');
  assert.equal(alerts[0].errorName, 'Error');
  assert.equal(typeof alerts[0].requestId, 'string');
  assert.equal(typeof alerts[0].timestamp, 'string');
  assert.equal(JSON.stringify(alerts[0]).includes('raw-token'), false);
  const failureLog = logs.find((entry) => entry.message.includes('Deadline reminders run failed'));
  assert.ok(failureLog);
  assert.equal(failureLog.error instanceof Error, false);
  const serializedLog = JSON.stringify(failureLog);
  assert.equal(serializedLog.includes('raw-token'), false);
  assert.equal(serializedLog.includes('user@example.org'), false);
  assert.equal(serializedLog.includes('org-1/private-policy.pdf'), false);
  assert.equal(serializedLog.includes('token=[redacted]'), true);
});

test('runDocumentStorageCleanup sends a sanitized operational alert when storage cleanup fails', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  const alerts: ErrorAlertPayload[] = [];
  const logs: Array<{ message: string; error?: unknown }> = [];
  const failed = await runDocumentStorageCleanup({
    documentService: {
      async retryPendingStorageDeletions() {
        throw new Error('Supabase failed token=raw-token user@example.org org-1/private-policy.pdf');
      },
    },
    storageService: {
      async deleteFile() {
        throw new Error('not reached');
      },
    },
    documentStorageCleanupLimit: 7,
    logger: {
      info() {},
      error(message: string, error?: unknown) {
        logs.push({ message, error });
      },
    },
    alertSender: async (payload) => {
      alerts.push(payload);
    },
  });

  assert.equal(failed, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].service, 'charitypilot-api');
  assert.equal(alerts[0].method, 'JOB');
  assert.equal(alerts[0].url, '/jobs/document-storage-cleanup');
  assert.equal(alerts[0].statusCode, 500);
  assert.equal(alerts[0].code, 'DOCUMENT_STORAGE_CLEANUP_FAILED');
  assert.equal(alerts[0].errorName, 'Error');
  assert.equal(JSON.stringify(alerts[0]).includes('raw-token'), false);
  const failureLog = logs.find((entry) => entry.message.includes('Document storage cleanup run failed'));
  assert.ok(failureLog);
  assert.equal(failureLog.error instanceof Error, false);
  const serializedLog = JSON.stringify(failureLog);
  assert.equal(serializedLog.includes('raw-token'), false);
  assert.equal(serializedLog.includes('user@example.org'), false);
  assert.equal(serializedLog.includes('org-1/private-policy.pdf'), false);
  assert.equal(serializedLog.includes('token=[redacted]'), true);
});

test('runDocumentStorageCleanup alerts when cleanup records failed storage deletions without throwing', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  const alerts: ErrorAlertPayload[] = [];
  const failed = await runDocumentStorageCleanup({
    documentService: {
      async retryPendingStorageDeletions() {
        return { processed: 3, failed: 1 };
      },
    },
    storageService: {
      async deleteFile() {},
    },
    documentStorageCleanupLimit: 7,
    logger: {
      info() {},
      error() {},
    },
    alertSender: async (payload) => {
      alerts.push(payload);
    },
  });

  assert.equal(failed, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].url, '/jobs/document-storage-cleanup');
  assert.equal(alerts[0].code, 'DOCUMENT_STORAGE_CLEANUP_FAILED');
  assert.equal(alerts[0].errorName, 'DocumentStorageCleanupFailure');
});
