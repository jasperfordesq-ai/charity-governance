#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProductionComposeDeployFromArgs } from './production-compose-deploy.mjs';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';

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

const requiredWebBuildOrigins = [
  'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL',
  'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL',
];

function usage() {
  return [
    'Usage: node scripts/production-compose-rollback.mjs --production-env-file <path> --rollback-digest-file <path> [--dry-run] [--wait-timeout <seconds>]',
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
    productionEnvFile: '.env.production',
    rollbackDigestFile: null,
    waitTimeoutSeconds: null,
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
    if (arg === '--rollback-digest-file' || arg === '--image-digest-file') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.rollbackDigestFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--rollback-digest-file=')) {
      options.rollbackDigestFile = arg.slice('--rollback-digest-file='.length);
      continue;
    }
    if (arg.startsWith('--image-digest-file=')) {
      options.rollbackDigestFile = arg.slice('--image-digest-file='.length);
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

  if (!options.rollbackDigestFile) {
    throw new Error('--rollback-digest-file is required');
  }

  return options;
}

function parseEnvFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} file not found: ${path}`);
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
  if (!value) return `${envName} is required in the rollback digest manifest`;
  if (value.includes(':') && !value.includes('@sha256:')) {
    return `${envName} must be pinned to an immutable sha256 digest, not a mutable tag`;
  }

  const expected = new RegExp(`^${repository.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`);
  if (!expected.test(value)) {
    return `${envName} must use ${repository}@sha256:<64 lowercase hex chars>`;
  }

  return null;
}

function validateRollbackImages(rollbackEnv) {
  const issues = [];
  for (const image of requiredImages) {
    const issue = imageRefIssue(image, rollbackEnv[image.envName]);
    if (issue) issues.push(issue);
  }
  for (const envName of requiredWebBuildOrigins) {
    if (!rollbackEnv[envName]) {
      issues.push(`${envName} is required in the rollback digest manifest`);
    }
  }

  if (issues.length > 0) {
    throw new Error([
      `rollback digest manifest failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
      ...issues.map((issue) => `- ${issue}`),
    ].join('\n'));
  }
}

function mergedEnvContent(productionEnv, rollbackEnv) {
  const merged = { ...productionEnv };
  for (const { envName } of requiredImages) {
    merged[envName] = rollbackEnv[envName];
  }
  for (const envName of requiredWebBuildOrigins) {
    merged[envName] = rollbackEnv[envName];
  }

  return `${Object.entries(merged).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

export function runProductionComposeRollbackFromArgs(
  args = process.argv.slice(2),
  {
    processEnv = process.env,
    runDeploy = runProductionComposeDeployFromArgs,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const productionEnvPath = resolve(repoRoot, options.productionEnvFile);
  const rollbackDigestPath = resolve(repoRoot, options.rollbackDigestFile);

  let productionEnv;
  let rollbackEnv;
  try {
    productionEnv = parseEnvFile(productionEnvPath, 'production env');
    rollbackEnv = parseEnvFile(rollbackDigestPath, 'rollback digest manifest');
    validateRollbackImages(rollbackEnv);
  } catch (error) {
    return result(1, '', `Production compose rollback failed: ${error.message}\n`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-rollback-'));
  const mergedEnvPath = join(tempDir, 'rollback-production.env');
  const deployArgs = [
    '--production-env-file',
    mergedEnvPath,
    ...(options.waitTimeoutSeconds ? ['--wait-timeout', String(options.waitTimeoutSeconds)] : []),
    ...(options.dryRun ? ['--dry-run'] : []),
  ];

  try {
    writeFileSync(mergedEnvPath, mergedEnvContent(productionEnv, rollbackEnv), {
      encoding: 'utf8',
      mode: 0o600,
    });

    const deployResult = runDeploy(deployArgs, processEnv);
    const stdoutPrefix = [
      `Production compose rollback${options.dryRun ? ' dry-run' : ''}:`,
      `Rollback digest file: ${options.rollbackDigestFile}`,
      '',
    ].join('\n');

    if (deployResult.status !== 0) {
      return result(
        deployResult.status,
        `${stdoutPrefix}${deployResult.stdout}`,
        `Production compose rollback failed: deployment failed.\n${redactProductionDeployTranscript(deployResult.stderr)}`,
      );
    }

    return result(
      0,
      `${stdoutPrefix}${deployResult.stdout}Production compose rollback completed.\n`,
      deployResult.stderr,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const rollbackResult = runProductionComposeRollbackFromArgs();
  if (rollbackResult.stdout) process.stdout.write(rollbackResult.stdout);
  if (rollbackResult.stderr) process.stderr.write(rollbackResult.stderr);
  process.exit(rollbackResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
