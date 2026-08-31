import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { pendingMigrations, lintMigrationSql, gateMigrations } from './migration-gate.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function blockIds(findings) {
  return findings.map((f) => f.id);
}

// ---------------------------------------------------------------------------
// drop-table
// ---------------------------------------------------------------------------

test('drop-table blocks a real DROP TABLE statement', () => {
  const { blocked } = lintMigrationSql('m1', 'DROP TABLE "Foo";');
  assert.ok(blockIds(blocked).includes('drop-table'));
});

test('drop-table does not block a commented-out DROP TABLE (line comment)', () => {
  const { blocked } = lintMigrationSql('m1', '-- DROP TABLE "Foo";\nSELECT 1;');
  assert.equal(blockIds(blocked).includes('drop-table'), false);
});

test('drop-table does not block a commented-out DROP TABLE (block comment)', () => {
  const { blocked } = lintMigrationSql('m1', '/* DROP TABLE "Foo"; */\nSELECT 1;');
  assert.equal(blockIds(blocked).includes('drop-table'), false);
});

// ---------------------------------------------------------------------------
// drop-column
// ---------------------------------------------------------------------------

test('drop-column blocks ALTER TABLE ... DROP COLUMN', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" DROP COLUMN "bar";');
  assert.ok(blockIds(blocked).includes('drop-column'));
});

test('drop-column does not block ALTER TABLE ... ADD COLUMN', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" ADD COLUMN "bar" TEXT;');
  assert.equal(blockIds(blocked).includes('drop-column'), false);
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

test('truncate blocks a real TRUNCATE statement', () => {
  const { blocked } = lintMigrationSql('m1', 'TRUNCATE "Foo";');
  assert.ok(blockIds(blocked).includes('truncate'));
});

test('truncate does not block a column name that merely contains the word', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'CREATE TABLE "Foo" ("truncateLog" TEXT NOT NULL);',
  );
  assert.equal(blockIds(blocked).includes('truncate'), false);
});

// ---------------------------------------------------------------------------
// rename-table
// ---------------------------------------------------------------------------

test('rename-table blocks ALTER TABLE ... RENAME TO', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" RENAME TO "Bar";');
  assert.ok(blockIds(blocked).includes('rename-table'));
});

test('rename-table does not block an unrelated ALTER TABLE', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" ADD COLUMN "bar" TEXT;');
  assert.equal(blockIds(blocked).includes('rename-table'), false);
});

// ---------------------------------------------------------------------------
// rename-column
// ---------------------------------------------------------------------------

test('rename-column blocks ALTER TABLE ... RENAME COLUMN', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" RENAME COLUMN "bar" TO "baz";');
  assert.ok(blockIds(blocked).includes('rename-column'));
});

test('rename-column does not block ALTER TABLE ... ADD COLUMN', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" ADD COLUMN "bar" TEXT;');
  assert.equal(blockIds(blocked).includes('rename-column'), false);
});

// ---------------------------------------------------------------------------
// alter-column-type
// ---------------------------------------------------------------------------

test('alter-column-type blocks ALTER TABLE ... ALTER COLUMN ... TYPE', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" ALTER COLUMN "bar" TYPE TEXT;');
  assert.ok(blockIds(blocked).includes('alter-column-type'));
});

test('alter-column-type does not block ALTER COLUMN ... SET DEFAULT (no TYPE change)', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ALTER COLUMN "bar" SET DEFAULT \'x\';',
  );
  assert.equal(blockIds(blocked).includes('alter-column-type'), false);
});

// ---------------------------------------------------------------------------
// set-not-null
// ---------------------------------------------------------------------------

test('set-not-null blocks ALTER TABLE ... ALTER COLUMN ... SET NOT NULL', () => {
  const { blocked } = lintMigrationSql('m1', 'ALTER TABLE "Foo" ALTER COLUMN "bar" SET NOT NULL;');
  assert.ok(blockIds(blocked).includes('set-not-null'));
});

test('set-not-null does not block ALTER COLUMN ... DROP NOT NULL (SET NOT NULL absent)', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ALTER COLUMN "bar" DROP NOT NULL;',
  );
  assert.equal(blockIds(blocked).includes('set-not-null'), false);
});

