import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { authRecoverySecretFingerprint } from '../services/password-recovery-crypto.js';
import { authRecoveryDatabaseIdentitySha256 } from '../jobs/rotate-auth-recovery-secret.js';
import {
  PrismaPersonalServerReplacementRebindStore,
  assertPersonalServerReplacementRebindEnvironment,
  parsePersonalServerReplacementRebindArgs,
  personalServerReplacementRebindConfirmation,
  runPersonalServerReplacementRebind,
  type PersonalServerReplacementControlState,
  type PersonalServerReplacementRebindCounts,
  type PersonalServerReplacementRebindEvidence,
  type PersonalServerReplacementRebindStore,
} from '../jobs/rebind-personal-server-auth-recovery-secret.js';

const RECOVERY_SET_ID = 'personal-server-2026-07-12T11-22-33-444Z-0123abcd';
const MANIFEST_SHA256 = 'ab'.repeat(32);
const REPLACEMENT_SECRET = '11'.repeat(48);
const OLD_SECRET = '22'.repeat(48);
const RETIRED_SECRET = '33'.repeat(48);
const DATABASE_TARGET = {
  databaseName: 'charitypilot',
  databaseOid: '16384',
  schemaName: 'public',
  schemaOid: '2200',
  databaseUser: 'charitypilot',
  serverAddress: '172.30.250.2',
  serverPort: 5432,
};
const DATABASE_IDENTITY_SHA256 = authRecoveryDatabaseIdentitySha256(DATABASE_TARGET);
const PERSONAL_SERVER_ENV = {
  NODE_ENV: 'production',
  CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
  AUTH_RECOVERY_SECRET: REPLACEMENT_SECRET,
  JWT_SECRET: '44'.repeat(48),
  READINESS_API_KEY: '55'.repeat(48),
};
const ACTIVE_COUNTS: PersonalServerReplacementRebindCounts = {
  capabilities: 7,
  requestEvidenceRows: 9,
  legacySlots: 2,
  rateBuckets: 11,
  securityNotices: 3,
  retiredSecrets: 0,
};
const ACTIVE_EVIDENCE: PersonalServerReplacementRebindEvidence = {
  controlState: 'active',
  generation: 1,
  counts: ACTIVE_COUNTS,
  databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
};

function dryRunArgs(): string[] {
  return [
    '--dry-run',
    '--recovery-set-id', RECOVERY_SET_ID,
    '--manifest-sha256', MANIFEST_SHA256,
    '--confirm-api-and-scheduler-quiesced',
  ];
}

function executeArgs(
  evidence: PersonalServerReplacementRebindEvidence = ACTIVE_EVIDENCE,
): string[] {
  return [
    '--execute',
    '--recovery-set-id', RECOVERY_SET_ID,
    '--manifest-sha256', MANIFEST_SHA256,
    '--confirm-api-and-scheduler-quiesced',
    '--expected-control-state', evidence.controlState,
    '--expected-generation', String(evidence.generation),
    '--expected-capabilities', String(evidence.counts.capabilities),
    '--expected-request-evidence-rows', String(evidence.counts.requestEvidenceRows),
    '--expected-legacy-slots', String(evidence.counts.legacySlots),
    '--expected-rate-buckets', String(evidence.counts.rateBuckets),
    '--expected-security-notices', String(evidence.counts.securityNotices),
    '--expected-retired-secrets', String(evidence.counts.retiredSecrets),
    '--expected-database-identity-sha256', evidence.databaseIdentitySha256,
    '--confirm-execute', personalServerReplacementRebindConfirmation(
      RECOVERY_SET_ID,
      MANIFEST_SHA256,
      evidence,
    ),
  ];
}

function removeOption(args: string[], option: string): string[] {
  const index = args.indexOf(option);
  if (index < 0) return args;
  const result = [...args];
  result.splice(index, option.startsWith('--confirm-api') ? 1 : 2);
  return result;
}

