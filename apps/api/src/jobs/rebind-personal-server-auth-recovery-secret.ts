import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { lockAuthRecoveryControl } from '../services/auth-recovery-control.js';
import { authRecoverySecretFingerprint } from '../services/password-recovery-crypto.js';
import { serializeErrorForLog } from '../utils/logger.js';
import {
  authRecoveryDatabaseIdentitySha256,
  type AuthRecoveryLiveDatabaseTarget,
} from './rotate-auth-recovery-secret.js';

const OUTPUT_FORMAT = 'charitypilot-personal-replacement-auth-rebind/v1';
const RECOVERY_SET_ID = /^personal-server-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VALUE_OPTIONS = new Set([
  '--recovery-set-id',
  '--manifest-sha256',
  '--expected-control-state',
  '--expected-generation',
  '--expected-capabilities',
  '--expected-request-evidence-rows',
  '--expected-legacy-slots',
  '--expected-rate-buckets',
  '--expected-security-notices',
  '--expected-retired-secrets',
  '--expected-database-identity-sha256',
  '--confirm-execute',
]);
const FLAG_OPTIONS = new Set([
  '--dry-run',
  '--execute',
  '--confirm-api-and-scheduler-quiesced',
]);

export type PersonalServerReplacementControlState = 'unbound' | 'active' | 'blocked';

export type PersonalServerReplacementRebindCounts = {
  capabilities: number;
  requestEvidenceRows: number;
  legacySlots: number;
  rateBuckets: number;
  securityNotices: number;
  retiredSecrets: number;
};

export type PersonalServerReplacementRebindEvidence = {
  controlState: PersonalServerReplacementControlState;
  generation: number;
  counts: PersonalServerReplacementRebindCounts;
  databaseIdentitySha256: string;
};

export type PersonalServerReplacementRebindCommand = {
  mode: 'dry-run' | 'execute';
  recoverySetId: string;
  manifestSha256: string;
  apiAndSchedulerQuiesced: true;
  expected?: PersonalServerReplacementRebindEvidence;
  executionConfirmation?: string;
};

export type PersonalServerReplacementRebindMutation = {
  before: PersonalServerReplacementRebindEvidence;
  after: PersonalServerReplacementRebindEvidence;
  priorActiveFingerprintRetired: boolean;
};

export type PersonalServerReplacementRebindStore = {
  inspect(): Promise<PersonalServerReplacementRebindEvidence>;
  rebind(
    expected: PersonalServerReplacementRebindEvidence,
  ): Promise<PersonalServerReplacementRebindMutation>;
};

type ControlRow = Awaited<ReturnType<typeof lockAuthRecoveryControl>>;

type RebindCountRow = {
  capabilities: bigint | number;
  requestEvidenceRows: bigint | number;
  legacySlots: bigint | number;
  rateBuckets: bigint | number;
  securityNotices: bigint | number;
  retiredSecrets: bigint | number;
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

function canonicalRecoverySetId(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!RECOVERY_SET_ID.test(normalized)) {
    throw new Error(
      '--recovery-set-id must be an exact personal-server recovery-set identifier',
    );
  }
  return normalized;
}

function canonicalSha256(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? '';
  if (!SHA256.test(normalized)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function countOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`${name} must be a safe integer`);
  return count;
}

function controlStateOption(
  value: string | undefined,
): PersonalServerReplacementControlState | undefined {
  if (value === undefined) return undefined;
  if (value !== 'unbound' && value !== 'active' && value !== 'blocked') {
    throw new Error(
      '--expected-control-state must be exactly unbound, active, or blocked',
    );
  }
  return value;
}

