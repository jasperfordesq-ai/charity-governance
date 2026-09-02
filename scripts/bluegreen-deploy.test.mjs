import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
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
    // M1 fix: these two feed env.ts's own production validation on the API
    // server (CHARITYPILOT_CANONICAL_WEB_ORIGIN/_API_ORIGIN), which is
    // https-only with no loopback exception — a DIFFERENT, separate
    // mechanism from BLUEGREEN_ORIGIN/NEXT_PUBLIC_CHARITYPILOT_CANONICAL_
    // API_ORIGIN above (the web app's own build-time override, which DOES
    // accept exact loopback http for local acceptance testing). Must stay
    // realistic https placeholders now that preflightIssues validates
    // their shape, not just their presence.
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'https://vm.tailnet.example',
    CHARITYPILOT_CANONICAL_API_ORIGIN: 'https://vm.tailnet.example',
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
    // Fix round 4: [binary, '--version'] is the preflight's host-binary
    // probe (missingHostBinaries), not a real wget invocation — exclude it
    // here so it falls through to the generic success default below unless
    // a test's own override deliberately fails it (a missing binary is
    // exercised by its own dedicated test via a narrower runCommand stub).
    if (command[0] === 'wget' && command[1] !== '--version') {
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
    'ensure-db',
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
  assert.deepEqual(phases, ['preflight', 'ensure-db', 'backup', 'resolve', 'worktree', 'build', 'gate']);
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
      // command[1] !== '--version' excludes the preflight's host-binary
      // probe (fix round 4) from this count — it isn't a real smoke call.
      if (command[0] === 'wget' && command[1] !== '--version') {
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
      if (command[0] === 'wget' && command[1] !== '--version') {
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

test('M1: preflightIssues validates the SHAPE of the canonical-origin overrides, not just their presence', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = join(tmpdir(), 'bluegreen-preflight-canonical-shape.env');
  const nonApprovedFileEnv = {
    DATABASE_URL: 'postgresql://u:p@db:5432/charitypilot',
    BLUEGREEN_ENV_FILE: envFilePath,
    FRONTEND_URL: 'https://vm.tailnet.example',
    READINESS_API_KEY: 'a-real-readiness-key',
    BLUEGREEN_ORIGIN: 'https://vm.tailnet.example',
  };

  // Accept: both overrides are exact https origins.
  const clean = preflightIssues({
    fileEnv: {
      ...nonApprovedFileEnv,
      CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'https://vm.tailnet.example',
      CHARITYPILOT_CANONICAL_API_ORIGIN: 'https://vm.tailnet.example',
    },
    resolvedEnvFilePath: envFilePath,
  });
  assert.equal(clean.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_WEB_ORIGIN')), false);
  assert.equal(clean.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_API_ORIGIN')), false);

  // Reject: path, trailing slash, credentials, and non-https, one at a time.
  for (const badValue of [
    'https://vm.tailnet.example/path',
    'https://vm.tailnet.example/',
    'https://user:pass@vm.tailnet.example',
    'http://vm.tailnet.example',
    'not a url',
  ]) {
    const badWeb = preflightIssues({
      fileEnv: {
        ...nonApprovedFileEnv,
        CHARITYPILOT_CANONICAL_WEB_ORIGIN: badValue,
        CHARITYPILOT_CANONICAL_API_ORIGIN: 'https://vm.tailnet.example',
      },
      resolvedEnvFilePath: envFilePath,
    });
    assert.ok(
      badWeb.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_WEB_ORIGIN must be an exact https origin')),
      `expected a shape rejection for CHARITYPILOT_CANONICAL_WEB_ORIGIN=${badValue}`,
    );

    const badApi = preflightIssues({
      fileEnv: {
        ...nonApprovedFileEnv,
        CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'https://vm.tailnet.example',
        CHARITYPILOT_CANONICAL_API_ORIGIN: badValue,
      },
      resolvedEnvFilePath: envFilePath,
    });
    assert.ok(
      badApi.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_API_ORIGIN must be an exact https origin')),
      `expected a shape rejection for CHARITYPILOT_CANONICAL_API_ORIGIN=${badValue}`,
    );
  }
});

test('micro-round: canonical-origin overrides may be exact loopback http ONLY when BLUEGREEN_ORIGIN is itself loopback', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = join(tmpdir(), 'bluegreen-preflight-canonical-loopback.env');
  const baseFileEnv = {
    DATABASE_URL: 'postgresql://u:p@db:5432/charitypilot',
    BLUEGREEN_ENV_FILE: envFilePath,
    FRONTEND_URL: 'https://vm.tailnet.example',
    READINESS_API_KEY: 'a-real-readiness-key',
  };

  // Accepted: loopback override, loopback BLUEGREEN_ORIGIN.
  const acceptedLoopback = preflightIssues({
    fileEnv: {
      ...baseFileEnv,
      BLUEGREEN_ORIGIN: 'http://localhost:18080',
      CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'http://localhost:18080',
      CHARITYPILOT_CANONICAL_API_ORIGIN: 'http://localhost:18080',
    },
    resolvedEnvFilePath: envFilePath,
  });
  assert.equal(acceptedLoopback.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_WEB_ORIGIN')), false);
  assert.equal(acceptedLoopback.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_API_ORIGIN')), false);

  // Also accepted for the other two exact-loopback hostnames.
  for (const loopbackOrigin of ['http://127.0.0.1:18080', 'http://[::1]:18080']) {
    const accepted = preflightIssues({
      fileEnv: {
        ...baseFileEnv,
        BLUEGREEN_ORIGIN: loopbackOrigin,
        CHARITYPILOT_CANONICAL_WEB_ORIGIN: loopbackOrigin,
        CHARITYPILOT_CANONICAL_API_ORIGIN: loopbackOrigin,
      },
      resolvedEnvFilePath: envFilePath,
    });
    assert.equal(
      accepted.some((issue) => issue.includes('CANONICAL')),
      false,
      `expected ${loopbackOrigin} to be accepted when BLUEGREEN_ORIGIN matches it`,
    );
  }

  // Rejected: loopback override, but BLUEGREEN_ORIGIN is https (non-loopback)
  // — the leniency must not leak in when the deployment itself isn't local.
  const rejectedLoopback = preflightIssues({
    fileEnv: {
      ...baseFileEnv,
      BLUEGREEN_ORIGIN: 'https://vm.tailnet.example',
      CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'http://localhost:18080',
      CHARITYPILOT_CANONICAL_API_ORIGIN: 'http://localhost:18080',
    },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(
    rejectedLoopback.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_WEB_ORIGIN must be an exact https origin')),
    `expected a loopback override to be rejected when BLUEGREEN_ORIGIN is https, got: ${JSON.stringify(rejectedLoopback)}`,
  );
  assert.ok(
    rejectedLoopback.some((issue) => issue.includes('CHARITYPILOT_CANONICAL_API_ORIGIN must be an exact https origin')),
  );

  // The https path is unchanged: exact https origins still accepted
  // regardless of BLUEGREEN_ORIGIN's own shape.
  const httpsUnchanged = preflightIssues({
    fileEnv: {
      ...baseFileEnv,
      BLUEGREEN_ORIGIN: 'https://vm.tailnet.example',
      CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'https://vm.tailnet.example',
      CHARITYPILOT_CANONICAL_API_ORIGIN: 'https://vm.tailnet.example',
    },
    resolvedEnvFilePath: envFilePath,
  });
  assert.equal(httpsUnchanged.some((issue) => issue.includes('CANONICAL')), false);
});

test('M2: BLUEGREEN_FRONT_PORT="" falls back to the 8080 default, matching compose\'s own ${BLUEGREEN_FRONT_PORT:-8080}', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-m2-empty-front-port-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { BLUEGREEN_FRONT_PORT: '' });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);

  const publicSmoke = calls.find(
    (call) => call.command[0] === 'wget' && call.command[1] !== '--version',
  );
  assert.ok(publicSmoke, 'the public-smoke wget call must have run');
  const url = publicSmoke.command.at(-1);
  assert.match(url, /127\.0\.0\.1:8080/, `expected the 8080 default in the smoke URL, got: ${url}`);

  rmSync(stateDir, { recursive: true, force: true });
});

test('I3: BLUEGREEN_DOCUMENTS_VOLUME threads through to runBackupImpl (deploy path)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-i3-docs-volume-deploy-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { BLUEGREEN_DOCUMENTS_VOLUME: 'custom-charity-documents' });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, backupCalls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(backupCalls.length, 1);
  assert.equal(backupCalls[0].ctx.documentsVolume, 'custom-charity-documents');
});

test('I3: BLUEGREEN_DOCUMENTS_VOLUME threads through to runBackupImpl (standalone backup command)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-i3-docs-volume-backup-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { BLUEGREEN_DOCUMENTS_VOLUME: 'custom-charity-documents' });

  const { deps, backupCalls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['backup', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(backupCalls.length, 1);
  assert.equal(backupCalls[0].ctx.documentsVolume, 'custom-charity-documents');
});

test('I3: an unset/empty BLUEGREEN_DOCUMENTS_VOLUME leaves ctx.documentsVolume undefined (backup.mjs applies its own default)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-i3-docs-volume-default-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { BLUEGREEN_DOCUMENTS_VOLUME: '' });

  const { deps, backupCalls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['backup', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(backupCalls.length, 1);
  assert.equal(backupCalls[0].ctx.documentsVolume, undefined, "'' must count as unset, not a literal empty volume name");
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

test('I1: phase 9 (up) failure restarts jobs on the OLD tag with --wait', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-i1-phase9-up-');
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
      // The reviewer's own reproduction: web-green never becomes healthy
      // during phase 9's `up -d --wait`.
      if (command.includes('--profile') && command.includes('up') && command.includes('web-green')) {
        return new Error('service "web-green" did not become healthy');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /starting green containers failed/);
  assert.match(outcome.stderr, /Jobs were restarted on the old tag/);

  const restart = calls.find(
    (call) =>
      call.command.includes('up') &&
      call.command.includes('--wait') &&
      call.command.includes('scheduler') &&
      call.env?.BLUEGREEN_ACTIVE_TAG === OLD_COMMIT,
  );
  assert.ok(restart, 'scheduler must be restarted with --wait on the OLD tag after a phase-9 up failure');

  rmSync(stateDir, { recursive: true, force: true });
});

test('I1: phase 11 (up caddy) failure restarts jobs on the OLD tag with --wait', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-i1-phase11-up-');
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
      // Only phase 11's `up -d --wait caddy` — must not match phase 9's
      // up (which also includes 'up'/'-d'/'--wait' but also '--profile')
      // or the later scheduler-restart up (which never includes 'caddy').
      if (command.includes('up') && command.includes('--wait') && command.includes('caddy') && !command.includes('--profile')) {
        return new Error('service "caddy" did not become healthy');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /starting Caddy failed while switching/);
  assert.match(outcome.stderr, /Jobs were restarted on the old tag/);

  const restart = calls.find(
    (call) =>
      call.command.includes('up') &&
      call.command.includes('--wait') &&
      call.command.includes('scheduler') &&
      call.env?.BLUEGREEN_ACTIVE_TAG === OLD_COMMIT,
  );
  assert.ok(restart, 'scheduler must be restarted with --wait on the OLD tag after a phase-11 caddy-up failure');

  // No upstream file write was ever attempted at this point, so the
  // original content must be untouched (nothing to "restore").
  const content = readFileSync(activeUpstreamsPath, 'utf8');
  assert.equal(content, libModule.renderUpstreams('blue'));

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

  const wgetCalls = calls.filter((call) => call.command[0] === 'wget' && call.command[1] !== '--version');
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

test('I2 (fix round 2): a writeState failure right after cutover reports the switched-but-unrecorded state explicitly', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-i2-writestate-failure-');
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

  // The re-reviewer's EISDIR technique: pre-create state.json.tmp as a
  // DIRECTORY so lib.mjs's writeState (writeFileSync then renameSync) fails
  // synchronously the moment it tries to write the tmp file.
  mkdirSync(join(stateDir, 'state.json.tmp'), { recursive: true });

  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);

  // (a) the switch/reload happened BEFORE the writeState failure.
  const validateCall = calls.find((call) => call.command.includes('caddy') && call.command.includes('validate'));
  const reloadCall = calls.find((call) => call.command.includes('caddy') && call.command.includes('reload'));
  const publicSmokeCall = calls.find((call) => call.command[0] === 'wget');
  assert.ok(validateCall, 'caddy validate must have run before the writeState failure');
  assert.ok(reloadCall, 'caddy reload must have run before the writeState failure');
  assert.ok(publicSmokeCall, 'the public smoke wget must have run (and passed) before the writeState failure');
  const upstreamContent = readFileSync(join(stateDir, 'active-upstreams.caddy'), 'utf8');
  assert.equal(upstreamContent, libModule.renderUpstreams('green'), 'the live upstream file must already be rewritten to the new (target) colour — proof the switch really happened before the writeState failure');

  // (b) the message names the switch, the target colour, and the commit —
  // actionable from the message text alone.
  assert.match(outcome.stderr, /ALREADY been switched/);
  assert.match(outcome.stderr, /green/);
  assert.match(outcome.stderr, new RegExp(TARGET_COMMIT));
  assert.match(outcome.stderr, /state\.json still names blue/);
  assert.match(outcome.stderr, /DO NOT run another deploy/);
  assert.match(outcome.stderr, /activeColor: 'green'/);
  assert.match(outcome.stderr, new RegExp(`commit: '${TARGET_COMMIT}'`));

  // (c) no raw, unexplained EISDIR-only crash — the message is the crafted
  // one above, not a bare filesystem error, and the process returned a
  // normal result rather than throwing all the way out.
  assert.doesNotMatch(outcome.stderr, /^EISDIR/m);

  // state.json must still (wrongly, but knowably) say blue — proving the
  // hazard is real and that we are reporting it rather than silently
  // "fixing" it by some other path.
  const state = libModule.readState(stateDir);
  assert.equal(state.activeColor, 'blue');

  rmSync(stateDir, { recursive: true, force: true });
});

test('I2 (fix round 3, rollback side): a writeState failure right after rollback verification reports the switched-but-unrecorded state explicitly', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-i2-rollback-writestate-failure-');
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
  writeFileSync(join(stateDir, 'active-upstreams.caddy'), libModule.renderUpstreams('green'));

  // The re-reviewer's EISDIR technique, applied to the rollback path: a
  // pre-created state.json.tmp DIRECTORY makes lib.mjs's writeState throw
  // synchronously the moment it tries to write the tmp file.
  mkdirSync(join(stateDir, 'state.json.tmp'), { recursive: true });

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('ps') && command.includes('-a')) {
        return { stdout: 'api-blue   Up\nweb-blue   Up\n' };
      }
      if (command[0] === 'wget') {
        return { stdout: readinessBody(OLD_COMMIT) };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['rollback', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);

  // (a) the rollback's reload happened BEFORE the writeState failure.
  const validateCall = calls.find((call) => call.command.includes('caddy') && call.command.includes('validate'));
  const reloadCall = calls.find((call) => call.command.includes('caddy') && call.command.includes('reload'));
  const publicSmokeCall = calls.find((call) => call.command[0] === 'wget');
  assert.ok(validateCall, 'caddy validate must have run before the writeState failure');
  assert.ok(reloadCall, 'caddy reload must have run before the writeState failure');
  assert.ok(publicSmokeCall, 'the post-rollback smoke wget must have run (and passed) before the writeState failure');
  const upstreamContent = readFileSync(join(stateDir, 'active-upstreams.caddy'), 'utf8');
  assert.equal(
    upstreamContent,
    libModule.renderUpstreams('blue'),
    'the live upstream file must already be rewritten to the previous (rolled-back-to) colour — proof the rollback switch really happened before the writeState failure',
  );

  // (b) the message names the colour traffic was verified on and its
  // commit, verbatim, actionable from the message text alone.
  assert.match(outcome.stderr, /ALREADY been rolled back/);
  assert.match(outcome.stderr, /blue/);
  assert.match(outcome.stderr, new RegExp(OLD_COMMIT));
  assert.match(outcome.stderr, /state\.json still names green/);
  assert.match(outcome.stderr, /DO NOT deploy until state is corrected/);
  assert.match(outcome.stderr, /activeColor: 'blue'/);
  assert.match(outcome.stderr, new RegExp(`commit: '${OLD_COMMIT}'`));

  // (c) no raw, unexplained EISDIR-only crash.
  assert.doesNotMatch(outcome.stderr, /^EISDIR/m);

  // state.json must still (wrongly, but knowably) say green.
  const state = libModule.readState(stateDir);
  assert.equal(state.activeColor, 'green');

  rmSync(stateDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Fix round 3 (structural): caddy/Caddyfile.bluegreen's admin API moved from
// `admin off` to a unix socket on the container's own /tmp tmpfs, because
// every `caddy reload` in this file talks to that admin API to push the new
// config — `admin off` leaves no listener at all, so the switch/rollback
// cutover fails deterministically. This pin reads the real source text (not
// a stubbed command recording) so it fails if a NEW reload site is ever
// added without the matching --address flag, regardless of which code path
// exercises it.
// -----------------------------------------------------------------------------

test('fix round 3: every caddy reload invocation carries the unix-socket admin address', () => {
  const source = readFileSync(deployScriptPath, 'utf8');
  const reloadLines = source.split('\n').filter((line) => line.includes("'caddy', 'reload'"));

  assert.ok(
    reloadLines.length >= 5,
    `expected at least 5 caddy reload sites (deploy switch, deploy best-effort restore, deploy public-smoke revert, rollback switch, rollback best-effort restore); found ${reloadLines.length}`,
  );

  for (const line of reloadLines) {
    assert.match(
      line,
      /'--address',\s*'unix\/\/tmp\/caddy-admin\.sock'/,
      `caddy reload invocation is missing --address unix//tmp/caddy-admin.sock: ${line.trim()}`,
    );
  }
});

// -----------------------------------------------------------------------------
// Fix round 4: a missing host binary (wget, discovered by acceptance run 3 at
// phase 12 — AFTER traffic had already switched) must fail fast in the phase-1
// preflight instead of surfacing as an opaque failure deep into the run.
// -----------------------------------------------------------------------------

test('fix round 4: every host-level (non-containerized) binary spawn is covered by REQUIRED_HOST_BINARIES', async () => {
  const deployModule = await loadDeployModule();
  const source = readFileSync(deployScriptPath, 'utf8');

  // Host-level invocations start their argv array directly with the binary
  // literal (`run(['git', ...`, or `run(wgetVarName` where wgetVarName was
  // declared as `const wgetVarName = ['wget', ...`) — anything spawned via
  // `docker compose exec` runs INSIDE the container instead (its array
  // starts with the `...composePrefix()` spread, never a bare literal), and
  // needs no host binary of its own beyond docker itself.
  const found = new Set();

  const inlineRe = /\brun\(\s*\[\s*'([a-zA-Z0-9_.-]+)'/g;
  let match;
  while ((match = inlineRe.exec(source))) found.add(match[1]);

  const constArrayRe = /const (\w+) = \[\s*\n?\s*'([a-zA-Z0-9_.-]+)'/g;
  while ((match = constArrayRe.exec(source))) {
    const [, varName, binary] = match;
    if (source.includes(`run(${varName}`)) found.add(binary);
  }

  // docker is used exclusively via the composePrefix() spread, so it never
  // appears as a literal array-starting token — require it explicitly.
  found.add('docker');

  const covered = new Set(deployModule.REQUIRED_HOST_BINARIES);
  const uncovered = [...found].filter((binary) => !covered.has(binary));
  assert.deepEqual(
    uncovered,
    [],
    `host binaries invoked but not covered by REQUIRED_HOST_BINARIES: ${uncovered.join(', ')} — add them to the preflight's binary list`,
  );
  assert.ok(found.has('git'), 'sanity: the detector must actually find git usage, not silently match nothing');
  assert.ok(found.has('wget'), 'sanity: the detector must actually find wget usage, not silently match nothing');
});

test('fix round 5: both executeDeploy and executeRollback call missingHostBinaries — not just one entry point', async () => {
  const source = readFileSync(deployScriptPath, 'utf8');

  const deployStart = source.indexOf('async function executeDeploy(deps) {');
  const rollbackStart = source.indexOf('async function executeRollback(deps) {');
  const statusStart = source.indexOf('async function executeStatus(deps) {');
  assert.ok(deployStart !== -1 && rollbackStart !== -1 && statusStart !== -1, 'expected function boundaries not found');
  assert.ok(deployStart < rollbackStart && rollbackStart < statusStart, 'unexpected function order');

  const deployBody = source.slice(deployStart, rollbackStart);
  const rollbackBody = source.slice(rollbackStart, statusStart);

  assert.match(deployBody, /missingHostBinaries\(/, 'executeDeploy must call missingHostBinaries');
  assert.match(rollbackBody, /missingHostBinaries\(/, 'executeRollback must call missingHostBinaries');
});

test('fix round 4: missingHostBinaries reports exactly the binaries whose probe fails (stub honours the binary argument)', async () => {
  const deployModule = await loadDeployModule();
  const probed = [];
  const runCommand = async (command) => {
    probed.push(command[0]);
    // Only wget is "missing" here — the stub inspects which binary was
    // actually asked for rather than blindly succeeding/failing every call.
    if (command[0] === 'wget') throw new Error('spawn wget ENOENT');
    return { stdout: '' };
  };

  const missing = await deployModule.missingHostBinaries(runCommand);

  assert.deepEqual(probed.sort(), [...deployModule.REQUIRED_HOST_BINARIES].sort());
  assert.deepEqual(missing, ['wget']);
});

test('fix round 4: deploy preflight fails fast naming the missing host binary, before any real git/docker call', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-missing-binary-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      // Only the wget --version probe fails; docker/git probes and anything
      // else still succeed via the harness defaults if reached (they must
      // not be reached at all past the first failing probe's report).
      if (command[0] === 'wget' && command[1] === '--version') {
        return new Error('spawn wget ENOENT');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Blue-green deploy preflight failed/);
  assert.match(outcome.stderr, /Required host binaries not found on PATH: wget/);

  // Fails fast: no real git/docker command (status, fetch, worktree, ...)
  // ever ran — only the three --version probes.
  const realCalls = calls.filter((call) => !(call.command.length === 2 && call.command[1] === '--version'));
  assert.deepEqual(realCalls, [], 'no real command may run once a required host binary is reported missing');

  rmSync(stateDir, { recursive: true, force: true });
});

test('fix round 5: rollback refuses fast naming the missing host binary, before any real git/docker call', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-rollback-missing-binary-');
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

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      // Only git's probe fails here — proves the stub inspects which
      // binary was actually asked for, not a blanket pass/fail; docker's
      // and wget's probes, and any other command, must never run past the
      // first failing probe's report.
      if (command[0] === 'git' && command[1] === '--version') {
        return new Error('spawn git ENOENT');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['rollback', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Blue-green rollback refused: required host binaries not found on PATH: git/);

  // Fails fast: no real command (ps -a, the post-rollback wget smoke, ...)
  // ever ran — only the --version probes.
  const realCalls = calls.filter((call) => !(call.command.length === 2 && call.command[1] === '--version'));
  assert.deepEqual(realCalls, [], 'no real command may run once a required host binary is reported missing');

  rmSync(stateDir, { recursive: true, force: true });
});

test('I2: rollback brings the previous colour up (with --wait) BEFORE reloading Caddy onto it', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-i2-rollback-order-');
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

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('ps') && command.includes('-a')) {
        return { stdout: 'api-blue   Up\nweb-blue   Up\n' };
      }
      if (command[0] === 'wget' && command[1] !== '--version') {
        return { stdout: readinessBody(OLD_COMMIT) };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['rollback', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 0, outcome.stderr);

  const upIndex = calls.findIndex(
    (call) =>
      call.command.includes('up') &&
      call.command.includes('--wait') &&
      call.command.includes('api-blue') &&
      call.command.includes('web-blue'),
  );
  const reloadIndex = calls.findIndex(
    (call) => call.command.includes('caddy') && call.command.includes('reload'),
  );

  assert.notEqual(upIndex, -1, 'the previous colour must be brought up with --wait');
  assert.notEqual(reloadIndex, -1, 'Caddy must be reloaded');
  assert.ok(
    upIndex < reloadIndex,
    `up --wait (index ${upIndex}) must precede the Caddy reload (index ${reloadIndex}) — traffic must never point at unconfirmed containers`,
  );

  const upCall = calls[upIndex];
  assert.ok(!upCall.command.includes('scheduler'), 'the up --wait api/web call must not also start the scheduler');

  rmSync(stateDir, { recursive: true, force: true });
});

test('micro-round: rollback up-failure message says traffic was never switched, naming the current colour', async () => {
  const runDeploy = await loadDeployRunner();
  const libModule = await import(pathToFileURL(join(scriptsDir, 'bluegreen', 'lib.mjs')).href);
  const stateDir = makeFixtureDir('bluegreen-micro-rollback-up-failure-');
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

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.includes('ps') && command.includes('-a')) {
        return { stdout: 'api-blue   Up\nweb-blue   Up\n' };
      }
      if (
        command.includes('up') &&
        command.includes('--wait') &&
        command.includes('api-blue') &&
        command.includes('web-blue')
      ) {
        return new Error('service "api-blue" did not become healthy');
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['rollback', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /starting blue containers failed/);
  assert.match(outcome.stderr, /Traffic was never switched; green remains live\./);

  const reloadAttempted = calls.some((call) => call.command.includes('caddy') && call.command.includes('reload'));
  assert.equal(reloadAttempted, false, 'Caddy must never be touched when the up --wait step itself fails');

  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-1: databaseIdentity defaults to charitypilot/charitypilot and honours POSTGRES_DB/POSTGRES_USER ("" counts as unset)', async () => {
  const { databaseIdentity } = await loadDeployModule();
  assert.deepEqual(databaseIdentity({}), { databaseName: 'charitypilot', databaseUser: 'charitypilot' });
  assert.deepEqual(databaseIdentity({ POSTGRES_DB: '', POSTGRES_USER: '' }), {
    databaseName: 'charitypilot',
    databaseUser: 'charitypilot',
  });
  assert.deepEqual(
    databaseIdentity({ POSTGRES_DB: 'charitypilot_personal_server', POSTGRES_USER: 'charitypilot_personal_server' }),
    { databaseName: 'charitypilot_personal_server', databaseUser: 'charitypilot_personal_server' },
  );
});

test('P3-1: the gate psql, pg backup, and drill all use the env file database identity', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-identity-');
  const envPath = join(stateDir, 'vm.env');
  writeEnvFile(envPath, {
    POSTGRES_DB: 'charitypilot_personal_server',
    POSTGRES_USER: 'charitypilot_personal_server',
    DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server',
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const backupCtxs = [];
  const deps = {
    runCommand,
    runBackupImpl: async (ctx) => {
      backupCtxs.push(ctx);
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  };
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);
  assert.equal(outcome.status, 0, outcome.stderr);

  const psqlCalls = calls.filter((call) => call.command.includes('psql'));
  assert.ok(psqlCalls.length > 0, 'gate must query the database');
  for (const call of psqlCalls) {
    const u = call.command.indexOf('-U');
    const d = call.command.indexOf('-d');
    assert.equal(call.command[u + 1], 'charitypilot_personal_server');
    assert.equal(call.command[d + 1], 'charitypilot_personal_server');
  }
  assert.equal(backupCtxs.length, 1);
  assert.equal(backupCtxs[0].databaseName, 'charitypilot_personal_server');
  assert.equal(backupCtxs[0].databaseUser, 'charitypilot_personal_server');
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-1: with no POSTGRES_* vars the gate and backup still use charitypilot/charitypilot (default pinned)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-identity-default-');
  const envPath = join(stateDir, 'local.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const backupCtxs = [];
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async (ctx) => {
      backupCtxs.push(ctx);
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const psql = calls.find((call) => call.command.includes('psql'));
  assert.equal(psql.command[psql.command.indexOf('-U') + 1], 'charitypilot');
  assert.equal(psql.command[psql.command.indexOf('-d') + 1], 'charitypilot');
  assert.equal(backupCtxs[0].databaseName, 'charitypilot');
  assert.equal(backupCtxs[0].databaseUser, 'charitypilot');
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-1: preflightIssues rejects a DATABASE_URL whose database or user disagrees with the resolved identity', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = '/tmp/x.env';
  const base = {
    BLUEGREEN_ENV_FILE: envFilePath,
    BLUEGREEN_ORIGIN: 'http://127.0.0.1:8080',
    READINESS_API_KEY: READINESS_KEY,
    FRONTEND_URL: 'http://127.0.0.1:8080',
    // Fixture fix: FRONTEND_URL's loopback hostname is not an approved
    // charitypilot.ie hostname, so preflightIssues requires the canonical-
    // origin overrides regardless of the database-identity checks under
    // test here. BLUEGREEN_ORIGIN is itself exact loopback, so the
    // loopback-shaped values are accepted (mirrors the M1/micro-round
    // preflightIssues tests' own loopback fixtures).
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'http://127.0.0.1:8080',
    CHARITYPILOT_CANONICAL_API_ORIGIN: 'http://127.0.0.1:8080',
  };
  // Consistent, explicit identity: clean.
  assert.deepEqual(
    preflightIssues({
      fileEnv: {
        ...base,
        POSTGRES_DB: 'charitypilot_personal_server',
        POSTGRES_USER: 'charitypilot_personal_server',
        DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server',
      },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
  // Appliance-shaped URL with the POSTGRES_* vars forgotten: both mismatches named.
  const forgotten = preflightIssues({
    fileEnv: { ...base, DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(
    forgotten.includes(
      'DATABASE_URL database "charitypilot_personal_server" does not match POSTGRES_DB (resolved "charitypilot"); set POSTGRES_DB in the env file to the database the volume actually holds',
    ),
    forgotten.join('\n'),
  );
  assert.ok(
    forgotten.includes(
      'DATABASE_URL user "charitypilot_personal_server" does not match POSTGRES_USER (resolved "charitypilot"); set POSTGRES_USER in the env file to the role the volume actually holds',
    ),
    forgotten.join('\n'),
  );
  // Default identity with the default URL (today's local fixture): clean — pins that no new issue appears for existing deployments.
  assert.deepEqual(
    preflightIssues({
      fileEnv: { ...base, DATABASE_URL: 'postgresql://charitypilot:scratch-password@db:5432/charitypilot' },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
});

test('P3-1: the standalone backup subcommand passes the env file database identity to runBackup', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-identity-backup-subcommand-');
  const envPath = join(stateDir, 'vm.env');
  writeEnvFile(envPath, {
    POSTGRES_DB: 'charitypilot_personal_server',
    POSTGRES_USER: 'charitypilot_personal_server',
    DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server',
  });
  const { runCommand } = makeFakeRunCommand();
  const backupCtxs = [];
  const deps = {
    runCommand,
    runBackupImpl: async (ctx) => {
      backupCtxs.push(ctx);
      return { plan: { dir: join(stateDir, 'backups', 'x') }, manifest: {} };
    },
  };
  const outcome = await runDeploy(['backup', '--env-file', envPath, '--state-dir', stateDir], deps);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(backupCtxs.length, 1);
  assert.equal(backupCtxs[0].databaseName, 'charitypilot_personal_server');
  assert.equal(backupCtxs[0].databaseUser, 'charitypilot_personal_server');
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-1: the restore-drill subcommand passes the env file database identity to runRestoreDrill', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-identity-restore-drill-subcommand-');
  const envPath = join(stateDir, 'vm.env');
  writeEnvFile(envPath, {
    POSTGRES_DB: 'charitypilot_personal_server',
    POSTGRES_USER: 'charitypilot_personal_server',
    DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server',
  });
  // executeRestoreDrillCommand refuses with no backups found under the state
  // directory (latestBackupDir), so seed a minimal backup dir to reach ctx
  // construction — its contents are never read here since runRestoreDrillImpl
  // is faked.
  mkdirSync(join(stateDir, 'backups', '2026-08-31T00-00-00-000Z'), { recursive: true });
  const { runCommand } = makeFakeRunCommand();
  const drillCtxs = [];
  const deps = {
    runCommand,
    runRestoreDrillImpl: async (ctx) => {
      drillCtxs.push(ctx);
      return { ok: true, rowCensus: {} };
    },
  };
  const outcome = await runDeploy(['restore-drill', '--env-file', envPath, '--state-dir', stateDir], deps);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(drillCtxs.length, 1);
  assert.equal(drillCtxs[0].databaseName, 'charitypilot_personal_server');
  assert.equal(drillCtxs[0].databaseUser, 'charitypilot_personal_server');
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-2: composeFileArgs is a single -f by default and appends the override as a second -f', async () => {
  const { composeFileArgs } = await loadDeployModule();
  const defaults = composeFileArgs({});
  assert.equal(defaults.length, 2);
  assert.equal(defaults[0], '-f');
  assert.match(defaults[1], /compose\.bluegreen\.yml$/);
  assert.deepEqual(composeFileArgs({ BLUEGREEN_COMPOSE_OVERRIDE: '' }), defaults, '"" counts as unset');
  // Ruling: path.resolve(repoRoot, '/abs/private-vm.yml') is what the engine
  // actually produces on this Windows host (resolves to C:\abs\private-vm.yml,
  // portably the same on Linux) — the literal string is not what composeFileArgs
  // returns for an absolute-looking override.
  const withOverride = composeFileArgs({ BLUEGREEN_COMPOSE_OVERRIDE: '/abs/private-vm.yml' });
  assert.deepEqual(withOverride, [...defaults, '-f', resolve(repoRoot, '/abs/private-vm.yml')]);
});

test('P3-2: every docker compose call and the backup composeArgs carry the override -f when set', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-override-');
  const overridePath = join(stateDir, 'override.yml');
  writeFileSync(overridePath, 'volumes:\n  bluegreen-db:\n    external: true\n    name: x\n');
  const envPath = join(stateDir, 'vm.env');
  writeEnvFile(envPath, {
    BLUEGREEN_COMPOSE_OVERRIDE: overridePath,
    BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-personal-server-documents',
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const backupCtxs = [];
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async (ctx) => {
      backupCtxs.push(ctx);
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const composeCalls = calls.filter((call) => call.command[0] === 'docker' && call.command[1] === 'compose');
  assert.ok(composeCalls.length > 0);
  for (const call of composeCalls) {
    const flags = call.command.filter((_, i) => call.command[i - 1] === '-f');
    assert.equal(flags.length, 2, `expected two -f flags in: ${call.command.join(' ')}`);
    assert.match(flags[0], /compose\.bluegreen\.yml$/);
    assert.equal(flags[1], overridePath);
    assert.ok(call.command.indexOf('-p') > call.command.lastIndexOf('-f'), '-p must follow every -f');
  }
  assert.deepEqual(backupCtxs[0].composeArgs.filter((_, i) => backupCtxs[0].composeArgs[i - 1] === '-f')[1], overridePath);
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-2: without an override every docker compose call has exactly one -f (default pinned)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-no-override-');
  const envPath = join(stateDir, 'local.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async () => ({ backupDir: join(stateDir, 'backups', 'x') }),
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  for (const call of calls.filter((c) => c.command[0] === 'docker' && c.command[1] === 'compose')) {
    assert.equal(call.command.filter((arg) => arg === '-f').length, 1, call.command.join(' '));
  }
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-2: preflightIssues names a missing override file and requires BLUEGREEN_DOCUMENTS_VOLUME alongside an override', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = '/tmp/x.env';
  // Ruling: FRONTEND_URL's loopback hostname is not an approved
  // charitypilot.ie hostname, so preflightIssues also requires the
  // canonical-origin overrides here regardless of the override checks under
  // test — mirrors the P3-1 preflightIssues test's own base fixture, since
  // BLUEGREEN_ORIGIN is itself exact loopback (loopback-shaped values
  // accepted).
  const base = {
    BLUEGREEN_ENV_FILE: envFilePath,
    BLUEGREEN_ORIGIN: 'http://127.0.0.1:8080',
    READINESS_API_KEY: READINESS_KEY,
    FRONTEND_URL: 'http://127.0.0.1:8080',
    DATABASE_URL: 'postgresql://charitypilot:pw@db:5432/charitypilot',
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'http://127.0.0.1:8080',
    CHARITYPILOT_CANONICAL_API_ORIGIN: 'http://127.0.0.1:8080',
  };
  const missing = preflightIssues({
    fileEnv: { ...base, BLUEGREEN_COMPOSE_OVERRIDE: '/definitely/not/here.yml', BLUEGREEN_DOCUMENTS_VOLUME: 'v' },
    resolvedEnvFilePath: envFilePath,
  });
  // Same resolve() bug class as the composeFileArgs test above: the engine
  // reports the RESOLVED path (resolve(repoRoot, ...)), which on this
  // Windows host turns '/definitely/not/here.yml' into
  // 'C:\definitely\not\here.yml' — portably the same fix on Linux.
  assert.ok(
    missing.includes(`BLUEGREEN_COMPOSE_OVERRIDE file not found: ${resolve(repoRoot, '/definitely/not/here.yml')}`),
    missing.join('\n'),
  );

  const dir = makeFixtureDir('bluegreen-override-preflight-');
  const present = join(dir, 'o.yml');
  writeFileSync(present, 'volumes: {}\n');
  const noVolume = preflightIssues({
    fileEnv: { ...base, BLUEGREEN_COMPOSE_OVERRIDE: present },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(
    noVolume.includes(
      'BLUEGREEN_DOCUMENTS_VOLUME is required when BLUEGREEN_COMPOSE_OVERRIDE is set (an override exists to move the volumes; the backup must tar the one the override names)',
    ),
    noVolume.join('\n'),
  );
  assert.deepEqual(
    preflightIssues({
      fileEnv: { ...base, BLUEGREEN_COMPOSE_OVERRIDE: present, BLUEGREEN_DOCUMENTS_VOLUME: 'v' },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
  assert.deepEqual(preflightIssues({ fileEnv: base, resolvedEnvFilePath: envFilePath }), [], 'no override: no new issues');
  rmSync(dir, { recursive: true, force: true });
});

test('P3-3: a deploy brings db up (with --wait) before the backup runs and before any exec against db', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-ensure-db-');
  const envPath = join(stateDir, 'local.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  let callsAtBackup = -1;
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async () => {
      callsAtBackup = calls.length;
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const dbUpIndex = calls.findIndex(
    (call) => call.command.includes('up') && call.command.includes('--wait') && call.command.at(-1) === 'db',
  );
  assert.notEqual(dbUpIndex, -1, 'db must be brought up explicitly');
  assert.ok(dbUpIndex < callsAtBackup, 'db up must precede the backup');
  const firstExecDb = calls.findIndex((call) => call.command.includes('exec') && call.command.includes('db'));
  assert.ok(firstExecDb === -1 || dbUpIndex < firstExecDb, 'db up must precede any exec against db');
  // writeDeployStatus (scripts/bluegreen/lib.mjs:112) writes { history: [{ timestamp, phase, detail }] }
  // to <stateDir>/deploy-status.json.
  const { history } = JSON.parse(readFileSync(join(stateDir, 'deploy-status.json'), 'utf8'));
  const phases = history.map((entry) => entry.phase);
  assert.ok(phases.includes('ensure-db'), phases.join(' → '));
  assert.ok(phases.indexOf('ensure-db') < phases.indexOf('backup'), phases.join(' → '));
  rmSync(stateDir, { recursive: true, force: true });
});
