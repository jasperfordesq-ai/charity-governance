import type { DeadlineRemindersService } from '../services/deadline-reminders.service.js';

// Simple setInterval-based scheduler for deadline reminders
// In production, use a proper job queue (BullMQ, pg-boss, etc.)
export function startCronJobs(deadlineService: DeadlineRemindersService): void {
  // Run every 24 hours
  const INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await deadlineService.sendDueReminders();
    } catch (err) {
      console.error('[CRON] Deadline reminder failed:', err);
    }
  }, INTERVAL_MS);
  console.log('[CRON] Deadline reminder scheduler started (interval: 24h)');
}
