import { PrismaClient } from '@prisma/client';
import { DeadlineRemindersService } from '../services/deadline-reminders.service.js';
import { validateProductionEnv } from '../utils/env.js';

process.env.NODE_ENV ??= 'production';
validateProductionEnv();

const prisma = new PrismaClient();

try {
  const service = new DeadlineRemindersService(prisma);
  await service.sendDueReminders();
  console.log('Deadline reminders job completed successfully.');
} catch (error) {
  console.error('Deadline reminders job failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
