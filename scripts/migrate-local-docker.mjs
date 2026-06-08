#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const composeArgs = ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml'];
const prismaSchemaArgs = ['--schema', 'apps/api/prisma/schema.prisma'];
const dryRun = process.argv.includes('--dry-run');

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
  ['docker', ...composeArgs, 'run', '--rm', '--no-deps', '-T', 'api', 'npx', 'prisma', 'migrate', 'deploy', ...prismaSchemaArgs],
  ['docker', ...composeArgs, 'run', '--rm', '--no-deps', '-T', 'api', 'npx', 'prisma', 'migrate', 'status', ...prismaSchemaArgs],
];

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function formatCommand(command) {
  return command.map(shellQuote).join(' ');
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

for (const command of commands) {
  runCommand(command);
}

if (!dryRun) {
  console.log('Local Docker migrations applied and Prisma migration status verified.');
}
