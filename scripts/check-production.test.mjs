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
const validRuntimeWebApiUrlEnv = {
  CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
};

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function composeServiceBlock(compose, serviceName) {
  const match = compose.match(new RegExp(`\\n  ${serviceName}:\\n[\\s\\S]*?(?=\\n  [A-Za-z0-9_-]+:\\n|\\nnetworks:\\n|$)`));
  assert.ok(match, `compose service ${serviceName} must exist`);
  return match[0];
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

function runPreflight(args, envOverrides = {}) {
  const defaultRuntimeEnv = Object.hasOwn(envOverrides, 'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL')
    ? {}
    : validRuntimeWebApiUrlEnv;

  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...cleanEnv(), ...defaultRuntimeEnv, ...envOverrides },
  });
}

function completeProductionEnv(overrides = {}) {
  const values = {
    NODE_ENV: 'production',
    PORT: '3002',
    TRUSTED_PROXY_ADDRESSES: '10.0.0.10',
    READINESS_API_KEY: 'configured-readiness-key-32-chars',
    DATABASE_URL: 'postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
    JWT_SECRET: 'a'.repeat(40),
    FRONTEND_URL: 'https://app.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
    STRIPE_SECRET_KEY: 'sk_live_configuredSecret',
    STRIPE_WEBHOOK_SECRET: 'whsec_configuredSecret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_essentialsMonthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_essentialsYearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_completeMonthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_completeYearly',
    RESEND_API_KEY: 're_configuredSecret',
    EMAIL_FROM: 'noreply@charitypilot.ie',
    SUPABASE_URL: 'https://configured-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'configured-service-role-key',
    SUPABASE_STORAGE_BUCKET: 'documents',
    ERROR_ALERT_WEBHOOK_URL: 'https://alerts.example/hooks/charitypilot',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_configuredSecret',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

test('fails clearly when the explicit production env file is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-missing-'));
  const envPath = join(tempDir, 'missing-production.env');

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

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
      'ERROR_ALERT_WEBHOOK_URL=https://alerts.example/hooks/charitypilot',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
    assert.ok(result.stdout.includes(envPath));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-missing-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: '',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL is missing or still contains a placeholder value/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL is not an approved HTTPS origin', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-local-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'http://localhost:3002',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must use https:\/\/ for production/);
    assert.match(result.stderr, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must not point at localhost for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL uses an unapproved hostname', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-attacker-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.attacker.example',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL is not origin-only', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-path-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie/v1',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must be an origin-only URL for production/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL drifts from the production env API URL', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-drift-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://edge.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must match NEXT_PUBLIC_API_URL/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('passes when the compose runtime web API URL matches the production env API URL', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-valid-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('passes when the compose runtime web API URL is supplied by the selected env file', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-env-file-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: '',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when a required production value is absent from the selected env file even if the shell has it', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-env-file-authority-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
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
      'ERROR_ALERT_WEBHOOK_URL=https://alerts.example/hooks/charitypilot',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      READINESS_API_KEY: 'configured-readiness-key-from-parent-shell',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /READINESS_API_KEY is missing or still contains a placeholder value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-'));
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
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook is not an HTTPS public URL', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-local-'));
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
      'ERROR_ALERT_WEBHOOK_URL=http://localhost:3030/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use https:\/\/ for production/);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must not point at localhost for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook points at a private network', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-private-'));
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
      'ERROR_ALERT_WEBHOOK_URL=https://10.0.0.5/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook points at an IPv4-mapped private network', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-mapped-private-'));
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
      'ERROR_ALERT_WEBHOOK_URL=https://[::ffff:10.0.0.5]/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook points at reserved IPv6 space', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-reserved-ipv6-'));
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
      'ERROR_ALERT_WEBHOOK_URL=https://[2001:2::1]/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook has a malformed DNS hostname', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-malformed-host-'));
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
      'ERROR_ALERT_WEBHOOK_URL=https://alert_webhook.example.com/hooks',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
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
      'ERROR_ALERT_WEBHOOK_URL=https://alerts.example/hooks/charitypilot',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

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

test('production env template documents the compose runtime web API URL', () => {
  const template = readRepoFile('.env.production.example');

  assert.match(template, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL=https:\/\/REPLACE_ME_PUBLIC_API_ORIGIN\.example/);
  assert.match(template, /must match `NEXT_PUBLIC_API_URL`/);
  assert.match(template, /Docker Compose/);
});

