import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const deployScriptPath = join(scriptsDir, 'production-compose-deploy.mjs');
const digest = 'a'.repeat(64);
const productionSupabaseUrl = 'https://xjvdkmqbtczrnlqpswfa.supabase.co';

function cleanEnv() {
  return {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };
}

async function loadDeployRunner() {
  assert.ok(existsSync(deployScriptPath), 'production compose deploy script must exist');
  const module = await import(pathToFileURL(deployScriptPath).href);
  assert.equal(typeof module.runProductionComposeDeployFromArgs, 'function');
  return module.runProductionComposeDeployFromArgs;
}

function completeDeployEnv(overrides = {}) {
  const values = {
    NODE_ENV: 'production',
    PORT: '3002',
    TRUSTED_PROXY_ADDRESSES: '10.0.0.10',
    READINESS_API_KEY: 'r7Nq2Xc9Lm4Pz8Va6Ys3Td5He1Bw0UkF',
    DATABASE_URL: 'postgresql://user:pass@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    JWT_SECRET: 'J9mQ4vRx7tL2pZs6NfB8hDy3WcK1uEa5',
    FRONTEND_URL: 'https://app.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
    STRIPE_SECRET_KEY: 'sk_live_configuredSecret',
    STRIPE_WEBHOOK_SECRET: 'whsec_configuredSecret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_essentialsMonthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_essentialsYearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_completeMonthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_completeYearly',
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_configuredPortal',
    RESEND_API_KEY: 're_configuredSecret',
    EMAIL_FROM: 'noreply@charitypilot.ie',
    SUPABASE_URL: productionSupabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: 'configured-service-role-key',
    SUPABASE_STORAGE_BUCKET: 'documents',
    ERROR_ALERT_WEBHOOK_URL: 'https://alerts.charitypilot.ie/hooks/charitypilot',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    NEXT_PUBLIC_SUPABASE_URL: productionSupabaseUrl,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_configuredSecret',
    CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL: productionSupabaseUrl,
    CADDY_ACME_EMAIL: 'ops@charitypilot.ie',
    CHARITYPILOT_WEB_DOMAIN: 'app.charitypilot.ie',
    CHARITYPILOT_API_DOMAIN: 'api.charitypilot.ie',
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`,
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL: productionSupabaseUrl,
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

test('production deploy dry-run validates preflight before rendering compose up', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-deploy-dry-run-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv());

  try {
    const result = runProductionComposeDeployFromArgs(
      ['--production-env-file', envPath, '--dry-run'],
      { processEnv: cleanEnv() },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production compose deploy dry-run/);
    const preflightIndex = result.stdout.indexOf('node scripts/production-deploy-preflight.mjs');
    const deployIndex = result.stdout.indexOf('up --wait --wait-timeout 180 -d');
    assert.ok(preflightIndex > -1, 'dry-run must show the preflight command');
    assert.ok(deployIndex > -1, 'dry-run must show the compose deployment command');
    assert.ok(preflightIndex < deployIndex, 'preflight must be shown before compose up');
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /Compose environment:\nCHARITYPILOT_PRODUCTION_ENV_FILE=/);
    assert.match(result.stdout, /Compose command:\ndocker compose --env-file/);
    assert.match(result.stdout, /Post-deploy smoke command:\nnode scripts\/smoke-production-deploy\.mjs/);
    assert.doesNotMatch(result.stdout, /CHARITYPILOT_PRODUCTION_ENV_FILE=.*docker compose --env-file/);
    assert.doesNotMatch(result.stdout, /[A-Z]:\\\\/);
    assert.match(result.stdout, /up --wait --wait-timeout 180 -d/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production deploy dry-run aborts before compose up when preflight fails', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-deploy-preflight-fail-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CHARITYPILOT_API_IMAGE: 'ghcr.io/jasperfordesq-ai/charity-governance-api:sha-test',
  }));

  try {
    const result = runProductionComposeDeployFromArgs(
      ['--production-env-file', envPath, '--dry-run'],
      { processEnv: cleanEnv() },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production compose deploy failed: preflight failed/);
    assert.match(result.stderr, /CHARITYPILOT_API_IMAGE must be pinned to an immutable sha256 digest/);
    assert.doesNotMatch(result.stdout, /up --wait/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production deploy runs preflight before compose up with the selected env file', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), 'charitypilot-selected-production.env');
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ['--production-env-file', envPath, '--wait-timeout', '240'],
    {
      processEnv: cleanEnv(),
      runPreflight: (args, env) => {
        calls.push({ type: 'preflight', args, env });
        return { status: 0, stdout: 'preflight ok\n', stderr: '' };
      },
      runCommand: (command, env) => {
        calls.push({ type: 'command', command, env });
      },
      runSmoke: (args, env) => {
        calls.push({ type: 'smoke', args, env });
        return { status: 0, stdout: 'smoke ok\n', stderr: '' };
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map((call) => call.type), ['preflight', 'command', 'smoke']);
  assert.deepEqual(calls[0].args, ['--production-env-file', envPath]);
    assert.deepEqual(calls[1].command, [
      'docker',
      'compose',
      '--env-file',
      envPath,
      '-f',
      'compose.production.yml',
      '-f',
      'compose.production-tls.yml',
      'up',
      '--wait',
      '--wait-timeout',
      '240',
      '-d',
  ]);
  assert.equal(calls[1].env.CHARITYPILOT_PRODUCTION_ENV_FILE, envPath);
  assert.deepEqual(calls[2].args, ['--production-env-file', envPath]);
  assert.equal(calls[2].env.CHARITYPILOT_PRODUCTION_ENV_FILE, envPath);
  assert.match(result.stdout, /preflight ok/);
  assert.match(result.stdout, /smoke ok/);
  assert.match(result.stdout, /Production compose deploy completed/);
});

test('production deploy fails after compose up when public smoke fails', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), 'charitypilot-smoke-fail-production.env');
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ['--production-env-file', envPath],
    {
      processEnv: cleanEnv(),
      runPreflight: (args, env) => {
        calls.push({ type: 'preflight', args, env });
        return { status: 0, stdout: 'preflight ok\n', stderr: '' };
      },
      runCommand: (command, env) => {
        calls.push({ type: 'command', command, env });
      },
      runSmoke: (args, env) => {
        calls.push({ type: 'smoke', args, env });
        return { status: 1, stdout: '', stderr: 'keyed readiness must return 200 ready\n' };
      },
    },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(calls.map((call) => call.type), ['preflight', 'command', 'smoke']);
  assert.match(result.stdout, /preflight ok/);
  assert.match(result.stderr, /Production compose deploy failed: post-deploy smoke failed/);
  assert.match(result.stderr, /keyed readiness must return 200 ready/);
});

test('production deploy redacts command and smoke failure transcripts', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), 'charitypilot-redacted-production.env');
  const secret = 'sk_live_deploySecret';

  const commandResult = runProductionComposeDeployFromArgs(
    ['--production-env-file', envPath],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: 'preflight ok\n', stderr: '' }),
      runCommand: () => {
        throw new Error(`docker compose failed with STRIPE_SECRET_KEY=${secret} and DATABASE_URL=postgresql://user:pass@db.charitypilot.ie:5432/app`);
      },
      runSmoke: () => ({ status: 0, stdout: '', stderr: '' }),
    },
  );

  assert.equal(commandResult.status, 1);
  assert.match(commandResult.stderr, /STRIPE_SECRET_KEY=\[redacted\]/);
  assert.match(commandResult.stderr, /DATABASE_URL=\[redacted\]/);
  assert.doesNotMatch(commandResult.stderr, /sk_live_deploySecret|user:pass/);

  const smokeResult = runProductionComposeDeployFromArgs(
    ['--production-env-file', envPath],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: 'preflight ok\n', stderr: '' }),
      runCommand: () => {},
      runSmoke: () => ({
        status: 1,
        stdout: '',
        stderr: `readiness failed with Bearer configured-service-role-key and ERROR_ALERT_WEBHOOK_URL=https://hooks.example/alert?token=secret-token\n`,
      }),
    },
  );

  assert.equal(smokeResult.status, 1);
  assert.match(smokeResult.stderr, /Bearer \[redacted\]/);
  assert.match(smokeResult.stderr, /ERROR_ALERT_WEBHOOK_URL=\[redacted\]/);
  assert.doesNotMatch(smokeResult.stderr, /configured-service-role-key|secret-token/);
});

