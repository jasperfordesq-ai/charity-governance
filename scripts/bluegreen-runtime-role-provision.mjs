// Guarded provisioning for the optional blue-green application database role.
// This operation does not switch a running application to that role.
import { randomUUID, createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  composeFileArgs,
  databaseIdentity,
  defaultRunCommand,
  deploymentVolumeNames,
  parseEnvFile,
  preflightIssues,
  reconcileAppRuntimeRole,
  verifyAppRuntimePassword,
  verifyAppRuntimeRole,
  volumesInUseByOtherStacks,
} from './bluegreen-deploy.mjs';
import { readState } from './bluegreen/lib.mjs';
import { runBackup, runRestoreDrill } from './bluegreen/backup.mjs';
import { acquireProductionCutoverLock, releaseProductionCutoverLock } from './production-cutover-lock.mjs';
import { validateLocalDockerEndpoint } from './run-isolated-e2e.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = 'charitypilot-bluegreen';
const canonicalRemotes = new Set([
  'https://github.com/jasperfordesq-ai/charity-governance.git',
  'https://github.com/jasperfordesq-ai/charity-governance',
  'git@github.com:jasperfordesq-ai/charity-governance.git',
  'git@github.com:jasperfordesq-ai/charity-governance',
]);
const forbiddenDockerKeys = new Set([
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  'DOCKER_TLS', 'DOCKER_CONFIG', 'BUILDX_BUILDER',
]);

export function parseProvisionArgs(args) {
  if (args[0] !== 'provision') throw new Error('Expected provision command');
  const options = { envFile: null, stateDir: join(repoRoot, '.bluegreen', 'state'),
    receiptDir: null, resume: false, preflight: false };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--resume') { options.resume = true; continue; }
    if (arg === '--preflight') { options.preflight = true; continue; }
    if (arg === '--env-file' || arg === '--state-dir' || arg === '--receipt-dir') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--env-file') options.envFile = value;
      else if (arg === '--state-dir') options.stateDir = value;
      else options.receiptDir = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.envFile || !options.receiptDir || !isAbsolute(options.envFile) ||
      !isAbsolute(options.stateDir) || !isAbsolute(options.receiptDir)) {
    throw new Error('Provisioning requires absolute --env-file, --state-dir and --receipt-dir paths');
  }
  options.envFile = resolve(options.envFile);
  options.stateDir = resolve(options.stateDir);
  options.receiptDir = resolve(options.receiptDir);
  if (options.resume && options.preflight) throw new Error('--resume and --preflight cannot be combined');
  return options;
}

