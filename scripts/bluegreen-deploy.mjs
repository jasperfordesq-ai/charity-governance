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
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
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

// P3: the engine's compose invocation is `-f compose.bluegreen.yml [-f <override>] -p charitypilot-bluegreen`.
// The override (env-file key BLUEGREEN_COMPOSE_OVERRIDE, resolved against the repo root like --env-file)
// is how a deployment target points the volumes somewhere else — the private VM at the appliance's
// external volumes — without ever editing compose.bluegreen.yml (its header says exactly this).
let activeComposeFileArgs = ['-f', COMPOSE_FILE];

export function composeFileArgs(fileEnv) {
  const override = fileEnv.BLUEGREEN_COMPOSE_OVERRIDE || '';
  return override ? ['-f', COMPOSE_FILE, '-f', resolve(repoRoot, override)] : ['-f', COMPOSE_FILE];
}

const ACTIVE_UPSTREAMS_PATH = join(repoRoot, 'caddy', 'active-upstreams.caddy');
const MIGRATIONS_RELATIVE = ['apps', 'api', 'prisma', 'migrations'];
const READINESS_HEADER = 'x-charitypilot-readiness-key';
const READINESS_PATH = '/api/v1/health/readiness';
const WEB_HEALTH_PATH = '/login';
const UNBUILT_TAG = 'unbuilt';
const DEFAULT_DATABASE_NAME = 'charitypilot';
const DEFAULT_DATABASE_USER = 'charitypilot';

// P3: the appliance's volumes hold a role/database both named
// `charitypilot_personal_server`, not `charitypilot`. Every psql/pg_dump the
// engine issues must use the identity the volume actually holds, so it is
// read from the deployment env file (the same POSTGRES_DB/POSTGRES_USER the
// compose db service itself reads) with today's values as the default.
export function databaseIdentity(fileEnv) {
  return {
    databaseName: fileEnv.POSTGRES_DB || DEFAULT_DATABASE_NAME,
    databaseUser: fileEnv.POSTGRES_USER || DEFAULT_DATABASE_USER,
  };
}
const DEFAULT_KEEP_RELEASES = 3;
const DEFAULT_BACKUP_RETENTION_DAYS = 14;
const DUMP_ARTIFACT_NAME = 'database.dump';
const DOCUMENTS_ARTIFACT_NAME = 'documents.tar';
const MANIFEST_ARTIFACT_NAME = 'manifest.json';
const APPLIED_MIGRATIONS_SQL =
  'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL';
// C1 fix: a fresh database has no "_prisma_migrations" relation yet (every
// first-ever deploy, including Task 10's local acceptance run and the
// owner's real VM cutover). A bare SELECT against it errors with "relation
// ... does not exist" (confirmed against real postgres:16-alpine). Guarded
// two-step, mirroring production-p109-restored-database-probe.mjs's own
// TO_REGCLASS use: probe existence first (TO_REGCLASS never throws), skip
// the real query entirely when the relation is absent. The JS-level catch
// below is belt-and-braces in case the probe itself ever surfaces a
// relation-missing-shaped error some other way.
const PRISMA_MIGRATIONS_EXISTS_PROBE_SQL =
  "SELECT TO_REGCLASS('public.\"_prisma_migrations\"') IS NOT NULL";
const RELATION_MISSING_PATTERN = /relation\s+.*_prisma_migrations.*\s+does not exist/i;

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

// M1 fix: mirrors apps/api/src/utils/env.ts's parseCanonicalOriginOverride
// shape rule exactly — must parse as a URL, use https://, and its origin
// must equal the raw string verbatim (which rules out a path, a trailing
// slash, and userinfo/credentials all in one comparison).
function isExactHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

// Micro-round fix: mirrors apps/web/src/lib/api-config.ts's
// isLoopbackHostname exactly (normalises IPv6 brackets, checks against the
// three exact loopback forms).
function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isExactLoopbackHttpOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.origin === value && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

