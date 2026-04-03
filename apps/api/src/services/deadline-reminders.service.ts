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

      await this.emailService.sendDeadlineReminder(owner.email, deadline.organisation.name, {
        title: deadline.title,
        dueDate: deadline.dueDate,
        daysUntilDue,
      });

      sent++;
    }

    console.log(
      `[DeadlineReminders] Run complete — ${sent} reminder(s) sent, ${skipped} deadline(s) skipped`,
    );
  }
}
