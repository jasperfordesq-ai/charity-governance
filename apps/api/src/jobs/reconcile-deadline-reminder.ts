import {
  PrismaClient,
  type DeadlineReminderReconciliationOutcome,
  type Prisma,
} from '@prisma/client';
import { pathToFileURL } from 'node:url';

const OUTCOMES = new Set<DeadlineReminderReconciliationOutcome>([
  'ACCEPTED_CONFIRMED',
  'NOT_ACCEPTED_CONFIRMED',
  'UNKNOWN_ACKNOWLEDGED',
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export type ReminderReconciliationCommand =
  | { mode: 'list' }
  | { mode: 'assert-clear' }
  | { mode: 'prepare-cutover'; schedulersQuiesced: true }
  | {
      mode: 'reconcile';
      id: string;
      outcome: DeadlineReminderReconciliationOutcome;
      operator: string;
      reference: string;
      schedulersQuiesced: true;
    };

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function boundedEvidence(value: string | undefined, name: string, maximum: number): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`);
  if (CONTROL_CHARACTERS.test(normalized)) throw new Error(`${name} must not contain control characters`);
  return normalized;
}

export function parseReminderReconciliationArgs(args: string[]): ReminderReconciliationCommand {
  const allowed = new Set([
    '--list',
    '--assert-clear',
    '--prepare-quiesced-cutover',
    '--id',
    '--outcome',
    '--operator',
    '--reference',
    '--confirm-schedulers-quiesced',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (['--id', '--outcome', '--operator', '--reference'].includes(argument)) index += 1;
  }
  for (const option of allowed) {
    if (args.filter((argument) => argument === option).length > 1) {
      throw new Error(`${option} may only be supplied once`);
    }
  }

  const list = args.includes('--list');
  const assertClear = args.includes('--assert-clear');
  const prepareCutover = args.includes('--prepare-quiesced-cutover');
  const id = optionValue(args, '--id');
  const modes = Number(list) + Number(assertClear) + Number(prepareCutover) + Number(Boolean(id));
  if (modes !== 1) {
    throw new Error(
      'Choose exactly one mode: --list, --assert-clear, --prepare-quiesced-cutover, or --id <reminder-log-id>',
    );
  }
  if (list) {
    if (args.length !== 1) throw new Error('--list does not accept reconciliation options');
    return { mode: 'list' };
  }
  if (assertClear) {
    if (args.length !== 1) throw new Error('--assert-clear does not accept reconciliation options');
    return { mode: 'assert-clear' };
  }

  if (prepareCutover) {
    if (
      args.length !== 2 ||
      !args.includes('--confirm-schedulers-quiesced')
    ) {
      throw new Error(
        '--prepare-quiesced-cutover requires only --confirm-schedulers-quiesced',
      );
    }
    return { mode: 'prepare-cutover', schedulersQuiesced: true };
  }

  if (!args.includes('--confirm-schedulers-quiesced')) {
    throw new Error('--confirm-schedulers-quiesced is required before changing reconciliation evidence');
  }
  const outcomeValue = boundedEvidence(optionValue(args, '--outcome'), '--outcome', 40)
    .toUpperCase()
    .replaceAll('-', '_') as DeadlineReminderReconciliationOutcome;
  if (!OUTCOMES.has(outcomeValue)) {
    throw new Error(
      '--outcome must be ACCEPTED_CONFIRMED, NOT_ACCEPTED_CONFIRMED, or UNKNOWN_ACKNOWLEDGED',
    );
  }

  return {
    mode: 'reconcile',
    id: boundedEvidence(id, '--id', 200),
    outcome: outcomeValue,
    operator: boundedEvidence(optionValue(args, '--operator'), '--operator', 100),
    reference: boundedEvidence(optionValue(args, '--reference'), '--reference', 200),
    schedulersQuiesced: true,
  };
}

type ReminderReconciliationClient = Pick<PrismaClient, 'deadlineReminderLog' | '$transaction'>;

const cutoverBlockers: Prisma.DeadlineReminderLogWhereInput = {
  OR: [
    { status: { in: ['RESERVED', 'SENDING'] } },
    { status: 'UNCERTAIN', reconciliationOutcome: null },
  ],
};

export async function executeReminderReconciliation(
  client: ReminderReconciliationClient,
  command: ReminderReconciliationCommand,
  now = new Date(),
) {
  if (command.mode === 'list') {
    return client.deadlineReminderLog.findMany({
      where: cutoverBlockers,
      orderBy: [{ reservedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        status: true,
        organisationId: true,
        deadlineId: true,
        deadlineTitle: true,
        deadlineDueDate: true,
        deadlineSnapshotKnown: true,
        deliveryTimingKnown: true,
        email: true,
        reminderDays: true,
        error: true,
        legacyDeliveryStatus: true,
        legacyRecordedAt: true,
        reservationToken: true,
        providerIdempotencyKey: true,
        providerRequestStartedAt: true,
        attemptedAt: true,
      },
    });
  }

  if (command.mode === 'assert-clear') {
    const unresolved = await client.deadlineReminderLog.count({
      where: cutoverBlockers,
    });
    if (unresolved > 0) {
      throw new Error(
        `${unresolved} unresolved deadline reminder outcome(s) block runtime start; list and reconcile them while schedulers remain quiesced`,
      );
    }
    return { unresolved: 0 };
  }

  if (command.mode === 'prepare-cutover') {
    const prepared = await client.$transaction(async (tx) => {
      const releasedReservations = await tx.deadlineReminderLog.updateMany({
        where: { status: 'RESERVED' },
        data: {
          status: 'SKIPPED',
          error: 'Cutover released a quiesced reservation before provider I/O',
          attemptedAt: null,
          providerRequestStartedAt: null,
          sentAt: null,
        },
      });
      const quarantinedProviderRequests = await tx.deadlineReminderLog.updateMany({
        where: { status: 'SENDING', reconciliationOutcome: null },
        data: {
          status: 'UNCERTAIN',
          error: 'Cutover interrupted provider I/O; automatic retry is blocked unless restricted reconciliation confirms provider non-acceptance',
          sentAt: null,
        },
      });
      return {
        releasedReservations: releasedReservations.count,
        quarantinedProviderRequests: quarantinedProviderRequests.count,
      };
    });
    const unresolved = await client.deadlineReminderLog.count({ where: cutoverBlockers });
    if (unresolved > 0) {
      throw new Error(
        `${unresolved} unresolved deadline reminder outcome(s) block runtime start after quiesced cutover preparation`,
      );
    }
    return { ...prepared, unresolved: 0 };
  }

  const updated = await client.deadlineReminderLog.updateMany({
    where: {
      id: command.id,
      status: 'UNCERTAIN',
      reconciliationOutcome: null,
    },
    data: {
      reconciliationOutcome: command.outcome,
      reconciledAt: now,
      reconciledBy: command.operator,
      reconciliationReference: command.reference,
    },
  });
  if (updated.count !== 1) {
    throw new Error('Reminder outcome was not changed; it is missing, not UNCERTAIN, or already reconciled');
  }
  return { id: command.id, outcome: command.outcome, reconciledAt: now.toISOString() };
}

async function main() {
  const command = parseReminderReconciliationArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const result = await executeReminderReconciliation(prisma, command);
    if (command.mode === 'list') {
      process.stderr.write(
        '[deadline-reminder-reconciliation] Restricted output: contains recipient and provider correlation data; keep it out of shared logs and tickets.\n',
      );
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[deadline-reminder-reconciliation] ${message}\n`);
    process.exitCode = 1;
  });
}
