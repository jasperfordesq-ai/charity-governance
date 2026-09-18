import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import {
  requireAtlassianOAuthClient,
  requireIntegrationEncryptionKey,
  requireUsableDocumentStorageDefault,
  validateAuthDeliveryEnv,
  validateDeadlineRemindersEnv,
  validateDocumentStorageCleanupEnv,
  validateProductionEnv,
} from '../utils/env.js';

const ORIGINAL_ENV = { ...process.env };
const AUTH_RECOVERY_TEST_SECRET = '0123456789abcdef'.repeat(4);
const INTEGRATION_ENCRYPTION_TEST_KEY = 'c'.repeat(64);

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
    OWNER_JWT_SECRET: 'b'.repeat(40),
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
    INTEGRATION_ENCRYPTION_KEY: INTEGRATION_ENCRYPTION_TEST_KEY,
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
  process.env.OWNER_JWT_SECRET = 'b'.repeat(40);
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
  process.env.INTEGRATION_ENCRYPTION_KEY = INTEGRATION_ENCRYPTION_TEST_KEY;

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

// Pins the *wiring*, not the guard: every other test of
// requireIntegrationEncryptionKey calls it directly, so deleting its call site
// inside validateProductionEnv leaves them all green. This test goes through
// validateProductionEnv, so the boot guard cannot be silently unhooked.
test('validateProductionEnv requires a distinct, correctly sized INTEGRATION_ENCRYPTION_KEY', () => {
  setCompleteProductionEnv({ INTEGRATION_ENCRYPTION_KEY: undefined });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes(
        'INTEGRATION_ENCRYPTION_KEY is missing or still contains a placeholder value',
      ),
  );

  setCompleteProductionEnv({ INTEGRATION_ENCRYPTION_KEY: '00'.repeat(16) });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes(
        'INTEGRATION_ENCRYPTION_KEY must canonically encode exactly 32 bytes as hex or base64url',
      ),
  );

  const shared = '11'.repeat(32);
  setCompleteProductionEnv({ INTEGRATION_ENCRYPTION_KEY: shared, JWT_SECRET: shared });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.some((issue: string) =>
        issue.startsWith('INTEGRATION_ENCRYPTION_KEY must be distinct from'),
      ),
  );
});

// Pins the *decision*, not just the guard. If a later change makes the
// Atlassian client a required production variable, this test fails and whoever
// made it has to come here, read why it is not required, and change the
// documentation that says so — instead of silently breaking the boot of every
// production deployment whose charities do not use Confluence.
test('validateProductionEnv boots without any Atlassian client configured', () => {
  setCompleteProductionEnv({
    ATLASSIAN_CLIENT_ID: undefined,
    ATLASSIAN_CLIENT_SECRET: undefined,
  });
  assert.doesNotThrow(() => validateProductionEnv());
});

