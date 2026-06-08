import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scannerPath = join(scriptsDir, 'security-scan.mjs');

function runScanner(args) {
  return spawnSync(process.execPath, [scannerPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
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
