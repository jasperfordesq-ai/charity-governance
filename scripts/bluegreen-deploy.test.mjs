import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const deployScriptPath = join(scriptsDir, 'bluegreen-deploy.mjs');
const TARGET_COMMIT = 'a'.repeat(40);
const OLD_COMMIT = 'b'.repeat(40);
const READINESS_KEY = 'r7Nq2Xc9Lm4Pz8Va6Ys3Td5He1Bw0UkF';

async function loadDeployModule() {
  assert.ok(existsSync(deployScriptPath), 'bluegreen deploy script must exist');
  return import(pathToFileURL(deployScriptPath).href);
}

async function loadDeployRunner() {
  const module = await loadDeployModule();
  assert.equal(typeof module.runBluegreenDeployFromArgs, 'function');
  return (args, dependencies = {}) => module.runBluegreenDeployFromArgs(args, dependencies);
}

// -----------------------------------------------------------------------------
// Fixture scaffolding: a scratch state dir + env file + (fake) release
// worktree containing a real migrations directory, so migration-gate.mjs
// (the REAL module, never mocked) actually reads real files off disk.
// Mirrors production-compose-deploy.test.mjs's harness: only `runCommand`
// (docker/git/wget) and the async backup functions are faked; state.json,
// deploy-status.json, and the migrations directory are real files under a
// real temp directory.
// -----------------------------------------------------------------------------

function makeFixtureDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeEnvFile(envPath, overrides = {}) {
  const values = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://charitypilot:scratch-password@db:5432/charitypilot',
    BLUEGREEN_ENV_FILE: envPath,
    BLUEGREEN_ORIGIN: 'http://127.0.0.1:8080',
    BLUEGREEN_FRONT_PORT: '8080',
    READINESS_API_KEY: READINESS_KEY,
    FRONTEND_URL: 'http://127.0.0.1:8080',
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'http://127.0.0.1:8080',
    CHARITYPILOT_CANONICAL_API_ORIGIN: 'http://127.0.0.1:8080',
    ...overrides,
  };
  writeFileSync(
    envPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
  return values;
}

function seedMigrationsDir(stateDir, commit, migrations = []) {
  const migrationsDir = join(stateDir, 'releases', commit, 'apps', 'api', 'prisma', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  for (const { name, sql } of migrations) {
    const dir = join(migrationsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'migration.sql'), sql);
  }
  return migrationsDir;
}

function readinessBody(commit) {
  return JSON.stringify({ status: 'ready', buildCommit: commit });
}

/**
 * A recording fake runCommand covering the full happy-path deploy: git
 * gate commands, docker compose exec/up/build/stop, and the two wget-based
 * smoke checks. `overrides(command, options, calls)` may return a result
 * (or throw) to replace the default behaviour for a specific command,
 * letting each failure-path test inject exactly one failure.
 */
function makeFakeRunCommand({ targetCommit = TARGET_COMMIT, appliedMigrations = [], overrides } = {}) {
  const calls = [];
  const runCommand = async (command, options = {}) => {
    calls.push({ command: [...command], env: options.env, cwd: options.cwd });
    if (overrides) {
      const forced = overrides(command, options, calls);
      if (forced !== undefined) {
        if (forced instanceof Error) throw forced;
        return forced;
      }
    }

    const joined = command.join(' ');
    if (command[0] === 'git' && command[1] === 'status') return { stdout: '' };
    if (command[0] === 'git' && command[1] === 'fetch') return { stdout: '' };
    if (command[0] === 'git' && command[1] === 'rev-parse' && command[2] === 'HEAD') {
      return { stdout: `${targetCommit}\n` };
    }
    if (command[0] === 'git' && joined.includes('origin/master')) {
      return { stdout: `${targetCommit}\n` };
    }
    if (command[0] === 'git' && command[1] === 'worktree') return { stdout: '' };
    // M5: the worktree-reuse check runs `git -C <dir> rev-parse HEAD`; report
    // it as already matching the target commit so tests that pre-seed a
    // release directory (seedMigrationsDir) don't get wiped and recreated.
    if (command[0] === 'git' && command[1] === '-C' && command[3] === 'rev-parse' && command[4] === 'HEAD') {
      return { stdout: `${targetCommit}\n` };
    }
    // C1: the gate probes existence first (TO_REGCLASS) before running the
    // real applied-migrations SELECT — the probe must report the table
    // exists ('t') so the real query below actually runs in tests.
    if (joined.includes('psql') && joined.includes('TO_REGCLASS')) {
      return { stdout: 't' };
    }
    if (joined.includes('psql') && joined.includes('_prisma_migrations')) {
      return { stdout: appliedMigrations.map((name) => `${name}\n`).join('') };
    }
    if (joined.includes('exec') && /api-(blue|green)/.test(joined) && joined.includes('readiness')) {
      return { stdout: readinessBody(targetCommit) };
    }
    if (command[0] === 'wget') {
      return { stdout: readinessBody(targetCommit) };
    }
    return { stdout: '' };
  };
  return { runCommand, calls };
}