test('replacement rebind parser accepts only the exact quiesced dry-run contract', () => {
  assert.deepEqual(parsePersonalServerReplacementRebindArgs(dryRunArgs()), {
    mode: 'dry-run',
    recoverySetId: RECOVERY_SET_ID,
    manifestSha256: MANIFEST_SHA256,
    apiAndSchedulerQuiesced: true,
  });
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs([]),
    /Choose exactly one mode/u,
  );
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs([
      ...dryRunArgs(), '--execute',
    ]),
    /Choose exactly one mode/u,
  );
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs(
      dryRunArgs().filter((argument) => argument !== '--confirm-api-and-scheduler-quiesced'),
    ),
    /--confirm-api-and-scheduler-quiesced is required/u,
  );
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs([
      ...dryRunArgs(), '--expected-capabilities', '7',
    ]),
    /Execute-only evidence/u,
  );
});

test('replacement rebind parser rejects malformed bindings, duplicates, values, and unknown options', () => {
  for (const [option, value, pattern] of [
    ['--recovery-set-id', 'personal-server-latest', /exact personal-server/u],
    ['--recovery-set-id', `${RECOVERY_SET_ID}/other`, /exact personal-server/u],
    ['--manifest-sha256', MANIFEST_SHA256.toUpperCase(), /lowercase SHA-256/u],
    ['--manifest-sha256', 'abc', /lowercase SHA-256/u],
  ] as const) {
    const args = dryRunArgs();
    args[args.indexOf(option) + 1] = value;
    assert.throws(() => parsePersonalServerReplacementRebindArgs(args), pattern);
  }
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs([
      ...dryRunArgs(), '--recovery-set-id', RECOVERY_SET_ID,
    ]),
    /may only be supplied once/u,
  );
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs([
      '--dry-run', '--recovery-set-id', '--manifest-sha256', MANIFEST_SHA256,
      '--confirm-api-and-scheduler-quiesced',
    ]),
    /--recovery-set-id requires a value/u,
  );
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs([...dryRunArgs(), '--surprise']),
    /Unknown option/u,
  );
});

test('replacement rebind execute parser binds every count, control state, database, manifest, and recovery set', () => {
  const command = parsePersonalServerReplacementRebindArgs(executeArgs());
  assert.equal(command.mode, 'execute');
  assert.deepEqual(command.expected, ACTIVE_EVIDENCE);
  assert.equal(command.recoverySetId, RECOVERY_SET_ID);
  assert.equal(command.manifestSha256, MANIFEST_SHA256);
  assert.equal(
    command.executionConfirmation,
    personalServerReplacementRebindConfirmation(
      RECOVERY_SET_ID,
      MANIFEST_SHA256,
      ACTIVE_EVIDENCE,
    ),
  );
  for (const option of [
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
  ]) {
    assert.throws(
      () => parsePersonalServerReplacementRebindArgs(removeOption(executeArgs(), option)),
      /complete exact evidence|--confirm-execute must exactly equal/u,
      option,
    );
  }
});

test('replacement rebind execute parser rejects noncanonical counts, state, history, and acknowledgement', () => {
  const invalidState = executeArgs();
  invalidState[invalidState.indexOf('--expected-control-state') + 1] = 'unknown';
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs(invalidState),
    /exactly unbound, active, or blocked/u,
  );

  for (const value of ['-1', '01', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
    const invalidCount = executeArgs();
    invalidCount[invalidCount.indexOf('--expected-capabilities') + 1] = value;
    assert.throws(
      () => parsePersonalServerReplacementRebindArgs(invalidCount),
      /non-negative integer|safe integer/u,
    );
  }

  const badHistory = executeArgs();
  badHistory[badHistory.indexOf('--expected-retired-secrets') + 1] = '1';
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs(badHistory),
    /retired history does not match/u,
  );

  const badConfirmation = executeArgs();
  badConfirmation[badConfirmation.length - 1] = 'REBIND EVERYTHING';
  assert.throws(
    () => parsePersonalServerReplacementRebindArgs(badConfirmation),
    /--confirm-execute must exactly equal/u,
  );
});

