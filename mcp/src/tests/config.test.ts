import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  requestedDataScope,
  profileSummary,
  DEFAULT_BASE_URL,
  PROFILE_NAMES,
  PRODUCTION_API_ORIGIN,
} from '../config.js';

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

test('the two directories may arrive as environment variables, for a packaged bundle', () => {
  // A bundle cannot add or drop a flag depending on whether somebody filled a
  // field in, so it sets the value either way and an unanswered field arrives
  // empty.
  const before = {
    upload: process.env.CHARITYPILOT_UPLOAD_ROOT,
    download: process.env.CHARITYPILOT_DOWNLOAD_DIR,
  };
  try {
    process.env.CHARITYPILOT_UPLOAD_ROOT = '/home/jasper/charity-docs';
    process.env.CHARITYPILOT_DOWNLOAD_DIR = '   ';
    const fromEnv = parseArgs([]);
    assert.equal(fromEnv.uploadRoot, '/home/jasper/charity-docs');
    assert.equal(fromEnv.downloadDir, undefined, 'an unanswered field is not a directory');

    const flagWins = parseArgs(['--upload-root', '/elsewhere']);
    assert.equal(flagWins.uploadRoot, '/elsewhere');
  } finally {
    if (before.upload === undefined) delete process.env.CHARITYPILOT_UPLOAD_ROOT;
    else process.env.CHARITYPILOT_UPLOAD_ROOT = before.upload;
    if (before.download === undefined) delete process.env.CHARITYPILOT_DOWNLOAD_DIR;
    else process.env.CHARITYPILOT_DOWNLOAD_DIR = before.download;
  }
});

// ── profiles as pins ───────────────────────────────────────────────────────

test('every profile is described, so a refusal can name the alternatives', () => {
  assert.deepEqual([...PROFILE_NAMES], ['default', 'local', 'vm', 'prod']);
  for (const name of PROFILE_NAMES) {
    assert.match(profileSummary(), new RegExp(`\\b${name}\\b`), `${name} must be described`);
  }
});

test('the vm profile reaches the private server and nothing else', () => {
  const config = parseArgs(['status', '--profile', 'vm', '--base-url', DEFAULT_BASE_URL]);
  assert.equal(config.profile, 'vm');
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
});

test('the prod profile reaches the hosted service and nothing else', () => {
  const config = parseArgs([
    'status', '--profile', 'prod', '--base-url', PRODUCTION_API_ORIGIN,
  ]);
  assert.equal(config.profile, 'prod');
});

// The reason a profile is worth having: the configuration file naming the host
// is treated as something an attacker may write, so a pin refuses a redirected
// base URL before any password is typed.
test('a pinned profile refuses a host that merely looks right', () => {
  for (const [profile, url] of [
    ['prod', 'https://api.charitypilot.ie.evil.example'],
    ['prod', 'https://evil.example/api.charitypilot.ie'],
    ['prod', 'https://app.charitypilot.ie'],
    ['vm', 'https://charitypilot.tailae0b07.ts.net.evil.example'],
    ['vm', 'https://charitypilot.other-tailnet.ts.net'],
  ] as const) {
    assert.throws(
      () => parseArgs(['status', '--profile', profile, '--base-url', url]),
      new RegExp(`--profile ${profile} only reaches`),
      `${profile} must refuse ${url}`,
    );
  }
});

test('a pinned profile refuses plain http even to its own host', () => {
  assert.throws(
    () => parseArgs(['status', '--profile', 'prod', '--base-url', 'http://api.charitypilot.ie']),
    /must use https/,
  );
});

test('a pinned profile ignores the path, because identity is scheme, host and port', () => {
  // Trailing paths arrive from copy-and-paste constantly and say nothing about
  // which machine is being reached.
  const config = parseArgs([
    'status', '--profile', 'prod', '--base-url', `${PRODUCTION_API_ORIGIN}/api/v1`,
  ]);
  assert.equal(config.profile, 'prod');
});

test('local is still loopback only, and still the one profile allowing http', () => {
  assert.equal(
    parseArgs(['status', '--profile', 'local', '--base-url', 'http://127.0.0.1:3002']).profile,
    'local',
  );
  assert.throws(
    () => parseArgs(['status', '--profile', 'local', '--base-url', 'https://api.charitypilot.ie']),
    /only accepts a loopback base URL/,
  );
  assert.throws(
    () => parseArgs(['status', '--profile', 'local', '--base-url', 'http://127.0.0.1.evil.example']),
    /only accepts a loopback base URL/,
  );
});

test('the default profile pins nothing but still requires https', () => {
  // A charity running its own deployment has an origin nobody here can know.
  assert.equal(
    parseArgs(['status', '--base-url', 'https://charity.example/api']).baseUrl,
    'https://charity.example/api',
  );
  assert.throws(
    () => parseArgs(['status', '--base-url', 'http://charity.example']),
    /must use https/,
  );
});

test('an unknown profile is refused with the real list rather than a bare error', () => {
  assert.throws(
    () => parseArgs(['status', '--profile', 'staging']),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /Unknown profile: staging/);
      assert.match(message, /\bvm\b/);
      assert.match(message, /\bprod\b/);
      return true;
    },
  );
});
