import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  parsePlatformDocumentStorageRecoveryArgs,
  platformDocumentRecoveryConfirmation,
  runPlatformDocumentStorageRecovery,
  type PlatformDocumentStorageRecoveryCommand,
} from '../jobs/recover-document-storage-deletion.js';

const DEAD_LETTER = {
  id: 'deletion-1',
  organisationId: 'org-1',
  storagePath: 'foreign-org/rejected.pdf',
  state: 'DEAD_LETTER',
  attempts: 1,
  lastError: 'path rejected',
  lastAttemptAt: new Date('2026-07-11T11:00:00.000Z'),
  nextAttemptAt: null,
  claimedAt: null,
  deadLetteredAt: new Date('2026-07-11T11:00:00.000Z'),
  terminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
  alertClaimToken: null,
  alertClaimedAt: null,
  alertedAt: new Date('2026-07-11T11:05:00.000Z'),
  processedAt: null,
  createdAt: new Date('2026-07-11T09:00:00.000Z'),
};
const PRODUCTION_DATABASE_URL = 'postgresql://recovery:secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write&channel_binding=require&connect_timeout=10&application_name=charitypilot_document_recovery';
const DATABASE_AUTHORITY_SHA256 = createHash('sha256').update(PRODUCTION_DATABASE_URL).digest('hex');
const CORRECTED_PATH_SHA256 = createHash('sha256').update('org-1/corrected.pdf').digest('hex');

function productionEnv(databaseUrl = PRODUCTION_DATABASE_URL) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST: 'db.charitypilot.ie',
  };
}

function command(overrides: Partial<PlatformDocumentStorageRecoveryCommand> = {}): PlatformDocumentStorageRecoveryCommand {
  return {
    mode: 'execute',
    organisationId: 'org-1',
    deletionId: 'deletion-1',
    operatorIdentity: 'Jane Recovery Operator',
    reason: 'Reviewed provider evidence authorizes this recovery.',
    disposition: 'REQUEUE_CORRECTED_PATH',
    correctedStoragePath: 'org-1/corrected.pdf',
    expectedAttempts: 1,
    expectedTerminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
    expectedDatabaseAuthoritySha256: DATABASE_AUTHORITY_SHA256,
    expectedCorrectedStoragePathSha256: CORRECTED_PATH_SHA256,
    productionDatabaseAuthorityConfirmed: true,
    executionConfirmation: platformDocumentRecoveryConfirmation({
      organisationId: 'org-1',
      deletionId: 'deletion-1',
      disposition: 'REQUEUE_CORRECTED_PATH',
      expectedAttempts: 1,
      expectedTerminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
      databaseAuthoritySha256: DATABASE_AUTHORITY_SHA256,
      correctedStoragePathSha256: CORRECTED_PATH_SHA256,
    }),
    ...overrides,
  };
}

function database(row = DEAD_LETTER) {
  let audit: { data?: Record<string, unknown> } | undefined;
  let update: { where?: Record<string, unknown>; data?: Record<string, unknown> } | undefined;
  const prisma: Record<string, unknown> = {
    documentStorageDeletion: {
      findFirst: async () => ({
        id: row.id,
        attempts: row.attempts,
        terminalReason: row.terminalReason,
        deadLetteredAt: row.deadLetteredAt,
        alertedAt: row.alertedAt,
      }),
      updateMany: async (args: { where?: Record<string, unknown>; data?: Record<string, unknown> }) => {
        update = args;
        return { count: 1 };
      },
    },
    documentStorageDeletionRecovery: {
      create: async (args: { data?: Record<string, unknown> }) => {
        audit = args;
        return { id: 'recovery-1' };
      },
    },
  };
  prisma.$queryRaw = async (strings: TemplateStringsArray) =>
    strings.join('?').includes('FROM "Organisation"')
      ? [{ id: 'org-1' }]
      : strings.join('?').includes('AS "liveDocument"')
        ? [{ liveDocument: false, otherDeletion: false }]
        : [row];
  prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma);
  return { prisma, audit: () => audit, update: () => update };
}

