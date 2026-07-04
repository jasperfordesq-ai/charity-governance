import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProductionDeployPreflightFromArgs } from './production-deploy-preflight.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;

function usage() {
  return [
    'Usage: node scripts/production-compose-deploy.mjs --production-env-file <path> [--dry-run] [--wait-timeout <seconds>] [--no-tls-proxy]',
    '',
  ].join('\n');
}

function parsePositiveInteger(value, flagName) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    throw new Error(`${flagName} must be a positive integer number of seconds`);
  }

  return Number(value);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tlsProxy: true,
    productionEnvFile: '.env.production',
    waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--no-tls-proxy') {
      options.tlsProxy = false;
      continue;
    }
    if (arg === '--production-env-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--production-env-file requires a value');
      options.productionEnvFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--production-env-file=')) {
      options.productionEnvFile = arg.slice('--production-env-file='.length);
      continue;
    }
    if (arg === '--wait-timeout') {
      const value = argv[index + 1];
      if (!value) throw new Error('--wait-timeout requires a value');
      options.waitTimeoutSeconds = parsePositiveInteger(value, '--wait-timeout');
      index += 1;
      continue;
    }
    if (arg.startsWith('--wait-timeout=')) {
      options.waitTimeoutSeconds = parsePositiveInteger(arg.slice('--wait-timeout='.length), '--wait-timeout');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function commandLine(command) {
  return command.map(shellQuote).join(' ');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function defaultRunCommand(command, env) {
  const commandResult = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    stdio: 'inherit',
  });

  if (commandResult.status !== 0) {
    throw new Error(`${commandLine(command)} failed with exit code ${commandResult.status ?? 'unknown'}`);
  }
}

function defaultRunSmoke(args, env) {
  const smokeResult = spawnSync('node', ['scripts/smoke-production-deploy.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });

  return {
    status: smokeResult.status ?? 1,
    stdout: smokeResult.stdout ?? '',
    stderr: smokeResult.stderr ?? '',
  };
}

function composeUpCommand({ productionEnvFile, tlsProxy, waitTimeoutSeconds }) {
  const composeFiles = [
    '-f',
    'compose.production.yml',
    ...(tlsProxy ? ['-f', 'compose.production-tls.yml'] : []),
  ];

  return [
    'docker',
    'compose',
    '--env-file',
    productionEnvFile,
    ...composeFiles,
    'up',
    '--wait',
    '--wait-timeout',
    String(waitTimeoutSeconds),
    '-d',
  ];
}

export function runProductionComposeDeployFromArgs(
  args = process.argv.slice(2),
  {
    processEnv = process.env,
    runPreflight = runProductionDeployPreflightFromArgs,
    runCommand = defaultRunCommand,
    runSmoke = defaultRunSmoke,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const preflightArgs = [
    '--production-env-file',
    options.productionEnvFile,
    ...(options.dryRun ? ['--dry-run'] : []),
    ...(options.tlsProxy ? [] : ['--no-tls-proxy']),
  ];
  const preflightResult = runPreflight(preflightArgs, processEnv);
  if (preflightResult.status !== 0) {
    return result(
      1,
      preflightResult.stdout,
      `Production compose deploy failed: preflight failed.\n${preflightResult.stderr}`,
    );
  }

  const commandEnvOverrides = {
    CHARITYPILOT_PRODUCTION_ENV_FILE: options.productionEnvFile,
  };
  const commandEnv = {
    ...processEnv,
    ...commandEnvOverrides,
  };
  const command = composeUpCommand(options);
  const smokeArgs = ['--production-env-file', options.productionEnvFile];
  const smokeCommand = ['node', 'scripts/smoke-production-deploy.mjs', ...smokeArgs];

  if (options.dryRun) {
    return result(0, [
      'Production compose deploy dry-run:',
      'Preflight command:',
      commandLine(['node', 'scripts/production-deploy-preflight.mjs', ...preflightArgs]),
      'Preflight validation output:',
      preflightResult.stdout.trimEnd(),
      'Compose environment:',
      ...Object.entries(commandEnvOverrides).map(([key, value]) => `${key}=${value}`),
      'Compose command:',
      commandLine(command),
      'Post-deploy smoke command:',
      commandLine([...smokeCommand, '--dry-run']),
      '',
    ].filter(Boolean).join('\n'));
  }

  try {
    runCommand(command, commandEnv);
  } catch (error) {
    return result(1, preflightResult.stdout, `Production compose deploy failed: ${error.message}\n`);
  }

  const smokeResult = runSmoke(smokeArgs, commandEnv);
  if (smokeResult.status !== 0) {
    return result(
      1,
      `${preflightResult.stdout}${smokeResult.stdout}`,
      `Production compose deploy failed: post-deploy smoke failed.\n${smokeResult.stderr}`,
    );
  }

  return result(0, `${preflightResult.stdout}${smokeResult.stdout}Production compose deploy completed.\n`);
}

function main() {
  const deployResult = runProductionComposeDeployFromArgs();
  if (deployResult.stdout) process.stdout.write(deployResult.stdout);
  if (deployResult.stderr) process.stderr.write(deployResult.stderr);
  process.exit(deployResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
