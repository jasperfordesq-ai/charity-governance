import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { runProductionPreflightFromArgs } from './check-production.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const productionSupabaseUrl = 'https://xjvdkmqbtczrnlqpswfa.supabase.co';
const validRuntimeWebApiUrlEnv = {
  CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
};
const forbiddenApiRuntimePackages = [
  'typescript',
  'tsx',
  'prisma',
  'turbo',
  'next',
  'react',
  'react-dom',
  '@heroui/react',
  'pino-pretty',
];
const forbiddenMigrationRunnerPackages = [
  '@prisma/client',
  'fastify',
  '@fastify/cookie',
  '@fastify/cors',
  '@fastify/multipart',
  '@fastify/rate-limit',
  'stripe',
  'resend',
  '@supabase/supabase-js',
  'bcryptjs',
  'jsonwebtoken',
  'next',
  'react',
  'react-dom',
  '@heroui/react',
  'typescript',
  'tsx',
  'turbo',
  'pino-pretty',
];
const forbiddenWebRuntimePackages = [
  'typescript',
  'eslint',
  'turbo',
  '@prisma/client',
  'fastify',
  '@fastify/cookie',
  '@fastify/cors',
  '@fastify/multipart',
  '@fastify/rate-limit',
  'stripe',
  'fastify-plugin',
  'resend',
  '@supabase/supabase-js',
  'bcryptjs',
  'jsonwebtoken',
  'pino-pretty',
];

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
}

function currentAuditSelectedGateCommit() {
  const auditLedger = readRepoFile('docs/platform-completion-audit.md');
  const match = auditLedger.match(/`npm run release:ready` passed locally on 2026-07-09 at commit ([a-f0-9]{7,40})/);
  assert.ok(match, 'platform completion audit must record the latest local release-gate commit');
  return match[1];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function composeServiceBlock(compose, serviceName) {
  const match = compose.match(
    new RegExp(`\\n  ${serviceName}:\\n[\\s\\S]*?(?=\\n  [A-Za-z0-9_-]+:\\n|\\nnetworks:\\n|$)`),
  );
  assert.ok(match, `compose service ${serviceName} must exist`);
  return match[0];
}

function assertComposeServiceHasReadOnlyRootfs(service, serviceName) {
  assert.match(service, /\n\s+read_only:\s+true\b/, `${serviceName} must run with a read-only root filesystem`);
  assert.match(
    service,
    /\n\s+tmpfs:\s*\n\s+- \/tmp\b/,
    `${serviceName} must keep writable temp space isolated to tmpfs`,
  );
}

function dockerRunForCommand(step, command) {
  const commandIndex = step.indexOf(command);
  assert.notEqual(commandIndex, -1, `scheduled job smoke command must exist: ${command}`);

  const runStart = step.lastIndexOf('docker run --rm --network host', commandIndex);
  assert.notEqual(runStart, -1, `scheduled job smoke command must run in Docker: ${command}`);

  const nextRun = step.indexOf('docker run --rm --network host', commandIndex + command.length);
  return step.slice(runStart, nextRun === -1 ? undefined : nextRun);
}

function workflowStepBetween(workflow, stepName, nextStepName) {
  const stepStart = workflow.indexOf(`name: ${stepName}`);
  assert.notEqual(stepStart, -1, `${stepName} step must exist`);
  const stepEnd = nextStepName ? workflow.indexOf(`name: ${nextStepName}`, stepStart) : -1;
  return workflow.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);
}

function assertWorkflowUsesPackagePathAbsenceChecks(step) {
  assert.match(step, /const path = require\('path'\)/);
  assert.match(step, /path\.join\('node_modules', \.\.\.pkg\.split\('\/'\)\)/);
  assert.doesNotMatch(step, /require\.resolve\(pkg\)/);
}