test('platform recovery parser requires explicit authority and target-bound execute confirmation', () => {
  const dryRun = parsePlatformDocumentStorageRecoveryArgs([
    '--dry-run',
    '--confirm-production-database-authority',
    '--organisation-id', 'org-1',
    '--deletion-id', 'deletion-1',
    '--operator', 'Jane Recovery Operator',
    '--reason', 'Reviewed provider evidence authorizes this recovery.',
    '--disposition', 'REQUEUE_CORRECTED_PATH',
    '--corrected-storage-path', 'org-1/corrected.pdf',
  ]);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.productionDatabaseAuthorityConfirmed, true);

  const confirmation = platformDocumentRecoveryConfirmation({
    organisationId: 'org-1',
    deletionId: 'deletion-1',
    disposition: 'REQUEUE_CORRECTED_PATH',
    expectedAttempts: 1,
    expectedTerminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
    databaseAuthoritySha256: DATABASE_AUTHORITY_SHA256,
    correctedStoragePathSha256: CORRECTED_PATH_SHA256,
  });
  const execute = parsePlatformDocumentStorageRecoveryArgs([
    '--execute',
    '--confirm-production-database-authority',
    '--organisation-id', 'org-1',
    '--deletion-id', 'deletion-1',
    '--operator', 'Jane Recovery Operator',
    '--reason', 'Reviewed provider evidence authorizes this recovery.',
    '--disposition', 'REQUEUE_CORRECTED_PATH',
    '--corrected-storage-path', 'org-1/corrected.pdf',
    '--expected-attempts', '1',
    '--expected-terminal-reason', 'PERMANENT_STORAGE_PATH_REJECTED',
    '--expected-database-authority-sha256', DATABASE_AUTHORITY_SHA256,
    '--expected-corrected-storage-path-sha256', CORRECTED_PATH_SHA256,
    '--confirm-execute', confirmation,
  ]);
  assert.equal(execute.executionConfirmation, confirmation);

  assert.throws(
    () => parsePlatformDocumentStorageRecoveryArgs([
      '--execute', '--organisation-id', 'org-1', '--deletion-id', 'deletion-1',
      '--operator', 'Jane Recovery Operator', '--reason', 'A sufficiently long recovery reason.',
      '--disposition', 'COMPLETE_EXTERNALLY_REMEDIATED',
    ]),
    /confirm-production-database-authority/u,
  );
  assert.throws(
    () => parsePlatformDocumentStorageRecoveryArgs([
      '--dry-run', '--confirm-production-database-authority', '--organisation-id', 'org-1',
      '--deletion-id', 'deletion-1', '--operator', 'admin',
      '--reason', 'A sufficiently long recovery reason.', '--disposition', 'REQUEUE_UNCHANGED',
    ]),
    /named human operator/u,
  );
});

test('platform recovery authority rejects local, private, reserved, routed, weak-TLS, and non-allowlisted database URLs without querying', async () => {
  const unsafeUrls = [
    'postgresql://u:p@127.0.0.1/db?sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write',
    'postgresql://u:p@10.1.2.3/db?sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write',
    'postgresql://u:p@[::ffff:127.0.0.1]/db?sslmode=verify-full&target_session_attrs=read-write',
    'postgresql://u:p@203.0.113.8/db?sslmode=verify-full&target_session_attrs=read-write',
    'postgresql://u:p@db.example.test/db?sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write',
    'postgresql://u:p@db.charitypilot.ie/db?host=localhost&sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write',
    'postgresql://u:p@db.charitypilot.ie/db?sslmode=require&sslrootcert=system&target_session_attrs=read-write',
    'postgresql://u:p@db.charitypilot.ie/db?sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write',
    'postgresql://u:p@db.charitypilot.ie/db?sslmode=verify-full&sslrootcert=relative-ca.pem&target_session_attrs=read-write',
  ];
  for (const url of unsafeUrls) {
    let queried = false;
    const prisma = {
      documentStorageDeletion: { findFirst: async () => { queried = true; return null; } },
      $transaction: async () => assert.fail('unsafe authority must not open a transaction'),
    };
    await assert.rejects(
      runPlatformDocumentStorageRecovery(
        { ...command(), mode: 'dry-run', executionConfirmation: undefined },
        prisma as never,
        productionEnv(url),
      ),
      /Document storage recovery refused/u,
    );
    assert.equal(queried, false);
  }

  await assert.rejects(
    runPlatformDocumentStorageRecovery(
      { ...command(), mode: 'dry-run', executionConfirmation: undefined },
      { documentStorageDeletion: { findFirst: async () => null }, $transaction: async () => undefined } as never,
      { ...productionEnv(), DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST: 'other.charitypilot.ie' },
    ),
    /explicit recovery allowlist/u,
  );

  const trustedCaUrl = new URL(productionEnv().DATABASE_URL);
  trustedCaUrl.searchParams.set('sslrootcert', resolve(process.cwd(), 'trusted-production-ca.pem'));
  const trustedCaMock = database();
  const trustedCaResult = await runPlatformDocumentStorageRecovery(
    { ...command(), mode: 'dry-run', executionConfirmation: undefined },
    trustedCaMock.prisma as never,
    productionEnv(trustedCaUrl.toString()),
  );
  assert.equal(trustedCaResult.mode, 'DRY_RUN');
});