export function protectedRegularFile(path, label, platform) {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile() ||
      realpathSync(path) !== resolve(path)) {
    throw new Error(`${label} must be an existing non-symlink absolute regular file`);
  }
  if (platform === 'linux' && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${label} must be owner-only (mode 0600 or stricter)`);
  }
}

export function protectedDirectories(options) {
  if (!existsSync(options.stateDir) || !statSync(options.stateDir).isDirectory() ||
      realpathSync(options.stateDir) !== options.stateDir) {
    throw new Error('State directory must exist and must not be a symlink');
  }
  if (!existsSync(options.receiptDir) || !statSync(options.receiptDir).isDirectory() ||
      realpathSync(options.receiptDir) !== options.receiptDir ||
      (statSync(options.receiptDir).mode & 0o077) !== 0) {
    throw new Error('Receipt directory must be an existing owner-only non-symlink directory');
  }
  const receiptRelative = relative(repoRoot, options.receiptDir);
  if (!receiptRelative.startsWith('..') && !isAbsolute(receiptRelative)) {
    throw new Error('Receipt directory must be outside the source checkout');
  }
  const homeRelative = relative(homedir(), options.receiptDir);
  if (homeRelative.startsWith('..') || isAbsolute(homeRelative)) {
    throw new Error('Receipt directory must be inside the operator home');
  }
  for (let parent = dirname(options.receiptDir); parent !== dirname(homedir()); parent = dirname(parent)) {
    if (!existsSync(parent) || realpathSync(parent) !== resolve(parent) ||
        (statSync(parent).mode & 0o022) !== 0) {
      throw new Error('Receipt directory ancestry must be real and non-writable by group or others');
    }
    if (parent === homedir()) break;
  }
}

function cleanDockerEnvironment(source) {
  const overrides = Object.keys(source).filter((key) =>
    (forbiddenDockerKeys.has(key.toUpperCase()) || key.toUpperCase().startsWith('COMPOSE_')) &&
    String(source[key] ?? '').trim() !== '');
  if (overrides.length) throw new Error(`Docker/Compose ambient overrides are forbidden: ${overrides.join(', ')}`);
  const cleaned = { ...source };
  for (const key of Object.keys(cleaned)) {
    if (forbiddenDockerKeys.has(key.toUpperCase()) || key.toUpperCase().startsWith('COMPOSE_')) delete cleaned[key];
  }
  return cleaned;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertProvisionDockerEndpoint(endpoint) {
  validateLocalDockerEndpoint(endpoint);
  if (endpoint !== 'unix:///var/run/docker.sock') {
    throw new Error('Provisioning requires the Linux local /var/run/docker.sock endpoint');
  }
}

function writeNewDurably(path, value) {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(descriptor);
  try {
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

function pinnedRunner(endpoint, environment, underlying) {
  return (command, options = {}) => {
    const actualCommand = command[0] === 'docker'
      ? ['docker', '--host', endpoint, ...command.slice(1)]
      : command;
    return underlying(actualCommand, { ...options, env: { ...environment, ...(options.env ?? {}) } });
  };
}

function composeEnvironment(cleaned, fileEnv, envFile, state) {
  return {
    ...cleaned,
    BLUEGREEN_ENV_FILE: envFile,
    BLUEGREEN_APP_ENV_FILE: fileEnv.BLUEGREEN_APP_ENV_FILE,
    BLUEGREEN_BLUE_TAG: state.activeColor === 'blue' ? state.commit : state.previousCommit ?? 'unbuilt',
    BLUEGREEN_GREEN_TAG: state.activeColor === 'green' ? state.commit : state.previousCommit ?? 'unbuilt',
    BLUEGREEN_ACTIVE_TAG: state.commit,
    BLUEGREEN_ORIGIN: fileEnv.BLUEGREEN_ORIGIN ?? '',
    BLUEGREEN_FRONT_PORT: fileEnv.BLUEGREEN_FRONT_PORT || '8080',
  };
}

export async function provisionRuntimeRole(args, dependencies = {}) {
  const options = parseProvisionArgs(args);
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('The blue-green role provisioner is supported only on the Linux VM');
  const processEnv = dependencies.processEnv ?? process.env;
  const underlying = dependencies.runCommand ?? defaultRunCommand;
  const backup = dependencies.runBackup ?? runBackup;
  const restoreDrill = dependencies.runRestoreDrill ?? runRestoreDrill;
  const now = dependencies.now ?? (() => new Date());
  const checkFile = dependencies.checkFile ?? protectedRegularFile;
  const checkDirectories = dependencies.checkDirectories ?? protectedDirectories;
  const checkDockerEndpoint = dependencies.checkDockerEndpoint ?? assertProvisionDockerEndpoint;
  const cleanedEnv = cleanDockerEnvironment(processEnv);
  checkFile(options.envFile, 'Owner env file', platform);
  checkDirectories(options);
  const fileEnv = parseEnvFile(options.envFile);
  const issues = preflightIssues({ fileEnv, resolvedEnvFilePath: options.envFile });
  if (issues.length) throw new Error(`Blue-green provisioning preflight failed: ${issues.join('; ')}`);
  if (!fileEnv.BLUEGREEN_APP_ENV_FILE) throw new Error('A separate BLUEGREEN_APP_ENV_FILE is required');
  checkFile(fileEnv.BLUEGREEN_APP_ENV_FILE, 'Application env file', platform);
  const appUrl = new URL(parseEnvFile(fileEnv.BLUEGREEN_APP_ENV_FILE).DATABASE_URL);
  const role = decodeURIComponent(appUrl.username);
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(role)) throw new Error('Invalid application role identifier');
  const ownerEnvSha256 = sha256File(options.envFile);
  const appEnvSha256 = sha256File(fileEnv.BLUEGREEN_APP_ENV_FILE);
  const state = readState(options.stateDir);
  if (!state || state.corrupt || !state.activeColor || !state.commit) {
    throw new Error('A valid existing blue-green deploy state is required');
  }
  const volumeNames = deploymentVolumeNames(fileEnv);
  const composeArgs = [...composeFileArgs(fileEnv), '-p', project];
  const compose = ['docker', 'compose', ...composeArgs];
  const environment = composeEnvironment(cleanedEnv, fileEnv, options.envFile, state);
  const pendingPath = join(options.receiptDir, 'runtime-role-provision-pending.json');
  const lock = acquireProductionCutoverLock({ lockPath: join(options.stateDir, 'cutover.lock') });
  try {
    const context = await underlying(['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
      { env: cleanedEnv, cwd: repoRoot });
    let endpoint;
    try { endpoint = JSON.parse(context.stdout.trim()); }
    catch { throw new Error('Docker context returned an invalid endpoint'); }
    checkDockerEndpoint(endpoint);
    const run = pinnedRunner(endpoint, environment, underlying);
    const runWithEnv = (command, env) => run(command, { env });
    const remote = (await run(['git', 'remote', 'get-url', 'origin'])).stdout.trim();
    if (!canonicalRemotes.has(remote)) throw new Error('Git origin is not the canonical CharityPilot repository');
    const gitStatus = await run(['git', 'status', '--porcelain=v1', '--untracked-files=all']);
    if ((gitStatus.stdout ?? '').trim()) throw new Error('Source checkout must be clean');
    await run(['git', 'fetch', 'origin', 'master']);
    const head = (await run(['git', 'rev-parse', 'HEAD'])).stdout.trim();
    const origin = (await run(['git', 'rev-parse', '--verify', 'refs/remotes/origin/master^{commit}'])).stdout.trim();
    if (!head || head !== origin) throw new Error('Source HEAD must equal fresh origin/master');
    const foreign = await volumesInUseByOtherStacks(run, volumeNames);
    if (foreign.length) throw new Error(foreign.join('; '));
    const dbPs = await run([...compose, 'ps', '--status', 'running', '-q', 'db']);
    const dbId = dbPs.stdout.trim();
    if (!/^[0-9a-f]{64}$/u.test(dbId)) throw new Error('Exactly one running Compose db container is required');
    const inspected = await run(['docker', 'inspect', dbId]);
    let container;
    try { [container] = JSON.parse(inspected.stdout); }
    catch { throw new Error('Database container inspection was invalid'); }
    if (container?.Config?.Labels?.['com.docker.compose.project'] !== project ||
        container?.Config?.Labels?.['com.docker.compose.service'] !== 'db' ||
        !container?.Mounts?.some((mount) => mount.Type === 'volume' &&
          mount.Name === volumeNames.db && mount.Destination === '/var/lib/postgresql/data')) {
      throw new Error('Running db container does not match the exact Compose project and declared database volume');
    }
    const identity = databaseIdentity(fileEnv);
    const sql = `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN 'present' ELSE 'absent' END`;
    const presence = await run([...compose, 'exec', '-T', 'db', 'psql', '-X', '-A', '-t',
      '-U', identity.databaseUser, '-d', identity.databaseName, '-c', sql]);
    const stateOfRole = presence.stdout.trim();
    if (!['present', 'absent'].includes(stateOfRole)) throw new Error('Runtime role presence query failed');
    if (stateOfRole === 'present') {
      if (!await verifyAppRuntimeRole(runWithEnv, environment, fileEnv)) {
        throw new Error('Existing application role is unsafe; refuse to repurpose it');
      }
      await verifyAppRuntimePassword(run, environment, fileEnv);
    }
    if (options.preflight) {
      if (existsSync(pendingPath)) throw new Error('Pending provision receipt exists; inspect and use --resume');
      return { status: 'preflight', role, sourceCommit: head,
        activeCommit: state.commit, existingRole: stateOfRole, receiptDir: options.receiptDir };
    }
    const backupContext = {
      runCommand: run, stateDir: options.stateDir, envFile: options.envFile,
      composeArgs, env: environment, ...identity,
      documentsVolume: fileEnv.BLUEGREEN_DOCUMENTS_VOLUME || undefined,
      commit: state.commit, activeColor: state.activeColor, now,
    };
    let pending;
    if (options.resume) {
      if (!existsSync(pendingPath)) throw new Error('No pending provision receipt exists to resume');
      pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(pending.id ?? '') ||
          pending.status !== 'pending' || pending.role !== role || pending.sourceCommit !== head ||
          pending.activeCommit !== state.commit || pending.activeColor !== state.activeColor ||
          pending.ownerEnvFile !== options.envFile || pending.appEnvFile !== fileEnv.BLUEGREEN_APP_ENV_FILE ||
          pending.ownerEnvSha256 !== ownerEnvSha256 || pending.appEnvSha256 !== appEnvSha256 ||
          pending.database !== identity.databaseName || !pending.backupDir ||
          !relative(join(options.stateDir, 'backups'), resolve(pending.backupDir)) ||
          relative(join(options.stateDir, 'backups'), resolve(pending.backupDir)).startsWith('..') ||
          !existsSync(join(pending.backupDir, 'manifest.json')) ||
          sha256File(join(pending.backupDir, 'manifest.json')) !== pending.manifestSha256) {
        throw new Error('Pending provision receipt does not match source, credentials or backup evidence');
      }
    } else {
      if (existsSync(pendingPath)) throw new Error('Pending provision receipt exists; inspect and use --resume');
      const { plan } = await backup(backupContext);
      await restoreDrill({ ...backupContext, plan });
      pending = {
        id: randomUUID(), status: 'pending', startedAt: now().toISOString(),
        sourceCommit: head, activeCommit: state.commit, role,
        activeColor: state.activeColor,
        database: identity.databaseName, ownerEnvFile: options.envFile,
        appEnvFile: fileEnv.BLUEGREEN_APP_ENV_FILE,
        ownerEnvSha256, appEnvSha256, backupDir: plan.dir,
        manifestSha256: sha256File(plan.manifestFile),
      };
      writeNewDurably(pendingPath, pending);
    }
    if (options.resume) {
      const plan = { dir: pending.backupDir, dumpFile: join(pending.backupDir, 'database.dump'),
        documentsTar: join(pending.backupDir, 'documents.tar'),
        manifestFile: join(pending.backupDir, 'manifest.json') };
      await restoreDrill({ ...backupContext, plan });
    }
    checkFile(options.envFile, 'Owner env file', platform);
    checkFile(fileEnv.BLUEGREEN_APP_ENV_FILE, 'Application env file', platform);
    if (sha256File(options.envFile) !== ownerEnvSha256 ||
        sha256File(fileEnv.BLUEGREEN_APP_ENV_FILE) !== appEnvSha256) {
      throw new Error('Owner or application env file changed after preflight');
    }
    const currentState = readState(options.stateDir);
    if (!currentState || currentState.corrupt || currentState.commit !== state.commit ||
        currentState.activeColor !== state.activeColor) {
      throw new Error('Active release changed after backup rehearsal');
    }
    const dbPsAfter = await run([...compose, 'ps', '--status', 'running', '-q', 'db']);
    if (dbPsAfter.stdout.trim() !== dbId) throw new Error('Database container changed after backup rehearsal');
    const headAfter = (await run(['git', 'rev-parse', 'HEAD'])).stdout.trim();
    const statusAfter = (await run(['git', 'status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim();
    if (headAfter !== head || statusAfter) throw new Error('Source checkout changed after backup rehearsal');
    await reconcileAppRuntimeRole(run, environment, fileEnv);
    if (!await verifyAppRuntimeRole(runWithEnv, environment, fileEnv)) {
      throw new Error('Provisioned application role failed restricted privilege checks');
    }
    await verifyAppRuntimePassword(run, environment, fileEnv);
    const receiptPath = join(options.receiptDir, `runtime-role-provision-${pending.id}.json`);
    const receipt = { ...pending, status: 'complete', completedAt: now().toISOString() };
    const completedTempPath = `${receiptPath}.partial`;
    if (existsSync(receiptPath)) {
      const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (existing.status !== 'complete' || existing.id !== pending.id ||
          existing.sourceCommit !== head || existing.role !== role ||
          existing.backupDir !== pending.backupDir ||
          existing.manifestSha256 !== pending.manifestSha256 ||
          existing.activeCommit !== pending.activeCommit ||
          existing.activeColor !== pending.activeColor) {
        throw new Error('Existing completed provision receipt does not match pending operation');
      }
    } else {
      if (existsSync(completedTempPath)) {
        const partial = JSON.parse(readFileSync(completedTempPath, 'utf8'));
        if (partial.status !== 'complete' || partial.id !== pending.id ||
            partial.sourceCommit !== head || partial.role !== role ||
            partial.backupDir !== pending.backupDir ||
            partial.manifestSha256 !== pending.manifestSha256 ||
            partial.activeCommit !== pending.activeCommit ||
            partial.activeColor !== pending.activeColor) {
          throw new Error('Existing partial provision receipt does not match pending operation');
        }
        renameSync(completedTempPath, receiptPath);
      } else {
        writeNewDurably(completedTempPath, receipt);
        renameSync(completedTempPath, receiptPath);
      }
    }
    rmSync(pendingPath);
    if (process.platform !== 'win32') {
      const directory = openSync(options.receiptDir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return { role, sourceCommit: head, receiptPath, backupDir: pending.backupDir };
  } finally {
    releaseProductionCutoverLock(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await provisionRuntimeRole(process.argv.slice(2));
    if (result.status === 'preflight') {
      process.stdout.write(`Restricted role preflight passed for ${result.role} at ${result.sourceCommit}; existing role: ${result.existingRole}. No database write was performed.\n`);
    } else {
      process.stdout.write(`Restricted role ${result.role} provisioned at ${result.sourceCommit}; receipt: ${result.receiptPath}\n`);
    }
  } catch (error) {
    process.stderr.write(`Restricted role provisioning refused: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