test('Docker build context excludes generated caches and build metadata', () => {
  const dockerignore = readRepoFile('.dockerignore');

  for (const pattern of ['.turbo', '**/.turbo', '**/*.tsbuildinfo']) {
    assert.match(dockerignore, new RegExp(`(^|\\n)${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`));
  }
});

test('API Docker image documents the production runtime port and non-root user', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');

  assert.match(dockerfile, /FROM deps AS build[\s\S]*ARG\s+DATABASE_URL=/);
  assert.match(dockerfile, /FROM deps AS build[\s\S]*ENV\s+DATABASE_URL=\$DATABASE_URL[\s\S]*RUN\s+npm run db:generate -w @charitypilot\/api/);
  assert.match(dockerfile, /FROM node:22-alpine AS runtime-deps/);
  assert.match(
    dockerfile,
    /npm ci --omit=dev --omit=peer --workspace @charitypilot\/api --workspace @charitypilot\/shared --include-workspace-root=false/,
  );
  assert.match(dockerfile, /rm -rf[\s\S]*node_modules\/prisma[\s\S]*node_modules\/typescript/);
  assert.match(dockerfile, /COPY --chown=node:node --from=build \/app\/node_modules\/\.prisma \.\/node_modules\/\.prisma/);
  assert.match(dockerfile, /ENV\s+NODE_ENV=production/);
  assert.match(dockerfile, /ENV\s+PORT=3002/);
  assert.match(dockerfile, /EXPOSE\s+3002/);
  assert.match(dockerfile, /USER\s+node/);
  assert.match(dockerfile, /CMD\s+\["node",\s*"dist\/start\.js"\]/);
  assert.match(dockerfile, /COPY --chown=node:node --from=runtime-deps \/app\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node --from=build \/app\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /CMD[\s\S]*migrate deploy/);

  const runnerStage = dockerfile.slice(dockerfile.indexOf('FROM node:22-alpine AS runner'));
  assert.doesNotMatch(runnerStage, /DATABASE_URL/);
});

test('API Dockerfile includes a dedicated Prisma migration runner target', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');

  assert.match(dockerfile, /FROM deps AS migration-runner/);
  assert.match(dockerfile, /FROM deps AS migration-runner[\s\S]*COPY --chown=node:node apps\/api\/prisma \.\/apps\/api\/prisma/);
  assert.match(dockerfile, /FROM deps AS migration-runner[\s\S]*WORKDIR \/app\/apps\/api/);
  assert.match(dockerfile, /FROM deps AS migration-runner[\s\S]*USER node/);
  assert.match(dockerfile, /ENTRYPOINT\s+\["npx",\s*"prisma"\]/);
  assert.match(dockerfile, /CMD\s+\["migrate",\s*"deploy",\s*"--schema",\s*"prisma\/schema\.prisma"\]/);

  const migrationRunnerStart = dockerfile.indexOf('FROM deps AS migration-runner');
  const migrationRunnerEnd = dockerfile.indexOf('\nFROM ', migrationRunnerStart + 1);
  const migrationRunnerStage = dockerfile.slice(migrationRunnerStart, migrationRunnerEnd);
  assert.doesNotMatch(migrationRunnerStage, /dist\/start\.js/);
});

