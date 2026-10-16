import { createApplicationPrismaClient } from '../utils/application-prisma-client.js';
import type { PrismaClient } from '@prisma/client';
import { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import { validateDeadlineRemindersEnv } from '../utils/env.js';
import { logSchedulerError, sendJobFailureAlert } from './production-scheduler.js';

process.env.NODE_ENV ??= 'production';
validateDeadlineRemindersEnv();

let prisma: PrismaClient | undefined;
const logger = console;

try {
  prisma = await createApplicationPrismaClient();
  const service = new DeadlineRemindersService(prisma);
  await service.sendDueReminders();
  logger.info('Deadline reminders job completed successfully.');
} catch (error) {
  logSchedulerError(logger, 'Deadline reminders job failed:', error);
  await sendJobFailureAlert({
    job: 'deadline-reminders',
    code: 'DEADLINE_REMINDERS_FAILED',
    error,
    logger,
  });
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
