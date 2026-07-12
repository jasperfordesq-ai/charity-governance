import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  authRecoveryDatabaseIdentitySha256,
  authRecoverySecretActivationConfirmation,
  authRecoverySecretRotationConfirmation,
  parseAuthRecoverySecretRotationArgs,
  runAuthRecoverySecretRotation,
  type AuthRecoverySecretRotationCounts,
  type AuthRecoverySecretRotationStore,
} from '../jobs/rotate-auth-recovery-secret.js';

const COUNTS: AuthRecoverySecretRotationCounts = {
  generation: 1,
  capabilities: 7,
  requestEvidenceRows: 13,
  legacySlots: 2,
  rateBuckets: 11,
  securityNotices: 3,
};
const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  CHARITYPILOT_DEPLOYMENT_MODE: 'production',
  DATABASE_URL: 'postgresql://rotation_operator:strong-password@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full',
};
const LIVE_DATABASE_TARGET = {
  databaseName: 'charitypilot',
  databaseOid: '16384',
  schemaName: 'public',
  schemaOid: '2200',
  databaseUser: 'rotation_operator',
  serverAddress: '10.20.30.40',
  serverPort: 5432,
};
const DATABASE_IDENTITY_SHA256 = authRecoveryDatabaseIdentitySha256(LIVE_DATABASE_TARGET);
const EVIDENCE = { counts: COUNTS, databaseIdentitySha256: DATABASE_IDENTITY_SHA256 };

function dryRunArgs() {
  return [
    '--dry-run',
    '--reason',
    'SUSPECTED_KEY_COMPROMISE',
    '--operator',
    'Jasper Ford',
    '--case-reference',
    'INC-2026-0711',
    '--confirm-api-and-scheduler-quiesced',
  ];
}

function controlStatusArgs() {
  return [
    '--control-status',
    '--reason',
    'SUSPECTED_KEY_COMPROMISE',
    '--operator',
    'Jasper Ford',
    '--case-reference',
    'INC-2026-0711',
    '--confirm-api-and-scheduler-quiesced',
  ];
}

function executeArgs(counts = COUNTS) {
  const confirmation = authRecoverySecretRotationConfirmation(
    'SUSPECTED_KEY_COMPROMISE',
    counts,
    DATABASE_IDENTITY_SHA256,
  );
  return [
    '--execute',
    '--reason',
    'SUSPECTED_KEY_COMPROMISE',
    '--operator',
    'Jasper Ford',
    '--case-reference',
    'INC-2026-0711',
    '--confirm-api-and-scheduler-quiesced',
    '--confirm-outbox-preservation-understood',
    '--expected-capabilities',
    String(counts.capabilities),
    '--expected-generation',
    String(counts.generation),
    '--expected-request-evidence-rows',
    String(counts.requestEvidenceRows),
    '--expected-legacy-slots',
    String(counts.legacySlots),
    '--expected-rate-buckets',
    String(counts.rateBuckets),
    '--expected-security-notices',
    String(counts.securityNotices),
    '--expected-database-identity-sha256',
    DATABASE_IDENTITY_SHA256,
    '--expected-deployment-profile',
    'production',
    '--confirm-execute',
    confirmation,
  ];
}

function activationArgs(generation = 2) {
  return [
    '--activate-after-replacement',
    '--reason', 'SUSPECTED_KEY_COMPROMISE',
    '--operator', 'Jasper Ford',
    '--case-reference', 'INC-2026-0711',
    '--confirm-api-and-scheduler-quiesced',
    '--expected-generation', String(generation),
    '--expected-database-identity-sha256', DATABASE_IDENTITY_SHA256,
    '--expected-deployment-profile', 'production',
    '--confirm-activate', authRecoverySecretActivationConfirmation(
      'SUSPECTED_KEY_COMPROMISE',
      generation,
      DATABASE_IDENTITY_SHA256,
      'production',
    ),
  ];
}

test('rotation parser requires a quiesced dry-run and emits no execute authority', () => {
  assert.deepEqual(parseAuthRecoverySecretRotationArgs(dryRunArgs()), {
    mode: 'dry-run',
    reason: 'SUSPECTED_KEY_COMPROMISE',
    operator: 'Jasper Ford',
    caseReference: 'INC-2026-0711',
    apiAndSchedulerQuiesced: true,
    outboxPreservationUnderstood: false,
  });
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs(dryRunArgs().filter(
      (argument) => argument !== '--confirm-api-and-scheduler-quiesced',
    )),
    /--confirm-api-and-scheduler-quiesced is required/,
  );
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs([...dryRunArgs(), '--expected-capabilities', '7']),
    /Execution-only counts and confirmations/,
  );
});

