import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_GITHUB_PRODUCTION_SECRETS,
  runProductionGitHubSecretsCheckFromArgs,
} from './check-production-github-secrets.mjs';

const repository = 'jasperfordesq-ai/charity-governance';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts', 'check-production-github-secrets.mjs');

function okGh(payload) {
  return {
    status: 0,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: '',
  };
}

function allSecretRows() {
  return REQUIRED_GITHUB_PRODUCTION_SECRETS.map((secret) => ({
    name: secret.name,
    updatedAt: '2026-07-09T00:00:00Z',
  }));
}

test('production GitHub secret-store check passes with every required secret name', () => {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    assert.deepEqual(args, [
      'secret',
      'list',
      '--env',
      'production',
      '--repo',
      repository,
      '--json',
      'name,updatedAt',
    ]);

    return okGh(allSecretRows());
  };

  const result = runProductionGitHubSecretsCheckFromArgs([], { runGh });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(REQUIRED_GITHUB_PRODUCTION_SECRETS.map((item) => item.name), [
    'DATABASE_URL',
    'JWT_SECRET',
    'AUTH_RECOVERY_SECRET',
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ERROR_ALERT_WEBHOOK_URL',
  ]);
  assert.match(result.stdout, /Production GitHub secret-store check passed/);
  assert.match(result.stdout, /secret values were not read/);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /postgresql:\/\//);
  assert.doesNotMatch(result.stdout, /sk_live/);
});

test('production GitHub secret-store check fails for missing required secret names', () => {
  const result = runProductionGitHubSecretsCheckFromArgs([], {
    runGh: () =>
      okGh([
        { name: 'DATABASE_URL', updatedAt: '2026-07-09T00:00:00Z' },
        { name: 'JWT_SECRET', updatedAt: '2026-07-09T00:00:00Z' },
      ]),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Production GitHub secret-store check failed \(7 issues\)/);
  assert.match(result.stderr, /GitHub production secret AUTH_RECOVERY_SECRET is missing/);
  assert.match(result.stderr, /GitHub production secret STRIPE_SECRET_KEY is missing/);
  assert.match(result.stderr, /GitHub production secret SUPABASE_SERVICE_ROLE_KEY is missing/);
  assert.match(
    result.stderr,
    /gh secret set STRIPE_SECRET_KEY --env production --repo jasperfordesq-ai\/charity-governance --body "<value from approved secret store>"/,
  );
  assert.match(result.stderr, /Do not paste real secret values into chat, commits, screenshots, or launch evidence/);
  assert.doesNotMatch(result.stderr, /sk_live_/);
});

test('production GitHub secret-store check renders name-only JSON for automation', () => {
  const result = runProductionGitHubSecretsCheckFromArgs(['--json'], {
    runGh: () =>
      okGh([
        { name: 'JWT_SECRET', updatedAt: '2026-07-09T00:00:00Z' },
        { name: 'READINESS_API_KEY', updatedAt: '2026-07-09T00:00:00Z' },
      ]),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.environment, 'production');
  assert.deepEqual(payload.presentRequiredSecretNames, ['JWT_SECRET', 'READINESS_API_KEY']);
  assert.deepEqual(payload.missingSecretNames, [
    'DATABASE_URL',
    'AUTH_RECOVERY_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ERROR_ALERT_WEBHOOK_URL',
  ]);
  assert.equal(payload.issueCount, 7);
  assert.match(payload.issues.join('\n'), /GitHub production secret DATABASE_URL is missing/);
  assert.equal(payload.secretValuesRead, false);
  assert.doesNotMatch(result.stdout, /postgresql:\/\//);
  assert.doesNotMatch(result.stdout, /sk_live_/);
});

test('production GitHub secret-store check rejects unknown options', () => {
  const result = runProductionGitHubSecretsCheckFromArgs(['--surprise']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown option: --surprise/);
  assert.match(result.stderr, /Usage: node scripts\/check-production-github-secrets\.mjs/);
});

test('production GitHub secret-store check rejects empty inline options before gh calls', () => {
  for (const args of [
    ['--environment='],
    ['--repo='],
    ['--repository='],
  ]) {
    let called = false;
    const result = runProductionGitHubSecretsCheckFromArgs(args, {
      runGh: () => {
        called = true;
        return okGh([]);
      },
    });

    assert.equal(result.status, 2, `${args.join(' ')} should be rejected as usage`);
    assert.equal(called, false);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /requires a value/);
    assert.match(result.stderr, /Usage: node scripts\/check-production-github-secrets\.mjs/);
  }
});

test('production GitHub secret-store check CLI prints usage', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/check-production-github-secrets\.mjs/);
  assert.equal(result.stderr, '');
});

test('production GitHub secret-store check redacts gh failure transcripts', () => {
  const result = runProductionGitHubSecretsCheckFromArgs([], {
    runGh: () => ({
      status: 1,
      stdout: 'DATABASE_URL=postgresql://user:pass@db.charitypilot.ie:5432/app\n',
      stderr:
        'failed with STRIPE_SECRET_KEY=sk_live_secret123 and https://example.test/hook?token=ghp_secret123',
    }),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /gh secret list failed/);
  assert.doesNotMatch(result.stderr, /postgresql:\/\/user:pass/);
  assert.doesNotMatch(result.stderr, /sk_live_secret123/);
  assert.doesNotMatch(result.stderr, /ghp_secret123/);
  assert.match(result.stderr, /DATABASE_URL=\[redacted\]/);
  assert.match(result.stderr, /STRIPE_SECRET_KEY=\[redacted\]/);
});
