import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import {
  validateAuthDeliveryEnv,
  validateDeadlineRemindersEnv,
  validateDocumentStorageCleanupEnv,
  validateProductionEnv,
} from '../utils/env.js';

const ORIGINAL_ENV = { ...process.env };
const AUTH_RECOVERY_TEST_SECRET = '0123456789abcdef'.repeat(4);

beforeEach(() => {
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

function setCompleteProductionEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    PORT: '3002',
    TRUSTED_PROXY_ADDRESSES: '10.0.0.10',
    READINESS_API_KEY: 'configured-readiness-key-32-chars',
    DATABASE_URL: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write',
    JWT_SECRET: 'a'.repeat(40),
    AUTH_RECOVERY_SECRET: AUTH_RECOVERY_TEST_SECRET,
    FRONTEND_URL: 'https://app.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
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

test('validateProductionEnv rejects placeholder production configuration', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://example';
  process.env.JWT_SECRET = 'a'.repeat(32);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_test_...';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_...';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_...';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_...';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_...';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_...';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_...';
  process.env.RESEND_API_KEY = 're_...';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://your-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJ...';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      error.message === 'Production environment is not ready' &&
      Array.isArray(error.details) &&
      error.details.some((issue: string) => issue.includes('STRIPE_SECRET_KEY')),
  );
});

test('validateProductionEnv accepts complete production configuration', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_configuredPortal';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.doesNotThrow(() => validateProductionEnv());
});

test('validateProductionEnv requires a distinct high-entropy recovery secret', () => {
  setCompleteProductionEnv({ AUTH_RECOVERY_SECRET: undefined });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('AUTH_RECOVERY_SECRET is missing or still contains a placeholder value'),
  );

  setCompleteProductionEnv({ AUTH_RECOVERY_SECRET: 'short' });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('AUTH_RECOVERY_SECRET must be at least 43 characters'),
  );

  for (const invalid of [
    `${AUTH_RECOVERY_TEST_SECRET}!`,
    `${AUTH_RECOVERY_TEST_SECRET}=`,
    Buffer.alloc(65, 7).toString('base64url'),
  ]) {
    setCompleteProductionEnv({ AUTH_RECOVERY_SECRET: invalid });
    assert.throws(
      () => validateProductionEnv(),
      (error: unknown) =>
        error instanceof AppError &&
        Array.isArray(error.details) &&
        error.details.some((issue: string) =>
          issue.includes('AUTH_RECOVERY_SECRET must'),
        ),
    );
  }

  setCompleteProductionEnv({
    AUTH_RECOVERY_SECRET: 'a'.repeat(40),
    JWT_SECRET: 'a'.repeat(40),
  });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('AUTH_RECOVERY_SECRET must be distinct from JWT_SECRET and READINESS_API_KEY'),
  );
});

test('validateAuthDeliveryEnv accepts bounded scheduler configuration and rejects unsafe timing', () => {
  setCompleteProductionEnv({
    SECURITY_EMAIL_PROVIDER_TIMEOUT_MS: '8000',
    AUTH_DELIVERY_INTERVAL_MS: '5000',
    AUTH_DELIVERY_BATCH_SIZE: '25',
    AUTH_DELIVERY_CLEANUP_BATCH_SIZE: '500',
    AUTH_DELIVERY_STALE_SENDING_MS: '60000',
  });
  assert.doesNotThrow(() => validateAuthDeliveryEnv());

  process.env.AUTH_DELIVERY_STALE_SENDING_MS = '8000';
  assert.throws(
    () => validateAuthDeliveryEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'AUTH_DELIVERY_ENV_INVALID' &&
      Array.isArray(error.details) &&
      error.details.some((issue: string) => issue.includes('AUTH_DELIVERY_STALE_SENDING_MS')),
  );

  process.env.AUTH_DELIVERY_STALE_SENDING_MS = '60000';
  process.env.AUTH_DELIVERY_CLEANUP_BATCH_SIZE = '2';
  assert.throws(
    () => validateAuthDeliveryEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('AUTH_DELIVERY_CLEANUP_BATCH_SIZE must be an integer from 3 to 1000'),
  );
});

