import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentSecurityPolicy } from './content-security-policy';

test('production CSP uses only an approved origin-only API connect source', () => {
  const csp = createContentSecurityPolicy({
    nonce: 'test-nonce',
    isDevelopment: false,
    apiUrl: 'https://api.charitypilot.ie/',
  });

  assert.match(csp, /connect-src 'self' https:\/\/api\.charitypilot\.ie(?:;|$)/);
});

test('production CSP falls back instead of trusting unapproved API connect sources', () => {
  for (const apiUrl of [
    'https://api.attacker.example',
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

test('development CSP keeps local API and websocket connect sources', () => {
  const csp = createContentSecurityPolicy({
    nonce: 'test-nonce',
    isDevelopment: true,
    apiUrl: 'https://api.attacker.example',
  });

  assert.match(csp, /connect-src 'self' http:\/\/localhost:3002 http:\/\/localhost:3003 ws:\/\/localhost:3003/);
});
