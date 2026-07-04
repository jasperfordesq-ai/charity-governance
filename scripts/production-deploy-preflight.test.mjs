import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runProductionDeployPreflightFromArgs } from './production-deploy-preflight.mjs';

const digest = 'a'.repeat(64);

function completeDeployEnv(overrides = {}) {
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
    CADDY_ACME_EMAIL: 'ops@charitypilot.ie',
    CHARITYPILOT_WEB_DOMAIN: 'app.charitypilot.ie',
    CHARITYPILOT_API_DOMAIN: 'api.charitypilot.ie',
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`,
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL: 'https://configured-project.supabase.co',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function runPreflight(args, env = {}) {
  return runProductionDeployPreflightFromArgs(args, {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
    ...env,
  });
}

test('deploy preflight rejects mutable tag images before promotion', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-tag-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CHARITYPILOT_API_IMAGE: 'ghcr.io/jasperfordesq-ai/charity-governance-api:sha-test',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHARITYPILOT_API_IMAGE must be pinned to an immutable sha256 digest/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight rejects web image build origin drift before promotion', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-web-origin-drift-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: 'https://old-api.charitypilot.ie',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL must match NEXT_PUBLIC_API_URL from the promoted web image manifest/,
    );
    assert.doesNotMatch(result.stdout, /cosign verify/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight requires web image build origin metadata from the release manifest', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-web-origin-missing-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: '',
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL: '',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL is required from the release image digest manifest/,
    );
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL is required from the release image digest manifest/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight dry-run validates production environment values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-env-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    NEXT_PUBLIC_API_URL: 'https://attacker.example',
    CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://attacker.example',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /production environment validation failed/);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname/);
    assert.doesNotMatch(result.stdout, /cosign verify/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight dry-run emits production validation and signature verification commands', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-valid-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv());

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production deploy preflight dry-run/);
    assert.match(result.stdout, /node scripts\/check-production\.mjs "?--production-env-file=.*production\.env"?/);
    assert.match(
      result.stdout,
      /docker compose --env-file "?.*production\.env"? -f compose\.production\.yml -f compose\.production-tls\.yml config --quiet/,
    );
    assert.match(result.stdout, /cosign verify/);
    assert.match(result.stdout, /--certificate-identity-regexp "\^https:\/\/github\.com\/jasperfordesq-ai\/charity-governance\//);
    assert.match(result.stdout, /release-images\\\.yml@refs\/\(heads\/master\|tags\/v\.\*\)\$"/);
    assert.match(result.stdout, /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
    assert.match(result.stdout, /ghcr\.io\/jasperfordesq-ai\/charity-governance-api@sha256:[a-f0-9]{64}/);
    assert.match(result.stdout, /ghcr\.io\/jasperfordesq-ai\/charity-governance-web@sha256:[a-f0-9]{64}/);
    assert.match(result.stdout, /ghcr\.io\/jasperfordesq-ai\/charity-governance-migrations@sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(result.stdout, /[A-Z]:\\\\/);
    assert.doesNotMatch(result.stdout, /docker compose[\s\S]* up /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight can opt out of the TLS overlay when a managed load balancer terminates HTTPS', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-no-tls-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CADDY_ACME_EMAIL: '',
    CHARITYPILOT_WEB_DOMAIN: '',
    CHARITYPILOT_API_DOMAIN: '',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run', '--no-tls-proxy']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker compose --env-file "?.*production\.env"? -f compose\.production\.yml config --quiet/);
    assert.doesNotMatch(result.stdout, /compose\.production-tls\.yml/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight rejects TLS proxy hostname drift from canonical production origins', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-caddy-drift-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CHARITYPILOT_WEB_DOMAIN: 'charitypilot.ie',
    CHARITYPILOT_API_DOMAIN: 'services.charitypilot.ie',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHARITYPILOT_WEB_DOMAIN must match the canonical production web hostname app\.charitypilot\.ie/);
    assert.match(result.stderr, /CHARITYPILOT_API_DOMAIN must match the canonical production API hostname api\.charitypilot\.ie/);
    assert.doesNotMatch(result.stdout, /cosign verify/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
