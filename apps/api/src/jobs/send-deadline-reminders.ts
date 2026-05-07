import { PrismaClient } from '@prisma/client';
import { DeadlineRemindersService } from '../services/deadline-reminders.service.js';

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
