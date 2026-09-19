import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, DEFAULT_BASE_URL } from '../config.js';

test('the default base URL is the tailnet address', () => {
  assert.equal(parseArgs([]).baseUrl, DEFAULT_BASE_URL);
  assert.ok(DEFAULT_BASE_URL.startsWith('https://'));
});

test('personal data is withheld unless explicitly allowed', () => {
  assert.equal(parseArgs([]).allowPersonalData, false);
  assert.equal(parseArgs(['--allow-personal-data']).allowPersonalData, true);
});

test('the base URL can be overridden', () => {
  assert.equal(parseArgs(['--base-url', 'https://other.test']).baseUrl, 'https://other.test');
});

test('a non-https base URL is refused', () => {
  assert.throws(() => parseArgs(['--base-url', 'http://insecure.test']), /https/i);
});

test('there is no flag that disables TLS verification', () => {
  for (const flag of ['--insecure', '--no-verify-tls', '--skip-tls-verify']) {
    assert.throws(() => parseArgs([flag]), /Unknown option/i, `${flag} must not be accepted`);
  }
});

test('the command defaults to serve', () => {
  assert.equal(parseArgs([]).command, 'serve');
  assert.equal(parseArgs(['connect']).command, 'connect');
});
