import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { EmailService, type DeadlineReminderDeliveryResult } from './email.service.js';
import { hasSubscriptionAccess, pastDueGraceCutoff } from '../utils/subscription-access.js';
import {
  addCalendarDays,
  differenceInCivilDays,
  todayInTimeZone,
} from '@charitypilot/shared';
import { civilDateFromPrisma, prismaDateFromCivil } from '../utils/civil-date.js';

const REMINDER_RESERVATION_STALE_MS = 15 * 60 * 1000;
const REMINDER_BATCH_SIZE = 100;

type ReminderLogger = {
  info(message: string): void;
};

const silentReminderLogger: ReminderLogger = {
  info: () => undefined,
};

function defaultReminderLogger(): ReminderLogger {
  return process.env.NODE_ENV === 'test' ? silentReminderLogger : console;
}

function reminderIdempotencyKey(input: {
  organisationId: string;
  deadlineId: string;
  email: string;
  reminderDays: number;
  scheduleVersion: number;
  reservationToken: string;
}): string {
  const digest = createHash('sha256')
    .update(
      `${input.organisationId}\0${input.deadlineId}\0${input.email}\0${input.reminderDays}\0${input.scheduleVersion}\0${input.reservationToken}`,
    )
    .digest('hex');
  return `deadline-reminder/${digest}`;
}

