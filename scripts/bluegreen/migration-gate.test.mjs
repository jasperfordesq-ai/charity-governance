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
// String-literal-aware stripping (minor 7, reviewer-verified P5/P9 classes)
// ---------------------------------------------------------------------------

test('a "--" inside a string literal does not start a comment that swallows a real DROP TABLE after it', () => {
  // P9: naive `--`-strips-to-end-of-line would treat everything after the
  // literal's "--" as commented out, hiding the real DROP TABLE statement
  // that follows on the same line.
  const sql = 'INSERT INTO "log" ("msg") VALUES (\'note -- see ticket\'); DROP TABLE "Foo";';
  const { blocked } = lintMigrationSql('m1', sql);
  assert.ok(blockIds(blocked).includes('drop-table'), 'the real DROP TABLE after the literal must still block');
});

test('the literal text "DROP TABLE" inside a string does not block (behaviour change: it used to)', () => {
  // P5: before string literals were masked, this literal's contents were
  // live text to the regexes, so `lintMigrationSql` would previously have
  // reported a drop-table block here. Masking string-literal contents fixes
  // that false positive — this test pins the NEW (correct) behaviour.
  const sql = 'INSERT INTO "log" ("msg") VALUES (\'remember to DROP TABLE the old snapshot script tonight\');';
  const { blocked } = lintMigrationSql('m1', sql);
  assert.equal(blockIds(blocked).includes('drop-table'), false);
});

test('an escaped quote inside a string literal does not end the literal early', () => {
  // If '' (escaped quote) were mistaken for the closing quote, the rest of
  // the literal — including its "DROP TABLE" text — would spill out as live
  // SQL and wrongly block.
  const sql = `INSERT INTO "log" ("msg") VALUES ('it''s time to DROP TABLE the archive');`;
  const { blocked } = lintMigrationSql('m1', sql);
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

test('alter-column-type blocks the Prisma spelling ALTER COLUMN ... SET DATA TYPE', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ALTER COLUMN "bar" SET DATA TYPE TEXT;',
  );
  assert.ok(blockIds(blocked).includes('alter-column-type'));
});

// --- R1-R4: multi-statement near-misses (reviewer-verified false-block class) ---
// Every one of these pairs an unrelated ALTER TABLE ... ALTER COLUMN in one
// statement with an allowed-vocabulary statement afterwards. Before the R1
// fix (bounding every bridging gap to `[^;]`), the second statement's TYPE
// token — from CREATE TYPE, ALTER TYPE, or a column literally named "type"
// — could bridge back into the first statement's ALTER COLUMN and produce a
// false alter-column-type block. These must all pass completely clean.

test('R1: ALTER COLUMN ... SET DEFAULT followed by an unrelated CREATE TYPE ... AS ENUM passes clean', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ALTER COLUMN "bar" SET DEFAULT 5;\n' +
      'CREATE TYPE "FooKind" AS ENUM (\'A\', \'B\');',
  );
  assert.equal(blockIds(blocked).includes('alter-column-type'), false);
});

test('R2: ALTER COLUMN ... SET DEFAULT followed by an unrelated ALTER TYPE ... ADD VALUE passes clean', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ALTER COLUMN "bar" SET DEFAULT 5;\n' +
      'ALTER TYPE "FooKind" ADD VALUE IF NOT EXISTS \'C\';',
  );
  assert.equal(blockIds(blocked).includes('alter-column-type'), false);
});

test('R3: ALTER COLUMN ... SET DEFAULT followed by an unrelated ADD COLUMN "type" passes clean', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ALTER COLUMN "bar" SET DEFAULT 5;\n' +
      'ALTER TABLE "Baz" ADD COLUMN "type" TEXT;',
  );
  assert.equal(blockIds(blocked).includes('alter-column-type'), false);
});

test('R4: two unrelated ALTER TABLE statements, only the second touching ALTER COLUMN ... TYPE, blocks only via that statement', () => {
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD COLUMN "type" TEXT;\n' +
      'ALTER TABLE "Bar" ALTER COLUMN "baz" TYPE TEXT;',
  );
  // This one SHOULD block (the second statement is a genuine type change) —
  // proves the fix narrows the match to the real statement rather than
  // disabling the rule outright.
  assert.ok(blockIds(blocked).includes('alter-column-type'));
});

// --- R5: multi-clause ALTER TABLE with the destructive clause past the old
// unbounded window's reach (reviewer-verified false-ALLOW class) ---

