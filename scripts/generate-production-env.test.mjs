import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTO_GENERATED_KEYS,
  OPERATOR_SUPPLIED_KEYS,
  buildProductionEnv,
  generateSecret,
} from './generate-production-env.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseEnv(content) {
  const map = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(\r?)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

const SAMPLE = [
  '# comment line',
  'NODE_ENV=production',
  'JWT_SECRET=REPLACE_ME_RANDOM_SECRET_AT_LEAST_32_CHARACTERS',
  'READINESS_API_KEY=REPLACE_ME_RANDOM_READINESS_KEY_AT_LEAST_32_CHARACTERS',
  'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
  'STRIPE_SECRET_KEY=REPLACE_ME_STRIPE_LIVE_SECRET_KEY',
  'AUTH_COOKIE_DOMAIN=',
  '',
].join('\n');

test('auto-generates the random secrets and forces NODE_ENV', () => {
  let n = 0;
  const env = parseEnv(buildProductionEnv(SAMPLE, () => `generated-secret-${n++}`));
  assert.equal(env.JWT_SECRET, 'generated-secret-0');
  assert.equal(env.READINESS_API_KEY, 'generated-secret-1');
  assert.equal(env.NODE_ENV, 'production');
});

test('leaves every operator-supplied/external value as its placeholder (gate preserved)', () => {
  const env = parseEnv(buildProductionEnv(SAMPLE, () => 'x'.repeat(64)));
  assert.match(env.DATABASE_URL, /^REPLACE_ME/);
  assert.match(env.STRIPE_SECRET_KEY, /^REPLACE_ME/);
  // An intentionally-empty value is preserved, not "generated".
  assert.equal(env.AUTH_COOKIE_DOMAIN, '');
});

test('preserves comments and blank lines', () => {
  const content = buildProductionEnv(SAMPLE, () => 'secret');
  assert.ok(content.startsWith('# comment line\n'));
  assert.ok(content.endsWith('\n'));
});

test('the real secret generator yields distinct, high-entropy, non-placeholder values', () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.notEqual(a, b);
  for (const secret of [a, b]) {
    assert.ok(secret.length >= 32, 'secret must clear the 32-character production floor');
    assert.doesNotMatch(secret, /REPLACE|change-me|\.\.\./i, 'secret must not look like a placeholder');
    assert.match(secret, /^[A-Za-z0-9_-]+$/, 'secret must be url-safe base64url');
  }
});

test('works against the real .env.production.example, changing only the auto-keys', () => {
  const example = readFileSync(join(repoRoot, '.env.production.example'), 'utf8');
  const before = parseEnv(example);
  const after = parseEnv(buildProductionEnv(example));

  for (const key of AUTO_GENERATED_KEYS) {
    assert.ok(after[key] && after[key].length >= 32, `${key} should be auto-generated`);
    assert.doesNotMatch(after[key], /REPLACE_ME/, `${key} should no longer be a placeholder`);
    assert.notEqual(after[key], before[key], `${key} should differ from the example`);
  }
  assert.equal(after.NODE_ENV, 'production');

  // Precise gate-preservation: every other key is byte-for-byte unchanged, so
  // external values still trip check:production until the operator fills them.
  const changed = new Set([...AUTO_GENERATED_KEYS, 'NODE_ENV']);
  for (const key of Object.keys(before)) {
    if (changed.has(key)) continue;
    assert.equal(after[key], before[key], `${key} must be preserved unchanged`);
  }

  // Every operator-supplied key is still present for the operator to fill.
  for (const [key] of OPERATOR_SUPPLIED_KEYS) {
    assert.ok(key in after, `${key} must remain in the generated file`);
  }
});