// Micro-round fix: the canonical-origin overrides are https-only EXCEPT
// when BLUEGREEN_ORIGIN itself is loopback — that's what marks this whole
// deployment as local/scratch (the web layer's own build-time override
// already has this exact leniency for the same reason). Any other
// BLUEGREEN_ORIGIN keeps the strict https-only rule.
function isValidCanonicalOrigin(value, allowLoopbackHttp) {
  if (isExactHttpsOrigin(value)) return true;
  return allowLoopbackHttp && isExactLoopbackHttpOrigin(value);
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

  // P3: the URL the app connects with and the identity the engine's own
  // psql/pg_dump use must name the same database and role — an appliance-
  // shaped URL with the POSTGRES_* vars forgotten would otherwise pass here
  // and fail at the migration gate with `role "charitypilot" does not exist`.
  const identity = databaseIdentity(fileEnv);
  try {
    const url = new URL(fileEnv.DATABASE_URL ?? '');
    const urlDatabase = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const urlUser = decodeURIComponent(url.username);
    if (urlDatabase && urlDatabase !== identity.databaseName) {
      issues.push(
        `DATABASE_URL database ${JSON.stringify(urlDatabase)} does not match POSTGRES_DB (resolved ${JSON.stringify(identity.databaseName)}); set POSTGRES_DB in the env file to the database the volume actually holds`,
      );
    }
    if (urlUser && urlUser !== identity.databaseUser) {
      issues.push(
        `DATABASE_URL user ${JSON.stringify(urlUser)} does not match POSTGRES_USER (resolved ${JSON.stringify(identity.databaseUser)}); set POSTGRES_USER in the env file to the role the volume actually holds`,
      );
    }
  } catch {
    // An unparseable DATABASE_URL is already reported by the hostname check above.
  }

  const declaredEnvFile = fileEnv.BLUEGREEN_ENV_FILE ?? '';
  if (!declaredEnvFile || resolve(declaredEnvFile) !== resolve(resolvedEnvFilePath)) {
    issues.push(
      `BLUEGREEN_ENV_FILE must equal this env file's own path (${resolvedEnvFilePath}); found ${JSON.stringify(declaredEnvFile)}`,
    );
  }

  const frontendHost = hostnameOf(fileEnv.FRONTEND_URL ?? '');
  if (frontendHost && !isApprovedCharityPilotHostname(frontendHost)) {
    // Micro-round fix: BLUEGREEN_ORIGIN itself being an exact loopback
    // origin is what marks this whole deployment as local/scratch — only
    // then may the canonical-origin overrides ALSO be an exact loopback
    // http:// origin, mirroring the web layer's own local-acceptance
    // leniency (apps/web/src/lib/api-config.ts's validateProductionApiUrl).
    // Any other BLUEGREEN_ORIGIN (including unset) keeps the strict
    // https-only rule.
    const blueGreenOriginHostname = hostnameOf(fileEnv.BLUEGREEN_ORIGIN ?? '');
    const allowLoopbackHttp = blueGreenOriginHostname !== null && isLoopbackHostname(blueGreenOriginHostname);
    const shapeMessage = (name) =>
      `${name} must be an exact https origin (no path, no trailing slash, no credentials)` +
      (allowLoopbackHttp ? ', or an exact loopback http:// origin (BLUEGREEN_ORIGIN is itself loopback)' : '');

    if (!fileEnv.CHARITYPILOT_CANONICAL_WEB_ORIGIN) {
      issues.push(
        'CHARITYPILOT_CANONICAL_WEB_ORIGIN is required when FRONTEND_URL is not a charitypilot.ie hostname',
      );
    } else if (!isValidCanonicalOrigin(fileEnv.CHARITYPILOT_CANONICAL_WEB_ORIGIN, allowLoopbackHttp)) {
      // M1 fix: was a bare truthiness check — a malformed value (a path, a
      // trailing slash, credentials, http://, or an unparseable string)
      // used to sail through preflight and only fail deep into the run
      // (e.g. web build/boot). Mirrors env.ts's own
      // parseCanonicalOriginOverride: must parse as a URL whose origin
      // equals the raw string exactly (rules out path/trailing-slash/
      // credentials) and use https:// — except for the loopback exception
      // above.
      issues.push(shapeMessage('CHARITYPILOT_CANONICAL_WEB_ORIGIN'));
    }
    if (!fileEnv.CHARITYPILOT_CANONICAL_API_ORIGIN) {
      issues.push(
        'CHARITYPILOT_CANONICAL_API_ORIGIN is required when FRONTEND_URL is not a charitypilot.ie hostname',
      );
    } else if (!isValidCanonicalOrigin(fileEnv.CHARITYPILOT_CANONICAL_API_ORIGIN, allowLoopbackHttp)) {
      issues.push(shapeMessage('CHARITYPILOT_CANONICAL_API_ORIGIN'));
    }
  }

  // I4 fix: without READINESS_API_KEY every readiness call is a guaranteed
  // 401 that only surfaces at phase 10 (candidate-smoke), AFTER migrations
  // have already applied — far too late to be a cheap preflight catch.
  if (!fileEnv.READINESS_API_KEY || !fileEnv.READINESS_API_KEY.trim()) {
    issues.push('READINESS_API_KEY is required (candidate/public smoke cannot authenticate without it)');
  }
  if (!fileEnv.BLUEGREEN_ORIGIN || !fileEnv.BLUEGREEN_ORIGIN.trim()) {
    issues.push('BLUEGREEN_ORIGIN is required (the web build and the canonical-origin check both need it)');
  }
  const frontPortValue = fileEnv.BLUEGREEN_FRONT_PORT;
  if (frontPortValue !== undefined && frontPortValue !== '' && !/^\d+$/.test(frontPortValue)) {
    issues.push(
      `BLUEGREEN_FRONT_PORT must be a positive integer port number when set; got ${JSON.stringify(frontPortValue)}`,
    );
  }

  const overrideValue = fileEnv.BLUEGREEN_COMPOSE_OVERRIDE || '';
  let overrideResolvable = true;
  if (overrideValue) {
    const overridePath = resolve(repoRoot, overrideValue);
    if (!existsSync(overridePath)) {
      issues.push(`BLUEGREEN_COMPOSE_OVERRIDE file not found: ${overridePath}`);
      overrideResolvable = false;
    }
    if (!(fileEnv.BLUEGREEN_DOCUMENTS_VOLUME || '')) {
      issues.push(
        'BLUEGREEN_DOCUMENTS_VOLUME is required when BLUEGREEN_COMPOSE_OVERRIDE is set (an override exists to move the volumes; the backup must tar the one the override names)',
      );
    }
  }

  // Round-2 fix: BLUEGREEN_DOCUMENTS_VOLUME is the name the BACKUP tars;
  // the compose file/override is what the APP actually mounts. A one-
  // character disagreement between them does not fail — it silently backs
  // up an EMPTY volume. `docker run --mount type=volume,src=<nonexistent>`
  // AUTO-CREATES the named volume (root:root 0755, which uid 1000 traverses
  // happily), so the tar exits 0 with an empty tree, the manifest records
  // zero documents, and the restore drill compares that empty manifest
  // against the equally-empty tar and passes. The drill's whole value is
  // that it cannot pass vacuously, so this must be a refusal.
  //
  // Skipped when the override path itself is unresolvable: the missing-file
  // issue above already says what is wrong, and the compose-declared names
  // would then be the base file's rather than the override's.
  const declaredDocumentsVolume = fileEnv.BLUEGREEN_DOCUMENTS_VOLUME || '';
  if (declaredDocumentsVolume && overrideResolvable) {
    const composeDocumentsVolume = composeDeclaredVolumeNames(fileEnv).documents;
    if (composeDocumentsVolume && declaredDocumentsVolume !== composeDocumentsVolume) {
      issues.push(
        `BLUEGREEN_DOCUMENTS_VOLUME is ${JSON.stringify(declaredDocumentsVolume)} but the compose file(s) this deployment uses declare the documents volume as ${JSON.stringify(composeDocumentsVolume)}; they must name the same volume (the backup tars the former while the app mounts the latter, and docker would auto-create the missing one, producing a silently EMPTY documents backup that the restore drill would still pass)`,
      );
    }
  }

  return issues;
}

// Every host binary this orchestrator spawns directly on the HOST — never
// via `docker compose exec`, which runs inside a container using whatever
// that image already provides. docker itself (every composePrefix() call),
// git (status/fetch/rev-parse/worktree), and wget (the public-facing smoke
// tests that hit the front door from OUTSIDE any container: deploy's
// public-smoke, its revert-reverify, and rollback's post-rollback smoke).
// A missing one used to surface only as an opaque, generic "failed with
// exit code unknown" deep into the run (phase 12, AFTER traffic had already
// switched) instead of failing fast here. Extend this list whenever a new
// host-level run([...]) call introduces a new binary — the structural test
// in bluegreen-deploy.test.mjs fails loudly if one is missed.
export const REQUIRED_HOST_BINARIES = ['docker', 'git', 'wget'];

