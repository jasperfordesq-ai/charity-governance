import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { serializeErrorForLog } from '../utils/logger.js';
import {
  lockAuthRecoveryControl,
  requireAuthRecoveryControlForCurrentSecret,
} from '../services/auth-recovery-control.js';
import { authRecoverySecretFingerprint } from '../services/password-recovery-crypto.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const VALUE_OPTIONS = new Set([
  '--reason',
  '--operator',
  '--case-reference',
  '--expected-capabilities',
  '--expected-request-evidence-rows',
  '--expected-generation',
  '--expected-legacy-slots',
  '--expected-rate-buckets',
  '--expected-security-notices',
  '--expected-database-identity-sha256',
  '--expected-deployment-profile',
  '--confirm-execute',
  '--confirm-activate',
]);
const FLAG_OPTIONS = new Set([
  '--dry-run',
  '--execute',
  '--activate-after-replacement',
  '--confirm-api-and-scheduler-quiesced',
  '--confirm-outbox-preservation-understood',
]);
const ROTATION_REASONS = new Set([
  'PLANNED_KEY_ROTATION',
  'SUSPECTED_KEY_COMPROMISE',
] as const);

export type AuthRecoverySecretRotationReason =
  | 'PLANNED_KEY_ROTATION'
  | 'SUSPECTED_KEY_COMPROMISE';

export type AuthRecoverySecretRotationCounts = {
  generation: number;
  capabilities: number;
  requestEvidenceRows: number;
  legacySlots: number;
  rateBuckets: number;
  securityNotices: number;
};

export type AuthRecoveryLiveDatabaseTarget = {
  databaseName: string;
  databaseOid: string;
  schemaName: string;
  schemaOid: string;
  databaseUser: string;
  serverAddress: string;
  serverPort: number;
};

export type AuthRecoverySecretRotationEvidence = {
  counts: AuthRecoverySecretRotationCounts;
  databaseIdentitySha256: string;
};

export type AuthRecoverySecretRotationCommand = {
  mode: 'dry-run' | 'execute' | 'activate';
  reason: AuthRecoverySecretRotationReason;
  operator: string;
  caseReference: string;
  apiAndSchedulerQuiesced: true;
  outboxPreservationUnderstood: boolean;
  expected?: AuthRecoverySecretRotationCounts;
  expectedDatabaseIdentitySha256?: string;
  expectedDeploymentProfile?: 'production' | 'personal-server';
  executionConfirmation?: string;
  activationConfirmation?: string;
};

export type AuthRecoverySecretRotationStore = {
  inspect(): Promise<AuthRecoverySecretRotationEvidence>;
  rotate(
    expected: AuthRecoverySecretRotationCounts,
    expectedDatabaseIdentitySha256: string,
  ): Promise<AuthRecoverySecretRotationEvidence>;
  activate(
    expectedGeneration: number,
    expectedDatabaseIdentitySha256: string,
  ): Promise<{ generation: number; securityNotices: number; databaseIdentitySha256: string }>;
};

type RotationCountRow = {
  generation: bigint | number;
  capabilities: bigint | number;
  requestEvidenceRows: bigint | number;
  legacySlots: bigint | number;
  rateBuckets: bigint | number;
  securityNotices: bigint | number;
};