test('replacement rebind confirmation changes for every authority-bearing field', () => {
  const baseline = personalServerReplacementRebindConfirmation(
    RECOVERY_SET_ID,
    MANIFEST_SHA256,
    ACTIVE_EVIDENCE,
  );
  const variants: Array<[string, string, string, PersonalServerReplacementRebindEvidence]> = [
    ['recovery set', RECOVERY_SET_ID.replace(/0123abcd$/u, '0123abce'), MANIFEST_SHA256, ACTIVE_EVIDENCE],
    ['manifest', RECOVERY_SET_ID, `ac${MANIFEST_SHA256.slice(2)}`, ACTIVE_EVIDENCE],
    ['control', RECOVERY_SET_ID, MANIFEST_SHA256, { ...ACTIVE_EVIDENCE, controlState: 'unbound' }],
    ['generation', RECOVERY_SET_ID, MANIFEST_SHA256, {
      ...ACTIVE_EVIDENCE,
      generation: 2,
      counts: { ...ACTIVE_COUNTS, retiredSecrets: 1 },
    }],
    ['counts', RECOVERY_SET_ID, MANIFEST_SHA256, {
      ...ACTIVE_EVIDENCE,
      counts: { ...ACTIVE_COUNTS, capabilities: ACTIVE_COUNTS.capabilities + 1 },
    }],
    ['database', RECOVERY_SET_ID, MANIFEST_SHA256, {
      ...ACTIVE_EVIDENCE,
      databaseIdentitySha256: `cd${DATABASE_IDENTITY_SHA256.slice(2)}`,
    }],
  ];
  for (const [label, recoverySetId, manifestSha256, evidence] of variants) {
    assert.notEqual(
      personalServerReplacementRebindConfirmation(recoverySetId, manifestSha256, evidence),
      baseline,
      label,
    );
  }
});

test('replacement rebind environment is restricted to production personal-server with an independent valid secret', () => {
  assert.doesNotThrow(() => assertPersonalServerReplacementRebindEnvironment(PERSONAL_SERVER_ENV));
  for (const [env, pattern] of [
    [{ ...PERSONAL_SERVER_ENV, NODE_ENV: 'development' }, /NODE_ENV must be production/u],
    [{ ...PERSONAL_SERVER_ENV, CHARITYPILOT_DEPLOYMENT_MODE: 'production' }, /must be personal-server/u],
    [{ ...PERSONAL_SERVER_ENV, CHARITYPILOT_DEPLOYMENT_MODE: undefined }, /must be personal-server/u],
    [{ ...PERSONAL_SERVER_ENV, AUTH_RECOVERY_SECRET: 'short' }, /AUTH_RECOVERY_SECRET/u],
    [{ ...PERSONAL_SERVER_ENV, JWT_SECRET: REPLACEMENT_SECRET }, /must be independent/u],
    [{ ...PERSONAL_SERVER_ENV, READINESS_API_KEY: REPLACEMENT_SECRET }, /must be independent/u],
  ] as const) {
    assert.throws(() => assertPersonalServerReplacementRebindEnvironment(env), pattern);
  }
});

test('replacement rebind runner dry-run emits bounded JSON and no secret or fingerprint', async () => {
  let inspections = 0;
  const store: PersonalServerReplacementRebindStore = {
    async inspect() {
      inspections += 1;
      return ACTIVE_EVIDENCE;
    },
    async rebind() { throw new Error('dry-run must not mutate'); },
  };
  const result = await runPersonalServerReplacementRebind(
    store,
    parsePersonalServerReplacementRebindArgs(dryRunArgs()),
    PERSONAL_SERVER_ENV,
  );
  assert.equal(inspections, 1);
  assert.equal(result.format, 'charitypilot-personal-replacement-auth-rebind/v1');
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.mutationApplied, false);
  assert.equal(result.controlState, 'active');
  assert.equal(result.generation, 1);
  assert.equal(result.capabilities, 7);
  assert.equal(result.recoverySetId, RECOVERY_SET_ID);
  assert.equal(result.manifestSha256, MANIFEST_SHA256);
  assert.equal(result.databaseIdentitySha256, DATABASE_IDENTITY_SHA256);
  assert.equal(result.terminationReason, 'KEY_ROTATED');
  assert.equal(result.recoveryBlockedAfterExecute, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    new RegExp(`${REPLACEMENT_SECRET}|${OLD_SECRET}|activeSecretFingerprint|retiredSecretFingerprint`, 'u'),
  );
});

