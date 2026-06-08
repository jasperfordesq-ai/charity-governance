import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  productionSchedulerConfigFromEnv,
  runProductionSchedulerOnce,
} from '../jobs/production-scheduler.js';

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
