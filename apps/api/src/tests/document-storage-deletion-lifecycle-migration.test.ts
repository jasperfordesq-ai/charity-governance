import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runDomainInvariantsPrismaConcurrencyProof } from './domain-invariants-live.js';
import { runLoginPasswordResetRaceProof } from './auth-login-reset-race-live.js';
import { runPasswordRecoveryConcurrencyProof } from './password-recovery-live.js';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260711213000_add_document_storage_deletion_retry_lifecycle/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const postgresBackupScript = readFileSync(
  new URL('../../../../scripts/postgres-backup.mjs', import.meta.url),
  'utf8',
);
const require = createRequire(import.meta.url);
const { DISPOSABLE_DATABASE_RESET_TABLES } = require(
  '../../../../e2e/helpers/database-safety.cjs',
) as { DISPOSABLE_DATABASE_RESET_TABLES: readonly string[] };
const POSTGRES_IMAGE = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

function docker(args: string[], input?: string, timeout = 30_000) {
  return spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertDockerSuccess(result: ReturnType<typeof docker>, operation: string): void {
  assert.equal(
    result.status,
    0,
    `${operation} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').slice(0, 1000)}`,
  );
}

function psql(container: string, sql: string, expectedSuccess = true) {
  const result = docker(
    ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
    sql,
    30_000,
  );
  if (expectedSuccess) assertDockerSuccess(result, 'PostgreSQL fixture command');
  else assert.notEqual(result.status, 0, 'forged PostgreSQL transition unexpectedly succeeded');
  return result;
}

function psqlAsync(container: string, sql: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}

async function waitForPostgres(container: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    // The official image briefly starts an init-only Unix-socket server before
    // launching the final TCP listener. Waiting on TCP avoids a false-ready
    // window where pg_isready succeeds and the next psql command sees no socket.
    const ready = docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], undefined, 5_000);
    if (ready.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Disposable PostgreSQL 16 fixture did not become ready');
}

async function removeDisposableContainer(container: string): Promise<void> {
  const removal = docker(['rm', '--force', container], undefined, 20_000);
  let lastResidue = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const residue = docker(
      ['ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.ID}}'],
      undefined,
      10_000,
    );
    assertDockerSuccess(residue, 'Disposable PostgreSQL residue check');
    lastResidue = residue.stdout.trim();
    if (!lastResidue) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(
    `Disposable PostgreSQL cleanup left container residue ${lastResidue}; ` +
    `docker rm status=${removal.status ?? 'none'} error=${removal.error?.message ?? 'none'}`,
  );
}

test('document storage deletion retry migration is atomic and backfills legacy rows safely', () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /WHERE "processedAt" IS NOT NULL/);
  assert.match(migration, /"state" = 'PROCESSED'/);
  assert.match(migration, /WHERE "processedAt" IS NULL[\s\S]*"attempts" >= 5/);
  assert.match(migration, /"state" = 'DEAD_LETTER'/);
  assert.match(migration, /"terminalReason" = 'MAX_ATTEMPTS_EXHAUSTED'/);
  assert.match(migration, /SET "lastError" = left\("lastError", 500\)/);
});

test('schema and migration encode bounded due retries and terminal dead letters', () => {
  assert.match(schema, /enum DocumentStorageDeletionState[\s\S]*PENDING[\s\S]*DEAD_LETTER[\s\S]*PROCESSED/);
  assert.match(schema, /model DocumentStorageDeletion[\s\S]*nextAttemptAt\s+DateTime\?/);
  assert.match(schema, /model DocumentStorageDeletion[\s\S]*deadLetteredAt\s+DateTime\?/);
  assert.match(schema, /model DocumentStorageDeletion[\s\S]*terminalReason\s+DocumentStorageDeletionTerminalReason\?/);
  assert.match(migration, /"state" = 'PENDING'[\s\S]*"attempts" < 5/);
  assert.match(migration, /"state" = 'DEAD_LETTER'[\s\S]*"nextAttemptAt" IS NULL/);
  assert.match(migration, /DocumentStorageDeletion_state_nextAttemptAt_claimedAt_createdAt_idx/);
  assert.match(migration, /DocumentStorageDeletion_lastError_bounded/);
});

