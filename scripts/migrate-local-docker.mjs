#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const composeArgs = ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml'];
const prismaConfigArgs = ['--config', 'apps/api/prisma.config.ts'];
const prismaSchemaArgs = ['--schema', 'apps/api/prisma/schema.prisma'];
const dryRun = process.argv.includes('--dry-run');
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
    'npm ci --include=dev && npm run build -w @charitypilot/shared && npm run db:generate -w @charitypilot/api',
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

function captureCommand(command) {
  if (dryRun) {
    console.log(formatCommand(command));
    return '';
  }

  const [executable, ...args] = command;
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `${formatCommand(command)} failed with exit code ${result.status ?? 'unknown'}`);
  }

  return result.stdout;
}

function runCommand(command) {
  if (dryRun) {
    console.log(formatCommand(command));
    return;
  }

  const [executable, ...args] = command;
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${formatCommand(command)} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runningLocalAppServices() {
  if (dryRun) {
    return localAppServices;
  }

  const output = captureCommand(['docker', ...composeArgs, 'ps', '--format', 'json']);
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

function stopLocalAppServices(services) {
  if (services.length === 0) {
    return;
  }

  runCommand(['docker', ...composeArgs, 'stop', ...services]);
}

function startLocalAppServices(services) {
  if (services.length === 0) {
    return;
  }

  runCommand(['docker', ...composeArgs, 'up', '--wait', '--wait-timeout', '180', '-d', ...services]);
}

const localAppServicesRunningBeforeMigration = runningLocalAppServices();

stopLocalAppServices(localAppServicesRunningBeforeMigration);

for (const command of commands) {
  runCommand(command);
}

startLocalAppServices(localAppServicesRunningBeforeMigration);

if (!dryRun) {
  console.log('Local Docker migrations applied and Prisma migration status verified.');
}