test('validateProductionEnv requires exact authenticated read-write PostgreSQL routing', async (t) => {
  const cases = [
    {
      name: 'sslmode=require',
      databaseUrl: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require&target_session_attrs=read-write',
      issue: 'DATABASE_URL must use exact lowercase sslmode=verify-full in production',
    },
    {
      name: 'sslmode=verify-ca',
      databaseUrl: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-ca&target_session_attrs=read-write',
      issue: 'DATABASE_URL must use exact lowercase sslmode=verify-full in production',
    },
    {
      name: 'uppercase sslmode value',
      databaseUrl: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=VERIFY-FULL&target_session_attrs=read-write',
      issue: 'DATABASE_URL must use exact lowercase sslmode=verify-full in production',
    },
    {
      name: 'duplicate sslmode',
      databaseUrl: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&sslmode=verify-full&target_session_attrs=read-write',
      issue: 'DATABASE_URL must use exact lowercase sslmode=verify-full in production',
    },
    {
      name: 'missing target_session_attrs',
      databaseUrl: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full',
      issue: 'DATABASE_URL must explicitly set target_session_attrs=read-write in production',
    },
    {
      name: 'duplicate target_session_attrs',
      databaseUrl: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write&target_session_attrs=read-write',
      issue: 'DATABASE_URL must explicitly set target_session_attrs=read-write in production',
    },
    {
      name: 'wrong target_session_attrs',
      databaseUrl: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-only',
      issue: 'DATABASE_URL must explicitly set target_session_attrs=read-write in production',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      setCompleteProductionEnv({ DATABASE_URL: entry.databaseUrl });

      assert.throws(
        () => validateProductionEnv(),
        (error: unknown) =>
          error instanceof AppError &&
          Array.isArray(error.details) &&
          error.details.includes(entry.issue),
      );
    });
  }

  setCompleteProductionEnv({
    DATABASE_URL: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write',
  });
  assert.doesNotThrow(() => validateProductionEnv());
});

test('validateProductionEnv requires a pinned Stripe portal configuration and distinct prices', () => {
  setCompleteProductionEnv({
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: undefined,
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_essentialsMonthly',
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes(
        'STRIPE_BILLING_PORTAL_CONFIGURATION_ID is missing or still contains a placeholder value',
      ) &&
      error.details.includes('Stripe price IDs must be distinct for each plan and billing interval'),
  );
});

test('validateProductionEnv rejects copied Supabase project-ref placeholders', () => {
  setCompleteProductionEnv({
    SUPABASE_URL: 'https://REAL_SUPABASE_PROJECT_REF.supabase.co',
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('SUPABASE_URL is missing or still contains a placeholder value'),
  );
});

test('validateProductionEnv rejects local document storage in production', () => {
  setCompleteProductionEnv({ DOCUMENT_STORAGE_DRIVER: 'local' });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('DOCUMENT_STORAGE_DRIVER must not be local in production; use Supabase document storage'),
  );
});

test('validateDocumentStorageCleanupEnv rejects local document storage in production', () => {
  setCompleteProductionEnv({ DOCUMENT_STORAGE_DRIVER: 'local' });

  assert.throws(
    () => validateDocumentStorageCleanupEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('DOCUMENT_STORAGE_DRIVER must not be local in production; use Supabase document storage'),
  );
});

test('validateProductionEnv rejects non-canonical production public origins', () => {
  setCompleteProductionEnv({
    FRONTEND_URL: 'https://charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://services.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('FRONTEND_URL must use the canonical production web origin https://app.charitypilot.ie') &&
      error.details.includes('NEXT_PUBLIC_API_URL must use the canonical production API origin https://api.charitypilot.ie'),
  );
});

test('validateDeadlineRemindersEnv rejects non-canonical production frontend origins', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.FRONTEND_URL = 'https://charitypilot.ie';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.throws(
    () => validateDeadlineRemindersEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('FRONTEND_URL must use the canonical production web origin https://app.charitypilot.ie'),
  );
});

test('validateProductionEnv rejects malformed or overlong access token expiry values', () => {
  for (const [expiry, expectedIssue] of [
    ['forever', 'JWT_EXPIRY must be a duration like 15m, 1h, or 3600s'],
    ['2h', 'JWT_EXPIRY must not exceed 1h in production'],
  ] as const) {
    setCompleteProductionEnv({ JWT_EXPIRY: expiry });

    assert.throws(
      () => validateProductionEnv(),
      (error: unknown) =>
        error instanceof AppError &&
        Array.isArray(error.details) &&
        error.details.includes(expectedIssue),
    );
  }
});

test('validateProductionEnv rejects malformed or out-of-range refresh token TTL values', () => {
  for (const ttl of ['forever', '0', '-1', '31']) {
    setCompleteProductionEnv({ REFRESH_TOKEN_TTL_DAYS: ttl });

    assert.throws(
      () => validateProductionEnv(),
      (error: unknown) =>
        error instanceof AppError &&
        Array.isArray(error.details) &&
        error.details.includes('REFRESH_TOKEN_TTL_DAYS must be an integer from 1 to 30'),
    );
  }
});

test('validateProductionEnv rejects unapproved production email sender domains', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_configuredPortal';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@attacker.example';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('EMAIL_FROM must use an approved CharityPilot sender domain in production'),
  );
});

