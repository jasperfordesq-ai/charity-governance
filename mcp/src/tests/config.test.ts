import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, requestedDataScope, DEFAULT_BASE_URL } from '../config.js';

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

test('the profile defaults to default and can be set to local', () => {
  assert.equal(parseArgs([]).profile, 'default');
  assert.equal(parseArgs(['--profile', 'local', '--base-url', 'http://127.0.0.1:3302']).profile, 'local');
});

test('an unknown profile is refused', () => {
  assert.throws(
    () => parseArgs(['--profile', 'production', '--base-url', 'http://127.0.0.1:3302']),
    /profile/i,
  );
});

test('--profile local accepts http only for loopback hosts', () => {
  for (const url of ['http://127.0.0.1:3302', 'http://localhost:3002', 'http://[::1]:3002']) {
    assert.equal(parseArgs(['--profile', 'local', '--base-url', url]).baseUrl, url);
  }
});

test('--profile local refuses a host that merely looks like loopback', () => {
  for (const url of [
    'http://127.0.0.1.evil.example',
    'http://localhost.example.com',
    'http://10.0.0.5:3002',
  ]) {
    assert.throws(() => parseArgs(['--profile', 'local', '--base-url', url]), /loopback/i, url);
  }
});

test('--profile local cannot be pointed at the VM', () => {
  assert.throws(
    () => parseArgs(['--profile', 'local', '--base-url', DEFAULT_BASE_URL]),
    /loopback/i,
  );
});

test('without the local profile a loopback http URL is still refused', () => {
  assert.throws(() => parseArgs(['--base-url', 'http://127.0.0.1:3302']), /https/i);
});

test('the email and password-stdin flags parse', () => {
  const config = parseArgs([
    'connect', '--profile', 'local', '--base-url', 'http://127.0.0.1:3302',
    '--email', 'owner@example.org', '--password-stdin',
  ]);
  assert.equal(config.command, 'connect');
  assert.equal(config.email, 'owner@example.org');
  assert.equal(config.passwordStdin, true);
});

test('there is no flag or environment variable that carries a password value', () => {
  for (const flag of ['--password', '--pass', '--secret']) {
    assert.throws(() => parseArgs([flag, 'hunter2']), /Unknown option/i, `${flag} must not be accepted`);
  }
  assert.equal(parseArgs([]).passwordStdin, false);
});

test('the access level defaults to write, and to admin only on the local profile', () => {
  assert.equal(parseArgs([]).accessLevel, 'write');
  assert.equal(
    parseArgs(['--profile', 'local', '--base-url', 'http://127.0.0.1:3302']).accessLevel,
    'admin',
  );
});

test('the access level can be chosen, and an unknown one is refused', () => {
  for (const level of ['read', 'write', 'admin']) {
    assert.equal(parseArgs(['--access-level', level]).accessLevel, level);
  }
  assert.throws(() => parseArgs(['--access-level', 'superuser']), /access level/i);
  assert.throws(() => parseArgs(['--access-level']), /requires a value/i);
});

test('--toolsets narrows to named groups, and refuses a name it does not know', () => {
  assert.deepEqual(parseArgs(['--toolsets', 'compliance,registers']).toolsets, ['compliance', 'registers']);
  assert.equal(parseArgs([]).toolsets, undefined);
  assert.equal(parseArgs(['--toolsets', 'all']).toolsets, undefined);
  // Not a group today and not a plausible one tomorrow: a name that later
  // becomes real would turn this assertion into a false alarm, as "billing" did.
  assert.throws(() => parseArgs(['--toolsets', 'payroll']), /Unknown toolset: payroll/);
});

test('--verbose is off unless asked for', () => {
  assert.equal(parseArgs(['--verbose']).verbose, true);
  assert.equal(parseArgs([]).verbose, false);
});

test('--help and --version are commands, not unknown options', () => {
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.equal(parseArgs(['help']).command, 'help');
});

test('--data-scope chooses what the session may see, and defaults to withholding', () => {
  assert.equal(parseArgs([]).dataScope, undefined);
  assert.equal(parseArgs(['--data-scope', 'full']).dataScope, 'full');
  assert.equal(parseArgs(['--data-scope', 'withheld']).dataScope, 'withheld');
  assert.throws(() => parseArgs(['--data-scope', 'everything']), /Unknown data scope/);
  assert.throws(() => parseArgs(['--data-scope']), /requires a value/);
});

test('the old personal-data flag still means full, and the explicit scope wins', () => {
  assert.equal(requestedDataScope(parseArgs([])), 'withheld');
  assert.equal(requestedDataScope(parseArgs(['--allow-personal-data'])), 'full');
  assert.equal(requestedDataScope(parseArgs(['--data-scope', 'full'])), 'full');
  assert.equal(
    requestedDataScope(parseArgs(['--allow-personal-data', '--data-scope', 'withheld'])),
    'withheld',
    'the flag is the old spelling; asking explicitly must decide',
  );
});
