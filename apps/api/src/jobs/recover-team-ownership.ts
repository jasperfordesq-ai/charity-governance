import { Prisma, PrismaClient, type UserLifecycleStatus, type UserRole } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { assertBillingAuthorityAllowsOwnershipChange } from '../services/billing-authority-interlock.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const VALUE_OPTIONS = new Set([
  '--organisation-id',
  '--expected-owner-id',
  '--target-user-id',
  '--expected-target-email',
  '--expected-organisation-version',
  '--expected-owner-version',
  '--expected-target-version',
  '--operator',
  '--case-reference',
  '--confirm-execute',
]);

const FLAG_OPTIONS = new Set([
  '--dry-run',
  '--execute',
  '--confirm-authority-verified',
  '--confirm-target-identity-verified',
  '--confirm-session-revocation-understood',
]);

type LockedOrganisation = {
  id: string;
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  lifecycleVersion: number;
};

type LockedUser = {
  id: string;
  organisationId: string;
  email: string;
  role: UserRole;
  lifecycleStatus: UserLifecycleStatus;
  membershipVersion: number;
  emailVerified: boolean;
};

type OwnershipRecoveryClient = Pick<PrismaClient, '$transaction'>;

export type OwnershipRecoveryCommand = {
  mode: 'dry-run' | 'execute';
  organisationId: string;
  expectedOwnerId: string;
  targetUserId: string;
  expectedTargetEmail: string;
  expectedOrganisationVersion?: number;
  expectedOwnerVersion?: number;
  expectedTargetVersion?: number;
  operator: string;
  caseReference: string;
  authorityVerified: true;
  targetIdentityVerified: true;
  sessionRevocationUnderstood: boolean;
  executionConfirmation?: string;
};

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function boundedEvidence(
  value: string | undefined,
  name: string,
  maximum: number,
): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maximum) {
    throw new Error(`${name} must be at most ${maximum} characters`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return normalized;
}

function normalizedEmail(value: string | undefined): string {
  const email = boundedEvidence(value, '--expected-target-email', 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error('--expected-target-email must be a valid email address');
  return email;
}

function positiveVersion(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe positive integer`);
  return parsed;
}

export function parseOwnershipRecoveryArgs(args: string[]): OwnershipRecoveryCommand {
  const allowed = new Set([...VALUE_OPTIONS, ...FLAG_OPTIONS]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (VALUE_OPTIONS.has(argument)) index += 1;
  }
  for (const option of allowed) {
    if (args.filter((argument) => argument === option).length > 1) {
      throw new Error(`${option} may only be supplied once`);
    }
  }

  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');
  if (Number(dryRun) + Number(execute) !== 1) {
    throw new Error('Choose exactly one mode: --dry-run or --execute');
  }
  if (!args.includes('--confirm-authority-verified')) {
    throw new Error('--confirm-authority-verified is required');
  }
  if (!args.includes('--confirm-target-identity-verified')) {
    throw new Error('--confirm-target-identity-verified is required');
  }

  const organisationId = boundedEvidence(optionValue(args, '--organisation-id'), '--organisation-id', 200);
  const expectedOwnerId = boundedEvidence(optionValue(args, '--expected-owner-id'), '--expected-owner-id', 200);
  const targetUserId = boundedEvidence(optionValue(args, '--target-user-id'), '--target-user-id', 200);
  if (expectedOwnerId === targetUserId) {
    throw new Error('--target-user-id must identify someone other than the expected current owner');
  }

  const executionConfirmation = optionValue(args, '--confirm-execute')?.trim();
  const expectedOrganisationVersion = positiveVersion(
    optionValue(args, '--expected-organisation-version'),
    '--expected-organisation-version',
  );
  const expectedOwnerVersion = positiveVersion(
    optionValue(args, '--expected-owner-version'),
    '--expected-owner-version',
  );
  const expectedTargetVersion = positiveVersion(
    optionValue(args, '--expected-target-version'),
    '--expected-target-version',
  );
  if (
    execute &&
    (
      expectedOrganisationVersion === undefined ||
      expectedOwnerVersion === undefined ||
      expectedTargetVersion === undefined
    )
  ) {
    throw new Error(
      '--execute requires --expected-organisation-version, --expected-owner-version, and --expected-target-version from the reviewed dry-run',
    );
  }
  const expectedExecutionConfirmation =
    `TRANSFER OWNERSHIP TO ${targetUserId} AT ORGANISATION ${expectedOrganisationVersion} OWNER ${expectedOwnerVersion} TARGET ${expectedTargetVersion}`;
  const sessionRevocationUnderstood = args.includes('--confirm-session-revocation-understood');
  if (dryRun && (sessionRevocationUnderstood || executionConfirmation)) {
    throw new Error('Execution-only confirmations must not be supplied with --dry-run');
  }
  if (execute && !sessionRevocationUnderstood) {
    throw new Error('--confirm-session-revocation-understood is required with --execute');
  }
  if (execute && executionConfirmation !== expectedExecutionConfirmation) {
    throw new Error(
      `--confirm-execute must exactly equal "${expectedExecutionConfirmation}"`,
    );
  }

  return {
    mode: dryRun ? 'dry-run' : 'execute',
    organisationId,
    expectedOwnerId,
    targetUserId,
    expectedTargetEmail: normalizedEmail(optionValue(args, '--expected-target-email')),
    expectedOrganisationVersion,
    expectedOwnerVersion,
    expectedTargetVersion,
    operator: boundedEvidence(optionValue(args, '--operator'), '--operator', 160),
    caseReference: boundedEvidence(optionValue(args, '--case-reference'), '--case-reference', 128),
    authorityVerified: true,
    targetIdentityVerified: true,
    sessionRevocationUnderstood,
    executionConfirmation: execute ? executionConfirmation : undefined,
  };
}

function assertOwnershipRecoveryCommand(command: OwnershipRecoveryCommand): void {
  if (!command || typeof command !== 'object') {
    throw new Error('Ownership recovery refused: command is required');
  }
  if (command.mode !== 'dry-run' && command.mode !== 'execute') {
    throw new Error('Ownership recovery refused: mode must be dry-run or execute');
  }

  const organisationId = boundedEvidence(command.organisationId, 'organisationId', 200);
  const expectedOwnerId = boundedEvidence(command.expectedOwnerId, 'expectedOwnerId', 200);
  const targetUserId = boundedEvidence(command.targetUserId, 'targetUserId', 200);
  if (
    organisationId !== command.organisationId ||
    expectedOwnerId !== command.expectedOwnerId ||
    targetUserId !== command.targetUserId ||
    expectedOwnerId === targetUserId
  ) {
    throw new Error('Ownership recovery refused: command identifiers are not canonical');
  }
  if (normalizedEmail(command.expectedTargetEmail) !== command.expectedTargetEmail) {
    throw new Error('Ownership recovery refused: target email is not canonical');
  }
  if (boundedEvidence(command.operator, 'operator', 160) !== command.operator) {
    throw new Error('Ownership recovery refused: operator evidence is not canonical');
  }
  if (boundedEvidence(command.caseReference, 'caseReference', 128) !== command.caseReference) {
    throw new Error('Ownership recovery refused: case reference is not canonical');
  }
  if (command.authorityVerified !== true || command.targetIdentityVerified !== true) {
    throw new Error('Ownership recovery refused: authority and target identity must be verified');
  }

  for (const [name, version] of [
    ['organisation', command.expectedOrganisationVersion],
    ['owner', command.expectedOwnerVersion],
    ['target', command.expectedTargetVersion],
  ] as const) {
    if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
      throw new Error(`Ownership recovery refused: expected ${name} version must be a safe positive integer`);
    }
  }

  if (command.mode === 'dry-run') {
    if (command.sessionRevocationUnderstood || command.executionConfirmation !== undefined) {
      throw new Error('Ownership recovery refused: dry-run cannot include execution confirmations');
    }
    return;
  }

  if (
    command.expectedOrganisationVersion === undefined ||
    command.expectedOwnerVersion === undefined ||
    command.expectedTargetVersion === undefined
  ) {
    throw new Error('Ownership recovery refused: execute requires all reviewed versions');
  }
  if (command.sessionRevocationUnderstood !== true) {
    throw new Error('Ownership recovery refused: execute requires session-revocation acknowledgement');
  }
  const expectedConfirmation =
    `TRANSFER OWNERSHIP TO ${command.targetUserId} AT ORGANISATION ${command.expectedOrganisationVersion} OWNER ${command.expectedOwnerVersion} TARGET ${command.expectedTargetVersion}`;
  if (command.executionConfirmation !== expectedConfirmation) {
    throw new Error('Ownership recovery refused: execute confirmation does not match the reviewed target and versions');
  }
}

function requireRecoveryState(
  organisation: LockedOrganisation | undefined,
  users: LockedUser[],
  command: OwnershipRecoveryCommand,
): { currentOwner: LockedUser; target: LockedUser } {
  if (!organisation) throw new Error('Ownership recovery refused: organisation not found');
  if (organisation.lifecycleStatus !== 'ACTIVE') {
    throw new Error('Ownership recovery refused: organisation is not active');
  }
  if (
    command.expectedOrganisationVersion !== undefined &&
    organisation.lifecycleVersion !== command.expectedOrganisationVersion
  ) {
    throw new Error(
      'Ownership recovery refused: organisation version does not match --expected-organisation-version',
    );
  }

  const currentOwners = users.filter(
    (user) => user.role === 'OWNER' && user.lifecycleStatus === 'ACTIVE',
  );
  if (currentOwners.length !== 1) {
    throw new Error(
      `Ownership recovery refused: expected exactly one active owner, found ${currentOwners.length}`,
    );
  }
  const currentOwner = currentOwners[0];
  if (currentOwner.id !== command.expectedOwnerId) {
    throw new Error('Ownership recovery refused: the current owner does not match --expected-owner-id');
  }
  if (
    command.expectedOwnerVersion !== undefined &&
    currentOwner.membershipVersion !== command.expectedOwnerVersion
  ) {
    throw new Error(
      'Ownership recovery refused: current owner version does not match --expected-owner-version',
    );
  }
  if (currentOwner.lifecycleStatus !== 'ACTIVE') {
    throw new Error('Ownership recovery refused: the expected owner is not active');
  }

  const target = users.find((user) => user.id === command.targetUserId);
  if (!target) throw new Error('Ownership recovery refused: target user was not found in this organisation');
  if (target.lifecycleStatus !== 'ACTIVE') {
    throw new Error('Ownership recovery refused: target user is not active');
  }
  if (!target.emailVerified) {
    throw new Error('Ownership recovery refused: target user email is not verified');
  }
  if (target.role === 'OWNER') {
    throw new Error('Ownership recovery refused: target user is already the owner');
  }
  if (target.email.trim().toLowerCase() !== command.expectedTargetEmail) {
    throw new Error('Ownership recovery refused: target email does not match --expected-target-email');
  }
  if (
    command.expectedTargetVersion !== undefined &&
    target.membershipVersion !== command.expectedTargetVersion
  ) {
    throw new Error(
      'Ownership recovery refused: target version does not match --expected-target-version',
    );
  }

  return { currentOwner, target };
}

function recoveryResult(input: {
  command: OwnershipRecoveryCommand;
  organisation: LockedOrganisation;
  currentOwner: LockedUser;
  target: LockedUser;
  previousOwnerRevokedSessionCount: number;
  targetRevokedSessionCount: number;
  skippedReminderCount: number;
  billingAuthorityAutoReleasedGrantId: string | null;
  billingAuthorityReleaseRequired: boolean;
}) {
  return {
    mode: input.command.mode === 'dry-run' ? 'DRY_RUN' : 'EXECUTED',
    mutationApplied: input.command.mode === 'execute',
    organisationId: input.organisation.id,
    organisationLifecycleVersion: input.organisation.lifecycleVersion,
    previousOwnerId: input.currentOwner.id,
    previousOwnerRole: input.currentOwner.role,
    previousOwnerNewRole: 'ADMIN' as const,
    targetUserId: input.target.id,
    targetPreviousRole: input.target.role,
    targetNewRole: 'OWNER' as const,
    previousOwnerMembershipVersion: input.currentOwner.membershipVersion,
    targetMembershipVersion: input.target.membershipVersion,
    previousOwnerRevokedSessionCount: input.previousOwnerRevokedSessionCount,
    targetRevokedSessionCount: input.targetRevokedSessionCount,
    skippedReminderCount: input.skippedReminderCount,
    billingAuthorityAutoReleasedGrantId: input.billingAuthorityAutoReleasedGrantId,
    billingAuthorityReleaseRequired: input.billingAuthorityReleaseRequired,
    auditEventType: input.command.mode === 'execute' ? 'OWNERSHIP_RECOVERED' as const : null,
    auditActorKind: input.command.mode === 'execute' ? 'SUPPORT' as const : null,
    caseReference: input.command.caseReference,
    credentialsIssued: false,
  };
}

export async function executeOwnershipRecovery(
  client: OwnershipRecoveryClient,
  command: OwnershipRecoveryCommand,
  now = new Date(),
) {
  assertOwnershipRecoveryCommand(command);
  return client.$transaction(async (tx) => {
    const organisations = await tx.$queryRaw<LockedOrganisation[]>`
      SELECT "id", "lifecycleStatus", "lifecycleVersion"
      FROM "Organisation"
      WHERE "id" = ${command.organisationId}
      FOR UPDATE
    `;
    const organisation = organisations[0];
    if (!organisation) throw new Error('Ownership recovery refused: organisation not found');
    if (organisation.lifecycleStatus !== 'ACTIVE') {
      throw new Error('Ownership recovery refused: organisation is not active');
    }
    const billingAuthority = await assertBillingAuthorityAllowsOwnershipChange(tx, command.organisationId, {
      now,
      releaseElapsedCheckout: command.mode === 'execute',
    });
    const users = await tx.$queryRaw<LockedUser[]>(Prisma.sql`
      SELECT
        "id", "organisationId", "email", "role", "lifecycleStatus",
        "membershipVersion", "emailVerified"
      FROM "User"
      WHERE "organisationId" = ${command.organisationId}
        AND (
          "role" = 'OWNER'::"UserRole"
          OR "id" IN (${Prisma.join([command.expectedOwnerId, command.targetUserId].sort())})
        )
      ORDER BY "id"
      FOR UPDATE
    `);
    const { currentOwner, target } = requireRecoveryState(organisation, users, command);

    if (command.mode === 'dry-run') {
      const [previousOwnerSessionCount, targetSessionCount, reservedReminderCount] = await Promise.all([
        tx.authSession.count({ where: { userId: currentOwner.id, revokedAt: null } }),
        tx.authSession.count({ where: { userId: target.id, revokedAt: null } }),
        tx.deadlineReminderLog.count({
          where: {
            organisationId: command.organisationId,
            userId: currentOwner.id,
            status: 'RESERVED',
          },
        }),
      ]);
      return recoveryResult({
        command,
        organisation,
        currentOwner,
        target,
        previousOwnerRevokedSessionCount: previousOwnerSessionCount,
        targetRevokedSessionCount: targetSessionCount,
        skippedReminderCount: reservedReminderCount,
        billingAuthorityAutoReleasedGrantId: billingAuthority.autoReleasedGrantId,
        billingAuthorityReleaseRequired: billingAuthority.elapsedSafeGrantId !== null,
      });
    }

    // Demote first: the immediate partial unique index rejects a transient
    // second owner, while the deferred continuity trigger permits this
    // transaction's temporary zero-owner state only until commit.
    const demoted = await tx.user.updateMany({
      where: {
        id: currentOwner.id,
        organisationId: command.organisationId,
        role: 'OWNER',
        lifecycleStatus: 'ACTIVE',
        membershipVersion: currentOwner.membershipVersion,
      },
      data: { role: 'ADMIN' },
    });
    if (demoted.count !== 1) {
      throw new Error('Ownership recovery refused: current owner changed during recovery');
    }

    const promoted = await tx.user.updateMany({
      where: {
        id: target.id,
        organisationId: command.organisationId,
        role: target.role,
        lifecycleStatus: 'ACTIVE',
        membershipVersion: target.membershipVersion,
        email: target.email,
        emailVerified: true,
      },
      data: { role: 'OWNER' },
    });
    if (promoted.count !== 1) {
      throw new Error('Ownership recovery refused: target user changed during recovery');
    }

    const previousOwnerSessions = await tx.authSession.updateMany({
      where: { userId: currentOwner.id, revokedAt: null },
      data: { revokedAt: now, revocationReason: 'OWNERSHIP_CHANGED' },
    });
    const targetSessions = await tx.authSession.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: now, revocationReason: 'OWNERSHIP_CHANGED' },
    });
    const skippedReminders = await tx.deadlineReminderLog.updateMany({
      where: {
        organisationId: command.organisationId,
        userId: currentOwner.id,
        status: 'RESERVED',
      },
      data: {
        status: 'SKIPPED',
        error: 'Recipient ownership changed during restricted support recovery',
        attemptedAt: null,
        sentAt: null,
      },
    });

    await tx.securityAuditEvent.create({
      data: {
        organisationId: command.organisationId,
        type: 'OWNERSHIP_RECOVERED',
        actorKind: 'SUPPORT',
        actorUserId: null,
        actorLabel: command.operator,
        subjectLabel: target.email.slice(0, 160),
        subjectUserId: target.id,
        reason: `Restricted ownership recovery authorised under case ${command.caseReference}.`,
        requestId: command.caseReference,
        context: {
          previousOwnerId: currentOwner.id,
          previousOwnerRole: currentOwner.role,
          previousOwnerNewRole: 'ADMIN',
          previousOwnerMembershipVersion: currentOwner.membershipVersion,
          targetPreviousRole: target.role,
          targetMembershipVersion: target.membershipVersion,
          targetEmailMatched: true,
          authorityVerified: command.authorityVerified,
          targetIdentityVerified: command.targetIdentityVerified,
          sessionRevocationUnderstood: command.sessionRevocationUnderstood,
          previousOwnerRevokedSessionCount: previousOwnerSessions.count,
          targetRevokedSessionCount: targetSessions.count,
          skippedReminderCount: skippedReminders.count,
          billingAuthorityAutoReleasedGrantId: billingAuthority.autoReleasedGrantId,
          credentialsIssued: false,
        },
      },
    });

    return recoveryResult({
      command,
      organisation,
      currentOwner,
      target,
      previousOwnerRevokedSessionCount: previousOwnerSessions.count,
      targetRevokedSessionCount: targetSessions.count,
      skippedReminderCount: skippedReminders.count,
      billingAuthorityAutoReleasedGrantId: billingAuthority.autoReleasedGrantId,
      billingAuthorityReleaseRequired: false,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function main() {
  const command = parseOwnershipRecoveryArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    process.stderr.write(
      '[team-ownership-recovery] Restricted operator workflow. Keep organisation, user, operator, and case evidence out of shared logs.\n',
    );
    const result = await executeOwnershipRecovery(prisma, command);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[team-ownership-recovery] ${message}\n`);
    process.exitCode = 1;
  });
}