function fakeRunBackup(calls) {
  return async (ctx) => {
    calls.push({ type: 'backup', ctx });
    return { plan: { dir: join(ctx.stateDir, 'backups', 'fake') }, manifest: {} };
  };
}

function baseDeps({ stateDir, targetCommit = TARGET_COMMIT, appliedMigrations = [], overrides, now } = {}) {
  const { runCommand, calls } = makeFakeRunCommand({ targetCommit, appliedMigrations, overrides });
  const backupCalls = [];
  return {
    calls,
    backupCalls,
    deps: {
      processEnv: { PATH: process.env.PATH ?? '' },
      runCommand,
      runBackupImpl: fakeRunBackup(backupCalls),
      runRestoreDrillImpl: async () => ({ ok: true, rowCensus: {} }),
      now: now ?? (() => new Date('2026-08-31T12:00:00.000Z')),
      acquireCutoverLock: () => ({ fake: true }),
      releaseCutoverLock: () => {},
      activeUpstreamsPath: join(stateDir, 'active-upstreams.caddy'),
    },
  };
}

test('deploy: phase order is exactly the spec sequence (first deploy, no destructive migrations)', async () => {
  const runDeploy = await loadDeployRunner();
  const { deployStatus } = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-phase-order-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  const status = deployStatus(stateDir);
  const phases = status.history.map((entry) => entry.phase);
  assert.deepEqual(phases, [
    'preflight',
    'backup',
    'resolve',
    'worktree',
    'build',
    'gate',
    'quiesce',
    'migrate',
    'up',
    'candidate-smoke',
    'switch',
    'public-smoke',
    'jobs',
    'retire',
    'record',
  ]);

  rmSync(stateDir, { recursive: true, force: true });
});

test('deploy: a blocked migration aborts BEFORE quiesce and touches nothing', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-blocked-migration-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, [
    { name: '20260101000000_drop_something', sql: 'ALTER TABLE "Foo" DROP COLUMN "bar";' },
  ]);

  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /migration gate blocked/);
  assert.match(outcome.stderr, /drop-column/);

  const status = libModule.deployStatus(stateDir);
  const phases = status.history.map((entry) => entry.phase);
  assert.deepEqual(phases, ['preflight', 'backup', 'resolve', 'worktree', 'build', 'gate']);
  assert.equal(
    calls.some((call) => call.command.includes('stop')),
    false,
    'quiesce (stop) must never run',
  );
  assert.equal(
    calls.some((call) => call.command.includes('run') && call.command.includes('migrate')),
    false,
    'migrate must never run',
  );

  rmSync(stateDir, { recursive: true, force: true });
});

