import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiBaseUrl } from './api-config';

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

test('rejects unapproved API hosts in production', () => {
  assert.throws(
    () =>
      getApiBaseUrl({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.attacker.example' }),
    /NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname/,
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

test('keeps the local Docker API fallback for local development only', () => {
  assert.equal(getApiBaseUrl({ NODE_ENV: 'development' }), 'http://localhost:3002');
});