test('R5: drop-column still blocks when DROP COLUMN sits after 8 ADD COLUMN clauses in one ALTER TABLE', () => {
  const sql =
    'ALTER TABLE "Foo"\n' +
    '    ADD COLUMN "c1" TEXT,\n' +
    '    ADD COLUMN "c2" TEXT,\n' +
    '    ADD COLUMN "c3" TEXT,\n' +
    '    ADD COLUMN "c4" TEXT,\n' +
    '    ADD COLUMN "c5" TEXT,\n' +
    '    ADD COLUMN "c6" TEXT,\n' +
    '    ADD COLUMN "c7" TEXT,\n' +
    '    ADD COLUMN "c8" TEXT,\n' +
    '    DROP COLUMN "legacy";';
  const { blocked } = lintMigrationSql('m1', sql);
  assert.ok(blockIds(blocked).includes('drop-column'));
});

test('R5: set-not-null still blocks when SET NOT NULL sits after 8 ADD COLUMN clauses in one ALTER TABLE', () => {
  const sql =
    'ALTER TABLE "Foo"\n' +
    '    ADD COLUMN "c1" TEXT,\n' +
    '    ADD COLUMN "c2" TEXT,\n' +
    '    ADD COLUMN "c3" TEXT,\n' +
    '    ADD COLUMN "c4" TEXT,\n' +
    '    ADD COLUMN "c5" TEXT,\n' +
    '    ADD COLUMN "c6" TEXT,\n' +
    '    ADD COLUMN "c7" TEXT,\n' +
    '    ADD COLUMN "c8" TEXT,\n' +
    '    ALTER COLUMN "legacy" SET NOT NULL;';
  const { blocked } = lintMigrationSql('m1', sql);
  assert.ok(blockIds(blocked).includes('set-not-null'));
});

