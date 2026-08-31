// =============================================================================
// Blue-green deploy orchestrator (Task 8)
// =============================================================================
//
// Drives the 15-phase blue-green cutover over the primitives Tasks 4-7 built:
// compose.bluegreen.yml (Task 4), scripts/bluegreen/lib.mjs (Task 5),
// scripts/bluegreen/migration-gate.mjs (Task 6), scripts/bluegreen/backup.mjs
// (Task 7). This module owns the ONE place that constructs the compose
// prefix and the backup/restore-drill ctx shape, so every invocation across
// the engine agrees on `-f compose.bluegreen.yml -p charitypilot-bluegreen`.
//
// The whole entry point is `async` (unlike production-compose-deploy.mjs's
// synchronous harness) because Task 7's `runBackup`/`runRestoreDrill` are
// genuine `async function`s — their ctx.runCommand contract requires
// `await`-compatibility. Every phase here `await`s a single injected
// `runCommand`, so a test's fake can still be a plain synchronous function
// (awaiting a non-Promise resolves immediately) — the injected-runner shape
// tests use mirrors production-compose-deploy.test.mjs's harness exactly,
// only the call site adds `await`.
//
// -----------------------------------------------------------------------------
// Design decisions not fully pinned by the brief (flagged for the reviewer)
// -----------------------------------------------------------------------------
// 1. `--project-directory <release worktree>` is used ONLY for the `build`
//    phase (the brief's own phase-5 line puts "(--project-directory)"
//    directly after "builds run FROM the release worktree"). Every other
//    compose invocation omits --project-directory, so it defaults to the
//    directory containing `-f compose.bluegreen.yml` (repoRoot). This is
//    deliberate: `caddy/active-upstreams.caddy` is a gitignored, hand-edited-
//    by-the-engine file that must persist across deploys (each deploy gets a
//    FRESH release worktree via `git worktree add`, which only contains
//    tracked files) — if every phase used the release worktree as
//    project-directory, the live upstream file would not exist there and
//    `switch`'s "back up the existing file" step would have nothing to back
//    up on every redeploy.
// 2. `BLUEGREEN_ACTIVE_TAG` is set to the TARGET commit for the whole deploy
//    (not narrowly for phases 7-8/13 only). This is safe because phase 9's
//    `up` names `api-<target>`/`web-<target>` explicitly rather than relying
//    on bare `--profile <target> up`, so the always-in-scope `scheduler`
//    singleton is never implicitly recreated before cutover even though its
//    image tag config value has already flipped to the target commit.
//    `scheduler` is only actually brought up on the target tag at phase 13
//    ("jobs"), after cutover — matching compose.bluegreen.yml's own header
//    comment ("restarts them on it after migration and cutover").
// 3. "stop scheduler/job singletons" (phase 7) / "start scheduler/jobs on
//    the target tag" (phase 13) are read as covering the one long-running
//    singleton, `scheduler`. The other three singletons
//    (deadline-reminders/document-storage-cleanup/auth-recovery-secret-
//    rotation) are one-shot (`restart: "no"`) and are understood to be
//    triggered on their own external schedule (cron on the VM, out of this
//    engine's scope), not re-run on every deploy.
// 4. The engine ensures `caddy/active-upstreams.caddy` exists (seeding it
//    with the target colour's upstreams if absent) before the first time it
//    could bring Caddy up — otherwise Docker would silently bind-mount an
//    empty directory over the missing file on a brand new install.
// 5. Web candidate/public smoke hits `/login` (the same path
//    compose.bluegreen.yml's own healthcheck already proves returns 200
//    without a redirect), not a bare `/`.
// 6. The cutover lock is acquired/released uniformly for all five
//    subcommands (deploy/rollback/status/backup/restore-drill), reusing
//    scripts/production-cutover-lock.mjs rather than a second lock module.
// =============================================================================

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';
import {
  acquireProductionCutoverLock,
  releaseProductionCutoverLock,
} from './production-cutover-lock.mjs';
import { isApprovedCharityPilotHostname } from './production-hostnames.mjs';
import {
  otherColor,
  readState,
  writeState,
  renderUpstreams,
  releaseDirFor,
  prunePlan,
  deployStatus,
  writeDeployStatus,
} from './bluegreen/lib.mjs';
import { pendingMigrations, gateMigrations } from './bluegreen/migration-gate.mjs';
import { runBackup, runRestoreDrill, retentionPlan } from './bluegreen/backup.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const COMPOSE_FILE = join(repoRoot, 'compose.bluegreen.yml');
const PROJECT_NAME = 'charitypilot-bluegreen';
const ACTIVE_UPSTREAMS_PATH = join(repoRoot, 'caddy', 'active-upstreams.caddy');
const MIGRATIONS_RELATIVE = ['apps', 'api', 'prisma', 'migrations'];
const READINESS_HEADER = 'x-charitypilot-readiness-key';
const READINESS_PATH = '/api/v1/health/readiness';
const WEB_HEALTH_PATH = '/login';
const UNBUILT_TAG = 'unbuilt';
const DEFAULT_DATABASE_NAME = 'charitypilot';
const DEFAULT_DATABASE_USER = 'charitypilot';
const DEFAULT_KEEP_RELEASES = 3;
const DEFAULT_BACKUP_RETENTION_DAYS = 14;
const DUMP_ARTIFACT_NAME = 'database.dump';
const DOCUMENTS_ARTIFACT_NAME = 'documents.tar';
const MANIFEST_ARTIFACT_NAME = 'manifest.json';
const APPLIED_MIGRATIONS_SQL =
  'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL';