test('operator recovery is tenant-bound, admin-authorized, and append-only at the database layer', () => {
  assert.match(schema, /model DocumentStorageDeletionRecovery/);
  assert.match(migration, /DocumentStorageDeletionRecovery_deletionId_fkey/);
  assert.match(migration, /deletion\."organisationId" = NEW\."organisationId"/);
  assert.match(migration, /actor\."organisationId" = NEW\."organisationId"/);
  assert.match(migration, /actor\."role" IN \('OWNER', 'ADMIN'\)/);
  assert.match(migration, /actor\."lifecycleStatus" = 'ACTIVE'/);
  assert.match(migration, /NEW\."transactionId" := txid_current\(\)/);
  assert.match(migration, /candidate\."transactionId" = txid_current\(\)/);
  assert.match(migration, /candidate\."recoveryNonce" = NEW\."lastRecoveryNonce"/);
  assert.doesNotMatch(migration, /"createdAt" >= transaction_timestamp\(\)/);
  assert.match(migration, /Corrected-path and external completion dispositions require platform operations/);
  assert.match(migration, /DocumentStorageDeletionRecovery_append_only/);
  assert.match(migration, /DocumentStorageDeletion_no_delete/);
  assert.match(migration, /Dead-letter recovery requires an exact immutable event from the current transaction/);
  assert.match(migration, /FROM "Organisation" organisation[\s\S]*FOR UPDATE;/);
  assert.match(migration, /IF NOT recovery_transition AND \([\s\S]*NEW\."lastRecoveryId" IS DISTINCT FROM OLD\."lastRecoveryId"/);
});

test('real migration proof uses the repository-approved digest-pinned PostgreSQL tools image', () => {
  assert.equal(
    POSTGRES_IMAGE,
    'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c',
  );
  assert.match(
    postgresBackupScript,
    /const DEFAULT_POSTGRES_IMAGE = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';/,
  );
});

test('real PostgreSQL 16 migration enforces nonce-bound recovery, dispositions, concurrency, and dirty-row backfill', { timeout: 300_000 }, async () => {
  // Docker Desktop can serialize engine requests while the full API suite is
  // running. Keep this availability probe bounded, but do not misclassify a
  // temporarily busy local engine as an absent engine.
  const dockerAvailable = docker(['version', '--format', '{{.Server.Version}}'], undefined, 60_000);
  assertDockerSuccess(dockerAvailable, 'Docker availability check for real migration proof');
  const container = `charitypilot-document-recovery-${randomUUID()}`;
  const start = docker([
    'run', '--detach', '--rm', '--name', container,
    '--env', 'POSTGRES_PASSWORD=document-recovery-fixture-only',
    POSTGRES_IMAGE,
  ], undefined, 120_000);
  assertDockerSuccess(start, 'Disposable PostgreSQL 16 startup');

  const platformEventSql = (input: {
    recoveryId: string;
    nonce: string;
    deletionId: string;
    disposition: 'REQUEUE_UNCHANGED' | 'REQUEUE_CORRECTED_PATH' | 'COMPLETE_EXTERNALLY_REMEDIATED';
    attempts: number;
    terminalReason: 'MAX_ATTEMPTS_EXHAUSTED' | 'PERMANENT_STORAGE_PATH_REJECTED';
    previousPath: string;
    correctedPath?: string;
    organisationId?: string;
  }) => `
    INSERT INTO "DocumentStorageDeletionRecovery" (
      "id", "recoveryNonce", "deletionId", "organisationId", "actorType",
      "actorUserId", "operatorIdentity", "reason", "disposition",
      "previousAttempts", "previousTerminalReason", "previousStoragePath", "correctedStoragePath"
    ) VALUES (
      '${input.recoveryId}', '${input.nonce}', '${input.deletionId}', '${input.organisationId ?? 'org-1'}', 'PLATFORM_OPERATOR',
      NULL, 'Jane Recovery Operator', 'Reviewed provider evidence authorizes this recovery.', '${input.disposition}',
      ${input.attempts}, '${input.terminalReason}', '${input.previousPath}', ${input.correctedPath ? `'${input.correctedPath}'` : 'NULL'}
    );
  `;
  const recoveryUpdateSql = (input: {
    recoveryId: string;
    nonce: string;
    deletionId: string;
    disposition: 'REQUEUE_UNCHANGED' | 'REQUEUE_CORRECTED_PATH' | 'COMPLETE_EXTERNALLY_REMEDIATED';
    resultingPath: string;
    processed?: boolean;
  }) => input.processed ? `
    UPDATE "DocumentStorageDeletion"
    SET "state" = 'PROCESSED', "storagePath" = '${input.resultingPath}',
        "lastError" = NULL, "nextAttemptAt" = NULL, "claimedAt" = NULL,
        "deadLetteredAt" = NULL, "terminalReason" = NULL,
        "alertClaimToken" = NULL, "alertClaimedAt" = NULL, "alertedAt" = NULL,
        "processedAt" = CURRENT_TIMESTAMP,
        "lastRecoveryId" = '${input.recoveryId}', "lastRecoveryNonce" = '${input.nonce}',
        "lastRecoveryDisposition" = '${input.disposition}', "lastRecoveredAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${input.deletionId}';
  ` : `
    UPDATE "DocumentStorageDeletion"
    SET "state" = 'PENDING', "attempts" = 0, "storagePath" = '${input.resultingPath}',
        "lastError" = NULL, "lastAttemptAt" = NULL, "nextAttemptAt" = CURRENT_TIMESTAMP,
        "claimedAt" = NULL, "deadLetteredAt" = NULL, "terminalReason" = NULL,
        "alertClaimToken" = NULL, "alertClaimedAt" = NULL, "alertedAt" = NULL,
        "processedAt" = NULL,
        "lastRecoveryId" = '${input.recoveryId}', "lastRecoveryNonce" = '${input.nonce}',
        "lastRecoveryDisposition" = '${input.disposition}', "lastRecoveredAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${input.deletionId}';
  `;
  const resetDeadLetterSql = (deletionId: string) => `
    UPDATE "DocumentStorageDeletion"
    SET "state" = 'DEAD_LETTER', "attempts" = 5, "lastError" = 'provider unavailable',
        "lastAttemptAt" = CURRENT_TIMESTAMP, "nextAttemptAt" = NULL, "claimedAt" = NULL,
        "deadLetteredAt" = CURRENT_TIMESTAMP, "terminalReason" = 'MAX_ATTEMPTS_EXHAUSTED',
        "alertClaimToken" = NULL, "alertClaimedAt" = NULL, "alertedAt" = NULL,
        "processedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${deletionId}';
  `;

  try {
    await waitForPostgres(container);
    const permanentUnchangedNonce = randomUUID();
    psql(container, `
      CREATE TABLE "Organisation" (
        "id" TEXT PRIMARY KEY
      );
      CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
      CREATE TYPE "UserLifecycleStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');
      CREATE TABLE "User" (
        "id" TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL,
        "role" "UserRole" NOT NULL,
        "lifecycleStatus" "UserLifecycleStatus" NOT NULL
      );
      CREATE TABLE "Document" (
        "id" TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL,
        "fileUrl" TEXT NOT NULL
      );
      CREATE TABLE "DocumentStorageDeletion" (
        "id" TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL,
        "storagePath" TEXT NOT NULL,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "lastError" TEXT,
        "claimedAt" TIMESTAMP(3),
        "processedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO "Organisation" VALUES ('org-1'), ('org-other');
      INSERT INTO "User" VALUES ('owner-1', 'org-1', 'OWNER', 'ACTIVE');
      INSERT INTO "Document" VALUES ('live-document', 'org-other', 'org-1/live-object.pdf');
      INSERT INTO "DocumentStorageDeletion" ("id", "organisationId", "storagePath", "attempts", "lastError") VALUES
        ('legacy-long', 'org-1', 'org-1/legacy.pdf', 1, repeat('x', 700)),
        ('repeat-row', 'org-1', 'org-1/repeat.pdf', 5, 'provider unavailable'),
        ('permanent-row', 'org-1', 'foreign-org/rejected.pdf', 1, 'path rejected'),
        ('external-row', 'org-1', 'org-1/external.pdf', 5, 'provider unavailable'),
        ('concurrent-row', 'org-1', 'org-1/concurrent.pdf', 5, 'provider unavailable'),
        ('deleted-org-row', 'org-deleted', 'org-deleted/orphan.pdf', 5, 'provider unavailable');
      INSERT INTO "DocumentStorageDeletion" (
        "id", "organisationId", "storagePath", "attempts", "lastError", "processedAt"
      ) VALUES (
        'historical-row', 'org-other', 'org-1/historical-object.pdf', 1, NULL, CURRENT_TIMESTAMP
      );
    `);
    psql(container, migration);

    const legacyEvidence = psql(container, `
      SELECT "state" || '|' || char_length("lastError")
      FROM "DocumentStorageDeletion" WHERE "id" = 'legacy-long';
    `).stdout.trim();
    assert.equal(legacyEvidence, 'PENDING|500');

    psql(container, `
      INSERT INTO "DocumentStorageDeletion" (
        "id", "organisationId", "storagePath", "attempts",
        "lastRecoveryId", "lastRecoveryNonce", "lastRecoveryDisposition", "lastRecoveredAt"
      ) VALUES (
        'fabricated-binding-row', 'org-1', 'org-1/fabricated.pdf', 0,
        'fabricated-recovery', '${randomUUID()}', 'REQUEUE_UNCHANGED', CURRENT_TIMESTAMP
      );
    `, false);

    psql(container, `
      UPDATE "DocumentStorageDeletion"
      SET "state" = 'DEAD_LETTER', "attempts" = 1, "lastAttemptAt" = CURRENT_TIMESTAMP,
          "nextAttemptAt" = NULL, "claimedAt" = NULL, "deadLetteredAt" = CURRENT_TIMESTAMP,
          "terminalReason" = 'PERMANENT_STORAGE_PATH_REJECTED', "processedAt" = NULL
      WHERE "id" = 'permanent-row';
    `);

    for (const invalidEvent of [
      `
        INSERT INTO "DocumentStorageDeletionRecovery" (
          "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
          "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath"
        ) VALUES (
          'weak-nonce', 'not-a-random-uuid', 'repeat-row', 'org-1', 'PLATFORM_OPERATOR',
          'Jane Recovery Operator', 'This event has a malformed recovery nonce.', 'REQUEUE_UNCHANGED',
          5, 'MAX_ATTEMPTS_EXHAUSTED', 'org-1/repeat.pdf'
        );
      `,
      `
        INSERT INTO "DocumentStorageDeletionRecovery" (
          "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
          "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath"
        ) VALUES (
          'control-reason', '${randomUUID()}', 'repeat-row', 'org-1', 'PLATFORM_OPERATOR',
          'Jane Recovery Operator', E'Unsafe\trecovery reason must be rejected.', 'REQUEUE_UNCHANGED',
          5, 'MAX_ATTEMPTS_EXHAUSTED', 'org-1/repeat.pdf'
        );
      `,
      `
        INSERT INTO "DocumentStorageDeletionRecovery" (
          "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
          "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath"
        ) VALUES (
          'weak-operator', '${randomUUID()}', 'repeat-row', 'org-1', 'PLATFORM_OPERATOR',
          'operator', 'A generic operator identity must be rejected.', 'REQUEUE_UNCHANGED',
          5, 'MAX_ATTEMPTS_EXHAUSTED', 'org-1/repeat.pdf'
        );
      `,
      `
        INSERT INTO "DocumentStorageDeletionRecovery" (
          "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
          "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath", "correctedStoragePath"
        ) VALUES (
          'overlong-corrected-path', '${randomUUID()}', 'permanent-row', 'org-1', 'PLATFORM_OPERATOR',
          'Jane Recovery Operator', 'An overlong corrected path must be rejected.', 'REQUEUE_CORRECTED_PATH',
          1, 'PERMANENT_STORAGE_PATH_REJECTED', 'foreign-org/rejected.pdf', 'org-1/' || repeat('a', 1020)
        );
      `,
      `
        INSERT INTO "DocumentStorageDeletionRecovery" (
          "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
          "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath", "correctedStoragePath"
        ) VALUES (
          'control-corrected-path', '${randomUUID()}', 'permanent-row', 'org-1', 'PLATFORM_OPERATOR',
          'Jane Recovery Operator', 'A control character path must be rejected.', 'REQUEUE_CORRECTED_PATH',
          1, 'PERMANENT_STORAGE_PATH_REJECTED', 'foreign-org/rejected.pdf', E'org-1/unsafe\tpath.pdf'
        );
      `,
      `
        INSERT INTO "DocumentStorageDeletionRecovery" (
          "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
          "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath", "correctedStoragePath"
        ) VALUES (
          'live-corrected-path', '${randomUUID()}', 'permanent-row', 'org-1', 'PLATFORM_OPERATOR',
          'Jane Recovery Operator', 'A live document path must never be selected for deletion.', 'REQUEUE_CORRECTED_PATH',
          1, 'PERMANENT_STORAGE_PATH_REJECTED', 'foreign-org/rejected.pdf', 'org-1/live-object.pdf'
        );
      `,
      `
        INSERT INTO "DocumentStorageDeletionRecovery" (
          "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
          "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath", "correctedStoragePath"
        ) VALUES (
          'historical-corrected-path', '${randomUUID()}', 'permanent-row', 'org-1', 'PLATFORM_OPERATOR',
          'Jane Recovery Operator', 'A historically processed deletion path must never be selected again.', 'REQUEUE_CORRECTED_PATH',
          1, 'PERMANENT_STORAGE_PATH_REJECTED', 'foreign-org/rejected.pdf', 'org-1/historical-object.pdf'
        );
      `,
    ]) {
      psql(container, invalidEvent, false);
    }

    const repeatedTransactions: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const recoveryId = `repeat-recovery-${index}`;
      const nonce = randomUUID();
      repeatedTransactions.push(`
        BEGIN;
        SELECT "id" FROM "Organisation" WHERE "id" = 'org-1' FOR UPDATE;
        SELECT "id" FROM "DocumentStorageDeletion" WHERE "id" = 'repeat-row' FOR UPDATE;
        ${platformEventSql({
          recoveryId,
          nonce,
          deletionId: 'repeat-row',
          disposition: 'REQUEUE_UNCHANGED',
          attempts: 5,
          terminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
          previousPath: 'org-1/repeat.pdf',
        })}
        ${recoveryUpdateSql({
          recoveryId,
          nonce,
          deletionId: 'repeat-row',
          disposition: 'REQUEUE_UNCHANGED',
          resultingPath: 'org-1/repeat.pdf',
        })}
        ${resetDeadLetterSql('repeat-row')}
        COMMIT;
      `);
    }
    psql(container, repeatedTransactions.join('\n'));
    assert.equal(
      psql(container, `SELECT count(*) FROM "DocumentStorageDeletionRecovery" WHERE "deletionId" = 'repeat-row';`).stdout.trim(),
      '20',
    );
    psql(container, `
      UPDATE "DocumentStorageDeletion"
      SET "lastRecoveryNonce" = '${randomUUID()}', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'repeat-row';
    `, false);

    psql(container, `
      UPDATE "DocumentStorageDeletion"
      SET "state" = 'PENDING', "attempts" = 0, "lastError" = NULL, "lastAttemptAt" = NULL,
          "nextAttemptAt" = CURRENT_TIMESTAMP, "deadLetteredAt" = NULL, "terminalReason" = NULL,
          "lastRecoveryId" = 'forged-event', "lastRecoveryNonce" = '${randomUUID()}',
          "lastRecoveryDisposition" = 'REQUEUE_UNCHANGED', "lastRecoveredAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'repeat-row';
    `, false);
    psql(container, `
      INSERT INTO "DocumentStorageDeletionRecovery" (
        "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "operatorIdentity",
        "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath"
      ) VALUES (
        'cross-tenant-event', '${randomUUID()}', 'repeat-row', 'org-other', 'PLATFORM_OPERATOR',
        'Jane Recovery Operator', 'Cross tenant insertion must be rejected safely.', 'REQUEUE_UNCHANGED',
        5, 'MAX_ATTEMPTS_EXHAUSTED', 'org-1/repeat.pdf'
      );
    `, false);

    psql(container, `
      BEGIN;
      SELECT "id" FROM "Organisation" WHERE "id" = 'org-1' FOR UPDATE;
      SELECT "id" FROM "DocumentStorageDeletion" WHERE "id" = 'permanent-row' FOR UPDATE;
      ${platformEventSql({
        recoveryId: 'permanent-unchanged', nonce: permanentUnchangedNonce, deletionId: 'permanent-row',
        disposition: 'REQUEUE_UNCHANGED', attempts: 1,
        terminalReason: 'PERMANENT_STORAGE_PATH_REJECTED', previousPath: 'foreign-org/rejected.pdf',
      })}
      ${recoveryUpdateSql({
        recoveryId: 'permanent-unchanged', nonce: permanentUnchangedNonce, deletionId: 'permanent-row',
        disposition: 'REQUEUE_UNCHANGED', resultingPath: 'foreign-org/rejected.pdf',
      })}
      COMMIT;
    `, false);

    psql(container, `
      INSERT INTO "DocumentStorageDeletionRecovery" (
        "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "actorUserId",
        "reason", "disposition", "previousAttempts", "previousTerminalReason", "previousStoragePath", "correctedStoragePath"
      ) VALUES (
        'tenant-corrected-forbidden', '${randomUUID()}', 'permanent-row', 'org-1', 'TENANT_USER', 'owner-1',
        'Tenant actors cannot choose an arbitrary corrected object key.', 'REQUEUE_CORRECTED_PATH',
        1, 'PERMANENT_STORAGE_PATH_REJECTED', 'foreign-org/rejected.pdf', 'org-1/corrected.pdf'
      );
    `, false);

    const correctedNonce = randomUUID();
    psql(container, `
      BEGIN;
      SELECT "id" FROM "Organisation" WHERE "id" = 'org-1' FOR UPDATE;
      SELECT "id" FROM "DocumentStorageDeletion" WHERE "id" = 'permanent-row' FOR UPDATE;
      ${platformEventSql({
        recoveryId: 'permanent-corrected', nonce: correctedNonce, deletionId: 'permanent-row',
        disposition: 'REQUEUE_CORRECTED_PATH', attempts: 1,
        terminalReason: 'PERMANENT_STORAGE_PATH_REJECTED', previousPath: 'foreign-org/rejected.pdf',
        correctedPath: 'org-1/corrected.pdf',
      })}
      ${recoveryUpdateSql({
        recoveryId: 'permanent-corrected', nonce: correctedNonce, deletionId: 'permanent-row',
        disposition: 'REQUEUE_CORRECTED_PATH', resultingPath: 'org-1/corrected.pdf',
      })}
      COMMIT;
    `);
    assert.equal(
      psql(container, `
        SELECT deletion."state" || '|' || deletion."storagePath" || '|' || recovery."previousStoragePath" || '|' || recovery."correctedStoragePath"
        FROM "DocumentStorageDeletion" deletion
        JOIN "DocumentStorageDeletionRecovery" recovery ON recovery."id" = deletion."lastRecoveryId"
        WHERE deletion."id" = 'permanent-row';
      `).stdout.trim(),
      'PENDING|org-1/corrected.pdf|foreign-org/rejected.pdf|org-1/corrected.pdf',
    );
    psql(container, `
      UPDATE "DocumentStorageDeletion"
      SET "lastRecoveryNonce" = '${randomUUID()}', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'permanent-row';
    `, false);

    const externalNonce = randomUUID();
    psql(container, `
      BEGIN;
      SELECT "id" FROM "Organisation" WHERE "id" = 'org-1' FOR UPDATE;
      SELECT "id" FROM "DocumentStorageDeletion" WHERE "id" = 'external-row' FOR UPDATE;
      ${platformEventSql({
        recoveryId: 'external-completion', nonce: externalNonce, deletionId: 'external-row',
        disposition: 'COMPLETE_EXTERNALLY_REMEDIATED', attempts: 5,
        terminalReason: 'MAX_ATTEMPTS_EXHAUSTED', previousPath: 'org-1/external.pdf',
      })}
      ${recoveryUpdateSql({
        recoveryId: 'external-completion', nonce: externalNonce, deletionId: 'external-row',
        disposition: 'COMPLETE_EXTERNALLY_REMEDIATED', resultingPath: 'org-1/external.pdf', processed: true,
      })}
      COMMIT;
    `);
    assert.equal(
      psql(container, `SELECT "state" || '|' || "lastRecoveryDisposition" FROM "DocumentStorageDeletion" WHERE "id" = 'external-row';`).stdout.trim(),
      'PROCESSED|COMPLETE_EXTERNALLY_REMEDIATED',
    );

    const deletedOrganisationNonce = randomUUID();
    psql(container, `
      BEGIN;
      ${platformEventSql({
        recoveryId: 'deleted-organisation-recovery', nonce: deletedOrganisationNonce,
        deletionId: 'deleted-org-row', organisationId: 'org-deleted',
        disposition: 'REQUEUE_UNCHANGED', attempts: 5,
        terminalReason: 'MAX_ATTEMPTS_EXHAUSTED', previousPath: 'org-deleted/orphan.pdf',
      })}
      ${recoveryUpdateSql({
        recoveryId: 'deleted-organisation-recovery', nonce: deletedOrganisationNonce,
        deletionId: 'deleted-org-row', disposition: 'REQUEUE_UNCHANGED',
        resultingPath: 'org-deleted/orphan.pdf',
      })}
      COMMIT;
    `);
    assert.equal(
      psql(container, `SELECT "state" || '|' || "lastRecoveryId" FROM "DocumentStorageDeletion" WHERE "id" = 'deleted-org-row';`).stdout.trim(),
      'PENDING|deleted-organisation-recovery',
    );

    const organisationLockHolder = psqlAsync(container, `
      BEGIN;
      SELECT "id" FROM "Organisation" WHERE "id" = 'org-1' FOR UPDATE;
      SELECT pg_sleep(1.5);
      COMMIT;
    `);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const organisationLockContender = psql(container, `
      BEGIN;
      SET LOCAL lock_timeout = '300ms';
      ${platformEventSql({
        recoveryId: 'organisation-lock-contender', nonce: randomUUID(), deletionId: 'concurrent-row',
        disposition: 'REQUEUE_UNCHANGED', attempts: 5,
        terminalReason: 'MAX_ATTEMPTS_EXHAUSTED', previousPath: 'org-1/concurrent.pdf',
      })}
      COMMIT;
    `, false);
    assert.match(organisationLockContender.stderr, /lock timeout|canceling statement/u);
    const organisationLockOwner = await organisationLockHolder;
    assert.equal(
      organisationLockOwner.status,
      0,
      `organisation lock owner failed: ${organisationLockOwner.stderr.slice(0, 1000)}`,
    );
    assert.equal(
      psql(container, `SELECT count(*) FROM "DocumentStorageDeletionRecovery" WHERE "id" = 'organisation-lock-contender';`).stdout.trim(),
      '0',
    );

    const concurrentNonce = randomUUID();
    const firstWorker = psqlAsync(container, `
      BEGIN;
      SELECT "id" FROM "Organisation" WHERE "id" = 'org-1' FOR UPDATE;
      SELECT "id" FROM "DocumentStorageDeletion" WHERE "id" = 'concurrent-row' FOR UPDATE;
      SELECT pg_sleep(1.5);
      ${platformEventSql({
        recoveryId: 'concurrent-winner', nonce: concurrentNonce, deletionId: 'concurrent-row',
        disposition: 'REQUEUE_UNCHANGED', attempts: 5,
        terminalReason: 'MAX_ATTEMPTS_EXHAUSTED', previousPath: 'org-1/concurrent.pdf',
      })}
      ${recoveryUpdateSql({
        recoveryId: 'concurrent-winner', nonce: concurrentNonce, deletionId: 'concurrent-row',
        disposition: 'REQUEUE_UNCHANGED', resultingPath: 'org-1/concurrent.pdf',
      })}
      COMMIT;
    `);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const contender = psql(container, `
      BEGIN;
      SET LOCAL lock_timeout = '300ms';
      SELECT "id" FROM "DocumentStorageDeletion" WHERE "id" = 'concurrent-row' FOR UPDATE;
      COMMIT;
    `, false);
    assert.match(contender.stderr, /lock timeout|canceling statement/u);
    const winner = await firstWorker;
    assert.equal(winner.status, 0, `lock-owning recovery failed: ${winner.stderr.slice(0, 1000)}`);
    assert.equal(
      psql(container, `SELECT "state" || '|' || "lastRecoveryId" FROM "DocumentStorageDeletion" WHERE "id" = 'concurrent-row';`).stdout.trim(),
      'PENDING|concurrent-winner',
    );
  } finally {
    await removeDisposableContainer(container);
  }
});