test('validateProductionEnv rejects malformed billing and email provider identifiers', () => {
  setCompleteProductionEnv({
    STRIPE_WEBHOOK_SECRET: 'configured-webhook-secret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'essentialsMonthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'essentialsYearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'completeMonthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'completeYearly',
    RESEND_API_KEY: 'configuredResendSecret',
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('STRIPE_WEBHOOK_SECRET must use a Stripe webhook signing secret in production') &&
      error.details.includes('STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must use a Stripe price ID in production') &&
      error.details.includes('STRIPE_ESSENTIALS_YEARLY_PRICE_ID must use a Stripe price ID in production') &&
      error.details.includes('STRIPE_COMPLETE_MONTHLY_PRICE_ID must use a Stripe price ID in production') &&
      error.details.includes('STRIPE_COMPLETE_YEARLY_PRICE_ID must use a Stripe price ID in production') &&
      error.details.includes('RESEND_API_KEY must use a Resend API key in production'),
  );
});

test('validateDocumentStorageCleanupEnv accepts storage-only production configuration', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.doesNotThrow(() => validateDocumentStorageCleanupEnv());
});

test('validateDeadlineRemindersEnv accepts reminder-only production configuration', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.doesNotThrow(() => validateDeadlineRemindersEnv());
});

test('validateDeadlineRemindersEnv rejects malformed Resend API keys in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.RESEND_API_KEY = 'configuredResendSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.throws(
    () => validateDeadlineRemindersEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      error.message === 'Deadline reminders environment is not ready' &&
      Array.isArray(error.details) &&
      error.details.includes('RESEND_API_KEY must use a Resend API key in production'),
  );
});

test('validateDeadlineRemindersEnv rejects missing reminder-only production configuration', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot';
  process.env.FRONTEND_URL = 'https://localhost:3003';
  delete process.env.RESEND_API_KEY;
  process.env.EMAIL_FROM = 'noreply@attacker.example';
  delete process.env.ERROR_ALERT_WEBHOOK_URL;

  assert.throws(
    () => validateDeadlineRemindersEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      error.message === 'Deadline reminders environment is not ready' &&
      Array.isArray(error.details) &&
      error.details.includes('DATABASE_URL must use exact lowercase sslmode=verify-full in production') &&
      error.details.includes('FRONTEND_URL must not point at localhost in production') &&
      error.details.includes('RESEND_API_KEY is missing or still contains a placeholder value') &&
      error.details.includes('EMAIL_FROM must use an approved CharityPilot sender domain in production') &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value'),
  );
});

test('validateDeadlineRemindersEnv rejects missing production job alert webhook', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  delete process.env.ERROR_ALERT_WEBHOOK_URL;

  assert.throws(
    () => validateDeadlineRemindersEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value'),
  );
});

test('validateProductionEnv rejects missing production error alert webhook', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value'),
  );
});

test('validateProductionEnv rejects local production error alert webhooks', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'http://localhost:3030/alerts';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL must use https:// in production') &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL must not point at localhost in production'),
  );
});