// Pins the wiring: every other test of requireAtlassianOAuthClient calls it
// directly, so deleting its call site inside validateProductionEnv would leave
// them all green.
test('validateProductionEnv rejects a half-configured Atlassian client', () => {
  setCompleteProductionEnv({
    ATLASSIAN_CLIENT_ID: 'configured-atlassian-client-id',
    ATLASSIAN_CLIENT_SECRET: undefined,
  });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes(
        'ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET must both be set to enable the Confluence ' +
          'integration, or both be left unset',
      ),
  );

  setCompleteProductionEnv({
    ATLASSIAN_CLIENT_ID: undefined,
    ATLASSIAN_CLIENT_SECRET: 'configured-atlassian-client-secret',
  });
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.some((issue: string) => issue.startsWith('ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET')),
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

test('validateAuthDeliveryEnv boots under manual-link without RESEND_API_KEY/EMAIL_FROM', () => {
  setCompleteProductionEnv({
    CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
    RESEND_API_KEY: undefined,
    EMAIL_FROM: undefined,
  });

  assert.doesNotThrow(() => validateAuthDeliveryEnv());
});

test('validateAuthDeliveryEnv still requires RESEND_API_KEY/EMAIL_FROM under explicit provider mode (byte-identical to the unset/default path)', () => {
  setCompleteProductionEnv({
    CHARITYPILOT_EMAIL_DELIVERY: 'provider',
    RESEND_API_KEY: undefined,
    EMAIL_FROM: undefined,
  });

  assert.throws(
    () => validateAuthDeliveryEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('RESEND_API_KEY is missing or still contains a placeholder value') &&
      error.details.includes('EMAIL_FROM is missing or still contains a placeholder value'),
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

test('validateProductionEnv requires a local storage path when local storage is selected', () => {
  // DOCUMENT_STORAGE_DRIVER=local is now a valid axis choice for a
  // self-contained deployment (see deployment-profile-env-validation.test.ts);
  // it is no longer unconditionally rejected. This still guards that picking
  // local storage without configuring where files land is caught.
  setCompleteProductionEnv({ DOCUMENT_STORAGE_DRIVER: 'local', LOCAL_FILE_STORAGE_DIR: undefined });

  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('LOCAL_FILE_STORAGE_DIR must be an absolute non-root filesystem path'),
  );
});

test('validateProductionEnv refuses to boot when the deployment default storage provider is unusable', () => {
  // Every real DOCUMENT_STORAGE_DRIVER value resolves to a usable default in
  // Phase 0 (the shipped registry is ga-only, and an unrecognised value still
  // falls back to Supabase), so the boot gate must stay silent for all of them.
  for (const driver of [undefined, 'supabase', 'nonsense', '']) {
    const issues: string[] = [];
    setCompleteProductionEnv({ DOCUMENT_STORAGE_DRIVER: driver });
    requireUsableDocumentStorageDefault(issues);
    assert.deepEqual(issues, [], `expected no boot issue for DOCUMENT_STORAGE_DRIVER=${String(driver)}`);
  }

  setCompleteProductionEnv({ DOCUMENT_STORAGE_DRIVER: 'local', LOCAL_FILE_STORAGE_DIR: '/data/documents' });
  assert.doesNotThrow(() => validateProductionEnv());

  // The failure this gate exists for: a default the registry refuses. It is
  // unreachable with the shipped ga-only registry, so the resolver is injected.
  const issues: string[] = [];
  requireUsableDocumentStorageDefault(issues, () => {
    throw new AppError(
      500,
      'STORAGE_PROVIDER_ALPHA_NOT_DEFAULTABLE',
      'An alpha document storage provider cannot be the deployment default.',
    );
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^DOCUMENT_STORAGE_DRIVER names a document storage provider that cannot be the deployment default: /);
  assert.match(issues[0], /alpha document storage provider cannot be the deployment default/);
});

test('validateDocumentStorageCleanupEnv mirrors validateProductionEnv on the local storage driver (both directions)', () => {
  // Local direction: a self-contained deployment (the private VM) runs the
  // cleanup job against StorageService's local branch, so the Supabase trio
  // must NOT be required and the driver must not be rejected — but the local
  // path must be, exactly as validateProductionEnv demands it.
  setCompleteProductionEnv({
    DOCUMENT_STORAGE_DRIVER: 'local',
    LOCAL_FILE_STORAGE_DIR: '/data/documents',
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_STORAGE_BUCKET: undefined,
  });
  assert.doesNotThrow(() => validateDocumentStorageCleanupEnv());

  setCompleteProductionEnv({
    DOCUMENT_STORAGE_DRIVER: 'local',
    LOCAL_FILE_STORAGE_DIR: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_STORAGE_BUCKET: undefined,
  });
  assert.throws(
    () => validateDocumentStorageCleanupEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('LOCAL_FILE_STORAGE_DIR must be an absolute non-root filesystem path'),
  );

  // Hosted direction, unchanged and with zero new env vars: with no
  // DOCUMENT_STORAGE_DRIVER set the Supabase trio is still required, and a
  // near-miss driver value ("Local ") is still rejected as local.
  setCompleteProductionEnv({
    DOCUMENT_STORAGE_DRIVER: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_STORAGE_BUCKET: undefined,
  });
  assert.throws(
    () => validateDocumentStorageCleanupEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('SUPABASE_URL is missing or still contains a placeholder value') &&
      error.details.includes('SUPABASE_SERVICE_ROLE_KEY is missing or still contains a placeholder value') &&
      error.details.includes('SUPABASE_STORAGE_BUCKET is missing or still contains a placeholder value'),
  );

  setCompleteProductionEnv({ DOCUMENT_STORAGE_DRIVER: 'Local ' });
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

test('validateDeadlineRemindersEnv boots under manual-link without RESEND_API_KEY/EMAIL_FROM', () => {
  process.env.NODE_ENV = 'production';
  process.env.CHARITYPILOT_EMAIL_DELIVERY = 'manual-link';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.doesNotThrow(() => validateDeadlineRemindersEnv());
});

test('validateDeadlineRemindersEnv still requires RESEND_API_KEY/EMAIL_FROM under explicit provider mode (byte-identical to the unset/default path)', () => {
  process.env.NODE_ENV = 'production';
  process.env.CHARITYPILOT_EMAIL_DELIVERY = 'provider';
  process.env.DATABASE_URL = 'postgresql://user:pass@example.com:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  assert.throws(
    () => validateDeadlineRemindersEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.includes('RESEND_API_KEY is missing or still contains a placeholder value') &&
      error.details.includes('EMAIL_FROM is missing or still contains a placeholder value'),
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
  process.env.OWNER_JWT_SECRET = 'b'.repeat(40);
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
  process.env.INTEGRATION_ENCRYPTION_KEY = INTEGRATION_ENCRYPTION_TEST_KEY;
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

test('production requires a distinct, correctly sized INTEGRATION_ENCRYPTION_KEY', () => {
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: undefined,
  } as NodeJS.ProcessEnv);
  assert.equal(issues.some((issue) => issue.includes('INTEGRATION_ENCRYPTION_KEY')), true);
});

test('an INTEGRATION_ENCRYPTION_KEY of the wrong size is rejected', () => {
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: '00'.repeat(16),
  } as NodeJS.ProcessEnv);
  assert.equal(issues.some((issue) => issue.includes('32 bytes')), true);
});

test('an INTEGRATION_ENCRYPTION_KEY equal to another secret is rejected', () => {
  const shared = '11'.repeat(32);
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: shared,
    JWT_SECRET: shared,
  } as NodeJS.ProcessEnv);
  assert.equal(issues.some((issue) => issue.includes('distinct')), true);
});

test('a valid, distinct INTEGRATION_ENCRYPTION_KEY raises no issue', () => {
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32),
    JWT_SECRET: 'cd'.repeat(32),
    AUTH_RECOVERY_SECRET: 'ef'.repeat(32),
  } as NodeJS.ProcessEnv);
  assert.deepEqual(issues, []);
});