test('control status requires named quiesced operator evidence and carries no mutation authority', () => {
  assert.deepEqual(parseAuthRecoverySecretRotationArgs(controlStatusArgs()), {
    mode: 'control-status',
    reason: 'SUSPECTED_KEY_COMPROMISE',
    operator: 'Jasper Ford',
    caseReference: 'INC-2026-0711',
    apiAndSchedulerQuiesced: true,
    outboxPreservationUnderstood: false,
  });
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs(controlStatusArgs().filter(
      (argument) => argument !== '--confirm-api-and-scheduler-quiesced',
    )),
    /--confirm-api-and-scheduler-quiesced is required/,
  );
  const unnamedOperator = controlStatusArgs();
  unnamedOperator[unnamedOperator.indexOf('--operator') + 1] = 'admin';
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs(unnamedOperator),
    /safe named human operator identity/,
  );
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs([
      ...controlStatusArgs(), '--expected-generation', '1',
    ]),
    /must not be supplied with --control-status/,
  );
});

test('rotation execute is bound to every reviewed count and an exact acknowledgement', () => {
  const command = parseAuthRecoverySecretRotationArgs(executeArgs());
  assert.deepEqual(command.expected, COUNTS);
  assert.equal(command.expectedDatabaseIdentitySha256, DATABASE_IDENTITY_SHA256);
  assert.equal(command.expectedDeploymentProfile, 'production');
  assert.equal(
    command.executionConfirmation,
    `ROTATE AUTH RECOVERY SECRET REASON SUSPECTED_KEY_COMPROMISE GENERATION 1 TERMINATE 7 CAPABILITIES REDACT 13 REQUEST EVIDENCE ROWS CLEAR 2 LEGACY SLOTS DELETE 11 RATE BUCKETS PRESERVE 3 SECURITY NOTICES DATABASE SHA256 ${DATABASE_IDENTITY_SHA256} PROFILE production`,
  );
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs(executeArgs().filter(
      (argument) => argument !== '--confirm-outbox-preservation-understood',
    )),
    /--confirm-outbox-preservation-understood is required/,
  );
  const wrong = executeArgs();
  wrong[wrong.length - 1] = 'ROTATE EVERYTHING';
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs(wrong),
    /--confirm-execute must exactly equal/,
  );
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs([...dryRunArgs(), '--surprise']),
    /Unknown option: --surprise/,
  );
});

test('replacement activation is bound to the blocked generation, database, profile, and exact acknowledgement', () => {
  const command = parseAuthRecoverySecretRotationArgs(activationArgs());
  assert.equal(command.mode, 'activate');
  assert.equal(command.expected?.generation, 2);
  assert.equal(command.expectedDatabaseIdentitySha256, DATABASE_IDENTITY_SHA256);
  assert.equal(command.expectedDeploymentProfile, 'production');
  assert.equal(
    command.activationConfirmation,
    authRecoverySecretActivationConfirmation(
      'SUSPECTED_KEY_COMPROMISE', 2, DATABASE_IDENTITY_SHA256, 'production',
    ),
  );
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs([
      ...activationArgs(), '--expected-capabilities', '0',
    ]),
    /must not be supplied with activation/,
  );
  const wrong = activationArgs();
  wrong[wrong.length - 1] = 'ACTIVATE ANYTHING';
  assert.throws(
    () => parseAuthRecoverySecretRotationArgs(wrong),
    /--confirm-activate must exactly equal/,
  );
});

test('live database identity distinguishes schemas within the same database authority', () => {
  assert.notEqual(
    DATABASE_IDENTITY_SHA256,
    authRecoveryDatabaseIdentitySha256({
      ...LIVE_DATABASE_TARGET,
      schemaName: 'shadow',
      schemaOid: '24576',
    }),
  );
  assert.throws(
    () => authRecoveryDatabaseIdentitySha256({
      ...LIVE_DATABASE_TARGET,
      schemaOid: '',
    }),
    /live database identity is invalid/,
  );
});

