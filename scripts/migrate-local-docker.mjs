#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const composeArgs = ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml'];
const prismaConfigArgs = ['--config', 'apps/api/prisma.config.ts'];
const prismaSchemaArgs = ['--schema', 'apps/api/prisma/schema.prisma'];
const localAppServices = ['api', 'web'];

const commands = [
  ['docker', ...composeArgs, 'up', '--wait', '--wait-timeout', '180', '-d', 'db'],
  [
    'docker',
    ...composeArgs,
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'deps',
    'sh',
    '-lc',
    "set -eu; lock_hash=$(sha256sum package-lock.json | awk '{print $1}'); marker=node_modules/.charitypilot-package-lock.sha256; if [ -d node_modules/next ] && [ -d node_modules/@prisma/client ] && [ -f \"$marker\" ] && [ \"$(cat \"$marker\")\" = \"$lock_hash\" ]; then echo 'Using existing node_modules volume'; else npm ci --include=dev; printf '%s\\n' \"$lock_hash\" > \"$marker\"; fi && npm run build -w @charitypilot/shared && npm run db:generate -w @charitypilot/api",
  ],
  [
    'docker',
    ...composeArgs,
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'api',
    'npx',
    'prisma',
    ...prismaConfigArgs,
    'migrate',
    'deploy',
    ...prismaSchemaArgs,
  ],
  [
    'docker',
    ...composeArgs,
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'api',
    'npx',
    'prisma',
    ...prismaConfigArgs,
    'migrate',
    'status',
    ...prismaSchemaArgs,
  ],
];

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function formatCommand(command) {
  return command.map(shellQuote).join(' ');
}

function captureCommand(command, { dryRun, processEnv, spawnSyncImpl, writeOutput }) {
  if (dryRun) {
    writeOutput(`${formatCommand(command)}\n`);
    return '';
  }

  const [executable, ...args] = command;
  const result = spawnSyncImpl(executable, args, {
    cwd: repoRoot,
    env: processEnv,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `${formatCommand(command)} failed with exit code ${result.status ?? 'unknown'}`);
  }

  return result.stdout;
}

function runCommand(command, { dryRun, processEnv, spawnSyncImpl, writeOutput }) {
  if (dryRun) {
    writeOutput(`${formatCommand(command)}\n`);
    return;
  }

  const [executable, ...args] = command;
  const result = spawnSyncImpl(executable, args, {
    cwd: repoRoot,
    env: processEnv,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${formatCommand(command)} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runningLocalAppServices(context) {
  const { dryRun } = context;
  if (dryRun) {
    return localAppServices;
  }

  const output = captureCommand(['docker', ...composeArgs, 'ps', '--format', 'json'], context);
  const runningServices = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((service) => service.State === 'running')
    .map((service) => service.Service);

  const services = localAppServices.filter((service) => runningServices.includes(service));
  if (services.includes('web') && !services.includes('api')) {
    services.unshift('api');
  }

  return services;
}

function stopLocalAppServices(services, context) {
  if (services.length === 0) {
    return;
  }

  try {
    runCommand(['docker', ...composeArgs, 'stop', ...services], context);
  } catch (error) {
    context.writeOutput(`Graceful stop failed for local app services; forcing stop before dependency refresh: ${error.message}\n`);
    runCommand(['docker', ...composeArgs, 'kill', ...services], context);
  }
}

function startLocalAppServices(services, context) {
  if (services.length === 0) {
    return;
  }

  runCommand(['docker', ...composeArgs, 'up', '--wait', '--wait-timeout', '180', '-d', ...services], context);
}

export function runLocalDockerMigrations({
  args = process.argv.slice(2),
  processEnv = process.env,
  spawnSyncImpl = spawnSync,
  writeOutput = (value) => process.stdout.write(value),
} = {}) {
  for (const arg of args) {
    if (arg !== '--dry-run') {
      throw new Error(`Unknown option: ${arg}\nUsage: node scripts/migrate-local-docker.mjs [--dry-run]`);
    }
  }

  const context = {
    dryRun: args.includes('--dry-run'),
    processEnv,
    spawnSyncImpl,
    writeOutput,
  };
  const localAppServicesRunningBeforeMigration = runningLocalAppServices(context);

  stopLocalAppServices(localAppServicesRunningBeforeMigration, context);

  let pendingError = null;
  try {
    for (const command of commands) {
      runCommand(command, context);
    }
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      startLocalAppServices(localAppServicesRunningBeforeMigration, context);
    } catch (restartError) {
      if (!pendingError) {
        throw restartError;
      }
      pendingError.message = `${pendingError.message}\nFailed to restart local app services: ${restartError.message}`;
    }
  }

  if (!context.dryRun) {
    writeOutput('Local Docker migrations applied and Prisma migration status verified.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runLocalDockerMigrations();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.message.startsWith('Unknown option:') ? 2 : 1);
  }
}