test('production Docker compose runs migrations before API and keeps web away from secrets', () => {
  const productionComposePath = join(repoRoot, 'compose.production.yml');
  assert.equal(existsSync(productionComposePath), true, 'compose.production.yml must exist');

  const compose = readRepoFile('compose.production.yml');

  assert.match(compose, /\nservices:\s*\n\s+migrate:/);
  assert.match(compose, /\n\s+api:/);
  assert.match(compose, /\n\s+web:/);
  assert.match(compose, /\n\s+deadline-reminders:/);
  assert.match(compose, /\n\s+document-storage-cleanup:/);
  assert.doesNotMatch(compose, /\n\s+db:/);
  assert.doesNotMatch(compose, /\n\s+build:/);
  assert.doesNotMatch(compose, /node:22/);
  assert.doesNotMatch(compose, /\n\s+volumes:/);
  assert.doesNotMatch(compose, /:\s*\/app\b/);

  const migrate = composeServiceBlock(compose, 'migrate');
  const api = composeServiceBlock(compose, 'api');
  const web = composeServiceBlock(compose, 'web');
  const deadlineReminders = composeServiceBlock(compose, 'deadline-reminders');
  const documentStorageCleanup = composeServiceBlock(compose, 'document-storage-cleanup');

  assert.match(migrate, /image:\s+\$\{CHARITYPILOT_MIGRATION_IMAGE:\?Set CHARITYPILOT_MIGRATION_IMAGE\}/);
  assert.match(migrate, /env_file:[\s\S]*\$\{CHARITYPILOT_PRODUCTION_ENV_FILE:-\.env\.production\}/);
  assert.match(migrate, /command:\s+\["migrate",\s*"deploy",\s*"--schema",\s*"prisma\/schema\.prisma"\]/);
  assert.match(migrate, /restart:\s+"no"/);

  assert.match(api, /image:\s+\$\{CHARITYPILOT_API_IMAGE:\?Set CHARITYPILOT_API_IMAGE\}/);
  assert.match(api, /env_file:[\s\S]*\$\{CHARITYPILOT_PRODUCTION_ENV_FILE:-\.env\.production\}/);
  assert.match(api, /NODE_ENV:\s+production/);
  assert.match(api, /depends_on:[\s\S]*migrate:[\s\S]*condition:\s+service_completed_successfully/);
  assert.match(api, /fetch\('http:\/\/127\.0\.0\.1:3002\/api\/v1\/health\/readiness'/);
  assert.match(api, /'x-charitypilot-readiness-key':\s*process\.env\.READINESS_API_KEY/);
  assert.match(api, /ports:[\s\S]*\$\{CHARITYPILOT_API_PORT:-3002\}:3002/);

  assert.match(web, /image:\s+\$\{CHARITYPILOT_WEB_IMAGE:\?Set CHARITYPILOT_WEB_IMAGE\}/);
  assert.doesNotMatch(web, /env_file:/);
  assert.match(web, /NODE_ENV:\s+production/);
  assert.match(web, /NEXT_PUBLIC_API_URL:\s+\$\{CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL:\?Set CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL\}/);
  assert.match(web, /depends_on:[\s\S]*api:[\s\S]*condition:\s+service_healthy/);
  assert.match(web, /fetch\('http:\/\/127\.0\.0\.1:3003\/'\)/);
  assert.match(web, /ports:[\s\S]*\$\{CHARITYPILOT_WEB_PORT:-3003\}:3003/);

  for (const secret of [
    'DATABASE_URL',
    'JWT_SECRET',
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ERROR_ALERT_WEBHOOK_URL',
  ]) {
    assert.doesNotMatch(web, new RegExp(`\\b${secret}:`));
  }

  for (const service of [migrate, api, web, deadlineReminders, documentStorageCleanup]) {
    assert.match(service, /security_opt:[\s\S]*no-new-privileges:true/);
    assert.match(service, /cap_drop:[\s\S]*- ALL/);
  }

  for (const job of [deadlineReminders, documentStorageCleanup]) {
    assert.match(job, /profiles:[\s\S]*- jobs/);
    assert.match(job, /image:\s+\$\{CHARITYPILOT_API_IMAGE:\?Set CHARITYPILOT_API_IMAGE\}/);
    assert.match(job, /env_file:[\s\S]*\$\{CHARITYPILOT_PRODUCTION_ENV_FILE:-\.env\.production\}/);
    assert.match(job, /depends_on:[\s\S]*migrate:[\s\S]*condition:\s+service_completed_successfully/);
    assert.match(job, /NODE_ENV:\s+production/);
    assert.match(job, /restart:\s+"no"/);
    assert.doesNotMatch(job, /ports:/);
    assert.doesNotMatch(job, /healthcheck:/);
  }

  assert.match(deadlineReminders, /command:\s+\["node",\s*"dist\/jobs\/send-deadline-reminders\.js"\]/);
  assert.match(documentStorageCleanup, /command:\s+\["node",\s*"dist\/jobs\/cleanup-document-storage\.js"\]/);
});

test('production Docker compose renders with published image variables and an external env file', () => {
  const result = spawnSync('docker', ['compose', '-f', 'compose.production.yml', 'config', '--quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CHARITYPILOT_PRODUCTION_ENV_FILE: '.env.production.example',
      CHARITYPILOT_API_IMAGE: 'ghcr.io/jasperfordesq-ai/charity-governance-api:sha-test',
      CHARITYPILOT_WEB_IMAGE: 'ghcr.io/jasperfordesq-ai/charity-governance-web:sha-test',
      CHARITYPILOT_MIGRATION_IMAGE: 'ghcr.io/jasperfordesq-ai/charity-governance-migrations:sha-test',
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    },
    timeout: 120_000,
  });

  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || result.error?.message || 'docker compose production config failed',
  );
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
  assert.match(schema, /claimedAt\s+DateTime\?/);
  assert.match(schema, /processedAt\s+DateTime\?/);
  assert.match(schema, /@@index\(\[processedAt, createdAt\]\)/);
  assert.match(schema, /@@index\(\[processedAt, claimedAt, createdAt\]\)/);
  assert.equal(apiPackage.scripts['jobs:document-storage-cleanup'], 'node dist/jobs/cleanup-document-storage.js');
  assert.match(cleanupJob, /retryPendingStorageDeletions/);
  assert.match(cleanupJob, /validateDocumentStorageCleanupEnv/);
  assert.match(cleanupJob, /StorageService/);
  assert.doesNotMatch(cleanupJob, /validateProductionEnv/);
});

