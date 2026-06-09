import { PrismaClient } from '@prisma/client';
import { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import { validateDeadlineRemindersEnv } from '../utils/env.js';
import { logSchedulerError, sendJobFailureAlert } from './production-scheduler.js';

process.env.NODE_ENV ??= 'production';
validateDeadlineRemindersEnv();

const prisma = new PrismaClient();

try {
  const service = new DeadlineRemindersService(prisma);
  await service.sendDueReminders();
  console.log('Deadline reminders job completed successfully.');
} catch (error) {
  logSchedulerError(console, 'Deadline reminders job failed:', error);
  await sendJobFailureAlert({
    job: 'deadline-reminders',
    code: 'DEADLINE_REMINDERS_FAILED',
    error,
    logger: console,
  });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
