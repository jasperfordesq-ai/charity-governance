import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

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
  // VM-cutover defect 2a: the ONLY `stop` allowed on this path is the
  // engine putting back the `db` it started itself at ensure-db (asserted
  // by its own tests below). Quiesce — `stop scheduler` — must still never
  // run, and neither may a stop of anything else.
  const stopCalls = calls.filter((call) => call.command.includes('stop'));
  assert.deepEqual(
    stopCalls.map((call) => call.command.slice(call.command.indexOf('stop'))),
    [['stop', 'db']],
    'the only stop on a gate-blocked deploy is the engine stopping the db it started',
  );
  assert.equal(
    calls.some((call) => call.command.includes('stop') && call.command.includes('scheduler')),
    false,
    'quiesce (stop scheduler) must never run',
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
  // Review round 2: a custom documents volume is only legitimate when the
  // compose file(s) declare the same name — preflight now refuses a
  // disagreement (it would silently back up an auto-created empty volume),
  // so this fixture supplies the matching override the real VM has.
  const overridePath = join(stateDir, 'override.yml');
  writeFileSync(
    overridePath,
    'volumes:\n  bluegreen-documents:\n    external: true\n    name: custom-charity-documents\n',
  );
  writeEnvFile(envPath, {
    BLUEGREEN_COMPOSE_OVERRIDE: overridePath,
    BLUEGREEN_DOCUMENTS_VOLUME: 'custom-charity-documents',
  });
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

test('P3-1: the gate psql and the deploy-phase backup use the env file database identity', async () => {
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
  // Review round 2: the override must declare the SAME documents volume the
  // env file names, or preflight refuses the pair.
  writeFileSync(
    overridePath,
    'volumes:\n  bluegreen-db:\n    external: true\n    name: x\n' +
      '  bluegreen-documents:\n    external: true\n    name: charitypilot-personal-server-documents\n',
  );
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
  // Review round 2: declares the documents volume the pairing below names —
  // an override whose declared name disagreed with BLUEGREEN_DOCUMENTS_VOLUME
  // is now itself a preflight issue (tested separately).
  writeFileSync(present, 'volumes:\n  bluegreen-documents:\n    external: true\n    name: v\n');
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

test('P3-5: the committed private-VM env template, filled in, passes engine preflight with zero issues', async () => {
  const { preflightIssues, parseEnvFile } = await loadDeployModule();
  const repoRoot = dirname(scriptsDir);
  let text = readFileSync(join(repoRoot, '.env.bluegreen.private-vm.example'), 'utf8');
  const dir = makeFixtureDir('bluegreen-vm-template-');
  const envPath = join(dir, 'private-vm.env');
  const fill = {
    REPLACE_ME_TAILSCALE_HOSTNAME: 'charitypilot.tail0000.ts.net',
    REPLACE_ME_POSTGRES_DB: 'charitypilot_personal_server',
    REPLACE_ME_POSTGRES_USER: 'charitypilot_personal_server',
    REPLACE_ME_POSTGRES_PASSWORD: 'a'.repeat(64),
    REPLACE_ME_JWT_SECRET: 'j'.repeat(48),
    REPLACE_ME_AUTH_RECOVERY_SECRET: '0123456789abcdef'.repeat(4),
    REPLACE_ME_READINESS_API_KEY: 'r'.repeat(40),
    REPLACE_ME_OWNER_JWT_SECRET: 'o'.repeat(48),
    REPLACE_ME_ENV_FILE_PATH: envPath,
  };
  for (const [key, value] of Object.entries(fill)) text = text.split(key).join(value);
  assert.doesNotMatch(text, /REPLACE_ME_/);
  writeFileSync(envPath, text);
  const fileEnv = parseEnvFile(envPath);
  assert.equal(fileEnv.BLUEGREEN_COMPOSE_OVERRIDE, 'compose.bluegreen.private-vm.yml');
  assert.equal(fileEnv.BLUEGREEN_DOCUMENTS_VOLUME, 'charitypilot-personal-server-documents');
  assert.deepEqual(preflightIssues({ fileEnv, resolvedEnvFilePath: envPath }), []);
  rmSync(dir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// VM-cutover defect 2a: a failed deploy must not leave behind a `db` service
// that THIS deploy started. On the real cutover the deploy aborted at phase 2
// and left a live postmaster attached to the appliance's production PGDATA;
// restoring appliance service then started a second postmaster on the same
// data directory (they overlapped ~83s).
// -----------------------------------------------------------------------------

function dbStopCalls(calls) {
  return calls.filter(
    (call) =>
      call.command[0] === 'docker' &&
      call.command[1] === 'compose' &&
      call.command.at(-2) === 'stop' &&
      call.command.at(-1) === 'db',
  );
}

const DESTRUCTIVE_MIGRATION = [
  { name: '20260101000000_drop_something', sql: 'ALTER TABLE "Foo" DROP COLUMN "bar";' },
];

// Every failure return between ensure-db and the Caddy switch, in one place:
// each entry injects exactly one failure and must produce a stopped db plus
// the sentence that says so.
const ABORT_CASES = [
  {
    label: 'backup failure',
    expect: /pre-migration backup failed/,
    deps: () => ({
      runBackupImpl: async () => {
        throw new Error('injected backup failure');
      },
    }),
  },
  {
    label: 'migration gate block',
    migrations: DESTRUCTIVE_MIGRATION,
    expect: /migration gate blocked/,
  },
  {
    label: 'migration run failure',
    expect: /migration failed/,
    fail: (joined) => joined.includes('run --rm --no-deps migrate'),
  },
  {
    label: 'starting the target colour failure',
    expect: /starting (blue|green) containers failed/,
    fail: (joined) => joined.includes('--profile') && joined.includes(' up '),
  },
  {
    label: 'candidate smoke failure',
    expect: /candidate smoke test failed/,
    fail: (joined) => joined.includes('exec') && /api-(blue|green)/.test(joined) && joined.includes('readiness'),
  },
  {
    label: 'starting Caddy failure',
    expect: /starting Caddy failed/,
    fail: (joined) => joined.includes('up -d --wait caddy'),
  },
  {
    label: 'Caddy reload failure',
    expect: /Caddy reload failed/,
    fail: (joined) => joined.includes('caddy reload'),
  },
  {
    label: 'an unexpected error (a bare-await phase: build)',
    expect: /Blue-green deploy failed:/,
    fail: (joined) => joined.includes(' build '),
  },
];

test('defect 2a: EVERY failure between ensure-db and the switch stops the db this deploy started, and says so', async () => {
  const runDeploy = await loadDeployRunner();
  for (const abortCase of ABORT_CASES) {
    const stateDir = makeFixtureDir('bluegreen-abort-db-');
    const envPath = join(stateDir, 'bluegreen.env');
    writeEnvFile(envPath);
    seedMigrationsDir(stateDir, TARGET_COMMIT, abortCase.migrations ?? []);

    const { deps, calls } = baseDeps({
      stateDir,
      overrides: abortCase.fail
        ? (command) => (abortCase.fail(` ${command.join(' ')} `) ? new Error(`injected ${abortCase.label}`) : undefined)
        : undefined,
    });

    const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
      ...deps,
      ...(abortCase.deps ? abortCase.deps() : {}),
    });

    assert.equal(outcome.status, 1, `${abortCase.label}: expected failure`);
    assert.match(outcome.stderr, abortCase.expect, `${abortCase.label}: unexpected message`);
    assert.equal(
      dbStopCalls(calls).length,
      1,
      `${abortCase.label}: the db this deploy started must be stopped exactly once (calls: ${calls
        .map((c) => c.command.join(' '))
        .join(' | ')})`,
    );
    assert.match(
      outcome.stderr,
      /The db service this deploy started has been stopped again\./,
      `${abortCase.label}: the message must state the db was stopped again`,
    );
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('defect 2a: ensure-db asks whether db is already running BEFORE starting it', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-probe-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);
  assert.equal(outcome.status, 0, outcome.stderr);

  const probeIndex = calls.findIndex((call) => call.command.slice(-5).join(' ') === 'ps --status running -q db');
  const upIndex = calls.findIndex((call) => call.command.join(' ').includes('up -d --wait db'));
  assert.ok(
    probeIndex !== -1,
    `expected a running-state probe for db; calls: ${calls.map((c) => c.command.join(' ')).join(' | ')}`,
  );
  assert.ok(upIndex !== -1, 'expected ensure-db to start db');
  assert.ok(probeIndex < upIndex, 'the probe must run before `up -d --wait db`, or it answers the wrong question');

  rmSync(stateDir, { recursive: true, force: true });
});

test('defect 2a: a db that was ALREADY running is never stopped on an abort (a redeploy must not take the site down)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-preexisting-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, DESTRUCTIVE_MIGRATION);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      // The steady-state case: compose reports a running db container id.
      if (command.join(' ').includes('ps --status running -q db')) return { stdout: '9f3c1d2e4b5a\n' };
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /migration gate blocked/);
  assert.deepEqual(dbStopCalls(calls), [], 'a db the engine did not start must never be stopped');
  assert.doesNotMatch(outcome.stderr, /db service this deploy started/);
  assert.doesNotMatch(outcome.stderr, /could not determine whether the db service/);

  rmSync(stateDir, { recursive: true, force: true });
});

test('defect 2a: a failed abort-time db stop is reported as STILL RUNNING, never as stopped', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-stop-fails-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, DESTRUCTIVE_MIGRATION);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.join(' ').endsWith('stop db')) return new Error('injected: docker daemon refused the stop');
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.equal(dbStopCalls(calls).length, 1, 'the stop must be attempted');
  assert.match(outcome.stderr, /could NOT be stopped/);
  assert.match(outcome.stderr, /STILL RUNNING/);
  assert.match(outcome.stderr, /before starting any other stack on these volumes/);
  assert.doesNotMatch(outcome.stderr, /has been stopped again/);

  rmSync(stateDir, { recursive: true, force: true });
});

