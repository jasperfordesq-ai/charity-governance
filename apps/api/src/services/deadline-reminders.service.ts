import type { PrismaClient } from '@prisma/client';
import { EmailService } from './email.service.js';
import { hasSubscriptionAccess, pastDueGraceCutoff } from '../utils/subscription-access.js';

const REMINDER_RESERVATION_ERROR = 'Reserved before delivery';
const REMINDER_RESERVATION_STALE_MS = 15 * 60 * 1000;

type ReminderLogger = {
  info(message: string): void;
};

const silentReminderLogger: ReminderLogger = {
  info: () => undefined,
};

function defaultReminderLogger(): ReminderLogger {
  return process.env.NODE_ENV === 'test' ? silentReminderLogger : console;
}

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
    private logger: ReminderLogger = defaultReminderLogger(),
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
   * owners when the due date is within one of the deadline's configured
   * reminderDays windows. Each configured window fires at most once (deduped via
   * DeadlineReminderLog keyed on the window). Matching uses "days remaining <=
   * window" against the most urgent reached window rather than exact equality,
   * so a missed or delayed daily run (deploy, crash, restart, interval drift)
   * still sends the most urgent not-yet-sent reminder on the next run instead of
   * silently skipping it forever.
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

      // The applicable window is the most urgent (smallest) configured window
      // whose threshold has been reached (daysUntilDue <= window). Matching with
      // "<=" rather than exact equality makes reminders resilient to a missed or
      // delayed daily run: if the exact trigger day was skipped, the next run
      // still sends the most urgent not-yet-sent window, and the per-window dedup
      // log (keyed on the window, not the live day count) stops a stale earlier
      // window from firing once a more urgent one has been sent.
      const applicableWindow = (deadline.reminderDays as number[])
        .filter((windowDays) => daysUntilDue <= windowDays)
        .sort((a, b) => a - b)[0];

      if (applicableWindow === undefined) {
        // Too early — no configured reminder window has been reached yet.
        skipped++;
        continue;
      }

      const reservation = await this.reserveReminderLog({
        organisationId: deadline.organisationId,
        deadlineId: deadline.id,
        userId: owner.id,
        email: owner.email,
        reminderDays: applicableWindow,
      });

      if (!reservation) {
        skipped++;
        continue;
      }

      let delivered = false;
      try {
        delivered = await this.emailService.sendDeadlineReminder(owner.email, deadline.organisation.name, {
          title: deadline.title,
          dueDate: deadline.dueDate,
          daysUntilDue,
        });
      } catch {
        // EmailService normally resolves false for provider failures. Keep the
        // reservation retryable even if an unexpected implementation throws.
        delivered = false;
      }

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

    this.logger.info(
      `[DeadlineReminders] Run complete - ${sent} reminder(s) sent, ${failed} failed, ${skipped} deadline(s) skipped`,
    );

    if (failed > 0) {
      const deliveryFailure = new Error(`Deadline reminder delivery failed for ${failed} reminder(s).`);
      deliveryFailure.name = 'DeadlineReminderDeliveryFailure';
      throw deliveryFailure;
    }
  }
}
