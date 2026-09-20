import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  atlassianEndpoints,
  isLocalOverrideHost,
  resolveFakeAtlassianBaseUrl,
  PRODUCTION_ATLASSIAN_ENDPOINTS,
  FAKE_ATLASSIAN_FLAG,
  FAKE_ATLASSIAN_BASE_URL,
} from '../services/atlassian-endpoints.js';

/**
 * This module can redirect where a charity's OAuth authorization codes are
 * sent. Every test here is about the fence, not about the feature.
 */

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { NODE_ENV: 'test', [FAKE_ATLASSIAN_FLAG]: '1', [FAKE_ATLASSIAN_BASE_URL]: 'http://fake-atlassian:4000', ...overrides };
}

test('with no environment at all, the real Atlassian is used', () => {
  assert.deepEqual(atlassianEndpoints({}), PRODUCTION_ATLASSIAN_ENDPOINTS);
  assert.equal(atlassianEndpoints({}).tokenUrl, 'https://auth.atlassian.com/oauth/token');
});

test('a base url WITHOUT the flag does nothing', () => {
  // There must be no way to redirect tokens by setting one plausible-looking
  // variable.
  const endpoints = atlassianEndpoints({
    NODE_ENV: 'test',
    [FAKE_ATLASSIAN_BASE_URL]: 'http://fake-atlassian:4000',
  });
  assert.deepEqual(endpoints, PRODUCTION_ATLASSIAN_ENDPOINTS);
});

test('the flag WITHOUT a base url does nothing', () => {
  assert.deepEqual(
    atlassianEndpoints({ NODE_ENV: 'test', [FAKE_ATLASSIAN_FLAG]: '1' }),
    PRODUCTION_ATLASSIAN_ENDPOINTS,
  );
});

test('the flag must be exactly "1"', () => {
  for (const value of ['true', 'yes', 'TRUE', '01', ' 1', '1 ', 'on']) {
    assert.deepEqual(
      atlassianEndpoints(env({ [FAKE_ATLASSIAN_FLAG]: value })),
      PRODUCTION_ATLASSIAN_ENDPOINTS,
      `"${value}" must not enable the override`,
    );
  }
});

test('production ignores the override entirely, however it is set', () => {
  assert.deepEqual(atlassianEndpoints(env({ NODE_ENV: 'production' })), PRODUCTION_ATLASSIAN_ENDPOINTS);
});

test('an unset NODE_ENV is treated as production, so it fails closed', () => {
  // The entry points default NODE_ENV to 'production' when unset, and this
  // agrees with them rather than assuming the safe case.
  assert.deepEqual(atlassianEndpoints(env({ NODE_ENV: undefined })), PRODUCTION_ATLASSIAN_ENDPOINTS);
});

test('a public host is refused even with both flags set', () => {
  for (const base of [
    'https://evil.example.com',
    'http://atlassian.com.evil.example',
    'https://8.8.8.8',
    'http://203.0.113.10',
  ]) {
    assert.deepEqual(
      atlassianEndpoints(env({ [FAKE_ATLASSIAN_BASE_URL]: base })),
      PRODUCTION_ATLASSIAN_ENDPOINTS,
      `${base} must be refused`,
    );
  }
});

test('a non-http scheme is refused', () => {
  for (const base of ['file:///etc/passwd', 'ftp://localhost', 'javascript:alert(1)']) {
    assert.deepEqual(
      atlassianEndpoints(env({ [FAKE_ATLASSIAN_BASE_URL]: base })),
      PRODUCTION_ATLASSIAN_ENDPOINTS,
    );
  }
});

test('a malformed base url is refused rather than throwing', () => {
  assert.deepEqual(atlassianEndpoints(env({ [FAKE_ATLASSIAN_BASE_URL]: 'not a url' })), PRODUCTION_ATLASSIAN_ENDPOINTS);
});

test('with every fence satisfied, all three endpoints move together', () => {
  const endpoints = atlassianEndpoints(env());

  // All three, or the fake would be half-used and a test would silently reach
  // the real Atlassian for whichever call was missed.
  assert.equal(endpoints.tokenUrl, 'http://fake-atlassian:4000/oauth/token');
  assert.equal(
    endpoints.accessibleResourcesUrl,
    'http://fake-atlassian:4000/oauth/token/accessible-resources',
  );
  assert.equal(endpoints.apiBase, 'http://fake-atlassian:4000/ex/confluence');
});

test('loopback and private addresses are accepted, public ones are not', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.9', '172.16.0.1', 'fake-atlassian']) {
    assert.equal(isLocalOverrideHost(host), true, `${host} should be local`);
  }
  for (const host of ['evil.example.com', 'atlassian.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isLocalOverrideHost(host), false, `${host} should not be local`);
  }
});

test('the resolver and the boot guard agree on the variable names', () => {
  // Two places name these strings. If they drift, the guard stops guarding the
  // thing the resolver reads and nothing else notices.
  const envSource = readFileSync(join(process.cwd(), 'src', 'utils', 'env.ts'), 'utf8');
  assert.ok(envSource.includes(FAKE_ATLASSIAN_FLAG));
  assert.ok(envSource.includes(FAKE_ATLASSIAN_BASE_URL));
  assert.equal(resolveFakeAtlassianBaseUrl(env()), 'http://fake-atlassian:4000');
});

test('no production code hard-codes an Atlassian URL any more', () => {
  // The whole point of the module is that there is one place to audit. A
  // second hard-coded constant would be a second place a redirect could fail
  // to apply — or worse, apply inconsistently.
  const src = join(process.cwd(), 'src', 'services');
  for (const file of ['atlassian-oauth.ts', 'confluence-client.ts']) {
    const source = readFileSync(join(src, file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(
      code,
      /https:\/\/(auth|api)\.atlassian\.com/,
      `${file} must resolve Atlassian URLs through atlassian-endpoints.ts`,
    );
  }
});