test('defect 2a: an undeterminable prior db state leaves db alone and says the state is unknown', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-unknown-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, DESTRUCTIVE_MIGRATION);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.join(' ').includes('ps --status running -q db')) return new Error('injected: compose ps unavailable');
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.deepEqual(dbStopCalls(calls), [], 'never stop a db that might have been serving before this deploy');
  assert.match(outcome.stderr, /could not determine whether the db service was already running/);
  assert.match(outcome.stderr, /check it by hand/);

  rmSync(stateDir, { recursive: true, force: true });
});

test('defect 2a: a successful cutover leaves the db running, and a post-cutover failure still does not stop it', async () => {
  const runDeploy = await loadDeployRunner();

  const cleanDir = makeFixtureDir('bluegreen-db-clean-');
  const cleanEnv = join(cleanDir, 'bluegreen.env');
  writeEnvFile(cleanEnv);
  seedMigrationsDir(cleanDir, TARGET_COMMIT, []);
  const clean = baseDeps({ stateDir: cleanDir });
  const cleanOutcome = await runDeploy(['deploy', '--env-file', cleanEnv, '--state-dir', cleanDir], clean.deps);
  assert.equal(cleanOutcome.status, 0, cleanOutcome.stderr);
  assert.deepEqual(dbStopCalls(clean.calls), [], 'a completed deploy must leave its db up');
  rmSync(cleanDir, { recursive: true, force: true });

  // Phase 12 (public smoke) and later run AFTER traffic has moved: the new
  // colour — or, on the revert path, the old one — is serving from this db.
  for (const failing of ['public smoke', 'jobs']) {
    const stateDir = makeFixtureDir('bluegreen-db-post-cutover-');
    const envPath = join(stateDir, 'bluegreen.env');
    writeEnvFile(envPath);
    seedMigrationsDir(stateDir, TARGET_COMMIT, []);
    const { deps, calls } = baseDeps({
      stateDir,
      overrides: (command) => {
        const joined = ` ${command.join(' ')} `;
        if (failing === 'public smoke' && command[0] === 'wget' && command[1] !== '--version') {
          return new Error('injected public smoke failure');
        }
        if (failing === 'jobs' && joined.includes(' up -d --wait scheduler ')) {
          return new Error('injected scheduler failure');
        }
        return undefined;
      },
    });
    const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);
    assert.equal(outcome.status, 1, `${failing}: expected failure`);
    assert.deepEqual(dbStopCalls(calls), [], `${failing}: the db must stay up once traffic has moved`);
    assert.doesNotMatch(outcome.stderr, /db service this deploy started/);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// VM-cutover defect 2b: refuse to deploy while another stack holds one of this
// deployment's volumes (two postmasters on one PGDATA is a corruption risk).
// -----------------------------------------------------------------------------

test('defect 2b: deploymentVolumeNames resolves both volume names from the compose file, the override, and the env', async () => {
  const { deploymentVolumeNames } = await loadDeployModule();

  assert.deepEqual(deploymentVolumeNames({}), {
    db: 'charitypilot-bluegreen-db',
    documents: 'charitypilot-bluegreen-documents',
  });

  // The committed private-VM override re-points both keys at the appliance's
  // external volumes — the names the real cutover collided on.
  assert.deepEqual(
    deploymentVolumeNames({
      BLUEGREEN_COMPOSE_OVERRIDE: 'compose.bluegreen.private-vm.yml',
      BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-personal-server-documents',
    }),
    { db: 'charitypilot-personal-server-db', documents: 'charitypilot-personal-server-documents' },
  );

  // BLUEGREEN_DOCUMENTS_VOLUME wins for documents, because it is the name
  // the backup itself tars.
  assert.equal(
    deploymentVolumeNames({ BLUEGREEN_DOCUMENTS_VOLUME: 'custom-charity-documents' }).documents,
    'custom-charity-documents',
  );
});

test('defect 2b: volumesInUseByOtherStacks refuses a foreign container and accepts this engine own project', async () => {
  const { volumesInUseByOtherStacks } = await loadDeployModule();
  const volumes = { db: 'charitypilot-personal-server-db', documents: 'charitypilot-personal-server-documents' };

  const seen = [];
  const foreignIssues = await volumesInUseByOtherStacks(async (command) => {
    seen.push(command);
    if (command.includes('volume=charitypilot-personal-server-db')) {
      return { stdout: 'charitypilot-personal-server-db-1\tcharitypilot-personal-server\n' };
    }
    return { stdout: '' };
  }, volumes);

  assert.equal(foreignIssues.length, 1);
  assert.equal(
    foreignIssues[0],
    'Refusing to deploy: volume charitypilot-personal-server-db is in use by container(s) charitypilot-personal-server-db-1 from another stack; stop that stack first (a second Postgres on one data directory risks corruption).',
  );
  assert.deepEqual(seen[0].slice(0, 4), ['docker', 'ps', '--filter', 'volume=charitypilot-personal-server-db']);
  assert.ok(seen[0].includes('--format'));

  // This engine's own containers on the same volumes are the deployment
  // being redeployed, not a conflict.
  const ownIssues = await volumesInUseByOtherStacks(
    async () => ({
      stdout:
        'charitypilot-bluegreen-db-1\tcharitypilot-bluegreen\ncharitypilot-bluegreen-api-blue-1\tcharitypilot-bluegreen\n',
    }),
    volumes,
  );
  assert.deepEqual(ownIssues, []);

  // A container with no compose project at all counts as another stack.
  const bareIssues = await volumesInUseByOtherStacks(
    async (command) =>
      command.includes('volume=charitypilot-personal-server-documents')
        ? { stdout: 'some-hand-run-container\t\n' }
        : { stdout: '' },
    volumes,
  );
  assert.equal(bareIssues.length, 1);
  assert.match(
    bareIssues[0],
    /charitypilot-personal-server-documents is in use by container\(s\) some-hand-run-container/,
  );

  // And an unanswerable question is a refusal, never an assumed "clear".
  const blindIssues = await volumesInUseByOtherStacks(async () => {
    throw new Error('docker ps exploded');
  }, volumes);
  assert.equal(blindIssues.length, 2);
  assert.match(blindIssues[0], /Could not determine whether volume .* is already in use/);
});

test('defect 2b: a deploy refuses at preflight when another stack already holds a deployment volume', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-volume-conflict-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command[0] === 'docker' && command[1] === 'ps' && command.includes('volume=charitypilot-bluegreen-db')) {
        return { stdout: 'charitypilot-personal-server-db-1\tcharitypilot-personal-server\n' };
      }
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Blue-green deploy preflight failed:/);
  assert.match(
    outcome.stderr,
    /volume charitypilot-bluegreen-db is in use by container\(s\) charitypilot-personal-server-db-1 from another stack/,
  );
  assert.match(outcome.stderr, /a second Postgres on one data directory risks corruption/);
  // Nothing may have been touched: no compose command at all, so no db was
  // started on volumes another stack is already using.
  assert.deepEqual(
    calls.filter((call) => call.command[0] === 'docker' && call.command[1] === 'compose'),
    [],
    'no compose command may run once the volume check refuses',
  );
  assert.deepEqual(
    calls.filter((call) => call.command[0] === 'git' && call.command[1] !== '--version'),
    [],
    'the refusal must land before any real git work (only the host-binary probe may have run)',
  );

  rmSync(stateDir, { recursive: true, force: true });
});