test('replacement rebind runner execute returns only verified final evidence', async () => {
  const after: PersonalServerReplacementRebindEvidence = {
    controlState: 'active',
    generation: 2,
    counts: {
      capabilities: 0,
      requestEvidenceRows: 0,
      legacySlots: 0,
      rateBuckets: 0,
      securityNotices: ACTIVE_COUNTS.securityNotices,
      retiredSecrets: 1,
    },
    databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
  };
  let delegated: PersonalServerReplacementRebindEvidence | undefined;
  const store: PersonalServerReplacementRebindStore = {
    async inspect() { throw new Error('execute must not preview'); },
    async rebind(expected) {
      delegated = expected;
      return {
        before: ACTIVE_EVIDENCE,
        after,
        priorActiveFingerprintRetired: true,
      };
    },
  };
  const result = await runPersonalServerReplacementRebind(
    store,
    parsePersonalServerReplacementRebindArgs(executeArgs()),
    PERSONAL_SERVER_ENV,
  );
  assert.deepEqual(delegated, ACTIVE_EVIDENCE);
  assert.equal(result.mode, 'EXECUTED');
  assert.equal(result.recoveryBlocked, false);
  assert.equal(result.boundToReplacementSecret, true);
  assert.equal(result.priorActiveSecretRetired, true);
  assert.equal(result.generation, 2);
  assert.equal(result.securityNoticesPreserved, 3);
  assert.equal(result.remainingCapabilities, 0);
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(`${REPLACEMENT_SECRET}|${OLD_SECRET}|Fingerprint`, 'u'),
  );
});

test('replacement rebind runner rejects invalid store evidence and fails before store access outside its profile', async () => {
  let touched = false;
  const store: PersonalServerReplacementRebindStore = {
    async inspect() { touched = true; return ACTIVE_EVIDENCE; },
    async rebind() { touched = true; throw new Error('unexpected'); },
  };
  await assert.rejects(
    () => runPersonalServerReplacementRebind(
      store,
      parsePersonalServerReplacementRebindArgs(dryRunArgs()),
      { ...PERSONAL_SERVER_ENV, CHARITYPILOT_DEPLOYMENT_MODE: 'production' },
    ),
    /must be personal-server/u,
  );
  assert.equal(touched, false);

  await assert.rejects(
    () => runPersonalServerReplacementRebind(
      {
        async inspect() {
          return { ...ACTIVE_EVIDENCE, databaseIdentitySha256: 'invalid' };
        },
        async rebind() { throw new Error('unexpected'); },
      },
      parsePersonalServerReplacementRebindArgs(dryRunArgs()),
      PERSONAL_SERVER_ENV,
    ),
    /database identity is invalid/u,
  );
});

type MockControl = {
  id: number;
  blocked: boolean;
  generation: number;
  activeSecretFingerprint: string | null;
  retiredSecretFingerprint: string | null;
};

type MockDatabase = {
  control: MockControl;
  counts: PersonalServerReplacementRebindCounts;
  retiredFingerprints: Set<string>;
  transactionAttempts: number;
  serializationConflicts: number;
  isolationLevels: unknown[];
  statements: string[];
};

function sqlText(strings: TemplateStringsArray): string {
  return strings.join('?').replace(/\s+/gu, ' ').trim();
}