test('control status exposes only bounded reconciliation evidence for all three permitted lifecycle postures', async () => {
  const postures = [
    {
      label: 'reviewed old secret is still active',
      blocked: false,
      currentSecretActive: true,
      counts: COUNTS,
    },
    {
      label: 'rotation is blocked with zero postconditions',
      blocked: true,
      currentSecretActive: false,
      counts: {
        ...COUNTS,
        generation: COUNTS.generation + 1,
        capabilities: 0,
        requestEvidenceRows: 0,
        legacySlots: 0,
        rateBuckets: 0,
      },
    },
    {
      label: 'replacement secret is active with zero postconditions',
      blocked: false,
      currentSecretActive: true,
      counts: {
        ...COUNTS,
        generation: COUNTS.generation + 1,
        capabilities: 0,
        requestEvidenceRows: 0,
        legacySlots: 0,
        rateBuckets: 0,
      },
    },
  ] as const;

  for (const posture of postures) {
    let statusInspections = 0;
    const store: AuthRecoverySecretRotationStore = {
      async controlStatus() {
        statusInspections += 1;
        return {
          blocked: posture.blocked,
          currentSecretActive: posture.currentSecretActive,
          counts: posture.counts,
          databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
        };
      },
      async inspect() { throw new Error('control status must not use active-secret dry-run'); },
      async rotate() { throw new Error('control status must not rotate'); },
      async activate() { throw new Error('control status must not activate'); },
    };
    const result = await runAuthRecoverySecretRotation(
      store,
      parseAuthRecoverySecretRotationArgs(controlStatusArgs()),
      {
        ...PRODUCTION_ENV,
        AUTH_RECOVERY_SECRET: 'current-root-secret-that-must-not-leak',
      },
    );
    assert.equal(statusInspections, 1, posture.label);
    assert.equal(result.mode, 'CONTROL_STATUS', posture.label);
    assert.equal(result.mutationApplied, false, posture.label);
    assert.equal(result.blocked, posture.blocked, posture.label);
    assert.equal(result.generation, posture.counts.generation, posture.label);
    assert.equal(result.currentSecretActive, posture.currentSecretActive, posture.label);
    assert.equal(result.capabilities, posture.counts.capabilities, posture.label);
    assert.equal(result.requestEvidenceRows, posture.counts.requestEvidenceRows, posture.label);
    assert.equal(result.legacySlots, posture.counts.legacySlots, posture.label);
    assert.equal(result.rateBuckets, posture.counts.rateBuckets, posture.label);
    assert.equal(result.securityNotices, posture.counts.securityNotices, posture.label);
    assert.equal(result.databaseIdentitySha256, DATABASE_IDENTITY_SHA256, posture.label);
    assert.equal(result.deploymentProfile, 'production', posture.label);
    assert.match(result.caseReferenceSha256, /^[a-f0-9]{64}$/u, posture.label);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(
      serialized,
      /current-root-secret|activeSecretFingerprint|retiredSecretFingerprint|Jasper Ford|INC-2026-0711/u,
      posture.label,
    );
  }
});

test('control status fails closed before inspection without an explicit production deployment profile', async () => {
  let touched = false;
  const store: AuthRecoverySecretRotationStore = {
    async controlStatus() {
      touched = true;
      return {
        blocked: false,
        currentSecretActive: true,
        counts: COUNTS,
        databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
      };
    },
    async inspect() { throw new Error('must not inspect'); },
    async rotate() { throw new Error('must not rotate'); },
    async activate() { throw new Error('must not activate'); },
  };
  await assert.rejects(
    () => runAuthRecoverySecretRotation(
      store,
      parseAuthRecoverySecretRotationArgs(controlStatusArgs()),
      { NODE_ENV: 'development', CHARITYPILOT_DEPLOYMENT_MODE: 'production' },
    ),
    /NODE_ENV must be production/,
  );
  await assert.rejects(
    () => runAuthRecoverySecretRotation(
      store,
      parseAuthRecoverySecretRotationArgs(controlStatusArgs()),
      { NODE_ENV: 'production' },
    ),
    /CHARITYPILOT_DEPLOYMENT_MODE must be explicit/,
  );
  assert.equal(touched, false);
});