test('deploy: migrate failure restarts jobs on the OLD tag and never ups the target colour', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-migrate-failure-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  // Simulate an existing prior deploy (active=blue @ OLD_COMMIT) so target
  // resolves to green and there is an "old tag" to restart jobs on.
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  libModule.writeState(stateDir, {
    activeColor: 'blue',
    commit: OLD_COMMIT,
    previousColor: null,
    previousCommit: null,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('run') && command.includes('--no-deps') && command.includes('migrate')) {
        return new Error('migration failed: constraint violation');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /migration failed/);
  assert.match(outcome.stderr, /restarted on the old tag/);

  const upCalls = calls.filter((call) => call.command.includes('up'));
  assert.ok(
    upCalls.some((call) => call.command.includes('scheduler') && call.env?.BLUEGREEN_ACTIVE_TAG === OLD_COMMIT),
    'scheduler must be restarted with ACTIVE_TAG=old commit',
  );
  assert.equal(
    upCalls.some((call) => call.command.includes('api-green') || call.command.includes('web-green')),
    false,
    'target colour must never be brought up after a migration failure',
  );

  rmSync(stateDir, { recursive: true, force: true });
});

test('deploy: candidate smoke failure leaves the switch unexecuted', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-candidate-smoke-failure-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  // Second-deploy scenario (active=blue, deploying green) so the live
  // upstream file already exists with real content the switch phase would
  // have to overwrite — a meaningful "was it touched" assertion.
  libModule.writeState(stateDir, {
    activeColor: 'blue',
    commit: OLD_COMMIT,
    previousColor: null,
    previousCommit: null,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });
  const activeUpstreamsPath = join(stateDir, 'active-upstreams.caddy');
  writeFileSync(activeUpstreamsPath, libModule.renderUpstreams('blue'));

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      const joined = command.join(' ');
      if (joined.includes('exec') && joined.includes('api-green') && joined.includes('readiness')) {
        return { stdout: readinessBody('wrong-commit') };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /candidate smoke test failed/);
  assert.equal(
    calls.some((call) => call.command.includes('caddy') && call.command.includes('validate')),
    false,
    'caddy validate must never run — switch was never entered',
  );
  assert.equal(
    calls.some((call) => call.command.includes('caddy') && call.command.includes('reload')),
    false,
    'caddy reload must never run',
  );
  assert.equal(
    readFileSync(activeUpstreamsPath, 'utf8'),
    libModule.renderUpstreams('blue'),
    'the live upstream file must be untouched (still blue) when candidate smoke fails',
  );

  rmSync(stateDir, { recursive: true, force: true });
});

test('deploy: public smoke failure restores upstreams, reloads, and re-verifies the OLD commit', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-public-smoke-failure-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  libModule.writeState(stateDir, {
    activeColor: 'blue',
    commit: OLD_COMMIT,
    previousColor: null,
    previousCommit: null,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const activeUpstreamsPath = join(stateDir, 'active-upstreams.caddy');
  writeFileSync(activeUpstreamsPath, libModule.renderUpstreams('blue'));

  let publicSmokeCallCount = 0;
  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command, options) => {
      if (command[0] === 'wget') {
        publicSmokeCallCount += 1;
        // First public-smoke call (through the front door, ACTIVE_TAG=target)
        // fails; the re-verify call (ACTIVE_TAG=old commit) must succeed
        // reporting the OLD commit.
        if (publicSmokeCallCount === 1) return { stdout: readinessBody('a-broken-response') };
        return { stdout: readinessBody(options.env?.BLUEGREEN_ACTIVE_TAG) };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /public smoke test failed/);
  assert.match(outcome.stderr, /reverted to the old colour and re-verified/);
  assert.doesNotMatch(outcome.stderr, /re-verification reported buildCommit/, 'the re-verify must have reported the old commit, not a mismatch');

  const restoredContent = readFileSync(activeUpstreamsPath, 'utf8');
  assert.equal(restoredContent, libModule.renderUpstreams('blue'), 'the upstream file must be restored to blue');

  const reloadCalls = calls.filter(
    (call) => call.command.includes('caddy') && call.command.includes('reload'),
  );
  assert.ok(reloadCalls.length >= 2, 'caddy must reload at least twice: switch + revert');

  const oldSchedulerRestart = calls.find(
    (call) => call.command.includes('up') && call.command.includes('scheduler') && call.env?.BLUEGREEN_ACTIVE_TAG === OLD_COMMIT,
  );
  assert.ok(oldSchedulerRestart, 'scheduler must be restarted on the old tag during the revert');

  assert.equal(publicSmokeCallCount, 2, 'exactly one public smoke attempt plus one re-verify wget call');

  rmSync(stateDir, { recursive: true, force: true });
});

test('deploy: reload failure restores the previous upstream file', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-reload-failure-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const activeUpstreamsPath = join(stateDir, 'active-upstreams.caddy');
  writeFileSync(activeUpstreamsPath, libModule.renderUpstreams('blue'));
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('caddy') && command.includes('reload')) {
        // Fail the FIRST reload (switch attempt); the recovery reload (2nd
        // call) must succeed so we can prove the restore path.
        const reloadCallsSoFar = calls.filter((c) => c.command.includes('reload')).length;
        if (reloadCallsSoFar === 1) return new Error('caddy: reload failed, config error');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Caddy reload failed while switching/);
  const restoredContent = readFileSync(activeUpstreamsPath, 'utf8');
  assert.equal(restoredContent, libModule.renderUpstreams('blue'), 'the previous (blue) upstream file must be restored verbatim');

  const reloadCalls = calls.filter((call) => call.command.includes('reload'));
  assert.equal(reloadCalls.length, 2, 'the failed reload plus the recovery reload');

  rmSync(stateDir, { recursive: true, force: true });
});