test('validateProductionEnv rejects reserved documentation error alert webhooks', () => {
  setCompleteProductionEnv({
    ERROR_ALERT_WEBHOOK_URL: 'https://alerts.example/hooks/charitypilot',
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL in production'),
  );
});

test('validateProductionEnv rejects private production error alert webhooks', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  for (const webhookUrl of [
    'https://10.0.0.5/alerts',
    'https://[::ffff:10.0.0.5]/alerts',
    'https://[fec0::1]/alerts',
    'https://[64:ff9b::a00:5]/alerts',
    'https://[100::]/alerts',
    'https://[2001:2::1]/alerts',
  ]) {
    process.env.ERROR_ALERT_WEBHOOK_URL = webhookUrl;

    assert.throws(
      () => validateProductionEnv(),
      (error: unknown) =>
        error instanceof AppError &&
        Array.isArray(error.details) &&
        error.details.includes('ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL in production'),
    );
  }
});

test('validateProductionEnv rejects malformed production error alert webhook hostnames', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  for (const webhookUrl of [
    'https://alerts..example.com/hooks',
    'https://alert_webhook.example.com/hooks',
    'https://-alerts.example.com/hooks',
  ]) {
    process.env.ERROR_ALERT_WEBHOOK_URL = webhookUrl;

    assert.throws(
      () => validateProductionEnv(),
      (error: unknown) =>
        error instanceof AppError &&
        Array.isArray(error.details) &&
        error.details.includes('ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL in production'),
    );
  }
});

test('validateDocumentStorageCleanupEnv rejects missing storage cleanup configuration', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;
  delete process.env.ERROR_ALERT_WEBHOOK_URL;

  assert.throws(
    () => validateDocumentStorageCleanupEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      error.message === 'Document storage cleanup environment is not ready' &&
      Array.isArray(error.details) &&
      error.details.includes('DATABASE_URL must use exact lowercase sslmode=verify-full in production') &&
      error.details.includes('SUPABASE_URL is missing or still contains a placeholder value') &&
      error.details.includes('SUPABASE_SERVICE_ROLE_KEY is missing or still contains a placeholder value') &&
      error.details.includes('SUPABASE_STORAGE_BUCKET is missing or still contains a placeholder value') &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value'),
  );
});

test('validateDocumentStorageCleanupEnv rejects private Supabase URLs', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.SUPABASE_URL = 'https://10.0.0.5';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.throws(
    () => validateDocumentStorageCleanupEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('SUPABASE_URL must use a public, non-local URL in production'),
  );
});

test('validateDocumentStorageCleanupEnv rejects missing production job alert webhook', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  delete process.env.ERROR_ALERT_WEBHOOK_URL;

  assert.throws(
    () => validateDocumentStorageCleanupEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value'),
  );
});

test('validateProductionEnv rejects private Supabase URLs', () => {
  setCompleteProductionEnv({ SUPABASE_URL: 'https://10.0.0.5' });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('SUPABASE_URL must use a public, non-local URL in production'),
  );
});

test('validateProductionEnv rejects missing production readiness key', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('READINESS_API_KEY is missing or still contains a placeholder value'),
  );
});

test('validateProductionEnv rejects short production readiness keys', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'short-readiness-key';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('READINESS_API_KEY must be at least 32 characters'),
  );
});

test('validateProductionEnv requires explicit trusted proxy addresses in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('TRUSTED_PROXY_ADDRESSES must list the reverse proxy address or CIDR for production rate limits'),
  );
});

test('validateProductionEnv rejects comma-separated non-canonical production frontend origins', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie, https://admin.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('FRONTEND_URL must use the canonical production web origin https://app.charitypilot.ie'),
  );
});

test('validateProductionEnv rejects missing production API origin used for cookie-domain checks', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('NEXT_PUBLIC_API_URL is missing or still contains a placeholder value'),
  );
});

test('validateProductionEnv rejects split production web and API hosts without a shared auth cookie domain', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('AUTH_COOKIE_DOMAIN must be set when FRONTEND_URL and NEXT_PUBLIC_API_URL use different hostnames'),
  );
});