function usage() {
  return [
    'Usage: node scripts/bluegreen-deploy.mjs <deploy|rollback|status|backup|restore-drill>',
    '         --env-file <path> [--state-dir <path>] [--detach]',
    '         [--allow-destructive-migration] [--skip-backup]',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function redact(value) {
  return redactProductionDeployTranscript(value instanceof Error ? value.message : String(value));
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function commandLine(command) {
  return command.map(shellQuote).join(' ');
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const COMMANDS = new Set(['deploy', 'rollback', 'status', 'backup', 'restore-drill']);

function parseArgs(argv) {
  if (argv.length === 0 || !COMMANDS.has(argv[0])) {
    throw new Error(`a command is required: one of ${[...COMMANDS].join(', ')}`);
  }

  const options = {
    command: argv[0],
    envFile: null,
    stateDir: join(repoRoot, '.bluegreen', 'state'),
    detach: false,
    allowDestructiveMigration: false,
    skipBackup: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--detach') {
      options.detach = true;
      continue;
    }
    if (arg === '--allow-destructive-migration') {
      options.allowDestructiveMigration = true;
      continue;
    }
    if (arg === '--skip-backup') {
      options.skipBackup = true;
      continue;
    }
    if (arg === '--env-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--env-file requires a value');
      options.envFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--env-file=')) {
      const value = arg.slice('--env-file='.length);
      if (!value) throw new Error('--env-file requires a value');
      options.envFile = value;
      continue;
    }
    if (arg === '--state-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--state-dir requires a value');
      options.stateDir = resolve(repoRoot, value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--state-dir=')) {
      const value = arg.slice('--state-dir='.length);
      if (!value) throw new Error('--state-dir requires a value');
      options.stateDir = resolve(repoRoot, value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.envFile) {
    throw new Error('--env-file is required');
  }

  return options;
}

// ---------------------------------------------------------------------------
// Env file parsing (the deployment's single env file: app runtime config
// consumed by every container via `env_file:`, PLUS the handful of
// orchestration-level BLUEGREEN_* vars this script itself reads).
// ---------------------------------------------------------------------------

export function parseEnvFile(path) {
  if (!existsSync(path)) {
    throw new Error(`env file not found: ${path}`);
  }
  const values = {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Deploy-critical preflight validation over the parsed env file. Pure —
 * takes the already-resolved env file path and its parsed contents.
 */
export function preflightIssues({ fileEnv, resolvedEnvFilePath }) {
  const issues = [];

  const databaseHost = hostnameOf(fileEnv.DATABASE_URL ?? '');
  if (databaseHost !== 'db') {
    issues.push(
      'DATABASE_URL must point at the compose db service (hostname "db") — got ' +
        JSON.stringify(fileEnv.DATABASE_URL ?? ''),
    );
  }

  const declaredEnvFile = fileEnv.BLUEGREEN_ENV_FILE ?? '';
  if (!declaredEnvFile || resolve(declaredEnvFile) !== resolve(resolvedEnvFilePath)) {
    issues.push(
      `BLUEGREEN_ENV_FILE must equal this env file's own path (${resolvedEnvFilePath}); found ${JSON.stringify(declaredEnvFile)}`,
    );
  }

  const frontendHost = hostnameOf(fileEnv.FRONTEND_URL ?? '');
  if (frontendHost && !isApprovedCharityPilotHostname(frontendHost)) {
    if (!fileEnv.CHARITYPILOT_CANONICAL_WEB_ORIGIN) {
      issues.push(
        'CHARITYPILOT_CANONICAL_WEB_ORIGIN is required when FRONTEND_URL is not a charitypilot.ie hostname',
      );
    }
    if (!fileEnv.CHARITYPILOT_CANONICAL_API_ORIGIN) {
      issues.push(
        'CHARITYPILOT_CANONICAL_API_ORIGIN is required when FRONTEND_URL is not a charitypilot.ie hostname',
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Compose command builders
// ---------------------------------------------------------------------------

function composePrefix({ projectDirectory } = {}) {
  const prefix = ['docker', 'compose', '-f', COMPOSE_FILE, '-p', PROJECT_NAME];
  if (projectDirectory) prefix.push('--project-directory', projectDirectory);
  return prefix;
}

function baseComposeEnv({ processEnv, resolvedEnvFilePath, fileEnv, blueTag, greenTag, activeTag }) {
  return {
    ...processEnv,
    BLUEGREEN_ENV_FILE: resolvedEnvFilePath,
    BLUEGREEN_BLUE_TAG: blueTag,
    BLUEGREEN_GREEN_TAG: greenTag,
    BLUEGREEN_ACTIVE_TAG: activeTag,
    BLUEGREEN_ORIGIN: fileEnv.BLUEGREEN_ORIGIN ?? '',
    BLUEGREEN_FRONT_PORT: fileEnv.BLUEGREEN_FRONT_PORT ?? '8080',
  };
}

function readinessKey(fileEnv) {
  return fileEnv.READINESS_API_KEY ?? '';
}

function frontPort(fileEnv) {
  return fileEnv.BLUEGREEN_FRONT_PORT ?? '8080';
}

// ---------------------------------------------------------------------------
// Default (real) dependency implementations
// ---------------------------------------------------------------------------

async function defaultRunCommand(command, options = {}) {
  const { env, cwd = repoRoot, outputFile } = options;
  const spawnResult = spawnSync(command[0], command.slice(1), {
    cwd,
    env: env ?? process.env,
    encoding: outputFile ? undefined : 'utf8',
  });
  if (spawnResult.status !== 0) {
    const stderrText = outputFile
      ? spawnResult.stderr
        ? spawnResult.stderr.toString('utf8')
        : ''
      : spawnResult.stderr ?? '';
    throw new Error(
      `${commandLine(command)} failed with exit code ${spawnResult.status ?? 'unknown'}${
        stderrText ? `: ${stderrText.slice(0, 2000)}` : ''
      }`,
    );
  }
  if (outputFile) {
    writeFileSync(outputFile, spawnResult.stdout);
    return { stdout: '' };
  }
  return { stdout: spawnResult.stdout ?? '', stderr: spawnResult.stderr ?? '' };
}

function defaultSpawnDetached(command, options) {
  return spawn(command[0], command.slice(1), options);
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function parsePsqlList(stdout) {
  return (stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readMigrationBatch(migrationsDir, names) {
  return names.map((name) => {
    let sql;
    try {
      sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
    } catch {
      sql = null;
    }
    return { name, sql };
  });
}

function ensureActiveUpstreamsFileExists(path, target) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderUpstreams(target));
  }
}

function collectReleases(stateDir) {
  const releasesDir = join(stateDir, 'releases');
  if (!existsSync(releasesDir)) return [];
  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = join(releasesDir, entry.name);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { commit: entry.name, mtime };
    });
}

function pruneBackups(stateDir, referenceDate) {
  const backupsDir = join(stateDir, 'backups');
  if (!existsSync(backupsDir)) return;
  const entries = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      let mtime = 0;
      try {
        mtime = statSync(join(backupsDir, entry.name)).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name: entry.name, mtime };
    });
  const doomed = retentionPlan(entries, DEFAULT_BACKUP_RETENTION_DAYS, referenceDate);
  for (const name of doomed) {
    try {
      rmSync(join(backupsDir, name), { recursive: true, force: true });
    } catch {
      // Best-effort retention pruning; never abort a completed deploy over it.
    }
  }
}

function latestBackupDir(stateDir) {
  const backupsDir = join(stateDir, 'backups');
  if (!existsSync(backupsDir)) return null;
  const names = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) return null;
  return join(backupsDir, names.at(-1));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runBluegreenDeployFromArgs(
  args = process.argv.slice(2),
  {
    processEnv = process.env,
    runCommand = defaultRunCommand,
    runBackupImpl = runBackup,
    runRestoreDrillImpl = runRestoreDrill,
    now = () => new Date(),
    acquireCutoverLock = acquireProductionCutoverLock,
    releaseCutoverLock = releaseProductionCutoverLock,
    spawnDetached = defaultSpawnDetached,
    activeUpstreamsPath = ACTIVE_UPSTREAMS_PATH,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const resolvedEnvFilePath = resolve(repoRoot, options.envFile);
  const resolvedStateDir = options.stateDir;

  let fileEnv;
  try {
    fileEnv = parseEnvFile(resolvedEnvFilePath);
  } catch (error) {
    return result(1, '', `Blue-green ${options.command} failed: ${redact(error)}\n`);
  }

  if (options.skipBackup && (fileEnv.NODE_ENV ?? '').trim() === 'production') {
    return result(
      1,
      '',
      '--skip-backup is refused: the deployment env file declares NODE_ENV=production. Backups are mandatory for a production blue-green deployment.\n',
    );
  }

  if (options.detach) {
    try {
      mkdirSync(resolvedStateDir, { recursive: true });
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const logPath = join(resolvedStateDir, `deploy-${stamp}.log`);
      const logFd = openSync(logPath, 'a');
      const forwardedArgs = args.filter((arg) => arg !== '--detach');
      const child = spawnDetached([process.execPath, fileURLToPath(import.meta.url), ...forwardedArgs], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd: repoRoot,
      });
      closeSync(logFd);
      if (child?.unref) child.unref();
      return result(0, `Deploying in the background. Tail the log: ${logPath}\n`);
    } catch (error) {
      return result(1, '', `Blue-green ${options.command} could not detach: ${redact(error)}\n`);
    }
  }

  const composeArgs = ['-f', COMPOSE_FILE, '-p', PROJECT_NAME];
  const cutoverLockPath = join(resolvedStateDir, 'cutover.lock');

  let ownedLock = null;
  try {
    mkdirSync(resolvedStateDir, { recursive: true });
    ownedLock = acquireCutoverLock({ lockPath: cutoverLockPath });
  } catch (error) {
    return result(1, '', `Blue-green ${options.command} failed before preflight: ${redact(error)}\n`);
  }

  const deps = {
    processEnv,
    runCommand,
    runBackupImpl,
    runRestoreDrillImpl,
    now,
    composeArgs,
    fileEnv,
    resolvedEnvFilePath,
    resolvedStateDir,
    options,
    activeUpstreamsPath,
  };

  let deployResult;
  let operationError;
  try {
    if (options.command === 'deploy') {
      deployResult = await executeDeploy(deps);
    } else if (options.command === 'rollback') {
      deployResult = await executeRollback(deps);
    } else if (options.command === 'status') {
      deployResult = await executeStatus(deps);
    } else if (options.command === 'backup') {
      deployResult = await executeBackupCommand(deps);
    } else if (options.command === 'restore-drill') {
      deployResult = await executeRestoreDrillCommand(deps);
    }
  } catch (error) {
    operationError = error;
  }

  try {
    releaseCutoverLock(ownedLock);
  } catch (error) {
    const priorError = deployResult?.stderr
      ? `${deployResult.stderr.trimEnd()}\n`
      : operationError
        ? `Blue-green ${options.command} failed unexpectedly: ${redact(operationError)}\n`
        : '';
    return result(
      1,
      deployResult?.stdout ?? '',
      `${priorError}Blue-green ${options.command} could not release the cutover lock: ${redact(error)}. Do not start another deploy or rollback until the lock owner and runtime state are reconciled.\n`,
    );
  }

  if (operationError) {
    return result(1, deployResult?.stdout ?? '', `Blue-green ${options.command} failed: ${redact(operationError)}\n`);
  }
  return deployResult;
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

async function executeDeploy(deps) {
  const { runCommand, now, composeArgs, fileEnv, resolvedEnvFilePath, resolvedStateDir, options } = deps;

  const run = (command, env) => runCommand(command, { env: env ?? deps.processEnv, cwd: repoRoot });

  // Phase 1: preflight
  writeDeployStatus(resolvedStateDir, 'preflight', 'validating deployment env and git state');
  const issues = preflightIssues({ fileEnv, resolvedEnvFilePath });
  if (issues.length > 0) {
    return result(1, '', `Blue-green deploy preflight failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}\n`);
  }

  const statusOutput = await run(['git', 'status', '--porcelain=v1', '--untracked-files=all']);
  if ((statusOutput.stdout ?? '').trim() !== '') {
    return result(
      1,
      '',
      'Blue-green deploy preflight failed: the git worktree is not clean; commit or stash changes before deploying.\n',
    );
  }
  await run(['git', 'fetch', 'origin', 'master']);
  const headResult = await run(['git', 'rev-parse', 'HEAD']);
  const originResult = await run(['git', 'rev-parse', '--verify', 'refs/remotes/origin/master^{commit}']);
  const targetCommit = (headResult.stdout ?? '').trim();
  const originCommit = (originResult.stdout ?? '').trim();
  if (!targetCommit || targetCommit !== originCommit) {
    return result(
      1,
      '',
      'Blue-green deploy preflight failed: HEAD does not exactly match the already-fetched canonical origin/master commit; deploy from a clean canonical checkout.\n',
    );
  }

  // The spec's phase order is preflight(1) -> backup(2) -> resolve(3), but
  // backup's ctx needs `commit`/`activeColor` metadata that only exist once
  // we've read state — so the READ happens here, silently, and the
  // `writeDeployStatus('resolve', ...)` status-log entry is deliberately
  // emitted AFTER phase 2's backup entry below, to match the spec's phase
  // numbering in the status history a status-checking operator/test reads.
  const state = readState(resolvedStateDir);
  if (state?.corrupt) {
    return result(
      1,
      '',
      'Blue-green deploy aborted: deploy state file is corrupt. Inspect and repair or remove state.json under the state directory before retrying; do not guess at the last-known-good colour.\n',
    );
  }
  const activeColor = state?.activeColor ?? null;
  const target = activeColor ? otherColor(activeColor) : 'blue';
  const oldColor = activeColor;
  const oldCommit = state?.commit ?? null;
  const blueTag = target === 'blue' ? targetCommit : oldCommit ?? UNBUILT_TAG;
  const greenTag = target === 'green' ? targetCommit : oldCommit ?? UNBUILT_TAG;

  const envFor = (activeTag) =>
    baseComposeEnv({ processEnv: deps.processEnv, resolvedEnvFilePath, fileEnv, blueTag, greenTag, activeTag });
  const deployEnv = envFor(targetCommit);

  ensureActiveUpstreamsFileExists(deps.activeUpstreamsPath, target);

  // Phase 2: backup
  writeDeployStatus(resolvedStateDir, 'backup', options.skipBackup ? 'skipped' : 'starting pre-migration backup');
  if (!options.skipBackup) {
    try {
      await deps.runBackupImpl({
        runCommand,
        stateDir: resolvedStateDir,
        envFile: resolvedEnvFilePath,
        composeArgs,
        env: deployEnv,
        databaseName: DEFAULT_DATABASE_NAME,
        databaseUser: DEFAULT_DATABASE_USER,
        commit: targetCommit,
        activeColor: oldColor,
        now,
      });
    } catch (error) {
      return result(1, '', `Blue-green deploy failed: pre-migration backup failed: ${redact(error)}\n`);
    }
  }

  // Phase 3: resolve (status entry emitted here — see the note above)
  writeDeployStatus(
    resolvedStateDir,
    'resolve',
    `target=${target} (previous=${oldColor ?? 'none'}@${oldCommit ?? 'none'})`,
  );

  // Phase 4: worktree
  writeDeployStatus(resolvedStateDir, 'worktree', `preparing release worktree for ${targetCommit}`);
  const releaseDir = releaseDirFor(resolvedStateDir, targetCommit);
  if (!existsSync(releaseDir)) {
    mkdirSync(dirname(releaseDir), { recursive: true });
    await run(['git', 'worktree', 'add', releaseDir, targetCommit]);
  }
  const releases = collectReleases(resolvedStateDir);
  const toPrune = prunePlan(releases, DEFAULT_KEEP_RELEASES, targetCommit);
  for (const commit of toPrune) {
    if (commit === oldCommit) continue; // never prune the rollback target
    const doomedDir = releaseDirFor(resolvedStateDir, commit);
    try {
      await run(['git', 'worktree', 'remove', doomedDir, '--force']);
    } catch {
      // Best-effort: a stale worktree entry must not abort the deploy.
    }
  }

  // Phase 5: build
  writeDeployStatus(resolvedStateDir, 'build', `building ${target} images`);
  await run([...composePrefix({ projectDirectory: releaseDir }), '--profile', target, 'build'], deployEnv);

  // Phase 6: gate
  writeDeployStatus(resolvedStateDir, 'gate', 'checking migration safety');
  await run([...composePrefix(), 'up', '-d', '--wait', 'db'], deployEnv);
  const appliedResult = await run(
    [
      ...composePrefix(),
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      DEFAULT_DATABASE_USER,
      '-d',
      DEFAULT_DATABASE_NAME,
      '-tA',
      '-c',
      APPLIED_MIGRATIONS_SQL,
    ],
    deployEnv,
  );
  const appliedNames = parsePsqlList(appliedResult.stdout);
  const migrationsDir = join(releaseDir, ...MIGRATIONS_RELATIVE);
  const { pending, unknownApplied } = pendingMigrations(migrationsDir, appliedNames);
  const migrationBatch = readMigrationBatch(migrationsDir, pending);
  const gate = gateMigrations(migrationBatch, { allowDestructive: options.allowDestructiveMigration });
  let unknownAppliedWarning = '';
  if (unknownApplied.length > 0) {
    unknownAppliedWarning = `WARNING: the live database has ${unknownApplied.length} applied migration(s) this release's checkout does not contain (${unknownApplied.join(', ')}) — this release is OLDER than the database, which is expected during a rollback-style deploy.\n`;
    writeDeployStatus(resolvedStateDir, 'gate', unknownAppliedWarning.trim());
  }
  if (!gate.ok) {
    const findings = gate.blocked
      .map((finding) => `- [${finding.id}] ${finding.migration}: ${finding.excerpt}`)
      .join('\n');
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy aborted: migration gate blocked ${gate.blocked.length} finding(s). Pass --allow-destructive-migration only after confirming the old colour tolerates these changes.\n${findings}\n`,
    );
  }
  const destructiveOverrideUsed = gate.overridden.length > 0;

  // Phase 7: quiesce
  writeDeployStatus(resolvedStateDir, 'quiesce', 'stopping the scheduler singleton');
  await run([...composePrefix(), 'stop', 'scheduler'], deployEnv);

  // Phase 8: migrate
  writeDeployStatus(resolvedStateDir, 'migrate', `running migrations on ${targetCommit}`);
  try {
    await run([...composePrefix(), 'run', '--rm', '--no-deps', 'migrate'], deployEnv);
  } catch (error) {
    const oldEnv = envFor(oldCommit ?? UNBUILT_TAG);
    try {
      if (oldColor) await run([...composePrefix(), 'up', '-d', 'scheduler'], oldEnv);
    } catch {
      // Best-effort restart; the original migration error is what matters.
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: migration failed: ${redact(error)}. Jobs were restarted on the old tag (${oldCommit ?? 'none'}); the old colour was never touched and remains serving.\n`,
    );
  }

  // Phase 9: up (named services only — never implicitly touches scheduler)
  writeDeployStatus(resolvedStateDir, 'up', `starting ${target} api/web`);
  await run(
    [...composePrefix(), '--profile', target, 'up', '-d', '--wait', `api-${target}`, `web-${target}`],
    deployEnv,
  );

  // Phase 10: candidate-smoke
  writeDeployStatus(resolvedStateDir, 'candidate-smoke', `smoke-testing ${target} directly`);
  try {
    const apiSmoke = await run(
      [
        ...composePrefix(),
        'exec',
        '-T',
        `api-${target}`,
        'wget',
        '-qO-',
        '--header',
        `${READINESS_HEADER}: ${readinessKey(fileEnv)}`,
        `http://127.0.0.1:3002${READINESS_PATH}`,
      ],
      deployEnv,
    );
    const apiBody = JSON.parse(apiSmoke.stdout || '{}');
    if (apiBody.buildCommit !== targetCommit) {
      throw new Error(
        `candidate readiness reported buildCommit=${JSON.stringify(apiBody.buildCommit)}, expected ${targetCommit}`,
      );
    }
    await run(
      [...composePrefix(), 'exec', '-T', `web-${target}`, 'wget', '-qO-', `http://127.0.0.1:3003${WEB_HEALTH_PATH}`],
      deployEnv,
    );
  } catch (error) {
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: candidate smoke test failed on the ${target} colour: ${redact(error)}. Traffic was never switched; the old colour remains live.\n`,
    );
  }

  // Phase 11: switch
  writeDeployStatus(resolvedStateDir, 'switch', `pointing Caddy at ${target}`);
  await run([...composePrefix(), 'up', '-d', '--wait', 'caddy'], deployEnv);
  const previousUpstreams = existsSync(deps.activeUpstreamsPath) ? readFileSync(deps.activeUpstreamsPath, 'utf8') : null;
  writeFileSync(deps.activeUpstreamsPath, renderUpstreams(target));
  try {
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'],
      deployEnv,
    );
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
      deployEnv,
    );
  } catch (error) {
    if (previousUpstreams !== null) writeFileSync(deps.activeUpstreamsPath, previousUpstreams);
    try {
      await run(
        [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
        deployEnv,
      );
    } catch {
      // Best-effort restore reload; the original reload error is what matters.
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: Caddy reload failed while switching to ${target}: ${redact(error)}. The previous upstream file was restored and reloaded; traffic was never switched.\n`,
    );
  }

  // Phase 12: public-smoke
  writeDeployStatus(resolvedStateDir, 'public-smoke', 'verifying traffic through the front door');
  try {
    const publicSmoke = await run(
      [
        'wget',
        '-qO-',
        '--header',
        `${READINESS_HEADER}: ${readinessKey(fileEnv)}`,
        `http://127.0.0.1:${frontPort(fileEnv)}${READINESS_PATH}`,
      ],
      deployEnv,
    );
    const publicBody = JSON.parse(publicSmoke.stdout || '{}');
    if (publicBody.buildCommit !== targetCommit) {
      throw new Error(
        `public readiness reported buildCommit=${JSON.stringify(publicBody.buildCommit)}, expected ${targetCommit}`,
      );
    }
  } catch (error) {
    if (previousUpstreams !== null) writeFileSync(deps.activeUpstreamsPath, previousUpstreams);
    let revertError = '';
    try {
      await run(
        [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
        deployEnv,
      );
      const oldEnv = envFor(oldCommit ?? UNBUILT_TAG);
      if (oldColor) await run([...composePrefix(), 'up', '-d', 'scheduler'], oldEnv);
      const reverify = await run(
        [
          'wget',
          '-qO-',
          '--header',
          `${READINESS_HEADER}: ${readinessKey(fileEnv)}`,
          `http://127.0.0.1:${frontPort(fileEnv)}${READINESS_PATH}`,
        ],
        oldEnv,
      );
      const reverifyBody = JSON.parse(reverify.stdout || '{}');
      if (reverifyBody.buildCommit !== oldCommit) {
        revertError = ` Traffic revert re-verification reported buildCommit=${JSON.stringify(reverifyBody.buildCommit)}, expected the old commit ${oldCommit}.`;
      }
    } catch (revertErr) {
      revertError = ` Traffic revert itself failed: ${redact(revertErr)}`;
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: public smoke test failed after switching to ${target}: ${redact(error)}. Traffic was reverted to the old colour and re-verified.${revertError}\n`,
    );
  }

  // Phase 13: jobs
  writeDeployStatus(resolvedStateDir, 'jobs', `starting scheduler on ${targetCommit}`);
  await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], deployEnv);

  // Phase 14: retire
  if (oldColor) {
    writeDeployStatus(resolvedStateDir, 'retire', `stopping ${oldColor} (containers kept)`);
    await run([...composePrefix(), 'stop', `api-${oldColor}`, `web-${oldColor}`], deployEnv);
  } else {
    writeDeployStatus(resolvedStateDir, 'retire', 'no previous colour to retire (first deploy)');
  }

  // Phase 15: record
  writeDeployStatus(resolvedStateDir, 'record', 'writing deploy state');
  writeState(resolvedStateDir, {
    activeColor: target,
    commit: targetCommit,
    previousColor: oldColor,
    previousCommit: oldCommit,
    deployedAt: now().toISOString(),
    rollbackable: !destructiveOverrideUsed,
  });
  pruneBackups(resolvedStateDir, now());

  return result(0, `${unknownAppliedWarning}Blue-green deploy completed: ${target} is now live at ${targetCommit}.\n`);
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

async function executeRollback(deps) {
  const { runCommand, now, fileEnv, resolvedEnvFilePath, resolvedStateDir } = deps;
  const run = (command, env) => runCommand(command, { env: env ?? deps.processEnv, cwd: repoRoot });

  const state = readState(resolvedStateDir);
  if (!state) {
    return result(1, '', 'Blue-green rollback refused: no deploy state found; there is nothing to roll back.\n');
  }
  if (state.corrupt) {
    return result(
      1,
      '',
      'Blue-green rollback refused: deploy state file is corrupt; inspect and repair state.json before retrying.\n',
    );
  }
  if (state.rollbackable === false) {
    return result(
      1,
      '',
      'Blue-green rollback refused: the current deploy used --allow-destructive-migration, which disables one-command rollback. Restore from backup instead.\n',
    );
  }
  if (!state.previousColor || !state.previousCommit) {
    return result(1, '', 'Blue-green rollback refused: no previous colour is recorded to roll back to.\n');
  }

  const { previousColor, previousCommit, activeColor: currentColor, commit: currentCommit } = state;
  const blueTag = previousColor === 'blue' ? previousCommit : currentCommit;
  const greenTag = previousColor === 'green' ? previousCommit : currentCommit;
  const rollbackEnv = baseComposeEnv({
    processEnv: deps.processEnv,
    resolvedEnvFilePath,
    fileEnv,
    blueTag,
    greenTag,
    activeTag: previousCommit,
  });

  const psResult = await run([...composePrefix(), 'ps', '-a'], rollbackEnv);
  if (!(psResult.stdout ?? '').includes(`api-${previousColor}`)) {
    return result(
      1,
      '',
      `Blue-green rollback refused: no containers found for the previous colour (${previousColor}); it may have been pruned.\n`,
    );
  }

  const previousUpstreams = existsSync(deps.activeUpstreamsPath) ? readFileSync(deps.activeUpstreamsPath, 'utf8') : null;
  writeFileSync(deps.activeUpstreamsPath, renderUpstreams(previousColor));
  try {
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'],
      rollbackEnv,
    );
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
      rollbackEnv,
    );
  } catch (error) {
    if (previousUpstreams !== null) writeFileSync(deps.activeUpstreamsPath, previousUpstreams);
    try {
      await run(
        [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
        rollbackEnv,
      );
    } catch {
      // Best-effort restore reload.
    }
    return result(
      1,
      '',
      `Blue-green rollback failed: Caddy reload failed: ${redact(error)}. The previous upstream file was restored.\n`,
    );
  }

  await run([...composePrefix(), 'up', '-d', `api-${previousColor}`, `web-${previousColor}`], rollbackEnv);
  await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], rollbackEnv);

  try {
    const publicSmoke = await run(
      [
        'wget',
        '-qO-',
        '--header',
        `${READINESS_HEADER}: ${readinessKey(fileEnv)}`,
        `http://127.0.0.1:${frontPort(fileEnv)}${READINESS_PATH}`,
      ],
      rollbackEnv,
    );
    const body = JSON.parse(publicSmoke.stdout || '{}');
    if (body.buildCommit !== previousCommit) {
      throw new Error(
        `rollback readiness reported buildCommit=${JSON.stringify(body.buildCommit)}, expected ${previousCommit}`,
      );
    }
  } catch (error) {
    return result(1, '', `Blue-green rollback failed: public smoke test after rollback failed: ${redact(error)}.\n`);
  }

  if (currentColor) await run([...composePrefix(), 'stop', `api-${currentColor}`, `web-${currentColor}`], rollbackEnv);

  writeState(resolvedStateDir, {
    activeColor: previousColor,
    commit: previousCommit,
    previousColor: currentColor,
    previousCommit: currentCommit,
    deployedAt: now().toISOString(),
    rollbackable: true,
  });

  return result(0, `Blue-green rollback completed: ${previousColor} is now live at ${previousCommit}.\n`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function executeStatus(deps) {
  const { runCommand, fileEnv, resolvedEnvFilePath, resolvedStateDir } = deps;
  const run = (command, env) => runCommand(command, { env: env ?? deps.processEnv, cwd: repoRoot });

  const state = readState(resolvedStateDir);
  const lines = [];
  if (!state) {
    lines.push('No deploy state found.');
  } else if (state.corrupt) {
    lines.push('Deploy state file is CORRUPT — inspect state.json under the state directory.');
  } else {
    lines.push(`Active colour: ${state.activeColor} @ ${state.commit}`);
    lines.push(`Previous colour: ${state.previousColor ?? 'none'} @ ${state.previousCommit ?? 'none'}`);
    lines.push(`Deployed at: ${state.deployedAt}`);
    lines.push(`Rollbackable: ${state.rollbackable !== false}`);

    const env = baseComposeEnv({
      processEnv: deps.processEnv,
      resolvedEnvFilePath,
      fileEnv,
      blueTag: state.activeColor === 'blue' ? state.commit : state.previousCommit ?? UNBUILT_TAG,
      greenTag: state.activeColor === 'green' ? state.commit : state.previousCommit ?? UNBUILT_TAG,
      activeTag: state.commit,
    });
    try {
      const ps = await run([...composePrefix(), 'ps', '-a'], env);
      lines.push('', 'docker compose ps -a:', (ps.stdout ?? '').trimEnd());
    } catch (error) {
      lines.push('', `Could not run docker compose ps: ${redact(error)}`);
    }
  }

  const status = deployStatus(resolvedStateDir);
  if (status?.history?.length) {
    lines.push('', 'Recent deploy status history:');
    for (const entry of status.history.slice(-10)) {
      lines.push(`- ${entry.timestamp} [${entry.phase}] ${entry.detail}`);
    }
  }

  return result(0, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// backup / restore-drill standalone subcommands
// ---------------------------------------------------------------------------

async function executeBackupCommand(deps) {
  const { runCommand, now, composeArgs, fileEnv, resolvedEnvFilePath, resolvedStateDir } = deps;
  const state = readState(resolvedStateDir);
  const blueTag = state?.activeColor === 'blue' ? state.commit : state?.previousCommit ?? UNBUILT_TAG;
  const greenTag = state?.activeColor === 'green' ? state.commit : state?.previousCommit ?? UNBUILT_TAG;
  const env = baseComposeEnv({
    processEnv: deps.processEnv,
    resolvedEnvFilePath,
    fileEnv,
    blueTag,
    greenTag,
    activeTag: state?.commit ?? UNBUILT_TAG,
  });

  const { plan } = await deps.runBackupImpl({
    runCommand,
    stateDir: resolvedStateDir,
    envFile: resolvedEnvFilePath,
    composeArgs,
    env,
    databaseName: DEFAULT_DATABASE_NAME,
    databaseUser: DEFAULT_DATABASE_USER,
    commit: state?.commit ?? null,
    activeColor: state?.activeColor ?? null,
    now,
  });

  pruneBackups(resolvedStateDir, now());
  return result(0, `Backup created at ${plan.dir}\n`);
}

async function executeRestoreDrillCommand(deps) {
  const { runCommand, fileEnv, resolvedEnvFilePath, resolvedStateDir, composeArgs } = deps;
  const backupDir = latestBackupDir(resolvedStateDir);
  if (!backupDir) {
    return result(1, '', 'Blue-green restore-drill refused: no backups found under the state directory.\n');
  }

  const state = readState(resolvedStateDir);
  const blueTag = state?.activeColor === 'blue' ? state.commit : state?.previousCommit ?? UNBUILT_TAG;
  const greenTag = state?.activeColor === 'green' ? state.commit : state?.previousCommit ?? UNBUILT_TAG;
  const env = baseComposeEnv({
    processEnv: deps.processEnv,
    resolvedEnvFilePath,
    fileEnv,
    blueTag,
    greenTag,
    activeTag: state?.commit ?? UNBUILT_TAG,
  });

  const plan = {
    dir: backupDir,
    dumpFile: join(backupDir, DUMP_ARTIFACT_NAME),
    documentsTar: join(backupDir, DOCUMENTS_ARTIFACT_NAME),
    manifestFile: join(backupDir, MANIFEST_ARTIFACT_NAME),
  };

  const drillResult = await deps.runRestoreDrillImpl({
    runCommand,
    stateDir: resolvedStateDir,
    envFile: resolvedEnvFilePath,
    composeArgs,
    env,
    databaseName: DEFAULT_DATABASE_NAME,
    databaseUser: DEFAULT_DATABASE_USER,
    plan,
  });

  return result(0, `Restore drill against ${backupDir} passed: ${JSON.stringify(drillResult.rowCensus)}\n`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function main() {
  const args = process.argv.slice(2);
  const deployResult = await runBluegreenDeployFromArgs(args);
  if (deployResult.stdout) process.stdout.write(deployResult.stdout);
  if (deployResult.stderr) process.stderr.write(deployResult.stderr);
  process.exit(deployResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
