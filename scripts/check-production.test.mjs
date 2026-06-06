import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptPath = join(scriptsDir, 'check-production.mjs');

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function cleanEnv() {
  const env = {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

function runPreflight(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: cleanEnv(),
  });
}

test('fails clearly when the explicit production env file is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-missing-'));
  const envPath = join(tempDir, 'missing-production.env');

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Production preflight failed: environment file not found: ${envPath}`));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails with configuration issues when the selected env file contains placeholders', () => {
  const result = runPreflight(['--production-env-file=.env.example']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production preflight failed \(17 issues\):/);
  assert.match(result.stderr, /JWT_SECRET is missing or still contains a placeholder value/);
  assert.match(result.stderr, /STRIPE_SECRET_KEY is missing or still contains a placeholder value/);
  assert.match(result.stderr, /FRONTEND_URL must use https:\/\/ for production/);
  assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
});

test('passes when the selected env file contains complete production values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
    assert.ok(result.stdout.includes(envPath));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when NODE_ENV is not production', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-node-env-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=development',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /NODE_ENV must be production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production values are local, malformed, or test-mode', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-strict-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002abc',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://localhost:3003',
      'STRIPE_SECRET_KEY=sk_test_realisticSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://127.0.0.1:3002',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_realisticSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /PORT must be an integer from 1 to 65535/);
    assert.match(result.stderr, /DATABASE_URL must not point at localhost for production/);
    assert.match(result.stderr, /FRONTEND_URL must not point at localhost for production/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
    assert.match(result.stderr, /STRIPE_SECRET_KEY must use a live Stripe secret key/);
    assert.match(result.stderr, /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must use a live Stripe publishable key/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production URLs point at bracketed IPv6 localhost', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-ipv6-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@[::1]:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://[::1]:3003',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://[::1]:3002',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL must not point at localhost for production/);
    assert.match(result.stderr, /FRONTEND_URL must not point at localhost for production/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production API scripts run built entrypoints without local env-file dependencies', () => {
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));

  assert.equal(apiPackage.scripts.start, 'node dist/start.js');
  assert.equal(apiPackage.scripts['jobs:deadline-reminders'], 'node dist/jobs/send-deadline-reminders.js');
  assert.doesNotMatch(apiPackage.scripts.start, /--env-file|tsx|src\//);
  assert.doesNotMatch(apiPackage.scripts['jobs:deadline-reminders'], /--env-file|tsx|src\//);
});

test('API Docker image documents the production runtime port and non-root user', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');

  assert.match(dockerfile, /ENV\s+NODE_ENV=production/);
  assert.match(dockerfile, /ENV\s+PORT=3002/);
  assert.match(dockerfile, /EXPOSE\s+3002/);
  assert.match(dockerfile, /USER\s+node/);
});

test('web Docker build requires a production HTTPS API URL before Next build', () => {
  const dockerfile = readRepoFile('apps/web/Dockerfile');

  assert.match(dockerfile, /ARG\s+NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /ENV\s+NEXT_PUBLIC_API_URL=\$NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /RUN\s+case\s+"\$NEXT_PUBLIC_API_URL"\s+in[\s\S]*https:\/\/\*/);
  assert.match(dockerfile, /RUN\s+npm run build -w @charitypilot\/web/);
  assert.match(dockerfile, /USER\s+node/);
});

test('web server awaits request handling and closes cleanly on termination signals', () => {
  const server = readRepoFile('apps/web/server.mjs');

  assert.match(server, /const\s+server\s*=\s*createServer\(async\s*\(/);
  assert.match(server, /await\s+handle\(request,\s*response\)/);
  assert.match(server, /server\.close\(/);
  assert.match(server, /process\.once\('SIGTERM'/);
  assert.match(server, /process\.once\('SIGINT'/);
});
