#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_REPOSITORY = 'jasperfordesq-ai/charity-governance';
const CANONICAL_API_ORIGIN = 'https://api.charitypilot.ie';
const PLACEHOLDER_PATTERN = /(?:replace_me|real_|todo|tbd|pending|placeholder|change-me|your_|your-|project_ref)/i;
const USAGE_TEXT =
  'Usage: node scripts/check-production-github-env.mjs [--environment production] [--repo jasperfordesq-ai/charity-governance]';

export const REQUIRED_GITHUB_PRODUCTION_VARIABLES = Object.freeze([
  {
    name: 'NEXT_PUBLIC_API_URL',
    validate(value) {
      if (value !== CANONICAL_API_ORIGIN) {
        return `GitHub production variable NEXT_PUBLIC_API_URL must equal ${CANONICAL_API_ORIGIN}`;
      }
      return null;
    },
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    validate(value) {
      if (PLACEHOLDER_PATTERN.test(value)) {
        return 'GitHub production variable NEXT_PUBLIC_SUPABASE_URL must not contain placeholder text';
      }

      try {
        const url = new URL(value);
        const originOnly = url.origin === value.replace(/\/+$/, '');
        if (url.protocol !== 'https:' || !originOnly || !url.hostname.toLowerCase().endsWith('.supabase.co')) {
          return 'GitHub production variable NEXT_PUBLIC_SUPABASE_URL must be an origin-only HTTPS Supabase project URL';
        }
      } catch {
        return 'GitHub production variable NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS Supabase project URL';
      }

      return null;
    },
  },
]);

function parseArgs(argv) {
  const options = {
    environment: DEFAULT_ENVIRONMENT,
    repository: DEFAULT_REPOSITORY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { ...options, help: true };
    }
    if (arg === '--environment') {
      const value = argv[index + 1];
      if (!value) return { error: '--environment requires a value' };
      options.environment = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--environment=')) {
      options.environment = arg.slice('--environment='.length);
      continue;
    }
    if (arg === '--repo' || arg === '--repository') {
      const value = argv[index + 1];
      if (!value) return { error: `${arg} requires a value` };
      options.repository = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      options.repository = arg.slice('--repo='.length);
      continue;
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length);
      continue;
    }
    return { error: `Unknown option: ${arg}` };
  }

  return options;
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function defaultRunGh(args) {
  const ghResult = spawnSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return {
    status: ghResult.status ?? 1,
    stdout: ghResult.stdout ?? '',
    stderr: ghResult.stderr ?? '',
  };
}

function redactedGhFailure(resultValue) {
  const transcript = `${resultValue.stdout ?? ''}${resultValue.stderr ?? ''}`;
  return redactProductionDeployTranscript(transcript).trim();
}

function parseVariableRows(stdout) {
  try {
    const payload = JSON.parse(stdout);
    return Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function validateVariableRows(rows, environment) {
  const byName = new Map(rows.map((row) => [String(row.name ?? ''), String(row.value ?? '')]));
  const issues = [];

  for (const variable of REQUIRED_GITHUB_PRODUCTION_VARIABLES) {
    const value = byName.get(variable.name)?.trim();
    if (!value) {
      issues.push(`GitHub ${environment} variable ${variable.name} is missing`);
      continue;
    }

    if (PLACEHOLDER_PATTERN.test(value)) {
      issues.push(`GitHub ${environment} variable ${variable.name} must not contain placeholder text`);
      continue;
    }

    const issue = variable.validate(value);
    if (issue) issues.push(issue.replace('GitHub production', `GitHub ${environment}`));
  }

  return issues;
}

export function runProductionGitHubEnvironmentCheckFromArgs(
  args = process.argv.slice(2),
  { runGh = defaultRunGh } = {},
) {
  const options = parseArgs(args);
  if (options.error) return result(2, '', `${USAGE_TEXT}\n${options.error}\n`);
  if (options.help) return result(0, `${USAGE_TEXT}\n`, '');

  const variableResult = runGh([
    'variable',
    'list',
    '--env',
    options.environment,
    '--repo',
    options.repository,
    '--json',
    'name,value,updatedAt',
  ]);

  if (!variableResult || variableResult.status !== 0) {
    const details = redactedGhFailure(variableResult ?? {});
    return result(
      1,
      '',
      `Production GitHub environment check failed: gh variable list failed${details ? `:\n${details}` : '.'}\n`,
    );
  }

  const rows = parseVariableRows(variableResult.stdout ?? '');
  if (!rows) {
    return result(1, '', 'Production GitHub environment check failed: gh variable list returned invalid JSON.\n');
  }

  const issues = validateVariableRows(rows, options.environment);
  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production GitHub environment check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  return result(
    0,
    `Production GitHub environment check passed: ${options.environment} has the required release-image public variables; secret values were not read.\n`,
    '',
  );
}

function main() {
  const checkResult = runProductionGitHubEnvironmentCheckFromArgs();
  process.stdout.write(checkResult.stdout);
  process.stderr.write(checkResult.stderr);
  process.exitCode = checkResult.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
