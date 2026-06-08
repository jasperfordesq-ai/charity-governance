import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rollbackScriptPath = join(scriptsDir, 'production-compose-rollback.mjs');
const currentDigest = 'b'.repeat(64);
const rollbackDigest = 'a'.repeat(64);

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

async function loadRollbackRunner() {
  assert.ok(existsSync(rollbackScriptPath), 'production compose rollback script must exist');
  const module = await import(pathToFileURL(rollbackScriptPath).href);
  assert.equal(typeof module.runProductionComposeRollbackFromArgs, 'function');
  return module.runProductionComposeRollbackFromArgs;
}

function productionEnv(overrides = {}) {
  const values = {
    NODE_ENV: 'production',
    PORT: '3002',
    TRUSTED_PROXY_ADDRESSES: '10.0.0.10',
    READINESS_API_KEY: 'configured-readiness-key-32-chars',
    DATABASE_URL: 'postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
    JWT_SECRET: 'a'.repeat(40),
    FRONTEND_URL: 'https://app.charitypilot.ie',
    AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
    STRIPE_SECRET_KEY: 'sk_live_configuredSecret',
    STRIPE_WEBHOOK_SECRET: 'whsec_configuredSecret',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_essentialsMonthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_essentialsYearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_completeMonthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_completeYearly',
    RESEND_API_KEY: 're_configuredSecret',
    EMAIL_FROM: 'noreply@charitypilot.ie',
    SUPABASE_URL: 'https://configured-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'configured-service-role-key',
    SUPABASE_STORAGE_BUCKET: 'documents',
    ERROR_ALERT_WEBHOOK_URL: 'https://alerts.charitypilot.ie/hooks/charitypilot',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    NEXT_PUBLIC_SUPABASE_URL: 'https://configured-project.supabase.co',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_configuredSecret',
    CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL: 'https://configured-project.supabase.co',
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${currentDigest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${currentDigest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${currentDigest}`,
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function rollbackManifest(overrides = {}) {
  const values = {
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${rollbackDigest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${rollbackDigest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${rollbackDigest}`,
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

test('production rollback dry-run delegates to deploy with rollback digests merged over production env', async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-rollback-dry-run-'));
  const envPath = join(tempDir, 'production.env');
  const manifestPath = join(tempDir, 'release-image-digests.previous.env');
  const deployCalls = [];

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        '--production-env-file',
        envPath,
        '--rollback-digest-file',
        manifestPath,
        '--wait-timeout',
        '240',
        '--dry-run',
      ],
      {
        processEnv: cleanEnv(),
        runDeploy: (args, env) => {
          deployCalls.push({ args, env, mergedEnvPath: args[1], mergedEnv: readFileSync(args[1], 'utf8') });
          return { status: 0, stdout: 'deploy dry-run ok\n', stderr: '' };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(deployCalls.length, 1);
    assert.deepEqual(deployCalls[0].args, [
      '--production-env-file',
      deployCalls[0].mergedEnvPath,
      '--wait-timeout',
      '240',
      '--dry-run',
    ]);
    assert.match(deployCalls[0].mergedEnv, new RegExp(`CHARITYPILOT_API_IMAGE=ghcr\\.io/jasperfordesq-ai/charity-governance-api@sha256:${rollbackDigest}`));
    assert.match(deployCalls[0].mergedEnv, new RegExp(`CHARITYPILOT_WEB_IMAGE=ghcr\\.io/jasperfordesq-ai/charity-governance-web@sha256:${rollbackDigest}`));
    assert.match(deployCalls[0].mergedEnv, new RegExp(`CHARITYPILOT_MIGRATION_IMAGE=ghcr\\.io/jasperfordesq-ai/charity-governance-migrations@sha256:${rollbackDigest}`));
    assert.match(deployCalls[0].mergedEnv, /JWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.doesNotMatch(deployCalls[0].mergedEnv, new RegExp(currentDigest));
    assert.match(result.stdout, /Production compose rollback dry-run/);
    assert.match(result.stdout, /deploy dry-run ok/);
    assert.equal(existsSync(deployCalls[0].mergedEnvPath), false, 'temporary merged env file must be removed');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production rollback fails before deploy when rollback digest manifest uses mutable image tags', async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-rollback-invalid-'));
  const envPath = join(tempDir, 'production.env');
  const manifestPath = join(tempDir, 'release-image-digests.previous.env');
  let deployCalled = false;

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest({
    CHARITYPILOT_API_IMAGE: 'ghcr.io/jasperfordesq-ai/charity-governance-api:sha-old',
  }));

  try {
    const result = runProductionComposeRollbackFromArgs(
      ['--production-env-file', envPath, '--rollback-digest-file', manifestPath],
      {
        processEnv: cleanEnv(),
        runDeploy: () => {
          deployCalled = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(deployCalled, false);
    assert.match(result.stderr, /Production compose rollback failed/);
    assert.match(result.stderr, /CHARITYPILOT_API_IMAGE must be pinned to an immutable sha256 digest/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production rollback propagates deploy failures from the shared deploy path', async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-rollback-deploy-fail-'));
  const envPath = join(tempDir, 'production.env');
  const manifestPath = join(tempDir, 'release-image-digests.previous.env');

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());

  try {
    const result = runProductionComposeRollbackFromArgs(
      ['--production-env-file', envPath, '--rollback-digest-file', manifestPath],
      {
        processEnv: cleanEnv(),
        runDeploy: () => ({ status: 1, stdout: 'preflight ok\n', stderr: 'post-deploy smoke failed\n' }),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /preflight ok/);
    assert.match(result.stderr, /Production compose rollback failed: deployment failed/);
    assert.match(result.stderr, /post-deploy smoke failed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production rollback requires an explicit rollback digest manifest', async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();

  const result = runProductionComposeRollbackFromArgs(
    ['--production-env-file', '.env.production'],
    { processEnv: cleanEnv() },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--rollback-digest-file is required/);
});
