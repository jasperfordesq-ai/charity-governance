import type { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import { serializeErrorForLog } from './logger.js';

export function startCronJobs(deadlineService: DeadlineRemindersService): void {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_IN_PROCESS_JOBS !== 'true') {
    console.log('[CRON] In-process jobs disabled. Run deadline reminders through the dedicated job entrypoint.');
    return;
  }

  const INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await deadlineService.sendDueReminders();
    } catch (err) {
      console.error('[CRON] Deadline reminder failed:', serializeErrorForLog(err));
    }
  }, INTERVAL_MS);
  console.log('[CRON] Deadline reminder scheduler started (interval: 24h)');
}