function normalizeDeliveryResult(
  result: DeadlineReminderDeliveryResult | boolean | unknown,
): DeadlineReminderDeliveryResult {
  // Only structured provider evidence can prove acceptance or definite
  // rejection. Bare booleans were the pre-P0-06 adapter contract and carry no
  // acceptance id or rejection classification, so they fail closed.
  if (result && typeof result === 'object' && 'outcome' in result) {
    const candidate = result as { outcome?: unknown; providerMessageId?: unknown };
    if (
      candidate.outcome === 'ACCEPTED' &&
      typeof candidate.providerMessageId === 'string' &&
      candidate.providerMessageId.trim() !== ''
    ) {
      return { outcome: 'ACCEPTED', providerMessageId: candidate.providerMessageId };
    }
    if (candidate.outcome === 'REJECTED') return { outcome: 'REJECTED' };
    if (candidate.outcome === 'UNCERTAIN') return { outcome: 'UNCERTAIN' };
  }
  return { outcome: 'UNCERTAIN' };
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
    deadlineScheduleVersion: number;
    deadlineTitle: string;
    deadlineDueDate: string;
    now: Date;
  }): Promise<{ id: string; reservationToken: string; providerIdempotencyKey: string } | null> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Match the organisation -> deadline lock order used by profile-driven
      // reconciliation so reminder claims cannot deadlock those updates.
      const organisation = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Organisation"
        WHERE "id" = ${input.organisationId}
        FOR KEY SHARE
      `;
      if (organisation.length !== 1) return null;

      const [recipient, subscription] = await Promise.all([
        tx.user.findFirst({
          where: {
            id: input.userId,
            organisationId: input.organisationId,
            email: input.email,
            role: 'OWNER',
            emailVerified: true,
          },
          select: { id: true },
        }),
        tx.subscription.findUnique({
          where: { organisationId: input.organisationId },
          select: { status: true, trialEndsAt: true, currentPeriodEnd: true },
        }),
      ]);
      if (!recipient || !hasReminderEntitlement(subscription, input.now)) return null;

      const occurrence = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Deadline"
        WHERE "id" = ${input.deadlineId}
          AND "organisationId" = ${input.organisationId}
          AND "isComplete" = false
          AND "supersededAt" IS NULL
          AND "archivedAt" IS NULL
          AND "scheduleVersion" = ${input.deadlineScheduleVersion}
          -- Bind the civil ISO string directly. Binding a JavaScript Date here
          -- lets PostgreSQL apply the session timezone before ::date, which can
          -- shift the intended calendar day in non-UTC sessions.
          AND "dueDate" = ${input.deadlineDueDate}::date
          AND ${input.reminderDays} = ANY("reminderDays")
        FOR UPDATE
      `;
      if (occurrence.length !== 1) return null;

      // Failed attempts are immutable history. A partial database unique index
      // permits only one active/terminal delivery claim for a window. Only a
      // definitely rejected FAILED attempt may be retried with a new attempt
      // token and provider idempotency key.
      const reservedAt = new Date();
      const activeLog = await tx.deadlineReminderLog.findFirst({
        where: {
          deadlineId: input.deadlineId,
          email: input.email,
          reminderDays: input.reminderDays,
          deadlineScheduleVersion: input.deadlineScheduleVersion,
          OR: [
            { status: { in: ['RESERVED', 'SENDING', 'SENT'] } },
            {
              status: 'UNCERTAIN',
              OR: [
                { reconciliationOutcome: null },
                { reconciliationOutcome: { in: ['ACCEPTED_CONFIRMED', 'UNKNOWN_ACKNOWLEDGED'] } },
              ],
            },
          ],
        },
        orderBy: [{ reservedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          status: true,
          reservationToken: true,
          reservedAt: true,
        },
      });

      if (activeLog && activeLog.status !== 'RESERVED') return null;
      if (activeLog) {
        const staleBefore = new Date(reservedAt.getTime() - REMINDER_RESERVATION_STALE_MS);
        if (activeLog.reservedAt >= staleBefore) return null;

        const expired = await tx.deadlineReminderLog.updateMany({
          where: {
            id: activeLog.id,
            status: 'RESERVED',
            reservationToken: activeLog.reservationToken,
            reservedAt: { lt: staleBefore },
          },
          data: {
            status: 'SKIPPED',
            error: 'Reminder reservation expired before delivery was finalized',
            attemptedAt: null,
            sentAt: null,
          },
        });
        if (expired.count !== 1) return null;
      }

      const reservationToken = randomUUID();
      const providerIdempotencyKey = reminderIdempotencyKey({
        organisationId: input.organisationId,
        deadlineId: input.deadlineId,
        email: input.email,
        reminderDays: input.reminderDays,
        scheduleVersion: input.deadlineScheduleVersion,
        reservationToken,
      });
      const created = await tx.deadlineReminderLog.create({
        data: {
          organisationId: input.organisationId,
          deadlineId: input.deadlineId,
          userId: input.userId,
          email: input.email,
          reminderDays: input.reminderDays,
          deadlineScheduleVersion: input.deadlineScheduleVersion,
          deadlineTitle: input.deadlineTitle,
          deadlineDueDate: prismaDateFromCivil(input.deadlineDueDate),
          deadlineSnapshotKnown: true,
          deliveryTimingKnown: true,
          legacyDeliveryStatus: null,
          status: 'RESERVED',
          error: null,
          reservationToken,
          providerIdempotencyKey,
          providerRequestStartedAt: null,
          providerMessageId: null,
          reservedAt,
          attemptedAt: null,
          sentAt: null,
        },
        select: { id: true },
      });
      return { id: created.id, reservationToken, providerIdempotencyKey };
    });
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
  async sendDueReminders(now = new Date()): Promise<void> {
    const today = todayInTimeZone('Europe/Dublin', now);
    const candidateEnd = addCalendarDays(today, 365);

    // Once provider I/O may have begun, a crash leaves the delivery outcome
    // unknowable. Quarantine these attempts globally, even when their deadline
    // is no longer in today's candidate window, and never resend them
    // automatically unless restricted reconciliation conclusively proves the
    // provider never accepted/created the original message. Operators can
    // reconcile modern rows using the recorded provider
    // idempotency key without exposing message payloads in the tenant API.
    const staleSendingBefore = new Date(now.getTime() - REMINDER_RESERVATION_STALE_MS);
    await this.prisma.deadlineReminderLog.updateMany({
      where: {
        status: 'SENDING',
        providerRequestStartedAt: { lt: staleSendingBefore },
      },
      data: {
        status: 'UNCERTAIN',
        error: 'Provider outcome is uncertain after worker interruption; automatic retry is blocked unless restricted reconciliation confirms provider non-acceptance',
        sentAt: null,
      },
    });

    let sent = 0;
    let failed = 0;
    // Existing terminal ambiguity remains an operational action item even when
    // it is merely suppressing a duplicate claim. Count it every run so legacy
    // cutover suppressors and prior ambiguous sends cannot become silent debt.
    let uncertain = await this.prisma.deadlineReminderLog.count({
      where: { status: 'UNCERTAIN', reconciliationOutcome: null },
    });
    let skipped = 0;

    let cursor: string | undefined;
    while (true) {
      const activeDeadlines = await this.prisma.deadline.findMany({
        where: {
          isComplete: false,
          supersededAt: null,
          archivedAt: null,
          dueDate: {
            gte: prismaDateFromCivil(today),
            lte: prismaDateFromCivil(candidateEnd),
          },
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
                orderBy: { id: 'asc' },
                select: { id: true, email: true, role: true, emailVerified: true },
              },
            },
          },
        },
        // The pagination key must be immutable. dueDate can be rescheduled
        // while a run is processing page 1; ordering/cursoring by id ensures a
        // moved boundary row cannot skip untouched rows on later pages.
        orderBy: { id: 'asc' },
        take: REMINDER_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      for (const deadline of activeDeadlines) {
      const owners = deadline.organisation.users.filter(
        (candidate) => candidate.role === 'OWNER' && candidate.emailVerified,
      );
      if (owners.length === 0) {
        skipped++;
        continue;
      }

      if (!hasReminderEntitlement(deadline.organisation.subscription, now)) {
        skipped++;
        continue;
      }

      const dueDate = civilDateFromPrisma(deadline.dueDate);
      const daysUntilDue = differenceInCivilDays(dueDate, today);

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

      for (const owner of owners) {
      const reservation = await this.reserveReminderLog({
        organisationId: deadline.organisationId,
        deadlineId: deadline.id,
        userId: owner.id,
        email: owner.email,
        reminderDays: applicableWindow,
        deadlineScheduleVersion: deadline.scheduleVersion,
        deadlineTitle: deadline.title,
        deadlineDueDate: dueDate,
        now,
      });

      if (!reservation) {
        skipped++;
        continue;
      }

      const [currentOccurrence, currentRecipient, currentSubscription, currentOrganisation] =
        await Promise.all([
          this.prisma.deadline.findFirst({
            where: {
              id: deadline.id,
              organisationId: deadline.organisationId,
              isComplete: false,
              supersededAt: null,
              archivedAt: null,
              scheduleVersion: deadline.scheduleVersion,
              dueDate: prismaDateFromCivil(dueDate),
              reminderDays: { has: applicableWindow },
            },
            select: { id: true },
          }),
          this.prisma.user.findFirst({
            where: {
              id: owner.id,
              organisationId: deadline.organisationId,
              email: owner.email,
              role: 'OWNER',
              emailVerified: true,
            },
            select: { id: true },
          }),
          this.prisma.subscription.findUnique({
            where: { organisationId: deadline.organisationId },
            select: { status: true, trialEndsAt: true, currentPeriodEnd: true },
          }),
          this.prisma.organisation.findUnique({
            where: { id: deadline.organisationId },
            select: { name: true },
          }),
        ]);
      if (
        !currentOccurrence ||
        !currentRecipient ||
        !currentOrganisation ||
        !hasReminderEntitlement(currentSubscription, now)
      ) {
        await this.prisma.deadlineReminderLog.updateMany({
          where: {
            id: reservation.id,
            status: 'RESERVED',
            reservationToken: reservation.reservationToken,
          },
          data: {
            status: 'SKIPPED',
            error: 'Deadline, recipient or subscription changed before reminder delivery',
            attemptedAt: null,
            sentAt: null,
          },
        });
        skipped++;
        continue;
      }

      const providerRequestStartedAt = new Date();
      const started = await this.prisma.deadlineReminderLog.updateMany({
        where: {
          id: reservation.id,
          status: 'RESERVED',
          reservationToken: reservation.reservationToken,
        },
        data: {
          status: 'SENDING',
          attemptedAt: providerRequestStartedAt,
          providerRequestStartedAt,
          error: null,
          sentAt: null,
        },
      });
      if (started.count !== 1) {
        skipped++;
        continue;
      }

      let deliveryResult: DeadlineReminderDeliveryResult = { outcome: 'UNCERTAIN' };
      try {
        deliveryResult = normalizeDeliveryResult(
          await this.emailService.sendDeadlineReminder(
            owner.email,
            currentOrganisation.name,
            {
              title: deadline.title,
              dueDate: prismaDateFromCivil(dueDate),
              daysUntilDue,
            },
            { idempotencyKey: reservation.providerIdempotencyKey },
          ),
        );
      } catch {
        // A thrown transport/provider outcome may have reached the provider.
        // Quarantine it unless restricted reconciliation can later prove the
        // provider did not accept/create the original message.
        deliveryResult = { outcome: 'UNCERTAIN' };
      }

      const accepted = deliveryResult.outcome === 'ACCEPTED';
      const rejected = deliveryResult.outcome === 'REJECTED';

      const finalized = await this.prisma.deadlineReminderLog.updateMany({
        where: {
          id: reservation.id,
          status: { in: ['SENDING', 'UNCERTAIN'] },
          reservationToken: reservation.reservationToken,
          reconciliationOutcome: null,
        },
        data: {
          status: accepted ? 'SENT' : rejected ? 'FAILED' : 'UNCERTAIN',
          error: accepted
            ? null
            : rejected
              ? 'Email provider was not configured or definitely rejected the message'
              : 'Email provider outcome is uncertain; automatic retry is blocked unless restricted reconciliation confirms provider non-acceptance',
          providerMessageId:
            deliveryResult.outcome === 'ACCEPTED' ? deliveryResult.providerMessageId : null,
          sentAt: accepted ? new Date() : null,
        },
      });

      if (finalized.count !== 1) {
        // The reservation token/state no longer belongs to this worker. Never
        // overwrite a separately reconciled terminal result.
        skipped++;
        continue;
      }

      if (accepted) {
        sent++;
      } else if (rejected) {
        failed++;
      } else {
        uncertain++;
      }
      }
      }

      if (activeDeadlines.length < REMINDER_BATCH_SIZE) break;
      cursor = activeDeadlines.at(-1)?.id;
      if (!cursor) break;
    }

    this.logger.info(
      `[DeadlineReminders] Run complete - ${sent} reminder(s) provider-accepted, ${failed} failed, ${uncertain} uncertain, ${skipped} deadline(s) skipped`,
    );

    if (failed > 0 || uncertain > 0) {
      const deliveryFailure = new Error(
        `Deadline reminder delivery requires attention: ${failed} failed, ${uncertain} uncertain.`,
      );
      deliveryFailure.name = 'DeadlineReminderDeliveryFailure';
      throw deliveryFailure;
    }
  }
}