test('validateProductionEnv rejects auth cookie domains that do not cover production web and API hosts', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.admin.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('AUTH_COOKIE_DOMAIN must cover both FRONTEND_URL and NEXT_PUBLIC_API_URL hostnames'),
  );
});

test('validateProductionEnv rejects invalid auth cookie domains even for same-host deployments', () => {
  setCompleteProductionEnv({
    FRONTEND_URL: 'https://charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.attacker.example',
  });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('AUTH_COOKIE_DOMAIN must use an approved CharityPilot production hostname'),
  );
});

test('validateProductionEnv rejects unapproved production public hostnames', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://attacker.example';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.attacker.example';
  process.env.AUTH_COOKIE_DOMAIN = '.attacker.example';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('FRONTEND_URL must use an approved CharityPilot production hostname') &&
      error.details.includes('NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname'),
  );
});

test('validateProductionEnv rejects production database URLs without TLS', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('DATABASE_URL must use exact lowercase sslmode=verify-full in production'),
  );
});

test('validateProductionEnv rejects production frontend URLs that are not origins', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie/login';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('FRONTEND_URL must be an origin-only URL in production'),
  );
});

test('validateProductionEnv rejects local URLs and Stripe test mode in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002abc';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://localhost:3003';
  process.env.NEXT_PUBLIC_API_URL = 'https://127.0.0.1:3002';
  process.env.STRIPE_SECRET_KEY = 'sk_test_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('PORT must be an integer from 1 to 65535') &&
      error.details.includes('DATABASE_URL must not point at localhost in production') &&
      error.details.includes('FRONTEND_URL must not point at localhost in production') &&
      error.details.includes('NEXT_PUBLIC_API_URL must not point at localhost in production') &&
      error.details.includes('STRIPE_SECRET_KEY must use a live Stripe secret key in production'),
  );
});

test('validateProductionEnv rejects the local database smoke override outside GitHub Actions', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_configuredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_configuredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_configuredPortal';
  process.env.RESEND_API_KEY = 're_configuredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
  process.env.CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE = 'true';
  process.env.CI = 'true';
  process.env.GITHUB_ACTIONS = 'false';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('DATABASE_URL must not point at localhost in production') &&
      error.details.includes('DATABASE_URL must use exact lowercase sslmode=verify-full in production'),
  );
});

test('validateProductionEnv treats Docker host gateway database URLs as local production URLs', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@host.docker.internal:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_configuredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_configuredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_configuredPortal';
  process.env.RESEND_API_KEY = 're_configuredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('DATABASE_URL must not point at localhost in production') &&
      error.details.includes('DATABASE_URL must use exact lowercase sslmode=verify-full in production'),
  );
});

test('validateProductionEnv allows local database URLs only for GitHub Actions production smoke', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_configuredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_configuredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_configuredPortal';
  process.env.RESEND_API_KEY = 're_configuredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
  process.env.CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE = 'true';
  process.env.CI = 'true';
  process.env.GITHUB_ACTIONS = 'true';

  assert.doesNotThrow(() => validateProductionEnv());
});

test('validateProductionEnv rejects non-local plaintext database URLs even for GitHub Actions production smoke', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@db.charitypilot.ie:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.AUTH_COOKIE_DOMAIN = '.charitypilot.ie';
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  process.env.STRIPE_SECRET_KEY = 'sk_live_configuredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_configuredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_configuredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
  process.env.CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE = 'true';
  process.env.CI = 'true';
  process.env.GITHUB_ACTIONS = 'true';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('DATABASE_URL must use exact lowercase sslmode=verify-full in production'),
  );
});

test('validateProductionEnv rejects bracketed IPv6 localhost URLs in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@[::1]:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://[::1]:3003';
  process.env.NEXT_PUBLIC_API_URL = 'https://[::1]:3002';
  process.env.STRIPE_SECRET_KEY = 'sk_live_realisticConfiguredSecret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_realisticConfiguredSecret';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentialsMonthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentialsYearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_completeMonthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_completeYearly';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('DATABASE_URL must not point at localhost in production') &&
      error.details.includes('FRONTEND_URL must not point at localhost in production') &&
      error.details.includes('NEXT_PUBLIC_API_URL must not point at localhost in production'),
  );
});
