import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import { validateDeadlineRemindersEnv, validateDocumentStorageCleanupEnv, validateProductionEnv } from '../utils/env.js';

const ORIGINAL_ENV = { ...process.env };

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
    DATABASE_URL: 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require',
    JWT_SECRET: 'a'.repeat(40),
    FRONTEND_URL: 'https://app.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    STRIPE_SECRET_KEY: 'sk_live_realisticConfiguredSecret',
    STRIPE_WEBHOOK_SECRET: 'whsec_realisticConfiguredSecret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_essentialsMonthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_essentialsYearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_completeMonthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_completeYearly',
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.doesNotThrow(() => validateProductionEnv());
});

test('validateProductionEnv rejects unapproved production email sender domains', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
  process.env.SUPABASE_URL = 'https://configured-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.doesNotThrow(() => validateDocumentStorageCleanupEnv());
});

test('validateDeadlineRemindersEnv accepts reminder-only production configuration', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.RESEND_API_KEY = 're_realisticConfiguredSecret';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.doesNotThrow(() => validateDeadlineRemindersEnv());
});

test('validateDeadlineRemindersEnv rejects malformed Resend API keys in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
      error.details.includes('DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full in production') &&
      error.details.includes('FRONTEND_URL must not point at localhost in production') &&
      error.details.includes('RESEND_API_KEY is missing or still contains a placeholder value') &&
      error.details.includes('EMAIL_FROM must use an approved CharityPilot sender domain in production') &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value'),
  );
});

test('validateDeadlineRemindersEnv rejects missing production job alert webhook', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
      error.details.includes('DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full in production') &&
      error.details.includes('SUPABASE_URL is missing or still contains a placeholder value') &&
      error.details.includes('SUPABASE_SERVICE_ROLE_KEY is missing or still contains a placeholder value') &&
      error.details.includes('SUPABASE_STORAGE_BUCKET is missing or still contains a placeholder value') &&
      error.details.includes('ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value'),
  );
});

test('validateDocumentStorageCleanupEnv rejects private Supabase URLs', () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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

test('validateProductionEnv accepts comma-separated production frontend origins', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.TRUSTED_PROXY_ADDRESSES = '10.0.0.10';
  process.env.READINESS_API_KEY = 'configured-readiness-key-32-chars';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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

  assert.doesNotThrow(() => validateProductionEnv());
});

test('validateProductionEnv rejects missing production API origin used for cookie-domain checks', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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

test('validateProductionEnv rejects unapproved production public hostnames', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
      error.details.includes('DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full in production'),
  );
});

test('validateProductionEnv rejects production frontend URLs that are not origins', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=require';
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
      error.details.includes('DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full in production'),
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
      error.details.includes('DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full in production'),
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
      error.details.includes('DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full in production'),
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
