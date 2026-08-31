import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import {
  validateDeadlineRemindersEnv,
  validateProductionEnv,
} from '../utils/env.js';

const ORIGINAL_ENV = { ...process.env };
const AUTH_RECOVERY_TEST_SECRET = '0123456789abcdef'.repeat(4);

// Every env var either validator reads, plus the three new deployment-origin
// / alert-webhook vars this suite exercises, so each test starts from a
// clean slate and restores whatever was there before it ran (mirrors
// deployment-profile-env-validation.test.ts's discipline).
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
  'CHARITYPILOT_CANONICAL_WEB_ORIGIN',
  'CHARITYPILOT_CANONICAL_API_ORIGIN',
  'CHARITYPILOT_ERROR_ALERTS',
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

// The hosted SaaS's full production configuration: multi-tenant, provider
// email, Stripe billing, Supabase storage. This is the fixture the "must
// validate byte-identically with zero new vars" invariant is about.
function hostedEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    PORT: '3002',
    TRUSTED_PROXY_ADDRESSES: '10.0.0.10',
    READINESS_API_KEY: 'configured-readiness-key-32-chars',
    DATABASE_URL:
      'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write',
    JWT_SECRET: 'a'.repeat(40),
    OWNER_JWT_SECRET: 'b'.repeat(40),
    AUTH_RECOVERY_SECRET: AUTH_RECOVERY_TEST_SECRET,
    FRONTEND_URL: 'https://app.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    ERROR_ALERT_WEBHOOK_URL: 'https://alerts.charitypilot.ie/hooks/charitypilot',
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
  };

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// A job validator's minimal env (validateDeadlineRemindersEnv only reads
// DATABASE_URL, FRONTEND_URL, RESEND_API_KEY, EMAIL_FROM, and the alert
// webhook — no NEXT_PUBLIC_API_URL/AUTH_COOKIE_DOMAIN, so origin tests here
// aren't entangled with the cookie-domain cross-check).
function deadlineRemindersEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    DATABASE_URL:
      'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write',
    FRONTEND_URL: 'https://app.charitypilot.ie',
    RESEND_API_KEY: 're_realisticConfiguredSecret',
    EMAIL_FROM: 'noreply@charitypilot.ie',
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

test('defaults unchanged: canonical charitypilot.ie origins still required with no new vars', () => {
  hostedEnv({ FRONTEND_URL: 'https://example.org' });

  const issues = issuesOf(() => validateProductionEnv());
  assert.ok(
    issues.includes('FRONTEND_URL must use the canonical production web origin https://app.charitypilot.ie'),
    `expected canonical web origin issue, got: ${JSON.stringify(issues)}`,
  );
});

test('configured canonical origins are honoured', () => {
  const configuredOrigin = 'https://charitypilot.tail1234.ts.net';

  deadlineRemindersEnv({
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: configuredOrigin,
    FRONTEND_URL: configuredOrigin,
  });
  assert.deepEqual(
    issuesOf(() => validateDeadlineRemindersEnv()),
    [],
  );

  deadlineRemindersEnv({
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: configuredOrigin,
    FRONTEND_URL: 'https://app.charitypilot.ie',
  });
  const issues = issuesOf(() => validateDeadlineRemindersEnv());
  assert.ok(
    issues.includes(`FRONTEND_URL must use the canonical production web origin ${configuredOrigin}`),
    `expected issue naming the configured origin, got: ${JSON.stringify(issues)}`,
  );
});

test('a non-https canonical origin override is itself rejected', () => {
  deadlineRemindersEnv({
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: 'http://x',
  });

  const issues = issuesOf(() => validateDeadlineRemindersEnv());
  assert.ok(
    issues.includes('CHARITYPILOT_CANONICAL_WEB_ORIGIN must be an exact https origin (no path, no trailing slash)'),
    `expected issue naming CHARITYPILOT_CANONICAL_WEB_ORIGIN, got: ${JSON.stringify(issues)}`,
  );
});

test('alerts default: webhook still required', () => {
  hostedEnv({ ERROR_ALERT_WEBHOOK_URL: undefined });

  const issues = issuesOf(() => validateProductionEnv());
  assert.ok(
    issues.some((issue) => issue.includes('ERROR_ALERT_WEBHOOK_URL')),
    `expected an ERROR_ALERT_WEBHOOK_URL issue, got: ${JSON.stringify(issues)}`,
  );
});

test('alerts none: webhook not required and, if present, still validated', () => {
  hostedEnv({
    CHARITYPILOT_ERROR_ALERTS: 'none',
    ERROR_ALERT_WEBHOOK_URL: undefined,
  });
  assert.deepEqual(
    issuesOf(() => validateProductionEnv()).filter((issue) => issue.includes('ERROR_ALERT_WEBHOOK_URL')),
    [],
  );

  hostedEnv({
    CHARITYPILOT_ERROR_ALERTS: 'none',
    ERROR_ALERT_WEBHOOK_URL: 'http://insecure.example/hooks',
  });
  const issues = issuesOf(() => validateProductionEnv());
  assert.ok(
    issues.some((issue) => issue.includes('ERROR_ALERT_WEBHOOK_URL')),
    `expected a shape-validation issue for the configured webhook, got: ${JSON.stringify(issues)}`,
  );
});

test('alerts axis invalid value fails at boot via assertDeploymentProfile-style naming', () => {
  hostedEnv({ CHARITYPILOT_ERROR_ALERTS: 'slack' });

  const issues = issuesOf(() => validateProductionEnv());
  assert.ok(
    issues.includes('CHARITYPILOT_ERROR_ALERTS must be webhook | none (got "slack")'),
    `expected issue naming CHARITYPILOT_ERROR_ALERTS, got: ${JSON.stringify(issues)}`,
  );
});

test('job validator (deadline reminders): alerts=none both directions', () => {
  deadlineRemindersEnv({
    CHARITYPILOT_ERROR_ALERTS: 'none',
    ERROR_ALERT_WEBHOOK_URL: undefined,
  });
  assert.deepEqual(
    issuesOf(() => validateDeadlineRemindersEnv()).filter((issue) => issue.includes('ERROR_ALERT_WEBHOOK_URL')),
    [],
  );

  deadlineRemindersEnv({
    CHARITYPILOT_ERROR_ALERTS: 'webhook',
    ERROR_ALERT_WEBHOOK_URL: undefined,
  });
  const issues = issuesOf(() => validateDeadlineRemindersEnv());
  assert.ok(
    issues.some((issue) => issue.includes('ERROR_ALERT_WEBHOOK_URL')),
    `expected an ERROR_ALERT_WEBHOOK_URL issue under the webhook mode, got: ${JSON.stringify(issues)}`,
  );
});