test('platform dry-run can inspect a dead letter without tenant subscription or active-session access and emits no path', async () => {
  const mock = database();
  const result = await runPlatformDocumentStorageRecovery(
    { ...command(), mode: 'dry-run', executionConfirmation: undefined },
    mock.prisma as never,
    productionEnv(),
  );
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.mutationApplied, false);
  assert.equal(result.terminalReason, 'PERMANENT_STORAGE_PATH_REJECTED');
  assert.ok('requiredExecutionConfirmation' in result);
  assert.match(result.requiredExecutionConfirmation, /deletion-1.*org-1.*PERMANENT_STORAGE_PATH_REJECTED/u);
  assert.match(result.requiredExecutionConfirmation, new RegExp(DATABASE_AUTHORITY_SHA256, 'u'));
  assert.match(result.requiredExecutionConfirmation, new RegExp(CORRECTED_PATH_SHA256, 'u'));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('foreign-org/rejected.pdf'), false);
  assert.equal(serialized.includes('corrected.pdf'), false);
  assert.equal(serialized.includes('Jane Recovery Operator'), false);
});

test('platform corrected-path execution records immutable operator evidence and returns no object key', async () => {
  const mock = database();
  const result = await runPlatformDocumentStorageRecovery(command(), mock.prisma as never, productionEnv());
  assert.equal(result.mode, 'EXECUTED');
  assert.ok('status' in result);
  assert.equal(result.status, 'PENDING');
  assert.equal(mock.audit()?.data?.actorType, 'PLATFORM_OPERATOR');
  assert.equal(mock.audit()?.data?.operatorIdentity, 'Jane Recovery Operator');
  assert.equal(mock.audit()?.data?.previousStoragePath, 'foreign-org/rejected.pdf');
  assert.equal(mock.audit()?.data?.correctedStoragePath, 'org-1/corrected.pdf');
  assert.equal(mock.update()?.data?.storagePath, 'org-1/corrected.pdf');
  assert.equal(JSON.stringify(result).includes('corrected.pdf'), false);
  assert.equal(JSON.stringify(result).includes('rejected.pdf'), false);
});

test('execute refuses a database authority or corrected path that changed after dry-run', async () => {
  for (const changed of [
    { expectedDatabaseAuthoritySha256: '0'.repeat(64) },
    { expectedCorrectedStoragePathSha256: 'f'.repeat(64) },
  ]) {
    const mock = database();
    await assert.rejects(
      runPlatformDocumentStorageRecovery(command(changed), mock.prisma as never, productionEnv()),
      /changed after dry-run/u,
    );
    assert.equal(mock.audit(), undefined);
  }
});

test('corrected-path execution fails closed for a live document or any deletion-history collision', async () => {
  for (const collision of [
    { liveDocument: true, otherDeletion: false },
    { liveDocument: false, otherDeletion: true },
  ]) {
    const mock = database();
    let collisionQuery = '';
    (mock.prisma as { $queryRaw: (strings: TemplateStringsArray) => Promise<unknown[]> }).$queryRaw = async (strings) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "Organisation"')) return [{ id: 'org-1' }];
      if (sql.includes('AS "liveDocument"')) {
        collisionQuery = sql;
        return [collision];
      }
      return [DEAD_LETTER];
    };
    await assert.rejects(
      runPlatformDocumentStorageRecovery(command(), mock.prisma as never, productionEnv()),
      (error: unknown) => (error as { code?: string }).code === 'CORRECTED_STORAGE_PATH_IN_USE',
    );
    assert.match(collisionQuery, /FROM "Document"\s+WHERE "fileUrl" =/u);
    assert.match(collisionQuery, /FROM "DocumentStorageDeletion"\s+WHERE "id" <>/u);
    assert.doesNotMatch(collisionQuery, /"organisationId"/u);
    assert.doesNotMatch(collisionQuery, /"state"/u);
    assert.equal(mock.audit(), undefined);
  }
});

