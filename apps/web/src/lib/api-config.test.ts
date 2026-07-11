import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiBaseUrl, getServerApiBaseUrl } from './api-config';

test('uses explicit API URL after trimming a trailing slash', () => {
  assert.equal(
    getApiBaseUrl({ NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie/' }),
    'https://api.charitypilot.ie',
  );
});

test('requires an explicit API URL in production', () => {
  assert.throws(
    () => getApiBaseUrl({ NODE_ENV: 'production' }),
    /NEXT_PUBLIC_API_URL must be set in production/,
  );
});

test('rejects non-production API URLs in production', () => {
  assert.throws(
    () => getApiBaseUrl({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'http://localhost:3002' }),
    /NEXT_PUBLIC_API_URL must use https:\/\/ in production/,
  );
});

test('rejects unapproved API hosts through the canonical production API origin check', () => {
  assert.throws(
    () =>
      getApiBaseUrl({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.attacker.example' }),
    /NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/,
  );
});

test('rejects approved but non-canonical API hosts in production', () => {
  assert.throws(
    () =>
      getApiBaseUrl({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://services.charitypilot.ie' }),
    /NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/,
  );
});

test('rejects API URLs with paths in production', () => {
  assert.throws(
    () =>
      getApiBaseUrl({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie/api/v1',
      }),
    /NEXT_PUBLIC_API_URL must be an origin-only URL in production/,
  );
});

test('isolated production E2E accepts only its exact browser and internal API origins', () => {
  const env = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: 'local-disposable',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3302/',
    CHARITYPILOT_INTERNAL_API_URL: 'http://api:3302/',
  };

  assert.equal(getApiBaseUrl(env), 'http://127.0.0.1:3302');
  assert.equal(getServerApiBaseUrl(env), 'http://api:3302');
});

test('isolated production E2E rejects every browser API origin except its exact loopback binding', () => {
  for (const NEXT_PUBLIC_API_URL of [
    'http://localhost:3302',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3302/api/v1',
    'http://127.0.0.1:3302?target=personal',
    'http://127.0.0.1:3302#fragment',
    'http://user@127.0.0.1:3302',
    'http://api:3302',
    'https://api.charitypilot.ie',
  ]) {
    assert.throws(
      () => getApiBaseUrl({
        NODE_ENV: 'production',
        NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: 'local-disposable',
        NEXT_PUBLIC_API_URL,
      }),
      /must use the exact isolated E2E browser origin http:\/\/127\.0\.0\.1:3302/,
      NEXT_PUBLIC_API_URL,
    );
  }
});

test('isolated production E2E requires its exact internal service origin', () => {
  const baseEnv = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: 'local-disposable',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3302',
  };

  assert.throws(
    () => getServerApiBaseUrl(baseEnv),
    /CHARITYPILOT_INTERNAL_API_URL must be set for isolated production E2E/,
  );

  for (const CHARITYPILOT_INTERNAL_API_URL of [
    'http://localhost:3302',
    'http://api:3002',
    'http://api:3302/api/v1',
    'https://api.charitypilot.ie',
  ]) {
    assert.throws(
      () => getServerApiBaseUrl({ ...baseEnv, CHARITYPILOT_INTERNAL_API_URL }),
      /must use the exact isolated E2E internal origin http:\/\/api:3302/,
      CHARITYPILOT_INTERNAL_API_URL,
    );
  }
});

test('personal-server production accepts an exact HTTPS origin and the fixed internal API service', () => {
  const env = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    NEXT_PUBLIC_API_URL: 'https://charitypilot.example-tailnet.ts.net/',
    CHARITYPILOT_INTERNAL_API_URL: 'http://api:3002/',
  };

  assert.equal(getApiBaseUrl(env), 'https://charitypilot.example-tailnet.ts.net');
  assert.equal(getServerApiBaseUrl(env), 'http://api:3002');
});

test('personal-server production permits plain HTTP only on an exact loopback origin', () => {
  for (const NEXT_PUBLIC_API_URL of [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
  ]) {
    assert.equal(
      getApiBaseUrl({
        NODE_ENV: 'production',
        NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
        NEXT_PUBLIC_API_URL,
      }),
      NEXT_PUBLIC_API_URL,
    );
  }

  for (const NEXT_PUBLIC_API_URL of [
    'http://192.168.1.20:8080',
    'http://charitypilot.internal:8080',
    'ftp://localhost:8080',
    'https://user@example-tailnet.ts.net',
    'https://example-tailnet.ts.net/api',
    'https://example-tailnet.ts.net?token=secret',
  ]) {
    assert.throws(
      () => getApiBaseUrl({
        NODE_ENV: 'production',
        NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
        NEXT_PUBLIC_API_URL,
      }),
      /must be an origin-only|must use https:\/\/ or exact loopback http:\/\//,
      NEXT_PUBLIC_API_URL,
    );
  }
});

test('personal-server production requires its exact internal Docker API origin', () => {
  const baseEnv = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    NEXT_PUBLIC_API_URL: 'http://localhost:8080',
  };

  assert.throws(
    () => getServerApiBaseUrl(baseEnv),
    /CHARITYPILOT_INTERNAL_API_URL must be set for personal-server production/,
  );

  for (const CHARITYPILOT_INTERNAL_API_URL of [
    'http://localhost:3002',
    'http://api:3003',
    'http://api:3002/api/v1',
    'https://api:3002',
  ]) {
    assert.throws(
      () => getServerApiBaseUrl({ ...baseEnv, CHARITYPILOT_INTERNAL_API_URL }),
      /must use the exact personal-server internal origin http:\/\/api:3002/,
      CHARITYPILOT_INTERNAL_API_URL,
    );
  }
});

test('lookalike personal-server markers cannot bypass canonical public-production validation', () => {
  assert.throws(
    () => getApiBaseUrl({
      NODE_ENV: 'production',
      NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server-preview',
      NEXT_PUBLIC_API_URL: 'http://localhost:8080',
    }),
    /NEXT_PUBLIC_API_URL must use https:\/\/ in production/,
  );
});

test('a lookalike isolated marker cannot bypass canonical production validation', () => {
  assert.throws(
    () => getApiBaseUrl({
      NODE_ENV: 'production',
      NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: 'local-disposable-lookalike',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3302',
    }),
    /NEXT_PUBLIC_API_URL must use https:\/\/ in production/,
  );
});

test('keeps the local Docker API fallback for local development only', () => {
  assert.equal(getApiBaseUrl({ NODE_ENV: 'development' }), 'http://localhost:3002');
});

test('normalizes an explicit isolated loopback API URL in development', () => {
  assert.equal(
    getApiBaseUrl({
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3302/',
    }),
    'http://127.0.0.1:3302',
  );
});
