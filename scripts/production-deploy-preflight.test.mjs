import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  redactProductionDeployTranscript,
  runProductionDeployPreflightFromArgs,
} from './production-deploy-preflight.mjs';

const digest = 'a'.repeat(64);
const productionSupabaseUrl = 'https://xjvdkmqbtczrnlqpswfa.supabase.co';

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
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_configuredSecret',
    CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    CADDY_ACME_EMAIL: 'ops@charitypilot.ie',
    CHARITYPILOT_WEB_DOMAIN: 'app.charitypilot.ie',
    CHARITYPILOT_API_DOMAIN: 'api.charitypilot.ie',
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`,
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
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

test('deploy transcript redaction removes production secret fragments', () => {
  const transcript = [
    'DATABASE_URL=postgresql://user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    'STRIPE_SECRET_KEY=sk_live_superSecret',
    'STRIPE_WEBHOOK_SECRET=whsec_superSecret',
    'RESEND_API_KEY=re_superSecret',
    'SUPABASE_SERVICE_ROLE_KEY=configured-service-role-key',
    'ERROR_ALERT_WEBHOOK_URL=https://hooks.example/alert?token=secret-token',
    'Authorization: Bearer configured-service-role-key',
    'apikey=configured-service-role-key',
  ].join('\n');

  const redacted = redactProductionDeployTranscript(transcript);

  assert.match(redacted, /DATABASE_URL=\[redacted\]/);
  assert.match(redacted, /STRIPE_SECRET_KEY=\[redacted\]/);
  assert.match(redacted, /STRIPE_WEBHOOK_SECRET=\[redacted\]/);
  assert.match(redacted, /RESEND_API_KEY=\[redacted\]/);
  assert.match(redacted, /SUPABASE_SERVICE_ROLE_KEY=\[redacted\]/);
  assert.match(redacted, /ERROR_ALERT_WEBHOOK_URL=\[redacted\]/);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.match(redacted, /apikey=\[redacted\]/);
  assert.doesNotMatch(redacted, /user:secret|sk_live_superSecret|whsec_superSecret|re_superSecret|secret-token|configured-service-role-key/);
});

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

test('deploy preflight requires web image API origin metadata from the release manifest', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-web-origin-missing-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: '',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL is required from the release image digest manifest/,
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

test('deploy preflight reports TLS proxy drift even when production env validation fails', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-env-and-tls-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    DATABASE_URL: 'REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
    CHARITYPILOT_WEB_DOMAIN: 'charitypilot.ie',
    CHARITYPILOT_API_DOMAIN: 'services.charitypilot.ie',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /production environment validation failed/);
    assert.match(result.stderr, /DATABASE_URL is missing or still contains a placeholder value/);
    assert.match(result.stderr, /TLS proxy validation also failed \(2 issues\):/);
    assert.match(result.stderr, /CHARITYPILOT_WEB_DOMAIN must match the canonical production web hostname app\.charitypilot\.ie/);
    assert.match(result.stderr, /CHARITYPILOT_API_DOMAIN must match the canonical production API hostname api\.charitypilot\.ie/);
    assert.doesNotMatch(result.stdout, /cosign verify/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight rejects placeholder TLS ACME contact emails', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-deploy-preflight-caddy-placeholder-'));
  const envPath = join(tempDir, 'production.env');

  writeFileSync(envPath, completeDeployEnv({
    CADDY_ACME_EMAIL: 'todo@example.com',
  }));

  try {
    const result = runPreflight(['--production-env-file', envPath, '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CADDY_ACME_EMAIL is required when the default TLS proxy overlay is enabled/);
    assert.doesNotMatch(result.stdout, /cosign verify/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy preflight rejects empty production env file option as usage error', () => {
  const result = runPreflight(['--production-env-file=', '--dry-run']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--production-env-file requires a value/);
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

test('deploy preflight redacts env file failure transcripts', () => {
  const result = runPreflight([
    '--production-env-file',
    'missing-production.env?token=secret-token',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production deploy preflight failed:/);
  assert.match(result.stderr, /token=\[redacted\]/);
  assert.doesNotMatch(result.stderr, /secret-token/);
});