function mockPrisma(database: MockDatabase) {
  const tx = {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = sqlText(strings);
      database.statements.push(sql);
      if (sql.includes('FROM "AuthRecoveryControl"') && sql.includes('FOR UPDATE')) {
        return [{ ...database.control }];
      }
      if (sql.includes('CURRENT_DATABASE() AS "databaseName"')) {
        return [{ ...DATABASE_TARGET }];
      }
      if (sql.includes('AS "capabilities"') && sql.includes('AS "retiredSecrets"')) {
        return [{ ...database.counts }];
      }
      if (sql.includes('SELECT EXISTS') && sql.includes('"AuthRecoveryRetiredSecret"')) {
        return [{ retired: database.retiredFingerprints.has(String(values[0])) }];
      }
      throw new Error(`Unexpected mock query: ${sql}`);
    },
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = sqlText(strings);
      database.statements.push(sql);
      if (sql.startsWith('LOCK TABLE')) return 0;
      if (
        sql.startsWith('UPDATE "PasswordRecoveryRequest"') &&
        sql.includes('"terminationReason" = \'KEY_ROTATED\'')
      ) {
        const count = database.counts.capabilities;
        database.counts.capabilities = 0;
        return count;
      }
      if (
        sql.startsWith('UPDATE "PasswordRecoveryRequest"') &&
        sql.includes('"requestEvidenceRedactedAt" = CURRENT_TIMESTAMP')
      ) {
        const count = database.counts.requestEvidenceRows;
        database.counts.requestEvidenceRows = 0;
        return count;
      }
      if (sql.startsWith('UPDATE "User"')) {
        const count = database.counts.legacySlots;
        database.counts.legacySlots = 0;
        return count;
      }
      if (sql.startsWith('DELETE FROM "AuthRecoveryRateLimitBucket"')) {
        const count = database.counts.rateBuckets;
        database.counts.rateBuckets = 0;
        return count;
      }
      if (sql.startsWith('INSERT INTO "AuthRecoveryRetiredSecret"')) {
        if (database.control.activeSecretFingerprint === null) return 0;
        database.retiredFingerprints.add(database.control.activeSecretFingerprint);
        database.counts.retiredSecrets += 1;
        return 1;
      }
      if (
        sql.startsWith('UPDATE "AuthRecoveryControl"') &&
        sql.includes('"blocked" = TRUE')
      ) {
        if (database.control.blocked || database.control.activeSecretFingerprint === null) return 0;
        database.control = {
          ...database.control,
          blocked: true,
          generation: database.control.generation + 1,
          retiredSecretFingerprint: database.control.activeSecretFingerprint,
          activeSecretFingerprint: null,
        };
        return 1;
      }
      if (
        sql.startsWith('UPDATE "AuthRecoveryControl"') &&
        sql.includes('"blocked" = FALSE')
      ) {
        if (!database.control.blocked) return 0;
        database.control = {
          ...database.control,
          blocked: false,
          activeSecretFingerprint: String(values[0]),
        };
        return 1;
      }
      if (
        sql.startsWith('UPDATE "AuthRecoveryControl"') &&
        sql.includes('"activeSecretFingerprint" = ?') &&
        sql.includes('"generation" = 1')
      ) {
        if (
          database.control.blocked ||
          database.control.generation !== 1 ||
          database.control.activeSecretFingerprint !== null ||
          database.control.retiredSecretFingerprint !== null
        ) return 0;
        database.control = {
          ...database.control,
          activeSecretFingerprint: String(values[0]),
        };
        return 1;
      }
      throw new Error(`Unexpected mock execution: ${sql}`);
    },
  };
  return {
    async $transaction(
      callback: (transaction: typeof tx) => Promise<unknown>,
      options: { isolationLevel?: unknown },
    ) {
      database.transactionAttempts += 1;
      database.isolationLevels.push(options.isolationLevel);
      if (database.serializationConflicts > 0) {
        database.serializationConflicts -= 1;
        throw { code: 'P2034' };
      }
      return callback(tx);
    },
  };
}

function mockDatabase(
  state: PersonalServerReplacementControlState,
  counts: PersonalServerReplacementRebindCounts,
): MockDatabase {
  const oldFingerprint = authRecoverySecretFingerprint(OLD_SECRET);
  const retiredFingerprint = authRecoverySecretFingerprint(RETIRED_SECRET);
  const generation = state === 'unbound' || state === 'active' ? 1 : 2;
  return {
    control: {
      id: 1,
      blocked: state === 'blocked',
      generation,
      activeSecretFingerprint: state === 'active' ? oldFingerprint : null,
      retiredSecretFingerprint: state === 'blocked' ? retiredFingerprint : null,
    },
    counts: { ...counts },
    retiredFingerprints: new Set(state === 'blocked' ? [retiredFingerprint] : []),
    transactionAttempts: 0,
    serializationConflicts: 0,
    isolationLevels: [],
    statements: [],
  };
}