test('rollback: refuses after --allow-destructive-migration (rollbackable: false)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-rollback-refused-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  libModule.writeState(stateDir, {
    activeColor: 'green',
    commit: TARGET_COMMIT,
    previousColor: 'blue',
    previousCommit: OLD_COMMIT,
    deployedAt: new Date().toISOString(),
    rollbackable: false,
  });

  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['rollback', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /disables one-command rollback/);
  assert.equal(calls.length, 0, 'no docker/git command may run once rollbackable:false is seen');

  rmSync(stateDir, { recursive: true, force: true });
});

test('every DSN in the transcript is redacted', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-redaction-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const secretDsn = 'postgresql://produser:sup3rSecret@db.charitypilot.ie:5432/charitypilot';
  const { deps } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('run') && command.includes('--no-deps') && command.includes('migrate')) {
        return new Error(`migration failed while connected to ${secretDsn}`);
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.doesNotMatch(outcome.stderr, /sup3rSecret/);
  assert.doesNotMatch(outcome.stdout, /sup3rSecret/);
  assert.match(outcome.stderr, /\[redacted-database-url\]/);

  rmSync(stateDir, { recursive: true, force: true });
});

test('lock is released on every abort path', async () => {
  const runDeploy = await loadDeployRunner();

  const scenarios = [
    {
      name: 'preflight failure (bad DATABASE_URL host)',
      setup(stateDir) {
        const envPath = join(stateDir, 'bluegreen.env');
        writeEnvFile(envPath, { DATABASE_URL: 'postgresql://u:p@not-the-db-service:5432/charitypilot' });
        return envPath;
      },
    },
    {
      name: 'blocked migration',
      setup(stateDir) {
        const envPath = join(stateDir, 'bluegreen.env');
        writeEnvFile(envPath);
        seedMigrationsDir(stateDir, TARGET_COMMIT, [
          { name: '20260101000000_drop', sql: 'DROP TABLE "Foo";' },
        ]);
        return envPath;
      },
    },
    {
      name: 'migrate failure',
      setup(stateDir) {
        const envPath = join(stateDir, 'bluegreen.env');
        writeEnvFile(envPath);
        seedMigrationsDir(stateDir, TARGET_COMMIT, []);
        return envPath;
      },
      overrides: (command) => {
        if (command.includes('run') && command.includes('--no-deps') && command.includes('migrate')) {
          return new Error('boom');
        }
        return undefined;
      },
    },
  ];

  for (const scenario of scenarios) {
    const stateDir = makeFixtureDir('bluegreen-lock-release-');
    const envPath = scenario.setup(stateDir);
    let released = false;
    const { deps } = baseDeps({ stateDir, overrides: scenario.overrides });
    deps.releaseCutoverLock = (lock) => {
      released = true;
      assert.ok(lock);
    };

    const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

    assert.equal(outcome.status, 1, `${scenario.name}: expected failure`);
    assert.equal(released, true, `${scenario.name}: lock must be released`);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--skip-backup is refused when NODE_ENV=production', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-skip-backup-refused-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { NODE_ENV: 'production' });

  const { deps, calls, backupCalls } = baseDeps({ stateDir });

  const outcome = await runDeploy(
    ['deploy', '--env-file', envPath, '--state-dir', stateDir, '--skip-backup'],
    deps,
  );

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /--skip-backup is refused/);
  assert.match(outcome.stderr, /NODE_ENV=production/);
  assert.equal(calls.length, 0, 'no docker/git command may run');
  assert.equal(backupCalls.length, 0, 'backup must never run either');

  rmSync(stateDir, { recursive: true, force: true });
});