test('control status rejects internally inconsistent or unbounded store evidence', async () => {
  const baseStore = {
    async inspect() { throw new Error('must not inspect'); },
    async rotate() { throw new Error('must not rotate'); },
    async activate() { throw new Error('must not activate'); },
  };
  await assert.rejects(
    () => runAuthRecoverySecretRotation(
      {
        ...baseStore,
        async controlStatus() {
          return {
            blocked: true,
            currentSecretActive: true,
            counts: COUNTS,
            databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
          };
        },
      },
      parseAuthRecoverySecretRotationArgs(controlStatusArgs()),
      PRODUCTION_ENV,
    ),
    /control status is invalid/,
  );
  await assert.rejects(
    () => runAuthRecoverySecretRotation(
      {
        ...baseStore,
        async controlStatus() {
          return {
            blocked: false,
            currentSecretActive: false,
            counts: { ...COUNTS, capabilities: Number.MAX_SAFE_INTEGER + 1 },
            databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
          };
        },
      },
      parseAuthRecoverySecretRotationArgs(controlStatusArgs()),
      PRODUCTION_ENV,
    ),
    /control status capabilities count is invalid/,
  );
});

test('dry-run reports only bounded counts, reason, a case digest, and exact next acknowledgement', async () => {
  let inspected = 0;
  const store: AuthRecoverySecretRotationStore = {
    async controlStatus() { throw new Error('must not inspect control status'); },
    async inspect() { inspected += 1; return EVIDENCE; },
    async rotate() { throw new Error('must not execute'); },
    async activate() { throw new Error('must not activate'); },
  };
  const result = await runAuthRecoverySecretRotation(
    store,
    parseAuthRecoverySecretRotationArgs(dryRunArgs()),
    PRODUCTION_ENV,
  );
  assert.equal(inspected, 1);
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.mutationApplied, false);
  assert.equal(result.terminationReason, 'KEY_ROTATED');
  assert.equal(result.securityNoticesPreserved, 3);
  assert.equal(result.databaseIdentitySha256, DATABASE_IDENTITY_SHA256);
  assert.equal(result.deploymentProfile, 'production');
  assert.match(result.caseReferenceSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /Jasper Ford|INC-2026-0711/);
  assert.equal(
    result.executionConfirmation,
    authRecoverySecretRotationConfirmation(
      'SUSPECTED_KEY_COMPROMISE',
      COUNTS,
      DATABASE_IDENTITY_SHA256,
      'production',
    ),
  );
});

test('execute delegates only the reviewed counts and preserves completion notice evidence', async () => {
  let rotatedWith: AuthRecoverySecretRotationCounts | undefined;
  let rotatedDatabaseIdentity: string | undefined;
  const store: AuthRecoverySecretRotationStore = {
    async controlStatus() { throw new Error('must not inspect control status'); },
    async inspect() { throw new Error('execute must not use unlocked preview'); },
    async rotate(expected, expectedDatabaseIdentitySha256) {
      rotatedWith = expected;
      rotatedDatabaseIdentity = expectedDatabaseIdentitySha256;
      return EVIDENCE;
    },
    async activate() { throw new Error('must not activate'); },
  };
  const result = await runAuthRecoverySecretRotation(
    store,
    parseAuthRecoverySecretRotationArgs(executeArgs()),
    PRODUCTION_ENV,
  );
  assert.deepEqual(rotatedWith, COUNTS);
  assert.equal(rotatedDatabaseIdentity, DATABASE_IDENTITY_SHA256);
  assert.equal(result.mode, 'EXECUTED');
  assert.equal(result.mutationApplied, true);
  assert.equal(result.invalidatedCapabilities, COUNTS.capabilities);
  assert.equal(result.redactedRequestEvidenceRows, COUNTS.requestEvidenceRows);
  assert.equal(result.clearedLegacySlots, COUNTS.legacySlots);
  assert.equal(result.deletedRateBuckets, COUNTS.rateBuckets);
  assert.equal(result.remainingCapabilities, 0);
  assert.equal(result.remainingRequestEvidenceRows, 0);
  assert.equal(result.remainingLegacySlots, 0);
  assert.equal(result.remainingRateBuckets, 0);
  assert.equal(result.securityNotices, COUNTS.securityNotices);
  assert.equal(result.securityNoticesPreserved, COUNTS.securityNotices);
  assert.equal(result.credentialsIssued, false);
  assert.equal(result.recoveryBlocked, true);
  assert.equal(result.rotatedGeneration, 1);
  assert.equal(result.blockedGeneration, 2);
});