test('drop-column does not bridge into a later unrelated statement past its own semicolon', () => {
  // A safe ALTER TABLE followed by an unrelated DROP COLUMN in a *different*
  // table's statement must block via that second statement, not make the
  // first ALTER TABLE look like the source of the match — proving the gap
  // is truly statement-bounded, not just "narrower".
  const { blocked } = lintMigrationSql(
    'm1',
    'ALTER TABLE "Foo" ADD COLUMN "bar" TEXT;\nALTER TABLE "Baz" DROP COLUMN "qux";',
  );
  assert.ok(blockIds(blocked).includes('drop-column'));
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
// drop-index-non-concurrent (WARN, not BLOCK) — symmetric with
// create-index-non-concurrent
// ---------------------------------------------------------------------------

test('drop-index-non-concurrent warns on plain DROP INDEX, and does not block', () => {
  const { blocked, warned } = lintMigrationSql('m1', 'DROP INDEX "Foo_bar_idx";');
  assert.ok(blockIds(warned).includes('drop-index-non-concurrent'));
  assert.deepEqual(blocked, []);
});

test('DROP INDEX CONCURRENTLY passes with no warning', () => {
  const { blocked, warned } = lintMigrationSql('m1', 'DROP INDEX CONCURRENTLY "Foo_bar_idx";');
  assert.deepEqual(blocked, []);
  assert.equal(blockIds(warned).includes('drop-index-non-concurrent'), false);
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

test('gateMigrations: a pending entry with undefined sql becomes an unreadable-migration BLOCK, never clean', () => {
  const result = gateMigrations([{ name: 'm1', sql: undefined }]);
  assert.equal(result.ok, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, 'unreadable-migration');
  assert.equal(result.blocked[0].migration, 'm1');
});

test('gateMigrations: a pending entry with null sql also becomes an unreadable-migration BLOCK', () => {
  const result = gateMigrations([{ name: 'm1', sql: null }]);
  assert.equal(result.ok, false);
  assert.equal(result.blocked[0].id, 'unreadable-migration');
});

test('gateMigrations: unreadable-migration can still be overridden like any other block', () => {
  const result = gateMigrations([{ name: 'm1', sql: undefined }], { allowDestructive: true });
  assert.equal(result.ok, true);
  assert.equal(result.overridden.length, 1);
  assert.equal(result.overridden[0].id, 'unreadable-migration');
});

// ---------------------------------------------------------------------------
// pendingMigrations
// ---------------------------------------------------------------------------

// NOTE (interface change, R1 fix round): pendingMigrations now returns
// `{ pending, unknownApplied }` instead of a bare array. See task-6-report.md
// for the full rationale — the orchestrator (Task 8) consumes this shape.

test('pendingMigrations returns dir names minus applied, sorted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20260101000000_third'));
    mkdirSync(join(dir, '20260101000000_third', 'sub')); // nested dir should not appear
    mkdirSync(join(dir, '20250101000000_first'));
    mkdirSync(join(dir, '20250601000000_second'));
    writeFileSync(join(dir, 'migration_lock.toml'), ''); // non-directory entry, ignored

    const applied = ['20250101000000_first'];
    const { pending, unknownApplied } = pendingMigrations(dir, applied);

    assert.deepEqual(pending, ['20250601000000_second', '20260101000000_third']);
    assert.deepEqual(unknownApplied, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingMigrations returns everything when nothing is applied yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20260101000000_b'));
    mkdirSync(join(dir, '20250101000000_a'));

    const { pending, unknownApplied } = pendingMigrations(dir, []);

    assert.deepEqual(pending, ['20250101000000_a', '20260101000000_b']);
    assert.deepEqual(unknownApplied, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingMigrations returns empty pending when everything is applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20260101000000_a'));

    const { pending, unknownApplied } = pendingMigrations(dir, ['20260101000000_a']);

    assert.deepEqual(pending, []);
    assert.deepEqual(unknownApplied, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingMigrations surfaces applied names with no matching directory as unknownApplied, not pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20250101000000_a'));

    // The live db reports a migration applied that this checkout doesn't
    // have on disk at all (e.g. a rollback deploy serving an older release
    // than what most recently ran against the db). It must never appear in
    // pending (there's no migration.sql to even read), but it must also not
    // be silently dropped on the floor.
    const applied = ['20250101000000_a', '20260601000000_future_migration'];
    const { pending, unknownApplied } = pendingMigrations(dir, applied);

    assert.deepEqual(pending, []);
    assert.deepEqual(unknownApplied, ['20260601000000_future_migration']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingMigrations sorts unknownApplied too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    mkdirSync(join(dir, '20250101000000_a'));

    const applied = ['20250101000000_a', '20270101000000_z', '20260101000000_m'];
    const { unknownApplied } = pendingMigrations(dir, applied);

    assert.deepEqual(unknownApplied, ['20260101000000_m', '20270101000000_z']);
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
  // Deliberately NOT try/catch-ENOENT-and-return here: if this migration is
  // ever renamed or removed, this test must fail loudly, not go quiet. A
  // swallowed ENOENT is a fixture that silently stops testing anything.
  const migrationPath = join(
    repoRoot,
    'apps',
    'api',
    'prisma',
    'migrations',
    '20260831000000_add_owner_provisioned_recovery_source',
    'migration.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  const result = gateMigrations([
    { name: '20260831000000_add_owner_provisioned_recovery_source', sql },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.warned, [], 'a pure ALTER TYPE ... ADD VALUE migration should not even warn');
});

test('the real add_deadline_calendar_lifecycle migration blocks with rename-column, alter-column-type, and set-not-null', () => {
  // The blocking-side real fixture: a migration with genuine destructive
  // clauses (RENAME COLUMN, ALTER COLUMN ... TYPE, and multiple
  // ALTER COLUMN ... SET NOT NULL, each many clauses into a large
  // multi-statement file) must still be caught by the R1-fixed,
  // statement-bounded regexes — not just stay quiet on safe files.
  const migrationPath = join(
    repoRoot,
    'apps',
    'api',
    'prisma',
    'migrations',
    '20260710190000_add_deadline_calendar_lifecycle',
    'migration.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  const result = gateMigrations([
    { name: '20260710190000_add_deadline_calendar_lifecycle', sql },
  ]);

  assert.equal(result.ok, false);
  const ids = new Set(result.blocked.map((f) => f.id));
  assert.ok(ids.has('rename-column'), 'expected rename-column to be blocked');
  assert.ok(ids.has('alter-column-type'), 'expected alter-column-type to be blocked');
  assert.ok(ids.has('set-not-null'), 'expected set-not-null to be blocked');
});

test('the real add_password_recovery_integrity migration passes with no truncate block (pinned forever)', () => {
  // This migration's only "TRUNCATE" is a trigger event specifier —
  // `BEFORE TRUNCATE ON "AuthRecoveryRetiredSecret"` — guarding AGAINST
  // truncation, not performing one. Before the R1 fix, the unanchored
  // \bTRUNCATE\b rule blocked this file; it must never regress.
  const migrationPath = join(
    repoRoot,
    'apps',
    'api',
    'prisma',
    'migrations',
    '20260712013000_add_password_recovery_integrity',
    'migration.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');
  assert.match(sql, /BEFORE\s+TRUNCATE\s+ON/i, 'fixture assumption: the trigger event specifier is present');

  const result = gateMigrations([
    { name: '20260712013000_add_password_recovery_integrity', sql },
  ]);

  assert.equal(result.ok, true);
  const ids = result.blocked.map((f) => f.id);
  assert.equal(ids.includes('truncate'), false, 'a BEFORE TRUNCATE ON trigger guard must never trip the truncate rule');
});