test('platform recovery can preserve orphaned deletion evidence after an organisation is deleted', async () => {
  const orphanedDeadLetter = {
    ...DEAD_LETTER,
    id: 'orphaned-deletion',
    organisationId: 'org-deleted',
    storagePath: 'org-deleted/orphan.pdf',
    attempts: 5,
    terminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
  } as const;
  const mock = database(orphanedDeadLetter);
  (mock.prisma as { $queryRaw: (strings: TemplateStringsArray) => Promise<unknown[]> }).$queryRaw = async (strings) =>
    strings.join('?').includes('FROM "Organisation"') ? [] : [orphanedDeadLetter];
  const executionConfirmation = platformDocumentRecoveryConfirmation({
    organisationId: 'org-deleted',
    deletionId: 'orphaned-deletion',
    disposition: 'REQUEUE_UNCHANGED',
    expectedAttempts: 5,
    expectedTerminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
    databaseAuthoritySha256: DATABASE_AUTHORITY_SHA256,
    correctedStoragePathSha256: null,
  });
  const result = await runPlatformDocumentStorageRecovery(
    command({
      organisationId: 'org-deleted',
      deletionId: 'orphaned-deletion',
      disposition: 'REQUEUE_UNCHANGED',
      correctedStoragePath: undefined,
      expectedAttempts: 5,
      expectedTerminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
      expectedCorrectedStoragePathSha256: undefined,
      executionConfirmation,
    }),
    mock.prisma as never,
    productionEnv(),
  );
  assert.ok('status' in result);
  assert.equal(result.status, 'PENDING');
  assert.equal(mock.audit()?.data?.organisationId, 'org-deleted');
  assert.equal(mock.audit()?.data?.actorType, 'PLATFORM_OPERATOR');
});

test('platform external completion is explicit and terminal while unchanged permanent recovery is refused', async () => {
  const externalMock = database();
  const external = await runPlatformDocumentStorageRecovery(
    command({
      disposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
      correctedStoragePath: undefined,
      expectedCorrectedStoragePathSha256: undefined,
      executionConfirmation: platformDocumentRecoveryConfirmation({
        organisationId: 'org-1', deletionId: 'deletion-1',
        disposition: 'COMPLETE_EXTERNALLY_REMEDIATED', expectedAttempts: 1,
        expectedTerminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
        databaseAuthoritySha256: DATABASE_AUTHORITY_SHA256,
        correctedStoragePathSha256: null,
      }),
    }),
    externalMock.prisma as never,
    productionEnv(),
  );
  assert.ok('status' in external);
  assert.equal(external.status, 'PROCESSED');
  assert.equal(externalMock.audit()?.data?.disposition, 'COMPLETE_EXTERNALLY_REMEDIATED');
  assert.equal(externalMock.update()?.data?.state, 'PROCESSED');

  const unchangedMock = database();
  await assert.rejects(
    runPlatformDocumentStorageRecovery(
      command({
        disposition: 'REQUEUE_UNCHANGED',
        correctedStoragePath: undefined,
        expectedCorrectedStoragePathSha256: undefined,
        executionConfirmation: platformDocumentRecoveryConfirmation({
          organisationId: 'org-1', deletionId: 'deletion-1',
          disposition: 'REQUEUE_UNCHANGED', expectedAttempts: 1,
          expectedTerminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
          databaseAuthoritySha256: DATABASE_AUTHORITY_SHA256,
          correctedStoragePathSha256: null,
        }),
      }),
      unchangedMock.prisma as never,
      productionEnv(),
    ),
    (error: unknown) => (error as { code?: string }).code === 'PERMANENT_STORAGE_PATH_REQUIRES_DISPOSITION',
  );
  assert.equal(unchangedMock.audit(), undefined);
});

test('one-shot CLI failures emit only a bounded code and never echo database credentials or object keys', () => {
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const entrypoint = fileURLToPath(new URL(`../jobs/recover-document-storage-deletion.${extension}`, import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', entrypoint,
      '--dry-run', '--confirm-production-database-authority',
      '--organisation-id', 'org-1', '--deletion-id', 'deletion-1',
      '--operator', 'Jane Recovery Operator',
      '--reason', 'Reviewed provider evidence authorizes this recovery.',
      '--disposition', 'REQUEUE_CORRECTED_PATH',
      '--corrected-storage-path', 'org-1/highly-sensitive-object-key.pdf',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://recovery:do-not-leak@127.0.0.1:5432/private?sslmode=verify-full&target_session_attrs=read-write',
        DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST: '127.0.0.1',
      },
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\{"ok":false,"code":"DOCUMENT_STORAGE_RECOVERY_FAILED"\}\s*$/u);
  assert.doesNotMatch(result.stderr + result.stdout, /do-not-leak|127\.0\.0\.1|highly-sensitive|postgresql:\/\//u);
});
