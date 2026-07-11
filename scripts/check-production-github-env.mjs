#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_REPOSITORY = 'jasperfordesq-ai/charity-governance';
const CANONICAL_API_ORIGIN = 'https://api.charitypilot.ie';
const PLACEHOLDER_PATTERN = /(?:replace_me|real_|todo|tbd|pending|placeholder|change-me|your_|your-|project_ref)/i;
const USAGE_TEXT =
  'Usage: node scripts/check-production-github-env.mjs [--environment production] [--repo jasperfordesq-ai/charity-governance] [--json]';

function recoveryDatabaseHostAllowlistIssue(value) {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => !entry)) {
    return 'GitHub production variable DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST must contain nonempty comma-separated hostnames';
  }
  if (new Set(entries).size !== entries.length) {
    return 'GitHub production variable DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST must not contain duplicate hostnames';
  }
  for (const entry of entries) {
    const ascii = domainToASCII(entry);
    const labels = entry.split('.');
    const reserved = [
      '.alt', '.arpa', '.example', '.internal', '.invalid', '.local', '.localhost',
      '.localdomain', '.onion', '.private', '.test',
    ].some((suffix) => entry.endsWith(suffix));
    if (
      !ascii || ascii !== entry || entry !== entry.toLowerCase() || entry.endsWith('.') ||
      entry.includes('*') || isIP(entry) !== 0 || entry.length > 253 || labels.length < 2 ||
      labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      !/[a-z]/u.test(labels.at(-1) ?? '') || reserved ||
      ['example.com', 'example.net', 'example.org', 'localhost', 'host.docker.internal'].includes(entry)
    ) {
      return 'GitHub production variable DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST must contain canonical public DNS hostnames';
    }
  }
  return null;
}

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
    name: 'DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST',
    validate: recoveryDatabaseHostAllowlistIssue,
  },
]);

function parseArgs(argv) {
  const options = {
    environment: DEFAULT_ENVIRONMENT,
    repository: DEFAULT_REPOSITORY,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { ...options, help: true };
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--environment') {
      const value = argv[index + 1];
      if (!value) return { error: '--environment requires a value' };
      options.environment = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--environment=')) {
      const value = arg.slice('--environment='.length);
      if (!value) return { error: '--environment requires a value' };
      options.environment = value;
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
      const value = arg.slice('--repo='.length);
      if (!value) return { error: '--repo requires a value' };
      options.repository = value;
      continue;
    }
    if (arg.startsWith('--repository=')) {
      const value = arg.slice('--repository='.length);
      if (!value) return { error: '--repository requires a value' };
      options.repository = value;
      continue;
    }
    return { error: `Unknown option: ${arg}` };
  }

  return options;
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function jsonResult(status, payload) {
  return result(status, `${JSON.stringify(payload, null, 2)}\n`, '');
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

function variableStatusPayload(options, rows, issues) {
  const presentNames = new Set(rows.map((row) => String(row.name ?? '').trim()).filter(Boolean));
  const requiredVariableNames = REQUIRED_GITHUB_PRODUCTION_VARIABLES.map((variable) => variable.name);
  const missingVariableNames = requiredVariableNames.filter((name) => !presentNames.has(name));

  return {
    ok: issues.length === 0,
    environment: options.environment,
    repository: options.repository,
    requiredVariableNames,
    missingVariableNames,
    issueCount: issues.length,
    issues,
    valuesRead: true,
    secretValuesRead: false,
    note: 'GitHub variable values are validated but not printed.',
  };
}

function remediationCommands(environment, repository) {
  return [
    'Safe remediation commands:',
    `- gh variable set NEXT_PUBLIC_API_URL --env ${environment} --repo ${repository} --body "${CANONICAL_API_ORIGIN}"`,
    `- gh variable set DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST --env ${environment} --repo ${repository} --body "<managed-postgres-hostname>"`,
  ];
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
    if (options.json) {
      return jsonResult(1, {
        ok: false,
        environment: options.environment,
        repository: options.repository,
        requiredVariableNames: REQUIRED_GITHUB_PRODUCTION_VARIABLES.map((variable) => variable.name),
        missingVariableNames: [],
        issueCount: 1,
        issues: [`gh variable list failed${details ? `: ${details}` : ''}`],
        secretValuesRead: false,
      });
    }
    return result(
      1,
      '',
      `Production GitHub environment check failed: gh variable list failed${details ? `:\n${details}` : '.'}\n`,
    );
  }

  const rows = parseVariableRows(variableResult.stdout ?? '');
  if (!rows) {
    if (options.json) {
      return jsonResult(1, {
        ok: false,
        environment: options.environment,
        repository: options.repository,
        requiredVariableNames: REQUIRED_GITHUB_PRODUCTION_VARIABLES.map((variable) => variable.name),
        missingVariableNames: [],
        issueCount: 1,
        issues: ['gh variable list returned invalid JSON'],
        secretValuesRead: false,
      });
    }
    return result(1, '', 'Production GitHub environment check failed: gh variable list returned invalid JSON.\n');
  }

  const issues = validateVariableRows(rows, options.environment);
  if (options.json) {
    return jsonResult(issues.length > 0 ? 1 : 0, variableStatusPayload(options, rows, issues));
  }

  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production GitHub environment check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        ...remediationCommands(options.environment, options.repository),
        '',
      ].join('\n'),
    );
  }

  return result(
    0,
    `Production GitHub environment check passed: ${options.environment} has the required release-image public API variable; secret values were not read.\n`,
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
