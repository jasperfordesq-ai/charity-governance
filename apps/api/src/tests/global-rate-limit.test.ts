import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE,
  MANAGED_E2E_GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE,
  globalApiRateLimitMax,
} from '../utils/global-rate-limit.js';

const INSTANCE_ID = '9d9899dc-9bea-45ca-a916-c9a2e023e46e';

test('global API limiter keeps the production and ordinary runtime ceiling', () => {
  assert.equal(globalApiRateLimitMax({}), GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE);
  assert.equal(
    globalApiRateLimitMax({
      NODE_ENV: 'production',
      E2E_DATABASE_IDENTITY_PROBE_ENABLED: 'true',
      E2E_DATABASE_INSTANCE_ID: INSTANCE_ID,
    }),
    GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE,
  );
  assert.equal(
    globalApiRateLimitMax({
      NODE_ENV: 'development',
      E2E_DATABASE_IDENTITY_PROBE_ENABLED: 'true',
      E2E_DATABASE_INSTANCE_ID: 'copied-or-invalid-instance-id',
    }),
    GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE,
  );
});

test('only a UUID-bound non-production disposable E2E runtime gets the synthetic gateway ceiling', () => {
  assert.equal(
    globalApiRateLimitMax({
      NODE_ENV: 'development',
      E2E_DATABASE_IDENTITY_PROBE_ENABLED: 'true',
      E2E_DATABASE_INSTANCE_ID: INSTANCE_ID,
    }),
    MANAGED_E2E_GLOBAL_API_RATE_LIMIT_MAX_PER_MINUTE,
  );
});

test('API server wires the environment-gated global limiter selector', () => {
  const serverSource = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');
  assert.match(serverSource, /max:\s*globalApiRateLimitMax\(\)/);
  assert.doesNotMatch(serverSource, /max:\s*10_?000/);
});
