import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import { validateProductionEnv } from '../utils/env.js';

const ORIGINAL_ENV = { ...process.env };
const AUTH_RECOVERY_TEST_SECRET = '0123456789abcdef'.repeat(4);

// Every env var either validateProductionEnv or the deployment-profile axes
// it now consults read, so each test starts from a clean slate and restores
// whatever was there before it ran.
const ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'TRUSTED_PROXY_ADDRESSES',
  'READINESS_API_KEY',
  'DATABASE_URL',
  'JWT_SECRET',
  'OWNER_JWT_SECRET',
  'AUTH_RECOVERY_SECRET',
  'FRONTEND_URL',
  'AUTH_COOKIE_DOMAIN',
  'NEXT_PUBLIC_API_URL',
  'ERROR_ALERT_WEBHOOK_URL',
  'CHARITYPILOT_DEPLOYMENT_MODE',
  'CHARITYPILOT_TENANCY',
  'CHARITYPILOT_EMAIL_DELIVERY',
  'CHARITYPILOT_BILLING',
  'DOCUMENT_STORAGE_DRIVER',
  'LOCAL_FILE_STORAGE_DIR',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AUTH_RECOVERY_SECRET = AUTH_RECOVERY_TEST_SECRET;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

// The baseline vars validateProductionEnv requires unconditionally,
// regardless of any deployment-profile axis: PORT, proxy/database/JWT
// config, FRONTEND_URL/NEXT_PUBLIC_API_URL/cookie domain, and the webhook
// alert URL. Individual tests layer axis-specific overrides on top.
function baselineEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    PORT: '3002',
    TRUSTED_PROXY_ADDRESSES: '10.0.0.10',
    READINESS_API_KEY: 'configured-readiness-key-32-chars',
    DATABASE_URL:
      'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write',
    JWT_SECRET: 'a'.repeat(40),
    AUTH_RECOVERY_SECRET: AUTH_RECOVERY_TEST_SECRET,
    FRONTEND_URL: 'https://app.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    ERROR_ALERT_WEBHOOK_URL: 'https://alerts.charitypilot.ie/hooks/charitypilot',
    ...overrides,
  };

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// A fully self-contained configuration: local document storage, manual-link
// email delivery, no billing provider. Multi-tenancy is left at its default
// (multi), so OWNER_JWT_SECRET is still required and provided.
function selfContainedEnv(storageDir: string, overrides: Record<string, string | undefined> = {}) {
  baselineEnv({
    OWNER_JWT_SECRET: 'b'.repeat(40),
    CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
    CHARITYPILOT_BILLING: 'none',
    DOCUMENT_STORAGE_DRIVER: 'local',
    LOCAL_FILE_STORAGE_DIR: storageDir,
    ...overrides,
  });
}

function setCompleteProviderEnv(overrides: Record<string, string | undefined> = {}) {
  baselineEnv({
    OWNER_JWT_SECRET: 'b'.repeat(40),
    STRIPE_SECRET_KEY: 'sk_live_realisticConfiguredSecret',
    STRIPE_WEBHOOK_SECRET: 'whsec_realisticConfiguredSecret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_essentialsMonthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_essentialsYearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_completeMonthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_completeYearly',
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_configuredPortal',
    RESEND_API_KEY: 're_realisticConfiguredSecret',
    EMAIL_FROM: 'noreply@charitypilot.ie',
    SUPABASE_URL: 'https://configured-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'configured-service-role-key',
    SUPABASE_STORAGE_BUCKET: 'documents',
    ...overrides,
  });
}

function issuesOf(run: () => void): string[] {
  try {
    run();
    return [];
  } catch (error) {
    if (error instanceof AppError && Array.isArray(error.details)) {
      return error.details as string[];
    }
    throw error;
  }
}

test('self-contained config passes: storage local, email manual-link, billing none', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'charitypilot-self-contained-'));
  try {
    selfContainedEnv(storageDir);
    const issues = issuesOf(() => validateProductionEnv());
    assert.deepEqual(
      issues.filter((issue) => /SUPABASE|RESEND|EMAIL_FROM|STRIPE/.test(issue)),
      [],
    );
    assert.deepEqual(issues, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('local storage still requires the local storage path config', () => {
  selfContainedEnv('', { LOCAL_FILE_STORAGE_DIR: undefined });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('LOCAL_FILE_STORAGE_DIR must be an absolute non-root filesystem path'),
  );
});

test('provider email still requires RESEND_API_KEY and EMAIL_FROM', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'charitypilot-provider-email-'));
  try {
    // Default axes (no CHARITYPILOT_EMAIL_DELIVERY set) => 'provider'.
    selfContainedEnv(storageDir, {
      CHARITYPILOT_EMAIL_DELIVERY: undefined,
      RESEND_API_KEY: undefined,
      EMAIL_FROM: undefined,
    });

    assert.throws(
      () => validateProductionEnv(),
      (error: unknown) =>
        error instanceof AppError &&
        Array.isArray(error.details) &&
        error.details.some((issue) => issue.includes('RESEND_API_KEY')) &&
        error.details.some((issue) => issue.includes('EMAIL_FROM')),
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('supabase storage still requires the trio', () => {
  // Default axes (no DOCUMENT_STORAGE_DRIVER set) => Supabase branch.
  setCompleteProviderEnv({
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_STORAGE_BUCKET: undefined,
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.some((issue) => issue.includes('SUPABASE_URL')) &&
      error.details.some((issue) => issue.includes('SUPABASE_SERVICE_ROLE_KEY')) &&
      error.details.some((issue) => issue.includes('SUPABASE_STORAGE_BUCKET')),
  );
});

test('stripe billing still requires the stripe secrets', () => {
  // Default axes (no CHARITYPILOT_BILLING set) => 'stripe'.
  setCompleteProviderEnv({
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.some((issue) => issue.includes('STRIPE_SECRET_KEY')) &&
      error.details.some((issue) => issue.includes('STRIPE_WEBHOOK_SECRET')),
  );
});

test('multi tenancy still requires OWNER_JWT_SECRET distinct from JWT_SECRET', () => {
  setCompleteProviderEnv({
    // CHARITYPILOT_TENANCY left unset => defaults to 'multi'.
    JWT_SECRET: 'a'.repeat(40),
    OWNER_JWT_SECRET: 'a'.repeat(40),
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('OWNER_JWT_SECRET must be distinct from JWT_SECRET'),
  );

  setCompleteProviderEnv({
    OWNER_JWT_SECRET: undefined,
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.some((issue) => issue.includes('OWNER_JWT_SECRET')),
  );
});

test('single tenancy skips the OWNER_JWT_SECRET requirement', () => {
  setCompleteProviderEnv({
    CHARITYPILOT_TENANCY: 'single',
    OWNER_JWT_SECRET: undefined,
  });

  const issues = issuesOf(() => validateProductionEnv());
  assert.deepEqual(
    issues.filter((issue) => issue.includes('OWNER_JWT_SECRET')),
    [],
  );
});