// --- the Atlassian OAuth client: validated when configured, never required ---

test('an absent Atlassian client raises no issue — Confluence is simply not enabled', () => {
  const issues: string[] = [];
  requireAtlassianOAuthClient(issues, {} as NodeJS.ProcessEnv);
  assert.deepEqual(issues, []);

  const blank: string[] = [];
  requireAtlassianOAuthClient(blank, {
    ATLASSIAN_CLIENT_ID: '   ',
    ATLASSIAN_CLIENT_SECRET: '',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(blank, []);
});

test('an Atlassian client id without its secret is rejected', () => {
  const issues: string[] = [];
  requireAtlassianOAuthClient(issues, {
    ATLASSIAN_CLIENT_ID: 'configured-atlassian-client-id',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(issues, [
    'ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET must both be set to enable the Confluence ' +
      'integration, or both be left unset',
  ]);
});

test('an Atlassian client secret without its id is rejected', () => {
  const issues: string[] = [];
  requireAtlassianOAuthClient(issues, {
    ATLASSIAN_CLIENT_SECRET: 'configured-atlassian-client-secret',
  } as NodeJS.ProcessEnv);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET must both be set/);
});

// Presence is tested on the raw value, so a placeholder counts as *set*. If it
// counted as unset, a half-filled env file would read as "Confluence not
// enabled" and sail past both this guard and the route's presence-only gate,
// failing against auth.atlassian.com only after a charity had granted access.
test('a placeholder Atlassian client is rejected rather than read as absent', () => {
  const issues: string[] = [];
  requireAtlassianOAuthClient(issues, {
    ATLASSIAN_CLIENT_ID: 'REPLACE_ME_ATLASSIAN_CLIENT_ID',
    ATLASSIAN_CLIENT_SECRET: 'REPLACE_ME_ATLASSIAN_CLIENT_SECRET',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(issues, [
    'ATLASSIAN_CLIENT_ID still contains a placeholder value',
    'ATLASSIAN_CLIENT_SECRET still contains a placeholder value',
  ]);
});

test('an ATLASSIAN_CLIENT_SECRET equal to another secret is rejected', () => {
  const shared = 'ff'.repeat(32);
  for (const peer of [
    'JWT_SECRET',
    'AUTH_RECOVERY_SECRET',
    'OWNER_JWT_SECRET',
    'READINESS_API_KEY',
    'INTEGRATION_ENCRYPTION_KEY',
  ]) {
    const issues: string[] = [];
    requireAtlassianOAuthClient(issues, {
      ATLASSIAN_CLIENT_ID: 'configured-atlassian-client-id',
      ATLASSIAN_CLIENT_SECRET: shared,
      [peer]: shared,
    } as NodeJS.ProcessEnv);
    assert.equal(
      issues.some((issue) => issue.startsWith('ATLASSIAN_CLIENT_SECRET must be distinct from')),
      true,
      `${peer} reuse must be rejected`,
    );
  }
});

test('an ATLASSIAN_CLIENT_SECRET equal to the client id is rejected', () => {
  const issues: string[] = [];
  requireAtlassianOAuthClient(issues, {
    ATLASSIAN_CLIENT_ID: 'same-value-for-both',
    ATLASSIAN_CLIENT_SECRET: 'same-value-for-both',
  } as NodeJS.ProcessEnv);
  assert.equal(
    issues.includes('ATLASSIAN_CLIENT_SECRET must be distinct from ATLASSIAN_CLIENT_ID'),
    true,
  );
});

test('a fully configured, distinct Atlassian client raises no issue', () => {
  const issues: string[] = [];
  requireAtlassianOAuthClient(issues, {
    ATLASSIAN_CLIENT_ID: 'configured-atlassian-client-id',
    ATLASSIAN_CLIENT_SECRET: 'configured-atlassian-client-secret',
    JWT_SECRET: 'cd'.repeat(32),
    AUTH_RECOVERY_SECRET: 'ef'.repeat(32),
    INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32),
  } as NodeJS.ProcessEnv);
  assert.deepEqual(issues, []);
});

// No issue message may echo the value it is complaining about: these strings
// reach logs and the deploy preflight transcript.
test('no Atlassian client issue contains the secret it rejects', () => {
  const secret = 'super-secret-atlassian-value';
  const issues: string[] = [];
  requireAtlassianOAuthClient(issues, {
    ATLASSIAN_CLIENT_ID: secret,
    ATLASSIAN_CLIENT_SECRET: secret,
    JWT_SECRET: secret,
  } as NodeJS.ProcessEnv);
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.equal(issue.includes(secret), false, issue);
  }
});
