import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  productionSchedulerConfigFromEnv,
  runDeadlineReminders,
  runDocumentStorageCleanup,
  runProductionSchedulerOnce,
  startRecurringJob,
  waitForRecurringJobsToStop,
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
    PRODUCTION_SCHEDULER_SHUTDOWN_TIMEOUT_MS: '15000',
    PRODUCTION_SCHEDULER_RUN_ONCE: 'true',
  });

  assert.deepEqual(config, {
    deadlineRemindersIntervalMs: 120000,
    documentStorageCleanupIntervalMs: 60000,
    documentStorageCleanupLimit: 7,
    shutdownTimeoutMs: 15000,
    runOnce: true,
  });
});

test('productionSchedulerConfigFromEnv falls back to safe defaults for invalid numeric values', () => {
  const config = productionSchedulerConfigFromEnv({
    DEADLINE_REMINDERS_INTERVAL_MS: '0',
    DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS: '-1',
    DOCUMENT_STORAGE_CLEANUP_LIMIT: 'not-a-number',
    PRODUCTION_SCHEDULER_SHUTDOWN_TIMEOUT_MS: '60000',
  });

  assert.deepEqual(config, {
    deadlineRemindersIntervalMs: 24 * 60 * 60 * 1000,
    documentStorageCleanupIntervalMs: 60 * 60 * 1000,
    documentStorageCleanupLimit: 25,
    shutdownTimeoutMs: 45 * 1000,
    runOnce: false,
  });
});

test('recurring job stop waits for an in-flight provider run and prevents rescheduling', async () => {
  let finishRun: (() => void) | undefined;
  let runs = 0;
  const handle = startRecurringJob({
    name: 'in-flight reminder test',
    intervalMs: 5,
    logger: { info() {}, error() {} },
    run: async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return false;
    },
  });

  let stopped = false;
  const stopping = handle.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false, 'shutdown must await the active reminder run');
  finishRun?.();
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(stopped, true);
  assert.equal(runs, 1, 'a stopped job must not schedule another run');
});

test('bounded scheduler shutdown reports an active run that exceeds the grace window', async () => {
  let finishRun: (() => void) | undefined;
  const handle = startRecurringJob({
    name: 'timeout reminder test',
    intervalMs: 1000,
    logger: { info() {}, error() {} },
    run: async () => {
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return false;
    },
  });

  assert.equal(await waitForRecurringJobsToStop([handle], 5), false);
  finishRun?.();
  await handle.stop();
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

test('runDocumentStorageCleanup sends one actionable alert and acknowledges claimed dead letters', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  const alerts: ErrorAlertPayload[] = [];
  const acknowledgements: unknown[] = [];
  const failed = await runDocumentStorageCleanup({
    documentService: {
      async retryPendingStorageDeletions() {
        return {
          processed: 3,
          failed: 1,
          retryScheduled: 0,
          newlyDeadLettered: 1,
          deadLetterAlert: { claimToken: 'alert-claim-1', ids: ['deletion-1'] },
        };
      },
      async markDeadLetterAlertSent(claim) { acknowledgements.push(claim); return 1; },
      async releaseDeadLetterAlertClaim() { assert.fail('successful alert must not release its claim'); },
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
  assert.equal(alerts[0].code, 'DOCUMENT_STORAGE_DELETION_DEAD_LETTERED');
  assert.equal(alerts[0].errorName, 'DocumentStorageDeletionDeadLettered');
  assert.equal(alerts[0].affectedCount, 1);
  assert.equal(alerts[0].action, 'REVIEW_DOCUMENT_STORAGE_DEAD_LETTERS');
  assert.deepEqual(acknowledgements, [{ claimToken: 'alert-claim-1', ids: ['deletion-1'] }]);
});

test('transient document storage retries do not alert or fail the scheduler run', async () => {
  const alerts: ErrorAlertPayload[] = [];
  const failed = await runDocumentStorageCleanup({
    documentService: {
      async retryPendingStorageDeletions() {
        return {
          processed: 0,
          failed: 1,
          retryScheduled: 1,
          newlyDeadLettered: 0,
          deadLetterAlert: null,
        };
      },
    },
    storageService: { async deleteFile() {} },
    documentStorageCleanupLimit: 7,
    logger: { info() {}, error() {} },
    alertSender: async (payload) => { alerts.push(payload); },
  });
  assert.equal(failed, false);
  assert.deepEqual(alerts, []);
});

test('failed dead-letter alert delivery releases the claim for a later scheduler run', async () => {
  const released: unknown[] = [];
  const failed = await runDocumentStorageCleanup({
    documentService: {
      async retryPendingStorageDeletions() {
        return {
          processed: 0,
          failed: 0,
          retryScheduled: 0,
          newlyDeadLettered: 0,
          deadLetterAlert: { claimToken: 'alert-claim-2', ids: ['deletion-2'] },
        };
      },
      async markDeadLetterAlertSent() { assert.fail('failed alert must not be acknowledged'); },
      async releaseDeadLetterAlertClaim(claim) { released.push(claim); return 1; },
    },
    storageService: { async deleteFile() {} },
    documentStorageCleanupLimit: 7,
    logger: { info() {}, error() {} },
    alertSender: async () => { throw new Error('alert transport unavailable'); },
  });
  assert.equal(failed, true);
  assert.deepEqual(released, [{ claimToken: 'alert-claim-2', ids: ['deletion-2'] }]);
});
