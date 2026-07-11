#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_REPOSITORY = 'jasperfordesq-ai/charity-governance';
const USAGE_TEXT =
  'Usage: node scripts/check-production-github-secrets.mjs [--environment production] [--repo jasperfordesq-ai/charity-governance] [--json]';

export const REQUIRED_GITHUB_PRODUCTION_SECRETS = Object.freeze([
  { name: 'DATABASE_URL', hint: 'Managed production PostgreSQL URL with sslmode=verify-full and target_session_attrs=read-write' },
  { name: 'JWT_SECRET', hint: 'High-entropy API JWT signing secret' },
  { name: 'READINESS_API_KEY', hint: 'High-entropy keyed readiness probe secret' },
  { name: 'STRIPE_SECRET_KEY', hint: 'Stripe live secret key' },
  { name: 'STRIPE_WEBHOOK_SECRET', hint: 'Stripe live webhook signing secret' },
  { name: 'RESEND_API_KEY', hint: 'Resend production API key' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', hint: 'Supabase service role key' },
  { name: 'ERROR_ALERT_WEBHOOK_URL', hint: 'Incident alert webhook URL' },
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

function parseSecretRows(stdout) {
  try {
    const payload = JSON.parse(stdout);
    return Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function validateSecretRows(rows, environment) {
  return missingRequiredSecrets(rows).map(
    (secret) => `GitHub ${environment} secret ${secret.name} is missing (${secret.hint})`,
  );
}

function missingRequiredSecrets(rows) {
  const presentNames = new Set(rows.map((row) => String(row.name ?? '').trim()).filter(Boolean));
  return REQUIRED_GITHUB_PRODUCTION_SECRETS.filter((secret) => !presentNames.has(secret.name));
}

function secretStatusPayload(options, rows, issues, missingSecrets) {
  const presentNames = new Set(rows.map((row) => String(row.name ?? '').trim()).filter(Boolean));
  const requiredSecretNames = REQUIRED_GITHUB_PRODUCTION_SECRETS.map((secret) => secret.name);

  return {
    ok: issues.length === 0,
    environment: options.environment,
    repository: options.repository,
    requiredSecretNames,
    presentRequiredSecretNames: requiredSecretNames.filter((name) => presentNames.has(name)),
    missingSecretNames: missingSecrets.map((secret) => secret.name),
    issueCount: issues.length,
    issues,
    secretValuesRead: false,
    note: 'Only GitHub secret names are listed; secret values are never read or printed.',
  };
}

function remediationCommands(environment, repository, missingSecrets) {
  return [
    'Safe remediation commands:',
    ...missingSecrets.map(
      (secret) =>
        `- gh secret set ${secret.name} --env ${environment} --repo ${repository} --body "<value from approved secret store>"`,
    ),
    'Do not paste real secret values into chat, commits, screenshots, or launch evidence.',
  ];
}

export function runProductionGitHubSecretsCheckFromArgs(args = process.argv.slice(2), { runGh = defaultRunGh } = {}) {
  const options = parseArgs(args);
  if (options.error) return result(2, '', `${USAGE_TEXT}\n${options.error}\n`);
  if (options.help) return result(0, `${USAGE_TEXT}\n`, '');

  const secretResult = runGh([
    'secret',
    'list',
    '--env',
    options.environment,
    '--repo',
    options.repository,
    '--json',
    'name,updatedAt',
  ]);

  if (!secretResult || secretResult.status !== 0) {
    const details = redactedGhFailure(secretResult ?? {});
    if (options.json) {
      return jsonResult(1, {
        ok: false,
        environment: options.environment,
        repository: options.repository,
        requiredSecretNames: REQUIRED_GITHUB_PRODUCTION_SECRETS.map((secret) => secret.name),
        presentRequiredSecretNames: [],
        missingSecretNames: [],
        issueCount: 1,
        issues: [`gh secret list failed${details ? `: ${details}` : ''}`],
        secretValuesRead: false,
      });
    }
    return result(
      1,
      '',
      `Production GitHub secret-store check failed: gh secret list failed${details ? `:\n${details}` : '.'}\n`,
    );
  }

  const rows = parseSecretRows(secretResult.stdout ?? '');
  if (!rows) {
    if (options.json) {
      return jsonResult(1, {
        ok: false,
        environment: options.environment,
        repository: options.repository,
        requiredSecretNames: REQUIRED_GITHUB_PRODUCTION_SECRETS.map((secret) => secret.name),
        presentRequiredSecretNames: [],
        missingSecretNames: [],
        issueCount: 1,
        issues: ['gh secret list returned invalid JSON'],
        secretValuesRead: false,
      });
    }
    return result(1, '', 'Production GitHub secret-store check failed: gh secret list returned invalid JSON.\n');
  }

  const missingSecrets = missingRequiredSecrets(rows);
  const issues = validateSecretRows(rows, options.environment);
  if (options.json) {
    return jsonResult(issues.length > 0 ? 1 : 0, secretStatusPayload(options, rows, issues, missingSecrets));
  }

  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production GitHub secret-store check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        ...remediationCommands(options.environment, options.repository, missingSecrets),
        '',
      ].join('\n'),
    );
  }

  return result(
    0,
    `Production GitHub secret-store check passed: ${options.environment} has ${REQUIRED_GITHUB_PRODUCTION_SECRETS.length} required secret name(s); secret values were not read.\n`,
    '',
  );
}

function main() {
  const checkResult = runProductionGitHubSecretsCheckFromArgs();
  process.stdout.write(checkResult.stdout);
  process.stderr.write(checkResult.stderr);
  process.exitCode = checkResult.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