test('production operations docs keep detailed readiness checks behind the internal header', () => {
  const runbook = readRepoFile('docs/production-runbook.md');
  const launchChecklist = readRepoFile('docs/production-launch-checklist.md');
  const browserQa = readRepoFile('docs/production-browser-qa.md');
  const supabaseSetup = readRepoFile('docs/supabase-production-setup.md');

  for (const doc of [runbook, launchChecklist, browserQa, supabaseSetup]) {
    assert.match(doc, /x-charitypilot-readiness-key/);
  }

  assert.match(browserQa, /without `x-charitypilot-readiness-key` returns `401`/);
  assert.match(supabaseSetup, /without `x-charitypilot-readiness-key` should return `401`/);
  assert.match(runbook, /Public monitoring can check `\/api\/v1\/health`/);
  assert.doesNotMatch(supabaseSetup, /curl -i https:\/\/api\.charitypilot\.ie\/api\/v1\/health\/readiness/);
});

test('production operations docs explain the compose runtime web API URL', () => {
  const runbook = readRepoFile('docs/production-runbook.md');
  const launchChecklist = readRepoFile('docs/production-launch-checklist.md');

  assert.match(runbook, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL/);
  assert.match(runbook, /must match `NEXT_PUBLIC_API_URL`/);
  assert.match(runbook, /docker compose --env-file \.env\.production -f compose\.production\.yml config --quiet/);
  assert.match(launchChecklist, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL/);
  assert.match(launchChecklist, /matches `NEXT_PUBLIC_API_URL`/);
});

