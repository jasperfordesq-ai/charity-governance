import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSecurityScanFromArgs } from './security-scan.mjs';

function runScanner(args, env = {}, options = {}) {
  return runSecurityScanFromArgs(args, {
    processEnv: { ...process.env, ...env },
    ...options,
  });
}

function withTempProject(callback) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-security-scan-'));

  try {
    return callback(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('secret scanner fails on committed credential patterns without printing the secret', () => {
  withTempProject((tempDir) => {
    const leakedSecret = 'sk_live_1234567890abcdefghijklmnopqrstuvwxyz';
    writeFileSync(join(tempDir, 'leak.env'), `STRIPE_SECRET_KEY=${leakedSecret}\n`);

    const result = runScanner(['secrets', '--path', tempDir]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /stripe-secret-key/);
    assert.match(result.stderr, /leak\.env:1/);
    assert.doesNotMatch(result.stderr, new RegExp(leakedSecret));
  });
});

test('secret scanner checks explicitly scanned env files', () => {
  withTempProject((tempDir) => {
    const leakedSecret = 'sk_live_1234567890abcdefghijklmnopqrstuvwxyz';
    writeFileSync(join(tempDir, '.env'), `STRIPE_SECRET_KEY=${leakedSecret}\n`);

    const result = runScanner(['secrets', '--path', tempDir]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /stripe-secret-key/);
    assert.match(result.stderr, /\.env:1/);
    assert.doesNotMatch(result.stderr, new RegExp(leakedSecret));
  });
});

test('secret scanner allows documented local placeholders and CI sentinels', () => {
  withTempProject((tempDir) => {
    writeFileSync(
      join(tempDir, 'sentinels.env'),
      [
        'STRIPE_SECRET_KEY=sk_test_...',
        'STRIPE_WEBHOOK_SECRET=whsec_...',
        'RESEND_API_KEY=re_...',
        'SUPABASE_SERVICE_ROLE_KEY=eyJ...',
        'JWT_SECRET=ci-smoke-jwt-secret-with-enough-entropy',
        'STRIPE_SECRET_KEY=sk_live_configuredSecret',
        'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
        'RESEND_API_KEY=re_configuredSecret',
        'STRIPE_SECRET_KEY=sk_live_ci_smoke_secret',
        'STRIPE_WEBHOOK_SECRET=whsec_ci_smoke_secret',
        'RESEND_API_KEY=re_ci_smoke_key',
        '',
      ].join('\n'),
    );

    const result = runScanner(['secrets', '--path', tempDir]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Secret scan passed/);
  });
});

test('scanner falls back to the working tree when git tracked-file listing is unavailable', () => {
  withTempProject((tempDir) => {
    writeFileSync(join(tempDir, 'safe.ts'), 'export const value = 1;\n');
    const result = runScanner(['sast'], {}, { scanRoot: tempDir });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /git ls-files unavailable/);
    assert.match(result.stdout, /SAST scan passed/);
    assert.doesNotMatch(result.stderr, /Cannot read properties/);
  });
});

test('security scanner rejects empty inline path options', () => {
  const result = runScanner(['scan', '--path=']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--path requires a value/);
});

test('scanner skips generated Next build output directories', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, '.next-build-verify'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, '.next-build-verify', 'generated.js'), 'eval("generated");\n');
    writeFileSync(join(tempDir, 'src', 'safe.ts'), 'export const value = 1;\n');

    const result = runScanner(['sast', '--path', tempDir]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SAST scan passed/);
  });
});

test('SAST scanner fails on dangerous code patterns with file and detector context', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(
      join(tempDir, 'src', 'unsafe.ts'),
      [
        'export function run(userInput: string, prisma: any) {',
        '  eval(userInput);',
        '  return prisma.$queryRawUnsafe(userInput);',
        '}',
        '',
      ].join('\n'),
    );

    const result = runScanner(['sast', '--path', tempDir]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /dangerous-eval/);
    assert.match(result.stderr, /prisma-raw-unsafe/);
    assert.match(result.stderr, /src[/\\]unsafe\.ts:2/);
    assert.match(result.stderr, /src[/\\]unsafe\.ts:3/);
  });
});

test('SAST scanner passes ordinary TypeScript source', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(
      join(tempDir, 'src', 'safe.ts'),
      [
        'export function greet(name: string) {',
        "  return `Hello ${name.trim()}`;",
        '}',
        '',
      ].join('\n'),
    );

    const result = runScanner(['sast', '--path', tempDir]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SAST scan passed/);
  });
});

// Every raw control byte below is built from a JavaScript escape at runtime.
// Writing one into this file literally would corrupt this file in the same way
// the detector exists to catch, and no diff of it would be readable afterwards.
const NUL = '\u0000';
const UNIT_SEPARATOR = '\u001F';
const DELETE = '\u007F';

test('control byte scanner fails on a NUL committed into source', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(
      join(tempDir, 'src', 'corrupted.ts'),
      [
        'export const label = "ok";',
        `export const broken = "${NUL}";`,
        '',
      ].join('\n'),
    );

    const result = runScanner(['control-bytes', '--path', tempDir]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /control-byte-\\x00/);
    assert.match(result.stderr, /src[/\\]corrupted\.ts:2/);
    // The finding names the byte; it must never carry it.
    assert.doesNotMatch(result.stderr, new RegExp(NUL));
  });
});

test('control byte scanner catches a character class written as raw bytes', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(
      join(tempDir, 'src', 'sanitiser.ts'),
      [
        'export function clean(raw: string) {',
        `  return raw.replace(/[${NUL}-${UNIT_SEPARATOR}${DELETE}]/g, " ");`,
        '}',
        '',
      ].join('\n'),
    );

    const result = runScanner(['control-bytes', '--path', tempDir]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /control-byte-\\x00/);
    assert.match(result.stderr, /control-byte-\\x1f/);
    assert.match(result.stderr, /control-byte-\\x7f/);
    assert.match(result.stderr, /src[/\\]sanitiser\.ts:2/);
  });
});

test('control byte scanner passes the escaped form of the same character class', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(
      join(tempDir, 'src', 'sanitiser.ts'),
      [
        'export function clean(raw: string) {',
        '  return raw.replace(/[\\x00-\\x1f\\x7f]/g, " ");',
        '}',
        '',
      ].join('\n'),
    );

    const result = runScanner(['control-bytes', '--path', tempDir]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Control byte scan passed/);
  });
});

test('control byte scanner allows tab, newline and carriage return', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(
      join(tempDir, 'src', 'whitespace.ts'),
      'export const indented = {\r\n\tkey: "value",\r\n};\r\n',
    );

    const result = runScanner(['control-bytes', '--path', tempDir]);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('control byte scanner leaves genuine binary assets alone', () => {
  withTempProject((tempDir) => {
    writeFileSync(join(tempDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1f]));

    const result = runScanner(['control-bytes', '--path', tempDir]);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('the full scan runs the control byte detector alongside the others', () => {
  withTempProject((tempDir) => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src', 'corrupted.ts'), `export const broken = "${NUL}";\n`);

    const result = runScanner(['scan', '--path', tempDir]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Control byte scan failed/);
    assert.match(result.stderr, /control-byte-\\x00/);
  });
});