// ---------------------------------------------------------------------------
// create-index-non-concurrent (WARN, not BLOCK)
// ---------------------------------------------------------------------------

test('create-index-non-concurrent warns on plain CREATE INDEX, and does not block', () => {
  const { blocked, warned } = lintMigrationSql(
    'm1',
    'CREATE INDEX "Foo_bar_idx" ON "Foo"("bar");',
  );
  assert.ok(blockIds(warned).includes('create-index-non-concurrent'));
  assert.deepEqual(blocked, []);
});

test('create-index-non-concurrent warns on plain CREATE UNIQUE INDEX too', () => {
  const { warned } = lintMigrationSql('m1', 'CREATE UNIQUE INDEX "Foo_bar_key" ON "Foo"("bar");');
  assert.ok(blockIds(warned).includes('create-index-non-concurrent'));
});

test('CREATE INDEX CONCURRENTLY passes with no warning', () => {
  const { blocked, warned } = lintMigrationSql(
    'm1',
    'CREATE INDEX CONCURRENTLY "Foo_bar_idx" ON "Foo"("bar");',
  );
  assert.deepEqual(blocked, []);
  assert.equal(blockIds(warned).includes('create-index-non-concurrent'), false);
});

// ---------------------------------------------------------------------------
// validating-constraint (WARN, not BLOCK) — implementer-authored rule
// ---------------------------------------------------------------------------

test('validating-constraint warns on a bare ADD CONSTRAINT ... CHECK', () => {
  const { blocked, warned } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD CONSTRAINT "Foo_bar_check" CHECK ("bar" > 0);',
  );
  assert.ok(blockIds(warned).includes('validating-constraint'));
  assert.deepEqual(blocked, []);
});

test('validating-constraint does not warn when CHECK carries NOT VALID', () => {
  const { warned } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD CONSTRAINT "Foo_bar_check" CHECK ("bar" > 0) NOT VALID;',
  );
  assert.equal(blockIds(warned).includes('validating-constraint'), false);
});

test('validating-constraint warns on a bare ADD CONSTRAINT ... FOREIGN KEY', () => {
  const { warned } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD CONSTRAINT "Foo_bar_fkey" FOREIGN KEY ("barId") REFERENCES "Bar"("id");',
  );
  assert.ok(blockIds(warned).includes('validating-constraint'));
});

test('validating-constraint does not warn when FOREIGN KEY carries NOT VALID', () => {
  const { warned } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD CONSTRAINT "Foo_bar_fkey" FOREIGN KEY ("barId") REFERENCES "Bar"("id") NOT VALID;',
  );
  assert.equal(blockIds(warned).includes('validating-constraint'), false);
});

test('validating-constraint does not misfire on a plain ADD COLUMN line', () => {
  const { blocked, warned } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD COLUMN "bar" TEXT NOT NULL DEFAULT \'x\';',
  );
  assert.deepEqual(blocked, []);
  assert.equal(blockIds(warned).includes('validating-constraint'), false);
});

// ---------------------------------------------------------------------------
// Allowed vocabulary passes clean (no blocked, no warned)
// ---------------------------------------------------------------------------

test('ADD COLUMN ... DEFAULT passes clean', () => {
  const { blocked, warned } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD COLUMN "bar" TEXT NOT NULL DEFAULT \'x\';',
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(warned, []);
});

