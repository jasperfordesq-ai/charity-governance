import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProductionPreflight } from './check-production.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const requiredImages = [
  {
    envName: 'CHARITYPILOT_API_IMAGE',
    repository: 'ghcr.io/jasperfordesq-ai/charity-governance-api',
  },
  {
    envName: 'CHARITYPILOT_WEB_IMAGE',
    repository: 'ghcr.io/jasperfordesq-ai/charity-governance-web',
  },
  {
    envName: 'CHARITYPILOT_MIGRATION_IMAGE',
    repository: 'ghcr.io/jasperfordesq-ai/charity-governance-migrations',
  },
];

const cosignIdentityRegex = '^https://github.com/jasperfordesq-ai/charity-governance/\\.github/workflows/release-images\\.yml@refs/(heads/master|tags/v.*)$';
const cosignIssuer = 'https://token.actions.githubusercontent.com';

function usage() {
  return 'Usage: node scripts/production-deploy-preflight.mjs --production-env-file <path> [--dry-run]\n';
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    productionEnvFile: '.env.production',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseEnvFile(path) {
  if (!existsSync(path)) {
    throw new Error(`production env file not found: ${path}`);
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

function imageRefIssue({ envName, repository }, value) {
  if (!value) return `${envName} is required for production deployment`;
  if (value.includes(':') && !value.includes('@sha256:')) {
    return `${envName} must be pinned to an immutable sha256 digest, not a mutable tag`;
  }

  const expected = new RegExp(`^${repository.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`);
  if (!expected.test(value)) {
    return `${envName} must use ${repository}@sha256:<64 lowercase hex chars>`;
  }

  return null;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function commandLine(command) {
  return command.map(shellQuote).join(' ');
}

function runCommand(command, env) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${commandLine(command)} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function commandsFor({ productionEnvFile, images }) {
  const commands = [
    ['node', 'scripts/check-production.mjs', `--production-env-file=${productionEnvFile}`],
    ['docker', 'compose', '--env-file', productionEnvFile, '-f', 'compose.production.yml', 'config', '--quiet'],
  ];

  for (const image of images) {
    commands.push([
      'cosign',
      'verify',
      '--certificate-identity-regexp',
      cosignIdentityRegex,
      '--certificate-oidc-issuer',
      cosignIssuer,
      image,
    ]);
  }

  return commands;
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

export function runProductionDeployPreflightFromArgs(args = process.argv.slice(2), processEnv = process.env) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const envPath = resolve(repoRoot, options.productionEnvFile);
  let fileEnv;
  try {
    fileEnv = parseEnvFile(envPath);
  } catch (error) {
    return result(1, '', `Production deploy preflight failed: ${error.message}\n`);
  }

  const deploymentEnv = { ...processEnv, ...fileEnv };
  const productionEnvResult = runProductionPreflight({
    envFile: envPath,
    processEnv: deploymentEnv,
  });
  if (productionEnvResult.status !== 0) {
    return result(
      1,
      '',
      `Production deploy preflight failed: production environment validation failed.\n${productionEnvResult.stderr}`,
    );
  }

  const issues = [];
  for (const image of requiredImages) {
    const issue = imageRefIssue(image, deploymentEnv[image.envName]);
    if (issue) issues.push(issue);
  }

  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production deploy preflight failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  const images = requiredImages.map(({ envName }) => deploymentEnv[envName]);
  const commands = commandsFor({ productionEnvFile: options.productionEnvFile, images });

  if (options.dryRun) {
    return result(0, [
      'Production deploy preflight dry-run:',
      ...commands.map(commandLine),
      '',
    ].join('\n'));
  }

  const commandEnv = {
    ...processEnv,
    ...fileEnv,
    CHARITYPILOT_PRODUCTION_ENV_FILE: options.productionEnvFile,
  };

  try {
    for (const command of commands) {
      runCommand(command, commandEnv);
    }
  } catch (error) {
    return result(1, '', `Production deploy preflight failed: ${error.message}\n`);
  }

  return result(0, 'Production deploy preflight passed: env, compose config, and image signatures verified.\n');
}

function main() {
  const preflightResult = runProductionDeployPreflightFromArgs();
  if (preflightResult.stdout) process.stdout.write(preflightResult.stdout);
  if (preflightResult.stderr) process.stderr.write(preflightResult.stderr);
  process.exit(preflightResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
