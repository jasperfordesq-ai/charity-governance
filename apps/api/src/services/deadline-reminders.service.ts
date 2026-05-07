import type { PrismaClient } from '@prisma/client';
import { EmailService } from './email.service.js';

export class DeadlineRemindersService {
  private emailService: EmailService;

  constructor(
    private prisma: PrismaClient,
    emailService?: EmailService,
  ) {
    this.emailService = emailService ?? new EmailService();
  }

  /**
   * Check all active (non-complete) deadlines and send reminder emails to org
   * owners when today falls exactly N days before the due date, where N is one
   * of the deadline's configured reminderDays.
   *
   * Intended to be called once per day by a scheduler (see utils/cron.ts).
   */
  async sendDueReminders(): Promise<void> {
    const today = new Date();
    // Normalise to midnight UTC so day-diff arithmetic is stable
    today.setUTCHours(0, 0, 0, 0);

    const activeDeadlines = await this.prisma.deadline.findMany({
      where: { isComplete: false },
      include: {
        organisation: {
          include: {
            users: {
              where: { role: 'OWNER' },
              take: 1,
            },
          },
        },
      },
    });

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const deadline of activeDeadlines) {
      const owner = deadline.organisation.users[0];
      if (!owner) {
        // No owner found for this org — skip silently
        skipped++;
        continue;
      }

      const dueDate = new Date(deadline.dueDate);
      dueDate.setUTCHours(0, 0, 0, 0);

      const msPerDay = 24 * 60 * 60 * 1000;
      const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / msPerDay);

      if (daysUntilDue < 0) {
        // Deadline already passed — skip
        skipped++;
        continue;
      }

      const shouldRemind = (deadline.reminderDays as number[]).includes(daysUntilDue);

      if (!shouldRemind) {
        skipped++;
        continue;
      }

      const existingLog = await this.prisma.deadlineReminderLog.findUnique({
        where: {
          deadlineId_email_reminderDays: {
            deadlineId: deadline.id,
            email: owner.email,
            reminderDays: daysUntilDue,
          },
        },
      });

      if (existingLog?.status === 'SENT') {
        skipped++;
        continue;
      }

      const delivered = await this.emailService.sendDeadlineReminder(owner.email, deadline.organisation.name, {
        title: deadline.title,
        dueDate: deadline.dueDate,
        daysUntilDue,
      });

      await this.prisma.deadlineReminderLog.upsert({
        where: {
          deadlineId_email_reminderDays: {
            deadlineId: deadline.id,
            email: owner.email,
            reminderDays: daysUntilDue,
          },
        },
        create: {
          organisationId: deadline.organisationId,
          deadlineId: deadline.id,
          userId: owner.id,
          email: owner.email,
          reminderDays: daysUntilDue,
          status: delivered ? 'SENT' : 'FAILED',
          error: delivered ? null : 'Email provider was not configured or rejected the message',
        },
        update: {
          userId: owner.id,
          status: delivered ? 'SENT' : 'FAILED',
          error: delivered ? null : 'Email provider was not configured or rejected the message',
          sentAt: new Date(),
        },
      });

      if (delivered) {
        sent++;
      } else {
        failed++;
      }
    }

    console.log(
      `[DeadlineReminders] Run complete - ${sent} reminder(s) sent, ${failed} failed, ${skipped} deadline(s) skipped`,
    );
  }
}