test('defect 2b: the volume check runs only after the pure env checks pass', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-volume-check-order-');
  const envPath = join(stateDir, 'bluegreen.env');
  // A known-bad env file: no docker command at all may run, not even the
  // volume probe (the engine's standing "nothing runs while a bad env file
  // would refuse anyway" invariant).
  writeEnvFile(envPath, { READINESS_API_KEY: '' });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /READINESS_API_KEY is required/);
  assert.deepEqual(calls, [], 'no command whatsoever may run when the pure env checks already refuse');

  rmSync(stateDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Review round 2: BLUEGREEN_DOCUMENTS_VOLUME must name the same volume the
// compose file(s) declare. A mismatch does not fail loudly — docker
// auto-creates the missing named volume (root:root 0755), the tar exits 0 with
// an empty tree, and the manifest and the restore drill then agree on zero
// documents. Silent data loss dressed as a passing drill.
// -----------------------------------------------------------------------------

const PREFLIGHT_BASE = {
  BLUEGREEN_ORIGIN: 'http://127.0.0.1:8080',
  READINESS_API_KEY: READINESS_KEY,
  FRONTEND_URL: 'http://127.0.0.1:8080',
  DATABASE_URL: 'postgresql://charitypilot:pw@db:5432/charitypilot',
  CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'http://127.0.0.1:8080',
  CHARITYPILOT_CANONICAL_API_ORIGIN: 'http://127.0.0.1:8080',
};

test('round 2: preflight refuses a BLUEGREEN_DOCUMENTS_VOLUME that disagrees with the compose-declared documents volume', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = '/tmp/round2.env';
  const base = { ...PREFLIGHT_BASE, BLUEGREEN_ENV_FILE: envFilePath };

  // Disagreeing, with the real committed private-VM override: the override
  // declares charitypilot-personal-server-documents, the env names a typo.
  const mismatch = preflightIssues({
    fileEnv: {
      ...base,
      BLUEGREEN_COMPOSE_OVERRIDE: 'compose.bluegreen.private-vm.yml',
      BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-personal-server-document',
    },
    resolvedEnvFilePath: envFilePath,
  });
  assert.equal(mismatch.length, 1, mismatch.join(' | '));
  assert.match(mismatch[0], /BLUEGREEN_DOCUMENTS_VOLUME is "charitypilot-personal-server-document"/);
  assert.match(mismatch[0], /declare the documents volume as "charitypilot-personal-server-documents"/);
  assert.match(mismatch[0], /silently EMPTY documents backup/);

  // A typo with NO override at all is the same bug against the base file.
  const noOverrideMismatch = preflightIssues({
    fileEnv: { ...base, BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-bluegreen-document' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.equal(noOverrideMismatch.length, 1, noOverrideMismatch.join(' | '));
  assert.match(noOverrideMismatch[0], /declare the documents volume as "charitypilot-bluegreen-documents"/);

  // Agreeing (the committed template's own pairing): no issue at all.
  assert.deepEqual(
    preflightIssues({
      fileEnv: {
        ...base,
        BLUEGREEN_COMPOSE_OVERRIDE: 'compose.bluegreen.private-vm.yml',
        BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-personal-server-documents',
      },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
  // Agreeing with the base compose file, and unset (the hosted default), both clean.
  assert.deepEqual(
    preflightIssues({
      fileEnv: { ...base, BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-bluegreen-documents' },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
  assert.deepEqual(preflightIssues({ fileEnv: base, resolvedEnvFilePath: envFilePath }), []);

  // An unresolvable override reports only the missing file — the compose-
  // declared name would be the base file's, so a second, misleading mismatch
  // issue must not pile on.
  const missingOverride = preflightIssues({
    fileEnv: {
      ...base,
      BLUEGREEN_COMPOSE_OVERRIDE: '/definitely/not/here.yml',
      BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-personal-server-documents',
    },
    resolvedEnvFilePath: envFilePath,
  });
  assert.equal(missingOverride.length, 1, missingOverride.join(' | '));
  assert.match(missingOverride[0], /BLUEGREEN_COMPOSE_OVERRIDE file not found/);
});

test('round 2: composeDeclaredVolumeNames reports what compose mounts, ignoring the env preference', async () => {
  const { composeDeclaredVolumeNames, deploymentVolumeNames } = await loadDeployModule();

  // The env var must NOT leak into the compose-declared view — that is the
  // whole basis of the comparison above.
  assert.deepEqual(composeDeclaredVolumeNames({ BLUEGREEN_DOCUMENTS_VOLUME: 'anything-else' }), {
    db: 'charitypilot-bluegreen-db',
    documents: 'charitypilot-bluegreen-documents',
  });
  assert.equal(deploymentVolumeNames({ BLUEGREEN_DOCUMENTS_VOLUME: 'anything-else' }).documents, 'anything-else');
});

test('round 2: a deploy refuses at preflight on a documents-volume disagreement, before any command runs', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-volume-name-mismatch-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath, { BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-bluegreen-documnets' });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { deps, calls } = baseDeps({ stateDir });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /Blue-green deploy preflight failed:/);
  assert.match(outcome.stderr, /BLUEGREEN_DOCUMENTS_VOLUME is "charitypilot-bluegreen-documnets"/);
  assert.deepEqual(calls, [], 'a pure env-file refusal must run no command at all');

  rmSync(stateDir, { recursive: true, force: true });
});

test('round 2: ensure-db up failure does not claim a container was stopped again', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-ensure-db-up-fails-');
  const envPath = join(stateDir, 'bluegreen.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);

  const { deps, calls } = baseDeps({
    stateDir,
    overrides: (command) => {
      if (command.join(' ').includes('up -d --wait db')) return new Error('injected: db never became healthy');
      return undefined;
    },
  });

  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /could not start the db service/);
  // The stop is still issued — `up --wait` can fail with the container left
  // running — but the message must not overclaim that one existed.
  assert.equal(dbStopCalls(calls).length, 1);
  assert.match(outcome.stderr, /nothing this deploy started is left running on these volumes/);
  assert.doesNotMatch(outcome.stderr, /has been stopped again/);

  rmSync(stateDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// VM-cutover defect 3: spawnSync output buffering
//
// These drive defaultRunCommand's REAL implementation (never an injected
// fake) because the defect WAS the real implementation's buffering posture.
// A live cutover died in phase 2 on an 8.4 MB documents tar: spawnSync's
// default 1 MiB maxBuffer killed the child, returned status:null with
// error.code ENOBUFS, and the engine reported "failed with exit code unknown"
// with no stderr. The P2 acceptance never caught it because its seeded
// document set was a few KB, so size is exactly what is asserted here.
//
// Payloads are deterministic, non-repeating, and BYTE-EXACT-checked rather
// than merely counted: the real artifacts are `pg_dump -Fc` and a tar, so a
// stdio path that translated CRLF or decoded bytes as text would corrupt
// them silently while the size still matched. The emitter is a generated
// .cjs script (unambiguously CommonJS regardless of the repo's module type)
// run by process.execPath — portable across this Windows host and the Linux
// VM, and no /dev/urandom or `head -c`.
// -----------------------------------------------------------------------------

const OVER_SPAWN_BUFFER_BYTES = 3 * 1024 * 1024; // comfortably over Node's 1 MiB default

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Non-repeating over the whole 3 MiB (a 32-bit LCG has period 2^32) and
// seeded with CR, LF, CRLF, NUL and 0xff at regular offsets — precisely the
// bytes a line-ending-translating or text-decoding path mangles.
function deterministicBinaryPayload(byteCount) {
  const buffer = Buffer.alloc(byteCount);
  let state = 0x2545f491;
  for (let i = 0; i < byteCount; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer[i] = (state >>> 16) & 0xff;
  }
  for (let i = 0; i + 5 < byteCount; i += 4096) {
    buffer[i] = 0x0d;
    buffer[i + 1] = 0x0a;
    buffer[i + 2] = 0x00;
    buffer[i + 3] = 0xff;
    buffer[i + 4] = 0x0d;
    buffer[i + 5] = 0x0d;
  }
  return buffer;
}

// The capture path returns a utf8 STRING, so its payload has to be
// byte-exact under utf8 — ASCII, but still non-repeating and still full of
// CR/LF (this is what the sha256 hash listing actually looks like).
function deterministicTextPayload(byteCount) {
  let text = '';
  for (let n = 0; text.length < byteCount; n += 1) {
    text += `${n} ${(Math.imul(n, 2654435761) >>> 0).toString(36)}\r\n`;
  }
  return text.slice(0, byteCount);
}

// A generated .cjs emitter, so `require` is available whatever the repo's
// package type is, and the payload reaches stdout as raw bytes.
function payloadEmitterCommand(dir, payload) {
  const emitterPath = join(dir, 'emit-payload.cjs');
  const payloadPath = join(dir, 'payload.bin');
  writeFileSync(emitterPath, "process.stdout.write(require('node:fs').readFileSync(process.argv[2]));\n");
  writeFileSync(payloadPath, payload);
  return [process.execPath, emitterPath, payloadPath];
}

test('runCommand: stdout far larger than the 1 MiB spawn buffer streams to the output file whole', async () => {
  const module = await loadDeployModule();
  assert.equal(typeof module.defaultRunCommand, 'function', 'defaultRunCommand must be exported for this test');
  const dir = makeFixtureDir('bluegreen-runcommand-outputfile-');
  const outputFile = join(dir, 'artifact.bin');
  const payload = deterministicBinaryPayload(OVER_SPAWN_BUFFER_BYTES);

  const result = await module.defaultRunCommand(payloadEmitterCommand(dir, payload), { cwd: dir, outputFile });

  // Contract preserved: the outputFile case still resolves { stdout: '' }.
  assert.equal(result.stdout, '');
  const written = readFileSync(outputFile);
  assert.equal(
    written.length,
    OVER_SPAWN_BUFFER_BYTES,
    'every byte of the child stdout must reach the file — no 1 MiB truncation, no ENOBUFS kill',
  );
  assert.equal(
    sha256Hex(written),
    sha256Hex(payload),
    'the artifact must be byte-identical: a pg_dump -Fc or tar survives no CRLF translation and no text decoding',
  );
  assert.equal(Buffer.compare(written, payload), 0, 'byte-for-byte comparison must match');
  assert.equal(existsSync(`${outputFile}.partial`), false, 'the streaming temp file must not survive a success');

  rmSync(dir, { recursive: true, force: true });
});

test('runCommand: captured stdout far larger than the 1 MiB spawn buffer comes back intact', async () => {
  const module = await loadDeployModule();
  const dir = makeFixtureDir('bluegreen-runcommand-capture-');
  const text = deterministicTextPayload(OVER_SPAWN_BUFFER_BYTES);

  const result = await module.defaultRunCommand(payloadEmitterCommand(dir, Buffer.from(text, 'utf8')), { cwd: dir });

  assert.equal(
    result.stdout.length,
    OVER_SPAWN_BUFFER_BYTES,
    'the sha256 hash listing and docker compose config output both exceed 1 MiB on a real charity; capture must not truncate',
  );
  assert.equal(
    sha256Hex(Buffer.from(result.stdout, 'utf8')),
    sha256Hex(Buffer.from(text, 'utf8')),
    'captured stdout must be byte-identical, CRLF included',
  );

  rmSync(dir, { recursive: true, force: true });
});

test('runCommand: a spawn-level failure names its error code instead of "exit code unknown"', async () => {
  const module = await loadDeployModule();
  const dir = makeFixtureDir('bluegreen-runcommand-spawn-error-');

  await assert.rejects(
    () => module.defaultRunCommand(['charitypilot-no-such-binary-a7f3', '--version'], { cwd: dir }),
    (error) => {
      assert.match(error.message, /ENOENT/, 'the spawn-level error code must appear in the message');
      assert.match(error.message, /charitypilot-no-such-binary-a7f3/, 'the failing command must be named');
      assert.doesNotMatch(
        error.message,
        /exit code unknown/,
        'the misleading "exit code unknown" wording is what cost two production outages',
      );
      return true;
    },
  );

  rmSync(dir, { recursive: true, force: true });
});

// Round-1 review, Important 3: ENOENT above exercises exactly one branch of
// commandFailureMessage. The signal-only and "nothing reported" branches
// cannot be provoked from a real child on demand, so the shapes are
// table-tested directly against the exported builder — which is what the
// graceful-degradation ledger row actually claims.
test('runCommand: commandFailureMessage names every spawnSync failure shape, never "exit code unknown"', async () => {
  const module = await loadDeployModule();
  assert.equal(typeof module.commandFailureMessage, 'function', 'commandFailureMessage must be exported');
  const command = ['docker', 'run', '--rm', 'image', 'tar', '-cf', '-'];

  const cases = [
    {
      label: 'non-zero exit',
      spawnResult: { status: 2, signal: null },
      stderr: 'tar: /documents: Cannot open',
      expect: [/failed with exit code 2/, /tar: \/documents: Cannot open/],
    },
    {
      label: 'non-zero exit killed by a signal',
      spawnResult: { status: 137, signal: 'SIGKILL' },
      stderr: '',
      expect: [/failed with exit code 137/, /killed by signal SIGKILL/],
    },
    {
      label: 'ENOBUFS — the defect that cost the cutover',
      spawnResult: { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync docker ENOBUFS'), { code: 'ENOBUFS' }) },
      stderr: '',
      expect: [/failed: ENOBUFS: spawnSync docker ENOBUFS/, /killed by signal SIGTERM/],
    },
    {
      label: 'ENOENT',
      spawnResult: { status: null, signal: null, error: Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' }) },
      stderr: '',
      expect: [/failed: ENOENT: spawnSync docker ENOENT/],
    },
    {
      label: 'EACCES',
      spawnResult: { status: null, signal: null, error: Object.assign(new Error('spawnSync docker EACCES'), { code: 'EACCES' }) },
      stderr: '',
      expect: [/failed: EACCES: spawnSync docker EACCES/],
    },
    {
      label: 'signal kill with no error object',
      spawnResult: { status: null, signal: 'SIGKILL' },
      stderr: '',
      expect: [/failed: killed by signal SIGKILL/],
    },
    {
      label: 'null status with no signal and no error',
      spawnResult: { status: null, signal: null },
      stderr: '',
      expect: [/failed: no exit code, no signal and no spawn error were reported/],
    },
    {
      label: 'a spawn error carrying no code',
      spawnResult: { status: null, signal: null, error: new Error('something went wrong') },
      stderr: '',
      expect: [/failed: something went wrong/],
    },
  ];

  for (const testCase of cases) {
    const message = module.commandFailureMessage(command, testCase.spawnResult, testCase.stderr);
    for (const pattern of testCase.expect) {
      assert.match(message, pattern, `${testCase.label}: message must match ${pattern}`);
    }
    assert.match(message, /^docker run --rm image tar -cf -/, `${testCase.label}: the command must be named first`);
    assert.doesNotMatch(message, /exit code unknown/, `${testCase.label}: must never say "exit code unknown"`);
    assert.doesNotMatch(message, /undefined|\[object Object\]/, `${testCase.label}: must not leak undefined`);
  }
});

// Round-1 review, Important 1: spawnSync can THROW instead of returning a
// result, in which case there is no spawnResult to read. That used to raise
// a bare TypeError from the outputFile path, naming no command.
test('runCommand: a spawnSync that throws instead of returning still names the command', async () => {
  const module = await loadDeployModule();
  const dir = makeFixtureDir('bluegreen-runcommand-spawn-throws-');
  const outputFile = join(dir, 'artifact.bin');

  for (const options of [{ cwd: dir }, { cwd: dir, outputFile }]) {
    await assert.rejects(
      // A non-string argv[0] makes spawnSync itself throw ERR_INVALID_ARG_TYPE
      // rather than return { status: null, error }.
      () => module.defaultRunCommand([42, '--version'], options),
      (error) => {
        assert.equal(error.name, 'Error', 'a raw TypeError must not escape');
        assert.match(error.message, /^42 --version failed:/, 'the command must be named');
        assert.match(error.message, /ERR_INVALID_ARG_TYPE/, 'the spawn-level error code must appear');
        assert.doesNotMatch(error.message, /exit code unknown/);
        return true;
      },
    );
  }

  assert.equal(existsSync(outputFile), false, 'a spawn that never started must leave no artifact');
  assert.equal(existsSync(`${outputFile}.partial`), false, 'nor a partial');

  rmSync(dir, { recursive: true, force: true });
});

test('runCommand: a failed outputFile command leaves no artifact behind for the manifest to hash', async () => {
  const module = await loadDeployModule();
  const dir = makeFixtureDir('bluegreen-runcommand-outputfile-fail-');
  const outputFile = join(dir, 'artifact.bin');

  await assert.rejects(
    () =>
      module.defaultRunCommand(
        [process.execPath, '-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.stderr.write('injected failure'); process.exit(3)"],
        { cwd: dir, outputFile },
      ),
    (error) => {
      assert.match(error.message, /exit code 3/);
      assert.match(error.message, /injected failure/, 'stderr must still be piped so failures explain themselves');
      return true;
    },
  );

  assert.equal(existsSync(outputFile), false, 'a half-written dump/tar must never be left where sha256File would hash it');
  assert.equal(existsSync(`${outputFile}.partial`), false, 'the streaming temp file must be cleaned up on failure');

  rmSync(dir, { recursive: true, force: true });
});

// Round-1 review, Important 2: a command can exit 0 having written nothing.
// Neither real caller can legitimately do that (pg_dump -Fc always emits a
// header; tar always emits a member plus its zero-block trailer), and
// publishing an empty artifact would let runBackup hash and manifest it —
// self-consistent, and so vacuously passing a restore drill — until a real
// restore was needed.
test('runCommand: an outputFile command that exits 0 writing nothing is refused, not published', async () => {
  const module = await loadDeployModule();
  const dir = makeFixtureDir('bluegreen-runcommand-empty-artifact-');
  const outputFile = join(dir, 'artifact.bin');

  await assert.rejects(
    () => module.defaultRunCommand([process.execPath, '-e', 'process.exit(0)'], { cwd: dir, outputFile }),
    (error) => {
      assert.match(error.message, /ZERO bytes/, 'the refusal must say the artifact was empty');
      assert.match(error.message, /artifact\.bin/, 'the refusal must name the artifact path');
      assert.match(error.message, /node/i, 'the refusal must name the command');
      return true;
    },
  );

  assert.equal(existsSync(outputFile), false, 'an empty artifact must never be published where the manifest would hash it');
  assert.equal(existsSync(`${outputFile}.partial`), false, 'the empty partial must be removed too');

  rmSync(dir, { recursive: true, force: true });
});

// Round-1 review, Important 1: cleanup used to sit inside the non-zero-exit
// branch only, so a failing fsync/rename left the `.partial` behind and the
// error named no command. ENOSPC on fsync is not injectable from a test, but
// the rename branch is: renaming onto an existing non-empty directory fails
// on every platform, and it shares the single cleanup catch with fsync.
test('runCommand: a publish that cannot complete names the command, the size, and leaves no partial', async () => {
  const module = await loadDeployModule();
  const dir = makeFixtureDir('bluegreen-runcommand-publish-fails-');
  const outputFile = join(dir, 'artifact.bin');
  mkdirSync(outputFile, { recursive: true });
  writeFileSync(join(outputFile, 'occupied.txt'), 'the rename target is not a file');

  await assert.rejects(
    () => module.defaultRunCommand([process.execPath, '-e', "process.stdout.write('x'.repeat(4096))"], { cwd: dir, outputFile }),
    (error) => {
      assert.match(error.message, /^"?.*node.*"? -e/i, 'the command must be named');
      assert.match(error.message, /produced 4096 bytes that could not be published/, 'the message must say what could not be published');
      assert.match(error.message, /artifact\.bin/, 'and where');
      assert.doesNotMatch(error.message, /exit code unknown/);
      return true;
    },
  );

  assert.equal(existsSync(`${outputFile}.partial`), false, 'a failed publish must not leave the streaming temp file behind');

  rmSync(dir, { recursive: true, force: true });
});