test('--skip-backup is honoured outside production (backup phase skipped)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-skip-backup-dev-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { NODE_ENV: 'development' });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, backupCalls } = baseDeps({ stateDir });

  const outcome = await runDeploy(
    ['deploy', '--env-file', envPath, '--state-dir', stateDir, '--skip-backup'],
    deps,
  );

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(backupCalls.length, 0, 'runBackupImpl must not be invoked when skipped');

  rmSync(stateDir, { recursive: true, force: true });
});

test('preflight surfaces unknownApplied migrations as a warning, never an abort', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-unknown-applied-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  // The release checkout has NO migrations directories, but the live db
  // reports one applied migration this release doesn't know about — the
  // "release is older than the database" rollback-style scenario.
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps } = baseDeps({ stateDir, appliedMigrations: ['20990101000000_future_migration'] });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /WARNING/);
  assert.match(outcome.stdout, /20990101000000_future_migration/);
  assert.match(outcome.stdout, /OLDER than the database/);

  rmSync(stateDir, { recursive: true, force: true });
});

test('status: reports "no deploy state found" before any deploy has run', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-status-empty-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  const { deps } = baseDeps({ stateDir });

  const outcome = await runDeploy(['status', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /No deploy state found/);

  rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fix round 1 (coordinator review) — new pinned tests
// ---------------------------------------------------------------------------

test('C1: gate survives a fresh database with no _prisma_migrations relation yet', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-fresh-db-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, [
    { name: '20260101000000_init', sql: 'CREATE TABLE "Foo" (id serial primary key);' },
  ]);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      const joined = command.join(' ');
      if (joined.includes('psql') && joined.includes('TO_REGCLASS')) {
        return { stdout: 'f' };
      }
      if (joined.includes('psql') && joined.includes('_prisma_migrations') && !joined.includes('TO_REGCLASS')) {
        throw new Error('the real applied-migrations query must never run against a missing table');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  const realQueryRan = calls.some((call) => {
    const joined = call.command.join(' ');
    return joined.includes('_prisma_migrations') && !joined.includes('TO_REGCLASS');
  });
  assert.equal(realQueryRan, false, 'the real applied-migrations query must never run when the probe reports the table missing');

  rmSync(stateDir, { recursive: true, force: true });
});

test('C1: a probe that itself throws a relation-missing error is treated as a fresh database, not an abort', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-fresh-db-throw-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps } = baseDeps({
    stateDir,
    overrides: (command) => {
      const joined = command.join(' ');
      if (joined.includes('psql') && joined.includes('TO_REGCLASS')) {
        return new Error('ERROR:  relation "_prisma_migrations" does not exist');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);

  rmSync(stateDir, { recursive: true, force: true });
});

test('I2: a failure starting the scheduler (phase 13) still records the target colour as active', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-phase13-failure-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  libModule.writeState(stateDir, {
    activeColor: 'blue',
    commit: OLD_COMMIT,
    previousColor: null,
    previousCommit: null,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  writeFileSync(join(stateDir, 'active-upstreams.caddy'), libModule.renderUpstreams('blue'));

  const { deps } = baseDeps({
    stateDir,
    overrides: (command, options) => {
      if (
        command.includes('up') &&
        command.includes('scheduler') &&
        options.env?.BLUEGREEN_ACTIVE_TAG === TARGET_COMMIT
      ) {
        return new Error('scheduler failed to start');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Traffic is serving green and state is recorded/);
  assert.match(outcome.stderr, /scheduler restart\/retire incomplete/);

  const state = libModule.readState(stateDir);
  assert.equal(state.activeColor, 'green', 'state must already say green is active even though jobs failed');
  assert.equal(state.commit, TARGET_COMMIT);

  rmSync(stateDir, { recursive: true, force: true });
});

test('I2: a failure stopping the old colour (phase 14) still records the target colour as active', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-phase14-failure-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  libModule.writeState(stateDir, {
    activeColor: 'blue',
    commit: OLD_COMMIT,
    previousColor: null,
    previousCommit: null,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  writeFileSync(join(stateDir, 'active-upstreams.caddy'), libModule.renderUpstreams('blue'));

  const { deps } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('stop') && command.includes('api-blue') && command.includes('web-blue')) {
        return new Error('stop failed: container busy');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Traffic is serving green and state is recorded/);
  assert.match(outcome.stderr, /stopping the old colour \(blue\) failed/);

  const state = libModule.readState(stateDir);
  assert.equal(state.activeColor, 'green', 'state must already say green is active even though retire failed');

  rmSync(stateDir, { recursive: true, force: true });
});

test('I3: a post-rollback verification mismatch leaves state unflipped and logs rollback-uncertain', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-rollback-uncertain-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  libModule.writeState(stateDir, {
    activeColor: 'green',
    commit: TARGET_COMMIT,
    previousColor: 'blue',
    previousCommit: OLD_COMMIT,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });

  const { deps } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('ps') && command.includes('-a')) {
        return { stdout: 'api-blue   Up\nweb-blue   Up\n' };
      }
      if (command[0] === 'wget') {
        return { stdout: readinessBody('some-other-unexpected-commit') };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['rollback', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /State uncertain/);
  assert.match(outcome.stderr, /observed buildCommit=.*some-other-unexpected-commit/);
  assert.match(outcome.stderr, /expected/);

  const state = libModule.readState(stateDir);
  assert.equal(state.activeColor, 'green', 'state must NOT flip when the rollback re-verify mismatches');
  assert.equal(state.commit, TARGET_COMMIT);

  const status = libModule.deployStatus(stateDir);
  assert.ok(
    status.history.some((entry) => entry.phase === 'rollback-uncertain'),
    'a rollback-uncertain status entry must be recorded',
  );

  rmSync(stateDir, { recursive: true, force: true });
});

test('I3: a post-rollback smoke command failure also leaves state unflipped and logs rollback-uncertain', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-rollback-uncertain-cmd-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  libModule.writeState(stateDir, {
    activeColor: 'green',
    commit: TARGET_COMMIT,
    previousColor: 'blue',
    previousCommit: OLD_COMMIT,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });

  const { deps } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('ps') && command.includes('-a')) {
        return { stdout: 'api-blue   Up\n' };
      }
      if (command[0] === 'wget') {
        return new Error('connection refused');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['rollback', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /State uncertain/);

  const state = libModule.readState(stateDir);
  assert.equal(state.activeColor, 'green');

  const status = libModule.deployStatus(stateDir);
  assert.ok(status.history.some((entry) => entry.phase === 'rollback-uncertain'));

  rmSync(stateDir, { recursive: true, force: true });
});

test('I4: preflightIssues requires READINESS_API_KEY and BLUEGREEN_ORIGIN; BLUEGREEN_FRONT_PORT is optional-but-numeric', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = join(tmpdir(), 'bluegreen-preflight-issues.env');
  const baseFileEnv = {
    DATABASE_URL: 'postgresql://u:p@db:5432/charitypilot',
    BLUEGREEN_ENV_FILE: envFilePath,
    FRONTEND_URL: 'https://app.charitypilot.ie',
    READINESS_API_KEY: 'a-real-readiness-key',
    BLUEGREEN_ORIGIN: 'https://app.charitypilot.ie',
  };

  const clean = preflightIssues({ fileEnv: baseFileEnv, resolvedEnvFilePath: envFilePath });
  assert.equal(clean.some((issue) => issue.includes('READINESS_API_KEY')), false);
  assert.equal(clean.some((issue) => issue.includes('BLUEGREEN_ORIGIN')), false);
  assert.equal(clean.some((issue) => issue.includes('BLUEGREEN_FRONT_PORT')), false);

  const noKey = preflightIssues({
    fileEnv: { ...baseFileEnv, READINESS_API_KEY: '' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(noKey.some((issue) => issue.includes('READINESS_API_KEY is required')));

  const noOrigin = preflightIssues({
    fileEnv: { ...baseFileEnv, BLUEGREEN_ORIGIN: '' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(noOrigin.some((issue) => issue.includes('BLUEGREEN_ORIGIN is required')));

  const numericPort = preflightIssues({
    fileEnv: { ...baseFileEnv, BLUEGREEN_FRONT_PORT: '8080' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.equal(numericPort.some((issue) => issue.includes('BLUEGREEN_FRONT_PORT')), false);

  const badPort = preflightIssues({
    fileEnv: { ...baseFileEnv, BLUEGREEN_FRONT_PORT: 'not-a-port' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(badPort.some((issue) => issue.includes('BLUEGREEN_FRONT_PORT must be a positive integer')));
});

test('I4: deploy preflight actually refuses before any command runs when READINESS_API_KEY is missing', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-preflight-no-key-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { READINESS_API_KEY: '' });

  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /READINESS_API_KEY is required/);
  assert.equal(calls.length, 0, 'no docker/git command may run before preflight passes');

  rmSync(stateDir, { recursive: true, force: true });
});

test('I5: candidate smoke failure restarts jobs on the OLD tag with --wait', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-i5-candidate-smoke-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  libModule.writeState(stateDir, {
    activeColor: 'blue',
    commit: OLD_COMMIT,
    previousColor: null,
    previousCommit: null,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  writeFileSync(join(stateDir, 'active-upstreams.caddy'), libModule.renderUpstreams('blue'));

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      const joined = command.join(' ');
      if (joined.includes('exec') && joined.includes('api-green') && joined.includes('readiness')) {
        return { stdout: readinessBody('wrong-commit') };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /candidate smoke test failed/);
  assert.match(outcome.stderr, /Jobs were restarted on the old tag/);

  const restart = calls.find(
    (call) =>
      call.command.includes('up') &&
      call.command.includes('--wait') &&
      call.command.includes('scheduler') &&
      call.env?.BLUEGREEN_ACTIVE_TAG === OLD_COMMIT,
  );
  assert.ok(restart, 'scheduler must be restarted with --wait on the OLD tag after a candidate-smoke failure');

  rmSync(stateDir, { recursive: true, force: true });
});

test('I5: Caddy reload failure at switch restarts jobs on the OLD tag with --wait', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-i5-reload-failure-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  libModule.writeState(stateDir, {
    activeColor: 'blue',
    commit: OLD_COMMIT,
    previousColor: null,
    previousCommit: null,
    deployedAt: new Date().toISOString(),
    rollbackable: true,
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const activeUpstreamsPath = join(stateDir, 'active-upstreams.caddy');
  writeFileSync(activeUpstreamsPath, libModule.renderUpstreams('blue'));

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('caddy') && command.includes('reload')) {
        const priorReloads = calls.filter((c) => c.command.includes('reload')).length;
        if (priorReloads === 1) return new Error('caddy: reload failed, config error');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Caddy reload failed while switching/);
  assert.match(outcome.stderr, /Jobs were restarted on the old tag/);

  const restart = calls.find(
    (call) =>
      call.command.includes('up') &&
      call.command.includes('--wait') &&
      call.command.includes('scheduler') &&
      call.env?.BLUEGREEN_ACTIVE_TAG === OLD_COMMIT,
  );
  assert.ok(restart, 'scheduler must be restarted with --wait on the OLD tag after a reload failure');

  const restoredContent = readFileSync(activeUpstreamsPath, 'utf8');
  assert.equal(restoredContent, libModule.renderUpstreams('blue'));

  rmSync(stateDir, { recursive: true, force: true });
});

test('M2: public smoke failure on a first deploy skips the revert block with a clear message', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-m2-first-deploy-smoke-fail-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command[0] === 'wget') return { stdout: readinessBody('wrong-commit') };
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /No previous colour to revert to \(first deploy\)/);
  assert.match(outcome.stderr, /inspect manually before retrying/);

  const wgetCalls = calls.filter((call) => call.command[0] === 'wget');
  assert.equal(wgetCalls.length, 1, 'only the original public smoke wget runs — no re-verify attempt on a first deploy');
  const reloadCalls = calls.filter((call) => call.command.includes('reload'));
  assert.equal(reloadCalls.length, 1, 'only the switch-time reload runs — no revert reload on a first deploy');

  rmSync(stateDir, { recursive: true, force: true });
});

test('M5: a reused release worktree belonging to a different commit is removed and recreated', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-m5-worktree-mismatch-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  const migrationsDir = seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command[0] === 'git' && command[1] === '-C' && command[3] === 'rev-parse' && command[4] === 'HEAD') {
        return { stdout: `${'c'.repeat(40)}\n` };
      }
      if (command[0] === 'git' && command[1] === 'worktree' && command[2] === 'add') {
        mkdirSync(migrationsDir, { recursive: true });
        return { stdout: '' };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  const removeCall = calls.find((call) => call.command.includes('worktree') && call.command.includes('remove'));
  assert.ok(removeCall, 'a worktree belonging to a different commit must be removed');
  const addCall = calls.find((call) => call.command.includes('worktree') && call.command.includes('add'));
  assert.ok(addCall, 'the worktree must be recreated at the target commit');

  rmSync(stateDir, { recursive: true, force: true });
});

test('M6: --detach lock contention fails loudly in the foreground and never spawns', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-m6-detach-contended-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  let spawnCalled = false;
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir, '--detach'], {
    processEnv: { PATH: process.env.PATH ?? '' },
    acquireCutoverLock: () => {
      throw new Error('production cutover lock is already held by process 4242');
    },
    releaseCutoverLock: () => {},
    spawnDetached: () => {
      spawnCalled = true;
      return {};
    },
    now: () => new Date('2026-08-31T12:00:00.000Z'),
  });

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /failed before detaching/);
  assert.match(outcome.stderr, /already held/);
  assert.equal(spawnCalled, false, 'must never spawn the detached child when the lock is contended');

  rmSync(stateDir, { recursive: true, force: true });
});

test('M6: --detach acquires then releases the probe lock before spawning', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-m6-detach-clean-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  const order = [];
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir, '--detach'], {
    processEnv: { PATH: process.env.PATH ?? '' },
    acquireCutoverLock: () => {
      order.push('acquire');
      return { fake: true };
    },
    releaseCutoverLock: (lock) => {
      assert.ok(lock);
      order.push('release');
    },
    spawnDetached: () => {
      order.push('spawn');
      return {};
    },
    now: () => new Date('2026-08-31T12:00:00.000Z'),
  });

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(order, ['acquire', 'release', 'spawn'], 'the probe lock must release before the child spawns');
  assert.match(outcome.stdout, /Deploying in the background/);

  rmSync(stateDir, { recursive: true, force: true });
});