function assertWorkflowChecksForbiddenWebRuntimePackages(workflow) {
  for (const packageName of forbiddenWebRuntimePackages) {
    assert.match(
      workflow,
      new RegExp(`'${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `web runtime dependency check must reject ${packageName}`,
    );
  }
}

function assertWorkflowChecksForbiddenApiRuntimePackages(workflow) {
  for (const packageName of forbiddenApiRuntimePackages) {
    assert.match(
      workflow,
      new RegExp(`'${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `API runtime dependency check must reject ${packageName}`,
    );
  }
}

function assertDockerfileUsesDigestPinnedNodeBase(dockerfile, dockerfilePath) {
  const nodeFromLines = dockerfile.match(/^FROM\s+node:22-alpine(?:@[^\s]+)?\s+AS\s+\S+/gm) ?? [];
  assert.ok(nodeFromLines.length > 0, `${dockerfilePath} must use node:22-alpine build stages`);

  for (const fromLine of nodeFromLines) {
    assert.match(
      fromLine,
      /^FROM\s+node:22-alpine@sha256:[a-f0-9]{64}\s+AS\s+\S+$/,
      `${dockerfilePath} must digest-pin Node base image in: ${fromLine}`,
    );
  }
}

function dockerfileStage(dockerfile, stageName) {
  const header = dockerfile.match(new RegExp(`^FROM\\s+[^\\r\\n]+\\s+AS\\s+${escapeRegExp(stageName)}\\s*$`, 'm'));
  assert.ok(header?.index !== undefined, `Dockerfile stage must exist: ${stageName}`);

  const start = header.index;
  const rest = dockerfile.slice(start + header[0].length);
  const nextStage = rest.search(/^FROM\s+/m);
  const end = nextStage === -1 ? dockerfile.length : start + header[0].length + nextStage;
  return dockerfile.slice(start, end);
}

function assertWorkflowChecksForbiddenMigrationRunnerPackages(workflow) {
  for (const packageName of forbiddenMigrationRunnerPackages) {
    assert.match(
      workflow,
      new RegExp(`'${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `migration runner dependency check must reject ${packageName}`,
    );
  }
}

function workspacePackageDirs() {
  return ['apps', 'packages'].flatMap((workspaceRoot) =>
    readdirSync(join(repoRoot, workspaceRoot), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspaceRoot, entry.name)),
  );
}

function workspaceHasSourceTests(workspaceDir) {
  const testsDir = join(repoRoot, workspaceDir, 'src', 'tests');
  if (!existsSync(testsDir)) return false;

  return readdirSync(testsDir).some((fileName) => /\.test\.(?:ts|tsx|js|mjs)$/.test(fileName));
}

function repoFilesUnder(path) {
  const absolutePath = join(repoRoot, path);
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) return repoFilesUnder(childPath);
    return childPath;
  });
}

function packageLockPackage(packagePath) {
  const packageLock = JSON.parse(readRepoFile('package-lock.json'));
  return packageLock.packages[packagePath];
}

function cleanEnv() {
  const env = {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

function runPreflight(args, envOverrides = {}) {
  const defaultRuntimeEnv = {
    ...(Object.hasOwn(envOverrides, 'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL')
      ? {}
      : {
          CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: validRuntimeWebApiUrlEnv.CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL,
        }),
  };

  return runProductionPreflightFromArgs(args, {
    ...cleanEnv(),
    ...defaultRuntimeEnv,
    ...envOverrides,
  });
}

function completeProductionEnv(overrides = {}) {
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
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_configuredSecret',
    ...overrides,
  };

  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

test('production preflight rejects unknown options before reading configuration', () => {
  const result = runPreflight(['--production-env-file=.env.production', '--surprise']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown option: --surprise/);
  assert.match(result.stderr, /Usage: node scripts\/check-production\.mjs \[--production-env-file=<path>\]/);
});

test('fails clearly when the explicit production env file is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-missing-'));
  const envPath = join(tempDir, 'missing-production.env');
  const tokenEnvPath = `${envPath}?token=secret-token`;

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Production preflight failed: environment file not found: ${envPath}`));

    const redactedResult = runPreflight([`--production-env-file=${tokenEnvPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(redactedResult.status, 1);
    assert.match(redactedResult.stderr, /token=\[redacted\]/);
    assert.doesNotMatch(redactedResult.stderr, /secret-token/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails with configuration issues when the selected env file contains placeholders', () => {
  const result = runPreflight(['--production-env-file=.env.example']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production preflight failed \(\d+ issues\):/);
  assert.match(result.stderr, /JWT_SECRET is missing or still contains a placeholder value/);
  assert.match(result.stderr, /STRIPE_SECRET_KEY is missing or still contains a placeholder value/);
  assert.match(result.stderr, /FRONTEND_URL must use https:\/\/ for production/);
  assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
});

test('passes when the selected env file contains complete production values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=r7Nq2Xc9Lm4Pz8Va6Ys3Td5He1Bw0UkF',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.ie:5432/charitypilot?sslmode=require',
      'JWT_SECRET=J9mQ4vRx7tL2pZs6NfB8hDy3WcK1uEa5',
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'STRIPE_BILLING_PORTAL_CONFIGURATION_ID=bpc_configuredPortal',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      `SUPABASE_URL=${productionSupabaseUrl}`,
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=https://alerts.charitypilot.ie/hooks/charitypilot',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
    assert.ok(result.stdout.includes(envPath));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the API Supabase URL still contains project-ref placeholder text', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-project-ref-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      SUPABASE_URL: 'https://REAL_SUPABASE_PROJECT_REF.supabase.co',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SUPABASE_URL is missing or still contains a placeholder value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the API Supabase URL uses a sample project ref', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-sample-supabase-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      SUPABASE_URL: 'https://configured-project.supabase.co',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SUPABASE_URL must not use a sample Supabase project ref/);
    assert.doesNotMatch(result.stderr, /configured-project/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production Supabase service role uses copied secret-store placeholder text', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-supabase-service-placeholder-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key-from-secret-store',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY is missing or still contains a placeholder value/);
    assert.doesNotMatch(result.stderr, /supabase-service-role-key-from-secret-store/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production database URL uses a reserved documentation hostname', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-db-doc-host-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      DATABASE_URL: 'postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL must not use a reserved documentation hostname/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production document storage is configured to use the local driver', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-storage-driver-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv({ DOCUMENT_STORAGE_DRIVER: 'local' }));

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /DOCUMENT_STORAGE_DRIVER must not be local for production; use Supabase document storage/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production web or API origins drift from canonical hostnames', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-canonical-hosts-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      FRONTEND_URL: 'https://charitypilot.ie',
      NEXT_PUBLIC_API_URL: 'https://services.charitypilot.ie',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://services.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /FRONTEND_URL must use the canonical production web origin https:\/\/app\.charitypilot\.ie/,
    );
    assert.match(
      result.stderr,
      /NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/,
    );
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production billing or email provider identifiers have invalid prefixes', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-provider-prefixes-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      STRIPE_WEBHOOK_SECRET: 'configured-webhook-secret',
      STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'essentialsMonthly',
      STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'essentialsYearly',
      STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'completeMonthly',
      STRIPE_COMPLETE_YEARLY_PRICE_ID: 'completeYearly',
      RESEND_API_KEY: 'configuredResendSecret',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /STRIPE_WEBHOOK_SECRET must use a Stripe webhook signing secret/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_MONTHLY_PRICE_ID must use a Stripe price ID/);
    assert.match(result.stderr, /STRIPE_ESSENTIALS_YEARLY_PRICE_ID must use a Stripe price ID/);
    assert.match(result.stderr, /STRIPE_COMPLETE_MONTHLY_PRICE_ID must use a Stripe price ID/);
    assert.match(result.stderr, /STRIPE_COMPLETE_YEARLY_PRICE_ID must use a Stripe price ID/);
    assert.match(result.stderr, /RESEND_API_KEY must use a Resend API key/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production access token expiry is malformed or overlong', () => {
  for (const [expiry, expectedIssue] of [
    ['forever', 'JWT_EXPIRY must be a duration like 15m, 1h, or 3600s'],
    ['2h', 'JWT_EXPIRY must not exceed 1h in production'],
  ]) {
    const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-jwt-expiry-'));
    const envPath = join(tempDir, 'production.env');

    writeFileSync(envPath, completeProductionEnv({ JWT_EXPIRY: expiry }));

    try {
      const result = runPreflight([`--production-env-file=${envPath}`]);

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(escapeRegExp(expectedIssue)));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('fails when production refresh token TTL is malformed or out of range', () => {
  for (const ttl of ['forever', '0', '-1', '31']) {
    const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-refresh-ttl-'));
    const envPath = join(tempDir, 'production.env');

    writeFileSync(envPath, completeProductionEnv({ REFRESH_TOKEN_TTL_DAYS: ttl }));

    try {
      const result = runPreflight([`--production-env-file=${envPath}`]);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /REFRESH_TOKEN_TTL_DAYS must be an integer from 1 to 30/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('fails when the compose runtime web API URL is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-missing-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: '',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL is missing or still contains a placeholder value/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL is not an approved HTTPS origin', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-local-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'http://localhost:3002',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must use https:\/\/ for production/);
    assert.match(result.stderr, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must not point at localhost for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL uses an unapproved hostname', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-attacker-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.attacker.example',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL is not origin-only', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-path-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie/v1',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must be an origin-only URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the compose runtime web API URL uses a non-canonical production origin', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-drift-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://edge.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('passes when the compose runtime web API URL matches the production env API URL', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-valid-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv());

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('passes when the compose runtime web API URL is supplied by the selected env file', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-runtime-api-env-file-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: '',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production preflight passed using /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when a required production value is absent from the selected env file even if the shell has it', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-env-file-authority-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=https://alerts.charitypilot.ie/hooks/charitypilot',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      READINESS_API_KEY: 'configured-readiness-key-from-parent-shell',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /READINESS_API_KEY is missing or still contains a placeholder value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL is missing or still contains a placeholder value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook is not an HTTPS public URL', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-local-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=http://localhost:3030/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use https:\/\/ for production/);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must not point at localhost for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook uses a reserved documentation hostname', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-reserved-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      ERROR_ALERT_WEBHOOK_URL: 'https://alerts.example/hooks/charitypilot',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook points at a private network', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-private-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=https://10.0.0.5/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook points at an IPv4-mapped private network', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-mapped-private-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=https://[::ffff:10.0.0.5]/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook points at reserved IPv6 space', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-reserved-ipv6-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=https://[2001:2::1]/alerts',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production error alert webhook has a malformed DNS hostname', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-alert-webhook-malformed-host-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=https://alert_webhook.example.com/hooks',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR_ALERT_WEBHOOK_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the detailed readiness key is missing from production config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-readiness-key-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /READINESS_API_KEY is missing or still contains a placeholder value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the detailed readiness key is too short for production config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-short-readiness-key-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'READINESS_API_KEY=short-readiness-key',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /READINESS_API_KEY must be at least 32 characters/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production secret keys are low entropy or sample values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-low-entropy-secrets-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      JWT_SECRET: 'a'.repeat(40),
      READINESS_API_KEY: 'configured-readiness-key-32-chars',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /JWT_SECRET must not be a repeated-character or sample value/);
    assert.match(result.stderr, /READINESS_API_KEY must not be a repeated-character or sample value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when NODE_ENV is not production', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-node-env-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=development',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /NODE_ENV must be production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production values are local, malformed, or test-mode', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-strict-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002abc',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://localhost:3003',
      'STRIPE_SECRET_KEY=sk_test_realisticSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://127.0.0.1:3002',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_realisticSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /PORT must be an integer from 1 to 65535/);
    assert.match(result.stderr, /DATABASE_URL must not point at localhost for production/);
    assert.match(
      result.stderr,
      /DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full for production/,
    );
    assert.match(result.stderr, /FRONTEND_URL must not point at localhost for production/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
    assert.match(result.stderr, /STRIPE_SECRET_KEY must use a live Stripe secret key/);
    assert.match(result.stderr, /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must use a live Stripe publishable key/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production database URL uses the Docker host gateway', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-docker-host-db-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      DATABASE_URL: 'postgresql://user:pass@host.docker.internal:5432/charitypilot?sslmode=require',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL must not point at localhost for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production frontend origins include non-canonical additional origins', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-multi-origin-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'TRUSTED_PROXY_ADDRESSES=10.0.0.10',
      'READINESS_API_KEY=configured-readiness-key-32-chars',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie, https://admin.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'ERROR_ALERT_WEBHOOK_URL=https://alerts.charitypilot.ie/hooks/charitypilot',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /FRONTEND_URL must use the canonical production web origin https:\/\/app\.charitypilot\.ie/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when public production URLs use unapproved hostnames', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-public-hosts-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://attacker.example',
      'AUTH_COOKIE_DOMAIN=.attacker.example',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.attacker.example',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /FRONTEND_URL must use an approved CharityPilot production hostname/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when the production email sender uses an unapproved domain', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-email-from-host-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv({ EMAIL_FROM: 'noreply@attacker.example' }));

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /EMAIL_FROM must use an approved CharityPilot sender domain for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production Supabase URL points at a private network', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-supabase-private-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeProductionEnv({ SUPABASE_URL: 'https://10.0.0.5' }));

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SUPABASE_URL must use a public, non-local URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production database URL omits TLS mode', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-db-tls-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full for production/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when public production URLs are not origin-only', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-origin-only-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie/login',
      'AUTH_COOKIE_DOMAIN=.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie/v1',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /FRONTEND_URL must be an origin-only URL for production/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must be an origin-only URL for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when split web and API production hosts omit a shared auth cookie domain', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-cookie-domain-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://app.charitypilot.ie',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /AUTH_COOKIE_DOMAIN must be set when FRONTEND_URL and NEXT_PUBLIC_API_URL use different hostnames/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when same-host production sets an invalid auth cookie domain', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-same-host-cookie-domain-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      FRONTEND_URL: 'https://charitypilot.ie',
      NEXT_PUBLIC_API_URL: 'https://charitypilot.ie',
      AUTH_COOKIE_DOMAIN: '.attacker.example',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /AUTH_COOKIE_DOMAIN must use an approved CharityPilot production hostname/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production tries to collapse web and API onto the apex same-host origin', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-same-host-no-cookie-domain-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    completeProductionEnv({
      FRONTEND_URL: 'https://charitypilot.ie',
      NEXT_PUBLIC_API_URL: 'https://charitypilot.ie',
      AUTH_COOKIE_DOMAIN: '',
    }),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`], {
      CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://charitypilot.ie',
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /FRONTEND_URL must use the canonical production web origin https:\/\/app\.charitypilot\.ie/,
    );
    assert.match(
      result.stderr,
      /NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/,
    );
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL must use the canonical production API origin https:\/\/api\.charitypilot\.ie/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails when production URLs point at bracketed IPv6 localhost', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-ipv6-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(
    envPath,
    [
      'NODE_ENV=production',
      'PORT=3002',
      'DATABASE_URL=postgresql://user:pass@[::1]:5432/charitypilot?sslmode=require',
      `JWT_SECRET=${'a'.repeat(40)}`,
      'FRONTEND_URL=https://[::1]:3003',
      'STRIPE_SECRET_KEY=sk_live_configuredSecret',
      'STRIPE_WEBHOOK_SECRET=whsec_configuredSecret',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_essentialsMonthly',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_essentialsYearly',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_completeMonthly',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID=price_completeYearly',
      'RESEND_API_KEY=re_configuredSecret',
      'EMAIL_FROM=noreply@charitypilot.ie',
      'SUPABASE_URL=https://configured-project.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
      'SUPABASE_STORAGE_BUCKET=documents',
      'NEXT_PUBLIC_API_URL=https://[::1]:3002',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_configuredSecret',
      '',
    ].join('\n'),
  );

  try {
    const result = runPreflight([`--production-env-file=${envPath}`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL must not point at localhost for production/);
    assert.match(result.stderr, /FRONTEND_URL must not point at localhost for production/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must not point at localhost for production/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production API scripts run built entrypoints without local env-file dependencies', () => {
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));

  assert.equal(apiPackage.scripts.start, 'node dist/start.js');
  assert.equal(apiPackage.scripts['db:migrate:deploy'], 'prisma migrate deploy');
  assert.equal(apiPackage.scripts['jobs:production-scheduler'], 'node dist/jobs/production-scheduler.js');
  assert.equal(apiPackage.scripts['jobs:deadline-reminders'], 'node dist/jobs/send-deadline-reminders.js');
  assert.equal(apiPackage.scripts['jobs:document-storage-cleanup'], 'node dist/jobs/cleanup-document-storage.js');
  assert.doesNotMatch(apiPackage.scripts.start, /--env-file|tsx|src\//);
  assert.doesNotMatch(apiPackage.scripts['jobs:production-scheduler'], /--env-file|tsx|src\//);
  assert.doesNotMatch(apiPackage.scripts['jobs:deadline-reminders'], /--env-file|tsx|src\//);
  assert.doesNotMatch(apiPackage.scripts['jobs:document-storage-cleanup'], /--env-file|tsx|src\//);
});

test('workspaces with source tests expose a test script for the root test gate', () => {
  const orphanedTestWorkspaces = workspacePackageDirs()
    .filter((workspaceDir) => workspaceHasSourceTests(workspaceDir))
    .filter((workspaceDir) => {
      const packageJson = JSON.parse(readRepoFile(join(workspaceDir, 'package.json')));
      return typeof packageJson.scripts?.test !== 'string' || !packageJson.scripts.test.trim();
    });

  assert.deepEqual(
    orphanedTestWorkspaces,
    [],
    `Workspaces with src/tests/*.test files must define package scripts.test: ${orphanedTestWorkspaces.join(', ')}`,
  );
});

test('package test scripts stay compatible with the Node 22 production runtime', () => {
  const packageJsonPaths = [
    'package.json',
    ...workspacePackageDirs().map((workspaceDir) => join(workspaceDir, 'package.json')),
  ];
  const incompatibleScripts = [];

  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = JSON.parse(readRepoFile(packageJsonPath));
    for (const [scriptName, scriptCommand] of Object.entries(packageJson.scripts ?? {})) {
      if (typeof scriptCommand === 'string' && scriptCommand.includes('--test-isolation=')) {
        incompatibleScripts.push(`${packageJsonPath}:${scriptName}`);
      }
    }
  }

  assert.deepEqual(
    incompatibleScripts,
    [],
    `Node 22 rejects --test-isolation in package scripts: ${incompatibleScripts.join(', ')}`,
  );
});

test('web test discovery cannot be shell-expanded from stale compiled output', () => {
  const webPackage = JSON.parse(readRepoFile('apps/web/package.json'));
  const testScript = webPackage.scripts?.test;

  assert.equal(typeof testScript, 'string');
  assert.match(testScript, /rmSync\('\.test-dist'/);
  assert.match(testScript, /tsc -p tsconfig\.test\.json/);
  assert.match(testScript, /--test ["']\.test-dist\/\*\*\/\*\.test\.js["']/);
  assert.doesNotMatch(testScript, /--test \.test-dist\/\*\*\/\*\.test\.js(?:\s|$)/);
});

test('release readiness command uses ASCII-safe operator output', () => {
  const releaseReady = readRepoFile('scripts/release-ready.mjs');

  assert.doesNotMatch(releaseReady, /[^\x00-\x7F]/);
  assert.doesNotMatch(releaseReady, /[\u2705\u274C\u2796]/u);
  assert.doesNotMatch(releaseReady, /\u00E2/u);
  assert.match(releaseReady, /-- \$\{name\} --/);
  assert.match(releaseReady, /PASS/);
  assert.match(releaseReady, /FAIL/);
  assert.match(releaseReady, /SKIP/);
});

test('release readiness command distinguishes skipped gates from full readiness', () => {
  const releaseReady = readRepoFile('scripts/release-ready.mjs');

  assert.match(releaseReady, /allowedArgs = new Set\(\[['"]--no-e2e['"], ['"]--no-build['"]\]\)/);
  assert.match(releaseReady, /Unknown option: \$\{arg\}/);
  assert.match(releaseReady, /Usage: npm run release:ready -- \[--no-e2e\] \[--no-build\]/);
  assert.match(releaseReady, /process\.exit\(2\)/);
  assert.match(releaseReady, /skipped > 0/);
  assert.match(releaseReady, /GREEN - selected gates passed; skipped gates remain/);
  assert.match(releaseReady, /GREEN - repository release gates passed/);
  assert.doesNotMatch(releaseReady, /platform is release-ready/);
  assert.doesNotMatch(releaseReady, /failed\.length === 0 \? 'GREEN - platform is release-ready'/);
});

test('release readiness delegates stack ownership to the isolated E2E runner', () => {
  const releaseReady = readRepoFile('scripts/release-ready.mjs');

  assert.match(releaseReady, /managedLocalE2eEnvironment\(timeoutMs\)/);
  assert.match(releaseReady, /env\.E2E_EXECUTION_MODE = 'local-disposable'/);
  assert.match(releaseReady, /env\.E2E_MANAGED_LOCAL_RUNNER = 'true'/);
  assert.match(releaseReady, /env\.E2E_RELEASE_READY = 'true'/);
  assert.match(releaseReady, /'E2E_GATEWAY_IMAGE'/);
  assert.match(releaseReady, /replaceEnv:\s*true/);
  assert.doesNotMatch(releaseReady, /compose\.yml -f compose\.local\.yml/);
  assert.doesNotMatch(releaseReady, /Stack not reachable/);
});

test('release readiness child gates have finite process timeouts', () => {
  const releaseReady = readRepoFile('scripts/release-ready.mjs');

  assert.match(
    releaseReady,
    /RELEASE_READY_GATE_TIMEOUT_MS = positiveIntEnv\('RELEASE_READY_GATE_TIMEOUT_MS', 900000\)/,
  );
  assert.match(
    releaseReady,
    /RELEASE_READY_E2E_TIMEOUT_MS = positiveIntEnv\('RELEASE_READY_E2E_TIMEOUT_MS', 2400000\)/,
  );
  assert.match(releaseReady, /timeout: opts\.timeoutMs \?\? RELEASE_READY_GATE_TIMEOUT_MS/);
  assert.match(releaseReady, /res\.error\?\.code === 'ETIMEDOUT'/);
  assert.match(releaseReady, /cleanupProcessTree\(res\.pid\)/);
  assert.match(releaseReady, /function resolveGateCommand/);
  assert.match(releaseReady, /process\.env\.npm_execpath/);
  assert.match(releaseReady, /npx-cli\.js/);
  assert.doesNotMatch(releaseReady, /shell:\s*true/);
  assert.match(releaseReady, /taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/);
  assert.match(releaseReady, /Gate timed out after \$\{\(timeoutMs \/ 1000\)\.toFixed\(0\)\}s/);
  assert.match(releaseReady, /timeoutMs:\s*RELEASE_READY_E2E_TIMEOUT_MS \+ 1800000/);
  assert.match(releaseReady, /managedLocalE2eEnvironment\(RELEASE_READY_E2E_TIMEOUT_MS\)/);
});

test('release readiness cleanup is scoped to the spawned child tree on timeout', () => {
  const releaseReady = readRepoFile('scripts/release-ready.mjs');
  const isolatedRunner = readRepoFile('scripts/run-isolated-e2e.mjs');

  assert.match(releaseReady, /delete env\[key\]/);
  assert.match(releaseReady, /'E2E_REMOTE_DATABASE_RESET_OVERRIDE'/);
  assert.doesNotMatch(releaseReady, /E2E_ALLOW_LOCAL_DB_RESET:\s*'true'/);
  assert.match(releaseReady, /cleanupProcessTree\(res\.pid\)/);
  assert.doesNotMatch(releaseReady, /cleanupRepoPlaywrightProcesses/);
  assert.doesNotMatch(releaseReady, /Get-CimInstance Win32_Process|Stop-Process/);
  assert.doesNotMatch(releaseReady, /ParentProcessId|repoMatchedProcessIds/);
  assert.match(isolatedRunner, /function checkedWindowsTaskkill/);
  assert.match(isolatedRunner, /function isExactPosixChildGroupAbsent/);
  assert.match(isolatedRunner, /function stopAndWaitForExactChildTree/);
  assert.match(
    isolatedRunner,
    /remote-disposable E2E is forbidden on native Windows until the runner has a Job Object-backed exact process-tree lifetime primitive/,
  );
  const remoteWindowsGuard =
    isolatedRunner.match(
      /if \(env\.E2E_EXECUTION_MODE === ["']remote-disposable["']\)[\s\S]*?return await runRemoteDisposable/,
    )?.[0] ?? '';
  assert.match(remoteWindowsGuard, /if \(process\.platform === ["']win32["']\)/);
  assert.doesNotMatch(remoteWindowsGuard, /options\.platform/);
  assert.match(isolatedRunner, /remoteAuthorized && exactTreeAbsenceProven/);
  assert.doesNotMatch(isolatedRunner, /scheduleExactTreeKillEscalation/);
  assert.match(isolatedRunner, /daemonComposeInvocation/);
  assert.match(isolatedRunner, /cleanupStarted/);
  assert.match(isolatedRunner, /process\.on\(["']SIGINT["']/);
  assert.match(isolatedRunner, /process\.on\(["']SIGTERM["']/);
});

test('reliability report emits ASCII-safe operator output', () => {
  const result = spawnSync(process.execPath, ['scripts/reliability-report.mjs', '--no-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /[^\x00-\x7F]/);
  assert.match(result.stdout, /covered : \d+/);
  assert.match(result.stdout, /--no-run/);
});

test('reliability report distinguishes static E2E linkage from executed evidence', () => {
  const source = readRepoFile('scripts/reliability-report.mjs');

  assert.match(source, /EXECUTED E2E: NOT VERIFIED BY THIS COMMAND/);
  assert.match(source, /LINKAGE CHECK:.*COMPLETE.*INCOMPLETE/);
  assert.match(source, /not executed by this command/);
  assert.doesNotMatch(source, /OVERALL:\s*\$\{[^}]*GREEN/);
  assert.doesNotMatch(source, /Overall:\s*\$\{[^}]*GREEN/);
});

test('release image promotion requires the reusable managed E2E gate before write authority', () => {
  const e2e = readRepoFile('.github/workflows/e2e.yml');
  const release = readRepoFile('.github/workflows/release-images.yml');
  const workflowPermissions = release.slice(
    release.indexOf('permissions:'),
    release.indexOf('concurrency:'),
  );
  const e2eJob = release.slice(release.indexOf('  e2e:'), release.indexOf('  publish:'));
  const publishJob = release.slice(release.indexOf('  publish:'));

  assert.match(e2e, /on:\s*[\s\S]*workflow_call:/);
  assert.match(e2eJob, /uses:\s+\.\/\.github\/workflows\/e2e\.yml/);
  assert.match(e2eJob, /permissions:\s*[\s\S]*contents:\s+read/);
  assert.doesNotMatch(e2eJob, /packages:\s+write|id-token:\s+write/);
  assert.match(publishJob, /needs:\s+e2e/);
  assert.match(publishJob, /permissions:\s*[\s\S]*packages:\s+write[\s\S]*id-token:\s+write/);
  assert.doesNotMatch(workflowPermissions, /packages:\s+write|id-token:\s+write/);
});

test('reliability report rejects unknown options before reporting', () => {
  const result = spawnSync(process.execPath, ['scripts/reliability-report.mjs', '--no-run', '--surprise'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option: --surprise/);
  assert.match(result.stderr, /Usage: node scripts\/reliability-report\.mjs/);
  assert.equal(result.stdout, '');
});

test('reliability report removes stale compiled tests before collecting proof', () => {
  const source = readRepoFile('scripts/reliability-report.mjs');
  assert.match(source, /rmSync\(join\(API_DIR, 'dist', 'tests'\), \{ recursive: true, force: true \}\)/);
  assert.match(source, /rmSync\(join\(WEB_DIR, '\.test-dist'\), \{ recursive: true, force: true \}\)/);
  assert.ok(
    source.indexOf("rmSync(join(API_DIR, 'dist', 'tests')") < source.indexOf("compile(API_DIR, 'tsconfig.json')"),
  );
  assert.ok(
    source.indexOf("rmSync(join(WEB_DIR, '.test-dist')") < source.indexOf("compile(WEB_DIR, 'tsconfig.test.json')"),
  );
});

test('production todo reflects current launch blockers without overclaiming local browser smoke', () => {
  const productionTodo = readRepoFile('PRODUCTION_TODO.md');
  const selectedGateCommit = currentAuditSelectedGateCommit();

  assert.match(productionTodo, /Current local status checked 2026-07-11/);
  assert.match(productionTodo, /9 of 26 production values are complete/);
  assert.match(
    productionTodo,
    /9 of 26 production values are complete[\s\S]*17[\s\S]*production values still require real data/,
  );
  assert.match(
    productionTodo,
    /launch evidence ledger is now 9 of 86 checks\s+>\s+complete from local\/CI release-gate evidence/s,
  );
  assert.match(productionTodo, /final signoffs remain 0 of 5\s+>\s+approved/s);
  assert.match(productionTodo, /`approvedForLaunch` is false/);
  assert.match(productionTodo, /Local browser QA has current 2026-07-09 evidence/);
  assert.match(productionTodo, /public desktop 14\/14/);
  assert.match(productionTodo, /public mobile 14\/14/);
  assert.match(productionTodo, /dashboard desktop 12\/12/);
  assert.match(productionTodo, /dashboard mobile 12\/12/);
  assert.match(productionTodo, /full local accessibility suite passed 26\/26 checks on 2026-07-09/i);
  assert.match(productionTodo, /including `\/about` and both light and dark themes/i);
  assert.doesNotMatch(
    productionTodo,
    /prior full local accessibility suite passed 25\/25 checks before `\/about` was added/i,
  );
  assert.doesNotMatch(productionTodo, /full accessibility suite must be rerun for the final release transcript/i);
  assert.match(productionTodo, /deployed production QA still remains open/i);
  assert.match(productionTodo, /browserQa\.checks\.browser-qa-completed/);
  assert.match(productionTodo, /npm run check:production:browser-qa-env/);
  assert.match(productionTodo, /Deployed browser QA environment preflight passed/);
  assert.match(productionTodo, /86 machine-readable launch evidence checks/);
  assert.match(productionTodo, /Missing production values are grouped by provider\/source/);
  assert.match(productionTodo, /release\s+image promotion/i);
  assert.match(productionTodo, /browserQa\.checks\.accessibility-coverage/);
  assert.match(productionTodo, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(productionTodo, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(productionTodo, /local `npm run release:ready` run passed on 2026-07-09/);
  assert.match(productionTodo, /95 Playwright E2E tests passed/);
  assert.match(productionTodo, /GREEN - repository release gates passed/);
  assert.match(productionTodo, /scopes failed Playwright cleanup to CharityPilot processes on Windows/);
  assert.match(productionTodo, /runs npm\/npx child gates without shell execution/);
  assert.doesNotMatch(productionTodo, /only Playwright E2E was skipped/);
  assert.match(productionTodo, new RegExp(`commit\\s+[\r\n>\\s]*\`${escapeRegExp(selectedGateCommit)}\``));
  assert.match(productionTodo, /352\/352 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /351\/351 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /349\/349 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /346\/346 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /345\/345 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /340\/340 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /338\/338 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /333\/333 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /332\/332 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /331\/331 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /330\/330 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /322\/322 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /321\/321 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /320\/320 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /319\/319 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /318\/318 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /317\/317 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /316\/316 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /315\/315 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /313\/313 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /312\/312 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /311\/311 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /304\/304 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /300\/300 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /299\/299 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /298\/298 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /297\/297 production-tooling checks/);
  assert.doesNotMatch(productionTodo, /286\/286 production-tooling checks/);
  assert.match(productionTodo, /Rerun every release gate on the final release ref/);
  assert.match(productionTodo, /commit SHA, workflow run, and digest manifest/);
  assert.doesNotMatch(productionTodo, /Latest local selected-gate check/);
  assert.doesNotMatch(productionTodo, /at `[0-9a-f]{7,40}`/);
  assert.doesNotMatch(productionTodo, /--no-build --no-e2e/);
  assert.doesNotMatch(productionTodo, /full Docker stack smoke all pass/i);
  assert.doesNotMatch(productionTodo, /Everything verifiable without external accounts now passes/i);
});

test('agent continuation handoff reflects current launch evidence progress without stale zero counters', () => {
  const handoff = readRepoFile('docs/agent-continuation-handoff.md');
  const selectedGateCommit = currentAuditSelectedGateCommit();

  assert.match(handoff, /Known current state from `npm run launch:status -- --json` on \d{4}-\d{2}-\d{2}/);
  assert.match(handoff, /Machine-readable launch evidence completion: `9 \/ 86`/);
  assert.match(handoff, /The evidence ledger is currently `9 \/ 86`/);
  assert.match(handoff, /77 \/ 86` machine-readable launch checks remain/);
  assert.match(handoff, /releaseGate\.check-production/);
  assert.match(handoff, /releaseGate\.github-environment/);
  assert.match(handoff, /releaseGate\.github-secret-store/);
  assert.match(handoff, /releaseGate\.deploy-preflight/);
  assert.match(handoff, /GitHub production environment/);
  assert.match(handoff, /check:production:github-secrets -- --environment=production/);
  assert.match(handoff, /required GitHub `production` secret names without reading secret/);
  assert.match(handoff, /Most recent local production-tooling gate[\s\S]{0,180}548\s*\/\s*548`? checks/);
  assert.doesNotMatch(handoff, /351\s*\/\s*351`? checks/);
  assert.doesNotMatch(handoff, /349\s*\/\s*349`? checks/);
  assert.doesNotMatch(handoff, /346\s*\/\s*346`? checks/);
  assert.doesNotMatch(handoff, /345\s*\/\s*345`? checks/);
  assert.match(
    handoff,
    /Older `546 \/ 546`, `545 \/ 545`, `544 \/ 544`, `494 \/ 494`, `488 \/ 488`, `396 \/ 396`, `352 \/ 352`,[\s\S]{0,80}`338 \/ 338`, and `339 \/ 339` entries[\s\S]{0,180}historical/,
  );
  assert.match(
    handoff,
    /GitHub `production` environment secrets currently include[\s\S]{0,160}`JWT_SECRET` and `READINESS_API_KEY`/,
  );
  assert.match(handoff, /still fails with six[\s\S]{0,240}`DATABASE_URL`[\s\S]{0,240}`ERROR_ALERT_WEBHOOK_URL`/);
  assert.doesNotMatch(handoff, /GitHub `production` environment secrets list is currently empty/);
  assert.match(handoff, /Re-run launch status/);
  assert.match(handoff, new RegExp(`commit \`${escapeRegExp(selectedGateCommit)}\``));
  assert.match(handoff, /isolated restore target/);
  assert.match(handoff, /non-production restore target/);
  assert.match(handoff, /production project was not overwritten/);
  assert.match(handoff, /352 \/ 352/);
  assert.match(handoff, /352\/352 production-tooling checks/);
  assert.doesNotMatch(handoff, /351\/351 production-tooling checks/);
  assert.match(handoff, /338\/338 production-tooling checks/);
  assert.doesNotMatch(handoff, /333\/333 production-tooling checks/);
  assert.doesNotMatch(handoff, /332\/332 production-tooling checks/);
  assert.doesNotMatch(handoff, /331\/331 production-tooling checks/);
  assert.match(handoff, /`npm run release:ready`/);
  assert.match(handoff, /95 Playwright E2E tests passed/);
  assert.doesNotMatch(handoff, /only Playwright E2E was skipped/);
  assert.match(handoff, /cb78eb85bb0127150ad448037b5d03b8060869bf/);
  assert.match(handoff, /29021018683/);
  assert.match(handoff, /Latest verified release-gate hardening commit captured by this handoff/);
  assert.match(handoff, /repositoryState\.headSha/);
  assert.match(handoff, /repo-scoped failed E2E cleanup hardening/);
  assert.match(handoff, /no-shell release gate execution hardening/);
  assert.doesNotMatch(handoff, /Latest verified pushed commit at the time of this handoff refresh/);
  assert.doesNotMatch(handoff, /Latest verified pushed commit[\s\S]{0,120}0d2988772504b73189d8ce9c500d92800d1de92f/);
  assert.doesNotMatch(handoff, /73eda7ddaeaa8d6fdbe273cd541296b90dbe8049/);
  assert.doesNotMatch(handoff, /29007934895/);
  assert.doesNotMatch(handoff, /a4c110fc0cbd6bbdd318cd5b94ef94207514e0f1/);
  assert.doesNotMatch(handoff, /29002966630/);
  assert.doesNotMatch(handoff, /Latest verified pushed commit[\s\S]{0,120}7c182f3379568765387772b382c4d596105a839a/);
  assert.doesNotMatch(handoff, /322\/322 production-tooling checks/);
  assert.doesNotMatch(handoff, /321\/321 production-tooling checks/);
  assert.doesNotMatch(handoff, /320\/320 production-tooling checks/);
  assert.doesNotMatch(handoff, /319\/319 production-tooling checks/);
  assert.doesNotMatch(handoff, /318\/318 production-tooling checks/);
  assert.doesNotMatch(handoff, /317\/317 production-tooling checks/);
  assert.doesNotMatch(handoff, /316\/316 production-tooling checks/);
  assert.doesNotMatch(handoff, /315\/315 production-tooling checks/);
  assert.doesNotMatch(handoff, /Machine-readable launch evidence completion: `0 \/ 86`/);
  assert.doesNotMatch(handoff, /The evidence ledger is still `0 \/ 86`/);
  assert.doesNotMatch(handoff, /86 \/ 86` machine-readable launch checks remain/);
  assert.doesNotMatch(handoff, /313\/313 production-tooling checks/);
  assert.doesNotMatch(handoff, /restore-test ownership/);
});

test('production secret env files are ignored by git without hiding the template', () => {
  const gitignoreLines = readRepoFile('.gitignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  for (const pattern of ['.env.production', '.env.production.*']) {
    assert.ok(gitignoreLines.includes(pattern), `${pattern} must be ignored`);
  }

  assert.ok(gitignoreLines.includes('!.env.production.example'), '.env.production.example must remain visible');
  assert.ok(
    gitignoreLines.includes('production-launch-evidence*.json'),
    'machine-readable production launch evidence must stay outside git',
  );
});

test('production env template exposes only the API origin to the web runtime', () => {
  const template = readRepoFile('.env.production.example');
  const generator = readRepoFile('scripts/generate-production-env.mjs');

  assert.match(template, /NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie/);
  assert.match(template, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie/);
  assert.match(template, /SUPABASE_URL=https:\/\/REPLACE_ME_SUPABASE_PROJECT_REF\.supabase\.co/);
  assert.match(template, /must match `NEXT_PUBLIC_API_URL`/);
  assert.doesNotMatch(template, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(
    template,
    /CHARITYPILOT_API_IMAGE=ghcr\.io\/jasperfordesq-ai\/charity-governance-api@sha256:REPLACE_ME_API_IMAGE_DIGEST/,
  );
  assert.match(
    template,
    /CHARITYPILOT_WEB_IMAGE=ghcr\.io\/jasperfordesq-ai\/charity-governance-web@sha256:REPLACE_ME_WEB_IMAGE_DIGEST/,
  );
  assert.match(
    template,
    /CHARITYPILOT_MIGRATION_IMAGE=ghcr\.io\/jasperfordesq-ai\/charity-governance-migrations@sha256:REPLACE_ME_MIGRATION_IMAGE_DIGEST/,
  );
  assert.match(template, /CHARITYPILOT_DATABASE_COMPATIBILITY=p006-deadline-calendar-v1/);
  assert.match(template, /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie/);
  assert.match(template, /Docker Compose/);
  assert.match(generator, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL/);
  assert.doesNotMatch(generator, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(generator, /CHARITYPILOT_API_IMAGE/);
  assert.match(generator, /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL/);
});

test('production TLS defaults use the canonical app and API hostnames', () => {
  const template = readRepoFile('.env.production.example');
  const tlsOverlay = readRepoFile('compose.production-tls.yml');

  assert.match(template, /^CHARITYPILOT_WEB_DOMAIN=app\.charitypilot\.ie$/m);
  assert.match(template, /^CHARITYPILOT_API_DOMAIN=api\.charitypilot\.ie$/m);
  assert.match(tlsOverlay, /CHARITYPILOT_WEB_DOMAIN: \$\{CHARITYPILOT_WEB_DOMAIN:-app\.charitypilot\.ie\}/);
  assert.match(tlsOverlay, /CHARITYPILOT_API_DOMAIN: \$\{CHARITYPILOT_API_DOMAIN:-api\.charitypilot\.ie\}/);
});

test('Docker build context excludes generated caches and build metadata', () => {
  const dockerignore = readRepoFile('.dockerignore');

  for (const pattern of [
    '.turbo',
    '**/.turbo',
    '**/*.tsbuildinfo',
    '.test-dist',
    '**/.test-dist',
    '.next-build*',
    '**/.next-build*',
    'next-codex-build',
    '**/next-codex-build',
    '.charitypilot-backups',
    '.codex-*',
    '**/.codex-*',
    '**/.env',
    '**/.env.*',
    'coverage',
    '**/coverage',
    'out',
    '**/out',
    'test-results',
    '**/test-results',
    'playwright-report',
    '**/playwright-report',
    '.nyc_output',
    '**/.nyc_output',
  ]) {
    assert.match(dockerignore, new RegExp(`(^|\\n)${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`));
  }
});

test('API Docker image documents the production runtime port and non-root user', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));

  assertDockerfileUsesDigestPinnedNodeBase(dockerfile, 'apps/api/Dockerfile');
  assert.match(dockerfile, /FROM deps AS build[\s\S]*ARG\s+DATABASE_URL=/);
  assert.match(
    dockerfile,
    /FROM deps AS build[\s\S]*ENV\s+DATABASE_URL=\$DATABASE_URL[\s\S]*RUN\s+npm run db:generate -w @charitypilot\/api/,
  );
  assert.match(dockerfile, /FROM\s+node:22-alpine@sha256:[a-f0-9]{64}\s+AS runtime-deps/);
  assert.match(
    dockerfile,
    /npm ci --omit=dev --omit=peer --workspace @charitypilot\/api --workspace @charitypilot\/shared --include-workspace-root=false/,
  );
  assert.match(dockerfile, /rm -rf[\s\S]*node_modules\/prisma[\s\S]*node_modules\/typescript/);
  assert.match(
    dockerfile,
    /COPY --chown=node:node --from=build \/app\/node_modules\/\.prisma \.\/node_modules\/\.prisma/,
  );
  assert.match(dockerfile, /ENV\s+NODE_ENV=production/);
  assert.match(dockerfile, /ENV\s+PORT=3002/);
  assert.match(dockerfile, /EXPOSE\s+3002/);
  assert.match(dockerfile, /USER\s+node/);
  assert.match(dockerfile, /CMD\s+\["node",\s*"dist\/start\.js"\]/);
  assert.match(dockerfile, /COPY --chown=node:node --from=runtime-deps \/app\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node --from=build \/app\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /CMD[\s\S]*migrate deploy/);
  assert.equal(apiPackage.dependencies['pino-pretty'], undefined);
  assert.equal(apiPackage.devDependencies['pino-pretty'], '^13.0.0');

  const runnerStage = dockerfileStage(dockerfile, 'runner');
  assert.doesNotMatch(runnerStage, /DATABASE_URL/);
});

test('API Docker runtime ships only compiled app artifacts', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');
  const runnerStage = dockerfileStage(dockerfile, 'runner');

  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/apps\/api\/package\.json \.\/apps\/api\/package\.json/,
  );
  assert.match(runnerStage, /COPY --chown=node:node --from=build \/app\/apps\/api\/dist \.\/apps\/api\/dist/);
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/packages\/shared\/package\.json \.\/packages\/shared\/package\.json/,
  );
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/packages\/shared\/dist \.\/packages\/shared\/dist/,
  );
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/node_modules\/\.prisma \.\/node_modules\/\.prisma/,
  );
  assert.doesNotMatch(runnerStage, /COPY --chown=node:node --from=build \/app\/apps\/api \.\/apps\/api/);
  assert.doesNotMatch(runnerStage, /COPY --chown=node:node --from=build \/app\/packages\/shared \.\/packages\/shared/);
  assert.doesNotMatch(runnerStage, /apps\/api\/src/);
  assert.doesNotMatch(runnerStage, /apps\/api\/prisma/);
});

test('Prisma CLI and client versions are pinned together for production migrations', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));
  const migrationRunnerPackage = JSON.parse(readRepoFile('apps/api/prisma/migration-runner/package.json'));
  const migrationRunnerLock = JSON.parse(readRepoFile('apps/api/prisma/migration-runner/package-lock.json'));
  const lockPrisma = packageLockPackage('node_modules/prisma');
  const lockPrismaClient = packageLockPackage('node_modules/@prisma/client');
  const lockApiPackage = packageLockPackage('apps/api');

  assert.ok(lockPrisma?.version, 'package-lock must include prisma');
  assert.equal(lockPrismaClient?.version, lockPrisma.version);
  assert.equal(apiPackage.dependencies['@prisma/client'], lockPrisma.version);
  assert.equal(apiPackage.devDependencies.prisma, lockPrisma.version);
  assert.equal(lockApiPackage.dependencies['@prisma/client'], lockPrisma.version);
  assert.equal(lockApiPackage.devDependencies.prisma, lockPrisma.version);
  assert.equal(migrationRunnerPackage.dependencies.prisma, lockPrisma.version);
  assert.equal(migrationRunnerLock.packages[''].dependencies.prisma, lockPrisma.version);
  assert.equal(migrationRunnerLock.packages['node_modules/prisma'].version, lockPrisma.version);
  assert.match(
    dockerfile,
    /FROM\s+node:22-alpine@sha256:[a-f0-9]{64}\s+AS migration-deps[\s\S]*npm ci --omit=dev --omit=peer --no-audit --no-fund/,
  );
});

test('API Prisma configuration avoids deprecated package.json config', () => {
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));
  const prismaConfig = readRepoFile('apps/api/prisma.config.ts');
  const localMigrationScript = readRepoFile('scripts/migrate-local-docker.mjs');

  assert.equal(apiPackage.prisma, undefined);
  assert.match(prismaConfig, /import\s+\{\s*defineConfig\s*\}\s+from\s+'prisma\/config'/);
  assert.match(prismaConfig, /export\s+default\s+defineConfig\(\{/);
  assert.match(prismaConfig, /schema:\s*'prisma\/schema\.prisma'/);
  assert.match(prismaConfig, /migrations:\s*\{[\s\S]*seed:\s*'tsx prisma\/seed\.ts'/);
  assert.match(localMigrationScript, /--config', 'apps\/api\/prisma\.config\.ts'/);
  assert.doesNotMatch(localMigrationScript, /package\.json#prisma/);
});

test('migration runner package lock supports the production Docker npm ci command', () => {
  const npmArgs = ['ci', '--omit=dev', '--omit=peer', '--no-audit', '--no-fund', '--dry-run'];
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
  const npmCommandArgs =
    process.platform === 'win32'
      ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...npmArgs]
      : npmArgs;
  const result = spawnSync(npmCommand, npmCommandArgs, {
    cwd: join(repoRoot, 'apps/api/prisma/migration-runner'),
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    [
      'migration runner package-lock.json must stay in sync with package.json for the Docker migration-deps stage.',
      result.error ? String(result.error) : '',
      result.stdout,
      result.stderr,
    ].join('\n'),
  );
});

test('API Dockerfile includes a dedicated Prisma migration runner target', () => {
  const dockerfile = readRepoFile('apps/api/Dockerfile');
  const migrationDepsStage = dockerfileStage(dockerfile, 'migration-deps');
  const migrationRunnerStage = dockerfileStage(dockerfile, 'migration-runner');

  assert.match(migrationDepsStage, /^FROM\s+node:22-alpine@sha256:[a-f0-9]{64}\s+AS migration-deps/);
  assert.match(migrationDepsStage, /COPY apps\/api\/prisma\/migration-runner\/package\.json \.\/package\.json/);
  assert.match(
    migrationDepsStage,
    /COPY apps\/api\/prisma\/migration-runner\/package-lock\.json \.\/package-lock\.json/,
  );
  assert.match(migrationDepsStage, /RUN npm ci --omit=dev --omit=peer --no-audit --no-fund/);
  assert.doesNotMatch(migrationDepsStage, /npm install/);
  assert.doesNotMatch(migrationDepsStage, /npm init/);

  assert.match(migrationRunnerStage, /^FROM\s+node:22-alpine@sha256:[a-f0-9]{64}\s+AS migration-runner/);
  assert.match(
    migrationRunnerStage,
    /COPY --chown=node:node --from=migration-deps \/app\/apps\/api\/node_modules \.\/node_modules/,
  );
  assert.match(
    migrationRunnerStage,
    /COPY --chown=node:node --from=migration-deps \/app\/apps\/api\/package\.json \.\/package\.json/,
  );
  assert.match(
    migrationRunnerStage,
    /COPY --chown=node:node --from=migration-deps \/app\/apps\/api\/package-lock\.json \.\/package-lock\.json/,
  );
  assert.match(
    migrationRunnerStage,
    /COPY --chown=node:node apps\/api\/prisma\/schema\.prisma \.\/prisma\/schema\.prisma/,
  );
  assert.match(migrationRunnerStage, /COPY --chown=node:node apps\/api\/prisma\/migrations \.\/prisma\/migrations/);
  assert.match(migrationRunnerStage, /WORKDIR \/app\/apps\/api/);
  assert.match(migrationRunnerStage, /USER node/);
  assert.match(dockerfile, /ENTRYPOINT\s+\["\.\/node_modules\/\.bin\/prisma"\]/);
  assert.match(dockerfile, /CMD\s+\["migrate",\s*"deploy",\s*"--schema",\s*"prisma\/schema\.prisma"\]/);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node apps\/api\/prisma \.\/apps\/api\/prisma/);

  const migrationRunnerStart = dockerfile.indexOf('FROM deps AS migration-runner');
  assert.equal(migrationRunnerStart, -1);
  assert.doesNotMatch(migrationRunnerStage, /dist\/start\.js/);
  assert.doesNotMatch(migrationRunnerStage, /apps\/web/);
  assert.doesNotMatch(migrationRunnerStage, /packages\/shared/);
  assert.doesNotMatch(migrationRunnerStage, /COPY[^\n]+\sapps\/api\/package\.json\b/);
  assert.doesNotMatch(migrationRunnerStage, /seed\.ts/);
  assert.doesNotMatch(migrationRunnerStage, /npm install/);
  assert.doesNotMatch(migrationRunnerStage, /npm init/);
});

test('production Docker compose isolates maintenance migrations and keeps web away from secrets', () => {
  const productionComposePath = join(repoRoot, 'compose.production.yml');
  assert.equal(existsSync(productionComposePath), true, 'compose.production.yml must exist');

  const compose = readRepoFile('compose.production.yml');

  assert.match(compose, /\nservices:\s*\n\s+migrate:/);
  assert.match(compose, /\n\s+api:/);
  assert.match(compose, /\n\s+web:/);
  assert.match(compose, /\n\s+production-scheduler:/);
  assert.match(compose, /\n\s+deadline-reminders:/);
  assert.match(compose, /\n\s+document-storage-cleanup:/);
  assert.doesNotMatch(compose, /\n\s+db:/);
  assert.doesNotMatch(compose, /\n\s+build:/);
  assert.doesNotMatch(compose, /node:22/);
  assert.doesNotMatch(compose, /\n\s+volumes:/);
  assert.doesNotMatch(compose, /:\s*\/app\b/);

  const migrate = composeServiceBlock(compose, 'migrate');
  const api = composeServiceBlock(compose, 'api');
  const web = composeServiceBlock(compose, 'web');
  const productionScheduler = composeServiceBlock(compose, 'production-scheduler');
  const productionSchedulerSource = readRepoFile('apps/api/src/jobs/production-scheduler.ts');
  const deadlineReminders = composeServiceBlock(compose, 'deadline-reminders');
  const documentStorageCleanup = composeServiceBlock(compose, 'document-storage-cleanup');

  assert.match(migrate, /image:\s+\$\{CHARITYPILOT_MIGRATION_IMAGE:\?Set CHARITYPILOT_MIGRATION_IMAGE\}/);
  assert.doesNotMatch(migrate, /env_file:/);
  assert.match(migrate, /environment:[\s\S]*NODE_ENV:\s+production/);
  assert.match(migrate, /DATABASE_URL:\s+\$\{DATABASE_URL:\?Set DATABASE_URL\}/);
  assert.match(migrate, /command:\s+\["migrate",\s*"deploy",\s*"--schema",\s*"prisma\/schema\.prisma"\]/);
  assert.match(migrate, /restart:\s+"no"/);
  assert.match(migrate, /profiles:[\s\S]*- maintenance/);

  assert.match(api, /image:\s+\$\{CHARITYPILOT_API_IMAGE:\?Set CHARITYPILOT_API_IMAGE\}/);
  assert.match(api, /env_file:[\s\S]*\$\{CHARITYPILOT_PRODUCTION_ENV_FILE:-\.env\.production\}/);
  assert.match(api, /NODE_ENV:\s+production/);
  assert.match(api, /ENABLE_IN_PROCESS_JOBS:\s+"false"/);
  assert.doesNotMatch(api, /depends_on:[\s\S]*migrate:/);
  assert.match(api, /fetch\('http:\/\/127\.0\.0\.1:3002\/api\/v1\/health\/readiness'/);
  assert.match(api, /'x-charitypilot-readiness-key':\s*process\.env\.READINESS_API_KEY/);
  assert.match(api, /ports:[\s\S]*127\.0\.0\.1:\$\{CHARITYPILOT_API_PORT:-3002\}:3002/);

  assert.match(web, /image:\s+\$\{CHARITYPILOT_WEB_IMAGE:\?Set CHARITYPILOT_WEB_IMAGE\}/);
  assert.doesNotMatch(web, /env_file:/);
  assert.match(web, /NODE_ENV:\s+production/);
  assert.match(
    web,
    /NEXT_PUBLIC_API_URL:\s+\$\{CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL:\?Set CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL\}/,
  );
  assert.doesNotMatch(web, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(web, /depends_on:[\s\S]*api:[\s\S]*condition:\s+service_healthy/);
  assert.match(web, /fetch\('http:\/\/127\.0\.0\.1:3003\/'\)/);
  assert.match(web, /ports:[\s\S]*127\.0\.0\.1:\$\{CHARITYPILOT_WEB_PORT:-3003\}:3003/);

  for (const secret of [
    'DATABASE_URL',
    'JWT_SECRET',
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ERROR_ALERT_WEBHOOK_URL',
  ]) {
    assert.doesNotMatch(web, new RegExp(`\\b${secret}:`));
  }

  for (const secret of [
    'JWT_SECRET',
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'EMAIL_FROM',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_STORAGE_BUCKET',
    'ERROR_ALERT_WEBHOOK_URL',
    'FRONTEND_URL',
    'NEXT_PUBLIC_API_URL',
  ]) {
    assert.doesNotMatch(migrate, new RegExp(`\\b${secret}:`), `migrate must not receive ${secret}`);
  }

  assert.match(productionScheduler, /image:\s+\$\{CHARITYPILOT_API_IMAGE:\?Set CHARITYPILOT_API_IMAGE\}/);
  assert.doesNotMatch(productionScheduler, /profiles:/);
  assert.doesNotMatch(productionScheduler, /env_file:/);
  assert.match(productionScheduler, /command:\s+\["node",\s*"dist\/jobs\/production-scheduler\.js"\]/);
  assert.match(productionScheduler, /restart:\s+unless-stopped/);
  const stopGraceSeconds = Number(
    /stop_grace_period:\s+(\d+)s/.exec(productionScheduler)?.[1],
  );
  const maximumShutdownTimeoutSeconds = Number(
    /MAX_SCHEDULER_SHUTDOWN_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*1000/.exec(
      productionSchedulerSource,
    )?.[1],
  );
  assert.ok(Number.isFinite(stopGraceSeconds), 'production scheduler must declare stop_grace_period');
  assert.ok(Number.isFinite(maximumShutdownTimeoutSeconds), 'scheduler maximum shutdown timeout must remain explicit');
  assert.ok(
    stopGraceSeconds > maximumShutdownTimeoutSeconds,
    'compose stop grace must exceed every permitted scheduler shutdown timeout',
  );
  assert.doesNotMatch(productionScheduler, /depends_on:[\s\S]*migrate:/);
  assert.match(productionScheduler, /NODE_ENV:\s+production/);
  assert.match(productionScheduler, /DATABASE_URL:\s+\$\{DATABASE_URL:\?Set DATABASE_URL\}/);
  assert.match(productionScheduler, /FRONTEND_URL:\s+\$\{FRONTEND_URL:\?Set FRONTEND_URL\}/);
  assert.match(productionScheduler, /RESEND_API_KEY:\s+\$\{RESEND_API_KEY:\?Set RESEND_API_KEY\}/);
  assert.match(productionScheduler, /EMAIL_FROM:\s+\$\{EMAIL_FROM:\?Set EMAIL_FROM\}/);
  assert.match(productionScheduler, /SUPABASE_URL:\s+\$\{SUPABASE_URL:\?Set SUPABASE_URL\}/);
  assert.match(
    productionScheduler,
    /SUPABASE_SERVICE_ROLE_KEY:\s+\$\{SUPABASE_SERVICE_ROLE_KEY:\?Set SUPABASE_SERVICE_ROLE_KEY\}/,
  );
  assert.match(
    productionScheduler,
    /SUPABASE_STORAGE_BUCKET:\s+\$\{SUPABASE_STORAGE_BUCKET:\?Set SUPABASE_STORAGE_BUCKET\}/,
  );
  assert.match(productionScheduler, /DOCUMENT_STORAGE_CLEANUP_LIMIT:\s+\$\{DOCUMENT_STORAGE_CLEANUP_LIMIT:-25\}/);
  assert.match(productionScheduler, /DEADLINE_REMINDERS_INTERVAL_MS:\s+\$\{DEADLINE_REMINDERS_INTERVAL_MS:-86400000\}/);
  assert.match(
    productionScheduler,
    /DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS:\s+\$\{DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS:-3600000\}/,
  );
  assert.doesNotMatch(productionScheduler, /ports:/);
  assert.doesNotMatch(productionScheduler, /healthcheck:/);
  for (const secret of [
    'JWT_SECRET',
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'NEXT_PUBLIC_API_URL',
  ]) {
    assert.doesNotMatch(
      productionScheduler,
      new RegExp(`\\b${secret}:`),
      `production-scheduler must not receive ${secret}`,
    );
  }
  assert.match(
    productionScheduler,
    /ERROR_ALERT_WEBHOOK_URL:\s+\$\{ERROR_ALERT_WEBHOOK_URL:\?Set ERROR_ALERT_WEBHOOK_URL\}/,
  );

  for (const service of [migrate, api, web, productionScheduler, deadlineReminders, documentStorageCleanup]) {
    assert.match(service, /security_opt:[\s\S]*no-new-privileges:true/);
    assert.match(service, /cap_drop:[\s\S]*- ALL/);
  }

  for (const [serviceName, service] of [
    ['migrate', migrate],
    ['api', api],
    ['web', web],
    ['production-scheduler', productionScheduler],
    ['deadline-reminders', deadlineReminders],
    ['document-storage-cleanup', documentStorageCleanup],
  ]) {
    assertComposeServiceHasReadOnlyRootfs(service, serviceName);
  }

  for (const job of [deadlineReminders, documentStorageCleanup]) {
    assert.match(job, /profiles:[\s\S]*- jobs/);
    assert.match(job, /image:\s+\$\{CHARITYPILOT_API_IMAGE:\?Set CHARITYPILOT_API_IMAGE\}/);
    assert.doesNotMatch(job, /env_file:/);
    assert.doesNotMatch(job, /depends_on:[\s\S]*migrate:/);
    assert.match(job, /NODE_ENV:\s+production/);
    assert.match(job, /restart:\s+"no"/);
    assert.doesNotMatch(job, /ports:/);
    assert.doesNotMatch(job, /healthcheck:/);
  }

  assert.match(deadlineReminders, /command:\s+\["node",\s*"dist\/jobs\/send-deadline-reminders\.js"\]/);
  assert.match(deadlineReminders, /DATABASE_URL:\s+\$\{DATABASE_URL:\?Set DATABASE_URL\}/);
  assert.match(deadlineReminders, /FRONTEND_URL:\s+\$\{FRONTEND_URL:\?Set FRONTEND_URL\}/);
  assert.match(deadlineReminders, /RESEND_API_KEY:\s+\$\{RESEND_API_KEY:\?Set RESEND_API_KEY\}/);
  assert.match(deadlineReminders, /EMAIL_FROM:\s+\$\{EMAIL_FROM:\?Set EMAIL_FROM\}/);
  assert.match(
    deadlineReminders,
    /ERROR_ALERT_WEBHOOK_URL:\s+\$\{ERROR_ALERT_WEBHOOK_URL:\?Set ERROR_ALERT_WEBHOOK_URL\}/,
  );
  for (const secret of [
    'JWT_SECRET',
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_STORAGE_BUCKET',
    'NEXT_PUBLIC_API_URL',
  ]) {
    assert.doesNotMatch(
      deadlineReminders,
      new RegExp(`\\b${secret}:`),
      `deadline-reminders must not receive ${secret}`,
    );
  }

  assert.match(documentStorageCleanup, /command:\s+\["node",\s*"dist\/jobs\/cleanup-document-storage\.js"\]/);
  assert.match(documentStorageCleanup, /DATABASE_URL:\s+\$\{DATABASE_URL:\?Set DATABASE_URL\}/);
  assert.match(documentStorageCleanup, /SUPABASE_URL:\s+\$\{SUPABASE_URL:\?Set SUPABASE_URL\}/);
  assert.match(
    documentStorageCleanup,
    /SUPABASE_SERVICE_ROLE_KEY:\s+\$\{SUPABASE_SERVICE_ROLE_KEY:\?Set SUPABASE_SERVICE_ROLE_KEY\}/,
  );
  assert.match(
    documentStorageCleanup,
    /SUPABASE_STORAGE_BUCKET:\s+\$\{SUPABASE_STORAGE_BUCKET:\?Set SUPABASE_STORAGE_BUCKET\}/,
  );
  assert.match(documentStorageCleanup, /DOCUMENT_STORAGE_CLEANUP_LIMIT:\s+\$\{DOCUMENT_STORAGE_CLEANUP_LIMIT:-25\}/);
  assert.match(
    documentStorageCleanup,
    /ERROR_ALERT_WEBHOOK_URL:\s+\$\{ERROR_ALERT_WEBHOOK_URL:\?Set ERROR_ALERT_WEBHOOK_URL\}/,
  );
  for (const secret of [
    'JWT_SECRET',
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'EMAIL_FROM',
    'FRONTEND_URL',
    'NEXT_PUBLIC_API_URL',
  ]) {
    assert.doesNotMatch(
      documentStorageCleanup,
      new RegExp(`\\b${secret}:`),
      `document-storage-cleanup must not receive ${secret}`,
    );
  }
});

test('production Docker compose renders with published image variables and loopback-bound ports', () => {
  const compose = readRepoFile('compose.production.yml');
  const migrate = composeServiceBlock(compose, 'migrate');
  const api = composeServiceBlock(compose, 'api');
  const web = composeServiceBlock(compose, 'web');

  assert.match(migrate, /image:\s+\$\{CHARITYPILOT_MIGRATION_IMAGE:\?Set CHARITYPILOT_MIGRATION_IMAGE\}/);
  assert.match(api, /image:\s+\$\{CHARITYPILOT_API_IMAGE:\?Set CHARITYPILOT_API_IMAGE\}/);
  assert.match(web, /image:\s+\$\{CHARITYPILOT_WEB_IMAGE:\?Set CHARITYPILOT_WEB_IMAGE\}/);
  assert.match(api, /ports:[\s\S]*"127\.0\.0\.1:\$\{CHARITYPILOT_API_PORT:-3002\}:3002"/);
  assert.match(web, /ports:[\s\S]*"127\.0\.0\.1:\$\{CHARITYPILOT_WEB_PORT:-3003\}:3003"/);
  assert.match(
    web,
    /NEXT_PUBLIC_API_URL:\s+\$\{CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL:\?Set CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL\}/,
  );
});

test('API server enables trusted proxy handling for production rate limits', () => {
  const server = readRepoFile('apps/api/src/server.ts');

  assert.match(server, /trustedProxyAddresses/);
  assert.match(server, /trustProxy:\s*trustedProxyAddresses\.length\s*>\s*0\s*\?\s*trustedProxyAddresses\s*:\s*false/);
  assert.match(server, /Fastify\(\{[\s\S]*trustProxy:/);
  assert.doesNotMatch(server, /trustProxy:\s*process\.env\.TRUST_PROXY\s*===\s*'true'/);
});

test('request lifecycle docs describe identifier-aware auth throttles', () => {
  const docs = readRepoFile('docs/architecture/04-request-lifecycle.md');

  assert.match(docs, /identifier-aware per-route buckets/);
  assert.match(docs, /normalised email body field/);
  assert.match(docs, /normalised token body field/);
  assert.match(docs, /hash of the refresh token from the body or refresh cookie/);
  assert.match(docs, /hash of the bearer token or access cookie/);
  assert.match(docs, /production trusted-proxy configuration still matters/);
  assert.doesNotMatch(docs, /token-refresh endpoint, for example, caps at `5` requests per minute/);
});

test('module dependency graph describes auth public boundary and identifier throttles', () => {
  const docs = readRepoFile('docs/architecture/02-module-dependency-graph.md');

  assert.match(docs, /Public or partial-auth by design/);
  assert.match(docs, /do not require an existing organisation session/);
  assert.match(docs, /identifier-aware `rateLimit` buckets/);
  assert.match(docs, /email, reset\/verify token, refresh token, or bearer\/access-cookie credentials/);
  assert.doesNotMatch(docs, /No org-level guards/);
});

test('production API runtime leaves scheduled jobs to dedicated job containers', () => {
  const compose = readRepoFile('compose.production.yml');
  const cron = readRepoFile('apps/api/src/utils/cron.ts');
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));
  const api = composeServiceBlock(compose, 'api');
  const productionScheduler = composeServiceBlock(compose, 'production-scheduler');
  const deadlineReminders = composeServiceBlock(compose, 'deadline-reminders');
  const documentStorageCleanup = composeServiceBlock(compose, 'document-storage-cleanup');

  assert.match(cron, /NODE_ENV === 'production' && process\.env\.ENABLE_IN_PROCESS_JOBS !== 'true'/);
  assert.match(cron, /In-process jobs disabled/);
  assert.match(api, /ENABLE_IN_PROCESS_JOBS:\s+"false"/);
  assert.equal(apiPackage.scripts['jobs:production-scheduler'], 'node dist/jobs/production-scheduler.js');
  assert.match(productionScheduler, /command:\s+\["node",\s*"dist\/jobs\/production-scheduler\.js"\]/);
  assert.match(productionScheduler, /restart:\s+unless-stopped/);
  assert.doesNotMatch(productionScheduler, /profiles:/);
  assert.match(deadlineReminders, /command:\s+\["node",\s*"dist\/jobs\/send-deadline-reminders\.js"\]/);
  assert.match(documentStorageCleanup, /command:\s+\["node",\s*"dist\/jobs\/cleanup-document-storage\.js"\]/);
});

test('document storage deletion has a durable retry outbox and production job', () => {
  const schema = readRepoFile('apps/api/prisma/schema.prisma');
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));
  const cleanupJob = readRepoFile('apps/api/src/jobs/cleanup-document-storage.ts');

  assert.match(schema, /model DocumentStorageDeletion/);
  assert.match(schema, /claimedAt\s+DateTime\?/);
  assert.match(schema, /processedAt\s+DateTime\?/);
  assert.match(schema, /@@index\(\[processedAt, createdAt\]\)/);
  assert.match(schema, /@@index\(\[processedAt, claimedAt, createdAt\]\)/);
  assert.equal(apiPackage.scripts['jobs:document-storage-cleanup'], 'node dist/jobs/cleanup-document-storage.js');
  assert.match(cleanupJob, /retryPendingStorageDeletions/);
  assert.match(cleanupJob, /validateDocumentStorageCleanupEnv/);
  assert.match(cleanupJob, /StorageService/);
  assert.doesNotMatch(cleanupJob, /validateProductionEnv/);
});

test('backend architecture docs describe hardened storage keys and attempt-bound Stripe reconciliation', () => {
  const storageDoc = readRepoFile('docs/architecture/06-document-storage.md');
  const billingDoc = readRepoFile('docs/architecture/05-billing.md');

  assert.match(storageDoc, /<organisationId>\/<epoch-ms>-<uuid>-<sanitised-filename>/);
  assert.match(
    storageDoc,
    /same-millisecond uploads with the same original filename still produce distinct object keys/,
  );
  assert.doesNotMatch(storageDoc, /<organisationId>\/<epoch-ms>-<sanitised-filename>/);

  assert.match(billingDoc, /Checkout and portal creation reconcile billing ownership/);
  assert.match(billingDoc, /A stored `Organisation\.stripeCustomerId`, when present, is retrieved/);
  assert.match(billingDoc, /organisation-scoped idempotency key/);
  assert.match(billingDoc, /Portal creation never invents a customer/);
  assert.match(billingDoc, /`BillingCheckoutAttempt` lifecycle/);
  assert.match(billingDoc, /STRIPE_BILLING_PORTAL_CONFIGURATION_ID/);
  assert.doesNotMatch(billingDoc, /Lazily creates a Stripe customer if `organisation\.stripeCustomerId` is null/);
});

test('export API route delegates report rendering to a dedicated module', () => {
  const route = readRepoFile('apps/api/src/routes/export/index.ts');
  const renderer = readRepoFile('apps/api/src/routes/export/compliance-report-html.ts');

  assert.match(route, /buildComplianceReportHtml/);
  assert.match(route, /loadGovernanceRegisters/);
  assert.doesNotMatch(route, /function buildSourceReviewAppendixHtml/);
  assert.doesNotMatch(route, /IRISH_COMPLIANCE_MATRIX_LAST_CHECKED/);
  assert.match(renderer, /export function buildComplianceReportHtml/);
  assert.match(renderer, /export type GovernanceRegistersForExport/);
  assert.match(renderer, /function buildSourceReviewAppendixHtml/);
  assert.match(renderer, /IRISH_COMPLIANCE_MATRIX_LAST_CHECKED/);
});

test('documents API route delegates upload validation helpers to a dedicated module', () => {
  const route = readRepoFile('apps/api/src/routes/documents/index.ts');
  const validation = readRepoFile('apps/api/src/routes/documents/document-upload-validation.ts');

  assert.match(route, /document-upload-validation\.js/);
  assert.match(route, /hasAllowedMimeType/);
  assert.match(route, /DOCUMENT_UPLOAD_MULTIPART_LIMITS/);
  assert.doesNotMatch(route, /const ALLOWED_MIME_TYPES = new Set/);
  assert.doesNotMatch(route, /function hasZipSignature/);
  assert.match(validation, /const ALLOWED_MIME_TYPES = new Set/);
  assert.match(validation, /export function hasValidSignature/);
  assert.match(validation, /export function isMultipartLimitError/);
});

test('production operations docs keep detailed readiness checks behind the internal header', () => {
  const runbook = readRepoFile('docs/production-runbook.md');
  const launchChecklist = readRepoFile('docs/production-launch-checklist.md');
  const browserQa = readRepoFile('docs/production-browser-qa.md');
  const supabaseSetup = readRepoFile('docs/supabase-production-setup.md');

  for (const doc of [runbook, launchChecklist, browserQa, supabaseSetup]) {
    assert.match(doc, /x-charitypilot-readiness-key/);
  }

  assert.match(browserQa, /without `x-charitypilot-readiness-key` returns `401`/);
  assert.match(supabaseSetup, /without `x-charitypilot-readiness-key` should return `401`/);
  assert.match(supabaseSetup, /supabaseStorage\.checks\.supabase-backups-enabled/);
  assert.match(supabaseSetup, /supabaseStorage\.checks\.supabase-restore-tested/);
  assert.match(runbook, /Public monitoring can check `\/api\/v1\/health`/);
  assert.doesNotMatch(supabaseSetup, /curl -i https:\/\/api\.charitypilot\.ie\/api\/v1\/health\/readiness/);
});

test('production operations docs keep Supabase credentials API-only', () => {
  const runbook = readRepoFile('docs/production-runbook.md');
  const launchChecklist = readRepoFile('docs/production-launch-checklist.md');

  assert.match(runbook, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL/);
  assert.match(runbook, /must match `NEXT_PUBLIC_API_URL`/);
  assert.doesNotMatch(runbook, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(
    runbook,
    /docker compose --env-file \.env\.production -f compose\.production\.yml -f compose\.production-tls\.yml config --quiet/,
  );
  assert.match(launchChecklist, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL/);
  assert.match(launchChecklist, /matches `NEXT_PUBLIC_API_URL`/);
  assert.doesNotMatch(launchChecklist, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(launchChecklist, /npm run check:production:github-secrets -- --environment=production/);
  assert.match(launchChecklist, /required production secret names exist without reading secret values/);
});

test('production runbook documents deployed browser QA evidence commands', () => {
  const runbook = readRepoFile('docs/production-runbook.md');

  assert.match(runbook, /E2E_DEPLOYED_QA=true/);
  assert.match(runbook, /E2E_WEB_URL=https:\/\/app\.charitypilot\.ie/);
  assert.match(runbook, /E2E_API_URL=https:\/\/api\.charitypilot\.ie/);
  assert.match(runbook, /E2E_OWNER_EMAIL/);
  assert.match(runbook, /E2E_OWNER_PASSWORD/);
  assert.match(runbook, /npm run test:e2e:responsive/);
  assert.match(runbook, /npm run test:e2e -- tests\/accessibility\.spec\.ts/);
  assert.match(runbook, /npm run test:e2e:deployed:responsive:cross-browser/);
  assert.match(runbook, /npm run test:e2e:deployed:accessibility:cross-browser/);
  assert.match(runbook, /browserQa\.checks\.browser-qa-completed/);
  assert.match(runbook, /Deployed browser QA environment preflight passed/);
  assert.match(runbook, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(runbook, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(runbook, /production-launch-evidence\.json/);
});

test('production browser QA checklist points browser evidence at the dedicated launch slots', () => {
  const browserQa = readRepoFile('docs/production-browser-qa.md');
  const launchChecklist = readRepoFile('docs/production-launch-checklist.md');
  const requiredRouteLabels = [
    '/',
    '/about',
    '/features',
    '/pricing',
    '/blog',
    '/blog/understanding-the-charities-governance-code',
    '/privacy',
    '/terms',
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/accept-invite',
    '/dashboard',
    '/compliance',
    '/compliance/${principleId}',
    '/documents',
    '/deadlines',
    '/board',
    '/registers',
    '/regulator',
    '/organisation',
    '/team',
    '/billing',
    '/export',
  ];

  assert.match(browserQa, /npm run test:e2e -- tests\/accessibility\.spec\.ts/);
  assert.match(browserQa, /browserQa\.checks\.accessibility-coverage/);
  assert.match(browserQa, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(browserQa, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(browserQa, /light and dark/);
  assert.match(browserQa, /all four focused route chunks/);
  assert.match(browserQa, /test:e2e:responsive:public:desktop/);
  assert.match(browserQa, /test:e2e:responsive:public:mobile/);
  assert.match(browserQa, /test:e2e:responsive:dashboard:desktop/);
  assert.match(browserQa, /test:e2e:responsive:dashboard:mobile/);
  assert.match(browserQa, /E2E_DEPLOYED_QA=true[\s\S]*npm run test:e2e:responsive:public:desktop/);
  assert.match(browserQa, /E2E_DEPLOYED_QA=true[\s\S]*npm run test:e2e:responsive:dashboard:mobile/);
  assert.match(browserQa, /SECRET_STORE_E2E_OWNER_EMAIL/);
  assert.match(browserQa, /SECRET_STORE_E2E_OWNER_PASSWORD/);
  assert.doesNotMatch(browserQa, /qa-owner@example\.com|from-secret-store/);
  assert.doesNotMatch(browserQa, /<secret-store-reference>/);
  assert.match(browserQa, /E2E_SKIP_ROUTE_WARMING=true/);
  assert.match(browserQa, /E2E_ROUTE_WARM_TIMEOUT_MS/);
  assert.match(
    readRepoFile('e2e/global-setup.ts'),
    /Public-route readiness sweep skipped because E2E_SKIP_ROUTE_WARMING=true/,
  );
  assert.match(launchChecklist, /all four focused responsive route chunk transcripts/);
  assert.match(launchChecklist, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(launchChecklist, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(launchChecklist, /browserQa\.checks\.critical-flows-covered/);
  assert.doesNotMatch(launchChecklist, /browserQa\.checks\.critical-flows(?!-covered)/);
  assert.match(browserQa, /browserQa\.checks\.critical-flows-covered/);
  assert.match(browserQa, /browserQa\.checks\.critical-flows-covered[\s\S]{0,500}pending-navigation confirmation/);
  assert.match(browserQa, /browserQa\.checks\.critical-flows-covered[\s\S]{0,500}conditional obligations/);
  assert.match(browserQa, /browserQa\.checks\.critical-flows-covered[\s\S]{0,500}readiness blockers/);
  assert.doesNotMatch(browserQa, /browserQa\.checks\.critical-flows(?!-covered)/);
  assert.match(launchChecklist, /public\/auth and dashboard desktop light\/dark route matrices/);
  assert.match(launchChecklist, /public\/auth and dashboard mobile light\/dark route matrices/);
  assert.match(browserQa, /Launch-Critical Route Inventory/);
  assert.match(browserQa, /Every route below must have desktop, mobile, light-mode, and dark-mode evidence/);
  for (const route of requiredRouteLabels) {
    assert.match(browserQa, new RegExp(String.raw`\| \`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` \|`));
  }
});

test('plain English launch guide names every final approval role', () => {
  const launchGuide = readRepoFile('docs/LAUNCH-GUIDE.md');
  const selectedGateCommit = currentAuditSelectedGateCommit();

  assert.doesNotMatch(launchGuide, /[^\x00-\x7F]/);
  assert.match(launchGuide, /Last updated: 2026-07-10/);
  assert.match(launchGuide, /17 production values needing real data/);
  assert.match(launchGuide, /production values are `9 \/ 26` complete/);
  assert.match(launchGuide, /machine-readable launch evidence is `9 \/ 86` complete/);
  assert.match(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 512\/512/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 488\/488/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 351\/351/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 350\/350/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 349\/349/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 346\/346/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 345\/345/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 340\/340/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 338\/338/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 333\/333/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 332\/332/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 331\/331/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 330\/330/);
  assert.match(launchGuide, /local `npm run release:ready` run passed on 2026-07-09/);
  assert.match(launchGuide, /95 Playwright E2E tests passed/);
  assert.match(launchGuide, /GREEN - repository release gates passed/);
  assert.doesNotMatch(launchGuide, /only Playwright E2E was skipped/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 322\/322/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 321\/321/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 320\/320/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 319\/319/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 318\/318/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 316\/316/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 315\/315/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 313\/313/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 312\/312/);
  assert.doesNotMatch(launchGuide, /Production-tooling tests \| Local `npm run test:production-check` passed 311\/311/);
  assert.doesNotMatch(launchGuide, /304\/304 production-tooling checks|passed 304\/304/);
  assert.doesNotMatch(launchGuide, /300\/300 production-tooling checks|passed 300\/300/);
  assert.doesNotMatch(launchGuide, /299\/299 production-tooling checks|passed 299\/299/);
  assert.match(launchGuide, new RegExp(`commit\\s+\`${escapeRegExp(selectedGateCommit)}\``));
  assert.doesNotMatch(launchGuide, /`91baf75`|`db025c7`|`73e8484`/);
  assert.match(launchGuide, /final signoffs are\s+`0 \/ 5`/);
  assert.match(launchGuide, /`approvedForLaunch` is `false`/);
  assert.match(launchGuide, /Local browser QA has current 2026-07-09 evidence/);
  assert.match(launchGuide, /public desktop 14\/14/);
  assert.match(launchGuide, /public mobile 14\/14/);
  assert.match(launchGuide, /browserQa\.checks\.browser-qa-completed/);
  assert.match(launchGuide, /npm run check:production:browser-qa-env/);
  assert.match(launchGuide, /Deployed browser QA environment preflight passed/);
  assert.match(launchGuide, /dashboard desktop 12\/12/);
  assert.match(launchGuide, /dashboard mobile 12\/12/);
  assert.match(launchGuide, /full local accessibility suite passed 26\/26 checks on 2026-07-09/);
  assert.match(launchGuide, /including `\/about` and both light and dark themes/);
  assert.doesNotMatch(launchGuide, /prior full accessibility suite passed 25\/25 checks before `\/about` was added/);
  assert.doesNotMatch(launchGuide, /full accessibility suite must be rerun for the final release transcript/);
  assert.match(launchGuide, /deployed production QA remains a launch gate/i);
  assert.match(launchGuide, /86 machine-readable launch evidence checks/);
  assert.match(launchGuide, /browserQa\.checks\.accessibility-coverage/);
  assert.match(launchGuide, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(launchGuide, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(launchGuide, /Launch-Critical Route Inventory/);
  assert.match(launchGuide, /every route in desktop, mobile, light-mode, and dark-mode evidence/);
  assert.doesNotMatch(launchGuide, /machine-readable launch evidence is `0 \/ 86` complete/);
  assert.match(launchGuide, /TLS is now turnkey by default/);
  assert.match(launchGuide, /default reverse proxy overlay \(`compose\.production-tls\.yml` \+/);
  assert.match(
    launchGuide,
    /gh variable set NEXT_PUBLIC_API_URL --env production --repo jasperfordesq-ai\/charity-governance --body "https:\/\/api\.charitypilot\.ie"/,
  );
  assert.doesNotMatch(launchGuide, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.doesNotMatch(launchGuide, /REAL_SUPABASE_PROJECT_REF first/);
  assert.match(launchGuide, /gh workflow run release-images\.yml --ref master/);
  assert.match(launchGuide, /Current known GitHub environment blocker/);
  assert.match(launchGuide, /check:production:github-env -- --environment=production/);
  assert.match(launchGuide, /check:production:github-secrets -- --environment=production/);
  assert.match(launchGuide, /required production secret names exist without reading or\s+printing secret values/);
  assert.match(launchGuide, /release-image-digests\.env/);
  assert.match(launchGuide, /CHARITYPILOT_WEB_BUILD_\*/);
  assert.doesNotMatch(launchGuide, /optional reverse proxy/);
  assert.doesNotMatch(launchGuide, /four named approvals/i);
  assert.match(launchGuide, /five named approvals/i);
  assert.match(launchGuide, /engineering, operations, security, legal\/compliance, and business/);
});

test('frontend architecture docs describe current public theme support', () => {
  const frontendArchitecture = readRepoFile('docs/architecture/09-frontend.md');
  const authLayout = readRepoFile('apps/web/src/app/(auth)/layout.tsx');
  const marketingLayout = readRepoFile('apps/web/src/app/(marketing)/layout.tsx');

  assert.match(authLayout, /dark:bg-gray-950/);
  assert.match(marketingLayout, /dark:bg-gray-950/);
  assert.doesNotMatch(frontendArchitecture, /light-only/i);
  assert.doesNotMatch(frontendArchitecture, /colorScheme: 'light'/);
  assert.match(frontendArchitecture, /\(auth\)[^\n]*dark-capable/);
  assert.match(frontendArchitecture, /\(marketing\)[^\n]*dark-capable/);
  assert.match(
    frontendArchitecture,
    /pre-paint inline script applies the user's light\/dark preference across public and protected route groups/,
  );
});

test('marketing blog search uses the shared empty-state primitive', () => {
  const blogClient = readRepoFile('apps/web/src/app/(marketing)/blog/BlogClient.tsx');

  assert.match(blogClient, /import \{ EmptyState \} from '@\/components\/ui\/states'/);
  assert.match(blogClient, /<EmptyState[\s\S]*title="No articles found"/);
  assert.doesNotMatch(blogClient, /border-dashed border-gray-300/);
  assert.doesNotMatch(blogClient, /<FileText/);
});

test('compliance standard editor uses the shared save-status primitive', () => {
  const standardEditor = readRepoFile('apps/web/src/app/(dashboard)/compliance/[principleId]/standard-editor-card.tsx');
  const statePrimitives = readRepoFile('apps/web/src/components/ui/states.tsx');

  assert.match(statePrimitives, /export function SaveStatusIndicator/);
  assert.match(standardEditor, /import \{ SaveStatusIndicator \} from '@\/components\/ui\/states'/);
  assert.match(standardEditor, /<SaveStatusIndicator[\s\S]*status=\{save\}/);
  assert.doesNotMatch(standardEditor, /LoaderCircle/);
  assert.doesNotMatch(standardEditor, /CircleAlert/);
  assert.doesNotMatch(standardEditor, /import \{ Check/);
});

test('organisation profile form uses the shared save-status primitive', () => {
  const workflow = readRepoFile('apps/web/src/app/(dashboard)/organisation/use-organisation-workflow.ts');
  const page = readRepoFile('apps/web/src/app/(dashboard)/organisation/page.tsx');
  const form = readRepoFile('apps/web/src/app/(dashboard)/organisation/organisation-profile-form.tsx');

  assert.match(workflow, /profileSaveStatus/);
  assert.match(page, /profileSaveStatus=\{profileSaveStatus\}/);
  assert.match(
    form,
    /import \{[^}]*\bSaveStatusIndicator\b[^}]*\} from '@\/components\/ui\/states'/,
  );
  assert.match(form, /profileSaveStatus:\s*'idle' \| 'saving' \| 'saved' \| 'error'/);
  assert.match(form, /<SaveStatusIndicator\s+status=\{profileSaveStatus\}/);
});

test('governance registers page uses the shared save-status primitive', () => {
  const workflow = readRepoFile('apps/web/src/app/(dashboard)/registers/use-registers-workflow.ts');
  const page = readRepoFile('apps/web/src/app/(dashboard)/registers/page.tsx');

  assert.match(workflow, /registerSaveStatus/);
  assert.match(
    page,
    /import \{ ErrorState, LoadingState, LockedFeatureState, SaveStatusIndicator \} from '@\/components\/ui\/states'/,
  );
  assert.match(page, /registerSaveStatus,/);
  assert.match(page, /<SaveStatusIndicator\s+status=\{registerSaveStatus\}/);
  assert.doesNotMatch(page, /registerSavingLabel/);
});

test('deadline and board list mutations use the shared save-status primitive', () => {
  const deadlineList = readRepoFile('apps/web/src/app/(dashboard)/deadlines/deadline-list-panel.tsx');
  const boardList = readRepoFile('apps/web/src/app/(dashboard)/board/board-member-list-panel.tsx');

  assert.match(deadlineList, /SaveStatusIndicator/);
  assert.match(deadlineList, /const deadlineMutationStatus: 'idle' \| 'saving' \| 'saved' \| 'error'/);
  assert.match(deadlineList, /<SaveStatusIndicator\s+status=\{deadlineMutationStatus\}/);
  assert.doesNotMatch(deadlineList, /Deadline list ready/);

  assert.match(boardList, /SaveStatusIndicator/);
  assert.match(boardList, /const boardMutationStatus: 'idle' \| 'saving' \| 'saved' \| 'error'/);
  assert.match(boardList, /<SaveStatusIndicator\s+status=\{boardMutationStatus\}/);
  assert.doesNotMatch(boardList, /Board register ready/);
});

test('team page mutations use the shared save-status primitive', () => {
  const teamPage = readRepoFile('apps/web/src/app/(dashboard)/team/page.tsx');

  assert.match(teamPage, /SaveStatusIndicator/);
  assert.match(teamPage, /const teamMutationStatus: 'idle' \| 'saving' \| 'saved' \| 'error'/);
  assert.match(teamPage, /<SaveStatusIndicator\s+status=\{teamMutationStatus\}/);
  assert.doesNotMatch(teamPage, /Team permissions ready/);
});

test('documents page mutations use the shared save-status primitive', () => {
  const documentsPage = readRepoFile('apps/web/src/app/(dashboard)/documents/page.tsx');

  assert.match(documentsPage, /SaveStatusIndicator/);
  assert.match(documentsPage, /const documentMutationStatus: 'idle' \| 'saving' \| 'saved' \| 'error'/);
  assert.match(documentsPage, /<SaveStatusIndicator\s+status=\{documentMutationStatus\}/);
});

test('export board sign-off uses the shared save-status primitive', () => {
  const approvalPanel = readRepoFile('apps/web/src/app/(dashboard)/export/export-board-approval-panel.tsx');

  assert.match(approvalPanel, /SaveStatusIndicator/);
  assert.match(approvalPanel, /signoffSaveStatus: 'idle' \| 'dirty' \| 'saving' \| 'saved' \| 'error'/);
  assert.match(approvalPanel, /<SaveStatusIndicator\s+status=\{signoffSaveStatus\}/);
});

test('billing page uses shared visible status for Stripe actions', () => {
  const billingPage = readRepoFile('apps/web/src/app/(dashboard)/billing/page.tsx');

  assert.match(billingPage, /InlineStatus/);
  assert.match(billingPage, /const billingActionStatus = checkoutLoading[\s\S]*portalLoading/);
  assert.match(billingPage, /<InlineStatus tone="neutral">\s*\{billingActionStatus\}/);
  assert.doesNotMatch(billingPage, /Billing ready/);
});

test('billing plan pricing avoids nested card panel styling', () => {
  const billingPlans = readRepoFile('apps/web/src/app/(dashboard)/billing/billing-plan-sections.tsx');

  assert.doesNotMatch(billingPlans, /rounded-lg border border-gray-200 bg-gray-50/);
  assert.match(billingPlans, /border-y border-gray-200 py-4/);
});

test('team permission-denied states use the shared permission hint primitive', () => {
  const statePrimitives = readRepoFile('apps/web/src/components/ui/states.tsx');
  const membersPanel = readRepoFile('apps/web/src/app/(dashboard)/team/team-members-panel.tsx');
  const invitesPanel = readRepoFile('apps/web/src/app/(dashboard)/team/team-invites-panel.tsx');

  assert.match(statePrimitives, /export function PermissionHint/);
  assert.match(
    membersPanel,
    /import \{ EmptyState, ErrorState, LoadingState, PermissionHint \} from '@\/components\/ui\/states'/,
  );
  assert.match(membersPanel, /<PermissionHint>\s*\{roleDisabledReason\}\s*<\/PermissionHint>/);
  assert.doesNotMatch(membersPanel, /max-w-xs rounded-lg border border-gray-200 bg-gray-50/);

  assert.match(invitesPanel, /import \{ EmptyState, PermissionHint \} from '@\/components\/ui\/states'/);
  assert.match(invitesPanel, /<PermissionHint>\s*\{permissionDisabledReason\}\s*<\/PermissionHint>/);
  assert.doesNotMatch(
    invitesPanel,
    /<p className="text-xs text-gray-500 dark:text-gray-400">\{permissionDisabledReason\}<\/p>/,
  );
});

test('backend product audit records current launch and dependency posture', () => {
  const backendAudit = readRepoFile('docs/product-revamp/backend-audit.md');

  assert.match(backendAudit, /Date checked: 2026-07-05/);
  assert.match(backendAudit, /Fresh production dependency audit on 2026-07-05/);
  assert.match(backendAudit, /npm audit --omit=dev --audit-level=moderate/);
  assert.match(backendAudit, /found 0 vulnerabilities/);
  assert.match(backendAudit, /17 production values require real data/);
  assert.match(backendAudit, /86 machine-readable launch evidence checks/);
  assert.doesNotMatch(backendAudit, /Date checked: 2026-07-03/);
  assert.doesNotMatch(backendAudit, /Phase 7 current/);
});

test('platform audit describes safe isolated Supabase restore evidence', () => {
  const auditScript = readRepoFile('scripts/platform-completion-audit.mjs');
  const platformAudit = readRepoFile('docs/platform-completion-audit.md');
  const combined = `${auditScript}\n${platformAudit}`;

  assert.match(combined, /isolated restore target/);
  assert.match(combined, /non-production restore target/);
  assert.match(combined, /production project was not overwritten/);
  assert.doesNotMatch(combined, /restore-test ownership in addition to private bucket/);
});

test('governance docs describe the broadened approval-readiness model', () => {
  const governanceArchitecture = readRepoFile('docs/architecture/08-governance-domain.md');
  const backendAudit = readRepoFile('docs/product-revamp/backend-audit.md');
  const combined = `${governanceArchitecture}\n${backendAudit}`;

  for (const term of [
    'missingRecords',
    'missingEvidence',
    'missingExplanations',
    'profileIssues',
    'conditionalReviewItems',
    'matrixReviewItems',
    'matrixLastChecked',
  ]) {
    assert.match(combined, new RegExp(term), `docs must describe ${term}`);
  }

  assert.match(combined, /missing standard records/i);
  assert.match(combined, /missing action\/evidence fields/i);
  assert.match(combined, /conditional obligation profile/i);
  assert.match(combined, /conditional review prompts/i);
  assert.match(combined, /not legal certification/i);
  assert.doesNotMatch(combined, /returns \{ ready, missingExplanations \}/);
  assert.doesNotMatch(combined, /warning section when explanations are incomplete/);
  assert.doesNotMatch(combined, /specific approval-readiness warning/);
});

test('irish source log records current official-source recheck without legal certainty', () => {
  const sourceLog = readRepoFile('docs/product-revamp/irish-source-log.md');
  const auditScript = readRepoFile('scripts/platform-completion-audit.mjs');
  const platformAudit = readRepoFile('docs/platform-completion-audit.md');

  assert.match(sourceLog, /Date checked: 2026-07-09/);
  assert.match(sourceLog, /Official sources were rechecked by web search\/browsing on 2026-07-09/);
  assert.match(sourceLog, /Charities Regulator direct automated fetches returned 403/);
  assert.match(sourceLog, /Irish Statute Book commencement table was updated to 24 June 2026/);
  assert.match(sourceLog, /Law Reform Commission revised Charities Act 2009 page was updated to 22 April 2026/);
  assert.match(sourceLog, /changes known to be in force as of 2 July 2026/);
  assert.match(sourceLog, /not legal advice/);
  assert.match(sourceLog, /professional-review flags/);
  assert.doesNotMatch(sourceLog, /legally guaranteed/i);
  assert.doesNotMatch(sourceLog, /legally bombproof/i);
  assert.doesNotMatch(sourceLog, /Date checked: 2026-07-06/);
  assert.doesNotMatch(sourceLog, /Date checked: 2026-07-05/);
  assert.doesNotMatch(sourceLog, /Date checked: 2026-07-03/);
  assert.match(auditScript, /source metadata was refreshed.*2026-07-09/);
  assert.doesNotMatch(auditScript, /source metadata was refreshed.*2026-07-04/);
  assert.match(platformAudit, /source metadata was refreshed.*2026-07-09/);
  assert.doesNotMatch(platformAudit, /source metadata was refreshed.*2026-07-04/);
});

test('production deploy preflight is wired for digest-pinned image promotion', () => {
  const packageJson = JSON.parse(readRepoFile('package.json'));
  const runbook = readRepoFile('docs/production-runbook.md');
  const launchChecklist = readRepoFile('docs/production-launch-checklist.md');

  assert.ok(existsSync(join(repoRoot, 'scripts', 'production-deploy-preflight.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'production-compose-deploy.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'production-compose-rollback.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'production-cutover-lock.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'init-production-launch-evidence.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'production-launch-evidence.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'production-launch-evidence-status.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'production-release-run-evidence.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'generate-production-launch-evidence-template.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-production-supabase.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-production-providers.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-production-hosting.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-production-observability.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-production-database.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-production-github-secrets.mjs')));
  assert.ok(existsSync(join(repoRoot, 'scripts', 'smoke-production-deploy.mjs')));
  assert.equal(packageJson.scripts['check:production:database'], 'node scripts/check-production-database.mjs');
  assert.equal(
    packageJson.scripts['check:production:observability'],
    'node scripts/check-production-observability.mjs',
  );
  assert.equal(packageJson.scripts['check:production:hosting'], 'node scripts/check-production-hosting.mjs');
  assert.equal(packageJson.scripts['check:production:providers'], 'node scripts/check-production-providers.mjs');
  assert.equal(packageJson.scripts['check:production:supabase'], 'node scripts/check-production-supabase.mjs');
  assert.equal(
    packageJson.scripts['check:production:github-secrets'],
    'node scripts/check-production-github-secrets.mjs',
  );
  assert.equal(packageJson.scripts['check:production:evidence'], 'node scripts/production-launch-evidence.mjs');
  assert.equal(
    packageJson.scripts['check:production:evidence:init'],
    'node scripts/init-production-launch-evidence.mjs',
  );
  assert.equal(
    packageJson.scripts['check:production:evidence:status'],
    'node scripts/production-launch-evidence-status.mjs',
  );
  assert.equal(packageJson.scripts['check:production:release-run'], 'node scripts/production-release-run-evidence.mjs');
  assert.equal(
    packageJson.scripts['prepare:production:evidence-upload'],
    'node scripts/prepare-production-launch-evidence-upload.mjs',
  );
  assert.equal(
    packageJson.scripts['check:production:evidence:template'],
    'node scripts/generate-production-launch-evidence-template.mjs',
  );
  assert.equal(packageJson.scripts['deploy:preflight'], 'node scripts/production-deploy-preflight.mjs');
  assert.equal(packageJson.scripts['deploy:production'], 'node scripts/production-compose-deploy.mjs');
  assert.equal(packageJson.scripts['deploy:rollback'], 'node scripts/production-compose-rollback.mjs');
  assert.match(packageJson.scripts['test:production-check'], /scripts\/production-deploy-preflight\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/production-compose-deploy\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/production-compose-rollback\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/production-cutover-lock\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/init-production-launch-evidence\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/production-launch-evidence\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/production-launch-evidence-status\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/production-release-run-evidence\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/check-production-github-secrets\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/check-production-supabase\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/check-production-providers\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/check-production-hosting\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/check-production-observability\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/check-production-database\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/check-deployed-browser-qa-env\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/smoke-production-deploy\.test\.mjs/);
  assert.equal(
    packageJson.scripts['check:production:browser-qa-env'],
    'node scripts/check-deployed-browser-qa-env.mjs',
  );
  assert.match(readRepoFile('scripts/production-deploy-preflight.mjs'), /runProductionPreflight/);
  assert.match(readRepoFile('scripts/production-compose-deploy.mjs'), /runProductionDeployPreflightFromArgs/);
  assert.match(readRepoFile('scripts/production-compose-deploy.mjs'), /smoke-production-deploy\.mjs/);
  assert.match(readRepoFile('scripts/production-compose-rollback.mjs'), /runProductionComposeDeployFromArgs/);
  assert.match(readRepoFile('scripts/production-compose-rollback.mjs'), /--no-tls-proxy/);
  assert.match(readRepoFile('scripts/production-compose-deploy.mjs'), /acquireProductionCutoverLock/);
  assert.match(readRepoFile('scripts/production-compose-rollback.mjs'), /cutoverLock/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /REQUIRED_LAUNCH_AREAS/);
  assert.match(readRepoFile('scripts/init-production-launch-evidence.mjs'), /\.charitypilot-launch-evidence/);
  assert.match(readRepoFile('scripts/init-production-launch-evidence.mjs'), /--json/);
  assert.match(readRepoFile('scripts/init-production-launch-evidence.mjs'), /statusJson/);
  assert.match(readRepoFile('scripts/init-production-launch-evidence.mjs'), /validateJson/);
  assert.match(readRepoFile('scripts/check-deployed-browser-qa-env.mjs'), /E2E_DEPLOYED_QA/);
  assert.match(readRepoFile('scripts/check-deployed-browser-qa-env.mjs'), /secretValuesPrinted:\s*false/);
  assert.match(readRepoFile('scripts/launch-status.mjs'), /deployedBrowserQaPreflight/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /hosting-check/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /database-check/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /supabase-check/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /providers-check/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /observability-check/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /FINAL_SIGNOFF_ROLES/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /finalSignoff\.approvals/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /release-run-api-verification/);
  assert.match(readRepoFile('scripts/production-launch-evidence.mjs'), /check:production:release-run/);
  assert.match(readRepoFile('scripts/production-launch-evidence-status.mjs'), /Checklist checks complete/);
  assert.match(readRepoFile('scripts/production-launch-evidence-status.mjs'), /Next incomplete checks/);
  assert.match(readRepoFile('scripts/production-launch-evidence-status.mjs'), /Final approval roles approved/);
  assert.match(readRepoFile('scripts/launch-status.mjs'), /approvedForLaunch/);
  assert.match(readRepoFile('scripts/launch-status.mjs'), /finalSignoff/);
  assert.match(readRepoFile('scripts/launch-status.mjs'), /Next incomplete checks/);
  assert.match(readRepoFile('scripts/launch-status.mjs'), /Final approval roles approved/);
  assert.match(readRepoFile('scripts/production-release-run-evidence.mjs'), /api\.github\.com/);
  assert.match(readRepoFile('scripts/production-release-run-evidence.mjs'), /release-image-digests/);
  assert.match(readRepoFile('scripts/generate-production-launch-evidence-template.mjs'), /REQUIRED_LAUNCH_AREAS/);
  assert.match(readRepoFile('scripts/generate-production-launch-evidence-template.mjs'), /FINAL_SIGNOFF_ROLES/);
  assert.match(readRepoFile('scripts/check-production-supabase.mjs'), /runProductionSupabaseCheckFromArgs/);
  assert.match(readRepoFile('scripts/check-production-providers.mjs'), /runProductionProvidersCheckFromArgs/);
  assert.match(readRepoFile('scripts/check-production-hosting.mjs'), /runProductionHostingCheckFromArgs/);
  assert.match(readRepoFile('scripts/check-production-observability.mjs'), /runProductionObservabilityCheckFromArgs/);
  assert.match(readRepoFile('scripts/check-production-database.mjs'), /runProductionDatabaseCheckFromArgs/);
  assert.match(readRepoFile('scripts/check-production-github-secrets.mjs'), /runProductionGitHubSecretsCheckFromArgs/);

  assert.match(runbook, /npm run deploy:preflight -- --production-env-file=\.env\.production/);
  assert.match(runbook, /npm run deploy:production -- --production-env-file=\.env\.production/);
  assert.match(
    runbook,
    /npm run deploy:rollback -- --production-env-file=\.env\.production --rollback-digest-file=release-image-digests\.previous\.env/,
  );
  assert.match(
    runbook,
    /gh variable set NEXT_PUBLIC_API_URL --env production --repo jasperfordesq-ai\/charity-governance --body "https:\/\/api\.charitypilot\.ie"/,
  );
  assert.doesNotMatch(runbook, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(runbook, /npm run check:production:github-env -- --environment=production --json/);
  assert.match(runbook, /npm run check:production:github-secrets -- --environment=production/);
  assert.match(runbook, /npm run check:production:github-secrets -- --environment=production --json/);
  assert.match(runbook, /lists secret metadata only; it does not read secret values/);
  assert.doesNotMatch(runbook, /REAL_SUPABASE_PROJECT_REF first/);
  assert.match(runbook, /E2E_DEPLOYED_QA=true[\s\S]*npm run test:e2e:responsive/);
  assert.match(runbook, /E2E_DEPLOYED_QA=true[\s\S]*npm run test:e2e:deployed:responsive:cross-browser/);
  assert.match(runbook, /SECRET_STORE_E2E_OWNER_EMAIL/);
  assert.match(runbook, /SECRET_STORE_E2E_OWNER_PASSWORD/);
  assert.doesNotMatch(runbook, /<secret-store-reference>/);
  assert.match(runbook, /gh workflow run release-images\.yml --ref master/);
  assert.match(runbook, /gh run watch RELEASE_RUN_ID --exit-status/);
  assert.match(
    runbook,
    /pass `--no-tls-proxy` to `npm run deploy:preflight`, `npm run deploy:production`, and any matching `npm run deploy:rollback` rehearsal/,
  );
  assert.match(runbook, /npm run check:production:hosting -- --production-env-file=\.env\.production/);
  assert.match(runbook, /npm run check:production:observability -- --production-env-file=\.env\.production/);
  assert.match(
    runbook,
    /npm run check:production:database -- --production-env-file=\.env\.production --expect-operational-sentinel/,
  );
  assert.match(
    runbook,
    /representative organisation, user, document, compliance, storage deletion, and Stripe webhook sentinel rows/,
  );
  assert.match(runbook, /npm run check:production:supabase -- --production-env-file=\.env\.production/);
  assert.match(runbook, /npm run check:production:providers -- --production-env-file=\.env\.production/);
  assert.match(runbook, /npm run check:production:evidence:init/);
  assert.match(runbook, /npm run check:production:evidence:init -- --json/);
  assert.match(runbook, /npm run check:production:browser-qa-env/);
  assert.match(runbook, /--evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/);
  assert.match(
    runbook,
    /npm run check:production:evidence:status -- --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    runbook,
    /npm run check:production:release-run -- --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    runbook,
    /npm run check:production:release-run -- --json --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    runbook,
    /machine-readable workflow identity, release binding, artifact name, pass\/fail, and issue details/,
  );
  assert.match(runbook, /GitHub API/);
  assert.match(
    runbook,
    /npm run check:production:evidence -- --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    runbook,
    /npm run check:production:evidence -- --json --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(runbook, /requires a `release` block binding the evidence to the promoted commit SHA/);
  assert.match(runbook, /\.github\/workflows\/release-images\.yml/);
  assert.match(runbook, /refs\/heads\/master/);
  assert.match(runbook, /refs\/tags\/v/);
  assert.match(runbook, /finalSignoff\.approvals/);
  assert.match(runbook, /engineering, operations, security, legal\/compliance, and business owners/);
  assert.match(runbook, /legalAndCompliance\.checks\.solicitor-governance-privacy-review/);
  assert.match(runbook, /GitHub Actions release workflow run URL/);
  assert.match(runbook, /digest-pinned API\/web\/migration image refs/);
  assert.match(runbook, /node dist\/jobs\/production-scheduler\.js/);
  assert.match(runbook, /node dist\/jobs\/send-deadline-reminders\.js/);
  assert.match(runbook, /node dist\/jobs\/cleanup-document-storage\.js/);
  assert.match(runbook, /failure-alert evidence/);
  assert.match(runbook, /--profile maintenance --profile jobs down --remove-orphans/);
  assert.match(runbook, /--profile maintenance run --rm --no-deps migrate/);
  assert.match(runbook, /old API, web, production scheduler, one-shot jobs, and Caddy proxy before any database change/);
  assert.match(runbook, /pre-migration backup is restore-verifiable/);
  assert.match(runbook, /runtime remains stopped/);
  assert.match(runbook, /--no-tls-proxy/);
  assert.match(runbook, /public HTTPS smoke/);
  assert.match(runbook, /Rollback reuses the same maintenance-mode deploy path/);
  assert.match(runbook, /Image-only rollback remains exceptional/);
  assert.match(runbook, /--database-restore-attestation-file/);
  assert.match(runbook, /0700.*0600/);
  assert.match(runbook, /encrypted off-host storage/);
  assert.match(runbook, /CHARITYPILOT_API_IMAGE=.*@sha256:/);
  assert.match(runbook, /CHARITYPILOT_WEB_IMAGE=.*@sha256:/);
  assert.match(runbook, /CHARITYPILOT_MIGRATION_IMAGE=.*@sha256:/);
  assert.match(runbook, /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL/);
  assert.doesNotMatch(runbook, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(runbook, /cosign verify/);
  assert.match(runbook, /Do not deploy mutable image tags/);

  assert.match(launchChecklist, /npm run deploy:preflight -- --production-env-file=\.env\.production/);
  assert.match(launchChecklist, /npm run deploy:production -- --production-env-file=\.env\.production/);
  assert.match(launchChecklist, /CHARITYPILOT_DATABASE_COMPATIBILITY=p006-deadline-calendar-v1/);
  assert.match(launchChecklist, /legacy manifest fails closed without.*`--database-restore-attestation-file`/);
  assert.match(launchChecklist, /approved encrypted storage/);
  assert.doesNotMatch(launchChecklist, /dry-run evidence capture/);
  assert.match(launchChecklist, /web image build origins match the promoted production public origins/);
  assert.match(launchChecklist, /npm run check:production:hosting -- --production-env-file=\.env\.production/);
  assert.match(launchChecklist, /npm run check:production:observability -- --production-env-file=\.env\.production/);
  assert.match(
    launchChecklist,
    /npm run check:production:database -- --production-env-file=\.env\.production --expect-operational-sentinel/,
  );
  assert.match(launchChecklist, /Operational sentinel restore test location/);
  assert.match(launchChecklist, /npm run check:production:supabase -- --production-env-file=\.env\.production/);
  assert.match(launchChecklist, /supabaseStorage\.checks\.supabase-backups-enabled/);
  assert.match(launchChecklist, /supabaseStorage\.checks\.supabase-restore-tested/);
  assert.match(launchChecklist, /npm run check:production:providers -- --production-env-file=\.env\.production/);
  assert.match(launchChecklist, /npm run check:production:evidence:init/);
  assert.match(launchChecklist, /npm run check:production:evidence:init -- --json/);
  assert.match(launchChecklist, /npm run check:production:browser-qa-env/);
  assert.match(launchChecklist, /\.charitypilot-launch-evidence\/production-launch-evidence\.json/);
  assert.match(
    launchChecklist,
    /npm run check:production:release-run -- --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    launchChecklist,
    /npm run check:production:release-run -- --json --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    launchChecklist,
    /machine-readable release workflow identity, artifact, release binding, and issue details/,
  );
  assert.match(launchChecklist, /GitHub API release-run verification output/);
  assert.match(
    launchChecklist,
    /npm run check:production:evidence -- --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    launchChecklist,
    /npm run check:production:evidence -- --json --evidence-file=\.charitypilot-launch-evidence\/production-launch-evidence\.json/,
  );
  assert.match(
    launchChecklist,
    /machine-readable strict validation status, issue list, completion counts, and next incomplete evidence hints/,
  );
  assert.match(launchChecklist, /Release workflow run URL/);
  assert.match(launchChecklist, /Release workflow file/);
  assert.match(launchChecklist, /\.github\/workflows\/release-images\.yml/);
  assert.match(launchChecklist, /Release git ref/);
  assert.match(launchChecklist, /Web image build origins/);
  assert.match(launchChecklist, /finalSignoff\.approvals/);
  assert.match(launchChecklist, /`engineering`, `operations`, `security`, `legalCompliance`, and `business` approvals/);
  assert.match(launchChecklist, /Solicitor, governance, and privacy review confirms/);
  assert.match(launchChecklist, /legalAndCompliance\.checks\.solicitor-governance-privacy-review/);
  assert.match(launchChecklist, /node dist\/jobs\/production-scheduler\.js/);
  assert.match(launchChecklist, /node dist\/jobs\/send-deadline-reminders\.js/);
  assert.match(launchChecklist, /node dist\/jobs\/cleanup-document-storage\.js/);
  assert.match(
    launchChecklist,
    /Failure alerts are tested for both `deadline-reminders` and `document-storage-cleanup`/,
  );
  assert.match(launchChecklist, /post-deploy public HTTPS smoke/);
  assert.match(launchChecklist, /rollback rehearsal/i);
  assert.match(launchChecklist, /digest-pinned/);
  assert.match(launchChecklist, /cosign signature verification/);
});

test('web Docker build requires only the production HTTPS API origin before Next build', () => {
  const dockerfile = readRepoFile('apps/web/Dockerfile');

  assertDockerfileUsesDigestPinnedNodeBase(dockerfile, 'apps/web/Dockerfile');
  assert.match(dockerfile, /ARG\s+NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /ENV\s+NEXT_PUBLIC_API_URL=\$NEXT_PUBLIC_API_URL/);
  assert.match(dockerfile, /requireOrigin\('NEXT_PUBLIC_API_URL'/);
  assert.doesNotMatch(dockerfile, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(dockerfile, /api\.charitypilot\.ie/);
  assert.match(dockerfile, /host\)=>host==='api\.charitypilot\.ie'/);
  assert.doesNotMatch(dockerfile, /host\.endsWith\('\.charitypilot\.ie'\)/);
  assert.match(dockerfile, /origin-only CharityPilot production URL/);
  assert.match(dockerfile, /RUN\s+npm run build -w @charitypilot\/web/);
  assert.match(dockerfile, /FROM\s+node:22-alpine@sha256:[a-f0-9]{64}\s+AS runtime-deps/);
  assert.match(
    dockerfile,
    /npm ci --omit=dev --omit=peer --workspace @charitypilot\/web --workspace @charitypilot\/shared --include-workspace-root=false/,
  );
  assert.doesNotMatch(dockerfile, /FROM build AS runtime-deps/);
  assert.doesNotMatch(dockerfile, /npm prune --omit=dev --omit=peer --workspaces/);
  assert.match(
    dockerfile,
    /rm -rf[\s\S]*node_modules\/typescript[\s\S]*node_modules\/eslint[\s\S]*node_modules\/turbo/,
  );
  assert.match(dockerfile, /COPY --chown=node:node --from=runtime-deps \/app\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node --from=build \/app\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /USER\s+node/);
});

test('web Docker runtime ships only compiled app artifacts', () => {
  const dockerfile = readRepoFile('apps/web/Dockerfile');
  const runnerStage = dockerfileStage(dockerfile, 'runner');

  assert.match(
    dockerfile,
    /rm -rf apps\/web\/\.next\/cache[\s\S]*apps\/web\/\.next\/export[\s\S]*apps\/web\/\.next\/export-detail\.json[\s\S]*apps\/web\/\.next\/server\/proxy\.js[\s\S]*apps\/web\/\.next\/server\/proxy\.js\.nft\.json/,
  );
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/apps\/web\/package\.json \.\/apps\/web\/package\.json/,
  );
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/apps\/web\/server\.mjs \.\/apps\/web\/server\.mjs/,
  );
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/apps\/web\/next\.config\.ts \.\/apps\/web\/next\.config\.ts/,
  );
  assert.match(runnerStage, /COPY --chown=node:node --from=build \/app\/apps\/web\/\.next \.\/apps\/web\/\.next/);
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/packages\/shared\/package\.json \.\/packages\/shared\/package\.json/,
  );
  assert.match(
    runnerStage,
    /COPY --chown=node:node --from=build \/app\/packages\/shared\/dist \.\/packages\/shared\/dist/,
  );
  assert.doesNotMatch(runnerStage, /COPY --chown=node:node --from=build \/app\/apps\/web \.\/apps\/web/);
  assert.doesNotMatch(runnerStage, /COPY --chown=node:node --from=build \/app\/packages\/shared \.\/packages\/shared/);
});

test('web server awaits request handling and closes cleanly on termination signals', () => {
  const server = readRepoFile('apps/web/server.mjs');

  assert.match(server, /const\s+server\s*=\s*createServer\(async\s*\(/);
  assert.match(server, /await\s+handle\(request,\s*response\)/);
  assert.match(server, /server\.close\(/);
  assert.match(server, /process\.once\('SIGTERM'/);
  assert.match(server, /process\.once\('SIGINT'/);
});

test('web server serializes caught production errors before logging them', () => {
  const server = readRepoFile('apps/web/server.mjs');

  assert.match(server, /function\s+serializeErrorForWebLog\(error\)/);
  assert.match(server, /function\s+redactLogText\(value\)/);
  assert.match(server, /\[redacted-email\]/);
  assert.match(server, /\$1=\[redacted\]/);
  assert.match(server, /\[redacted-path\]/);
  assert.match(server, /console\.error\('Next request handler failed:',\s*serializeErrorForWebLog\(error\)\)/);
  assert.match(server, /console\.error\('Graceful shutdown failed:',\s*serializeErrorForWebLog\(error\)\)/);
  assert.doesNotMatch(server, /console\.error\('Next request handler failed:',\s*error\)/);
  assert.doesNotMatch(server, /console\.error\('Graceful shutdown failed:',\s*error\)/);
});

test('web config disables generated agent-rule files during local dev startup', () => {
  const config = readRepoFile('apps/web/next.config.ts');
  const nextEnv = readRepoFile('apps/web/next-env.d.ts');
  const tsconfig = readRepoFile('apps/web/tsconfig.json');
  const webPackage = JSON.parse(readRepoFile('apps/web/package.json'));
  const fsRetry = readRepoFile('scripts/next-build-fs-retry.cjs');
  const cleanup = readRepoFile('scripts/clean-next-export.cjs');

  assert.match(nextEnv, /import "\.\/\.next\/types\/routes\.d\.ts";/);
  assert.doesNotMatch(nextEnv, /\.next-build-/);
  assert.doesNotMatch(tsconfig, /\.next-build-/);
  assert.match(webPackage.scripts.build, /--require \.\.\/\.\.\/scripts\/next-build-fs-retry\.cjs/);
  assert.match(webPackage.scripts.build, /&& node \.\.\/\.\.\/scripts\/clean-next-export\.cjs/);
  assert.match(fsRetry, /function isNextExportCleanup/);
  assert.match(fsRetry, /function isNextExportDetail/);
  assert.match(fsRetry, /function isNextProxyArtifactRename/);
  assert.match(fsRetry, /fs\.promises\.unlink = async function retryingUnlink/);
  assert.match(fsRetry, /fs\.promises\.rename = async function retryingRename/);
  assert.match(fsRetry, /sourceFile === 'proxy\.js' && destinationFile === 'middleware\.js'/);
  assert.match(fsRetry, /distDir === '\.next' \|\| distDir\.startsWith\('\.next-build'\)/);
  assert.match(cleanup, /function resolveNextDistDir\(\)/);
  assert.match(cleanup, /function sanitizeErrorMessage\(error\)/);
  assert.match(cleanup, /async function removeGeneratedArtifact/);
  assert.match(cleanup, /export-detail\.json/);
  assert.match(cleanup, /proxy\.js\.nft\.json/);
  assert.match(cleanup, /Refusing to clean unsafe Next export path/);
  assert.match(cleanup, /path\.basename\(target\)/);
  assert.match(cleanup, /Next cleanup failed: \$\{sanitizeErrorMessage\(error\)\}/);
  assert.doesNotMatch(cleanup, /console\.error\(error\)/);
  assert.doesNotMatch(cleanup, /\$\{error\.message\}/);
  assert.match(config, /agentRules:\s*false/);
  assert.match(config, /function resolveNextDistDir\(\): string/);
  assert.match(config, /NEXT_DIST_DIR\?\.trim\(\)/);
  assert.match(config, /\/\[\\\\\/\]\//);
  assert.match(config, /distDir:\s*resolveNextDistDir\(\)/);
  assert.match(config, /experimental:\s*\{\s*cpus:\s*1,\s*webpackBuildWorker:\s*false,\s*workerThreads:\s*true,\s*\}/);
  assert.match(config, /poweredByHeader:\s*false/);
  assert.match(webPackage.scripts.dev, /--webpack/);
  assert.equal(existsSync(join(repoRoot, 'apps/web/AGENTS.md')), false);
  assert.equal(existsSync(join(repoRoot, 'apps/web/CLAUDE.md')), false);
});

test('web development CSP allows the local Docker API port', () => {
  const csp = readRepoFile('apps/web/src/lib/content-security-policy.ts');

  assert.match(csp, /http:\/\/localhost:3002/);
  assert.doesNotMatch(csp, /http:\/\/localhost:3001/);
});

test('web production CSP uses per-request script nonces without unsafe inline execution', () => {
  const config = readRepoFile('apps/web/next.config.ts');
  const csp = readRepoFile('apps/web/src/lib/content-security-policy.ts');

  assert.doesNotMatch(config, /script-src[^;\n]*'unsafe-inline'/);
  assert.match(csp, /function productionApiConnectSource\(apiUrl\?: string\): string/);
  assert.match(csp, /url\.origin === normalizedConfiguredUrl/);
  assert.match(csp, /url\.origin === DEFAULT_PRODUCTION_API_ORIGIN/);
  assert.doesNotMatch(csp, /apiUrl\?\.trim\(\) \|\| 'https:\/\/api\.charitypilot\.ie'/);
  assert.match(csp, /const scriptSrc = \[`'self'`, `'nonce-\$\{nonce\}'`, "'strict-dynamic'"\]/);
  assert.match(csp, /if \(isDevelopment\) \{\s*scriptSrc\.push\("'unsafe-eval'"\);\s*\}/);
  assert.match(csp, /`script-src \$\{scriptSrc\.join\(' '\)\}`/);
  assert.doesNotMatch(csp, /scriptSrc\.push\("'unsafe-inline'"\)/);
  assert.doesNotMatch(csp, /script-src[^`]*'unsafe-inline'/);
  assert.ok(
    csp.indexOf('scriptSrc.push("\'unsafe-eval\'")') > csp.indexOf('if (isDevelopment)'),
    'unsafe-eval must only be added in development',
  );
});

test('web executable inline scripts are nonce-bound for strict production CSP', () => {
  const layout = readRepoFile('apps/web/src/app/layout.tsx');
  const jsonLd = readRepoFile('apps/web/src/components/json-ld.tsx');
  const proxy = readRepoFile('apps/web/src/proxy.ts');

  assert.match(layout, /nonce=\{nonce\}/);
  assert.match(layout, /headers\(\)/);
  assert.match(jsonLd, /nonce=\{nonce\}/);
  assert.match(proxy, /requestHeaders\.set\(["']x-nonce["'], nonce\)/);
  assert.match(proxy, /Content-Security-Policy/);
});

test('web nonce-bearing scripts suppress hydration comparison for browser-masked nonces', () => {
  const layout = readRepoFile('apps/web/src/app/layout.tsx');
  const jsonLd = readRepoFile('apps/web/src/components/json-ld.tsx');

  assert.match(layout, /<script\s+nonce=\{nonce\}\s+suppressHydrationWarning\s+dangerouslySetInnerHTML=/);

  const nonceJsonLdScripts = jsonLd.match(/<script[\s\S]*?nonce=\{nonce\}[\s\S]*?dangerouslySetInnerHTML=/g) ?? [];
  assert.equal(nonceJsonLdScripts.length, 3);

  for (const script of nonceJsonLdScripts) {
    assert.match(script, /suppressHydrationWarning/);
  }
});

test('web route protection uses the Next proxy convention instead of deprecated middleware', () => {
  assert.equal(existsSync(join(repoRoot, 'apps/web/src/middleware.ts')), false);
  assert.equal(existsSync(join(repoRoot, 'apps/web/src/proxy.ts')), true);

  const proxy = readRepoFile('apps/web/src/proxy.ts');
  assert.match(proxy, /export async function proxy\(request: NextRequest\)/);
  assert.match(proxy, /export const config\s*=/);
  assert.doesNotMatch(proxy, /export function middleware/);
});

test('web email verification flow supports generic registration and unverified signed-in users', () => {
  const authContext = readRepoFile('apps/web/src/lib/auth-context.tsx');
  const loginPage = readRepoFile('apps/web/src/app/(auth)/login/page.tsx');
  const safeNextPath = readRepoFile('apps/web/src/lib/safe-next-path.ts');
  const safeNextPathTest = readRepoFile('apps/web/src/lib/safe-next-path.test.ts');
  const registerPage = readRepoFile('apps/web/src/app/(auth)/register/page.tsx');
  const dashboardLayout = readRepoFile('apps/web/src/app/(dashboard)/layout.tsx');
  const verifyEmailPage = readRepoFile('apps/web/src/app/(auth)/verify-email/page.tsx');
  const refreshUserBlock = authContext.match(/const refreshUser = useCallback[\s\S]*?\n  }, \[\]\);/)?.[0] ?? '';

  assert.match(authContext, /login:\s*\([^)]*\)\s*=>\s*Promise<UserResponse>/);
  assert.match(authContext, /register:\s*\([^)]*\)\s*=>\s*Promise<void>/);
  assert.ok(refreshUserBlock, 'auth context must define refreshUser');
  assert.doesNotMatch(
    refreshUserBlock,
    /skipAuthRefresh:\s*true/,
    'auth bootstrap must allow refresh-cookie-only sessions to refresh before reporting logged out',
  );
  assert.match(loginPage, /import \{ safeNextPath \} from '@\/lib\/safe-next-path'/);
  assert.match(
    safeNextPath,
    /export function safeNextPath\(nextPath: string \| null, origin = currentOrigin\(\)\): string/,
  );
  assert.match(safeNextPath, /new URL\(nextPath, baseOrigin\)/);
  assert.match(safeNextPath, /destination\.origin !== baseOrigin/);
  assert.match(safeNextPath, /isProtectedAppPath\(path\)/);
  assert.match(safeNextPathTest, /\/%5C%5Cevil\.example/);
  assert.match(safeNextPathTest, /\/%2F%2Fevil\.example/);
  assert.match(loginPage, /new URLSearchParams\(window\.location\.search\)\.get\('next'\)/);
  assert.match(loginPage, /user\.emailVerified\s*\?\s*safeNextPath\(nextPath\)\s*:\s*'\/verify-email'/);
  assert.match(loginPage, /router\.push\(loginDestination\(user\)\)/);
  assert.match(registerPage, /await register\(\{ name, email, password, organisationName \}\)/);
  assert.match(registerPage, /router\.push\('\/verify-email'\)/);
  assert.match(dashboardLayout, /!user\.emailVerified[\s\S]*router\.replace\('\/verify-email'\)/);
  assert.match(verifyEmailPage, /type Status = 'loading' \| 'pending' \| 'success' \| 'error'/);
  assert.match(verifyEmailPage, /status === 'pending'/);
  assert.match(verifyEmailPage, /api\.post\('\/auth\/resend-verification'/);
  assert.match(verifyEmailPage, /\{user && \(/);
  assert.match(verifyEmailPage, /href=\{user \? '\/dashboard' : '\/login'\}/);
  assert.match(verifyEmailPage, /\{user \? 'Continue to dashboard' : 'Go to sign in'\}/);
  assert.match(verifyEmailPage, /Resend verification email/);
  assert.doesNotMatch(verifyEmailPage, /No verification token found/);
});

test('billing page fails closed without exposing internal production setup gaps', () => {
  const billingPage = [
    readRepoFile('apps/web/src/app/(dashboard)/billing/page.tsx'),
    readRepoFile('apps/web/src/app/(dashboard)/billing/billing-plan-sections.tsx'),
  ].join('\n');

  assert.doesNotMatch(billingPage, /Stripe is not production-ready yet/);
  assert.doesNotMatch(billingPage, /secret key|webhook secret|price IDs/i);
  assert.match(billingPage, /Billing setup is temporarily unavailable/);
  assert.match(billingPage, /Please contact support to change your plan/);
  assert.match(billingPage, /isDisabled=\{[^}]*!billingConfigured[^}]*\}/);
});

test('billing API unavailable errors do not expose internal Stripe configuration names', () => {
  const billingService = readRepoFile('apps/api/src/services/billing.service.ts');

  assert.doesNotMatch(billingService, /Stripe secret key is not configured/);
  assert.doesNotMatch(billingService, /Stripe webhook secret is not configured/);
  assert.doesNotMatch(billingService, /Stripe price ID is not configured/);
  assert.match(billingService, /BILLING_UNAVAILABLE_MESSAGE/);
  assert.match(billingService, /Billing is temporarily unavailable/);
});

test('Stripe webhook processing does not hold a DB transaction across provider I/O', () => {
  const billingService = readRepoFile('apps/api/src/services/billing.service.ts');
  const handleWebhook = billingService.match(/async handleWebhook\(event: Stripe\.Event\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const transactionBody = handleWebhook.match(/this\.prisma\.\$transaction[\s\S]*?\n    \}\);/)?.[0] ?? '';
  const checkoutHandler = billingService.match(/private async handleCheckoutCompleted[\s\S]*?\n  \}/)?.[0] ?? '';

  assert.ok(handleWebhook, 'handleWebhook must exist');
  assert.ok(transactionBody, 'handleWebhook must use a transaction for ledger plus local mutation');
  assert.match(billingService, /private async resolveCheckoutSubscription/);
  assert.match(billingService, /private async hasProcessedWebhookEvent/);
  assert.ok(
    handleWebhook.indexOf('resolveCheckoutSubscription') < handleWebhook.indexOf('this.prisma.$transaction'),
    'Stripe subscription retrieval must happen before opening the local DB transaction',
  );
  assert.doesNotMatch(transactionBody, /subscriptions\.retrieve/);
  assert.doesNotMatch(checkoutHandler, /subscriptions\.retrieve/);
  assert.doesNotMatch(checkoutHandler, /stripe:\s*Stripe/);
});

test('storage API unavailable errors do not expose internal Supabase configuration names', () => {
  const storageService = readRepoFile('apps/api/src/services/storage.service.ts');

  assert.doesNotMatch(storageService, /Supabase storage is not configured/);
  assert.match(storageService, /STORAGE_UNAVAILABLE_MESSAGE/);
  assert.match(storageService, /Document storage is temporarily unavailable/);
});

test('email delivery logs do not include recipient or subject PII', () => {
  const emailService = readRepoFile('apps/api/src/services/email.service.ts');
  const logStatements = emailService.match(/this\.logger\.(?:warn|error)\([^;]+;/g) ?? [];

  assert.ok(logStatements.length > 0, 'email service should keep operational delivery logs');
  assert.doesNotMatch(emailService, /console\.(?:warn|error)\(/);
  for (const statement of logStatements) {
    assert.doesNotMatch(statement, /\bsubject\b/);
    assert.doesNotMatch(statement, /\$\{to\}/);
    assert.doesNotMatch(statement, /,\s*err\)/);
  }
  assert.match(emailService, /formatEmailDeliveryError/);
});

test('public API user and organisation responses omit internal provider and credential fields', () => {
  const publicDtos = readRepoFile('apps/api/src/utils/public-dtos.ts');
  const authService = readRepoFile('apps/api/src/services/auth.service.ts');
  const teamService = readRepoFile('apps/api/src/services/team.service.ts');
  const organisationService = readRepoFile('apps/api/src/services/organisation.service.ts');
  const authRoutes = readRepoFile('apps/api/src/routes/auth/index.ts');
  const teamRoutes = readRepoFile('apps/api/src/routes/team/index.ts');

  for (const content of [publicDtos, authService, teamService, organisationService, authRoutes, teamRoutes]) {
    assert.doesNotMatch(content, /organisation:\s*true/);
    assert.doesNotMatch(content, /organisation:\s*user\.organisation/);
    assert.doesNotMatch(content, /organisation:\s*result\.user\.organisation/);
  }

  assert.match(publicDtos, /publicOrganisationSelect/);
  assert.match(publicDtos, /export function publicOrganisation/);
  assert.match(publicDtos, /export function publicUser/);
  assert.doesNotMatch(publicDtos, /stripeCustomerId:\s*true/);
  assert.doesNotMatch(publicDtos, /passwordHash:\s*true/);
  assert.doesNotMatch(publicDtos, /resetToken:\s*true/);
  assert.doesNotMatch(publicDtos, /verifyToken:\s*true/);

  assert.match(
    authService,
    /organisation:\s*\{\s*select:\s*\{\s*\.\.\.publicOrganisationSelect,\s*lifecycleStatus:\s*true/,
  );
  assert.match(teamService, /organisation:\s*\{\s*select:\s*publicOrganisationSelect\s*\}/);
  assert.match(organisationService, /select:\s*publicOrganisationSelect/);
  assert.match(authRoutes, /publicUser\(result\.user\)/);
  assert.match(authRoutes, /publicUser\(user\)/);
  assert.match(teamRoutes, /publicUser\(result\.user\)/);
});

test('refresh and logout auth endpoints have route-specific throttles', () => {
  const authRoutes = readRepoFile('apps/api/src/routes/auth/index.ts');
  const identifierRateLimit = readRepoFile('apps/api/src/utils/identifier-rate-limit.ts');

  assert.match(authRoutes, /refreshTokenRateLimit/);
  assert.match(
    authRoutes,
    /app\.post\(\s*["']\/refresh["'],\s*\{\s*config:\s*\{\s*rateLimit:\s*refreshTokenRateLimit\(5\)\s*\}\s*\}/,
  );
  assert.match(
    authRoutes,
    /app\.post\(\s*["']\/logout["'],\s*\{\s*config:\s*\{\s*rateLimit:\s*refreshTokenRateLimit\(10\)\s*\}\s*\}/,
  );
  assert.match(identifierRateLimit, /REFRESH_TOKEN_COOKIE/);
  assert.match(identifierRateLimit, /body\.refreshToken/);
  assert.match(identifierRateLimit, /export function refreshTokenRateLimit\(max = 5\)/);
  assert.match(identifierRateLimit, /hook:\s*["']preHandler["']/);
});

test('API access tokens pin their JWT algorithm', () => {
  const jwtUtil = readRepoFile('apps/api/src/utils/jwt.ts');

  assert.match(jwtUtil, /const ACCESS_TOKEN_ALGORITHM = 'HS256'/);
  assert.match(jwtUtil, /const ACCESS_TOKEN_ISSUER = 'charitypilot-api'/);
  assert.match(jwtUtil, /const ACCESS_TOKEN_AUDIENCE = 'charitypilot-web'/);
  assert.match(jwtUtil, /jwt\.sign\(payload,\s*JWT_SECRET,\s*\{[\s\S]*algorithm:\s*ACCESS_TOKEN_ALGORITHM/);
  assert.match(jwtUtil, /jwt\.sign\(payload,\s*JWT_SECRET,\s*\{[\s\S]*issuer:\s*ACCESS_TOKEN_ISSUER/);
  assert.match(jwtUtil, /jwt\.sign\(payload,\s*JWT_SECRET,\s*\{[\s\S]*audience:\s*ACCESS_TOKEN_AUDIENCE/);
  assert.match(jwtUtil, /jwt\.verify\(token,\s*JWT_SECRET,\s*\{[\s\S]*algorithms:\s*\[ACCESS_TOKEN_ALGORITHM\]/);
  assert.match(jwtUtil, /jwt\.verify\(token,\s*JWT_SECRET,\s*\{[\s\S]*issuer:\s*ACCESS_TOKEN_ISSUER/);
  assert.match(jwtUtil, /jwt\.verify\(token,\s*JWT_SECRET,\s*\{[\s\S]*audience:\s*ACCESS_TOKEN_AUDIENCE/);
  assert.doesNotMatch(jwtUtil, /jwt\.verify\(token,\s*JWT_SECRET\);/);
});

test('team invite flows keep account enumeration and duplicate active invites guarded', () => {
  const authRoutes = readRepoFile('apps/api/src/routes/auth/index.ts');
  const teamRoutes = readRepoFile('apps/api/src/routes/team/index.ts');
  const authService = readRepoFile('apps/api/src/services/auth.service.ts');
  const teamService = readRepoFile('apps/api/src/services/team.service.ts');
  const migration = readRepoFile(
    'apps/api/prisma/migrations/20260608053000_add_active_team_invite_unique_index/migration.sql',
  );

  assert.match(authRoutes, /reply\.status\(202\)\.send\(result\)/);
  assert.doesNotMatch(authRoutes, /setAuthCookies\(reply, result\)[\s\S]*\/register/);
  assert.match(authService, /REGISTRATION_ACCEPTED_MESSAGE/);
  assert.match(authService, /isUniqueConstraintError/);
  assert.match(teamRoutes, /reply\.status\(202\)\.send\(invite\)/);
  assert.match(teamService, /TEAM_INVITE_ACCEPTED_MESSAGE/);
  assert.match(teamService, /isUniqueConstraintError/);
  assert.match(teamService, /expiresAt:\s*\{\s*lte:\s*now\s*\}/);
  assert.match(teamService, /catch \(err\)[\s\S]*isUniqueConstraintError\(err\)[\s\S]*return inviteAccepted\(\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "TeamInvite_active_email_unique"/);
  assert.match(migration, /ON "TeamInvite"\("organisationId", "email"\)/);
  assert.match(migration, /WHERE "acceptedAt" IS NULL\s+AND "revokedAt" IS NULL/);
});

test('production migrations install governance code reference data', () => {
  const migrationsDir = join(repoRoot, 'apps/api/prisma/migrations');
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(join(migrationsDir, entry.name, 'migration.sql'), 'utf8'));

  const migration = migrations.find(
    (content) =>
      content.includes('Seed governance code reference data') &&
      content.includes('"GovernancePrinciple"') &&
      content.includes('"GovernanceStandard"') &&
      content.includes('ON CONFLICT ("number")') &&
      content.includes('ON CONFLICT ("code")'),
  );

  assert.ok(migration, 'production migrations must seed governance reference data');
  assert.equal((migration.match(/\('governance-principle-/g) ?? []).length, 6);
  assert.equal((migration.match(/\('governance-standard-/g) ?? []).length, 49);
  const principleConflictBlock = migration.match(/ON CONFLICT \("number"\) DO UPDATE SET([\s\S]*?);/)?.[1] ?? '';
  const standardConflictBlock = migration.match(/ON CONFLICT \("code"\) DO UPDATE SET([\s\S]*?);/)?.[1] ?? '';
  assert.match(migration, /"description"\s+=\s+EXCLUDED\."description"/);
  assert.match(migration, /"principleId"\s+=\s+EXCLUDED\."principleId"/);
  assert.match(migration, /ON principles\."number"\s+=\s+standards\.principle_number/);
  assert.doesNotMatch(
    principleConflictBlock,
    /"id"\s*=/,
    'principle upserts must preserve existing IDs so legacy references remain valid',
  );
  assert.doesNotMatch(
    standardConflictBlock,
    /"id"\s*=/,
    'standard upserts must preserve existing IDs so compliance and document links remain valid',
  );
});

test('web proxy preserves protected-route redirect and no-cache behavior', () => {
  const proxy = readRepoFile('apps/web/src/proxy.ts');
  const redirectStart = proxy.indexOf('function redirectToLogin(');
  const redirectEnd = proxy.indexOf('\nfunction authenticationUnavailable(', redirectStart);
  const redirectToLogin =
    redirectStart >= 0 && redirectEnd > redirectStart ? proxy.slice(redirectStart, redirectEnd) : '';
  const publicStart = proxy.indexOf('if (!isProtectedAppPath(pathname))');
  const protectedStart = proxy.indexOf('if (!hasAuthSessionCookie(request))', publicStart);
  const publicBranch = publicStart >= 0 && protectedStart > publicStart ? proxy.slice(publicStart, protectedStart) : '';
  const protectedBranch = protectedStart >= 0 ? proxy.slice(protectedStart) : '';

  assert.ok(redirectToLogin, 'proxy must keep a dedicated login redirect helper');
  assert.match(redirectToLogin, /loginUrl\.pathname = ["']\/login["']/);
  assert.match(redirectToLogin, /loginUrl\.search = ["']["']/);
  assert.match(redirectToLogin, /loginUrl\.searchParams\.set\(["']next["'], `\$\{pathname\}\$\{search\}`\)/);
  assert.match(redirectToLogin, /NextResponse\.redirect\(loginUrl\)/);
  assert.match(redirectToLogin, /addProtectedNoCacheHeaders\(response\)/);
  assert.match(proxy, /const PROTECTED_RESPONSE_CACHE_CONTROL = ["']no-store, no-cache, must-revalidate["']/);
  assert.match(proxy, /response\.headers\.set\(["']Cache-Control["'], PROTECTED_RESPONSE_CACHE_CONTROL\)/);
  assert.match(proxy, /response\.headers\.set\(["']Pragma["'], ["']no-cache["']\)/);

  assert.ok(protectedBranch, 'protected branch must exist');
  assert.match(protectedBranch, /return redirectToLogin\(request, csp\)/);
  assert.match(protectedBranch, /await validateProtectedAuthSession\(request\)/);
  assert.match(protectedBranch, /addProtectedNoCacheHeaders\(\s*NextResponse\.next/);

  assert.ok(publicBranch, 'public branch must exist');
  assert.match(publicBranch, /NextResponse\.next/);
  assert.doesNotMatch(publicBranch, /addProtectedNoCacheHeaders/);
  assert.match(
    publicBranch,
    /isSensitiveAuthPath\(pathname\)\s*\?\s*addSensitiveAuthHeaders\(responseWithCsp\)\s*:\s*responseWithCsp/,
  );
});

test('web proxy validates protected sessions with API auth authority before rendering', () => {
  const proxy = readRepoFile('apps/web/src/proxy.ts');
  const protectedBranch =
    proxy.match(/if \(!hasAuthSessionCookie\(request\)\)[\s\S]*?const requestHeaders = createCspRequestHeaders/)?.[0] ??
    '';

  assert.match(proxy, /export async function proxy\(request: NextRequest\)/);
  assert.match(proxy, /import \{ getServerApiBaseUrl \} from ["']\.\/lib\/api-config["']/);
  assert.match(proxy, /new URL\(pathname,\s*getServerApiBaseUrl\(\)\)/);
  assert.doesNotMatch(proxy, /process\.env\.NEXT_PUBLIC_API_URL\?\.trim\(\)\s*\|\|/);
  assert.match(proxy, /type ProtectedAuthSession\s*=/);
  assert.match(proxy, /state:\s*["']authenticated["'];\s*setCookieHeaders:\s*string\[\]/);
  assert.match(proxy, /state:\s*["']unauthenticated["'];\s*setCookieHeaders:\s*string\[\]/);
  assert.match(proxy, /state:\s*["']unavailable["'];\s*setCookieHeaders:\s*\[\];\s*retryAfter:\s*string/);
  assert.match(proxy, /async function validateProtectedAuthSession\(/);
  assert.match(proxy, /\): Promise<ProtectedAuthSession> \{/);
  assert.match(proxy, /createApiAuthUrl\(["']\/api\/v1\/auth\/me["']\)/);
  assert.match(proxy, /createApiAuthUrl\(["']\/api\/v1\/auth\/refresh["']\)/);
  assert.match(proxy, /fetch\(authUrl/);
  assert.match(proxy, /fetch\(refreshUrl/);
  assert.match(proxy, /cache:\s*["']no-store["']/);
  assert.match(proxy, /redirect:\s*["']manual["']/);
  assert.equal(
    (proxy.match(/signal:\s*AbortSignal\.timeout\(AUTH_VALIDATION_TIMEOUT_MS\)/g) ?? []).length,
    2,
    'both auth authority requests must have a bounded timeout',
  );
  assert.match(proxy, /if \(response\.status !== 401\) return unavailableAuthSession\(response\)/);
  assert.equal(
    (proxy.match(/response\.status === 200/g) ?? []).length,
    2,
    'both auth authority responses must require exact HTTP 200',
  );
  assert.doesNotMatch(proxy, /response\.ok/);
  assert.match(proxy, /validatedAuthCookieHeaders\(\s*response\.headers,\s*["']rotation["']/);
  assert.match(
    proxy,
    /response\.status === 401[\s\S]*?validatedAuthCookieHeaders\(\s*response\.headers,\s*["']deletion["']/,
  );
  assert.match(proxy, /getSetCookie\.call\(headers\)\.map/);
  assert.doesNotMatch(proxy, /getSetCookie\.call\(headers\)\.flatMap/);
  assert.match(proxy, /COOKIE_HEADER_CONTROL_PATTERN/);
  assert.match(proxy, /selectedCookies\.some\(\(cookies\) => cookies\.length !== 1\)/);
  assert.match(proxy, /status:\s*503/);
  assert.match(
    protectedBranch,
    /authSession\.state === ["']unavailable["'][\s\S]*?authenticationUnavailable\(csp, authSession\.retryAfter\)/,
  );
  assert.match(
    protectedBranch,
    /authSession\.state === ["']unauthenticated["'][\s\S]*?redirectToLogin\(request, csp, authSession\.setCookieHeaders\)/,
  );
  assert.match(proxy, /protectedAuthCookieHeader\(request\)/);
  assert.match(proxy, /Cookie:\s*cookieHeader/);
  assert.match(proxy, /addSetCookieHeaders\(response,\s*authSession\.setCookieHeaders\)/);
  assert.ok(protectedBranch, 'protected proxy branch must still check missing auth cookies first');
  assert.match(protectedBranch, /await validateProtectedAuthSession\(request\)/);
  assert.ok(
    protectedBranch.indexOf('await validateProtectedAuthSession(request)') <
      protectedBranch.indexOf('const requestHeaders = createCspRequestHeaders'),
    'protected content must not render until the API auth session check succeeds',
  );
});

test('sensitive URL token helper prefers fragment tokens over query tokens', () => {
  const urlSecurity = readRepoFile('apps/web/src/lib/url-security.ts');
  const helperBody = urlSecurity.match(/export function getSensitiveUrlToken[\s\S]*?\n}/)?.[0] ?? '';

  assert.ok(helperBody, 'getSensitiveUrlToken helper must exist');
  assert.match(helperBody, /const fragmentToken = hashSearchParams\(url\)\?\.get\(paramName\)/);
  assert.match(helperBody, /if \(fragmentToken\) return fragmentToken/);
  assert.ok(
    helperBody.indexOf('fragmentToken') < helperBody.indexOf('queryToken'),
    'fragment token must be read before query token so URL fragments remain authoritative',
  );
});

test('document download trust permits only the exact CharityPilot API download route', () => {
  const urlSecurity = readRepoFile('apps/web/src/lib/url-security.ts');

  assert.match(urlSecurity, /function isDocumentDownloadRoute/);
  assert.match(urlSecurity, /NEXT_PUBLIC_API_URL/);
  assert.match(urlSecurity, /https:\/\/api\.charitypilot\.ie/);
  assert.doesNotMatch(urlSecurity, /SUPABASE|storage\/v1\/object\/sign/i);
});

test('document metadata responses do not expose internal storage object keys', () => {
  const sharedApiTypes = readRepoFile('packages/shared/src/types/api.ts');
  const documentService = readRepoFile('apps/api/src/services/document.service.ts');
  const documentRoutes = readRepoFile('apps/api/src/routes/documents/index.ts');

  const documentResponse = sharedApiTypes.match(/export interface DocumentResponse \{[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(documentResponse, 'DocumentResponse type must exist');
  assert.doesNotMatch(documentResponse, /fileUrl/);

  assert.match(documentService, /function publicDocument/);
  assert.match(documentService, /data\.map\(publicDocument\)/);
  assert.match(documentService, /return publicDocument\(doc\)/);
  assert.match(documentService, /async getDownloadDescriptor/);
  assert.doesNotMatch(documentService, /return doc;\s*$/m);
  assert.match(
    documentRoutes,
    /service\.getDownloadDescriptor\(\s*request\.user\.organisationId,\s*request\.params\.id,?\s*\)/,
  );
  assert.match(documentRoutes, /storageService\.downloadFile\(/);
  assert.doesNotMatch(documentRoutes, /doc\.fileUrl/);
});

test('storage provider failures are sanitized before logs and retry state', () => {
  const providerErrors = readRepoFile('apps/api/src/utils/provider-errors.ts');
  const documentService = readRepoFile('apps/api/src/services/document.service.ts');
  const documentRoutes = readRepoFile('apps/api/src/routes/documents/index.ts');
  const storageService = readRepoFile('apps/api/src/services/storage.service.ts');

  assert.match(providerErrors, /export function formatProviderError/);
  assert.match(providerErrors, /\$1=\[redacted\]/);
  assert.match(providerErrors, /\[email\]/);
  assert.match(providerErrors, /\[storage-path\]/);
  assert.match(documentService, /formatProviderError\(error\)/);
  assert.doesNotMatch(documentService, /function errorMessage/);
  assert.doesNotMatch(documentService, /lastError:\s*errorMessage\(error\)/);
  assert.match(documentRoutes, /formatProviderError\(cleanupError\)/);
  assert.match(documentRoutes, /formatProviderError\(outboxError\)/);
  assert.doesNotMatch(documentRoutes, /request\.log\.error\(cleanupError/);
  assert.doesNotMatch(documentRoutes, /request\.log\.error\(outboxError/);
  assert.doesNotMatch(storageService, /Failed to upload file: \$\{error\.message\}/);
  assert.doesNotMatch(storageService, /Failed to download file: \$\{error\?\.message/);
  assert.doesNotMatch(storageService, /Failed to delete file: \$\{error\.message\}/);
});

test('client code uses production-safe logging instead of raw error objects', () => {
  const clientFiles = repoFilesUnder('apps/web/src')
    .filter((file) => /\.(?:ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.(?:ts|tsx)$/.test(file))
    .filter((file) => file.replace(/\\/g, '/') !== 'apps/web/src/lib/client-logger.ts');

  for (const file of clientFiles) {
    const content = readRepoFile(file);
    assert.doesNotMatch(
      content,
      /console\.error\([\s\S]*?\b(?:err|error)\b[\s\S]*?\);/,
      `${file} must use logClientError instead of logging raw browser error objects`,
    );
  }

  const logger = readRepoFile('apps/web/src/lib/client-logger.ts');
  assert.match(logger, /export function logClientError/);
  assert.match(logger, /process\.env\.NODE_ENV !== 'production'/);
  assert.match(logger, /console\.error\(message, error\)/);
  assert.match(logger, /console\.error\(`\$\{message\}: \$\{clientErrorSummary\(error\)\}`\)/);
});

test('web proxy transitions legacy query auth tokens to URL fragments before render', () => {
  const proxy = readRepoFile('apps/web/src/proxy.ts');

  assert.match(proxy, /function redirectSensitiveQueryToken/);
  assert.match(proxy, /request\.nextUrl\.searchParams\.get\(["']token["']\)/);
  assert.match(proxy, /redirectUrl\.searchParams\.delete\(["']token["']\)/);
  assert.match(proxy, /fragmentParams\.set\(["']token["'], token\)/);
  assert.match(proxy, /redirectUrl\.hash = fragmentParams\.toString\(\)/);
  assert.match(proxy, /NextResponse\.redirect\(redirectUrl\)/);
  assert.match(proxy, /redirectSensitiveQueryToken\(request, csp\)/);
});

test('web export refreshes authentication before opening an isolated CSP-protected report blob', () => {
  const exportPage = [
    readRepoFile('apps/web/src/app/(dashboard)/export/page.tsx'),
    readRepoFile('apps/web/src/app/(dashboard)/export/use-export-workflow.ts'),
    readRepoFile('apps/web/src/lib/authenticated-report-open.ts'),
  ].join('\n');
  const reportRenderer = readRepoFile('apps/api/src/routes/export/compliance-report-html.ts');

  assert.match(exportPage, /api\.get\('\/export\/compliance-report',[\s\S]*responseType:\s*'blob'/);
  assert.match(exportPage, /openPopup:\s*\(\)\s*=>\s*window\.open\('',\s*'_blank'\)/);
  assert.match(exportPage, /popup\.opener\s*=\s*null/);
  assert.match(exportPage, /URL\.createObjectURL/);
  assert.match(exportPage, /URL\.revokeObjectURL/);
  assert.match(reportRenderer, /http-equiv="Content-Security-Policy"/);
  assert.match(reportRenderer, /default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(exportPage, /api\.getUri/);
  assert.doesNotMatch(exportPage, /new Blob\(/);
});

test('registers page handles Complete-plan denial as an upgrade state', () => {
  const registersPage = [
    readRepoFile('apps/web/src/app/(dashboard)/registers/page.tsx'),
    readRepoFile('apps/web/src/app/(dashboard)/registers/use-registers-workflow.ts'),
  ].join('\n');

  assert.match(registersPage, /isPlanFeatureUnavailable/);
  assert.match(registersPage, /setPlanUnavailable\(true\)/);
  assert.match(registersPage, /Complete plan/);
  assert.match(registersPage, /href="\/billing"/);
  assert.doesNotMatch(
    registersPage,
    /toast\('Failed to load governance registers', 'error'\);[\s\S]*PLAN_FEATURE_UNAVAILABLE/,
  );
});

test('web document upload picker does not advertise legacy Office formats', () => {
  const documentUploadSurface = [
    readRepoFile('apps/web/src/app/(dashboard)/documents/page.tsx'),
    readRepoFile('apps/web/src/app/(dashboard)/documents/document-upload-modal.tsx'),
  ].join('\n');

  assert.doesNotMatch(documentUploadSurface, /accept="[^"]*\.(doc|xls|ppt)(,|")/);
  assert.match(documentUploadSurface, /\.docx/);
  assert.match(documentUploadSurface, /\.xlsx/);
  assert.match(documentUploadSurface, /\.pptx/);
});

test('CI deploys Prisma migrations against PostgreSQL before release gates', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.doesNotMatch(workflow, /^\s+services:\s*$/m);
  assert.match(workflow, /DATABASE_URL:\s+postgresql:\/\/charitypilot:charitypilot_ci@localhost:5432\/charitypilot_ci/);
  assert.match(workflow, /node scripts\/start-ci-postgres\.mjs/);
  assert.match(workflow, /prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  assert.match(workflow, /prisma migrate status --schema apps\/api\/prisma\/schema\.prisma/);
});

test('CI starts PostgreSQL after checkout with repo-owned retry logic', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.doesNotMatch(
    workflow,
    /^\s+services:\s*$/m,
    'CI must not use service containers that can fail before checkout',
  );
  assert.match(workflow, /name:\s+Start PostgreSQL/);
  assert.match(workflow, /node scripts\/start-ci-postgres\.mjs/);
  assert.match(workflow, /name:\s+Stop PostgreSQL/);
  assert.match(workflow, /if:\s+always\(\)/);
  assert.ok(
    workflow.indexOf('name: Checkout') < workflow.indexOf('name: Start PostgreSQL'),
    'PostgreSQL startup must happen after checkout so retry behavior is repo-controlled',
  );
  assert.ok(
    workflow.indexOf('name: Start PostgreSQL') < workflow.indexOf('name: Deploy Prisma migrations'),
    'PostgreSQL must start before migrations deploy',
  );
});

test('CI verifies PostgreSQL backup and restore against the migrated database', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');
  const backupScript = readRepoFile('scripts/postgres-backup.mjs');
  const stepStart = workflow.indexOf('name: Verify PostgreSQL backup and restore');
  assert.notEqual(stepStart, -1, 'CI must verify database backup and restore');
  const step = workflow.slice(stepStart, workflow.indexOf('name: Lint'));

  assert.match(backupScript, /allow-remote-sentinel/);
  assert.match(backupScript, /Refusing to seed restore sentinel into a non-local database URL/);
  assert.match(backupScript, /isLocalDatabaseUrl\(databaseUrl\)/);
  assert.match(step, /backup_dir="\$\(mktemp -d\)"/);
  assert.match(step, /node scripts\/postgres-backup\.mjs seed-restore-sentinel/);
  assert.match(step, /node scripts\/postgres-backup\.mjs backup/);
  assert.match(step, /--database-url="\$\{DATABASE_URL\}"/);
  assert.match(step, /--docker-network=host/);
  assert.match(step, /--output-file=ci-postgres\.dump/);
  assert.match(step, /node scripts\/postgres-backup\.mjs verify-restore/);
  assert.match(step, /--dump-file="\$\{backup_dir\}\/ci-postgres\.dump"/);
  assert.match(step, /--expect-operational-sentinel/);
  assert.ok(
    step.indexOf('seed-restore-sentinel') < step.indexOf('postgres-backup.mjs backup'),
    'CI must seed operational data before taking the backup dump',
  );
  assert.ok(
    workflow.indexOf('name: Verify Prisma migration status') < stepStart,
    'backup verification must run after migration status is checked',
  );
  assert.ok(
    stepStart < workflow.indexOf('name: Build API Docker image'),
    'backup verification must run before release Docker gates',
  );
});

test('CI keeps every production release gate wired', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');
  const packageJson = JSON.parse(readRepoFile('package.json'));

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:[\s\S]*branches:[\s\S]*- master/);
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read\s*$/m);
  assert.match(workflow, /node-version:\s+22/);
  assert.match(workflow, /run:\s+npm ci/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/start-ci-postgres\.test\.mjs/);
  assert.match(packageJson.scripts['test:production-check'], /scripts\/security-scan\.test\.mjs/);
  assert.equal(packageJson.scripts['security:secrets'], 'node scripts/security-scan.mjs secrets');
  assert.equal(packageJson.scripts['security:sast'], 'node scripts/security-scan.mjs sast');
  assert.equal(packageJson.scripts['security:scan'], 'npm run security:secrets && npm run security:sast');
  assert.match(workflow, /run:\s+npm run security:scan/);
  assert.match(workflow, /run:\s+npm run db:generate -w @charitypilot\/api/);
  assert.match(workflow, /run:\s+npx prisma validate/);
  assert.match(workflow, /run:\s+npm run lint/);
  assert.match(workflow, /run:\s+npm run test/);
  assert.match(workflow, /run:\s+npm run build -w @charitypilot\/shared/);
  assert.match(workflow, /run:\s+npm run build -w @charitypilot\/api/);
  assert.match(workflow, /run:\s+npm run build -w @charitypilot\/web/);
  assert.match(workflow, /run:\s+npm audit --omit=dev --audit-level=moderate/);
});

test('repo-owned security scanner is wired before CI and release Docker gates', () => {
  const ci = readRepoFile('.github/workflows/ci.yml');
  const release = readRepoFile('.github/workflows/release-images.yml');

  assert.ok(existsSync(join(repoRoot, 'scripts', 'security-scan.mjs')), 'security scanner script must exist');

  for (const [workflowName, workflow] of [
    ['CI', ci],
    ['release', release],
  ]) {
    const installIndex = workflow.indexOf('name: Install dependencies');
    const securityIndex = workflow.indexOf('name: Security scan');

    assert.notEqual(securityIndex, -1, `${workflowName} workflow must run a security scan step`);
    assert.match(workflow.slice(securityIndex), /run:\s+npm run security:scan/);
    assert.ok(installIndex < securityIndex, `${workflowName} security scan must run after dependencies install`);
  }

  assert.ok(
    ci.indexOf('name: Security scan') < ci.indexOf('name: Generate Prisma client'),
    'CI security scan must run before application build/test gates',
  );
  assert.ok(
    ci.indexOf('name: Security scan') < ci.indexOf('name: Build API Docker image'),
    'CI security scan must run before Docker image build gates',
  );
  assert.ok(
    release.indexOf('name: Security scan') < release.indexOf('name: Login to GHCR'),
    'release security scan must run before registry login',
  );
  assert.ok(
    release.indexOf('name: Security scan') < release.indexOf('name: Push image tags'),
    'release security scan must run before publishing images',
  );
});

test('release workflow builds web images only for the canonical production API origin', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');
  const validationStep = workflow.slice(
    workflow.indexOf('name: Validate production public web origins'),
    workflow.indexOf('name: Setup Node'),
  );

  assert.match(validationStep, /const canonicalApiOrigin = 'https:\/\/api\.charitypilot\.ie'/);
  assert.match(validationStep, /url\.origin !== canonicalApiOrigin/);
  assert.match(
    validationStep,
    /NEXT_PUBLIC_API_URL must be the canonical production API origin https:\/\/api\.charitypilot\.ie/,
  );
  assert.doesNotMatch(validationStep, /hostname !== 'charitypilot\.ie'/);
  assert.doesNotMatch(validationStep, /endsWith\('\\.charitypilot\\.ie'\)/);
});

test('CI uses GitHub Actions releases that run on the Node 24 action runtime', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /uses:\s+actions\/checkout@[a-f0-9]{40}\s+# v5/);
  assert.match(workflow, /uses:\s+actions\/setup-node@[a-f0-9]{40}\s+# v6/);
  assert.doesNotMatch(workflow, /uses:\s+actions\/checkout@v[0-9]/);
  assert.doesNotMatch(workflow, /uses:\s+actions\/setup-node@v[0-9]/);
});

test('GitHub Actions workflow actions are pinned to immutable commits', () => {
  for (const workflowPath of [
    '.github/workflows/ci.yml',
    '.github/workflows/release-images.yml',
    '.github/workflows/production-launch-evidence.yml',
  ]) {
    const workflow = readRepoFile(workflowPath);
    const actionRefs = [...workflow.matchAll(/^\s+uses:\s+([^@\s]+)@([^\s#]+)/gm)];

    assert.ok(actionRefs.length > 0, `${workflowPath} must use at least one action`);

    for (const [, action, ref] of actionRefs) {
      assert.match(ref, /^[a-f0-9]{40}$/, `${workflowPath} action ${action} must be pinned to a full commit SHA`);
      assert.doesNotMatch(
        ref,
        /^(main|master|v[0-9].*)$/,
        `${workflowPath} action ${action} must not use a mutable ref`,
      );
    }
  }
});

test('manual production launch evidence workflow validates final signoff evidence', () => {
  const workflow = readRepoFile('.github/workflows/production-launch-evidence.yml');
  const runbook = readRepoFile('docs/production-runbook.md');

  assert.match(workflow, /name:\s+Production Launch Evidence/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /evidence_artifact_run_id:/);
  assert.match(workflow, /evidence_artifact_name:/);
  assert.match(workflow, /default:\s+production-launch-evidence/);
  assert.match(workflow, /evidence_file_name:/);
  assert.match(workflow, /default:\s+production-launch-evidence\.json/);
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read\s*\n\s+actions:\s+read\s*$/m);
  assert.match(workflow, /environment:\s+production/);
  assert.match(workflow, /uses:\s+actions\/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd\s+# v5/);
  assert.match(workflow, /uses:\s+actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e\s+# v6/);
  assert.match(workflow, /name:\s+Validate dispatch input names/);
  assert.match(workflow, /EVIDENCE_ARTIFACT_RUN_ID:\s+\$\{\{\s*inputs\.evidence_artifact_run_id\s*\}\}/);
  assert.match(workflow, /EVIDENCE_ARTIFACT_NAME:\s+\$\{\{\s*inputs\.evidence_artifact_name\s*\}\}/);
  assert.match(workflow, /EVIDENCE_FILE_NAME:\s+\$\{\{\s*inputs\.evidence_file_name\s*\}\}/);
  assert.match(workflow, /production launch evidence upload run id is invalid/);
  assert.match(workflow, /production launch evidence artifact name is invalid/);
  assert.match(workflow, /production launch evidence file name is invalid/);
  assert.match(workflow, /uses:\s+actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\s+# v4\.3\.0/);
  assert.match(workflow, /name:\s+\$\{\{\s*inputs\.evidence_artifact_name\s*\}\}/);
  assert.match(workflow, /path:\s+launch-evidence/);
  assert.match(workflow, /run-id:\s+\$\{\{\s*inputs\.evidence_artifact_run_id\s*\}\}/);
  assert.match(workflow, /test -f "launch-evidence\/\$\{EVIDENCE_FILE_NAME\}"/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /set \+e/);
  assert.match(
    workflow,
    /npm run check:production:release-run -- --evidence-file="launch-evidence\/\$\{EVIDENCE_FILE_NAME\}" 2>&1/,
  );
  assert.match(workflow, /release_run_text_status=\$\{PIPESTATUS\[0\]\}/);
  assert.match(
    workflow,
    /npm run check:production:release-run -- --json --evidence-file="launch-evidence\/\$\{EVIDENCE_FILE_NAME\}"/,
  );
  assert.match(workflow, /release_run_json_status=\$\?/);
  assert.match(
    workflow,
    /npm run check:production:evidence -- --evidence-file="launch-evidence\/\$\{EVIDENCE_FILE_NAME\}" 2>&1/,
  );
  assert.match(workflow, /evidence_text_status=\$\{PIPESTATUS\[0\]\}/);
  assert.match(
    workflow,
    /npm run check:production:evidence -- --json --evidence-file="launch-evidence\/\$\{EVIDENCE_FILE_NAME\}"/,
  );
  assert.match(workflow, /evidence_json_status=\$\?/);
  assert.match(workflow, /tee production-launch-evidence-validation\.log/);
  assert.match(workflow, /> production-release-run-evidence\.json/);
  assert.match(workflow, /> production-launch-evidence-validation\.json/);
  assert.match(workflow, /Validation command statuses:/);
  assert.match(workflow, /exit 1/);
  assert.match(workflow, /uses:\s+actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4\.6\.2/);
  assert.match(workflow, /if:\s+always\(\)/);
  assert.match(workflow, /name:\s+production-launch-evidence-validation/);
  assert.match(
    workflow,
    /path:\s+\|[\s\S]*production-launch-evidence-validation\.log[\s\S]*production-release-run-evidence\.json[\s\S]*production-launch-evidence-validation\.json/,
  );
  assert.match(workflow, /if-no-files-found:\s+error/);
  assert.match(workflow, /retention-days:\s+90/);
  assert.match(runbook, /\.github\/workflows\/production-launch-evidence\.yml/);
  assert.match(runbook, /evidence_artifact_run_id/);
  assert.match(runbook, /production-launch-evidence-validation/);
  assert.match(runbook, /production-release-run-evidence\.json/);
  assert.match(runbook, /production-launch-evidence-validation\.json/);
});

test('protected production launch evidence upload workflow creates the validator source artifact', () => {
  const workflow = readRepoFile('.github/workflows/upload-production-launch-evidence.yml');
  const runbook = readRepoFile('docs/production-runbook.md');
  const launchChecklist = readRepoFile('docs/production-launch-checklist.md');
  const packageJson = JSON.parse(readRepoFile('package.json'));
  const helper = readRepoFile('scripts/prepare-production-launch-evidence-upload.mjs');
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-evidence-upload-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  const evidence = {
    version: 1,
    approvedForLaunch: false,
    release: {
      commitSha: 'a'.repeat(40),
      workflowRunUrl: 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/123456789',
      workflowFile: '.github/workflows/release-images.yml',
      gitRef: 'refs/heads/master',
    },
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/prepare-production-launch-evidence-upload.mjs', '--json', '--evidence-file', evidencePath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const inputs = JSON.parse(result.stdout);
    const original = readFileSync(evidencePath);
    assert.equal(inputs.artifact_name, 'production-launch-evidence');
    assert.equal(inputs.evidence_file_name, 'production-launch-evidence.json');
    assert.equal(inputs.evidence_sha256, createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(
      JSON.parse(gunzipSync(Buffer.from(inputs.evidence_json_gzip_base64, 'base64')).toString('utf8')),
      evidence,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  assert.equal(
    packageJson.scripts['prepare:production:evidence-upload'],
    'node scripts/prepare-production-launch-evidence-upload.mjs',
  );
  assert.match(helper, /gzipSync/);
  assert.match(helper, /createHash\('sha256'\)/);
  assert.match(helper, /validateWorkflowInputNames/);
  assert.match(helper, /workflow_dispatch inputs may reject very large evidence ledgers/);
  assert.match(helper, /gh workflow run upload-production-launch-evidence\.yml --ref master --json/);
  assert.match(workflow, /name:\s+Upload Production Launch Evidence/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /evidence_json_gzip_base64:/);
  assert.match(workflow, /evidence_sha256:/);
  assert.match(workflow, /artifact_name:/);
  assert.match(workflow, /default:\s+production-launch-evidence/);
  assert.match(workflow, /evidence_file_name:/);
  assert.match(workflow, /default:\s+production-launch-evidence\.json/);
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read\s*$/m);
  assert.match(workflow, /environment:\s+production/);
  assert.match(workflow, /uses:\s+actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e\s+# v6/);
  assert.match(workflow, /name:\s+Validate dispatch input names/);
  assert.match(workflow, /ARTIFACT_NAME:\s+\$\{\{\s*inputs\.artifact_name\s*\}\}/);
  assert.match(workflow, /EVIDENCE_FILE_NAME:\s+\$\{\{\s*inputs\.evidence_file_name\s*\}\}/);
  assert.match(workflow, /EVIDENCE_SHA256:\s+\$\{\{\s*inputs\.evidence_sha256\s*\}\}/);
  assert.match(workflow, /production launch evidence artifact name is invalid/);
  assert.match(workflow, /production launch evidence file name is invalid/);
  assert.match(workflow, /production launch evidence SHA-256 is invalid/);
  assert.match(workflow, /base64 --decode \| gzip -d > "\$\{evidence_path\}"/);
  assert.match(workflow, /sha256sum "\$\{evidence_path\}"/);
  assert.match(workflow, /Evidence SHA-256 mismatch; refusing to upload artifact/);
  assert.match(workflow, /production launch evidence must be a JSON object/);
  assert.match(workflow, /uses:\s+actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4\.6\.2/);
  assert.match(workflow, /name:\s+\$\{\{\s*inputs\.artifact_name\s*\}\}/);
  assert.match(workflow, /path:\s+launch-evidence\/\$\{\{\s*inputs\.evidence_file_name\s*\}\}/);
  assert.match(workflow, /retention-days:\s+90/);
  assert.match(runbook, /upload-production-launch-evidence\.yml/);
  assert.match(
    runbook,
    /prepare:production:evidence-upload -- --json \| gh workflow run upload-production-launch-evidence\.yml --ref master --json/,
  );
  assert.match(runbook, /verifies the SHA-256/);
  assert.match(runbook, /without committing it to git/);
  assert.match(launchChecklist, /upload-production-launch-evidence\.yml/);
  assert.match(launchChecklist, /without committing it to git/);
  assert.match(launchChecklist, /evidence_artifact_run_id/);
});

test('production launch evidence upload helper rejects unsafe artifact and file names', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-evidence-upload-names-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  writeFileSync(evidencePath, JSON.stringify({ version: 1, approvedForLaunch: false }));

  try {
    for (const artifactName of ['../x', 'bad/name', '$(touch x)', 'bad name', 'production-launch-evidence\nnext']) {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/prepare-production-launch-evidence-upload.mjs',
          '--json',
          '--evidence-file',
          evidencePath,
          '--artifact-name',
          artifactName,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      assert.equal(result.status, 2, `artifact name ${JSON.stringify(artifactName)} should be rejected`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--artifact-name must match/);
    }

    for (const evidenceFileName of [
      '../production-launch-evidence.json',
      'x.json;echo bad',
      'x',
      'x.txt',
      'bad name.json',
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/prepare-production-launch-evidence-upload.mjs',
          '--json',
          '--evidence-file',
          evidencePath,
          '--evidence-file-name',
          evidenceFileName,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      assert.equal(result.status, 2, `evidence file name ${JSON.stringify(evidenceFileName)} should be rejected`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--evidence-file-name must match/);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence upload helper rejects empty inline options as usage errors', () => {
  for (const args of [['--evidence-file='], ['--artifact-name='], ['--evidence-file-name=']]) {
    const result = spawnSync(process.execPath, ['scripts/prepare-production-launch-evidence-upload.mjs', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 2, `${args.join(' ')} should be rejected as usage`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /requires a value/);
  }
});

test('CI builds API and web production Docker images', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(
    workflow,
    /docker build -f apps\/api\/Dockerfile --build-arg DATABASE_URL=postgresql:\/\/charitypilot:charitypilot_ci@localhost:5432\/charitypilot_ci -t charitypilot-api-ci \./,
  );
  assert.match(
    workflow,
    /docker build -f apps\/web\/Dockerfile[\s\S]*--build-arg NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie[\s\S]*-t charitypilot-web-ci \./,
  );
  assert.doesNotMatch(workflow, /NEXT_PUBLIC_SUPABASE_URL/);
});

test('CI smoke-runs API and web Docker images after building them', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /name:\s+Smoke API Docker image/);
  assert.match(workflow, /docker run -d --name charitypilot-api-smoke[\s\S]*charitypilot-api-ci/);
  assert.match(workflow, /-e JWT_SECRET=ci-smoke-jwt-secret-with-enough-entropy/);
  assert.match(workflow, /-e RESEND_API_KEY=re_ci_smoke_key/);
  assert.match(workflow, /docker ps --filter name=charitypilot-api-smoke --filter status=running --quiet/);
  assert.match(workflow, /api_headers="\$\(mktemp\)"/);
  assert.match(
    workflow,
    /curl --fail --silent --dump-header "\$\{api_headers\}" http:\/\/127\.0\.0\.1:3002\/api\/v1\/health/,
  );
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{api_headers\}"/);
  assert.match(
    workflow,
    /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{api_headers\}"/,
  );
  assert.match(
    workflow,
    /grep -qi "\^strict-transport-security: max-age=63072000; includeSubDomains; preload" "\$\{api_headers\}"/,
  );
  assert.match(workflow, /grep -qi "\^cache-control: no-store" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^pragma: no-cache" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^expires: 0" "\$\{api_headers\}"/);
  assert.match(
    workflow,
    /grep -qi "\^content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'" "\$\{api_headers\}"/,
  );
  assert.match(workflow, /docker rm -f charitypilot-api-smoke/);
  assert.match(workflow, /name:\s+Verify API Docker runtime dependencies/);
  assert.match(workflow, /docker run --rm --entrypoint node charitypilot-api-ci[\s\S]*@prisma\/client/);
  assertWorkflowChecksForbiddenApiRuntimePackages(workflow);
  assertWorkflowUsesPackagePathAbsenceChecks(
    workflowStepBetween(workflow, 'Verify API Docker runtime dependencies', 'Smoke API Docker image'),
  );
  assert.match(
    workflow,
    /const forbiddenPaths = \['src', 'prisma', '\.env', 'tsconfig\.json', 'tsconfig\.tsbuildinfo'\]/,
  );
  assert.match(workflow, /\.\.\/\.\.\/packages\/shared\/src/);

  assert.match(workflow, /name:\s+Smoke web Docker image/);
  assert.match(workflow, /docker run -d --name charitypilot-web-smoke[\s\S]*charitypilot-web-ci/);
  assert.match(
    workflow,
    /name:\s+Smoke web Docker image[\s\S]*-e NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie[\s\S]*charitypilot-web-ci/,
  );
  assert.match(workflow, /docker ps --filter name=charitypilot-web-smoke --filter status=running --quiet/);
  assert.match(workflow, /web_headers="\$\(mktemp\)"/);
  assert.match(workflow, /curl --fail --silent --dump-header "\$\{web_headers\}" http:\/\/127\.0\.0\.1:3003\//);
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{web_headers\}"/);
  assert.match(
    workflow,
    /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{web_headers\}"/,
  );
  assert.match(
    workflow,
    /grep -qi "\^strict-transport-security: max-age=63072000; includeSubDomains; preload" "\$\{web_headers\}"/,
  );
  assert.match(
    workflow,
    /grep -qi "\^content-security-policy: .*frame-ancestors 'none'.*connect-src 'self' https:\/\/api\.charitypilot\.ie" "\$\{web_headers\}"/,
  );
  assert.match(workflow, /docker rm -f charitypilot-web-smoke/);
  assert.match(workflow, /name:\s+Verify web Docker runtime dependencies/);
  assert.match(workflow, /docker run --rm --entrypoint node charitypilot-web-ci[\s\S]*require\.resolve\('next'\)/);
  assertWorkflowChecksForbiddenWebRuntimePackages(workflow);
  assertWorkflowUsesPackagePathAbsenceChecks(
    workflowStepBetween(workflow, 'Verify web Docker runtime dependencies', 'Smoke web Docker image'),
  );
  assert.match(
    workflow,
    /const forbiddenPaths = \['src', '\.test-dist', '\.next\/cache', '\.next\/export', '\.next\/export-detail\.json', '\.next\/server\/proxy\.js', '\.next\/server\/proxy\.js\.nft\.json', 'next-codex-build', 'tsconfig\.test\.json', 'tsconfig\.tsbuildinfo', 'next-env\.d\.ts'\]/,
  );
  assert.match(workflow, /entry\.startsWith\('\.next-build'\)/);
  assert.match(workflow, /\.\.\/\.\.\/packages\/shared\/src/);

  assert.ok(
    workflow.indexOf('name: Build API Docker image') < workflow.indexOf('name: Smoke API Docker image'),
    'API image must be built before the API smoke run',
  );
  assert.ok(
    workflow.indexOf('name: Build web Docker image') < workflow.indexOf('name: Smoke web Docker image'),
    'web image must be built before the web smoke run',
  );
  assert.ok(
    workflow.indexOf('name: Build API Docker image') < workflow.indexOf('name: Verify API Docker runtime dependencies'),
    'API image must be built before runtime dependency inspection',
  );
  assert.ok(
    workflow.indexOf('name: Build web Docker image') < workflow.indexOf('name: Verify web Docker runtime dependencies'),
    'web image must be built before runtime dependency inspection',
  );
});

test('CI API Docker smoke runs in production mode and exercises keyed readiness', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');
  const smokeStepEnd = workflow.indexOf('name: Smoke API Docker scheduled jobs');
  assert.notEqual(smokeStepEnd, -1, 'scheduled job smoke step must follow API smoke step');
  const smokeStep = workflow.slice(workflow.indexOf('name: Smoke API Docker image'), smokeStepEnd);

  assert.match(smokeStep, /-e NODE_ENV=production/);
  assert.match(smokeStep, /-e CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE=true/);
  assert.match(smokeStep, /-e CI=true/);
  assert.match(smokeStep, /-e GITHUB_ACTIONS=true/);
  assert.match(smokeStep, /-e TRUSTED_PROXY_ADDRESSES=10\.0\.0\.10/);
  assert.match(smokeStep, /-e READINESS_API_KEY=ci-readiness-key-with-enough-entropy/);
  assert.match(
    smokeStep,
    /-e DATABASE_URL=postgresql:\/\/charitypilot:charitypilot_ci@127\.0\.0\.1:5432\/charitypilot_ci/,
  );
  assert.match(smokeStep, /readiness_unauthorized_status/);
  assert.match(smokeStep, /test "\$\{readiness_unauthorized_status\}" = "401"/);
  assert.match(smokeStep, /x-charitypilot-readiness-key: ci-readiness-key-with-enough-entropy/);
  assert.match(smokeStep, /test "\$\{readiness_status\}" = "503"/);
  assert.match(smokeStep, /body\.status !== 'not_ready'/);
  assert.match(smokeStep, /body\.checks\.database !== true/);
  assert.match(smokeStep, /body\.checks\.storageConfigured !== true/);
  assert.match(smokeStep, /body\.checks\.storageBucketReachable !== false/);
  assert.match(smokeStep, /disallowed_cors_headers="\$\(mktemp\)"/);
  assert.match(smokeStep, /-H "origin: https:\/\/not-charitypilot\.example"/);
  assert.match(
    smokeStep,
    /grep -qi "\^access-control-allow-origin: https:\/\/not-charitypilot\.example" "\$\{disallowed_cors_headers\}"/,
  );
  assert.match(smokeStep, /API Docker smoke must not allow an unapproved browser Origin/);
  assert.match(smokeStep, /register_email="api-smoke-\$\{GITHUB_SHA:-local\}@example\.com"/);
  assert.match(smokeStep, /register_payload="\$\(mktemp\)"/);
  assert.match(smokeStep, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/auth\/register/);
  assert.match(smokeStep, /register_first_status="\$\(curl[\s\S]*--data @"\$\{register_payload\}"/);
  assert.match(smokeStep, /register_duplicate_status="\$\(curl[\s\S]*--data @"\$\{register_payload\}"/);
  assert.match(smokeStep, /test "\$\{register_first_status\}" = "202"/);
  assert.match(smokeStep, /test "\$\{register_duplicate_status\}" = "202"/);
  assert.match(smokeStep, /bodyA\.message !== bodyB\.message/);
  assert.match(smokeStep, /check your email for next steps/);
  assert.match(smokeStep, /'\buser\b' in bodyA/);
  assert.match(smokeStep, /'\buser\b' in bodyB/);
  assert.match(smokeStep, /grep -qi "\^set-cookie:" "\$\{register_first_headers\}" "\$\{register_duplicate_headers\}"/);
  assert.match(smokeStep, /grep -qi "\^cache-control: no-store" "\$\{register_first_headers\}"/);
});

test('CI smoke-runs production API scheduled job entrypoints inside the Docker image', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');
  const jobSmokeStep = workflow.slice(
    workflow.indexOf('name: Smoke API Docker scheduled jobs'),
    workflow.indexOf('name: Build web Docker image'),
  );
  const deadlineRun = dockerRunForCommand(
    jobSmokeStep,
    'charitypilot-api-ci node dist/jobs/send-deadline-reminders.js',
  );
  const cleanupRun = dockerRunForCommand(
    jobSmokeStep,
    'charitypilot-api-ci node dist/jobs/cleanup-document-storage.js',
  );
  const schedulerRun = dockerRunForCommand(jobSmokeStep, 'charitypilot-api-ci node dist/jobs/production-scheduler.js');

  assert.match(workflow, /name:\s+Smoke API Docker scheduled jobs/);
  assert.match(jobSmokeStep, /charitypilot_job_smoke/);
  assert.match(jobSmokeStep, /CREATE DATABASE charitypilot_job_smoke OWNER charitypilot/);
  assert.match(jobSmokeStep, /postgres@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(jobSmokeStep, /postgres:16\.4-alpine/);
  assert.match(jobSmokeStep, /npx prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  for (const run of [deadlineRun, cleanupRun, schedulerRun]) {
    assert.match(run, /-e NODE_ENV=production/);
    assert.match(run, /-e CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE=true/);
    assert.match(run, /-e CI=true/);
    assert.match(run, /-e GITHUB_ACTIONS=true/);
    assert.match(
      run,
      /-e DATABASE_URL=postgresql:\/\/charitypilot:charitypilot_ci@127\.0\.0\.1:5432\/charitypilot_job_smoke/,
    );
  }
  assert.match(deadlineRun, /-e TRUSTED_PROXY_ADDRESSES=10\.0\.0\.10/);
  assert.match(deadlineRun, /-e READINESS_API_KEY=ci-readiness-key-with-enough-entropy/);
  assert.match(deadlineRun, /-e JWT_SECRET=ci-smoke-jwt-secret-with-enough-entropy/);
  assert.match(deadlineRun, /-e FRONTEND_URL=https:\/\/app\.charitypilot\.ie/);
  assert.match(deadlineRun, /-e AUTH_COOKIE_DOMAIN=\.charitypilot\.ie/);
  assert.match(deadlineRun, /-e NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie/);
  assert.match(deadlineRun, /-e STRIPE_SECRET_KEY=sk_live_ci_smoke_secret/);
  assert.match(deadlineRun, /-e STRIPE_WEBHOOK_SECRET=whsec_ci_smoke_secret/);
  assert.match(deadlineRun, /-e RESEND_API_KEY=re_ci_smoke_key/);
  assert.match(deadlineRun, /-e EMAIL_FROM=noreply@charitypilot\.ie/);
  assert.match(deadlineRun, /-e SUPABASE_URL=https:\/\/ci-project\.supabase\.co/);
  assert.match(deadlineRun, /-e SUPABASE_SERVICE_ROLE_KEY=ci-configured-service-role-key/);
  assert.match(deadlineRun, /-e SUPABASE_STORAGE_BUCKET=documents/);
  assert.match(deadlineRun, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assert.match(cleanupRun, /-e SUPABASE_URL=https:\/\/ci-project\.supabase\.co/);
  assert.match(cleanupRun, /-e SUPABASE_SERVICE_ROLE_KEY=ci-configured-service-role-key/);
  assert.match(cleanupRun, /-e SUPABASE_STORAGE_BUCKET=documents/);
  assert.match(cleanupRun, /-e DOCUMENT_STORAGE_CLEANUP_LIMIT=1/);
  assert.match(cleanupRun, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assert.match(schedulerRun, /-e PRODUCTION_SCHEDULER_RUN_ONCE=true/);
  assert.match(schedulerRun, /-e FRONTEND_URL=https:\/\/app\.charitypilot\.ie/);
  assert.match(schedulerRun, /-e RESEND_API_KEY=re_ci_smoke_key/);
  assert.match(schedulerRun, /-e EMAIL_FROM=noreply@charitypilot\.ie/);
  assert.match(schedulerRun, /-e SUPABASE_URL=https:\/\/ci-project\.supabase\.co/);
  assert.match(schedulerRun, /-e SUPABASE_SERVICE_ROLE_KEY=ci-configured-service-role-key/);
  assert.match(schedulerRun, /-e SUPABASE_STORAGE_BUCKET=documents/);
  assert.match(schedulerRun, /-e DOCUMENT_STORAGE_CLEANUP_LIMIT=1/);
  assert.match(schedulerRun, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assert.match(jobSmokeStep, /Deadline reminders job completed successfully\./);
  assert.match(
    jobSmokeStep,
    /\[DeadlineReminders\] Run complete - 0 reminder\(s\) provider-accepted, 0 failed, 0 uncertain, 0 deadline\(s\) skipped/,
  );
  assert.match(jobSmokeStep, /Document storage cleanup completed\. Processed: 0\. Failed: 0\./);
  assert.match(jobSmokeStep, /Production scheduler run-once completed successfully\./);
  assert.ok(
    workflow.indexOf('name: Build API Docker image') < workflow.indexOf('name: Smoke API Docker scheduled jobs'),
    'API image must be built before scheduled job smoke runs',
  );
  assert.ok(
    workflow.indexOf('name: Smoke API Docker image') < workflow.indexOf('name: Smoke API Docker scheduled jobs'),
    'API runtime smoke must run before scheduled job smoke',
  );
  assert.ok(
    workflow.indexOf('name: Smoke API Docker scheduled jobs') < workflow.indexOf('name: Build web Docker image'),
    'scheduled job smoke must run before continuing to web image gates',
  );
});

test('CI validates API production env inside the built Docker image', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /name:\s+Validate API Docker production configuration/);
  assert.match(workflow, /docker run --rm[\s\S]*charitypilot-api-ci[\s\S]*validateProductionEnv/);
  assert.match(workflow, /-e NODE_ENV=production/);
  assert.match(workflow, /-e TRUSTED_PROXY_ADDRESSES=10\.0\.0\.10/);
  assert.match(
    workflow,
    /-e DATABASE_URL=postgresql:\/\/charitypilot:charitypilot@db\.charitypilot\.ie:5432\/charitypilot\?sslmode=require/,
  );
  assert.match(workflow, /-e STRIPE_SECRET_KEY=sk_live_ci_configured_secret/);
  assert.match(workflow, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assert.ok(
    workflow.indexOf('name: Build API Docker image') <
      workflow.indexOf('name: Validate API Docker production configuration'),
    'API image must be built before validating production configuration inside it',
  );
  assert.ok(
    workflow.indexOf('name: Validate API Docker production configuration') <
      workflow.indexOf('name: Smoke API Docker image'),
    'production configuration must be validated before the API smoke run',
  );
});

test('release workflow publishes runtime and migration Docker images to GHCR', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');

  assert.match(workflow, /name:\s+Release Images/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /inputs:[\s\S]*image_tag/);
  assert.match(workflow, /push:[\s\S]*tags:[\s\S]*- 'v\*'/);
  assert.match(workflow, /permissions:[\s\S]*contents:\s+read[\s\S]*packages:\s+write[\s\S]*id-token:\s+write/);
  assert.match(workflow, /environment:\s+production/);
  assert.match(workflow, /REGISTRY:\s+ghcr\.io/);
  assert.doesNotMatch(
    workflow,
    /^\s+services:\s*$/m,
    'release workflow must not use service containers that can fail before checkout',
  );
  assert.match(workflow, /name:\s+Start PostgreSQL/);
  assert.match(workflow, /node scripts\/start-ci-postgres\.mjs/);
  assert.match(workflow, /name:\s+Stop PostgreSQL/);
  assert.match(workflow, /if:\s+always\(\)/);
  assert.match(workflow, /name:\s+Validate release ref/);
  assert.match(workflow, /NEXT_PUBLIC_API_URL:\s+\$\{\{\s*vars\.NEXT_PUBLIC_API_URL\s*\}\}/);
  assert.match(workflow, /NEXT_PUBLIC_API_URL production variable is required/);
  assert.doesNotMatch(workflow, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(workflow, /production variable must not contain placeholder text/);
  assert.match(workflow, /project_ref/);
  assert.match(workflow, /your-/);
  assert.match(
    workflow,
    /NEXT_PUBLIC_API_URL must be the canonical production API origin https:\/\/api\.charitypilot\.ie/,
  );
  assert.match(workflow, /Manual image releases must run from master/);
  assert.match(workflow, /Docker tag must match \[a-z0-9_\]\[a-z0-9_.-\]\{0,127\}/);
  assert.match(workflow, /docker login "\$\{REGISTRY\}"/);
  assert.match(
    workflow,
    /docker build -f apps\/api\/Dockerfile --target migration-runner[\s\S]*-t charitypilot-api-migrations-ci \./,
  );
  assert.match(workflow, /name:\s+Verify migration runner Docker runtime dependencies/);
  const migrationDependencyStep = workflow.slice(
    workflow.indexOf('name: Verify migration runner Docker runtime dependencies'),
    workflow.indexOf('name: Start PostgreSQL'),
  );
  assert.match(migrationDependencyStep, /docker run --rm --entrypoint node charitypilot-api-migrations-ci/);
  assert.match(migrationDependencyStep, /require\.resolve\('prisma\/build\/index\.js'\)/);
  assert.match(migrationDependencyStep, /require\('prisma\/package\.json'\)\.version !== '6\.19\.3'/);
  assert.match(migrationDependencyStep, /fs\.existsSync\('node_modules\/\.bin\/prisma'\)/);
  assert.match(migrationDependencyStep, /fs\.readdirSync\('prisma\/migrations'\)\.length === 0/);
  assert.match(migrationDependencyStep, /path\.join\('node_modules', \.\.\.pkg\.split\('\/'\)\)/);
  assert.doesNotMatch(migrationDependencyStep, /require\.resolve\(pkg\)/);
  assertWorkflowChecksForbiddenMigrationRunnerPackages(workflow);
  assert.match(workflow, /name:\s+Audit migration runner Docker runtime dependencies/);
  assert.match(
    workflow,
    /docker run --rm --entrypoint npm charitypilot-api-migrations-ci audit --omit=dev --audit-level=moderate/,
  );
  assert.match(workflow, /const requiredPaths = \['prisma\/schema\.prisma', 'prisma\/migrations'\]/);
  assert.match(
    workflow,
    /const forbiddenPaths = \['src', 'dist', 'prisma\/seed\.ts', '\.env', 'tsconfig\.json', 'tsconfig\.tsbuildinfo', '\.\.\/\.\.\/apps\/web', '\.\.\/\.\.\/packages\/shared'\]/,
  );
  assert.match(
    workflow,
    /docker run --rm[\s\S]*charitypilot-api-migrations-ci[\s\S]*migrate status --schema prisma\/schema\.prisma/,
  );
  assert.match(
    workflow,
    /docker build -f apps\/api\/Dockerfile --build-arg DATABASE_URL=postgresql:\/\/charitypilot:charitypilot_ci@localhost:5432\/charitypilot_ci -t charitypilot-api-ci \./,
  );
  assert.match(workflow, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assertWorkflowChecksForbiddenApiRuntimePackages(workflow);
  assertWorkflowUsesPackagePathAbsenceChecks(
    workflowStepBetween(workflow, 'Verify API Docker runtime dependencies', 'Smoke API Docker image'),
  );
  assert.match(
    workflow,
    /const forbiddenPaths = \['src', 'prisma', '\.env', 'tsconfig\.json', 'tsconfig\.tsbuildinfo'\]/,
  );
  assert.match(workflow, /\.\.\/\.\.\/packages\/shared\/src/);
  assert.match(workflow, /api_headers="\$\(mktemp\)"/);
  assert.match(
    workflow,
    /curl --fail --silent --dump-header "\$\{api_headers\}" http:\/\/127\.0\.0\.1:3002\/api\/v1\/health/,
  );
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{api_headers\}"/);
  assert.match(
    workflow,
    /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{api_headers\}"/,
  );
  assert.match(
    workflow,
    /grep -qi "\^strict-transport-security: max-age=63072000; includeSubDomains; preload" "\$\{api_headers\}"/,
  );
  assert.match(workflow, /grep -qi "\^cache-control: no-store" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^pragma: no-cache" "\$\{api_headers\}"/);
  assert.match(workflow, /grep -qi "\^expires: 0" "\$\{api_headers\}"/);
  assert.match(
    workflow,
    /grep -qi "\^content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'" "\$\{api_headers\}"/,
  );
  assert.match(
    workflow,
    /docker build -f apps\/web\/Dockerfile[\s\S]*--build-arg NEXT_PUBLIC_API_URL="\$\{NEXT_PUBLIC_API_URL\}"[\s\S]*-t charitypilot-web-ci \./,
  );
  assert.match(workflow, /web_headers="\$\(mktemp\)"/);
  assert.match(
    workflow,
    /name:\s+Smoke web Docker image[\s\S]*-e NEXT_PUBLIC_API_URL="\$\{NEXT_PUBLIC_API_URL\}"[\s\S]*charitypilot-web-ci/,
  );
  assert.match(workflow, /curl --fail --silent --dump-header "\$\{web_headers\}" http:\/\/127\.0\.0\.1:3003\//);
  assert.match(workflow, /grep -qi "\^x-content-type-options: nosniff" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^x-frame-options: DENY" "\$\{web_headers\}"/);
  assert.match(workflow, /grep -qi "\^referrer-policy: strict-origin-when-cross-origin" "\$\{web_headers\}"/);
  assert.match(
    workflow,
    /grep -qi "\^permissions-policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" "\$\{web_headers\}"/,
  );
  assert.match(
    workflow,
    /grep -qi "\^strict-transport-security: max-age=63072000; includeSubDomains; preload" "\$\{web_headers\}"/,
  );
  assert.match(
    workflow,
    /grep -qi "\^content-security-policy: .*frame-ancestors 'none'.*connect-src 'self' \$\{NEXT_PUBLIC_API_URL\}" "\$\{web_headers\}"/,
  );
  assertWorkflowChecksForbiddenWebRuntimePackages(workflow);
  assertWorkflowUsesPackagePathAbsenceChecks(
    workflowStepBetween(workflow, 'Verify web Docker runtime dependencies', 'Smoke web Docker image'),
  );
  assert.match(
    workflow,
    /const forbiddenPaths = \['src', '\.test-dist', '\.next\/cache', '\.next\/export', '\.next\/export-detail\.json', '\.next\/server\/proxy\.js', '\.next\/server\/proxy\.js\.nft\.json', 'next-codex-build', 'tsconfig\.test\.json', 'tsconfig\.tsbuildinfo', 'next-env\.d\.ts'\]/,
  );
  assert.match(workflow, /entry\.startsWith\('\.next-build'\)/);
  assert.match(workflow, /\.\.\/\.\.\/packages\/shared\/src/);
  assert.match(workflow, /docker tag charitypilot-api-ci "\$\{api_image\}"/);
  assert.match(workflow, /docker tag charitypilot-web-ci "\$\{web_image\}"/);
  assert.match(workflow, /docker tag charitypilot-api-migrations-ci "\$\{migration_image\}"/);
  assert.match(workflow, /docker push "\$\{api_image\}"/);
  assert.match(workflow, /docker push "\$\{web_image\}"/);
  assert.match(workflow, /docker push "\$\{migration_image\}"/);
  assert.match(workflow, /name:\s+Install cosign/);
  assert.match(workflow, /uses:\s+sigstore\/cosign-installer@[a-f0-9]{40}\s+# v3\.10\.0/);
  assert.match(workflow, /name:\s+Resolve published image digests/);
  assert.match(workflow, /docker buildx imagetools inspect "\$\{api_image\}"/);
  assert.match(workflow, /docker buildx imagetools inspect "\$\{web_image\}"/);
  assert.match(workflow, /docker buildx imagetools inspect "\$\{migration_image\}"/);
  assert.match(workflow, /name:\s+Sign published image digests/);
  assert.match(
    workflow,
    /cosign sign --yes "\$\{api_image\}@\$\{api_digest\}" "\$\{web_image\}@\$\{web_digest\}" "\$\{migration_image\}@\$\{migration_digest\}"/,
  );
  assert.match(workflow, /name:\s+Verify published image signatures/);
  assert.ok(
    workflow.includes(
      'identity_regex="^https://github.com/${GITHUB_REPOSITORY}/\\\\.github/workflows/release-images\\\\.yml@refs/(heads/master|tags/v.*)$"',
    ),
  );
  assert.match(workflow, /cosign verify[\s\S]*"\$\{api_image\}@\$\{api_digest\}"/);
  assert.match(workflow, /cosign verify[\s\S]*"\$\{web_image\}@\$\{web_digest\}"/);
  assert.match(workflow, /cosign verify[\s\S]*"\$\{migration_image\}@\$\{migration_digest\}"/);
  assert.match(workflow, /--certificate-oidc-issuer "https:\/\/token\.actions\.githubusercontent\.com"/);
  assert.match(workflow, /--certificate-identity-regexp/);

  assert.ok(
    workflow.indexOf('name: Build migration runner image') <
      workflow.indexOf('name: Verify migration runner Docker runtime dependencies'),
    'migration runner image must be built before runtime inspection',
  );
  assert.ok(
    workflow.indexOf('name: Verify migration runner Docker runtime dependencies') <
      workflow.indexOf('name: Audit migration runner Docker runtime dependencies'),
    'migration runner image must be inspected before its runtime audit',
  );
  assert.ok(
    workflow.indexOf('name: Audit migration runner Docker runtime dependencies') <
      workflow.indexOf('name: Run migration runner against CI PostgreSQL'),
    'migration runner image dependencies must be audited before its smoke run',
  );
  assert.ok(
    workflow.indexOf('name: Smoke web Docker image') < workflow.indexOf('name: Push image tags'),
    'images must be smoke-tested before publishing',
  );
  assert.ok(
    workflow.indexOf('name: Run migration runner against CI PostgreSQL') < workflow.indexOf('name: Push image tags'),
    'migration runner must be tested before publishing',
  );
  assert.ok(
    workflow.indexOf('name: Validate API Docker production configuration') < workflow.indexOf('name: Push image tags'),
    'API production config must be validated before publishing',
  );
  assert.ok(
    workflow.indexOf('name: Smoke API Docker image') < workflow.indexOf('name: Push image tags'),
    'API image must be smoke-tested before publishing',
  );
  assert.ok(
    workflow.indexOf('name: Push image tags') < workflow.indexOf('name: Resolve published image digests'),
    'image digests must be resolved after publishing',
  );
  assert.ok(
    workflow.indexOf('name: Resolve published image digests') < workflow.indexOf('name: Sign published image digests'),
    'published image digests must be resolved before signing',
  );
  assert.ok(
    workflow.indexOf('name: Sign published image digests') <
      workflow.indexOf('name: Verify published image signatures'),
    'published signatures must be verified before the release job completes',
  );
});

test('release workflow archives a deployable image digest manifest', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');
  const runbook = readRepoFile('docs/production-runbook.md');
  const checklist = readRepoFile('docs/production-launch-checklist.md');
  const manifestStepStart = workflow.indexOf('name: Generate release image digest manifest');
  const uploadStepStart = workflow.indexOf('name: Upload release image digest manifest');

  assert.notEqual(manifestStepStart, -1, 'release workflow must generate a machine-readable digest manifest');
  assert.notEqual(uploadStepStart, -1, 'release workflow must upload the digest manifest as an artifact');

  const manifestStep = workflow.slice(manifestStepStart, uploadStepStart);
  const uploadStep = workflow.slice(uploadStepStart, workflow.indexOf('name: Stop PostgreSQL'));

  assert.match(manifestStep, /release-image-digests\.env/);
  assert.match(manifestStep, /api_repository="\$\{api_image%:\*\}"/);
  assert.match(manifestStep, /web_repository="\$\{web_image%:\*\}"/);
  assert.match(manifestStep, /migration_repository="\$\{migration_image%:\*\}"/);
  assert.match(manifestStep, /CHARITYPILOT_API_IMAGE="\$\{api_repository\}@\$\{api_digest\}"/);
  assert.match(manifestStep, /CHARITYPILOT_WEB_IMAGE="\$\{web_repository\}@\$\{web_digest\}"/);
  assert.match(manifestStep, /CHARITYPILOT_MIGRATION_IMAGE="\$\{migration_repository\}@\$\{migration_digest\}"/);
  assert.match(manifestStep, /CHARITYPILOT_DATABASE_COMPATIBILITY="p006-deadline-calendar-v1"/);
  assert.match(manifestStep, /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL="\$\{NEXT_PUBLIC_API_URL\}"/);
  assert.doesNotMatch(manifestStep, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.doesNotMatch(manifestStep, /CHARITYPILOT_API_IMAGE="\$\{api_image\}@\$\{api_digest\}"/);
  assert.match(manifestStep, /cat release-image-digests\.env >> "\$\{GITHUB_STEP_SUMMARY\}"/);
  assert.match(uploadStep, /uses:\s+actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4\.6\.2/);
  assert.match(uploadStep, /name:\s+release-image-digests/);
  assert.match(uploadStep, /path:\s+release-image-digests\.env/);
  assert.match(uploadStep, /if-no-files-found:\s+error/);
  assert.match(uploadStep, /retention-days:\s+90/);
  assert.ok(
    workflow.indexOf('name: Verify published image signatures') < manifestStepStart,
    'manifest must be generated only after signatures are verified',
  );
  assert.ok(manifestStepStart < uploadStepStart, 'manifest must be generated before upload');
  assert.match(runbook, /release-image-digests artifact/);
  assert.match(runbook, /release-image-digests\.env/);
  assert.match(checklist, /Release image digest manifest artifact/);
});

test('release workflow rehearses deploy preflight against generated digest manifest', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');
  const manifestStepStart = workflow.indexOf('name: Generate release image digest manifest');
  const rehearsalStepStart = workflow.indexOf('name: Rehearse production deploy preflight with release digests');
  const uploadStepStart = workflow.indexOf('name: Upload release image digest manifest');

  assert.notEqual(manifestStepStart, -1, 'release workflow must generate the image digest manifest');
  assert.notEqual(rehearsalStepStart, -1, 'release workflow must rehearse deploy preflight with the generated digests');
  assert.notEqual(uploadStepStart, -1, 'release workflow must upload the image digest manifest');

  const rehearsalStep = workflow.slice(rehearsalStepStart, uploadStepStart);

  assert.match(rehearsalStep, /\.env\.production\.ci/);
  assert.match(rehearsalStep, /cat > \.env\.production\.ci <<EOF/);
  assert.match(rehearsalStep, /NODE_ENV=production/);
  assert.match(
    rehearsalStep,
    /DATABASE_URL=postgresql:\/\/charitypilot:charitypilot@db\.charitypilot\.ie:5432\/charitypilot\?sslmode=require/,
  );
  assert.match(rehearsalStep, /NEXT_PUBLIC_API_URL=\$\{NEXT_PUBLIC_API_URL\}/);
  assert.match(rehearsalStep, /CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL=\$\{NEXT_PUBLIC_API_URL\}/);
  assert.doesNotMatch(rehearsalStep, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(rehearsalStep, /cat release-image-digests\.env >> \.env\.production\.ci/);
  assert.match(rehearsalStep, /npm run deploy:preflight -- --production-env-file=\.env\.production\.ci/);
  assert.ok(
    manifestStepStart < rehearsalStepStart,
    'deploy preflight rehearsal must run after the digest manifest is generated',
  );
  assert.ok(
    rehearsalStepStart < uploadStepStart,
    'digest manifest must only be uploaded after deploy preflight rehearsal passes',
  );
});

test('release workflow runs full production gates before publishing images', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');
  const publishIndex = workflow.indexOf('name: Push image tags');

  assert.match(workflow, /uses:\s+actions\/setup-node@[a-f0-9]{40}\s+# v6/);
  assert.match(workflow, /run:\s+npm ci/);
  assert.match(workflow, /run:\s+npm run db:generate -w @charitypilot\/api/);
  assert.match(workflow, /run:\s+npx prisma validate/);
  assert.match(workflow, /run:\s+npm run lint/);
  assert.match(workflow, /run:\s+npm run test/);
  assert.match(workflow, /name:\s+Build shared package[\s\S]*run:\s+npm run build -w @charitypilot\/shared/);
  assert.match(workflow, /name:\s+Build API[\s\S]*run:\s+npm run build -w @charitypilot\/api/);
  assert.match(workflow, /NEXT_PUBLIC_API_URL:\s+\$\{\{\s*vars\.NEXT_PUBLIC_API_URL\s*\}\}/);
  assert.match(workflow, /name:\s+Build web[\s\S]*run:\s+npm run build -w @charitypilot\/web/);
  assert.match(workflow, /run:\s+npm audit --omit=dev --audit-level=moderate/);

  for (const gate of [
    'name: Install dependencies',
    'name: Generate Prisma client',
    'name: Validate Prisma schema',
    'name: Lint',
    'name: Test',
    'name: Build shared package',
    'name: Build API',
    'name: Build web',
    'name: Dependency audit',
  ]) {
    assert.ok(workflow.indexOf(gate) > -1, `${gate} must exist in release workflow`);
    assert.ok(workflow.indexOf(gate) < publishIndex, `${gate} must run before image publishing`);
  }
});

test('release workflow verifies PostgreSQL backup and restore before publishing images', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');
  const stepStart = workflow.indexOf('name: Verify PostgreSQL backup and restore');
  const publishIndex = workflow.indexOf('name: Push image tags');
  assert.notEqual(stepStart, -1, 'release workflow must verify database backup and restore');
  const step = workflow.slice(stepStart, workflow.indexOf('name: Build API Docker image'));

  assert.match(step, /backup_dir="\$\(mktemp -d\)"/);
  assert.match(step, /node scripts\/postgres-backup\.mjs seed-restore-sentinel/);
  assert.match(step, /node scripts\/postgres-backup\.mjs backup/);
  assert.match(step, /--database-url="\$\{DATABASE_URL\}"/);
  assert.match(step, /--docker-network=host/);
  assert.match(step, /--output-file=ci-postgres\.dump/);
  assert.match(step, /node scripts\/postgres-backup\.mjs verify-restore/);
  assert.match(step, /--dump-file="\$\{backup_dir\}\/ci-postgres\.dump"/);
  assert.match(step, /--expect-operational-sentinel/);
  assert.ok(
    step.indexOf('seed-restore-sentinel') < step.indexOf('postgres-backup.mjs backup'),
    'release workflow must seed operational data before taking the backup dump',
  );
  assert.ok(
    workflow.indexOf('name: Run migration runner against CI PostgreSQL') < stepStart,
    'backup verification must run after the release migration runner smoke',
  );
  assert.ok(stepStart < publishIndex, 'backup verification must run before image publishing');
});

test('release API Docker smoke runs in production mode and exercises keyed readiness before publish', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');
  const smokeStepEnd = workflow.indexOf('name: Smoke API Docker scheduled jobs');
  assert.notEqual(smokeStepEnd, -1, 'scheduled job smoke step must follow API smoke step');
  const smokeStep = workflow.slice(workflow.indexOf('name: Smoke API Docker image'), smokeStepEnd);

  assert.match(smokeStep, /-e NODE_ENV=production/);
  assert.match(smokeStep, /-e CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE=true/);
  assert.match(smokeStep, /-e CI=true/);
  assert.match(smokeStep, /-e GITHUB_ACTIONS=true/);
  assert.match(smokeStep, /-e TRUSTED_PROXY_ADDRESSES=10\.0\.0\.10/);
  assert.match(smokeStep, /-e READINESS_API_KEY=ci-readiness-key-with-enough-entropy/);
  assert.match(smokeStep, /readiness_unauthorized_status/);
  assert.match(smokeStep, /test "\$\{readiness_unauthorized_status\}" = "401"/);
  assert.match(smokeStep, /x-charitypilot-readiness-key: ci-readiness-key-with-enough-entropy/);
  assert.match(smokeStep, /test "\$\{readiness_status\}" = "503"/);
  assert.match(smokeStep, /body\.status !== 'not_ready'/);
  assert.match(smokeStep, /body\.checks\.database !== true/);
  assert.match(smokeStep, /body\.checks\.storageConfigured !== true/);
  assert.match(smokeStep, /body\.checks\.storageBucketReachable !== false/);
  assert.match(smokeStep, /disallowed_cors_headers="\$\(mktemp\)"/);
  assert.match(smokeStep, /-H "origin: https:\/\/not-charitypilot\.example"/);
  assert.match(
    smokeStep,
    /grep -qi "\^access-control-allow-origin: https:\/\/not-charitypilot\.example" "\$\{disallowed_cors_headers\}"/,
  );
  assert.match(smokeStep, /API Docker smoke must not allow an unapproved browser Origin/);
  assert.match(smokeStep, /register_email="api-smoke-\$\{GITHUB_SHA:-local\}@example\.com"/);
  assert.match(smokeStep, /register_payload="\$\(mktemp\)"/);
  assert.match(smokeStep, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/auth\/register/);
  assert.match(smokeStep, /register_first_status="\$\(curl[\s\S]*--data @"\$\{register_payload\}"/);
  assert.match(smokeStep, /register_duplicate_status="\$\(curl[\s\S]*--data @"\$\{register_payload\}"/);
  assert.match(smokeStep, /test "\$\{register_first_status\}" = "202"/);
  assert.match(smokeStep, /test "\$\{register_duplicate_status\}" = "202"/);
  assert.match(smokeStep, /bodyA\.message !== bodyB\.message/);
  assert.match(smokeStep, /check your email for next steps/);
  assert.match(smokeStep, /'\buser\b' in bodyA/);
  assert.match(smokeStep, /'\buser\b' in bodyB/);
  assert.match(smokeStep, /grep -qi "\^set-cookie:" "\$\{register_first_headers\}" "\$\{register_duplicate_headers\}"/);
  assert.match(smokeStep, /grep -qi "\^cache-control: no-store" "\$\{register_first_headers\}"/);
  assert.ok(
    workflow.indexOf('name: Smoke API Docker image') < workflow.indexOf('name: Push image tags'),
    'API image must be smoke-tested before publishing',
  );
});

test('release workflow smoke-runs production API scheduled job entrypoints before publish', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');
  const jobSmokeStep = workflow.slice(
    workflow.indexOf('name: Smoke API Docker scheduled jobs'),
    workflow.indexOf('name: Build web Docker image'),
  );
  const deadlineRun = dockerRunForCommand(
    jobSmokeStep,
    'charitypilot-api-ci node dist/jobs/send-deadline-reminders.js',
  );
  const cleanupRun = dockerRunForCommand(
    jobSmokeStep,
    'charitypilot-api-ci node dist/jobs/cleanup-document-storage.js',
  );
  const schedulerRun = dockerRunForCommand(jobSmokeStep, 'charitypilot-api-ci node dist/jobs/production-scheduler.js');

  assert.match(workflow, /name:\s+Smoke API Docker scheduled jobs/);
  assert.match(jobSmokeStep, /charitypilot_job_smoke/);
  assert.match(jobSmokeStep, /CREATE DATABASE charitypilot_job_smoke OWNER charitypilot/);
  assert.match(jobSmokeStep, /npx prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  for (const run of [deadlineRun, cleanupRun, schedulerRun]) {
    assert.match(run, /-e NODE_ENV=production/);
    assert.match(run, /-e CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE=true/);
    assert.match(run, /-e CI=true/);
    assert.match(run, /-e GITHUB_ACTIONS=true/);
    assert.match(
      run,
      /-e DATABASE_URL=postgresql:\/\/charitypilot:charitypilot_ci@127\.0\.0\.1:5432\/charitypilot_job_smoke/,
    );
  }
  assert.match(deadlineRun, /-e TRUSTED_PROXY_ADDRESSES=10\.0\.0\.10/);
  assert.match(deadlineRun, /-e READINESS_API_KEY=ci-readiness-key-with-enough-entropy/);
  assert.match(deadlineRun, /-e JWT_SECRET=ci-smoke-jwt-secret-with-enough-entropy/);
  assert.match(deadlineRun, /-e FRONTEND_URL=https:\/\/app\.charitypilot\.ie/);
  assert.match(deadlineRun, /-e AUTH_COOKIE_DOMAIN=\.charitypilot\.ie/);
  assert.match(deadlineRun, /-e NEXT_PUBLIC_API_URL="\$\{NEXT_PUBLIC_API_URL\}"/);
  assert.match(deadlineRun, /-e STRIPE_SECRET_KEY=sk_live_ci_smoke_secret/);
  assert.match(deadlineRun, /-e STRIPE_WEBHOOK_SECRET=whsec_ci_smoke_secret/);
  assert.match(deadlineRun, /-e RESEND_API_KEY=re_ci_smoke_key/);
  assert.match(deadlineRun, /-e EMAIL_FROM=noreply@charitypilot\.ie/);
  assert.match(deadlineRun, /-e SUPABASE_URL=https:\/\/ci-project\.supabase\.co/);
  assert.match(deadlineRun, /-e SUPABASE_SERVICE_ROLE_KEY=ci-configured-service-role-key/);
  assert.match(deadlineRun, /-e SUPABASE_STORAGE_BUCKET=documents/);
  assert.match(deadlineRun, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assert.match(cleanupRun, /-e SUPABASE_URL=https:\/\/ci-project\.supabase\.co/);
  assert.match(cleanupRun, /-e SUPABASE_SERVICE_ROLE_KEY=ci-configured-service-role-key/);
  assert.match(cleanupRun, /-e SUPABASE_STORAGE_BUCKET=documents/);
  assert.match(cleanupRun, /-e DOCUMENT_STORAGE_CLEANUP_LIMIT=1/);
  assert.match(cleanupRun, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assert.match(schedulerRun, /-e PRODUCTION_SCHEDULER_RUN_ONCE=true/);
  assert.match(schedulerRun, /-e FRONTEND_URL=https:\/\/app\.charitypilot\.ie/);
  assert.match(schedulerRun, /-e RESEND_API_KEY=re_ci_smoke_key/);
  assert.match(schedulerRun, /-e EMAIL_FROM=noreply@charitypilot\.ie/);
  assert.match(schedulerRun, /-e SUPABASE_URL=https:\/\/ci-project\.supabase\.co/);
  assert.match(schedulerRun, /-e SUPABASE_SERVICE_ROLE_KEY=ci-configured-service-role-key/);
  assert.match(schedulerRun, /-e SUPABASE_STORAGE_BUCKET=documents/);
  assert.match(schedulerRun, /-e DOCUMENT_STORAGE_CLEANUP_LIMIT=1/);
  assert.match(schedulerRun, /-e ERROR_ALERT_WEBHOOK_URL=https:\/\/alerts\.charitypilot\.ie\/hooks\/charitypilot/);
  assert.match(jobSmokeStep, /Deadline reminders job completed successfully\./);
  assert.match(
    jobSmokeStep,
    /\[DeadlineReminders\] Run complete - 0 reminder\(s\) provider-accepted, 0 failed, 0 uncertain, 0 deadline\(s\) skipped/,
  );
  assert.match(jobSmokeStep, /Document storage cleanup completed\. Processed: 0\. Failed: 0\./);
  assert.match(jobSmokeStep, /Production scheduler run-once completed successfully\./);
  assert.ok(
    workflow.indexOf('name: Build API Docker image') < workflow.indexOf('name: Smoke API Docker scheduled jobs'),
    'API image must be built before scheduled job smoke runs',
  );
  assert.ok(
    workflow.indexOf('name: Smoke API Docker image') < workflow.indexOf('name: Smoke API Docker scheduled jobs'),
    'API runtime smoke must run before scheduled job smoke',
  );
  assert.ok(
    workflow.indexOf('name: Smoke API Docker scheduled jobs') < workflow.indexOf('name: Push image tags'),
    'scheduled job smoke must run before publishing images',
  );
});

test('release workflow only publishes tag images for commits contained in master', () => {
  const workflow = readRepoFile('.github/workflows/release-images.yml');

  assert.match(workflow, /uses:\s+actions\/checkout@[a-f0-9]{40}\s+# v5[\s\S]*with:[\s\S]*fetch-depth:\s+0/);
  assert.match(workflow, /if \[ "\$\{GITHUB_REF_TYPE\}" = "tag" \]; then/);
  assert.match(workflow, /git fetch origin master:refs\/remotes\/origin\/master/);
  assert.match(workflow, /git merge-base --is-ancestor "\$\{GITHUB_SHA\}" origin\/master/);
  assert.match(workflow, /Release tags must point at a commit contained in master/);
});

test('stale Vercel API project auto-deploys are disabled while Docker is the release gate', () => {
  const apiVercelConfig = JSON.parse(readRepoFile('apps/api/vercel.json'));

  assert.equal(apiVercelConfig.$schema, 'https://openapi.vercel.sh/vercel.json');
  assert.equal(apiVercelConfig.git?.deploymentEnabled, false);
});