test('web Docker build requires a production HTTPS API URL before Next build', () => {
  const dockerfile = readRepoFile('apps/web/Dockerfile');

  assert.match(dockerfile, /ARG\s+NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /ENV\s+NEXT_PUBLIC_API_URL=\$NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /new URL\(process\.env\.NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /api\.charitypilot\.ie/);
  assert.match(dockerfile, /origin-only CharityPilot production URL/);
  assert.match(dockerfile, /RUN\s+npm run build -w @charitypilot\/web/);
  assert.match(dockerfile, /FROM build AS runtime-deps[\s\S]*RUN\s+npm prune --omit=dev --omit=peer --workspaces/);
  assert.match(dockerfile, /rm -rf[\s\S]*node_modules\/typescript[\s\S]*node_modules\/eslint[\s\S]*node_modules\/turbo/);
  assert.match(dockerfile, /COPY --chown=node:node --from=runtime-deps \/app\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node --from=build \/app\/node_modules \.\/node_modules/);
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

test('CI smoke-runs API and web Docker images after building them', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /name:\s+Smoke API Docker image/);
  assert.match(workflow, /docker run -d --name charitypilot-api-smoke[\s\S]*charitypilot-api-ci/);
  assert.match(workflow, /-e JWT_SECRET=ci-smoke-jwt-secret-with-enough-entropy/);
  assert.match(workflow, /-e RESEND_API_KEY=re_ci_smoke_key/);
  assert.match(workflow, /docker ps --filter name=charitypilot-api-smoke --filter status=running --quiet/);
  assert.match(workflow, /api_headers="\$\(mktemp\)"/);
  assert.match(workflow, /curl --fail --silent --dump-header "\$\{api_headers\}" http:\/\/127\.0\.0\.1:3002\/api\/v1\/health/);
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'" "\$\{api_headers\}"/);
  assert.match(workflow, /docker rm -f charitypilot-api-smoke/);
  assert.match(workflow, /name:\s+Verify API Docker runtime dependencies/);
  assert.match(workflow, /docker run --rm --entrypoint node charitypilot-api-ci[\s\S]*@prisma\/client/);
  assert.match(workflow, /for \(const pkg of \['typescript', 'tsx', 'prisma', 'turbo', 'next', 'react', 'react-dom', '@heroui\/react'\]/);

  assert.match(workflow, /name:\s+Smoke web Docker image/);
  assert.match(workflow, /docker run -d --name charitypilot-web-smoke[\s\S]*charitypilot-web-ci/);
  assert.match(workflow, /name:\s+Smoke web Docker image[\s\S]*-e NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie[\s\S]*charitypilot-web-ci/);
  assert.match(workflow, /docker ps --filter name=charitypilot-web-smoke --filter status=running --quiet/);
  assert.match(workflow, /web_headers="\$\(mktemp\)"/);
  assert.match(workflow, /curl --fail --silent --dump-header "\$\{web_headers\}" http:\/\/127\.0\.0\.1:3003\//);
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^strict-transport-security: max-age=63072000; includeSubDomains; preload" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^content-security-policy: .*frame-ancestors 'none'.*connect-src 'self' https:\/\/api\.charitypilot\.ie" "\$\{web_headers\}"/);
  assert.match(workflow, /docker rm -f charitypilot-web-smoke/);
  assert.match(workflow, /name:\s+Verify web Docker runtime dependencies/);
  assert.match(workflow, /docker run --rm --entrypoint node charitypilot-web-ci[\s\S]*require\.resolve\('next'\)/);
  assert.match(workflow, /for \(const pkg of \['typescript', 'eslint', 'turbo'\]/);

  assert.ok(
    workflow.indexOf('name: Build API Docker image') < workflow.indexOf('name: Smoke API Docker image'),
    'API image must be built before the API smoke run',
  );
  assert.ok(
    workflow.indexOf('name: Build web Docker image') < workflow.indexOf('name: Smoke web Docker image'),
    'web image must be built before the web smoke run',
  );
  assert.ok(
    workflow.indexOf('name: Build API Docker image') < workflow.indexOf('name: Verify API Docker runtime dependencies'),
    'API image must be built before runtime dependency inspection',
  );
  assert.ok(
    workflow.indexOf('name: Build web Docker image') < workflow.indexOf('name: Verify web Docker runtime dependencies'),
    'web image must be built before runtime dependency inspection',
  );
});

test('CI validates API production env inside the built Docker image', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /name:\s+Validate API Docker production configuration/);
  assert.match(workflow, /docker run --rm[\s\S]*charitypilot-api-ci[\s\S]*validateProductionEnv/);
  assert.match(workflow, /-e NODE_ENV=production/);
  assert.match(workflow, /-e TRUSTED_PROXY_ADDRESSES=10\.0\.0\.10/);
  assert.match(workflow, /-e DATABASE_URL=postgresql:\/\/charitypilot:charitypilot@db\.charitypilot\.ie:5432\/charitypilot\?sslmode=require/);
  assert.match(workflow, /-e STRIPE_SECRET_KEY=sk_live_ci_configured_secret/);
  assert.match(workflow, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.example\/hooks\/charitypilot/);
  assert.ok(
    workflow.indexOf('name: Build API Docker image') < workflow.indexOf('name: Validate API Docker production configuration'),
    'API image must be built before validating production configuration inside it',
  );
  assert.ok(
    workflow.indexOf('name: Validate API Docker production configuration') < workflow.indexOf('name: Smoke API Docker image'),
    'production configuration must be validated before the API smoke run',
  );
});

test('release workflow publishes runtime and migration Docker images to GHCR', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');

  assert.match(workflow, /name:\s+Release Images/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /inputs:[\s\S]*image_tag/);
  assert.match(workflow, /push:[\s\S]*tags:[\s\S]*- 'v\*'/);
  assert.match(workflow, /permissions:[\s\S]*contents:\s+read[\s\S]*packages:\s+write/);
  assert.match(workflow, /environment:\s+production/);
  assert.match(workflow, /REGISTRY:\s+ghcr\.io/);
  assert.match(workflow, /name:\s+Validate release ref/);
  assert.match(workflow, /Manual image releases must run from master/);
  assert.match(workflow, /Docker tag must match \[a-z0-9_\]\[a-z0-9_.-\]\{0,127\}/);
  assert.match(workflow, /docker login "\$\{REGISTRY\}"/);
  assert.match(workflow, /docker build -f apps\/api\/Dockerfile --target migration-runner[\s\S]*-t charitypilot-api-migrations-ci \./);
  assert.match(workflow, /docker run --rm[\s\S]*charitypilot-api-migrations-ci[\s\S]*migrate status --schema prisma\/schema\.prisma/);
  assert.match(workflow, /docker build -f apps\/api\/Dockerfile --build-arg DATABASE_URL=postgresql:\/\/charitypilot:charitypilot_ci@localhost:5432\/charitypilot_ci -t charitypilot-api-ci \./);
  assert.match(workflow, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.example\/hooks\/charitypilot/);
  assert.match(workflow, /for \(const pkg of \['typescript', 'tsx', 'prisma', 'turbo', 'next', 'react', 'react-dom', '@heroui\/react'\]/);
  assert.match(workflow, /api_headers="\$\(mktemp\)"/);
  assert.match(workflow, /curl --fail --silent --dump-header "\$\{api_headers\}" http:\/\/127\.0\.0\.1:3002\/api\/v1\/health/);
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'" "\$\{api_headers\}"/);
  assert.match(workflow, /docker build -f apps\/web\/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie -t charitypilot-web-ci \./);
  assert.match(workflow, /web_headers="\$\(mktemp\)"/);
  assert.match(workflow, /name:\s+Smoke web Docker image[\s\S]*-e NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie[\s\S]*charitypilot-web-ci/);
  assert.match(workflow, /curl --fail --silent --dump-header "\$\{web_headers\}" http:\/\/127\.0\.0\.1:3003\//);
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^strict-transport-security: max-age=63072000; includeSubDomains; preload" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^content-security-policy: .*frame-ancestors 'none'.*connect-src 'self' https:\/\/api\.charitypilot\.ie" "\$\{web_headers\}"/);
  assert.match(workflow, /docker tag charitypilot-api-ci "\$\{api_image\}"/);
  assert.match(workflow, /docker tag charitypilot-web-ci "\$\{web_image\}"/);
  assert.match(workflow, /docker tag charitypilot-api-migrations-ci "\$\{migration_image\}"/);
  assert.match(workflow, /docker push "\$\{api_image\}"/);
  assert.match(workflow, /docker push "\$\{web_image\}"/);
  assert.match(workflow, /docker push "\$\{migration_image\}"/);

  assert.ok(
    workflow.indexOf('name: Build migration runner image') <
      workflow.indexOf('name: Run migration runner against CI PostgreSQL'),
    'migration runner image must be built before its smoke run',
  );
  assert.ok(
    workflow.indexOf('name: Smoke web Docker image') < workflow.indexOf('name: Push image tags'),
    'images must be smoke-tested before publishing',
  );
  assert.ok(
    workflow.indexOf('name: Run migration runner against CI PostgreSQL') < workflow.indexOf('name: Push image tags'),
    'migration runner must be tested before publishing',
  );
  assert.ok(
    workflow.indexOf('name: Validate API Docker production configuration') < workflow.indexOf('name: Push image tags'),
    'API production config must be validated before publishing',
  );
  assert.ok(
    workflow.indexOf('name: Smoke API Docker image') < workflow.indexOf('name: Push image tags'),
    'API image must be smoke-tested before publishing',
  );
});

test('stale Vercel API project auto-deploys are disabled while Docker is the release gate', () => {
  const apiVercelConfig = JSON.parse(readRepoFile('apps/api/vercel.json'));

  assert.equal(apiVercelConfig.$schema, 'https://openapi.vercel.sh/vercel.json');
  assert.equal(apiVercelConfig.git?.deploymentEnabled, false);
});