test('CREATE TYPE ... AS ENUM passes clean', () => {
  const { blocked, warned } = lintMigrationSql(
    'm1',
    'CREATE TYPE "FooStatus" AS ENUM (\'ACTIVE\', \'SUSPENDED\');',
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(warned, []);
});

test('ALTER TYPE ... ADD VALUE passes clean', () => {
  const { blocked, warned } = lintMigrationSql(
    'm1',
    'ALTER TYPE "FooStatus" ADD VALUE IF NOT EXISTS \'ARCHIVED\';',
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(warned, []);
});

// ---------------------------------------------------------------------------
// gateMigrations
// ---------------------------------------------------------------------------

test('gateMigrations: ok is true when nothing is blocked', () => {
  const result = gateMigrations([{ name: 'm1', sql: 'ALTER TABLE "Foo" ADD COLUMN "bar" TEXT;' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.overridden, []);
});

test('gateMigrations: ok is false when something is blocked and allowDestructive is not set', () => {
  const result = gateMigrations([{ name: 'm1', sql: 'DROP TABLE "Foo";' }]);
  assert.equal(result.ok, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, 'drop-table');
  assert.deepEqual(result.overridden, []);
});

test('gateMigrations: allowDestructive flips ok true while preserving the blocked list in overridden', () => {
  const result = gateMigrations(
    [{ name: 'm1', sql: 'DROP TABLE "Foo";' }],
    { allowDestructive: true },
  );
  assert.equal(result.ok, true);
  assert.equal(result.blocked.length, 1, 'blocked list itself is preserved, not cleared');
  assert.equal(result.blocked[0].id, 'drop-table');
  assert.deepEqual(result.overridden, result.blocked);
});

test('gateMigrations: warnings alone never flip ok to false', () => {
  const result = gateMigrations([
    { name: 'm1', sql: 'CREATE INDEX "Foo_bar_idx" ON "Foo"("bar");' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.warned.length, 1);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.overridden, []);
});

test('gateMigrations: aggregates findings across multiple pending migrations', () => {
  const result = gateMigrations([
    { name: 'm1', sql: 'CREATE INDEX "Foo_bar_idx" ON "Foo"("bar");' },
    { name: 'm2', sql: 'DROP TABLE "Bar";' },
    { name: 'm3', sql: 'ALTER TABLE "Baz" ADD COLUMN "qux" TEXT;' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].migration, 'm2');
  assert.equal(result.warned.length, 1);
  assert.equal(result.warned[0].migration, 'm1');
});

// ---------------------------------------------------------------------------
// pendingMigrations
// ---------------------------------------------------------------------------

test('pendingMigrations returns dir names minus applied, sorted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20260101000000_third'));
    mkdirSync(join(dir, '20260101000000_third', 'sub')); // nested dir should not appear
    mkdirSync(join(dir, '20250101000000_first'));
    mkdirSync(join(dir, '20250601000000_second'));
    writeFileSync(join(dir, 'migration_lock.toml'), ''); // non-directory entry, ignored

    const applied = ['20250101000000_first'];
    const pending = pendingMigrations(dir, applied);

    assert.deepEqual(pending, ['20250601000000_second', '20260101000000_third']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingMigrations returns everything when nothing is applied yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20260101000000_b'));
    mkdirSync(join(dir, '20250101000000_a'));

    const pending = pendingMigrations(dir, []);

    assert.deepEqual(pending, ['20250101000000_a', '20260101000000_b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingMigrations returns empty array when everything is applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20260101000000_a'));

    const pending = pendingMigrations(dir, ['20260101000000_a']);

    assert.deepEqual(pending, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real-fixture tests: read actual repo migrations off disk, never a copy
// typed into the test. This is what keeps the lint vocabulary honest against
// real Prisma output.
// ---------------------------------------------------------------------------

test('the real add_platform_operator migration passes the gate with no blocks', () => {
  const migrationPath = join(
    repoRoot,
    'apps',
    'api',
    'prisma',
    'migrations',
    '20260830201131_add_platform_operator',
    'migration.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  const result = gateMigrations([{ name: '20260830201131_add_platform_operator', sql }]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blocked, []);
});

test('the real add_owner_provisioned_recovery_source migration (ADD VALUE) passes the gate', () => {
  const migrationDir = join(
    repoRoot,
    'apps',
    'api',
    'prisma',
    'migrations',
    '20260831000000_add_owner_provisioned_recovery_source',
  );
  let sql;
  try {
    sql = readFileSync(join(migrationDir, 'migration.sql'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Migration doesn't exist in this checkout; nothing to assert.
      return;
    }
    throw err;
  }

  const result = gateMigrations([
    { name: '20260831000000_add_owner_provisioned_recovery_source', sql },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.warned, [], 'a pure ALTER TYPE ... ADD VALUE migration should not even warn');
});
