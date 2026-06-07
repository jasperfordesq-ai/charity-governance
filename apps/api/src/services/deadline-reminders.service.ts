import type { PrismaClient } from '@prisma/client';
import { EmailService } from './email.service.js';
import { hasSubscriptionAccess, pastDueGraceCutoff } from '../utils/subscription-access.js';

const REMINDER_RESERVATION_ERROR = 'Reserved before delivery';
const REMINDER_RESERVATION_STALE_MS = 15 * 60 * 1000;

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002');
}

function hasReminderEntitlement(
  subscription: { status: string; trialEndsAt: Date | null; currentPeriodEnd?: Date | null } | null | undefined,
  now: Date,
): boolean {
  return hasSubscriptionAccess(subscription, now);
}

export class DeadlineRemindersService {
  private emailService: EmailService;

  constructor(
    private prisma: PrismaClient,
    emailService?: EmailService,
  ) {
    this.emailService = emailService ?? new EmailService();
  }

  private async reserveReminderLog(input: {
    organisationId: string;
    deadlineId: string;
    userId: string;
    email: string;
    reminderDays: number;
  }): Promise<{ id: string } | null> {
    const reservedAt = new Date();
    try {
      return await this.prisma.deadlineReminderLog.create({
        data: {
          organisationId: input.organisationId,
          deadlineId: input.deadlineId,
          userId: input.userId,
          email: input.email,
          reminderDays: input.reminderDays,
          status: 'SKIPPED',
          error: REMINDER_RESERVATION_ERROR,
          sentAt: reservedAt,
        },
        select: { id: true },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existingLog = await this.prisma.deadlineReminderLog.findUnique({
        where: {
          deadlineId_email_reminderDays: {
            deadlineId: input.deadlineId,
            email: input.email,
            reminderDays: input.reminderDays,
          },
        },
        select: { id: true, status: true, error: true, sentAt: true },
      });

      if (!existingLog || existingLog.status === 'SENT') {
        return null;
      }

      const staleBefore = new Date(reservedAt.getTime() - REMINDER_RESERVATION_STALE_MS);
      const canReclaim =
        existingLog.status === 'FAILED' ||
        (
          existingLog.status === 'SKIPPED' &&
          existingLog.error === REMINDER_RESERVATION_ERROR &&
          existingLog.sentAt < staleBefore
        );

      if (!canReclaim) {
        return null;
      }

      const reclaimed = await this.prisma.deadlineReminderLog.updateMany({
        where: {
          id: existingLog.id,
          OR: [
            { status: 'FAILED' },
            {
              status: 'SKIPPED',
              error: REMINDER_RESERVATION_ERROR,
              sentAt: { lt: staleBefore },
            },
          ],
        },
        data: {
          userId: input.userId,
          status: 'SKIPPED',
          error: REMINDER_RESERVATION_ERROR,
          sentAt: reservedAt,
        },
      });

      if (reclaimed.count !== 1) {
        return null;
      }

      return { id: existingLog.id };
    }
  }

  /**
   * Check all active (non-complete) deadlines and send reminder emails to org
   * owners when today falls exactly N days before the due date, where N is one
   * of the deadline's configured reminderDays.
   *
   * Intended to be called once per day by a scheduler (see utils/cron.ts).
   */
  async sendDueReminders(): Promise<void> {
    const now = new Date();
    const today = new Date();
    // Normalise to midnight UTC so day-diff arithmetic is stable
    today.setUTCHours(0, 0, 0, 0);

    const activeDeadlines = await this.prisma.deadline.findMany({
      where: {
        isComplete: false,
        organisation: {
          subscription: {
            is: {
              OR: [
                { status: 'ACTIVE' },
                { status: 'PAST_DUE', currentPeriodEnd: { gt: pastDueGraceCutoff(now) } },
                { status: 'TRIALING', OR: [{ trialEndsAt: null }, { trialEndsAt: { gt: now } }] },
              ],
            },
          },
        },
      },
      include: {
        organisation: {
          include: {
            subscription: true,
            users: {
              where: { role: 'OWNER', emailVerified: true },
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
      if (!owner || !owner.emailVerified) {
        // No owner found for this org — skip silently
        skipped++;
        continue;
      }

      if (!hasReminderEntitlement(deadline.organisation.subscription, now)) {
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

      const reservation = await this.reserveReminderLog({
        organisationId: deadline.organisationId,
        deadlineId: deadline.id,
        userId: owner.id,
        email: owner.email,
        reminderDays: daysUntilDue,
      });

      if (!reservation) {
        skipped++;
        continue;
      }

      const delivered = await this.emailService.sendDeadlineReminder(owner.email, deadline.organisation.name, {
        title: deadline.title,
        dueDate: deadline.dueDate,
        daysUntilDue,
      });

      await this.prisma.deadlineReminderLog.update({
        where: { id: reservation.id },
        data: {
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