test('production deploy rejects invalid wait timeouts before preflight', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  let preflightCalled = false;

  const result = runProductionComposeDeployFromArgs(
    ['--production-env-file', '.env.production', '--wait-timeout', '0'],
    {
      processEnv: cleanEnv(),
      runPreflight: () => {
        preflightCalled = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(preflightCalled, false);
  assert.match(result.stderr, /--wait-timeout must be a positive integer number of seconds/);
});

test('production deploy rejects empty production env file option before preflight', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  let preflightCalled = false;

  const result = runProductionComposeDeployFromArgs(
    ['--production-env-file=', '--dry-run'],
    {
      processEnv: cleanEnv(),
      runPreflight: () => {
        preflightCalled = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(preflightCalled, false);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--production-env-file requires a value/);
});

test('production deploy can opt out of the TLS overlay when a managed load balancer terminates HTTPS', async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), 'charitypilot-managed-lb-production.env');
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ['--production-env-file', envPath, '--no-tls-proxy'],
    {
      processEnv: cleanEnv(),
      runPreflight: (args, env) => {
        calls.push({ type: 'preflight', args, env });
        return { status: 0, stdout: 'preflight ok\n', stderr: '' };
      },
      runCommand: (command, env) => {
        calls.push({ type: 'command', command, env });
      },
      runSmoke: (args, env) => {
        calls.push({ type: 'smoke', args, env });
        return { status: 0, stdout: 'smoke ok\n', stderr: '' };
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls[0].args, ['--production-env-file', envPath, '--no-tls-proxy']);
  assert.deepEqual(calls[1].command, [
    'docker',
    'compose',
    '--env-file',
    envPath,
    '-f',
    'compose.production.yml',
    'up',
    '--wait',
    '--wait-timeout',
    '180',
    '-d',
  ]);
});