type LiveDatabaseTargetRow = {
  databaseName: string;
  databaseOid: string;
  schemaName: string | null;
  schemaOid: string | null;
  databaseUser: string;
  serverAddress: string | null;
  serverPort: number | null;
};

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function bounded(value: string | undefined, name: string, minimum: number, maximum: number): string {
  const normalized = value?.trim() ?? '';
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${name} must contain between ${minimum} and ${maximum} characters`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return normalized;
}

function namedOperator(value: string | undefined): string {
  const operator = bounded(value, '--operator', 3, 160);
  if (
    /[@:\\/]/u.test(operator) ||
    /^(?:admin|administrator|operator|system|unknown)$/iu.test(operator)
  ) {
    throw new Error('--operator must be a safe named human operator identity');
  }
  return operator;
}

function countOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}

function rotationReason(value: string | undefined): AuthRecoverySecretRotationReason {
  if (!value || !ROTATION_REASONS.has(value as AuthRecoverySecretRotationReason)) {
    throw new Error(
      '--reason must be exactly PLANNED_KEY_ROTATION or SUSPECTED_KEY_COMPROMISE',
    );
  }
  return value as AuthRecoverySecretRotationReason;
}

export function authRecoverySecretRotationConfirmation(
  reason: AuthRecoverySecretRotationReason,
  counts: AuthRecoverySecretRotationCounts,
  databaseIdentitySha256: string,
  deploymentProfile = 'production',
): string {
  return [
    'ROTATE AUTH RECOVERY SECRET',
    `REASON ${reason}`,
    `GENERATION ${counts.generation}`,
    `TERMINATE ${counts.capabilities} CAPABILITIES`,
    `REDACT ${counts.requestEvidenceRows} REQUEST EVIDENCE ROWS`,
    `CLEAR ${counts.legacySlots} LEGACY SLOTS`,
    `DELETE ${counts.rateBuckets} RATE BUCKETS`,
    `PRESERVE ${counts.securityNotices} SECURITY NOTICES`,
    `DATABASE SHA256 ${databaseIdentitySha256}`,
    `PROFILE ${deploymentProfile}`,
  ].join(' ');
}

export function authRecoverySecretActivationConfirmation(
  reason: AuthRecoverySecretRotationReason,
  generation: number,
  databaseIdentitySha256: string,
  deploymentProfile = 'production',
): string {
  return [
    'ACTIVATE REPLACEMENT AUTH RECOVERY SECRET',
    `REASON ${reason}`,
    `GENERATION ${generation}`,
    `DATABASE SHA256 ${databaseIdentitySha256}`,
    `PROFILE ${deploymentProfile}`,
  ].join(' ');
}

function sha256Pattern(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function deploymentProfile(
  value: string | undefined,
  name: string,
): 'production' | 'personal-server' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'production' && value !== 'personal-server') {
    throw new Error(`${name} must be exactly production or personal-server`);
  }
  return value;
}

export function authRecoveryDeploymentProfile(
  env: Record<string, string | undefined>,
): 'production' | 'personal-server' {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Auth recovery secret rotation refused: NODE_ENV must be production');
  }
  const profile = deploymentProfile(
    env.CHARITYPILOT_DEPLOYMENT_MODE,
    'CHARITYPILOT_DEPLOYMENT_MODE',
  );
  if (profile === undefined) {
    throw new Error(
      'Auth recovery secret rotation refused: CHARITYPILOT_DEPLOYMENT_MODE must be explicit',
    );
  }
  return profile;
}

export function authRecoveryDatabaseIdentitySha256(
  target: AuthRecoveryLiveDatabaseTarget,
): string {
  const textFields = [
    target.databaseName,
    target.databaseOid,
    target.schemaName,
    target.schemaOid,
    target.databaseUser,
    target.serverAddress,
  ];
  if (
    textFields.some((value) => !value || CONTROL_CHARACTERS.test(value)) ||
    !/^\d+$/u.test(target.databaseOid) ||
    !/^\d+$/u.test(target.schemaOid) ||
    !Number.isInteger(target.serverPort) ||
    target.serverPort < 1 ||
    target.serverPort > 65_535
  ) {
    throw new Error('Auth recovery secret rotation refused: live database identity is invalid');
  }
  const canonicalIdentity = JSON.stringify({
    format: 'charitypilot-auth-recovery-database-target/v1',
    databaseName: target.databaseName,
    databaseOid: target.databaseOid,
    schemaName: target.schemaName,
    schemaOid: target.schemaOid,
    databaseUser: target.databaseUser,
    serverAddress: target.serverAddress,
    serverPort: target.serverPort,
  });
  return createHash('sha256').update(canonicalIdentity).digest('hex');
}

export function parseAuthRecoverySecretRotationArgs(
  args: string[],
): AuthRecoverySecretRotationCommand {
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
  const activate = args.includes('--activate-after-replacement');
  if (Number(dryRun) + Number(execute) + Number(activate) !== 1) {
    throw new Error(
      'Choose exactly one mode: --dry-run, --execute, or --activate-after-replacement',
    );
  }
  if (!args.includes('--confirm-api-and-scheduler-quiesced')) {
    throw new Error('--confirm-api-and-scheduler-quiesced is required');
  }

  const reason = rotationReason(optionValue(args, '--reason'));
  const operator = namedOperator(optionValue(args, '--operator'));
  const caseReference = bounded(optionValue(args, '--case-reference'), '--case-reference', 3, 128);
  const expectedGeneration = countOption(
    optionValue(args, '--expected-generation'),
    '--expected-generation',
  );
  const expectedCountValues = {
    capabilities: countOption(optionValue(args, '--expected-capabilities'), '--expected-capabilities'),
    requestEvidenceRows: countOption(
      optionValue(args, '--expected-request-evidence-rows'),
      '--expected-request-evidence-rows',
    ),
    legacySlots: countOption(optionValue(args, '--expected-legacy-slots'), '--expected-legacy-slots'),
    rateBuckets: countOption(optionValue(args, '--expected-rate-buckets'), '--expected-rate-buckets'),
    securityNotices: countOption(optionValue(args, '--expected-security-notices'), '--expected-security-notices'),
  };
  const hasAnyExpectedCount = Object.values(expectedCountValues).some((value) => value !== undefined);
  const hasAllExpectedCounts = Object.values(expectedCountValues).every((value) => value !== undefined);
  const outboxPreservationUnderstood = args.includes('--confirm-outbox-preservation-understood');
  const expectedDatabaseIdentitySha256 = sha256Pattern(
    optionValue(args, '--expected-database-identity-sha256'),
    '--expected-database-identity-sha256',
  );
  const expectedDeploymentProfile = deploymentProfile(
    optionValue(args, '--expected-deployment-profile'),
    '--expected-deployment-profile',
  );
  const executionConfirmation = optionValue(args, '--confirm-execute')?.trim();
  const activationConfirmation = optionValue(args, '--confirm-activate')?.trim();

  if (dryRun) {
    if (
      hasAnyExpectedCount ||
      expectedGeneration !== undefined ||
      expectedDatabaseIdentitySha256 !== undefined ||
      expectedDeploymentProfile !== undefined ||
      outboxPreservationUnderstood ||
      executionConfirmation !== undefined ||
      activationConfirmation !== undefined
    ) {
      throw new Error('Execution-only counts and confirmations must not be supplied with --dry-run');
    }
    return {
      mode: 'dry-run',
      reason,
      operator,
      caseReference,
      apiAndSchedulerQuiesced: true,
      outboxPreservationUnderstood: false,
    };
  }

  if (expectedDatabaseIdentitySha256 === undefined) {
    throw new Error('Mutation mode requires --expected-database-identity-sha256');
  }
  if (expectedDeploymentProfile === undefined) {
    throw new Error('Mutation mode requires --expected-deployment-profile');
  }
  if (expectedGeneration === undefined || expectedGeneration < 1) {
    throw new Error('Mutation mode requires a positive --expected-generation');
  }

  if (activate) {
    if (
      hasAnyExpectedCount ||
      outboxPreservationUnderstood ||
      executionConfirmation !== undefined
    ) {
      throw new Error('Rotation counts and execute authority must not be supplied with activation');
    }
    const expectedConfirmation = authRecoverySecretActivationConfirmation(
      reason,
      expectedGeneration,
      expectedDatabaseIdentitySha256,
      expectedDeploymentProfile,
    );
    if (activationConfirmation !== expectedConfirmation) {
      throw new Error(`--confirm-activate must exactly equal "${expectedConfirmation}"`);
    }
    return {
      mode: 'activate',
      reason,
      operator,
      caseReference,
      apiAndSchedulerQuiesced: true,
      outboxPreservationUnderstood: false,
      expected: {
        generation: expectedGeneration,
        capabilities: 0,
        requestEvidenceRows: 0,
        legacySlots: 0,
        rateBuckets: 0,
        securityNotices: 0,
      },
      expectedDatabaseIdentitySha256,
      expectedDeploymentProfile,
      activationConfirmation,
    };
  }

  if (!hasAllExpectedCounts) {
    throw new Error('--execute requires all five expected counts from the reviewed dry-run');
  }
  if (!outboxPreservationUnderstood) {
    throw new Error('--confirm-outbox-preservation-understood is required with --execute');
  }
  if (activationConfirmation !== undefined) {
    throw new Error('Activation authority must not be supplied with --execute');
  }
  const expected = {
    generation: expectedGeneration,
    ...expectedCountValues,
  } as AuthRecoverySecretRotationCounts;
  const expectedConfirmation = authRecoverySecretRotationConfirmation(
    reason,
    expected,
    expectedDatabaseIdentitySha256,
    expectedDeploymentProfile,
  );
  if (executionConfirmation !== expectedConfirmation) {
    throw new Error(`--confirm-execute must exactly equal "${expectedConfirmation}"`);
  }

  return {
    mode: 'execute',
    reason,
    operator,
    caseReference,
    apiAndSchedulerQuiesced: true,
    outboxPreservationUnderstood: true,
    expected,
    expectedDatabaseIdentitySha256,
    expectedDeploymentProfile,
    executionConfirmation,
  };
}

function assertCounts(counts: AuthRecoverySecretRotationCounts, label: string): void {
  for (const [name, value] of Object.entries(counts)) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (name === 'generation' && value < 1)
    ) {
      throw new Error(`Auth recovery secret rotation refused: ${label} ${name} count is invalid`);
    }
  }
}

function assertCommand(command: AuthRecoverySecretRotationCommand): void {
  if (!command || typeof command !== 'object') {
    throw new Error('Auth recovery secret rotation refused: command is required');
  }
  if (
    command.mode !== 'dry-run' &&
    command.mode !== 'execute' &&
    command.mode !== 'activate'
  ) {
    throw new Error('Auth recovery secret rotation refused: invalid mode');
  }
  rotationReason(command.reason);
  if (namedOperator(command.operator) !== command.operator) {
    throw new Error('Auth recovery secret rotation refused: operator is not canonical');
  }
  if (bounded(command.caseReference, 'caseReference', 3, 128) !== command.caseReference) {
    throw new Error('Auth recovery secret rotation refused: case reference is not canonical');
  }
  if (command.apiAndSchedulerQuiesced !== true) {
    throw new Error('Auth recovery secret rotation refused: API and scheduler must be quiesced');
  }
  if (command.mode === 'dry-run') {
    if (
      command.expected !== undefined ||
      command.expectedDatabaseIdentitySha256 !== undefined ||
      command.expectedDeploymentProfile !== undefined ||
      command.executionConfirmation !== undefined ||
      command.activationConfirmation !== undefined ||
      command.outboxPreservationUnderstood
    ) {
      throw new Error('Auth recovery secret rotation refused: dry-run contains execute authority');
    }
    return;
  }
  if (!command.expected) {
    throw new Error('Auth recovery secret rotation refused: reviewed counts are required');
  }
  assertCounts(command.expected, 'expected');
  if (command.expected.generation < 1) {
    throw new Error('Auth recovery secret rotation refused: expected generation is invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(command.expectedDatabaseIdentitySha256 ?? '')) {
    throw new Error('Auth recovery secret rotation refused: reviewed database identity is required');
  }
  if (
    command.expectedDeploymentProfile !== 'production' &&
    command.expectedDeploymentProfile !== 'personal-server'
  ) {
    throw new Error('Auth recovery secret rotation refused: reviewed deployment profile is required');
  }
  if (command.mode === 'activate') {
    if (
      command.outboxPreservationUnderstood ||
      command.executionConfirmation !== undefined ||
      command.expected.capabilities !== 0 ||
      command.expected.requestEvidenceRows !== 0 ||
      command.expected.legacySlots !== 0 ||
      command.expected.rateBuckets !== 0 ||
      command.expected.securityNotices !== 0
    ) {
      throw new Error('Auth recovery secret activation contains rotation authority');
    }
    if (
      command.activationConfirmation !==
      authRecoverySecretActivationConfirmation(
        command.reason,
        command.expected.generation,
        command.expectedDatabaseIdentitySha256 as string,
        command.expectedDeploymentProfile,
      )
    ) {
      throw new Error('Auth recovery secret rotation refused: activation confirmation is invalid');
    }
    return;
  }
  if (command.outboxPreservationUnderstood !== true) {
    throw new Error('Auth recovery secret rotation refused: outbox preservation was not acknowledged');
  }
  if (command.activationConfirmation !== undefined) {
    throw new Error('Auth recovery secret rotation refused: execute contains activation authority');
  }
  if (
    command.executionConfirmation !==
    authRecoverySecretRotationConfirmation(
      command.reason,
      command.expected,
      command.expectedDatabaseIdentitySha256 as string,
      command.expectedDeploymentProfile,
    )
  ) {
    throw new Error('Auth recovery secret rotation refused: execution confirmation is invalid');
  }
}

function countsFromRow(row: RotationCountRow | undefined): AuthRecoverySecretRotationCounts {
  if (!row) throw new Error('Auth recovery secret rotation count query returned no row');
  const counts = {
    generation: Number(row.generation),
    capabilities: Number(row.capabilities),
    requestEvidenceRows: Number(row.requestEvidenceRows),
    legacySlots: Number(row.legacySlots),
    rateBuckets: Number(row.rateBuckets),
    securityNotices: Number(row.securityNotices),
  };
  assertCounts(counts, 'database');
  return counts;
}

function countsEqual(
  left: AuthRecoverySecretRotationCounts,
  right: AuthRecoverySecretRotationCounts,
): boolean {
  return left.capabilities === right.capabilities &&
    left.generation === right.generation &&
    left.requestEvidenceRows === right.requestEvidenceRows &&
    left.legacySlots === right.legacySlots &&
    left.rateBuckets === right.rateBuckets &&
    left.securityNotices === right.securityNotices;
}

function isSerializableConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
    message?: unknown;
  };
  return candidate.code === 'P2034' ||
    candidate.meta?.code === '40001' ||
    (typeof candidate.message === 'string' && candidate.message.includes('40001'));
}

export class PrismaAuthRecoverySecretRotationStore implements AuthRecoverySecretRotationStore {
  private readonly secretFingerprint: string;

  constructor(
    private prisma: PrismaClient,
    secret = process.env.AUTH_RECOVERY_SECRET,
  ) {
    this.secretFingerprint = authRecoverySecretFingerprint(secret);
  }

  private async liveDatabaseIdentitySha256(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const rows = await tx.$queryRaw<LiveDatabaseTargetRow[]>`
      SELECT
        CURRENT_DATABASE() AS "databaseName",
        (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = CURRENT_DATABASE()) AS "databaseOid",
        CURRENT_SCHEMA() AS "schemaName",
        TO_REGNAMESPACE(CURRENT_SCHEMA())::oid::text AS "schemaOid",
        CURRENT_USER AS "databaseUser",
        COALESCE(INET_SERVER_ADDR()::text, 'local-socket') AS "serverAddress",
        COALESCE(INET_SERVER_PORT(), CURRENT_SETTING('port')::integer) AS "serverPort"
    `;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.schemaName === null ||
      row.schemaOid === null
    ) {
      throw new Error(
        'Auth recovery secret rotation refused: live database/schema identity is unavailable',
      );
    }
    return authRecoveryDatabaseIdentitySha256({
      ...row,
      schemaName: row.schemaName,
      schemaOid: row.schemaOid,
      serverAddress: row.serverAddress ?? 'local-socket',
      serverPort: row.serverPort ?? 0,
    });
  }

  private async lockedCounts(
    tx: Prisma.TransactionClient,
    requireActiveSecret: boolean,
  ): Promise<AuthRecoverySecretRotationCounts> {
    const control = requireActiveSecret
      ? await requireAuthRecoveryControlForCurrentSecret(tx)
      : await lockAuthRecoveryControl(tx);
    await tx.$executeRaw`
      LOCK TABLE
        "PasswordRecoveryRequest",
        "AuthRecoveryRateLimitBucket",
        "User",
        "AuthRecoveryRetiredSecret",
        "AuthSecurityEmailOutbox"
      IN SHARE ROW EXCLUSIVE MODE
    `;
    const rows = await tx.$queryRaw<RotationCountRow[]>`
      SELECT
        ${control.generation}::BIGINT AS "generation",
        (
          SELECT COUNT(*)
          FROM "PasswordRecoveryRequest"
          WHERE "deliveryState" <> 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
            AND "terminatedAt" IS NULL
        ) AS "capabilities",
        (
          SELECT COUNT(*)
          FROM "PasswordRecoveryRequest"
          WHERE "identifierDigest" IS NOT NULL
            OR "requestIpDigest" IS NOT NULL
            OR "requestNetworkDigest" IS NOT NULL
            OR "rateKeyVersion" IS NOT NULL
        ) AS "requestEvidenceRows",
        (
          SELECT COUNT(*)
          FROM "User"
          WHERE "resetToken" IS NOT NULL OR "resetTokenExpiry" IS NOT NULL
        ) AS "legacySlots",
        (SELECT COUNT(*) FROM "AuthRecoveryRateLimitBucket") AS "rateBuckets",
        (SELECT COUNT(*) FROM "AuthSecurityEmailOutbox") AS "securityNotices"
    `;
    return countsFromRow(rows[0]);
  }

  private async lockedEvidence(
    tx: Prisma.TransactionClient,
    requireActiveSecret: boolean,
  ): Promise<AuthRecoverySecretRotationEvidence> {
    const counts = await this.lockedCounts(tx, requireActiveSecret);
    const databaseIdentitySha256 = await this.liveDatabaseIdentitySha256(tx);
    return { counts, databaseIdentitySha256 };
  }

  async inspect(): Promise<AuthRecoverySecretRotationEvidence> {
    return this.prisma.$transaction(
      async (tx) => this.lockedEvidence(tx, true),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  }

  async rotate(
    expected: AuthRecoverySecretRotationCounts,
    expectedDatabaseIdentitySha256: string,
  ): Promise<AuthRecoverySecretRotationEvidence> {
    assertCounts(expected, 'expected');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
      const before = await this.lockedEvidence(tx, true);
      if (before.databaseIdentitySha256 !== expectedDatabaseIdentitySha256) {
        throw new Error(
          'Auth recovery secret rotation refused: live database/schema identity changed after the reviewed dry-run',
        );
      }
      if (!countsEqual(before.counts, expected)) {
        throw new Error(
          'Auth recovery secret rotation refused: database counts changed after the reviewed dry-run',
        );
      }

      const terminated = await tx.$executeRaw`
        UPDATE "PasswordRecoveryRequest"
        SET
          "deliveryState" = CASE
            WHEN "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
              THEN 'UNCERTAIN'::"PasswordRecoveryDeliveryState"
            ELSE "deliveryState"
          END,
          "claimToken" = CASE
            WHEN "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState" THEN NULL
            ELSE "claimToken"
          END,
          "deliveryFinalizedAt" = CASE
            WHEN "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
              THEN CURRENT_TIMESTAMP
            ELSE "deliveryFinalizedAt"
          END,
          "terminatedAt" = CURRENT_TIMESTAMP,
          "terminationReason" = 'KEY_ROTATED'::"PasswordRecoveryTerminationReason",
          "nextDeliveryAttemptAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "deliveryState" <> 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
          AND "terminatedAt" IS NULL
      `;
      const legacySlotsCleared = await tx.$executeRaw`
        UPDATE "User"
        SET "resetToken" = NULL, "resetTokenExpiry" = NULL
        WHERE "resetToken" IS NOT NULL OR "resetTokenExpiry" IS NOT NULL
      `;
      const requestEvidenceRedacted = await tx.$executeRaw`
        UPDATE "PasswordRecoveryRequest"
        SET
          "identifierDigest" = NULL,
          "requestIpDigest" = NULL,
          "requestNetworkDigest" = NULL,
          "rateKeyVersion" = NULL,
          "requestEvidenceRedactedAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "identifierDigest" IS NOT NULL
          OR "requestIpDigest" IS NOT NULL
          OR "requestNetworkDigest" IS NOT NULL
          OR "rateKeyVersion" IS NOT NULL
      `;
      const rateBucketsDeleted = await tx.$executeRaw`
        DELETE FROM "AuthRecoveryRateLimitBucket"
      `;
      const retiredFingerprintRecorded = await tx.$executeRaw`
        INSERT INTO "AuthRecoveryRetiredSecret" (
          "fingerprint", "retiredGeneration", "retiredAt"
        )
        SELECT "activeSecretFingerprint", "generation", CURRENT_TIMESTAMP
        FROM "AuthRecoveryControl"
        WHERE "id" = 1
          AND NOT "blocked"
          AND "generation" = ${expected.generation}
          AND "activeSecretFingerprint" = ${this.secretFingerprint}
      `;
      const controlBlocked = await tx.$executeRaw`
        UPDATE "AuthRecoveryControl"
        SET
          "blocked" = TRUE,
          "generation" = "generation" + 1,
          "retiredSecretFingerprint" = "activeSecretFingerprint",
          "activeSecretFingerprint" = NULL,
          "blockedAt" = CURRENT_TIMESTAMP,
          "activatedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = 1
          AND NOT "blocked"
          AND "generation" = ${expected.generation}
          AND "activeSecretFingerprint" = ${this.secretFingerprint}
      `;

      if (
        terminated !== expected.capabilities ||
        requestEvidenceRedacted !== expected.requestEvidenceRows ||
        legacySlotsCleared !== expected.legacySlots ||
        rateBucketsDeleted !== expected.rateBuckets ||
        retiredFingerprintRecorded !== 1 ||
        controlBlocked !== 1
      ) {
        throw new Error('Auth recovery secret rotation refused: mutation counts changed unexpectedly');
      }

      const after = await this.lockedEvidence(tx, false);
      if (
        after.databaseIdentitySha256 !== expectedDatabaseIdentitySha256 ||
        after.counts.generation !== expected.generation + 1 ||
        after.counts.capabilities !== 0 ||
        after.counts.requestEvidenceRows !== 0 ||
        after.counts.legacySlots !== 0 ||
        after.counts.rateBuckets !== 0 ||
        after.counts.securityNotices !== expected.securityNotices
      ) {
        throw new Error('Auth recovery secret rotation refused: atomic postconditions failed');
      }
          return before;
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        });
      } catch (error) {
        if (attempt === 0 && isSerializableConflict(error)) continue;
        throw error;
      }
    }
    throw new Error('Auth recovery secret rotation exhausted its serialization retry');
  }

  async activate(
    expectedGeneration: number,
    expectedDatabaseIdentitySha256: string,
  ): Promise<{ generation: number; securityNotices: number; databaseIdentitySha256: string }> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 2) {
      throw new Error('Auth recovery secret activation requires a valid blocked generation');
    }
    return this.prisma.$transaction(async (tx) => {
      const control = await lockAuthRecoveryControl(tx);
      if (!control.blocked || control.generation !== expectedGeneration) {
        throw new Error(
          'Auth recovery secret activation refused: blocked generation changed after review',
        );
      }
      if (control.retiredSecretFingerprint === this.secretFingerprint) {
        throw new Error(
          'Auth recovery secret activation refused: replacement matches the retired key',
        );
      }
      const retiredRows = await tx.$queryRaw<Array<{ retired: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM "AuthRecoveryRetiredSecret"
          WHERE "fingerprint" = ${this.secretFingerprint}
        ) AS "retired"
      `;
      if (retiredRows[0]?.retired === true) {
        throw new Error(
          'Auth recovery secret activation refused: replacement key was previously retired',
        );
      }
      const evidence = await this.lockedEvidence(tx, false);
      if (evidence.databaseIdentitySha256 !== expectedDatabaseIdentitySha256) {
        throw new Error(
          'Auth recovery secret activation refused: live database/schema identity changed after review',
        );
      }
      const counts = evidence.counts;
      if (
        counts.generation !== expectedGeneration ||
        counts.capabilities !== 0 ||
        counts.requestEvidenceRows !== 0 ||
        counts.legacySlots !== 0 ||
        counts.rateBuckets !== 0
      ) {
        throw new Error(
          'Auth recovery secret activation refused: rotation zero postconditions are not intact',
        );
      }
      const activated = await tx.$executeRaw`
        UPDATE "AuthRecoveryControl"
        SET
          "blocked" = FALSE,
          "activeSecretFingerprint" = ${this.secretFingerprint},
          "blockedAt" = NULL,
          "activatedAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = 1
          AND "blocked"
          AND "generation" = ${expectedGeneration}
          AND "activeSecretFingerprint" IS NULL
          AND "retiredSecretFingerprint" IS DISTINCT FROM ${this.secretFingerprint}
      `;
      if (activated !== 1) {
        throw new Error('Auth recovery secret activation lost its exact control fence');
      }
      return {
        generation: expectedGeneration,
        securityNotices: counts.securityNotices,
        databaseIdentitySha256: evidence.databaseIdentitySha256,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    });
  }
}

