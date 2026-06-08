#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function configFrom({ args = process.argv.slice(2), env = process.env } = {}) {
  return {
    image: env.CHARITYPILOT_CI_POSTGRES_IMAGE ?? 'postgres:16.4-alpine',
    dockerBin: env.CHARITYPILOT_CI_POSTGRES_DOCKER_BIN ?? 'docker',
    containerName: env.CHARITYPILOT_CI_POSTGRES_CONTAINER ?? 'charitypilot-ci-postgres',
    database: env.CHARITYPILOT_CI_POSTGRES_DB ?? 'charitypilot_ci',
    user: env.CHARITYPILOT_CI_POSTGRES_USER ?? 'charitypilot',
    password: env.CHARITYPILOT_CI_POSTGRES_PASSWORD ?? 'charitypilot_ci',
    hostPort: env.CHARITYPILOT_CI_POSTGRES_PORT ?? '5432',
    pullRetries: Number(env.CHARITYPILOT_CI_POSTGRES_PULL_RETRIES ?? '6'),
    readinessTimeoutMs: Number(env.CHARITYPILOT_CI_POSTGRES_READY_TIMEOUT_MS ?? '60000'),
    dryRun: args.includes('--dry-run'),
  };
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function renderCommand(command, args) {
  return [command, ...args.map((arg) => shellQuote(arg))].join(' ');
}

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    timeout: options.timeoutMs,
  });
}

function run(command, args, options = {}, context) {
  const rendered = renderCommand(command, args);
  if (context.config.dryRun) {
    context.stdout(`${rendered}\n`);
    return { status: 0 };
  }

  context.stdout(`$ ${rendered}\n`);
  const result = context.commandRunner(command, args, options);

  if (result.error && !options.ignoreFailure) {
    context.stderr(`${result.error.message}\n`);
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pullImage(context) {
  for (let attempt = 1; attempt <= context.config.pullRetries; attempt += 1) {
    const result = run(context.config.dockerBin, ['pull', context.config.image], { timeoutMs: 300000 }, context);
    if (result.status === 0) return;

    const remaining = context.config.pullRetries - attempt;
    if (remaining === 0) {
      throw new Error(`Failed to pull ${context.config.image} after ${context.config.pullRetries} attempts`);
    }

    const delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
    context.stderr(`Docker pull failed; retrying in ${Math.round(delayMs / 1000)}s (${remaining} attempt(s) left).\n`);
    await context.sleep(delayMs);
  }
}

function removeExistingContainer(context) {
  run(context.config.dockerBin, ['rm', '-f', context.config.containerName], {
    stdio: 'ignore',
    ignoreFailure: true,
  }, context);
}

function startContainer(context) {
  const healthCommand = `pg_isready -U ${context.config.user} -d ${context.config.database}`;
  const result = run(context.config.dockerBin, [
    'run',
    '-d',
    '--name',
    context.config.containerName,
    '-e',
    `POSTGRES_DB=${context.config.database}`,
    '-e',
    `POSTGRES_USER=${context.config.user}`,
    '-e',
    `POSTGRES_PASSWORD=${context.config.password}`,
    '-p',
    `127.0.0.1:${context.config.hostPort}:5432`,
    '--health-cmd',
    healthCommand,
    '--health-interval',
    '5s',
    '--health-timeout',
    '5s',
    '--health-retries',
    '12',
    context.config.image,
  ], {}, context);

  if (result.status !== 0) {
    throw new Error(`Failed to start ${context.config.containerName}`);
  }
}

async function waitForReadiness(context) {
  const startedAt = Date.now();
  const args = [
    'exec',
    context.config.containerName,
    'pg_isready',
    '-U',
    context.config.user,
    '-d',
    context.config.database,
  ];

  while (Date.now() - startedAt < context.config.readinessTimeoutMs) {
    const result = run(context.config.dockerBin, args, {}, context);
    if (result.status === 0) return;
    await context.sleep(2000);
  }

  throw new Error(`${context.config.containerName} did not become ready within ${context.config.readinessTimeoutMs}ms`);
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

export async function runCiPostgresFromArgs(args = process.argv.slice(2), {
  env = process.env,
  commandRunner = defaultCommandRunner,
  sleep: sleepFn = sleep,
} = {}) {
  let stdout = '';
  let stderr = '';
  const context = {
    config: configFrom({ args, env }),
    commandRunner,
    sleep: sleepFn,
    stdout(message) {
      stdout += message;
    },
    stderr(message) {
      stderr += message;
    },
  };

  if (context.config.dryRun) {
    context.stdout(`Image: ${context.config.image}\n`);
    context.stdout(`Container: ${context.config.containerName}\n`);
    context.stdout(`Retries: ${context.config.pullRetries}\n`);
  }

  try {
    await pullImage(context);
    removeExistingContainer(context);
    startContainer(context);
    await waitForReadiness(context);
    if (!context.config.dryRun) {
      context.stdout(`${context.config.containerName} is ready on 127.0.0.1:${context.config.hostPort}\n`);
    }
    return result(0, stdout, stderr);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : error}\n`);
    return result(1, stdout, stderr);
  }
}

async function main() {
  const startResult = await runCiPostgresFromArgs();
  if (startResult.stdout) process.stdout.write(startResult.stdout);
  if (startResult.stderr) process.stderr.write(startResult.stderr);
  process.exit(startResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