function assertCounts(
  counts: PersonalServerReplacementRebindCounts,
  label: string,
): void {
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Personal-server recovery-secret rebind refused: ${label} ${name} is invalid`);
    }
  }
}

function assertEvidence(
  evidence: PersonalServerReplacementRebindEvidence,
  label: string,
): void {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error(`Personal-server recovery-secret rebind refused: ${label} evidence is required`);
  }
  if (
    evidence.controlState !== 'unbound' &&
    evidence.controlState !== 'active' &&
    evidence.controlState !== 'blocked'
  ) {
    throw new Error(`Personal-server recovery-secret rebind refused: ${label} control state is invalid`);
  }
  if (!Number.isSafeInteger(evidence.generation) || evidence.generation < 1) {
    throw new Error(`Personal-server recovery-secret rebind refused: ${label} generation is invalid`);
  }
  assertCounts(evidence.counts, label);
  if (!SHA256.test(evidence.databaseIdentitySha256)) {
    throw new Error(
      `Personal-server recovery-secret rebind refused: ${label} database identity is invalid`,
    );
  }
  if (evidence.counts.retiredSecrets !== evidence.generation - 1) {
    throw new Error(
      `Personal-server recovery-secret rebind refused: ${label} retired history does not match the generation`,
    );
  }
  if (
    evidence.controlState === 'unbound' &&
    (evidence.generation !== 1 || evidence.counts.retiredSecrets !== 0)
  ) {
    throw new Error(
      `Personal-server recovery-secret rebind refused: ${label} unbound control is not pristine generation 1`,
    );
  }
  if (
    evidence.controlState === 'blocked' &&
    (
      evidence.counts.capabilities !== 0 ||
      evidence.counts.requestEvidenceRows !== 0 ||
      evidence.counts.legacySlots !== 0 ||
      evidence.counts.rateBuckets !== 0
    )
  ) {
    throw new Error(
      `Personal-server recovery-secret rebind refused: ${label} blocked control has non-zero invalidation postconditions`,
    );
  }
}

function evidenceEqual(
  left: PersonalServerReplacementRebindEvidence,
  right: PersonalServerReplacementRebindEvidence,
): boolean {
  return left.controlState === right.controlState &&
    left.generation === right.generation &&
    left.databaseIdentitySha256 === right.databaseIdentitySha256 &&
    left.counts.capabilities === right.counts.capabilities &&
    left.counts.requestEvidenceRows === right.counts.requestEvidenceRows &&
    left.counts.legacySlots === right.counts.legacySlots &&
    left.counts.rateBuckets === right.counts.rateBuckets &&
    left.counts.securityNotices === right.counts.securityNotices &&
    left.counts.retiredSecrets === right.counts.retiredSecrets;
}

export function personalServerReplacementRebindConfirmation(
  recoverySetId: string,
  manifestSha256: string,
  evidence: PersonalServerReplacementRebindEvidence,
): string {
  const canonicalId = canonicalRecoverySetId(recoverySetId);
  const canonicalManifest = canonicalSha256(manifestSha256, 'manifestSha256');
  assertEvidence(evidence, 'confirmation');
  return [
    'REBIND PERSONAL SERVER AUTH RECOVERY SECRET',
    `RECOVERY SET ${canonicalId}`,
    `MANIFEST SHA256 ${canonicalManifest}`,
    `CONTROL ${evidence.controlState}`,
    `GENERATION ${evidence.generation}`,
    `TERMINATE ${evidence.counts.capabilities} CAPABILITIES`,
    `REDACT ${evidence.counts.requestEvidenceRows} REQUEST EVIDENCE ROWS`,
    `CLEAR ${evidence.counts.legacySlots} LEGACY SLOTS`,
    `DELETE ${evidence.counts.rateBuckets} RATE BUCKETS`,
    `PRESERVE ${evidence.counts.securityNotices} SECURITY NOTICES`,
    `RETIRED HISTORY ${evidence.counts.retiredSecrets}`,
    `DATABASE SHA256 ${evidence.databaseIdentitySha256}`,
    'PROFILE personal-server',
  ].join(' ');
}

export function parsePersonalServerReplacementRebindArgs(
  args: string[],
): PersonalServerReplacementRebindCommand {
  const allowed = new Set([...VALUE_OPTIONS, ...FLAG_OPTIONS]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (VALUE_OPTIONS.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
    }
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
  if (!args.includes('--confirm-api-and-scheduler-quiesced')) {
    throw new Error('--confirm-api-and-scheduler-quiesced is required');
  }

  const recoverySetId = canonicalRecoverySetId(optionValue(args, '--recovery-set-id'));
  const manifestSha256 = canonicalSha256(
    optionValue(args, '--manifest-sha256'),
    '--manifest-sha256',
  );
  const expectedControlState = controlStateOption(
    optionValue(args, '--expected-control-state'),
  );
  const expectedGeneration = countOption(
    optionValue(args, '--expected-generation'),
    '--expected-generation',
  );
  const expectedCountValues = {
    capabilities: countOption(
      optionValue(args, '--expected-capabilities'),
      '--expected-capabilities',
    ),
    requestEvidenceRows: countOption(
      optionValue(args, '--expected-request-evidence-rows'),
      '--expected-request-evidence-rows',
    ),
    legacySlots: countOption(
      optionValue(args, '--expected-legacy-slots'),
      '--expected-legacy-slots',
    ),
    rateBuckets: countOption(
      optionValue(args, '--expected-rate-buckets'),
      '--expected-rate-buckets',
    ),
    securityNotices: countOption(
      optionValue(args, '--expected-security-notices'),
      '--expected-security-notices',
    ),
    retiredSecrets: countOption(
      optionValue(args, '--expected-retired-secrets'),
      '--expected-retired-secrets',
    ),
  };
  const expectedDatabaseIdentitySha256 = optionValue(
    args,
    '--expected-database-identity-sha256',
  );
  const executionConfirmation = optionValue(args, '--confirm-execute')?.trim();
  const hasAnyExecuteAuthority = expectedControlState !== undefined ||
    expectedGeneration !== undefined ||
    Object.values(expectedCountValues).some((value) => value !== undefined) ||
    expectedDatabaseIdentitySha256 !== undefined ||
    executionConfirmation !== undefined;

  if (dryRun) {
    if (hasAnyExecuteAuthority) {
      throw new Error('Execute-only evidence and confirmation must not be supplied with --dry-run');
    }
    return {
      mode: 'dry-run',
      recoverySetId,
      manifestSha256,
      apiAndSchedulerQuiesced: true,
    };
  }

  if (
    expectedControlState === undefined ||
    expectedGeneration === undefined ||
    Object.values(expectedCountValues).some((value) => value === undefined) ||
    expectedDatabaseIdentitySha256 === undefined
  ) {
    throw new Error('--execute requires the complete exact evidence emitted by the reviewed dry-run');
  }
  const expected: PersonalServerReplacementRebindEvidence = {
    controlState: expectedControlState,
    generation: expectedGeneration,
    counts: expectedCountValues as PersonalServerReplacementRebindCounts,
    databaseIdentitySha256: canonicalSha256(
      expectedDatabaseIdentitySha256,
      '--expected-database-identity-sha256',
    ),
  };
  assertEvidence(expected, 'expected');
  const requiredConfirmation = personalServerReplacementRebindConfirmation(
    recoverySetId,
    manifestSha256,
    expected,
  );
  if (executionConfirmation !== requiredConfirmation) {
    throw new Error(`--confirm-execute must exactly equal "${requiredConfirmation}"`);
  }
  return {
    mode: 'execute',
    recoverySetId,
    manifestSha256,
    apiAndSchedulerQuiesced: true,
    expected,
    executionConfirmation,
  };
}

function assertCommand(command: PersonalServerReplacementRebindCommand): void {
  if (!command || typeof command !== 'object') {
    throw new Error('Personal-server recovery-secret rebind refused: command is required');
  }
  if (command.mode !== 'dry-run' && command.mode !== 'execute') {
    throw new Error('Personal-server recovery-secret rebind refused: invalid mode');
  }
  if (canonicalRecoverySetId(command.recoverySetId) !== command.recoverySetId) {
    throw new Error('Personal-server recovery-secret rebind refused: recovery-set id is not canonical');
  }
  if (
    canonicalSha256(command.manifestSha256, 'manifestSha256') !== command.manifestSha256
  ) {
    throw new Error('Personal-server recovery-secret rebind refused: manifest digest is not canonical');
  }
  if (command.apiAndSchedulerQuiesced !== true) {
    throw new Error('Personal-server recovery-secret rebind refused: API and scheduler must be quiesced');
  }
  if (command.mode === 'dry-run') {
    if (command.expected !== undefined || command.executionConfirmation !== undefined) {
      throw new Error('Personal-server recovery-secret rebind refused: dry-run contains execute authority');
    }
    return;
  }
  if (!command.expected) {
    throw new Error('Personal-server recovery-secret rebind refused: reviewed evidence is required');
  }
  assertEvidence(command.expected, 'expected');
  if (
    command.executionConfirmation !==
    personalServerReplacementRebindConfirmation(
      command.recoverySetId,
      command.manifestSha256,
      command.expected,
    )
  ) {
    throw new Error('Personal-server recovery-secret rebind refused: execution confirmation is invalid');
  }
}

export function assertPersonalServerReplacementRebindEnvironment(
  env: Record<string, string | undefined>,
): void {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Personal-server recovery-secret rebind refused: NODE_ENV must be production');
  }
  if (env.CHARITYPILOT_DEPLOYMENT_MODE !== 'personal-server') {
    throw new Error(
      'Personal-server recovery-secret rebind refused: CHARITYPILOT_DEPLOYMENT_MODE must be personal-server',
    );
  }
  authRecoverySecretFingerprint(env.AUTH_RECOVERY_SECRET);
  const replacement = env.AUTH_RECOVERY_SECRET?.trim();
  if (
    !replacement ||
    replacement === env.JWT_SECRET?.trim() ||
    replacement === env.READINESS_API_KEY?.trim()
  ) {
    throw new Error(
      'Personal-server recovery-secret rebind refused: AUTH_RECOVERY_SECRET must be independent',
    );
  }
}

function fingerprintsEqual(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function controlState(control: ControlRow): PersonalServerReplacementControlState {
  if (
    control.blocked &&
    control.activeSecretFingerprint === null &&
    control.retiredSecretFingerprint !== null
  ) return 'blocked';
  if (
    !control.blocked &&
    control.generation === 1 &&
    control.activeSecretFingerprint === null &&
    control.retiredSecretFingerprint === null
  ) return 'unbound';
  if (
    !control.blocked &&
    control.activeSecretFingerprint !== null &&
    (
      control.retiredSecretFingerprint === null ||
      !fingerprintsEqual(
        control.activeSecretFingerprint,
        control.retiredSecretFingerprint,
      )
    )
  ) return 'active';
  throw new Error(
    'Personal-server recovery-secret rebind refused: authentication recovery control state is invalid',
  );
}

function countsFromRow(row: RebindCountRow | undefined): PersonalServerReplacementRebindCounts {
  if (!row) {
    throw new Error('Personal-server recovery-secret rebind count query returned no row');
  }
  const counts = {
    capabilities: Number(row.capabilities),
    requestEvidenceRows: Number(row.requestEvidenceRows),
    legacySlots: Number(row.legacySlots),
    rateBuckets: Number(row.rateBuckets),
    securityNotices: Number(row.securityNotices),
    retiredSecrets: Number(row.retiredSecrets),
  };
  assertCounts(counts, 'database');
  return counts;
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

export class PrismaPersonalServerReplacementRebindStore
implements PersonalServerReplacementRebindStore {
  private readonly replacementFingerprint: string;

  constructor(
    private readonly prisma: PrismaClient,
    replacementSecret = process.env.AUTH_RECOVERY_SECRET,
  ) {
    this.replacementFingerprint = authRecoverySecretFingerprint(replacementSecret);
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
        'Personal-server recovery-secret rebind refused: live database/schema identity is unavailable',
      );
    }
    const target: AuthRecoveryLiveDatabaseTarget = {
      ...row,
      schemaName: row.schemaName,
      schemaOid: row.schemaOid,
      serverAddress: row.serverAddress ?? 'local-socket',
      serverPort: row.serverPort ?? 0,
    };
    return authRecoveryDatabaseIdentitySha256(target);
  }

  private async lockedSnapshot(
    tx: Prisma.TransactionClient,
  ): Promise<{ control: ControlRow; evidence: PersonalServerReplacementRebindEvidence }> {
    const control = await lockAuthRecoveryControl(tx);
    await tx.$executeRaw`
      LOCK TABLE
        "AuthRecoveryControl",
        "PasswordRecoveryRequest",
        "AuthRecoveryRateLimitBucket",
        "User",
        "AuthRecoveryRetiredSecret",
        "AuthSecurityEmailOutbox"
      IN SHARE ROW EXCLUSIVE MODE
    `;
    const rows = await tx.$queryRaw<RebindCountRow[]>`
      SELECT
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
        (SELECT COUNT(*) FROM "AuthSecurityEmailOutbox") AS "securityNotices",
        (SELECT COUNT(*) FROM "AuthRecoveryRetiredSecret") AS "retiredSecrets"
    `;
    const evidence = {
      controlState: controlState(control),
      generation: control.generation,
      counts: countsFromRow(rows[0]),
      databaseIdentitySha256: await this.liveDatabaseIdentitySha256(tx),
    };
    assertEvidence(evidence, 'database');
    return { control, evidence };
  }

  private async assertFreshReplacement(
    tx: Prisma.TransactionClient,
    control: ControlRow,
  ): Promise<void> {
    if (
      control.activeSecretFingerprint !== null &&
      fingerprintsEqual(control.activeSecretFingerprint, this.replacementFingerprint)
    ) {
      throw new Error(
        'Personal-server recovery-secret rebind refused: replacement secret is already the active secret',
      );
    }
    if (
      control.retiredSecretFingerprint !== null &&
      fingerprintsEqual(control.retiredSecretFingerprint, this.replacementFingerprint)
    ) {
      throw new Error(
        'Personal-server recovery-secret rebind refused: replacement secret matches the retired secret',
      );
    }
    const rows = await tx.$queryRaw<Array<{ retired: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "AuthRecoveryRetiredSecret"
        WHERE "fingerprint" = ${this.replacementFingerprint}
      ) AS "retired"
    `;
    if (rows.length !== 1 || typeof rows[0]?.retired !== 'boolean') {
      throw new Error(
        'Personal-server recovery-secret rebind refused: retired-secret lookup returned invalid evidence',
      );
    }
    if (rows[0].retired) {
      throw new Error(
        'Personal-server recovery-secret rebind refused: replacement secret was previously retired',
      );
    }
  }

  async inspect(): Promise<PersonalServerReplacementRebindEvidence> {
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await this.lockedSnapshot(tx);
      await this.assertFreshReplacement(tx, snapshot.control);
      return snapshot.evidence;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    });
  }

  async rebind(
    expected: PersonalServerReplacementRebindEvidence,
  ): Promise<PersonalServerReplacementRebindMutation> {
    assertEvidence(expected, 'expected');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const before = await this.lockedSnapshot(tx);
          if (!evidenceEqual(before.evidence, expected)) {
            throw new Error(
              'Personal-server recovery-secret rebind refused: database evidence changed after the reviewed dry-run',
            );
          }
          await this.assertFreshReplacement(tx, before.control);

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
          const legacySlotsCleared = await tx.$executeRaw`
            UPDATE "User"
            SET "resetToken" = NULL, "resetTokenExpiry" = NULL
            WHERE "resetToken" IS NOT NULL OR "resetTokenExpiry" IS NOT NULL
          `;
          const rateBucketsDeleted = await tx.$executeRaw`
            DELETE FROM "AuthRecoveryRateLimitBucket"
          `;

          let priorActiveFingerprintRetired = false;
          if (before.evidence.controlState === 'active') {
            const retired = await tx.$executeRaw`
              INSERT INTO "AuthRecoveryRetiredSecret" (
                "fingerprint", "retiredGeneration", "retiredAt"
              )
              SELECT "activeSecretFingerprint", "generation", CURRENT_TIMESTAMP
              FROM "AuthRecoveryControl"
              WHERE "id" = 1
                AND NOT "blocked"
                AND "generation" = ${before.evidence.generation}
                AND "activeSecretFingerprint" = ${before.control.activeSecretFingerprint}
            `;
            const blocked = await tx.$executeRaw`
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
                AND "generation" = ${before.evidence.generation}
                AND "activeSecretFingerprint" = ${before.control.activeSecretFingerprint}
            `;
            if (retired !== 1 || blocked !== 1) {
              throw new Error(
                'Personal-server recovery-secret rebind refused: prior active-secret retirement lost its exact fence',
              );
            }
            priorActiveFingerprintRetired = true;
          }

          const finalGeneration = before.evidence.generation +
            (before.evidence.controlState === 'active' ? 1 : 0);
          let activated: number;
          if (before.evidence.controlState === 'unbound') {
            activated = await tx.$executeRaw`
              UPDATE "AuthRecoveryControl"
              SET
                "activeSecretFingerprint" = ${this.replacementFingerprint},
                "activatedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = 1
                AND NOT "blocked"
                AND "generation" = 1
                AND "activeSecretFingerprint" IS NULL
                AND "retiredSecretFingerprint" IS NULL
            `;
          } else {
            activated = await tx.$executeRaw`
              UPDATE "AuthRecoveryControl"
              SET
                "blocked" = FALSE,
                "activeSecretFingerprint" = ${this.replacementFingerprint},
                "blockedAt" = NULL,
                "activatedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = 1
                AND "blocked"
                AND "generation" = ${finalGeneration}
                AND "activeSecretFingerprint" IS NULL
                AND "retiredSecretFingerprint" IS DISTINCT FROM ${this.replacementFingerprint}
            `;
          }
          if (
            terminated !== before.evidence.counts.capabilities ||
            requestEvidenceRedacted !== before.evidence.counts.requestEvidenceRows ||
            legacySlotsCleared !== before.evidence.counts.legacySlots ||
            rateBucketsDeleted !== before.evidence.counts.rateBuckets ||
            activated !== 1
          ) {
            throw new Error(
              'Personal-server recovery-secret rebind refused: mutation counts changed unexpectedly',
            );
          }

          const after = await this.lockedSnapshot(tx);
          const expectedRetiredSecrets = before.evidence.counts.retiredSecrets +
            (before.evidence.controlState === 'active' ? 1 : 0);
          if (
            after.evidence.controlState !== 'active' ||
            after.evidence.generation !== finalGeneration ||
            after.evidence.databaseIdentitySha256 !== before.evidence.databaseIdentitySha256 ||
            after.evidence.counts.capabilities !== 0 ||
            after.evidence.counts.requestEvidenceRows !== 0 ||
            after.evidence.counts.legacySlots !== 0 ||
            after.evidence.counts.rateBuckets !== 0 ||
            after.evidence.counts.securityNotices !== before.evidence.counts.securityNotices ||
            after.evidence.counts.retiredSecrets !== expectedRetiredSecrets ||
            after.control.activeSecretFingerprint === null ||
            !fingerprintsEqual(
              after.control.activeSecretFingerprint,
              this.replacementFingerprint,
            )
          ) {
            throw new Error(
              'Personal-server recovery-secret rebind refused: atomic postconditions failed',
            );
          }
          return {
            before: before.evidence,
            after: after.evidence,
            priorActiveFingerprintRetired,
          };
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
    throw new Error('Personal-server recovery-secret rebind exhausted its serialization retry');
  }
}

