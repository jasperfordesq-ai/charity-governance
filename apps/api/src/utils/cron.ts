import type { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import { serializeErrorForLog } from './logger.js';

type CronLogger = {
  info(message: string): void;
  error(message: string, error?: unknown): void;
};

export function startCronJobs(deadlineService: DeadlineRemindersService, logger: CronLogger = console): void {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_IN_PROCESS_JOBS !== 'true') {
    logger.info('[CRON] In-process jobs disabled. Run deadline reminders through the dedicated job entrypoint.');
    return;
  }

  const INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await deadlineService.sendDueReminders();
    } catch (err) {
      logger.error('[CRON] Deadline reminder failed:', serializeErrorForLog(err));
    }
  }, INTERVAL_MS);
  logger.info('[CRON] Deadline reminder scheduler started (interval: 24h)');
}