export async function runAuthRecoverySecretRotation(
  store: AuthRecoverySecretRotationStore,
  command: AuthRecoverySecretRotationCommand,
  env: Record<string, string | undefined> = process.env,
) {
  assertCommand(command);
  const currentDeploymentProfile = authRecoveryDeploymentProfile(env);
  if (
    command.mode !== 'dry-run' &&
    command.expectedDeploymentProfile !== currentDeploymentProfile
  ) {
    throw new Error(
      'Auth recovery secret rotation refused: deployment profile changed after the reviewed dry-run',
    );
  }
  if (command.mode === 'activate') {
    const activation = await store.activate(
      (command.expected as AuthRecoverySecretRotationCounts).generation,
      command.expectedDatabaseIdentitySha256 as string,
    );
    if (
      !Number.isSafeInteger(activation.generation) ||
      activation.generation < 2 ||
      !Number.isSafeInteger(activation.securityNotices) ||
      activation.securityNotices < 0 ||
      activation.databaseIdentitySha256 !== command.expectedDatabaseIdentitySha256
    ) {
      throw new Error('Auth recovery secret activation returned invalid database evidence');
    }
    return {
      mode: 'ACTIVATED' as const,
      mutationApplied: true,
      generation: activation.generation,
      recoveryBlocked: false,
      remainingCapabilities: 0,
      remainingRequestEvidenceRows: 0,
      remainingLegacySlots: 0,
      remainingRateBuckets: 0,
      securityNoticesPreserved: activation.securityNotices,
      reason: command.reason,
      caseReferenceSha256: createHash('sha256').update(command.caseReference).digest('hex'),
      databaseIdentitySha256: activation.databaseIdentitySha256,
      deploymentProfile: currentDeploymentProfile,
      activationConfirmation: command.activationConfirmation,
      credentialsIssued: false,
    };
  }
  const evidence = command.mode === 'dry-run'
    ? await store.inspect()
    : await store.rotate(
      command.expected as AuthRecoverySecretRotationCounts,
      command.expectedDatabaseIdentitySha256 as string,
    );
  const counts = evidence.counts;
  assertCounts(counts, 'result');
  if (
    !/^[a-f0-9]{64}$/u.test(evidence.databaseIdentitySha256) ||
    (
      command.mode === 'execute' &&
      evidence.databaseIdentitySha256 !== command.expectedDatabaseIdentitySha256
    )
  ) {
    throw new Error(
      'Auth recovery secret rotation refused: live database/schema identity changed after review',
    );
  }
  const databaseIdentitySha256 = evidence.databaseIdentitySha256;
  const common = {
    reason: command.reason,
    terminationReason: 'KEY_ROTATED' as const,
    securityNoticesPreserved: counts.securityNotices,
    caseReferenceSha256: createHash('sha256').update(command.caseReference).digest('hex'),
    databaseIdentitySha256,
    deploymentProfile: currentDeploymentProfile,
    executionConfirmation: authRecoverySecretRotationConfirmation(
      command.reason,
      counts,
      databaseIdentitySha256,
      currentDeploymentProfile,
    ),
    credentialsIssued: false,
  };
  if (command.mode === 'dry-run') {
    return {
      mode: 'DRY_RUN' as const,
      mutationApplied: false,
      ...counts,
      ...common,
    };
  }
  return {
    mode: 'EXECUTED' as const,
    mutationApplied: true,
    recoveryBlocked: true,
    rotatedGeneration: counts.generation,
    blockedGeneration: counts.generation + 1,
    activationConfirmation: authRecoverySecretActivationConfirmation(
      command.reason,
      counts.generation + 1,
      databaseIdentitySha256,
      currentDeploymentProfile,
    ),
    invalidatedCapabilities: counts.capabilities,
    redactedRequestEvidenceRows: counts.requestEvidenceRows,
    clearedLegacySlots: counts.legacySlots,
    deletedRateBuckets: counts.rateBuckets,
    securityNotices: counts.securityNotices,
    remainingCapabilities: 0,
    remainingRequestEvidenceRows: 0,
    remainingLegacySlots: 0,
    remainingRateBuckets: 0,
    ...common,
  };
}

async function main() {
  const command = parseAuthRecoverySecretRotationArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    process.stderr.write(
      '[auth-recovery-secret-rotation] Restricted quiesced workflow. Do not place secrets, database URLs, or recovery tokens in arguments or logs.\n',
    );
    const result = await runAuthRecoverySecretRotation(
      new PrismaAuthRecoverySecretRotationStore(prisma),
      command,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `[auth-recovery-secret-rotation] ${JSON.stringify(serializeErrorForLog(error))}\n`,
    );
    process.exitCode = 1;
  });
}