test('activation delegates only the reviewed generation and reports zero mutation postconditions', async () => {
  let activatedGeneration: number | undefined;
  let activatedDatabaseIdentity: string | undefined;
  const store: AuthRecoverySecretRotationStore = {
    async controlStatus() { throw new Error('must not inspect control status'); },
    async inspect() { throw new Error('must not inspect'); },
    async rotate() { throw new Error('must not rotate'); },
    async activate(generation, expectedDatabaseIdentitySha256) {
      activatedGeneration = generation;
      activatedDatabaseIdentity = expectedDatabaseIdentitySha256;
      return {
        generation,
        securityNotices: 3,
        databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
      };
    },
  };
  const result = await runAuthRecoverySecretRotation(
    store,
    parseAuthRecoverySecretRotationArgs(activationArgs()),
    PRODUCTION_ENV,
  );
  assert.equal(activatedGeneration, 2);
  assert.equal(activatedDatabaseIdentity, DATABASE_IDENTITY_SHA256);
  assert.equal(result.mode, 'ACTIVATED');
  assert.equal(result.generation, 2);
  assert.equal(result.recoveryBlocked, false);
  assert.equal(result.remainingCapabilities, 0);
  assert.equal(result.remainingRequestEvidenceRows, 0);
  assert.equal(result.remainingLegacySlots, 0);
  assert.equal(result.remainingRateBuckets, 0);
  assert.equal(result.securityNoticesPreserved, 3);
});