test('Prisma replacement store atomically retires an old active key, invalidates capabilities, and binds the replacement', async () => {
  const database = mockDatabase('active', ACTIVE_COUNTS);
  const store = new PrismaPersonalServerReplacementRebindStore(
    mockPrisma(database) as never,
    REPLACEMENT_SECRET,
  );
  const preview = await store.inspect();
  assert.deepEqual(preview, ACTIVE_EVIDENCE);
  const result = await store.rebind(preview);
  assert.equal(result.priorActiveFingerprintRetired, true);
  assert.equal(result.after.controlState, 'active');
  assert.equal(result.after.generation, 2);
  assert.equal(result.after.counts.retiredSecrets, 1);
  assert.equal(result.after.counts.securityNotices, ACTIVE_COUNTS.securityNotices);
  assert.equal(database.control.blocked, false);
  assert.equal(
    database.control.activeSecretFingerprint,
    authRecoverySecretFingerprint(REPLACEMENT_SECRET),
  );
  assert.ok(database.retiredFingerprints.has(authRecoverySecretFingerprint(OLD_SECRET)));
  assert.ok(database.isolationLevels.every((value) => value === 'Serializable'));
  assert.match(database.statements.join('\n'), /LOCK TABLE/u);
  assert.match(database.statements.join('\n'), /KEY_ROTATED/u);
  assert.match(database.statements.join('\n'), /requestEvidenceRedactedAt/u);
});

test('Prisma replacement store safely activates an already-blocked zero-postcondition control', async () => {
  const blockedCounts: PersonalServerReplacementRebindCounts = {
    capabilities: 0,
    requestEvidenceRows: 0,
    legacySlots: 0,
    rateBuckets: 0,
    securityNotices: 4,
    retiredSecrets: 1,
  };
  const database = mockDatabase('blocked', blockedCounts);
  const store = new PrismaPersonalServerReplacementRebindStore(
    mockPrisma(database) as never,
    REPLACEMENT_SECRET,
  );
  const preview = await store.inspect();
  assert.equal(preview.controlState, 'blocked');
  const result = await store.rebind(preview);
  assert.equal(result.priorActiveFingerprintRetired, false);
  assert.equal(result.after.generation, 2);
  assert.equal(result.after.counts.retiredSecrets, 1);
  assert.equal(result.after.counts.securityNotices, 4);
  assert.equal(database.control.blocked, false);
  assert.equal(
    database.control.activeSecretFingerprint,
    authRecoverySecretFingerprint(REPLACEMENT_SECRET),
  );
  assert.doesNotMatch(database.statements.join('\n'), /INSERT INTO "AuthRecoveryRetiredSecret"/u);
});

test('Prisma replacement store safely binds a pristine restored generation-1 control without inventing retirement', async () => {
  const unboundCounts: PersonalServerReplacementRebindCounts = {
    ...ACTIVE_COUNTS,
    retiredSecrets: 0,
  };
  const database = mockDatabase('unbound', unboundCounts);
  const store = new PrismaPersonalServerReplacementRebindStore(
    mockPrisma(database) as never,
    REPLACEMENT_SECRET,
  );
  const preview = await store.inspect();
  assert.equal(preview.controlState, 'unbound');
  const result = await store.rebind(preview);
  assert.equal(result.priorActiveFingerprintRetired, false);
  assert.equal(result.after.generation, 1);
  assert.equal(result.after.counts.retiredSecrets, 0);
  assert.equal(database.control.blocked, false);
  assert.equal(
    database.control.activeSecretFingerprint,
    authRecoverySecretFingerprint(REPLACEMENT_SECRET),
  );
  assert.doesNotMatch(database.statements.join('\n'), /INSERT INTO "AuthRecoveryRetiredSecret"/u);
  assert.doesNotMatch(database.statements.join('\n'), /"blocked" = TRUE/u);
});

test('Prisma replacement store rejects active, immediately retired, or historically retired replacement secrets', async () => {
  const activeDatabase = mockDatabase('active', ACTIVE_COUNTS);
  await assert.rejects(
    () => new PrismaPersonalServerReplacementRebindStore(
      mockPrisma(activeDatabase) as never,
      OLD_SECRET,
    ).inspect(),
    /already the active secret/u,
  );

  const blockedDatabase = mockDatabase('blocked', {
    capabilities: 0,
    requestEvidenceRows: 0,
    legacySlots: 0,
    rateBuckets: 0,
    securityNotices: 0,
    retiredSecrets: 1,
  });
  await assert.rejects(
    () => new PrismaPersonalServerReplacementRebindStore(
      mockPrisma(blockedDatabase) as never,
      RETIRED_SECRET,
    ).inspect(),
    /matches the retired secret/u,
  );

  const historicalDatabase = mockDatabase('active', ACTIVE_COUNTS);
  historicalDatabase.retiredFingerprints.add(authRecoverySecretFingerprint(REPLACEMENT_SECRET));
  await assert.rejects(
    () => new PrismaPersonalServerReplacementRebindStore(
      mockPrisma(historicalDatabase) as never,
      REPLACEMENT_SECRET,
    ).inspect(),
    /previously retired/u,
  );
});