test('real PostgreSQL 16 migration serializes board references and exposes safe Prisma domain metadata', { timeout: 300_000 }, async () => {
  await runDomainInvariantsPrismaConcurrencyProof(POSTGRES_IMAGE);
});

test('real PostgreSQL 16 migration serializes password recovery requests and reset consumption', { timeout: 300_000 }, async () => {
  await runPasswordRecoveryConcurrencyProof(POSTGRES_IMAGE);
});

test('real PostgreSQL 16 migration serializes login issuance against password reset', { timeout: 300_000 }, async () => {
  await runLoginPasswordResetRaceProof(POSTGRES_IMAGE);
});

test('real PostgreSQL 16 migration binds complaint recovery outcomes to the exact claim transaction', { timeout: 120_000 }, async () => {
  const container = `charitypilot-outcome-${randomUUID()}`;
  assertDockerSuccess(docker(['run', '--detach', '--name', container, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'start outcome fixture');
  try {
    await waitForPostgres(container);
    // Minimal parent tables isolate this migration's guard. These fixtures do
    // not claim coverage of the separate production claim/deletion triggers.
    psql(container, `
      CREATE TABLE "Organisation" (id TEXT PRIMARY KEY);
      INSERT INTO "Organisation" VALUES ('charity'),('other');
      CREATE TABLE "ComplaintRecord" (id TEXT PRIMARY KEY);
      CREATE TABLE "ComplaintRecoveryPreparation" (id TEXT PRIMARY KEY, "organisationId" TEXT,
        "authorizationId" TEXT, "actorUserId" TEXT, facts TEXT);
      INSERT INTO "ComplaintRecoveryPreparation" VALUES ('prep','charity','auth','owner','{"complaint":{"id":"complaint"}}');
      CREATE TABLE "ComplaintPurgeClaim" (id TEXT PRIMARY KEY, "organisationId" TEXT,
        "authorizationId" TEXT, "actorUserId" TEXT, "complaintId" TEXT,
        "transactionId" BIGINT DEFAULT txid_current());
    `);
    psql(container, readFileSync(new URL('../../prisma/migrations/20260930233000_complaint_recovery_outcome/migration.sql', import.meta.url), 'utf8'));
    const claim = (name: string, org = 'charity', auth = 'auth', actor = 'owner', complaint = 'complaint') =>
      `INSERT INTO "ComplaintPurgeClaim" (id,"organisationId","authorizationId","actorUserId","complaintId") VALUES ('${name}','${org}','${auth}','${actor}','${complaint}');`;
    const outcome = (name: string) => `INSERT INTO "ComplaintRecoveryOutcome" (id,"preparationId","claimId","transactionId","recordedAt") VALUES ('outcome','prep','${name}',1,'2000-01-01');`;
    const mismatches: Array<[string, string, string, string, string]> = [
      ['foreign','other','auth','owner','complaint'], ['wrong-authority','charity','other','owner','complaint'],
      ['wrong-actor','charity','auth','other','complaint'], ['wrong-record','charity','auth','owner','other']];
    for (const args of mismatches) {
      const failed = psql(container, `BEGIN; ${claim(...args)} ${outcome(args[0])} COMMIT;`, false);
      assert.match(failed.stderr, /matching primary claim/);
    }
    psql(container, claim('old'));
    assert.match(psql(container, outcome('old'), false).stderr, /same transaction/);
    assert.match(psql(container, `BEGIN; INSERT INTO "ComplaintRecord" VALUES ('complaint'); ${claim('still-present')} ${outcome('still-present')} COMMIT;`, false).stderr, /matching primary claim/);
    psql(container, `BEGIN; ${claim('rollback')} ${outcome('rollback')} ROLLBACK;`);
    assert.equal(psql(container, 'SELECT count(*) FROM "ComplaintRecoveryOutcome";').stdout.trim(), '0');
    psql(container, `BEGIN; ${claim('committed')} ${outcome('committed')} COMMIT;`);
    assert.equal(psql(container, `SELECT (o."transactionId"=c."transactionId" AND o."transactionId"<>1 AND o."recordedAt">'2000-01-01')::text FROM "ComplaintRecoveryOutcome" o JOIN "ComplaintPurgeClaim" c ON c.id=o."claimId";`).stdout.trim(), 'true');
    for (const mutation of ['UPDATE "ComplaintRecoveryOutcome" SET id=\'changed\';', 'DELETE FROM "ComplaintRecoveryOutcome";']) {
      assert.match(psql(container, mutation, false).stderr, /append-only/);
    }
  } finally { await removeDisposableContainer(container); }
});

test('real PostgreSQL 16 migration freezes ordinary complaint removal and restoration after enforcement', { timeout: 120_000 }, async () => {
  const container = `charitypilot-removal-gate-${randomUUID()}`;
  assertDockerSuccess(docker(['run', '--detach', '--name', container, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'start removal gate fixture');
  try {
    await waitForPostgres(container);
    psql(container, `
      CREATE TABLE "Organisation" (id TEXT PRIMARY KEY);
      INSERT INTO "Organisation" VALUES ('charity'), ('other');
      CREATE TABLE "ComplaintRecoveryEnforcement" (id TEXT PRIMARY KEY, "organisationId" TEXT UNIQUE);
      CREATE TABLE "ComplaintRemoval" (id TEXT PRIMARY KEY, "organisationId" TEXT);
      CREATE TABLE "ComplaintRecord" (id TEXT PRIMARY KEY, "organisationId" TEXT,
        "removedAt" TIMESTAMP(3), "removalId" TEXT, summary TEXT);
      INSERT INTO "ComplaintRecord" VALUES
        ('active','charity',NULL,NULL,'untouched'),
        ('removed','charity','2026-09-30','earlier','untouched'),
        ('other-active','other',NULL,NULL,'untouched');
    `);
    psql(container, readFileSync(new URL('../../prisma/migrations/20261007000000_complaint_removal_recovery_gate/migration.sql', import.meta.url), 'utf8'));
    psql(container, `INSERT INTO "ComplaintRemoval" VALUES ('before','charity');
      UPDATE "ComplaintRecord" SET "removedAt"='2026-10-01', "removalId"='before' WHERE id='active';
      UPDATE "ComplaintRecord" SET "removedAt"=NULL, "removalId"=NULL WHERE id='active';`);
    psql(container, `INSERT INTO "ComplaintRecoveryEnforcement" VALUES ('binding','charity');`);
    assert.match(psql(container, `INSERT INTO "ComplaintRemoval" VALUES ('after','charity');`, false).stderr,
      /requires independent recovery authority/);
    assert.match(psql(container, `UPDATE "ComplaintRecord" SET "removedAt"='2026-10-01', "removalId"='before' WHERE id='active';`, false).stderr,
      /requires independent recovery authority/);
    assert.match(psql(container, `UPDATE "ComplaintRecord" SET "removedAt"=NULL, "removalId"=NULL WHERE id='removed';`, false).stderr,
      /requires independent recovery authority/);
    psql(container, `UPDATE "ComplaintRecord" SET summary='still readable' WHERE id='active';
      INSERT INTO "ComplaintRemoval" VALUES ('other-removal','other');
      UPDATE "ComplaintRecord" SET "removedAt"='2026-10-01', "removalId"='other-removal' WHERE id='other-active';`);
    assert.equal(psql(container, `SELECT count(*) FROM "ComplaintRemoval" WHERE "organisationId"='charity';`).stdout.trim(), '1');
  } finally { await removeDisposableContainer(container); }
});

test('real PostgreSQL 16 migration freezes only complaint policy facts after recovery enforcement', { timeout: 120_000 }, async () => {
  const container = `charitypilot-policy-gate-${randomUUID()}`;
  assertDockerSuccess(docker(['run', '--detach', '--name', container, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'start policy gate fixture');
  try {
    await waitForPostgres(container);
    psql(container, `
      CREATE TABLE "Organisation" (id TEXT PRIMARY KEY);
      INSERT INTO "Organisation" VALUES ('charity'), ('other');
      CREATE TABLE "ComplaintRecoveryEnforcement" (id TEXT PRIMARY KEY, "organisationId" TEXT UNIQUE);
      CREATE TABLE "DataRetentionPolicyRevision" (id TEXT PRIMARY KEY, "organisationId" TEXT, "recordClass" TEXT);
      CREATE TABLE "DataRetentionPolicyWithdrawal" (id TEXT PRIMARY KEY, "organisationId" TEXT, "policyId" TEXT);
    `);
    psql(container, readFileSync(new URL('../../prisma/migrations/20261007010000_complaint_policy_recovery_gate/migration.sql', import.meta.url), 'utf8'));
    psql(container, `INSERT INTO "DataRetentionPolicyRevision" VALUES
      ('old-complaint','charity','COMPLAINT'), ('new-vault','charity','VAULT_DRAFT');
      INSERT INTO "DataRetentionPolicyWithdrawal" VALUES ('old-withdrawal','charity','old-complaint');
      INSERT INTO "ComplaintRecoveryEnforcement" VALUES ('binding','charity');`);
    assert.match(psql(container, `INSERT INTO "DataRetentionPolicyRevision" VALUES ('blocked','charity','COMPLAINT');`, false).stderr,
      /revision requires independent recovery authority/);
    assert.match(psql(container, `INSERT INTO "DataRetentionPolicyWithdrawal" VALUES ('blocked','charity','old-complaint');`, false).stderr,
      /withdrawal requires independent recovery authority/);
    psql(container, `INSERT INTO "DataRetentionPolicyRevision" VALUES
      ('later-vault','charity','VAULT_DRAFT'), ('other-complaint','other','COMPLAINT');
      INSERT INTO "DataRetentionPolicyWithdrawal" VALUES
      ('vault-withdrawal','charity','new-vault'), ('other-withdrawal','other','other-complaint');`);
    assert.equal(psql(container, `SELECT count(*) FROM "DataRetentionPolicyRevision" WHERE "organisationId"='charity';`).stdout.trim(), '3');
    assert.equal(psql(container, `SELECT count(*) FROM "DataRetentionPolicyWithdrawal" WHERE "organisationId"='charity';`).stdout.trim(), '2');
  } finally { await removeDisposableContainer(container); }
});

test('disposable E2E reset inventory includes recovery evidence exactly once', () => {
  assert.equal(
    DISPOSABLE_DATABASE_RESET_TABLES.filter(
      (table) => table === 'DocumentStorageDeletionRecovery',
    ).length,
    1,
  );
});

test('real PostgreSQL 16 migration preserves an unresolved Confluence write reservation', { timeout: 120_000 }, async () => {
  const container = `charitypilot-publication-reservation-${randomUUID()}`;
  assertDockerSuccess(docker(['run', '--detach', '--name', container, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'start publication reservation fixture');
  try {
    await waitForPostgres(container);
    psql(container, `
      CREATE TYPE publication_state AS ENUM ('PENDING','PROCESSED','DEAD_LETTER','RETIRED');
      CREATE TABLE "DocumentPublication" (
        id TEXT PRIMARY KEY, state publication_state NOT NULL,
        "claimedAt" TIMESTAMP(3), "processedAt" TIMESTAMP(3),
        "terminalReason" TEXT, "pageId" TEXT, "attachmentId" TEXT
      );
    `);
    psql(container, readFileSync(new URL(
      '../../prisma/migrations/20261007120000_document_publication_remote_write_reservation/migration.sql',
      import.meta.url,
    ), 'utf8'));
    assert.match(psql(container, `INSERT INTO "DocumentPublication" (id,state,"claimedAt","remoteWriteStartedAt")
      VALUES ('forged','PENDING',now(),now());`, false).stderr, /requires a claimed publication/);
    psql(container, `INSERT INTO "DocumentPublication" (id,state,"claimedAt") VALUES ('unreserved','PENDING',now());`);
    assert.match(psql(container, `UPDATE "DocumentPublication" SET state='PROCESSED' WHERE id='unreserved';`, false).stderr,
      /cannot complete without a committed remote write reservation/);
    psql(container, `INSERT INTO "DocumentPublication" (id,state,"claimedAt") VALUES ('uncertain','PENDING',now());
      UPDATE "DocumentPublication" SET "remoteWriteStartedAt"=now() WHERE id='uncertain';`);
    assert.match(psql(container, `UPDATE "DocumentPublication" SET "remoteWriteStartedAt"=NULL WHERE id='uncertain';`, false).stderr,
      /cannot be cleared or changed/);
    assert.match(psql(container, `DELETE FROM "DocumentPublication" WHERE id='uncertain';`, false).stderr,
      /reservation evidence cannot be deleted/);
    psql(container, `UPDATE "DocumentPublication" SET state='DEAD_LETTER',
      "terminalReason"='REMOTE_WRITE_OUTCOME_UNKNOWN', "claimedAt"=NULL WHERE id='uncertain';`);
    assert.match(psql(container, `UPDATE "DocumentPublication" SET "remoteWriteStartedAt"=NULL WHERE id='uncertain';`, false).stderr,
      /cannot be cleared or changed/);
    psql(container, `INSERT INTO "DocumentPublication" (id,state,"claimedAt") VALUES ('complete','PENDING',now());
      UPDATE "DocumentPublication" SET "remoteWriteStartedAt"=now() WHERE id='complete';
      UPDATE "DocumentPublication" SET state='PROCESSED', "pageId"='page',
        "attachmentId"='attachment', "processedAt"=now(), "claimedAt"=NULL WHERE id='complete';
      UPDATE "DocumentPublication" SET state='PENDING', "remoteWriteStartedAt"=NULL,
        "processedAt"=NULL WHERE id='complete';`);
    assert.equal(psql(container, `SELECT state || '|' || ("remoteWriteStartedAt" IS NULL)::text
      FROM "DocumentPublication" WHERE id='complete';`).stdout.trim(), 'PENDING|true');
  } finally { await removeDisposableContainer(container); }
});

test('real PostgreSQL 16 migration preserves exact Confluence upload intent evidence', { timeout: 120_000 }, async () => {
  const container = `charitypilot-upload-intent-${randomUUID()}`;
  assertDockerSuccess(docker(['run', '--detach', '--name', container, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'start upload intent fixture');
  try {
    await waitForPostgres(container);
    psql(container, `CREATE TABLE "DocumentPublication" (
      id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "documentId" TEXT NOT NULL,
      state TEXT NOT NULL, "processedAt" TIMESTAMP(3), "terminalReason" TEXT,
      "claimedAt" TIMESTAMP(3), "remoteWriteStartedAt" TIMESTAMP(3),
      "cloudId" TEXT, "spaceId" TEXT, "pageId" TEXT
    );
    INSERT INTO "DocumentPublication" (id, "organisationId", "documentId", state,
      "claimedAt", "remoteWriteStartedAt", "cloudId", "spaceId", "pageId")
    VALUES ('pub-1', 'org-1', 'doc-1', 'PENDING', '2026-10-07T12:00:00Z',
      '2026-10-07T12:00:00Z', 'cloud-1', 'space-1', 'page-1');`);
    psql(container, readFileSync(new URL(
      '../../prisma/migrations/20261007130000_document_publication_upload_intent/migration.sql',
      import.meta.url,
    ), 'utf8'));
    const insert = (id: string, sha256: string, claimedAt = '2026-10-07T12:00:00Z') => `INSERT INTO "DocumentPublicationUploadIntent"
      (id, "publicationId", "organisationId", "documentId", "claimedAt", "cloudId",
       "spaceId", "pageId", filename, sha256)
      VALUES ('${id}', 'pub-1', 'org-1', 'doc-1', '${claimedAt}',
        'cloud-1', 'space-1', 'page-1', 'policy.pdf', '${sha256}');`;
    const validId = '0123456789abcdef0123456789abcdef';
    const validSha = 'a'.repeat(64);
    assert.equal(psql(container, `WITH eligible AS (
      SELECT p.id, p."organisationId", p."documentId", p."claimedAt"
      FROM "DocumentPublication" AS p
      WHERE p.id='pub-1' AND p."organisationId"='org-1' AND p."documentId"='doc-1'
        AND p.state='PENDING' AND p."processedAt" IS NULL
        AND p."terminalReason" IS NULL AND p."claimedAt"='2026-10-07T12:00:00Z'
        AND p."remoteWriteStartedAt" IS NOT NULL AND p."cloudId"='cloud-1'
        AND p."spaceId"='space-1' AND p."pageId"='page-1'
      FOR UPDATE
    )
    INSERT INTO "DocumentPublicationUploadIntent" (id, "publicationId", "organisationId",
      "documentId", "claimedAt", "cloudId", "spaceId", "pageId", filename, sha256)
    SELECT '${validId}', eligible.id, eligible."organisationId", eligible."documentId",
      eligible."claimedAt", 'cloud-1', 'space-1', 'page-1', 'policy.pdf', '${validSha}'
    FROM eligible RETURNING id;`).stdout.trim(), validId);
    assert.equal(psql(container, `SELECT "cloudId" || '|' || "pageId" || '|' || sha256
      FROM "DocumentPublicationUploadIntent" WHERE id='${validId}';`).stdout.trim(),
    `cloud-1|page-1|${validSha}`);
    assert.match(psql(container, insert(validId, validSha), false).stderr, /duplicate key/);
    assert.match(psql(container, insert('c'.repeat(32), validSha), false).stderr, /duplicate key/);
    assert.match(psql(container, insert('b'.repeat(32), 'wrong'), false).stderr,
      /DocumentPublicationUploadIntent_identity_check/);
    psql(container, `UPDATE "DocumentPublication" SET "pageId"='page-2',
      "claimedAt"='2026-10-07T12:01:00Z' WHERE id='pub-1';`);
    assert.match(psql(container, insert('b'.repeat(32), validSha, '2026-10-07T12:01:00Z'), false).stderr,
      /requires the current claimed publication and exact target/);
    assert.match(psql(container, `UPDATE "DocumentPublicationUploadIntent" SET "pageId"='other'
      WHERE id='${validId}';`, false).stderr, /immutable/);
    assert.match(psql(container, `DELETE FROM "DocumentPublicationUploadIntent"
      WHERE id='${validId}';`, false).stderr, /immutable/);
  } finally { await removeDisposableContainer(container); }
});
