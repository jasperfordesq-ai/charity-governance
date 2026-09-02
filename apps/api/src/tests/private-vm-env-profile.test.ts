import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import { assertDeploymentProfile } from '../utils/deployment-profile.js';
import { validateDeadlineRemindersEnv, validateProductionEnv } from '../utils/env.js';

// dist/tests/<this>.js → apps/api/dist/tests → repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TEMPLATE = join(REPO_ROOT, '.env.bluegreen.private-vm.example');
const ORIGINAL_ENV = { ...process.env };

const FILL: Record<string, string> = {
  REPLACE_ME_TAILSCALE_HOSTNAME: 'charitypilot.tail0000.ts.net',
  REPLACE_ME_POSTGRES_DB: 'charitypilot_personal_server',
  REPLACE_ME_POSTGRES_USER: 'charitypilot_personal_server',
  REPLACE_ME_POSTGRES_PASSWORD: 'a'.repeat(64),
  REPLACE_ME_JWT_SECRET: 'j'.repeat(48),
  REPLACE_ME_AUTH_RECOVERY_SECRET: '0123456789abcdef'.repeat(4),
  REPLACE_ME_READINESS_API_KEY: 'r'.repeat(40),
  REPLACE_ME_OWNER_JWT_SECRET: 'o'.repeat(48),
  REPLACE_ME_ENV_FILE_PATH: '/home/cpops/charity-governance/.bluegreen/private-vm.env',
};

function templateEnv(): Record<string, string> {
  assert.ok(existsSync(TEMPLATE), `private VM env template not found at ${TEMPLATE} (REPO_ROOT resolution wrong?)`);
  let text = readFileSync(TEMPLATE, 'utf8');
  for (const [key, value] of Object.entries(FILL)) text = text.split(key).join(value);
  assert.doesNotMatch(text, /REPLACE_ME_/, 'every placeholder in the template must be in FILL');
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

function applyEnv(values: Record<string, string>) {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  for (const key of ['CHARITYPILOT_DEPLOYMENT_MODE', 'ERROR_ALERT_WEBHOOK_URL', 'RESEND_API_KEY', 'SUPABASE_URL', 'STRIPE_SECRET_KEY']) {
    delete process.env[key];
  }
  Object.assign(process.env, values);
  // PORT is deliberately absent from the template: compose.bluegreen.yml
  // (and every other CharityPilot compose file) hardcodes PORT in the
  // service's own `environment:` block rather than reading it from the env
  // file, so it never belongs in this file. Every sibling suite that drives
  // validateProductionEnv against a compose-shaped fixture sets it the same
  // way (deployment-origins-env.test.ts's hostedEnv, personal-server-env
  // .test.ts) — mirrored here so this test reflects what actually reaches
  // process.env in the real container.
  process.env.PORT = '3002';
}

beforeEach(() => applyEnv(templateEnv()));
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

test('private VM template: the filled template passes the deployment profile, production, and job validators', () => {
  assert.doesNotThrow(() => assertDeploymentProfile());
  assert.doesNotThrow(() => validateProductionEnv());
  assert.doesNotThrow(() => validateDeadlineRemindersEnv());
});

test('private VM template: it runs the multi-tenant validator branch (dropping OWNER_JWT_SECRET is fatal)', () => {
  delete process.env.OWNER_JWT_SECRET;
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) =>
      error instanceof AppError &&
      Array.isArray(error.details) &&
      error.details.some((issue) => typeof issue === 'string' && /OWNER_JWT_SECRET/.test(issue)),
  );
});

test('private VM template: it is NOT the appliance branch (CHARITYPILOT_DEPLOYMENT_MODE is absent) and has no SaaS provider vars', () => {
  const values = templateEnv();
  assert.equal('CHARITYPILOT_DEPLOYMENT_MODE' in values, false);
  for (const forbidden of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'ERROR_ALERT_WEBHOOK_URL', 'PERSONAL_SERVER_OWNER_EMAIL']) {
    assert.equal(forbidden in values, false, `${forbidden} must not appear in the private VM template`);
  }
  assert.equal(values.CHARITYPILOT_TENANCY, 'multi');
  assert.equal(values.CHARITYPILOT_REGISTRATION, 'closed');
  assert.equal(values.CHARITYPILOT_EMAIL_DELIVERY, 'manual-link');
  assert.equal(values.CHARITYPILOT_BILLING, 'none');
  assert.equal(values.CHARITYPILOT_ERROR_ALERTS, 'none');
  assert.equal(values.DOCUMENT_STORAGE_DRIVER, 'local');
});

test('private VM template: the canonical-origin override is what makes the Tailscale origin acceptable (removing it is fatal)', () => {
  delete process.env.CHARITYPILOT_CANONICAL_WEB_ORIGIN;
  delete process.env.CHARITYPILOT_CANONICAL_API_ORIGIN;
  assert.throws(() => validateProductionEnv(), (error: unknown) => error instanceof AppError);
});
