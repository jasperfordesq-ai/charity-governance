import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import { validateProductionEnv } from '../utils/env.js';

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
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot';
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

  assert.doesNotThrow(() => validateProductionEnv());
});

test('validateProductionEnv rejects local URLs and Stripe test mode in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002abc';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://localhost:3003';
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
      error.details.includes('STRIPE_SECRET_KEY must use a live Stripe secret key in production'),
  );
});

test('validateProductionEnv rejects bracketed IPv6 localhost URLs in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = 'postgresql://user:pass@[::1]:5432/charitypilot';
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.FRONTEND_URL = 'https://[::1]:3003';
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
      error.details.includes('FRONTEND_URL must not point at localhost in production'),
  );
});