test('Prisma replacement store rejects drift, dirty blocked state, and retries one serialization conflict', async () => {
  const driftDatabase = mockDatabase('active', ACTIVE_COUNTS);
  const driftStore = new PrismaPersonalServerReplacementRebindStore(
    mockPrisma(driftDatabase) as never,
    REPLACEMENT_SECRET,
  );
  const preview = await driftStore.inspect();
  await assert.rejects(
    () => driftStore.rebind({
      ...preview,
      counts: { ...preview.counts, capabilities: preview.counts.capabilities + 1 },
    }),
    /database evidence changed/u,
  );

  const dirtyBlocked = mockDatabase('blocked', {
    capabilities: 1,
    requestEvidenceRows: 0,
    legacySlots: 0,
    rateBuckets: 0,
    securityNotices: 0,
    retiredSecrets: 1,
  });
  await assert.rejects(
    () => new PrismaPersonalServerReplacementRebindStore(
      mockPrisma(dirtyBlocked) as never,
      REPLACEMENT_SECRET,
    ).inspect(),
    /blocked control has non-zero/u,
  );

  const retryDatabase = mockDatabase('active', ACTIVE_COUNTS);
  retryDatabase.serializationConflicts = 1;
  const retryStore = new PrismaPersonalServerReplacementRebindStore(
    mockPrisma(retryDatabase) as never,
    REPLACEMENT_SECRET,
  );
  const result = await retryStore.rebind(ACTIVE_EVIDENCE);
  assert.equal(result.after.generation, 2);
  assert.equal(retryDatabase.transactionAttempts, 2);
});

test('replacement rebind source keeps the serializable lock and invalidation contract explicit', () => {
  const workspacePath = join(
    process.cwd(),
    'src',
    'jobs',
    'rebind-personal-server-auth-recovery-secret.ts',
  );
  const repositoryPath = join(
    process.cwd(),
    'apps',
    'api',
    'src',
    'jobs',
    'rebind-personal-server-auth-recovery-secret.ts',
  );
  const source = readFileSync(existsSync(workspacePath) ? workspacePath : repositoryPath, 'utf8');
  assert.match(source, /TransactionIsolationLevel\.Serializable/u);
  assert.match(
    source,
    /LOCK TABLE[\s\S]*"AuthRecoveryControl"[\s\S]*"PasswordRecoveryRequest"[\s\S]*"AuthRecoveryRateLimitBucket"[\s\S]*"User"[\s\S]*"AuthRecoveryRetiredSecret"[\s\S]*"AuthSecurityEmailOutbox"[\s\S]*SHARE ROW EXCLUSIVE/u,
  );
  assert.match(
    source,
    /UPDATE "PasswordRecoveryRequest"[\s\S]*'KEY_ROTATED'::"PasswordRecoveryTerminationReason"[\s\S]*"deliveryState" <> 'SUPPRESSED'/u,
  );
  assert.match(
    source,
    /UPDATE "PasswordRecoveryRequest"[\s\S]*"identifierDigest" = NULL[\s\S]*"requestEvidenceRedactedAt" = CURRENT_TIMESTAMP/u,
  );
  assert.match(source, /UPDATE "User"[\s\S]*"resetToken" = NULL/u);
  assert.match(source, /DELETE FROM "AuthRecoveryRateLimitBucket"/u);
  assert.match(source, /INSERT INTO "AuthRecoveryRetiredSecret"/u);
  assert.match(source, /"blocked" = FALSE[\s\S]*"activeSecretFingerprint"/u);
  assert.doesNotMatch(source, /process\.stdout\.write\([^\n]*AUTH_RECOVERY_SECRET/u);
});
