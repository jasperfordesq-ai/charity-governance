import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(result.stderr, /Production preflight failed \(\d+ issues\):/);
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
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
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

test('fails when the detailed readiness key is missing from production config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-readiness-key-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
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
    assert.match(result.stderr, /READINESS_API_KEY is missing or still contains a placeholder value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the detailed readiness key is too short for production config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-short-readiness-key-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'READINESS_API_KEY=short-readiness-key',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
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
    assert.match(result.stderr, /READINESS_API_KEY must be at least 32 characters/);
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
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
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
    assert.match(result.stderr, /DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full for production/);
    assert.match(result.stderr, /FRONTEND_URL must not point at localhost for production/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
    assert.match(result.stderr, /STRIPE_SECRET_KEY must use a live Stripe secret key/);
    assert.match(result.stderr, /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must use a live Stripe publishable key/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('passes when production frontend origins include multiple approved HTTPS origins', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-multi-origin-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie, https://admin.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
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
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when public production URLs use unapproved hostnames', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-public-hosts-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://attacker.example',
      'AUTH_COOKIE_DOMAIN=.attacker.example',
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
      'NEXT_PUBLIC_API_URL=https://api.attacker.example',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /FRONTEND_URL must use an approved CharityPilot production hostname/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production database URL omits TLS mode', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-db-tls-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
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
    assert.match(result.stderr, /DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when public production URLs are not origin-only', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-origin-only-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie/login',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
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
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie/v1',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /FRONTEND_URL must be an origin-only URL for production/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must be an origin-only URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when split web and API production hosts omit a shared auth cookie domain', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-cookie-domain-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
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
    assert.match(
      result.stderr,
      /AUTH_COOKIE_DOMAIN must be set when FRONTEND_URL and NEXT_PUBLIC_API_URL use different hostnames/,
    );
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
      'DATABASE_URL=postgresql://user:pass@[::1]:5432/charitypilot?sslmode=require',
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
  assert.equal(apiPackage.scripts['db:migrate:deploy'], 'prisma migrate deploy');
  assert.equal(apiPackage.scripts['jobs:deadline-reminders'], 'node dist/jobs/send-deadline-reminders.js');
  assert.doesNotMatch(apiPackage.scripts.start, /--env-file|tsx|src\//);
  assert.doesNotMatch(apiPackage.scripts['jobs:deadline-reminders'], /--env-file|tsx|src\//);
});

test('production secret env files are ignored by git without hiding the template', () => {
  for (const path of ['.env.production', '.env.production.secrets', '.env.production.local']) {
    const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${path} must be ignored`);
  }

  const templateResult = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '.env.production.example'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(templateResult.status, 1, '.env.production.example must remain visible');
});

test('API Docker image documents the production runtime port and non-root user', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');

  assert.match(dockerfile, /FROM deps AS build[\s\S]*ARG\s+DATABASE_URL=/);
  assert.match(dockerfile, /FROM deps AS build[\s\S]*ENV\s+DATABASE_URL=\$DATABASE_URL[\s\S]*RUN\s+npm run db:generate -w @charitypilot\/api/);
  assert.match(dockerfile, /ENV\s+NODE_ENV=production/);
  assert.match(dockerfile, /ENV\s+PORT=3002/);
  assert.match(dockerfile, /EXPOSE\s+3002/);
  assert.match(dockerfile, /USER\s+node/);
  assert.match(dockerfile, /CMD\s+\["node",\s*"dist\/start\.js"\]/);
  assert.doesNotMatch(dockerfile, /CMD[\s\S]*migrate deploy/);

  const runnerStage = dockerfile.slice(dockerfile.indexOf('FROM node:22-alpine AS runner'));
  assert.doesNotMatch(runnerStage, /DATABASE_URL/);
});

test('API server enables trusted proxy handling for production rate limits', () => {
  const server = readRepoFile('apps/api/src/server.ts');

  assert.match(server, /trustedProxyAddresses/);
  assert.match(server, /trustProxy:\s*trustedProxyAddresses\.length\s*>\s*0\s*\?\s*trustedProxyAddresses\s*:\s*false/);
  assert.match(server, /Fastify\(\{[\s\S]*trustProxy:/);
  assert.doesNotMatch(server, /trustProxy:\s*process\.env\.TRUST_PROXY\s*===\s*'true'/);
});

test('document storage deletion has a durable retry outbox and production job', () => {
  const schema = readRepoFile('apps/api/prisma/schema.prisma');
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));
  const cleanupJob = readRepoFile('apps/api/src/jobs/cleanup-document-storage.ts');

  assert.match(schema, /model DocumentStorageDeletion/);
  assert.match(schema, /processedAt\s+DateTime\?/);
  assert.match(schema, /@@index\(\[processedAt, createdAt\]\)/);
  assert.equal(apiPackage.scripts['jobs:document-storage-cleanup'], 'node dist/jobs/cleanup-document-storage.js');
  assert.match(cleanupJob, /retryPendingStorageDeletions/);
  assert.match(cleanupJob, /validateDocumentStorageCleanupEnv/);
  assert.match(cleanupJob, /StorageService/);
  assert.doesNotMatch(cleanupJob, /validateProductionEnv/);
});

test('web Docker build requires a production HTTPS API URL before Next build', () => {
  const dockerfile = readRepoFile('apps/web/Dockerfile');

  assert.match(dockerfile, /ARG\s+NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /ENV\s+NEXT_PUBLIC_API_URL=\$NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /new URL\(process\.env\.NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /api\.charitypilot\.ie/);
  assert.match(dockerfile, /origin-only CharityPilot production URL/);
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

test('web config disables generated agent-rule files during local dev startup', () => {
  const config = readRepoFile('apps/web/next.config.ts');
  const webPackage = JSON.parse(readRepoFile('apps/web/package.json'));

  assert.match(config, /agentRules:\s*false/);
  assert.match(webPackage.scripts.dev, /--webpack/);
  assert.equal(existsSync(join(repoRoot, 'apps/web/AGENTS.md')), false);
  assert.equal(existsSync(join(repoRoot, 'apps/web/CLAUDE.md')), false);
});

test('web development CSP allows the local Docker API port', () => {
  const csp = readRepoFile('apps/web/src/lib/content-security-policy.ts');

  assert.match(csp, /http:\/\/localhost:3002/);
  assert.doesNotMatch(csp, /http:\/\/localhost:3001/);
});

test('web production CSP uses per-request script nonces without unsafe inline execution', () => {
  const config = readRepoFile('apps/web/next.config.ts');

  assert.doesNotMatch(config, /script-src[^;\n]*'unsafe-inline'/);

  const script = `
    import assert from 'node:assert/strict';

    const cspModule = await import('./apps/web/src/lib/content-security-policy.ts');
    const createContentSecurityPolicy =
      cspModule.createContentSecurityPolicy ?? cspModule.default?.createContentSecurityPolicy;

    const csp = createContentSecurityPolicy({
      nonce: 'releaseGateNonce',
      isDevelopment: false,
      apiUrl: 'https://api.charitypilot.ie',
    });

    const scriptSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src '));

    assert.ok(scriptSrc, csp);
    assert.match(scriptSrc, /'nonce-releaseGateNonce'/);
    assert.match(scriptSrc, /'strict-dynamic'/);
    assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
    assert.doesNotMatch(scriptSrc, /'unsafe-eval'/);
  `;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('web executable inline scripts are nonce-bound for strict production CSP', () => {
  const layout = readRepoFile('apps/web/src/app/layout.tsx');
  const jsonLd = readRepoFile('apps/web/src/components/json-ld.tsx');
  const proxy = readRepoFile('apps/web/src/proxy.ts');

  assert.match(layout, /nonce=\{nonce\}/);
  assert.match(layout, /headers\(\)/);
  assert.match(jsonLd, /nonce=\{nonce\}/);
  assert.match(proxy, /requestHeaders\.set\('x-nonce', nonce\)/);
  assert.match(proxy, /Content-Security-Policy/);
});

test('web route protection uses the Next proxy convention instead of deprecated middleware', () => {
  assert.equal(existsSync(join(repoRoot, 'apps/web/src/middleware.ts')), false);
  assert.equal(existsSync(join(repoRoot, 'apps/web/src/proxy.ts')), true);

  const proxy = readRepoFile('apps/web/src/proxy.ts');
  assert.match(proxy, /export function proxy\(request: NextRequest\)/);
  assert.match(proxy, /export const config\s*=/);
  assert.doesNotMatch(proxy, /export function middleware/);
});

test('web email verification flow gives unverified signed-in users a tokenless waiting page', () => {
  const authContext = readRepoFile('apps/web/src/lib/auth-context.tsx');
  const loginPage = readRepoFile('apps/web/src/app/(auth)/login/page.tsx');
  const registerPage = readRepoFile('apps/web/src/app/(auth)/register/page.tsx');
  const dashboardLayout = readRepoFile('apps/web/src/app/(dashboard)/layout.tsx');
  const verifyEmailPage = readRepoFile('apps/web/src/app/(auth)/verify-email/page.tsx');

  assert.match(authContext, /login:\s*\([^)]*\)\s*=>\s*Promise<UserResponse>/);
  assert.match(authContext, /register:\s*\([^)]*\)\s*=>\s*Promise<UserResponse>/);
  assert.match(loginPage, /router\.push\(user\.emailVerified\s*\?\s*'\/dashboard'\s*:\s*'\/verify-email'\)/);
  assert.match(registerPage, /router\.push\(user\.emailVerified\s*\?\s*'\/dashboard'\s*:\s*'\/verify-email'\)/);
  assert.match(dashboardLayout, /!user\.emailVerified[\s\S]*router\.replace\('\/verify-email'\)/);
  assert.match(verifyEmailPage, /type Status = 'loading' \| 'pending' \| 'success' \| 'error'/);
  assert.match(verifyEmailPage, /status === 'pending'/);
  assert.match(verifyEmailPage, /api\.post\('\/auth\/resend-verification'/);
  assert.match(verifyEmailPage, /Resend verification email/);
  assert.doesNotMatch(verifyEmailPage, /No verification token found/);
});

test('web proxy preserves protected-route redirect and no-cache behavior', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { NextRequest } from 'next/server';

    const proxyModule = await import('./apps/web/src/proxy.ts');
    const proxy = proxyModule.proxy ?? proxyModule.default?.proxy;

    const unauthenticated = proxy(new NextRequest('https://app.charitypilot.ie/dashboard?tab=deadlines'));
    assert.equal(unauthenticated.status, 307);
    assert.equal(
      unauthenticated.headers.get('location'),
      'https://app.charitypilot.ie/login?next=%2Fdashboard%3Ftab%3Ddeadlines',
    );
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    assert.equal(unauthenticated.headers.get('pragma'), 'no-cache');

    const authenticated = proxy(new NextRequest('https://app.charitypilot.ie/dashboard', {
      headers: { cookie: 'charitypilot_access=token' },
    }));
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    assert.equal(authenticated.headers.get('pragma'), 'no-cache');

    const publicRoute = proxy(new NextRequest('https://app.charitypilot.ie/login'));
    assert.equal(publicRoute.status, 200);
    assert.equal(publicRoute.headers.get('cache-control'), null);
    assert.equal(publicRoute.headers.get('pragma'), null);
  `;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('web export opens the API-rendered report directly with opener isolation', () => {
  const exportPage = readRepoFile('apps/web/src/app/(dashboard)/export/page.tsx');

  assert.match(exportPage, /api\.getUri\(\{\s*url:\s*`\/export\/compliance-report\?year=\$\{year\}`\s*\}\)/);
  assert.match(exportPage, /window\.open\([^)]*'noopener,noreferrer'[^)]*\)/);
  assert.doesNotMatch(exportPage, /new Blob\(/);
  assert.doesNotMatch(exportPage, /URL\.createObjectURL/);
});

test('web document upload picker does not advertise legacy Office formats', () => {
  const documentsPage = readRepoFile('apps/web/src/app/(dashboard)/documents/page.tsx');

  assert.doesNotMatch(documentsPage, /accept="[^"]*\.(doc|xls|ppt)(,|")/);
  assert.match(documentsPage, /\.docx/);
  assert.match(documentsPage, /\.xlsx/);
  assert.match(documentsPage, /\.pptx/);
});

test('CI deploys Prisma migrations against PostgreSQL before release gates', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /services:\s*\n\s+postgres:/);
  assert.match(workflow, /image:\s+postgres:/);
  assert.match(workflow, /POSTGRES_DB:\s+charitypilot_ci/);
  assert.match(workflow, /DATABASE_URL:\s+postgresql:\/\/charitypilot:charitypilot_ci@localhost:5432\/charitypilot_ci/);
  assert.match(workflow, /prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  assert.match(workflow, /prisma migrate status --schema apps\/api\/prisma\/schema\.prisma/);
});

test('CI keeps every production release gate wired', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:[\s\S]*branches:[\s\S]*- master/);
  assert.match(workflow, /node-version:\s+22/);
  assert.match(workflow, /run:\s+npm ci/);
  assert.match(workflow, /run:\s+npm run db:generate -w @charitypilot\/api/);
  assert.match(workflow, /run:\s+npx prisma validate/);
  assert.match(workflow, /run:\s+npm run lint/);
  assert.match(workflow, /run:\s+npm run test/);
  assert.match(workflow, /run:\s+npm run build -w @charitypilot\/shared/);
  assert.match(workflow, /run:\s+npm run build -w @charitypilot\/api/);
  assert.match(workflow, /run:\s+npm run build -w @charitypilot\/web/);
  assert.match(workflow, /run:\s+npm audit --omit=dev --audit-level=moderate/);
});

test('CI uses GitHub Actions releases that run on the Node 24 action runtime', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /uses:\s+actions\/checkout@v5/);
  assert.match(workflow, /uses:\s+actions\/setup-node@v6/);
  assert.doesNotMatch(workflow, /uses:\s+actions\/checkout@v4/);
  assert.doesNotMatch(workflow, /uses:\s+actions\/setup-node@v4/);
});

test('CI builds API and web production Docker images', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /docker build -f apps\/api\/Dockerfile --build-arg DATABASE_URL=postgresql:\/\/charitypilot:charitypilot_ci@localhost:5432\/charitypilot_ci -t charitypilot-api-ci \./);
  assert.match(workflow, /docker build -f apps\/web\/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie -t charitypilot-web-ci \./);
});
