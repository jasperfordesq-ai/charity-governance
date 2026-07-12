import type { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import type { AuthEmailDeliveryService } from '../services/auth-email-delivery.service.js';
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

const LOCAL_AUTH_DELIVERY_INTERVAL_MS = 5 * 1000;

export async function runLocalAuthDeliveryOnce(
  authDeliveryService: Pick<AuthEmailDeliveryService, 'processDueDeliveries'>,
  logger: CronLogger = console,
): Promise<void> {
  try {
    const result = await authDeliveryService.processDueDeliveries({
      limit: 25,
      cleanupLimit: 500,
      staleSendingMs: 60 * 1000,
    });
    if (
      result.processed > 0 ||
      result.staleQuarantined > 0 ||
      result.keyUnavailable > 0
    ) {
      logger.info(
        `[CRON] Local authentication delivery processed ${result.processed} item(s); ` +
        `${result.staleQuarantined} stale and ${result.keyUnavailable} key-unavailable item(s) require review.`,
      );
    }
  } catch (err) {
    logger.error('[CRON] Local authentication delivery failed:', serializeErrorForLog(err));
  }
}

export function startLocalAuthDeliveryCron(
  authDeliveryService: Pick<AuthEmailDeliveryService, 'processDueDeliveries'>,
  logger: CronLogger = console,
): NodeJS.Timeout {
  void runLocalAuthDeliveryOnce(authDeliveryService, logger);
  const timer = setInterval(
    () => void runLocalAuthDeliveryOnce(authDeliveryService, logger),
    LOCAL_AUTH_DELIVERY_INTERVAL_MS,
  );
  logger.info('[CRON] Local authentication delivery scheduler started (interval: 5s)');
  return timer;
}