export async function runPersonalServerReplacementRebind(
  store: PersonalServerReplacementRebindStore,
  command: PersonalServerReplacementRebindCommand,
  env: Record<string, string | undefined> = process.env,
) {
  assertCommand(command);
  assertPersonalServerReplacementRebindEnvironment(env);

  if (command.mode === 'dry-run') {
    const evidence = await store.inspect();
    assertEvidence(evidence, 'dry-run');
    return {
      format: OUTPUT_FORMAT,
      mode: 'DRY_RUN' as const,
      mutationApplied: false,
      deploymentProfile: 'personal-server' as const,
      recoverySetId: command.recoverySetId,
      manifestSha256: command.manifestSha256,
      controlState: evidence.controlState,
      generation: evidence.generation,
      ...evidence.counts,
      databaseIdentitySha256: evidence.databaseIdentitySha256,
      executeConfirmation: personalServerReplacementRebindConfirmation(
        command.recoverySetId,
        command.manifestSha256,
        evidence,
      ),
      terminationReason: 'KEY_ROTATED' as const,
      recoveryBlockedAfterExecute: false,
      credentialsIssued: false,
    };
  }

  const expected = command.expected as PersonalServerReplacementRebindEvidence;
  const result = await store.rebind(expected);
  assertEvidence(result.before, 'execute before');
  assertEvidence(result.after, 'execute after');
  if (!evidenceEqual(result.before, expected)) {
    throw new Error(
      'Personal-server recovery-secret rebind refused: store returned different reviewed evidence',
    );
  }
  const expectedGeneration = expected.generation +
    (expected.controlState === 'active' ? 1 : 0);
  const expectedRetiredSecrets = expected.counts.retiredSecrets +
    (expected.controlState === 'active' ? 1 : 0);
  if (
    result.after.controlState !== 'active' ||
    result.after.generation !== expectedGeneration ||
    result.after.databaseIdentitySha256 !== expected.databaseIdentitySha256 ||
    result.after.counts.capabilities !== 0 ||
    result.after.counts.requestEvidenceRows !== 0 ||
    result.after.counts.legacySlots !== 0 ||
    result.after.counts.rateBuckets !== 0 ||
    result.after.counts.securityNotices !== expected.counts.securityNotices ||
    result.after.counts.retiredSecrets !== expectedRetiredSecrets ||
    result.priorActiveFingerprintRetired !== (expected.controlState === 'active')
  ) {
    throw new Error(
      'Personal-server recovery-secret rebind refused: store returned invalid final evidence',
    );
  }

  return {
    format: OUTPUT_FORMAT,
    mode: 'EXECUTED' as const,
    mutationApplied: true,
    deploymentProfile: 'personal-server' as const,
    recoverySetId: command.recoverySetId,
    manifestSha256: command.manifestSha256,
    previousControlState: expected.controlState,
    previousGeneration: expected.generation,
    generation: result.after.generation,
    invalidatedCapabilities: expected.counts.capabilities,
    redactedRequestEvidenceRows: expected.counts.requestEvidenceRows,
    clearedLegacySlots: expected.counts.legacySlots,
    deletedRateBuckets: expected.counts.rateBuckets,
    securityNoticesPreserved: result.after.counts.securityNotices,
    retiredSecrets: result.after.counts.retiredSecrets,
    priorActiveSecretRetired: result.priorActiveFingerprintRetired,
    remainingCapabilities: 0,
    remainingRequestEvidenceRows: 0,
    remainingLegacySlots: 0,
    remainingRateBuckets: 0,
    databaseIdentitySha256: result.after.databaseIdentitySha256,
    terminationReason: 'KEY_ROTATED' as const,
    recoveryBlocked: false,
    boundToReplacementSecret: true,
    credentialsIssued: false,
  };
}

async function main(): Promise<void> {
  const command = parsePersonalServerReplacementRebindArgs(process.argv.slice(2));
  assertPersonalServerReplacementRebindEnvironment(process.env);
  const prisma = new PrismaClient();
  try {
    process.stderr.write(
      '[personal-server-replacement-auth-rebind] Restricted quiesced replacement-host workflow. Do not place secrets, database URLs, or recovery tokens in arguments or logs.\n',
    );
    const result = await runPersonalServerReplacementRebind(
      new PrismaPersonalServerReplacementRebindStore(
        prisma,
        process.env.AUTH_RECOVERY_SECRET,
      ),
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
      `[personal-server-replacement-auth-rebind] ${JSON.stringify(serializeErrorForLog(error))}\n`,
    );
    process.exitCode = 1;
  });
}