export async function missingHostBinaries(runCommand) {
  const missing = [];
  for (const binary of REQUIRED_HOST_BINARIES) {
    try {
      await runCommand([binary, '--version']);
    } catch {
      missing.push(binary);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Which volumes this deployment will actually use, and who else is on them
// (VM-cutover defect 2b)
// ---------------------------------------------------------------------------
//
// The compose VOLUME KEYS are fixed (`bluegreen-db`/`bluegreen-documents`);
// the real Docker volume NAMES are whatever the compose file — or the
// deployment's `BLUEGREEN_COMPOSE_OVERRIDE`, which exists precisely to move
// them — declares under `name:`. Neither name is in the env file (only the
// documents one is, and only as the value the backup tars), so the names are
// read from the very files this run passes to `docker compose`, in the same
// order compose merges them (later file wins). That is deliberately NOT
// `docker compose config`: at phase 1 the blue/green/active image tags are
// not resolved yet (they come from state, read at phase 3) and every one of
// them is a `${...:?}` required interpolation, and `config` additionally
// prunes `bluegreen-documents` from its own output unless a colour profile
// is active. Reading the files needs no docker call, no dummy tags, and no
// new env var that a deployment could forget to set.
const COMPOSE_DB_VOLUME_KEY = 'bluegreen-db';
const COMPOSE_DOCUMENTS_VOLUME_KEY = 'bluegreen-documents';
const DEFAULT_DB_VOLUME = 'charitypilot-bluegreen-db';
const DEFAULT_DOCUMENTS_VOLUME = 'charitypilot-bluegreen-documents';

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Reads `{<volume key>: <name>}` out of one compose file's top-level
// `volumes:` block. Scoped deliberately narrowly (top-level block only,
// two-space keys, four-space `name:`) — that is the exact shape both
// compose.bluegreen.yml and compose.bluegreen.private-vm.yml have, and both
// shapes are already pinned byte-for-byte by
// scripts/check-bluegreen-compose.test.mjs and
// scripts/check-bluegreen-private-vm-compose.test.mjs.
function composeVolumeNames(composeFilePath) {
  let text;
  try {
    text = readFileSync(composeFilePath, 'utf8');
  } catch {
    return {};
  }
  const names = {};
  let inVolumesBlock = false;
  let currentKey = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      inVolumesBlock = /^volumes:\s*$/.test(line);
      currentKey = null;
      continue;
    }
    if (!inVolumesBlock) continue;
    const keyMatch = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (keyMatch) {
      currentKey = keyMatch[1];
      continue;
    }
    const nameMatch = /^ {4}name:\s*(.+)$/.exec(line);
    if (nameMatch && currentKey) names[currentKey] = unquoteYamlScalar(nameMatch[1]);
  }
  return names;
}

/**
 * The volume names the compose file(s) this run passes to `docker compose`
 * actually DECLARE — i.e. what compose will mount, ignoring any env-level
 * preference. `deploymentVolumeNames` layers the env over this; preflight
 * compares the two.
 */
export function composeDeclaredVolumeNames(fileEnv) {
  const merged = {};
  for (const composeFilePath of composeFileArgs(fileEnv).filter((arg) => arg !== '-f')) {
    Object.assign(merged, composeVolumeNames(composeFilePath));
  }
  return {
    db: merged[COMPOSE_DB_VOLUME_KEY] || DEFAULT_DB_VOLUME,
    documents: merged[COMPOSE_DOCUMENTS_VOLUME_KEY] || DEFAULT_DOCUMENTS_VOLUME,
  };
}

/**
 * The Docker volume names this deployment will actually mount. `documents`
 * prefers BLUEGREEN_DOCUMENTS_VOLUME because that is the name the backup
 * itself tars (see the backup phase); `db` has no env override at all and
 * comes from the compose file/override alone.
 */
export function deploymentVolumeNames(fileEnv) {
  const declared = composeDeclaredVolumeNames(fileEnv);
  return {
    db: declared.db,
    documents: fileEnv.BLUEGREEN_DOCUMENTS_VOLUME || declared.documents,
  };
}

// A container from ANOTHER compose project (or no project at all) already
// mounting one of this deployment's volumes is the shape of the real
// near-miss on the VM cutover: an aborted deploy left this engine's `db`
// attached to the appliance's PGDATA, and restoring appliance service then
// started a SECOND postmaster on the same data directory. Two postmasters on
// one PGDATA is a corruption risk, so this refuses BEFORE anything runs.
// Containers belonging to this engine's own compose project are fine — they
// are the deployment being (re-)deployed.
export async function volumesInUseByOtherStacks(runCommand, volumeNames) {
  const issues = [];
  const seen = new Set();
  for (const volume of [volumeNames.db, volumeNames.documents]) {
    if (!volume || seen.has(volume)) continue;
    seen.add(volume);
    let stdout;
    try {
      const listed = await runCommand([
        'docker',
        'ps',
        '--filter',
        `volume=${volume}`,
        '--format',
        // A literal tab, not the string "\t": no shell and no reliance on
        // docker's own escape handling in the template.
        '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
      ]);
      stdout = listed?.stdout ?? '';
    } catch (error) {
      issues.push(
        `Could not determine whether volume ${volume} is already in use by another stack (docker ps failed: ${redact(error)}); refusing to deploy without that answer — a second Postgres on one data directory risks corruption.`,
      );
      continue;
    }
    const foreign = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const [containerName, project = ''] = line.split('\t');
      if (!containerName) continue;
      if (project.trim() === PROJECT_NAME) continue;
      foreign.push(containerName.trim());
    }
    if (foreign.length > 0) {
      issues.push(
        `Refusing to deploy: volume ${volume} is in use by container(s) ${foreign.join(', ')} from another stack; stop that stack first (a second Postgres on one data directory risks corruption).`,
      );
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Compose command builders
// ---------------------------------------------------------------------------

function composePrefix({ projectDirectory } = {}) {
  const prefix = ['docker', 'compose', ...activeComposeFileArgs, '-p', PROJECT_NAME];
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
    // M2 fix: '' counts as unset (project convention — matches preflight's
    // own frontPortValue check and compose's ${BLUEGREEN_FRONT_PORT:-8080}
    // shell default, both of which already treat '' as "not set"). `??`
    // does not: an explicit empty string used to leak through as the
    // literal port value here instead of falling back to 8080.
    BLUEGREEN_FRONT_PORT: fileEnv.BLUEGREEN_FRONT_PORT || '8080',
  };
}

function readinessKey(fileEnv) {
  return fileEnv.READINESS_API_KEY ?? '';
}

function frontPort(fileEnv) {
  // M2 fix: same '' = unset convention as baseComposeEnv above.
  return fileEnv.BLUEGREEN_FRONT_PORT || '8080';
}

// ---------------------------------------------------------------------------
// Default (real) dependency implementations
// ---------------------------------------------------------------------------

// VM-cutover defect 3: spawnSync's maxBuffer default is 1 MiB, and going
// over it is not a polite truncation — the child is KILLED and spawnSync
// returns `status: null` with `error.code === 'ENOBUFS'`. A real cutover
// died in phase 2 tarring an 8.4 MB documents volume and reported only
// "failed with exit code unknown" with no stderr, because the message read
// nothing but `status` and `stderr`.
//
// This cap governs only output this function CAPTURES as a string: the row
// census, the per-document sha256 listing (which grows with the document
// count — a charity with thousands of files is far over 1 MiB),
// `docker ps`/`compose ps`/`compose config` probes, `git rev-parse`, and
// readiness bodies. 256 MiB is far above any of them. Exceeding it is
// STILL an ENOBUFS kill — raising the cap does not change the mechanism —
// but the kill now NAMES ITSELF (see commandFailureMessage) instead of
// surfacing as "exit code unknown". The genuinely unbounded artifacts (pg_dump -Fc, the
// documents tar) never come through the capture path at all: they stream
// straight to a file descriptor in runCommandToOutputFile below, so a large
// documents volume is bounded by DISK, not by this process's RAM.
const COMMAND_OUTPUT_MAX_BUFFER = 256 * 1024 * 1024;

// One failure message for every way spawnSync can fail, so no class of
// failure can misreport itself again:
//   - non-zero exit      -> "... failed with exit code 3: <stderr>"
//   - spawn-level error   -> "... failed: ENOENT: spawnSync docker ENOENT"
//                            (ENOBUFS/EACCES/E2BIG all name themselves too)
//   - killed by a signal  -> "... failed: killed by signal SIGKILL"
//   - error + signal      -> "... failed: ENOBUFS: <msg> (killed by signal SIGTERM)"
// `status: null` with neither an error nor a signal is not supposed to be
// reachable, but it still says so explicitly rather than printing "unknown".
//
// Exported so the reliability suite can table-test every shape directly:
// two of these branches (signal-only, and nothing-reported) cannot be
// provoked from a real child process on demand, and the ledger row that
// claims all of them has to be able to prove all of them.
export function commandFailureMessage(command, spawnResult, stderrText) {
  const detail = stderrText ? `: ${stderrText.slice(0, 2000)}` : '';
  const signalSuffix = spawnResult.signal ? ` (killed by signal ${spawnResult.signal})` : '';
  if (spawnResult.error) {
    const code = spawnResult.error.code ? `${spawnResult.error.code}: ` : '';
    return `${commandLine(command)} failed: ${code}${spawnResult.error.message}${signalSuffix}${detail}`;
  }
  if (spawnResult.status === null || spawnResult.status === undefined) {
    const cause = spawnResult.signal
      ? `killed by signal ${spawnResult.signal}`
      : 'no exit code, no signal and no spawn error were reported';
    return `${commandLine(command)} failed: ${cause}${detail}`;
  }
  return `${commandLine(command)} failed with exit code ${spawnResult.status}${signalSuffix}${detail}`;
}

// spawnSync does not only fail by RETURNING a failure — it can also THROW
// (argument validation) instead of returning a result at all, in which case
// there is no `spawnResult` to describe. Round-1 review: the outputFile path
// used to reach for `spawnResult.status` after such a throw and raise a bare
// TypeError naming no command. Every spawn goes through here so that a throw
// still identifies the command that could not be started.
function spawnCommandSync(command, spawnOptions) {
  try {
    return spawnSync(command[0], command.slice(1), spawnOptions);
  } catch (error) {
    throw new Error(commandFailureMessage(command, { error }, ''));
  }
}

// The post-spawn filesystem steps (fsync, size check, rename) can fail on
// their own — ENOSPC or EIO while flushing a multi-GB documents tar is the
// realistic one. Those errors must still name the command whose artifact
// they were publishing, or the operator gets a bare `EIO: fsync` with no
// idea which phase produced it.
function artifactStepFailure(command, description, error) {
  const code = error?.code ? `${error.code}: ` : '';
  return new Error(`${commandLine(command)} ${description}: ${code}${error?.message ?? String(error)}`);
}

// Streams the child's stdout DIRECTLY to a file descriptor. stderr stays
// piped (capped by COMMAND_OUTPUT_MAX_BUFFER) so a failure still explains
// itself.
//
// File-on-failure semantics: the old implementation captured the whole
// artifact in memory and only `writeFileSync`d it after a zero exit, so on
// failure `outputFile` did not exist. Streaming would otherwise leave a
// truncated dump/tar sitting exactly where runBackup's `sha256File` and the
// manifest expect a complete one. That property is deliberately PRESERVED
// AND STRENGTHENED: the child writes to `<outputFile>.partial`, which is
// fsynced and renamed into place only after a zero exit AND a non-empty
// size check, and is removed on EVERY failure path — a spawn that throws, a
// spawn-level error, a non-zero exit, a failed fsync, an empty artifact, or
// a failed rename. (The round-1 review caught the fsync, empty and rename
// paths escaping the old cleanup, which sat inside the non-zero-exit branch
// only.) So `outputFile` never exists unless it is complete and durable,
// and the rename is atomic within the backup directory — strictly better
// than the previous non-atomic whole-file write, at no cost to the caller.
//
// The empty-artifact refusal (round-1 review) mirrors
// scripts/personal-server.mjs:933. Neither real caller can legitimately
// produce zero bytes: `pg_dump -Fc` always emits a custom-format header
// even for an empty database, and `tar -cf -` always emits at least one
// member plus its zero-block trailer even for an empty directory. So zero
// bytes means the child wrote nothing — and publishing that would let
// runBackup hash and manifest an empty dump that stays self-consistent
// (and so passes a restore drill vacuously, the drill being a separate
// subcommand) until someone needs a real restore. Same "cannot pass
// vacuously" rule the previous fix round applied to the documents volume
// name; there is deliberately no escape hatch.
function runCommandToOutputFile(command, { env, cwd, outputFile }) {
  const partialFile = `${outputFile}.partial`;
  rmSync(partialFile, { force: true });
  const fd = openSync(partialFile, 'w', 0o600);
  try {
    let spawnResult;
    try {
      spawnResult = spawnCommandSync(command, {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', fd, 'pipe'],
        maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
      });
      if (spawnResult.status === 0) {
        try {
          fsyncSync(fd);
        } catch (error) {
          throw artifactStepFailure(command, `succeeded but its output could not be flushed to ${partialFile}`, error);
        }
      }
    } finally {
      closeSync(fd);
    }
    if (spawnResult.status !== 0) {
      const stderrText = spawnResult.stderr ? spawnResult.stderr.toString('utf8') : '';
      throw new Error(commandFailureMessage(command, spawnResult, stderrText));
    }
    const bytesWritten = statSync(partialFile).size;
    if (bytesWritten <= 0) {
      throw new Error(
        `${commandLine(command)} exited 0 but wrote ZERO bytes to ${outputFile}; refusing to publish an empty artifact (an empty dump or tar would still hash and drill consistently, so it would only surface at a real restore)`,
      );
    }
    try {
      renameSync(partialFile, outputFile);
    } catch (error) {
      throw artifactStepFailure(command, `produced ${bytesWritten} bytes that could not be published to ${outputFile}`, error);
    }
  } catch (error) {
    // Every failure path above lands here, so no partial dump or tar is ever
    // left behind for the manifest, the pruner or a drill to find.
    rmSync(partialFile, { force: true });
    throw error;
  }
  return { stdout: '' };
}

// Exported for the reliability tests: the buffering posture of this real
// implementation (not an injected fake) is exactly what VM-cutover defect 3
// was, so it has to be testable directly.
export async function defaultRunCommand(command, options = {}) {
  const { env, cwd = repoRoot, outputFile } = options;
  // Contract (see backup.mjs's ctx shape notes): the outputFile case
  // resolves { stdout: '' } — callers read the FILE, never the resolved
  // stdout — and both cases throw on a non-zero exit.
  if (outputFile) return runCommandToOutputFile(command, { env, cwd, outputFile });
  const spawnResult = spawnCommandSync(command, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
  });
  if (spawnResult.status !== 0) {
    throw new Error(commandFailureMessage(command, spawnResult, spawnResult.stderr ?? ''));
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

// C1 fix: probe-then-query. TO_REGCLASS never throws for a missing
// relation, so the probe itself is always safe; the JS-level catch is
// belt-and-braces in case a relation-missing error surfaces some other
// way. Returns [] (never throws) when the table does not exist yet —
// exactly the state of every first-ever deploy's database.
async function fetchAppliedMigrationNames(run, deployEnv, identity) {
  const probeCommand = [
    ...composePrefix(),
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    identity.databaseUser,
    '-d',
    identity.databaseName,
    '-tA',
    '-c',
    PRISMA_MIGRATIONS_EXISTS_PROBE_SQL,
  ];
  let tableExists;
  try {
    const probe = await run(probeCommand, deployEnv);
    tableExists = (probe.stdout ?? '').trim() === 't';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (RELATION_MISSING_PATTERN.test(message)) {
      tableExists = false;
    } else {
      throw error;
    }
  }
  if (!tableExists) return [];

  const appliedResult = await run(
    [
      ...composePrefix(),
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      identity.databaseUser,
      '-d',
      identity.databaseName,
      '-tA',
      '-c',
      APPLIED_MIGRATIONS_SQL,
    ],
    deployEnv,
  );
  return parsePsqlList(appliedResult.stdout);
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

  // Set once per run, from this run's env file — every composePrefix() call
  // below (32 of them) and the composeArgs handed to backup/drill agree.
  activeComposeFileArgs = composeFileArgs(fileEnv);

  if (options.skipBackup && (fileEnv.NODE_ENV ?? '').trim() === 'production') {
    return result(
      1,
      '',
      '--skip-backup is refused: the deployment env file declares NODE_ENV=production. Backups are mandatory for a production blue-green deployment.\n',
    );
  }

  const composeArgs = [...activeComposeFileArgs, '-p', PROJECT_NAME];
  const cutoverLockPath = join(resolvedStateDir, 'cutover.lock');

  if (options.detach) {
    // M6 fix: probe the lock in the FOREGROUND before spawning — acquire
    // then immediately release, so contention fails loudly here rather
    // than silently inside the detached child (whose failure the caller
    // would only discover by tailing the log later).
    try {
      mkdirSync(resolvedStateDir, { recursive: true });
      const probeLock = acquireCutoverLock({ lockPath: cutoverLockPath });
      releaseCutoverLock(probeLock);
    } catch (error) {
      return result(1, '', `Blue-green ${options.command} failed before detaching: ${redact(error)}\n`);
    }
    try {
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

  // VM-cutover defect 2a: an UNEXPECTED throw between ensure-db and the
  // Caddy switch (a bare `await run(...)` in worktree/build/quiesce, a
  // programming error, anything) reaches here rather than one of
  // executeDeploy's own failure returns. `dbGuard` (only ever set by
  // executeDeploy, and a no-op once the cutover is recorded) closes that
  // path too. Done while this run still holds the cutover lock, before the
  // release below.
  let unexpectedDbNote = '';
  if (operationError && deps.dbGuard) {
    unexpectedDbNote = await deps.dbGuard.stop();
  }

  try {
    releaseCutoverLock(ownedLock);
  } catch (error) {
    const priorError = deployResult?.stderr
      ? `${deployResult.stderr.trimEnd()}\n`
      : operationError
        ? `Blue-green ${options.command} failed unexpectedly: ${redact(operationError)}${unexpectedDbNote ? `.${unexpectedDbNote}` : ''}\n`
        : '';
    return result(
      1,
      deployResult?.stdout ?? '',
      `${priorError}Blue-green ${options.command} could not release the cutover lock: ${redact(error)}. Do not start another deploy or rollback until the lock owner and runtime state are reconciled.\n`,
    );
  }

  if (operationError) {
    return result(
      1,
      deployResult?.stdout ?? '',
      `Blue-green ${options.command} failed: ${redact(operationError)}${unexpectedDbNote ? `.${unexpectedDbNote}` : ''}\n`,
    );
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
  // Only probe once the cheap, pure env checks above already pass — no
  // command (not even a harmless `--version` probe) may run while a
  // known-bad env file would refuse the deploy anyway (I4's own
  // "no docker/git command may run before preflight passes" invariant).
  // Still runs BEFORE any real git/docker/wget call is attempted: catches a
  // missing host binary here instead of deep into the run (the acceptance-
  // run defect — a missing host wget surfaced only at phase 12, AFTER
  // traffic had already switched).
  if (issues.length === 0) {
    const missingBinaries = await missingHostBinaries(runCommand);
    if (missingBinaries.length > 0) {
      issues.push(`Required host binaries not found on PATH: ${missingBinaries.join(', ')}`);
    }
  }
  // VM-cutover defect 2b: only once docker is known to exist (the probe
  // above) — and still before any real deploy command — refuse outright if
  // another stack is already attached to the volumes this deployment will
  // mount.
  if (issues.length === 0) {
    issues.push(...(await volumesInUseByOtherStacks(runCommand, deploymentVolumeNames(fileEnv))));
  }
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

  // Phase 1.5: ensure-db
  // P3: a first deploy on a stopped stack (the VM cutover, or any host where
  // the stack was `down`) has no running db for phase 2's `exec db pg_dump`
  // or phase 6's `exec db psql` to reach. Idempotent when db is already up.
  writeDeployStatus(resolvedStateDir, 'ensure-db', 'starting db if not already running');
  // VM-cutover defect 2a: whether the db was ALREADY running decides who
  // owns its lifetime. `compose ps --status running -q db` prints one
  // container id per line for a running db and nothing at all otherwise —
  // one cheap, side-effect-free command, and the whole detection is a
  // single injected-runCommand call, so a test stubs "already running" or
  // "not running" just by choosing that call's stdout.
  let dbWasAlreadyRunning = false;
  let dbPriorStateUnknown = false;
  try {
    const dbPs = await run([...composePrefix(), 'ps', '--status', 'running', '-q', 'db'], deployEnv);
    dbWasAlreadyRunning = ((dbPs?.stdout ?? '') + '').trim() !== '';
  } catch {
    // Could not tell. Never claim to have started (and therefore never
    // silently stop) a db that might have been serving before this deploy;
    // the abort note below says so explicitly instead of guessing.
    dbPriorStateUnknown = true;
  }

  // The engine may stop the db again ONLY when this deploy is what started
  // it, and only before traffic has moved. `stop()` is idempotent, returns
  // the exact sentence to append to a failure message, and never throws:
  // a stop that itself fails must be reported as "still running", never
  // swallowed into an implied clean state.
  const dbGuard = {
    stoppable: false,
    handled: false,
    cutoverDone: false,
    // Set only on ensure-db's own `up` failure, where a container may never
    // have been created at all — see that path for why the wording differs.
    startWording: false,
    async stop() {
      if (this.handled || this.cutoverDone) return '';
      if (!this.stoppable) {
        return dbPriorStateUnknown
          ? ' The engine could not determine whether the db service was already running before this deploy, so it was left running: check it by hand and stop it if this deploy started it, before starting any other stack on these volumes.'
          : '';
      }
      this.handled = true;
      try {
        await run([...composePrefix(), 'stop', 'db'], deployEnv);
        return this.startWording
          ? ' `compose stop db` has been issued for the db this deploy was starting, so nothing this deploy started is left running on these volumes.'
          : ' The db service this deploy started has been stopped again.';
      } catch (stopError) {
        return ` The db service this deploy started could NOT be stopped (${redact(stopError)}) and is STILL RUNNING on this deployment's volumes: stop it by hand (docker compose ${composeArgs.join(' ')} stop db) before starting any other stack on these volumes.`;
      }
    },
  };
  deps.dbGuard = dbGuard;
  const stopDbOnAbort = () => dbGuard.stop();

  try {
    await run([...composePrefix(), 'up', '-d', '--wait', 'db'], deployEnv);
  } catch (error) {
    // `up --wait` can fail with the container left created/running (an
    // unhealthy start), so a db this deploy tried to start is still this
    // deploy's to clean up. Round-2 fix: the failure may equally have left
    // NO container at all, so this path gets its own wording — "stopped
    // again" would overclaim — while still actually issuing the stop.
    if (!dbWasAlreadyRunning && !dbPriorStateUnknown) {
      dbGuard.stoppable = true;
      dbGuard.startWording = true;
    }
    return result(
      1,
      '',
      `Blue-green deploy failed: could not start the db service: ${redact(error)}.${await stopDbOnAbort()}\n`,
    );
  }
  if (!dbWasAlreadyRunning && !dbPriorStateUnknown) dbGuard.stoppable = true;

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
        ...databaseIdentity(fileEnv),
        // I3 fix: was hardcoded to backup.mjs's own default everywhere —
        // '' counts as unset too (P1 convention), so an operator overriding
        // the documents volume name in the env file actually reaches the
        // backup.
        documentsVolume: fileEnv.BLUEGREEN_DOCUMENTS_VOLUME || undefined,
        commit: targetCommit,
        activeColor: oldColor,
        now,
      });
    } catch (error) {
      return result(
        1,
        '',
        `Blue-green deploy failed: pre-migration backup failed: ${redact(error)}.${await stopDbOnAbort()}\n`,
      );
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
  // M5 fix: a reused worktree directory might belong to a DIFFERENT commit
  // (an interrupted prior attempt, or a name collision) — verify it and
  // remove+recreate rather than silently building the wrong source.
  if (existsSync(releaseDir)) {
    let existingHead = '';
    try {
      const check = await run(['git', '-C', releaseDir, 'rev-parse', 'HEAD']);
      existingHead = (check.stdout ?? '').trim();
    } catch {
      existingHead = '';
    }
    if (existingHead !== targetCommit) {
      try {
        await run(['git', 'worktree', 'remove', releaseDir, '--force']);
      } catch {
        // Best-effort; rmSync below covers a worktree git no longer tracks.
      }
      rmSync(releaseDir, { recursive: true, force: true });
      await run(['git', 'worktree', 'add', releaseDir, targetCommit]);
    }
  } else {
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
  await run([...composePrefix(), 'up', '-d', '--wait', 'db'], deployEnv);
  // C1 fix: fetchAppliedMigrationNames survives a fresh database with no
  // "_prisma_migrations" relation yet (every first-ever deploy).
  const appliedNames = await fetchAppliedMigrationNames(run, deployEnv, databaseIdentity(fileEnv));
  const migrationsDir = join(releaseDir, ...MIGRATIONS_RELATIVE);
  const { pending, unknownApplied } = pendingMigrations(migrationsDir, appliedNames);
  const migrationBatch = readMigrationBatch(migrationsDir, pending);
  const gate = gateMigrations(migrationBatch, { allowDestructive: options.allowDestructiveMigration });
  let unknownAppliedWarning = '';
  if (unknownApplied.length > 0) {
    unknownAppliedWarning = `WARNING: the live database has ${unknownApplied.length} applied migration(s) this release's checkout does not contain (${unknownApplied.join(', ')}) — this release is OLDER than the database, which is expected during a rollback-style deploy.\n`;
  }
  // M1 fix: a single deduped 'gate' status entry (never two writes for the
  // same phase) carrying the full picture, including the unknownApplied
  // warning inline rather than as a second write.
  writeDeployStatus(
    resolvedStateDir,
    'gate',
    `checked migration safety: ${pending.length} pending, ${gate.blocked.length} blocked, ${gate.warned.length} warned${unknownApplied.length > 0 ? `; ${unknownAppliedWarning.trim()}` : ''}`,
  );
  if (!gate.ok) {
    const findings = gate.blocked
      .map((finding) => `- [${finding.id}] ${finding.migration}: ${finding.excerpt}`)
      .join('\n');
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy aborted: migration gate blocked ${gate.blocked.length} finding(s). Pass --allow-destructive-migration only after confirming the old colour tolerates these changes.${await stopDbOnAbort()}\n${findings}\n`,
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
      if (oldColor) await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], oldEnv);
    } catch {
      // Best-effort restart; the original migration error is what matters.
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: migration failed: ${redact(error)}. Jobs were restarted on the old tag (${oldCommit ?? 'none'}); the old colour was never touched and remains serving.${await stopDbOnAbort()}\n`,
    );
  }

  // Phase 9: up (named services only — never implicitly touches scheduler)
  writeDeployStatus(resolvedStateDir, 'up', `starting ${target} api/web`);
  try {
    await run(
      [...composePrefix(), '--profile', target, 'up', '-d', '--wait', `api-${target}`, `web-${target}`],
      deployEnv,
    );
  } catch (error) {
    // I1 fix: this used to be a bare await with no recovery — a failure
    // here (e.g. api/web-${target} never becomes healthy) ran AFTER
    // quiesce (the scheduler was stopped at phase 7) and left it stopped
    // forever, even though the old colour is what keeps serving. Same
    // recovery as candidate-smoke/caddy-reload below: restart jobs on the
    // old tag.
    let recoveryNote = '';
    if (oldColor) {
      try {
        const oldEnv = envFor(oldCommit ?? UNBUILT_TAG);
        await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], oldEnv);
        recoveryNote = ` Jobs were restarted on the old tag (${oldCommit}).`;
      } catch (restartError) {
        recoveryNote = ` Restarting jobs on the old tag also failed: ${redact(restartError)}.`;
      }
    } else {
      recoveryNote = ' No previous colour to revert to (first deploy).';
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: starting ${target} containers failed: ${redact(error)}. Traffic was never switched; the old colour remains live.${recoveryNote}${await stopDbOnAbort()}\n`,
    );
  }

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
    // I5 fix: candidate-smoke failure previously left the scheduler
    // stopped (it was stopped at quiesce/phase 7) even though the old
    // colour is still what serves traffic. Restart it on the old tag —
    // same recovery as a migrate failure. M2: skip cleanly on a first
    // deploy, where there is no old colour to restart anything on.
    let recoveryNote = '';
    if (oldColor) {
      try {
        const oldEnv = envFor(oldCommit ?? UNBUILT_TAG);
        await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], oldEnv);
        recoveryNote = ` Jobs were restarted on the old tag (${oldCommit}).`;
      } catch (restartError) {
        recoveryNote = ` Restarting jobs on the old tag also failed: ${redact(restartError)}.`;
      }
    } else {
      recoveryNote = ' No previous colour to revert to (first deploy).';
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: candidate smoke test failed on the ${target} colour: ${redact(error)}. Traffic was never switched; the old colour remains live.${recoveryNote}${await stopDbOnAbort()}\n`,
    );
  }

  // Phase 11: switch
  writeDeployStatus(resolvedStateDir, 'switch', `pointing Caddy at ${target}`);
  try {
    await run([...composePrefix(), 'up', '-d', '--wait', 'caddy'], deployEnv);
  } catch (error) {
    // I1 fix: same bare-await-with-no-recovery defect as phase 9 — a
    // failure starting/waiting on Caddy here runs AFTER quiesce stopped
    // the scheduler, and nothing else on this path would ever restart it.
    // No upstream file has been touched yet at this point, so there is
    // nothing to restore — just the same old-tag jobs recovery.
    let recoveryNote = '';
    if (oldColor) {
      try {
        const oldEnv = envFor(oldCommit ?? UNBUILT_TAG);
        await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], oldEnv);
        recoveryNote = ` Jobs were restarted on the old tag (${oldCommit}).`;
      } catch (restartError) {
        recoveryNote = ` Restarting jobs on the old tag also failed: ${redact(restartError)}.`;
      }
    } else {
      recoveryNote = ' No previous colour to revert to (first deploy).';
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: starting Caddy failed while switching to ${target}: ${redact(error)}. Traffic was never switched; the old colour remains live.${recoveryNote}${await stopDbOnAbort()}\n`,
    );
  }
  const previousUpstreams = existsSync(deps.activeUpstreamsPath) ? readFileSync(deps.activeUpstreamsPath, 'utf8') : null;
  writeFileSync(deps.activeUpstreamsPath, renderUpstreams(target));
  try {
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'],
      deployEnv,
    );
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//tmp/caddy-admin.sock'],
      deployEnv,
    );
  } catch (error) {
    if (previousUpstreams !== null) writeFileSync(deps.activeUpstreamsPath, previousUpstreams);
    try {
      await run(
        [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//tmp/caddy-admin.sock'],
        deployEnv,
      );
    } catch {
      // Best-effort restore reload; the original reload error is what matters.
    }
    // I5 fix: same as candidate-smoke — the scheduler was stopped at
    // quiesce and is never otherwise restarted on this failure path.
    let recoveryNote = '';
    if (oldColor) {
      try {
        const oldEnv = envFor(oldCommit ?? UNBUILT_TAG);
        await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], oldEnv);
        recoveryNote = ` Jobs were restarted on the old tag (${oldCommit}).`;
      } catch (restartError) {
        recoveryNote = ` Restarting jobs on the old tag also failed: ${redact(restartError)}.`;
      }
    } else {
      recoveryNote = ' No previous colour to revert to (first deploy).';
    }
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed: Caddy reload failed while switching to ${target}: ${redact(error)}. The previous upstream file was restored and reloaded; traffic was never switched.${recoveryNote}${await stopDbOnAbort()}\n`,
    );
  }

  // VM-cutover defect 2a: traffic has now actually moved. From here on the
  // db legitimately stays up whatever happens — the new colour is serving
  // from it, and even the public-smoke revert path below puts the OLD
  // colour back in front of it. Nothing past this line may stop it.
  dbGuard.cutoverDone = true;

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
    // M2 fix: a first deploy has no old colour to revert to at all — the
    // old code still attempted a caddy restore-and-reload plus a
    // reverify-against-the-old-commit wget, both meaningless (and
    // confusing: "expected the old commit null") when there is no old
    // colour. Skip the whole revert block with a clear message instead.
    if (!oldColor) {
      return result(
        1,
        unknownAppliedWarning,
        `Blue-green deploy failed: public smoke test failed after switching to ${target}: ${redact(error)}. No previous colour to revert to (first deploy) — traffic remains on ${target}, which failed its own public smoke test; inspect manually before retrying.\n`,
      );
    }
    if (previousUpstreams !== null) writeFileSync(deps.activeUpstreamsPath, previousUpstreams);
    let revertError = '';
    try {
      await run(
        [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//tmp/caddy-admin.sock'],
        deployEnv,
      );
      const oldEnv = envFor(oldCommit ?? UNBUILT_TAG);
      if (oldColor) await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], oldEnv);
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

  // I2 fix: state.json must become truthful the INSTANT traffic is
  // actually serving ${target} — the moment public smoke passes, not 15
  // lines later at "record". A failure in jobs/retire below must never
  // leave state.json pointing at the retiring old colour while Caddy is
  // already sending real traffic to the new one (the next deploy would
  // then target the LIVE colour and could recreate serving containers).
  // State-write is not itself a phase; it happens here, before phase 13.
  //
  // Fix round 2 (I2's last window): this write itself can fail (disk full,
  // a stray state.json.tmp DIRECTORY left behind causing EISDIR on the
  // rename, permissions, ...) — AFTER traffic has already been switched
  // and verified. A bare filesystem error here would abort with a message
  // naming neither the fact that traffic already moved nor what state.json
  // still (wrongly) says. Guard it explicitly and say both, verbatim,
  // so the operator can act on the message alone without re-deriving
  // anything from logs.
  try {
    writeState(resolvedStateDir, {
      activeColor: target,
      commit: targetCommit,
      previousColor: oldColor,
      previousCommit: oldCommit,
      deployedAt: now().toISOString(),
      rollbackable: !destructiveOverrideUsed,
    });
  } catch (error) {
    try {
      writeDeployStatus(
        resolvedStateDir,
        'state-write-failed',
        `traffic already switched to ${target}@${targetCommit} but writeState failed: ${redact(error)}`,
      );
    } catch {
      // Best-effort; the return below carries the actionable message
      // regardless of whether this log write itself succeeded.
    }
    return result(
      1,
      unknownAppliedWarning,
      `Traffic has ALREADY been switched to ${target} (commit ${targetCommit}) and verified, but recording state failed (${redact(error)}). state.json still names ${oldColor ?? 'none'}. DO NOT run another deploy until state is corrected: write { activeColor: '${target}', commit: '${targetCommit}' } manually or fix the underlying filesystem issue and re-run 'status'.\n`,
    );
  }

  // Phase 13: jobs
  writeDeployStatus(resolvedStateDir, 'jobs', `starting scheduler on ${targetCommit}`);
  try {
    await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], deployEnv);
  } catch (error) {
    return result(
      1,
      unknownAppliedWarning,
      `Blue-green deploy failed after cutover: starting the scheduler on ${targetCommit} failed: ${redact(error)}. Traffic is serving ${target} and state is recorded; scheduler restart/retire incomplete — inspect with status, re-run jobs manually or rollback.\n`,
    );
  }

  // Phase 14: retire
  if (oldColor) {
    writeDeployStatus(resolvedStateDir, 'retire', `stopping ${oldColor} (containers kept)`);
    try {
      await run([...composePrefix(), 'stop', `api-${oldColor}`, `web-${oldColor}`], deployEnv);
    } catch (error) {
      return result(
        1,
        unknownAppliedWarning,
        `Blue-green deploy failed after cutover: stopping the old colour (${oldColor}) failed: ${redact(error)}. Traffic is serving ${target} and state is recorded; scheduler restart/retire incomplete — inspect with status, re-run jobs manually or rollback.\n`,
      );
    }
  } else {
    writeDeployStatus(resolvedStateDir, 'retire', 'no previous colour to retire (first deploy)');
  }

  // Phase 15: record (state was already written above, right after
  // public smoke succeeded — see the I2 note; this phase now only prunes
  // retained backups).
  writeDeployStatus(resolvedStateDir, 'record', 'state already recorded after public smoke; pruning backups');
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

  // Fix round 5: same fail-fast as executeDeploy's phase-1 preflight, and
  // for the same reason — rollback also spawns a host wget (post-rollback
  // smoke) and git/docker throughout, and a missing one should refuse here
  // rather than surface as an opaque failure deep into the run. Only after
  // every pure state check above already refused to run any command at
  // all (mirrors the state-based refusals' own "no docker/git command may
  // run" invariant).
  const missingBinaries = await missingHostBinaries(runCommand);
  if (missingBinaries.length > 0) {
    return result(
      1,
      '',
      `Blue-green rollback refused: required host binaries not found on PATH: ${missingBinaries.join(', ')}\n`,
    );
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
  // M4 fix: executeRollback previously wrote no deploy-status entries at
  // all. Every step below now logs one, mirroring the deploy path.
  writeDeployStatus(resolvedStateDir, 'rollback-verify', `checking ${previousColor} containers exist`);
  const psResult = await run([...composePrefix(), 'ps', '-a'], rollbackEnv);
  if (!(psResult.stdout ?? '').includes(`api-${previousColor}`)) {
    return result(
      1,
      '',
      `Blue-green rollback refused: no containers found for the previous colour (${previousColor}); it may have been pruned.\n`,
    );
  }

  // I2 fix: previously reloaded Caddy onto the previous colour's containers
  // BEFORE starting them (and without --wait), so a rollback could point
  // live traffic at a colour that wasn't confirmed healthy yet — mirrors
  // deploy's own phase 9 (up --wait) -> phase 11 (switch) ordering: bring
  // the previous colour up and confirmed healthy FIRST, only then reload
  // Caddy onto it.
  writeDeployStatus(resolvedStateDir, 'rollback-up', `starting ${previousColor} containers`);
  try {
    await run(
      [...composePrefix(), 'up', '-d', '--wait', `api-${previousColor}`, `web-${previousColor}`],
      rollbackEnv,
    );
  } catch (error) {
    // Micro-round fix: this was a bare await with no failure message at
    // all. Matches the deploy path's own convention (e.g. phase 9/11's
    // "Traffic was never switched; the old colour remains live.") — Caddy
    // has not been touched yet at this point, so traffic is still on
    // whatever colour was live before the rollback started.
    return result(
      1,
      '',
      `Blue-green rollback failed: starting ${previousColor} containers failed: ${redact(error)}. Traffic was never switched; ${currentColor ?? 'the current colour'} remains live.\n`,
    );
  }

  writeDeployStatus(resolvedStateDir, 'rollback-switch', `pointing Caddy at ${previousColor}`);
  const previousUpstreams = existsSync(deps.activeUpstreamsPath) ? readFileSync(deps.activeUpstreamsPath, 'utf8') : null;
  writeFileSync(deps.activeUpstreamsPath, renderUpstreams(previousColor));
  try {
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'],
      rollbackEnv,
    );
    await run(
      [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//tmp/caddy-admin.sock'],
      rollbackEnv,
    );
  } catch (error) {
    if (previousUpstreams !== null) writeFileSync(deps.activeUpstreamsPath, previousUpstreams);
    try {
      await run(
        [...composePrefix(), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//tmp/caddy-admin.sock'],
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
  writeDeployStatus(resolvedStateDir, 'rollback-jobs', `starting scheduler on ${previousCommit}`);
  await run([...composePrefix(), 'up', '-d', '--wait', 'scheduler'], rollbackEnv);

  // I3 fix: a failed post-rollback smoke check (command failure OR an
  // observed commit that doesn't match) previously just returned an error
  // with no record, while Caddy may already be pointing at the previous
  // colour — a "half-rolled with no record" state. Never flip state.json
  // in this branch; log a dedicated 'rollback-uncertain' status entry
  // naming the observed vs expected commit and say so explicitly.
  writeDeployStatus(resolvedStateDir, 'rollback-smoke', 'verifying traffic through the front door');
  const smokeCommand = [
    'wget',
    '-qO-',
    '--header',
    `${READINESS_HEADER}: ${readinessKey(fileEnv)}`,
    `http://127.0.0.1:${frontPort(fileEnv)}${READINESS_PATH}`,
  ];
  let smokeBody;
  try {
    const publicSmoke = await run(smokeCommand, rollbackEnv);
    smokeBody = JSON.parse(publicSmoke.stdout || '{}');
  } catch (error) {
    writeDeployStatus(resolvedStateDir, 'rollback-uncertain', `post-rollback smoke command failed: ${redact(error)}`);
    return result(
      1,
      '',
      `Blue-green rollback failed: public smoke test after rollback failed: ${redact(error)}. State uncertain — traffic may be on ${previousColor} serving an unexpected commit; inspect manually.\n`,
    );
  }
  if (smokeBody.buildCommit !== previousCommit) {
    writeDeployStatus(
      resolvedStateDir,
      'rollback-uncertain',
      `observed=${JSON.stringify(smokeBody.buildCommit)} expected=${previousCommit}`,
    );
    return result(
      1,
      '',
      `Blue-green rollback failed: post-rollback verification observed buildCommit=${JSON.stringify(smokeBody.buildCommit)} but expected ${previousCommit}. State uncertain — traffic may be on ${previousColor} serving an unexpected commit; inspect manually.\n`,
    );
  }
  if (currentColor) {
    writeDeployStatus(resolvedStateDir, 'rollback-retire', `stopping ${currentColor}`);
    await run([...composePrefix(), 'stop', `api-${currentColor}`, `web-${currentColor}`], rollbackEnv);
  }

  writeDeployStatus(resolvedStateDir, 'rollback-record', 'writing rollback state');
  // Fix round 3 (I2's last window, rollback side): same hazard as the
  // deploy path's post-cutover writeState — traffic has ALREADY been
  // rolled back to previousColor and verified by the smoke check above,
  // so a bare writeState failure here (EISDIR from a stray
  // state.json.tmp directory, disk full, permissions, ...) must not abort
  // with a raw filesystem error that names neither fact. Guard it exactly
  // like the deploy path: best-effort status entry, then an explicit,
  // operator-actionable message naming the verified colour and commit
  // verbatim.
  try {
    writeState(resolvedStateDir, {
      activeColor: previousColor,
      commit: previousCommit,
      previousColor: currentColor,
      previousCommit: currentCommit,
      deployedAt: now().toISOString(),
      rollbackable: true,
    });
  } catch (error) {
    try {
      writeDeployStatus(
        resolvedStateDir,
        'state-write-failed',
        `traffic already rolled back to ${previousColor}@${previousCommit} but writeState failed: ${redact(error)}`,
      );
    } catch {
      // Best-effort; the return below carries the actionable message
      // regardless of whether this log write itself succeeded.
    }
    return result(
      1,
      '',
      `Traffic has ALREADY been rolled back to ${previousColor} (commit ${previousCommit}) and verified, but recording state failed (${redact(error)}). state.json still names ${currentColor ?? 'none'}. DO NOT deploy until state is corrected: write { activeColor: '${previousColor}', commit: '${previousCommit}' } manually or fix the underlying filesystem issue and re-run 'status'.\n`,
    );
  }

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
    ...databaseIdentity(fileEnv),
    // I3 fix: see the executeDeploy backup call for why.
    documentsVolume: fileEnv.BLUEGREEN_DOCUMENTS_VOLUME || undefined,
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
    ...databaseIdentity(fileEnv),
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
