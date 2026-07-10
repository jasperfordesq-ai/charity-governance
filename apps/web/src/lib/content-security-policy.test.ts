import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentSecurityPolicy } from './content-security-policy';

test('production CSP uses only the canonical API connect source', () => {
  const csp = createContentSecurityPolicy({
    nonce: 'test-nonce',
    isDevelopment: false,
    apiUrl: 'https://api.charitypilot.ie/',
  });

  assert.match(csp, /connect-src 'self' https:\/\/api\.charitypilot\.ie(?:;|$)/);
});

test('production CSP falls back instead of trusting non-canonical API connect sources', () => {
  for (const apiUrl of [
    'https://api.attacker.example',
    'https://services.charitypilot.ie',
    'http://localhost:3002',
    'https://api.charitypilot.ie/api/v1',
  ]) {
    const csp = createContentSecurityPolicy({
      nonce: 'test-nonce',
      isDevelopment: false,
      apiUrl,
    });

    assert.match(csp, /connect-src 'self' https:\/\/api\.charitypilot\.ie(?:;|$)/);
    assert.doesNotMatch(csp, /attacker\.example|localhost:3002|\/api\/v1/);
  }
});

test('isolated production E2E CSP permits only its exact loopback API without dev execution allowances', () => {
  const csp = createContentSecurityPolicy({
    nonce: 'test-nonce',
    isDevelopment: false,
    isIsolatedE2e: true,
    apiUrl: 'http://127.0.0.1:3302/',
    webUrl: 'http://127.0.0.1:3303',
  });

  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:3302(?:;|$)/);
  assert.doesNotMatch(
    csp,
    /unsafe-eval|upgrade-insecure-requests|ws:\/\/|localhost:|api\.charitypilot\.ie/,
  );
});

test('isolated production E2E CSP fails closed instead of trusting lookalike or internal API origins', () => {
  for (const apiUrl of [
    undefined,
    '',
    'http://localhost:3302',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3302/api/v1',
    'http://127.0.0.1:3302?target=personal',
    'http://api:3302',
    'https://api.charitypilot.ie',
    'https://api.attacker.example',
  ]) {
    const csp = createContentSecurityPolicy({
      nonce: 'test-nonce',
      isDevelopment: false,
      isIsolatedE2e: true,
      apiUrl,
    });

    assert.match(csp, /connect-src 'self'(?:;|$)/);
    assert.doesNotMatch(
      csp,
      /127\.0\.0\.1:3302|localhost:|http:\/\/api:|api\.charitypilot\.ie|attacker\.example|upgrade-insecure-requests/,
    );
  }
});

test('development CSP selects the configured isolated API origin without retaining the personal API', () => {
  const csp = createContentSecurityPolicy({
    nonce: 'test-nonce',
    isDevelopment: true,
    apiUrl: 'http://127.0.0.1:3302/',
    webUrl: 'http://127.0.0.1:3303/',
  });

  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:3302 http:\/\/127\.0\.0\.1:3303 ws:\/\/127\.0\.0\.1:3303/);
  assert.doesNotMatch(csp, /localhost:3002|localhost:3003/);
});

test('development CSP keeps the personal API only as the unconfigured local default', () => {
  for (const apiUrl of [undefined, '', '   ']) {
    const csp = createContentSecurityPolicy({
      nonce: 'test-nonce',
      isDevelopment: true,
      apiUrl,
    });

    assert.match(csp, /connect-src 'self' http:\/\/localhost:3002 http:\/\/localhost:3003 ws:\/\/localhost:3003/);
  }
});

test('development CSP fails closed for non-loopback or non-origin API values', () => {
  for (const apiUrl of [
    'https://api.attacker.example',
    'http://localhost.attacker.example:3002',
    'http://0.0.0.0:3302',
    'http://10.0.0.2:3302',
    'http://api:3302',
    'http://127.0.0.1:3302/api/v1',
    'http://127.0.0.1:3302?target=personal',
    'http://127.0.0.1:3302#fragment',
    'http://user@127.0.0.1:3302',
  ]) {
    const csp = createContentSecurityPolicy({
      nonce: 'test-nonce',
      isDevelopment: true,
      apiUrl,
    });

    assert.match(csp, /connect-src 'self' http:\/\/localhost:3003 ws:\/\/localhost:3003/);
    assert.doesNotMatch(csp, /localhost:3002|127\.0\.0\.1:3302|attacker|0\.0\.0\.0|10\.0\.0\.2|http:\/\/api:/);
  }
});

test('development CSP fails closed for non-loopback or non-origin web values', () => {
  for (const webUrl of [
    'https://web.attacker.example',
    'http://localhost.attacker.example:3303',
    'http://0.0.0.0:3303',
    'http://web:3303',
    'http://127.0.0.1:3303/path',
    'http://user@127.0.0.1:3303',
  ]) {
    const csp = createContentSecurityPolicy({
      nonce: 'test-nonce',
      isDevelopment: true,
      apiUrl: 'http://127.0.0.1:3302',
      webUrl,
    });

    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:3302(?:;|$)/);
    assert.doesNotMatch(csp, /localhost:3003|127\.0\.0\.1:3303|attacker|0\.0\.0\.0|http:\/\/web:/);
  }
});
