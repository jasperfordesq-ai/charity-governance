import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../utils/errors.js';
import {
  validatePersonalServerEnv,
  validateRuntimeEnv,
} from '../utils/personal-server-env.js';
import { validateProductionEnv } from '../utils/env.js';

const ENV_KEYS = [
  'NODE_ENV',
  'CHARITYPILOT_DEPLOYMENT_MODE',
  'PORT',
  'FRONTEND_URL',
  'NEXT_PUBLIC_API_URL',
  'DATABASE_URL',
  'JWT_SECRET',
  'READINESS_API_KEY',
  'DOCUMENT_STORAGE_DRIVER',
  'LOCAL_FILE_STORAGE_DIR',
  'AUTH_COOKIE_DOMAIN',
  'SELF_REGISTRATION_ENABLED',
  'STRIPE_SECRET_KEY',
  'RESEND_API_KEY',
  'SUPABASE_URL',
  'ERROR_ALERT_WEBHOOK_URL',
] as const;

function withPersonalEnv(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => void,
): void {
  const before = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const configured = {
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    PORT: '3002',
    FRONTEND_URL: 'http://127.0.0.1:3003',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3003',
    DATABASE_URL: 'postgresql://charitypilot:local-password@db:5432/charitypilot',
    JWT_SECRET: 'jwt-personal-server-secret-value-1234567890',
    READINESS_API_KEY: 'readiness-personal-server-secret-1234567890',
    DOCUMENT_STORAGE_DRIVER: 'local',
    LOCAL_FILE_STORAGE_DIR: '/var/lib/charitypilot/documents',
    AUTH_COOKIE_DOMAIN: undefined,
    SELF_REGISTRATION_ENABLED: 'false',
    STRIPE_SECRET_KEY: undefined,
    RESEND_API_KEY: undefined,
    SUPABASE_URL: undefined,
    ERROR_ALERT_WEBHOOK_URL: undefined,
    ...overrides,
  };

  try {
    for (const key of ENV_KEYS) {
      const value = configured[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function personalIssues(run: () => void): string[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'PERSONAL_SERVER_ENV_INVALID');
    assert.ok(Array.isArray(error.details));
    return error.details as string[];
  }
  assert.fail('Expected personal-server validation to fail');
}

test('personal-server accepts exact loopback HTTP without external providers', { concurrency: false }, () => {
  withPersonalEnv({}, () => {
    assert.doesNotThrow(() => validatePersonalServerEnv());
    assert.doesNotThrow(() => validateRuntimeEnv());

    assert.throws(
      () => validateProductionEnv(),
      (error: unknown) => error instanceof AppError && error.code === 'PRODUCTION_ENV_INVALID',
      'the normal public-production validator remains strict',
    );
  });
});

test('personal-server accepts one exact HTTPS private-DNS origin', { concurrency: false }, () => {
  withPersonalEnv({
    FRONTEND_URL: 'https://charitypilot.home.arpa',
    NEXT_PUBLIC_API_URL: 'https://charitypilot.home.arpa',
  }, () => assert.doesNotThrow(() => validatePersonalServerEnv()));
});

test('personal-server rejects unsafe origins, remote databases, and relative storage', { concurrency: false }, async (t) => {
  const cases = [
    {
      name: 'non-loopback HTTP',
      overrides: { FRONTEND_URL: 'http://charitypilot.lan', NEXT_PUBLIC_API_URL: 'http://charitypilot.lan' },
      issue: 'FRONTEND_URL and NEXT_PUBLIC_API_URL must be the same exact origin',
    },
    {
      name: 'different frontend and API origins',
      overrides: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3002' },
      issue: 'FRONTEND_URL and NEXT_PUBLIC_API_URL must be the same exact origin',
    },
    {
      name: 'origin with trailing slash',
      overrides: { FRONTEND_URL: 'http://127.0.0.1:3003/', NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3003/' },
      issue: 'FRONTEND_URL and NEXT_PUBLIC_API_URL must be the same exact origin',
    },
    {
      name: 'remote database',
      overrides: { DATABASE_URL: 'postgresql://user:password@database.example:5432/charitypilot' },
      issue: 'DATABASE_URL must use the local PostgreSQL service host',
    },
    {
      name: 'relative document path',
      overrides: { LOCAL_FILE_STORAGE_DIR: '.charitypilot/documents' },
      issue: 'LOCAL_FILE_STORAGE_DIR must be an absolute non-root filesystem path',
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, () => withPersonalEnv(entry.overrides, () => {
      const issues = personalIssues(() => validatePersonalServerEnv());
      assert.ok(issues.some((issue) => issue.includes(entry.issue)), issues.join('\n'));
    }));
  }
});

test('personal-server requires production mode, distinct strong secrets, local storage, no cookie domain, and disabled registration', { concurrency: false }, () => {
  withPersonalEnv({
    NODE_ENV: 'development',
    JWT_SECRET: 'short',
    READINESS_API_KEY: 'short',
    DOCUMENT_STORAGE_DRIVER: 'supabase',
    AUTH_COOKIE_DOMAIN: '.example.test',
    SELF_REGISTRATION_ENABLED: 'true',
  }, () => {
    const issues = personalIssues(() => validatePersonalServerEnv());
    assert.ok(issues.includes('NODE_ENV must be production for personal-server mode'));
    assert.ok(issues.includes('JWT_SECRET must be a configured secret of at least 32 characters'));
    assert.ok(issues.includes('READINESS_API_KEY must be a configured secret of at least 32 characters'));
    assert.ok(issues.includes('DOCUMENT_STORAGE_DRIVER must be exactly local for personal-server mode'));
    assert.ok(issues.includes('AUTH_COOKIE_DOMAIN must be unset in personal-server mode'));
    assert.ok(issues.includes('SELF_REGISTRATION_ENABLED must be exactly false in personal-server mode'));
  });

  const sharedSecret = 'shared-personal-server-secret-value-123456789';
  withPersonalEnv({ JWT_SECRET: sharedSecret, READINESS_API_KEY: sharedSecret }, () => {
    const issues = personalIssues(() => validatePersonalServerEnv());
    assert.ok(issues.includes('JWT_SECRET and READINESS_API_KEY must be distinct secrets'));
  });
});