test('rotation refuses changed live database evidence and deployment profile drift', async () => {
  let touched = false;
  const store: AuthRecoverySecretRotationStore = {
    async controlStatus() { touched = true; throw new Error('unexpected control status'); },
    async inspect() { touched = true; return EVIDENCE; },
    async rotate() {
      touched = true;
      return {
        counts: COUNTS,
        databaseIdentitySha256: 'f'.repeat(64),
      };
    },
    async activate() {
      touched = true;
      return {
        generation: 2,
        securityNotices: 0,
        databaseIdentitySha256: 'f'.repeat(64),
      };
    },
  };
  await assert.rejects(
    () => runAuthRecoverySecretRotation(
      store,
      parseAuthRecoverySecretRotationArgs(executeArgs()),
      PRODUCTION_ENV,
    ),
    /live database\/schema identity changed after review/,
  );
  assert.equal(touched, true);
  touched = false;
  await assert.rejects(
    () => runAuthRecoverySecretRotation(
      store,
      parseAuthRecoverySecretRotationArgs(executeArgs()),
      { ...PRODUCTION_ENV, CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server' },
    ),
    /deployment profile changed after the reviewed dry-run/,
  );
  assert.equal(touched, false);
});

test('production rotation store atomically invalidates every capability without deleting notices', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'jobs', 'rotate-auth-recovery-secret.ts'),
    'utf8',
  );
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const compose = readFileSync(join(process.cwd(), '..', '..', 'compose.production.yml'), 'utf8');
  const personalCompose = readFileSync(
    join(process.cwd(), '..', '..', 'compose.personal-server.yml'),
    'utf8',
  );
  const controlSource = readFileSync(
    join(process.cwd(), 'src', 'services', 'auth-recovery-control.ts'),
    'utf8',
  );
  const serverSource = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');
  const schedulerSource = readFileSync(
    join(process.cwd(), 'src', 'jobs', 'production-scheduler.ts'),
    'utf8',
  );
  const deliveryWorkerSource = readFileSync(
    join(process.cwd(), 'src', 'jobs', 'process-auth-email-delivery.ts'),
    'utf8',
  );
  const controlStatusMethod = source.slice(
    source.indexOf('  async controlStatus()'),
    source.indexOf('  async inspect()', source.indexOf('  async controlStatus()')),
  );
  const controlStatusCountReader = source.slice(
    source.indexOf('  private async lockedCountsForGeneration('),
    source.indexOf('  private async lockedCounts(', source.indexOf('  private async lockedCountsForGeneration(')),
  );

  assert.match(source, /Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(
    source,
    /CURRENT_DATABASE\(\)[\s\S]*pg_catalog\.pg_database[\s\S]*CURRENT_SCHEMA\(\)[\s\S]*TO_REGNAMESPACE\(CURRENT_SCHEMA\(\)\)[\s\S]*INET_SERVER_ADDR\(\)[\s\S]*INET_SERVER_PORT\(\)/,
  );
  assert.doesNotMatch(source, /new URL\(databaseUrl\)/);
  assert.match(
    source,
    /LOCK TABLE[\s\S]*"PasswordRecoveryRequest"[\s\S]*"AuthRecoveryRateLimitBucket"[\s\S]*"User"[\s\S]*"AuthRecoveryRetiredSecret"[\s\S]*"AuthSecurityEmailOutbox"[\s\S]*SHARE ROW EXCLUSIVE/,
  );
  assert.match(
    source,
    /UPDATE "PasswordRecoveryRequest"[\s\S]*'KEY_ROTATED'::"PasswordRecoveryTerminationReason"[\s\S]*"deliveryState" <> 'SUPPRESSED'/,
  );
  assert.match(source, /WHEN "deliveryState" = 'SENDING'[\s\S]*THEN 'UNCERTAIN'/);
  assert.match(
    source,
    /UPDATE "User"[\s\S]*"resetToken" = NULL, "resetTokenExpiry" = NULL/,
  );
  assert.match(
    source,
    /UPDATE "PasswordRecoveryRequest"[\s\S]*"identifierDigest" = NULL[\s\S]*"requestEvidenceRedactedAt" = CURRENT_TIMESTAMP/,
  );
  assert.match(source, /DELETE FROM "AuthRecoveryRateLimitBucket"/);
  assert.match(source, /INSERT INTO "AuthRecoveryRetiredSecret"/);
  assert.match(source, /replacement key was previously retired/);
  assert.match(source, /requireAuthRecoveryControlForCurrentSecret/);
  assert.match(controlStatusMethod, /lockAuthRecoveryControl/);
  assert.match(controlStatusMethod, /currentSecretActive/);
  assert.doesNotMatch(
    controlStatusMethod,
    /requireAuthRecoveryControlForCurrentSecret|assertAuthRecoveryControlForCurrentSecret|bindAuthRecoveryControlForRuntime|\b(?:INSERT|UPDATE|DELETE)\b/u,
  );
  assert.doesNotMatch(
    controlStatusCountReader,
    /\b(?:INSERT|UPDATE|DELETE)\b/u,
  );
  assert.doesNotMatch(source, /(?:DELETE FROM|UPDATE) "AuthSecurityEmailOutbox"/);
  assert.match(controlSource, /has not been explicitly bound/);
  assert.match(serverSource, /bindAuthRecoveryControlForRuntime\(app\.prisma\)[\s\S]*app\.listen/);
  assert.match(schedulerSource, /requireAuthRecoveryControlForRuntime\(prisma\)[\s\S]*new AuthEmailDeliveryService/);
  assert.doesNotMatch(schedulerSource, /bindAuthRecoveryControlForRuntime/);
  assert.match(deliveryWorkerSource, /requireAuthRecoveryControlForRuntime\(prisma\)[\s\S]*processDueDeliveries/);
  assert.doesNotMatch(deliveryWorkerSource, /bindAuthRecoveryControlForRuntime/);
  assert.equal(
    packageJson.scripts['jobs:rotate-auth-recovery-secret'],
    'node dist/jobs/rotate-auth-recovery-secret.js',
  );
  assert.match(
    compose,
    /auth-recovery-secret-rotation:[\s\S]*profiles:[\s\S]*- maintenance[\s\S]*dist\/jobs\/rotate-auth-recovery-secret\.js[\s\S]*CHARITYPILOT_DEPLOYMENT_MODE: production[\s\S]*AUTH_RECOVERY_SECRET: \$\{AUTH_RECOVERY_SECRET:\?Set AUTH_RECOVERY_SECRET\}/,
  );
  assert.match(
    personalCompose,
    /auth-recovery-secret-rotation:[\s\S]*profiles:[\s\S]*- maintenance[\s\S]*dist\/jobs\/rotate-auth-recovery-secret\.js[\s\S]*CHARITYPILOT_DEPLOYMENT_MODE: personal-server[\s\S]*AUTH_RECOVERY_SECRET: \$\{AUTH_RECOVERY_SECRET:\?Set AUTH_RECOVERY_SECRET in \.env\.personal-server\}/,
  );
});
