import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiBaseUrl } from './api-config';

test('uses explicit API URL after trimming a trailing slash', () => {
  assert.equal(
    getApiBaseUrl({ NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie/' }),
    'https://api.charitypilot.ie',
  );
});

test('does not fall back to localhost in production when API URL is omitted', () => {
  assert.equal(getApiBaseUrl({ NODE_ENV: 'production' }), 'https://api.charitypilot.ie');
});

test('keeps the local Docker API fallback for local development only', () => {
  assert.equal(getApiBaseUrl({ NODE_ENV: 'development' }), 'http://localhost:3002');
});
