import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessLaunchState,
  collectRepositoryState,
  groupRemainingKeys,
  renderLaunchStatusJson,
  renderLaunchStatusText,
} from './launch-status.mjs';
import { OPERATOR_SUPPLIED_KEYS } from './generate-production-env.mjs';
import { renderProductionLaunchEvidenceTemplate } from './generate-production-launch-evidence-template.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launchStatusScript = join(repoRoot, 'scripts', 'launch-status.mjs');
const productionSupabaseUrl = 'https://xjvdkmqbtczrnlqpswfa.supabase.co';
const stripeSecretFixture = ['sk', 'live', 'fixture'].join('_');
const stripeWebhookFixture = ['whsec', 'fixture'].join('_');
const stripePublishableFixture = ['pk', 'live', 'fixture'].join('_');
const resendApiFixture = ['re', 'fixture'].join('_');
const supabaseServiceRoleFixture = ['supabase', 'service-role', 'fixture'].join('_');
const VALID_PRODUCTION_VALUES = {
  DATABASE_URL: 'postgresql://charitypilot:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
  FRONTEND_URL: 'https://app.charitypilot.ie',
  NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
  CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
  NEXT_PUBLIC_SUPABASE_URL: productionSupabaseUrl,
  CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL: productionSupabaseUrl,
  SUPABASE_URL: productionSupabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleFixture,
  STRIPE_SECRET_KEY: stripeSecretFixture,
  STRIPE_WEBHOOK_SECRET: stripeWebhookFixture,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableFixture,
  STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_1R9xEssentialsMonthly',
  STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_1R9xEssentialsYearly',
  STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_1R9xCompleteMonthly',
  STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_1R9xCompleteYearly',
  RESEND_API_KEY: resendApiFixture,
  EMAIL_FROM: 'noreply@charitypilot.ie',
  ERROR_ALERT_WEBHOOK_URL: 'https://alerts.charitypilot.ie/hooks/charitypilot',
  TRUSTED_PROXY_ADDRESSES: '203.0.113.10/32',
  AUTH_COOKIE_DOMAIN: '.charitypilot.ie',
  CADDY_ACME_EMAIL: 'ops@charitypilot.ie',
  CHARITYPILOT_WEB_DOMAIN: 'app.charitypilot.ie',
  CHARITYPILOT_API_DOMAIN: 'api.charitypilot.ie',
  CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${'a'.repeat(64)}`,
  CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${'b'.repeat(64)}`,
  CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${'c'.repeat(64)}`,
  CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
  CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL: productionSupabaseUrl,
};

function productionEnv(overrides = {}) {
  return [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'READINESS_API_KEY=already-generated-readiness-key-1234567890',
    ...OPERATOR_SUPPLIED_KEYS.map(([key]) => `${key}=${Object.hasOwn(overrides, key) ? overrides[key] : VALID_PRODUCTION_VALUES[key]}`),
  ].join('\n');
}

function assertExternalLaunchEvidenceGates(state) {
  assert.ok(
    Array.isArray(state.externalEvidenceGates),
    'launch status must expose the external evidence gates separately from env placeholders',
  );
  const gates = state.externalEvidenceGates.join('\n');
  assert.match(gates, /production-launch-evidence\.json/);
  assert.match(gates, /87 machine-readable checks/);
  assert.match(gates, /GitHub production environment/);
  assert.match(gates, /GitHub production secret-store verification/);
  assert.match(gates, /browserQa\.checks\.accessibility-coverage/);
  assert.match(gates, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(gates, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(gates, /E2E_DEPLOYED_QA=true/);
  assert.match(gates, /npm run check:production:browser-qa-env/);
  assert.match(gates, /Deployed browser QA environment preflight passed/);
  assert.match(gates, /all four focused route chunks/);
  assert.match(gates, /npm run test:e2e:responsive/);
  assert.match(gates, /Launch-Critical Route Inventory/);
  assert.match(gates, /every route in desktop, mobile, light-mode, and dark-mode evidence/);
  assert.match(gates, /pending-navigation confirmation/);
  assert.match(gates, /conditional obligations/);
  assert.match(gates, /readiness blockers/);
  assert.match(gates, /every browser QA evidence slot must bind to the exact promoted release\.commitSha/);
  assert.match(gates, /browserQa\.checks\.browser-qa-completed/);
  assert.match(gates, /browserQa\.checks\.desktop-coverage/);
  assert.match(gates, /browserQa\.checks\.mobile-coverage/);
  assert.match(gates, /browserQa\.checks\.critical-flows-covered/);
  assert.doesNotMatch(gates, /browserQa\.checks\.critical-flows(?!-covered)/);
  assert.match(gates, /solicitor\/governance\/privacy review/);
  assert.match(gates, /external penetration test/);
}

function assertDeployedBrowserQaCommands(commands) {
  assert.deepEqual(commands.requiredEnvironment, [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'E2E_OWNER_EMAIL from the approved non-sensitive test workspace',
    'E2E_OWNER_PASSWORD from the approved non-sensitive test workspace',
  ]);
  assert.equal(commands.preflightCommand, 'npm run check:production:browser-qa-env');
  assert.equal(commands.preflightJsonCommand, 'npm run check:production:browser-qa-env -- --json');
  assert.match(commands.evidenceTarget, /browserQa\.checks\.browser-qa-completed/);
  assert.match(commands.evidenceTarget, /Deployed browser QA environment preflight passed/);
  assert.equal(commands.responsiveCommand, 'npm run test:e2e:responsive');
  assert.deepEqual(commands.focusedResponsiveCommands, [
    'npm run test:e2e:responsive:public:desktop',
    'npm run test:e2e:responsive:public:mobile',
    'npm run test:e2e:responsive:dashboard:desktop',
    'npm run test:e2e:responsive:dashboard:mobile',
  ]);
  assert.equal(commands.accessibilityCommand, 'npm run test:e2e -- tests/accessibility.spec.ts');
  assert.equal(commands.crossBrowserResponsiveCommand, 'npm run test:e2e:deployed:responsive:cross-browser');
  assert.equal(commands.crossBrowserAccessibilityCommand, 'npm run test:e2e:deployed:accessibility:cross-browser');
  assert.match(commands.iosSafariEvidence, /real iOS Safari/);
  assert.match(commands.evidenceTarget, /browserQa\.checks/);
}

function assertLocalPersonalReadiness(readiness) {
  assert.equal(readiness.command, 'npm run personal:ready');
  assert.equal(readiness.docs, 'docs/personal-local-use.md');
  assert.match(readiness.purpose, /Non-destructive local confidence gate/);
  assert.match(readiness.purpose, /without Stripe, Supabase, Resend, public hosting, or payments/);
  assert.ok(readiness.proves.includes('seeded local owner sign-in'));
  assert.ok(readiness.proves.includes('PostgreSQL backup and restore verification'));
  assert.ok(readiness.proves.includes('local document storage backup copy'));
  assert.ok(readiness.proves.some((item) => /billing safely disabled/.test(item)));
  assert.match(readiness.warning, /Do not run the default full E2E suite/);
  assert.match(readiness.warning, /reset tenant\/app tables/);
  assert.match(readiness.notLaunchEvidence, /does not replace production provider/);
  assert.match(readiness.notLaunchEvidence, /final signoff evidence/);
}

function assertProductionLaunchCommands(commands) {
  assert.equal(commands.corePreflight, 'npm run check:production -- --production-env-file=.env.production');
  assert.equal(commands.githubEnvironment, 'npm run check:production:github-env -- --environment=production');
  assert.equal(commands.githubEnvironmentJson, 'npm run check:production:github-env -- --environment=production --json');
  assert.equal(commands.githubSecretStore, 'npm run check:production:github-secrets -- --environment=production');
  assert.equal(
    commands.githubSecretStoreJson,
    'npm run check:production:github-secrets -- --environment=production --json',
  );
  assert.equal(commands.hosting, 'npm run check:production:hosting -- --production-env-file=.env.production');
  assert.equal(
    commands.database,
    'npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel',
  );
  assert.equal(commands.supabase, 'npm run check:production:supabase -- --production-env-file=.env.production');
  assert.equal(commands.providers, 'npm run check:production:providers -- --production-env-file=.env.production');
  assert.equal(
    commands.observability,
    'npm run check:production:observability -- --production-env-file=.env.production',
  );
  assert.equal(commands.deployedBrowserQaPreflight, 'npm run check:production:browser-qa-env');
  assert.equal(commands.deployedBrowserQaPreflightJson, 'npm run check:production:browser-qa-env -- --json');
  assert.equal(commands.deployPreflight, 'npm run deploy:preflight -- --production-env-file=.env.production');
  assert.equal(commands.deployProduction, 'npm run deploy:production -- --production-env-file=.env.production');
  assert.equal(
    commands.rollbackRehearsal,
    'npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env',
  );
  assert.equal(
    commands.releaseRunEvidence,
    'npm run check:production:release-run -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
  );
  assert.equal(
    commands.releaseRunEvidenceJson,
    'npm run check:production:release-run -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
  );
  assert.equal(
    commands.finalEvidenceValidation,
    'npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
  );
  assert.equal(
    commands.finalEvidenceValidationJson,
    'npm run check:production:evidence -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
  );
}

function assertFinalLaunchEvidenceWorkflow(workflow) {
  assert.equal(workflow.uploadWorkflowFile, '.github/workflows/upload-production-launch-evidence.yml');
  assert.equal(workflow.workflowFile, '.github/workflows/production-launch-evidence.yml');
  assert.equal(workflow.githubEnvironment, 'production');
  assert.equal(workflow.requiredInput, 'evidence_artifact_run_id');
  assert.equal(workflow.defaultArtifactName, 'production-launch-evidence');
  assert.equal(workflow.defaultEvidenceFileName, 'production-launch-evidence.json');
  assert.equal(workflow.validationArtifactName, 'production-launch-evidence-validation');
  assert.deepEqual(workflow.validationArtifactFiles, [
    'production-launch-evidence-validation.log',
    'production-release-run-evidence.json',
    'production-launch-evidence-validation.json',
  ]);
  assert.equal(
    workflow.prepareUploadCommand,
    'npm run prepare:production:evidence-upload -- --json | gh workflow run upload-production-launch-evidence.yml --ref master --json',
  );
  assert.match(workflow.uploadEvidenceTarget, /upload-production-launch-evidence\.yml run id/);
  assert.match(workflow.uploadEvidenceTarget, /evidence_artifact_run_id/);
  assert.equal(
    workflow.runCommand,
    'gh workflow run production-launch-evidence.yml --ref master -f evidence_artifact_run_id=EVIDENCE_ARTIFACT_RUN_ID -f evidence_artifact_name=production-launch-evidence -f evidence_file_name=production-launch-evidence.json',
  );
  assert.match(workflow.evidenceTarget, /protected workflow run URL/);
  assert.match(workflow.evidenceTarget, /production-launch-evidence-validation/);
  assert.match(workflow.evidenceTarget, /pass\/fail command statuses/);
  assert.match(workflow.evidenceTarget, /JSON validation files/);
}

function assertReleaseImagePromotion(promotion) {
  assert.equal(promotion.githubEnvironment, 'production');
  assert.deepEqual(promotion.requiredGitHubEnvironmentVariables, [
    'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
    'NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co (replace <project-ref> before running release-images.yml)',
  ]);
  assert.deepEqual(promotion.configureCommands, [
    'gh variable set NEXT_PUBLIC_API_URL --env production --repo jasperfordesq-ai/charity-governance --body "https://api.charitypilot.ie"',
    'gh variable set NEXT_PUBLIC_SUPABASE_URL --env production --repo jasperfordesq-ai/charity-governance --body "https://<project-ref>.supabase.co"  # replace <project-ref> first',
  ]);
  assert.doesNotMatch(promotion.requiredGitHubEnvironmentVariables.join('\n'), /REAL_SUPABASE_PROJECT_REF/);
  assert.doesNotMatch(promotion.configureCommands.join('\n'), /REAL_SUPABASE_PROJECT_REF/);
  assert.doesNotMatch(promotion.requiredGitHubEnvironmentVariables.join('\n'), /YOUR_SUPABASE_PROJECT_REF/);
  assert.doesNotMatch(promotion.configureCommands.join('\n'), /YOUR_SUPABASE_PROJECT_REF/);
  assert.equal(promotion.workflowCommand, 'gh workflow run release-images.yml --ref master');
  assert.equal(promotion.watchCommand, 'gh run watch RELEASE_RUN_ID --exit-status');
  assert.equal(promotion.githubEnvironmentCheckCommand, 'npm run check:production:github-env -- --environment=production');
  assert.equal(
    promotion.githubEnvironmentCheckJsonCommand,
    'npm run check:production:github-env -- --environment=production --json',
  );
  assert.equal(promotion.evidenceArtifact, 'release-image-digests.env');
  assert.match(promotion.evidenceTarget, /CHARITYPILOT_\*_IMAGE/);
  assert.match(promotion.evidenceTarget, /CHARITYPILOT_WEB_BUILD_\*/);
}

function assertFinalSignoffRequirements(requirements) {
  assert.deepEqual(requirements.requiredRoles, [
    'engineering',
    'operations',
    'security',
    'legalCompliance',
    'business',
  ]);
  assert.deepEqual(requirements.externalReviews, [
    'solicitor review',
    'governance review',
    'privacy review',
    'external penetration test',
    'critical/high findings remediated or formally accepted',
  ]);
  assert.match(requirements.releaseBinding, /release\.commitSha/);
  assert.match(requirements.evidenceTarget, /finalSignoff/);
  assert.match(requirements.legalPosture, /not legal advice/);
  assert.doesNotMatch(requirements.legalPosture, /bombproof|guaranteed/i);
}

test('launch status script text is ASCII-safe for operator transcripts', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'launch-status.mjs'), 'utf8');

  assert.doesNotMatch(source, /[^\x00-\x7F]/);
  assert.match(source, /external gates/);
  assert.match(source, /Release image promotion/);
});

test('launch status rejects unknown CLI options before producing operator evidence', () => {
  const result = spawnSync(process.execPath, [launchStatusScript, '--definitely-not-a-real-option'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown option: --definitely-not-a-real-option/);
  assert.match(result.stderr, /Usage: node scripts\/launch-status\.mjs \[--json\]/);
});

test('reports NO_ENV and points at the generator when .env.production is absent', () => {
  const s = assessLaunchState({ envExists: false, evidenceFileExists: false });
  assert.equal(s.phase, 'NO_ENV');
  assert.ok(s.nextActions.some((a) => a.includes('setup:production-env')));
  assert.equal(s.evidenceLedger.exists, false);
  assert.match(s.evidenceLedger.nextAction, /check:production:evidence:init/);
  assert.match(s.evidenceLedger.statusCommand, /check:production:evidence:status/);
  assert.match(s.evidenceLedger.jsonStatusCommand, /--json/);
  assert.match(s.evidenceLedger.validationCommand, /check:production:evidence -- --evidence-file/);
  assert.match(s.evidenceLedger.jsonValidationCommand, /check:production:evidence -- --json --evidence-file/);
  assert.equal(s.expectedProductionValueGroups.length, 8);
  assert.deepEqual(s.expectedProductionValueGroups.map((group) => group.label), [
    'Hosting, DNS, TLS, and proxy',
    'PostgreSQL',
    'Stripe billing',
    'Resend email',
    'Supabase storage',
    'Observability',
    'Release image promotion',
    'Other',
  ]);
  assert.ok(s.expectedProductionValueGroups.some((group) => group.keys.includes('CHARITYPILOT_API_IMAGE')));
  assert.ok(s.expectedProductionValueGroups.some((group) => group.keys.includes('EMAIL_FROM')));
  assert.ok(s.expectedProductionValueGroups.some((group) => group.keys.includes('AUTH_COOKIE_DOMAIN')));
  assert.ok(s.expectedProductionValueGroups.some((group) => group.keys.includes('CHARITYPILOT_WEB_DOMAIN')));
  assert.match(JSON.stringify(s.expectedProductionValueGroups), /Stripe live secret key/);
  assert.doesNotMatch(JSON.stringify(s.expectedProductionValueGroups), /sk_live_\.\.\.|whsec_\.\.\.|pk_live_\.\.\.|re_\.\.\./);
  const payload = JSON.parse(renderLaunchStatusJson(s));
  assert.equal(payload.phase, 'NO_ENV');
  assert.deepEqual(payload.expectedProductionValueGroups, s.expectedProductionValueGroups);
  assert.deepEqual(payload.launchProgress.productionValues, { completed: 0, total: 28, remaining: 28 });
  assert.equal(payload.launchProgress.evidenceChecks, null);
  assert.equal(payload.launchProgress.finalSignoffs, null);
  assert.deepEqual(payload.launchProgress.strictLaunchGates, { completed: 0, total: 120, remaining: 120 });
  assert.deepEqual(payload.launchProgress.percentages, {
    productionValues: 0,
    evidenceChecks: 0,
    finalSignoffs: 0,
    strictLaunchGates: 0,
  });
  assert.equal(payload.launchProgress.approvedForLaunch, false);
  assertProductionLaunchCommands(payload.productionLaunchCommands);
  assertFinalLaunchEvidenceWorkflow(payload.finalLaunchEvidenceWorkflow);
  assertReleaseImagePromotion(payload.releaseImagePromotion);
  assertDeployedBrowserQaCommands(payload.deployedBrowserQa);
  assertLocalPersonalReadiness(payload.localPersonalReadiness);
  assertFinalSignoffRequirements(payload.finalSignoffRequirements);
  assertExternalLaunchEvidenceGates(s);
});

test('reports ENV_INCOMPLETE and lists the unfilled keys', () => {
  const env = productionEnv({
    DATABASE_URL: 'REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
    STRIPE_SECRET_KEY: 'REPLACE_ME_STRIPE_LIVE_SECRET_KEY',
  });
  const s = assessLaunchState({ envExists: true, envContent: env, evidenceFileExists: true });
  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.match(s.headline, /production value issue\(s\) still need resolution/);
  assert.deepEqual(s.remainingKeys.sort(), ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
  assert.deepEqual(s.remainingKeyDetails, [
    { key: 'DATABASE_URL', reason: 'placeholder', detail: 'Value still contains a REPLACE_ME placeholder.' },
    { key: 'STRIPE_SECRET_KEY', reason: 'placeholder', detail: 'Value still contains a REPLACE_ME placeholder.' },
  ]);
  assert.deepEqual(s.remainingKeyGroups.map((group) => ({ label: group.label, keys: group.keys })), [
    { label: 'PostgreSQL', keys: ['DATABASE_URL'] },
    { label: 'Stripe billing', keys: ['STRIPE_SECRET_KEY'] },
  ]);
  assert.match(s.remainingKeyGroups[0].items[0].hint, /PostgreSQL URL/);
  assert.match(s.remainingKeyGroups[1].items[0].hint, /Stripe live secret key/);
  assert.doesNotMatch(JSON.stringify(s.remainingKeyGroups), /sk_live_\.\.\.|whsec_\.\.\.|pk_live_\.\.\.|re_\.\.\./);
  assert.equal(s.expectedProductionValueGroups.length, 8);
  assert.ok(s.expectedProductionValueGroups.some((group) => group.keys.includes('EMAIL_FROM')));
  assert.ok(s.expectedProductionValueGroups.some((group) => group.keys.includes('DATABASE_URL')));
  assert.ok(s.expectedProductionValueGroups.some((group) => group.keys.includes('CADDY_ACME_EMAIL')));
  assert.match(JSON.stringify(s.expectedProductionValueGroups), /https:\/\/<project-ref>\.supabase\.co \(replace <project-ref> before use\)/);
  assert.doesNotMatch(JSON.stringify(s.expectedProductionValueGroups), /Supabase project URL, https:\/\/REPLACE_ME_SUPABASE_PROJECT_REF\.supabase\.co/);
  assert.equal(s.evidenceLedger.exists, true);
  assert.deepEqual(s.launchProgress.productionValues, { completed: 26, total: 28, remaining: 2 });
  assert.match(s.evidenceLedger.nextAction, /check:production:evidence:status/);
  assert.match(s.evidenceLedger.validationCommand, /check:production:evidence -- --evidence-file/);
  assert.match(s.evidenceLedger.jsonValidationCommand, /check:production:evidence -- --json --evidence-file/);
  assert.ok(s.nextActions.some((a) => /replace placeholders, fill real provider values, or correct drifted TLS\/cookie settings/.test(a)));
  assert.ok(s.nextActions.some((a) => a.includes('check:production')));
  assertExternalLaunchEvidenceGates(s);
});

test('reports ENV_INCOMPLETE for non-REPLACE_ME production placeholders', () => {
  const env = productionEnv({
    STRIPE_SECRET_KEY: 'TODO_STRIPE_LIVE_SECRET_KEY',
    NEXT_PUBLIC_SUPABASE_URL: 'https://REAL_SUPABASE_PROJECT_REF.supabase.co',
    CHARITYPILOT_WEB_IMAGE: 'ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:placeholder',
  });

  const s = assessLaunchState({ envExists: true, envContent: env, evidenceFileExists: true });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, [
    'NEXT_PUBLIC_SUPABASE_URL',
    'STRIPE_SECRET_KEY',
    'CHARITYPILOT_WEB_IMAGE',
  ]);
  assert.deepEqual(s.remainingKeyDetails, [
    { key: 'NEXT_PUBLIC_SUPABASE_URL', reason: 'placeholder', detail: 'Value still contains placeholder text.' },
    { key: 'STRIPE_SECRET_KEY', reason: 'placeholder', detail: 'Value still contains placeholder text.' },
    { key: 'CHARITYPILOT_WEB_IMAGE', reason: 'placeholder', detail: 'Value still contains placeholder text.' },
  ]);
  assert.deepEqual(s.launchProgress.productionValues, { completed: 25, total: 28, remaining: 3 });
});

test('reports ENV_INCOMPLETE for sample Supabase project refs', () => {
  const env = productionEnv({
    SUPABASE_URL: 'https://configured-project.supabase.co',
    NEXT_PUBLIC_SUPABASE_URL: 'https://configured-project.supabase.co',
    CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL: 'https://configured-project.supabase.co',
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL: 'https://configured-project.supabase.co',
  });

  const s = assessLaunchState({ envExists: true, envContent: env, evidenceFileExists: true });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, [
    'NEXT_PUBLIC_SUPABASE_URL',
    'CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_URL',
    'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL',
  ]);
  assert.deepEqual(
    s.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason })),
    [
      { key: 'NEXT_PUBLIC_SUPABASE_URL', reason: 'sample-supabase-project-ref' },
      { key: 'CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL', reason: 'sample-supabase-project-ref' },
      { key: 'SUPABASE_URL', reason: 'sample-supabase-project-ref' },
      { key: 'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL', reason: 'sample-supabase-project-ref' },
    ],
  );
  assert.deepEqual(s.launchProgress.productionValues, { completed: 24, total: 28, remaining: 4 });
  assert.doesNotMatch(renderLaunchStatusText(s), /configured-project/);
});

test('reports ENV_INCOMPLETE for copied provider placeholder values', () => {
  const env = productionEnv({
    STRIPE_SECRET_KEY: 'sk_live_configured',
    STRIPE_WEBHOOK_SECRET: 'whsec_configured',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_configured',
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: 'price_essentials_monthly',
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: 'price_essentials_yearly',
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: 'price_complete_monthly',
    STRIPE_COMPLETE_YEARLY_PRICE_ID: 'price_complete_yearly',
    RESEND_API_KEY: 're_configured',
  });

  const s = assessLaunchState({ envExists: true, envContent: env, evidenceFileExists: true });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
    'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
    'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
    'STRIPE_COMPLETE_YEARLY_PRICE_ID',
    'RESEND_API_KEY',
  ]);
  assert.deepEqual(
    s.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason })),
    [
      { key: 'STRIPE_SECRET_KEY', reason: 'provider-placeholder' },
      { key: 'STRIPE_WEBHOOK_SECRET', reason: 'provider-placeholder' },
      { key: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', reason: 'provider-placeholder' },
      { key: 'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID', reason: 'provider-placeholder' },
      { key: 'STRIPE_ESSENTIALS_YEARLY_PRICE_ID', reason: 'provider-placeholder' },
      { key: 'STRIPE_COMPLETE_MONTHLY_PRICE_ID', reason: 'provider-placeholder' },
      { key: 'STRIPE_COMPLETE_YEARLY_PRICE_ID', reason: 'provider-placeholder' },
      { key: 'RESEND_API_KEY', reason: 'provider-placeholder' },
    ],
  );
  assert.deepEqual(s.launchProgress.productionValues, { completed: 20, total: 28, remaining: 8 });
  assert.doesNotMatch(renderLaunchStatusText(s), /sk_live_configured|whsec_configured|pk_live_configured|re_configured|price_essentials/);
});

test('reports ENV_INCOMPLETE for copied Supabase service-role placeholder values', () => {
  const env = productionEnv({
    SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key-from-secret-store',
  });

  const s = assessLaunchState({ envExists: true, envContent: env, evidenceFileExists: true });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, ['SUPABASE_SERVICE_ROLE_KEY']);
  assert.deepEqual(
    s.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason })),
    [{ key: 'SUPABASE_SERVICE_ROLE_KEY', reason: 'provider-placeholder' }],
  );
  assert.deepEqual(s.launchProgress.productionValues, { completed: 27, total: 28, remaining: 1 });
  assert.doesNotMatch(renderLaunchStatusText(s), /supabase-service-role-key-from-secret-store/);
});

test('groups missing production values by operator source', () => {
  const groups = groupRemainingKeys([
    'CHARITYPILOT_WEB_IMAGE',
    'SUPABASE_SERVICE_ROLE_KEY',
    'UNKNOWN_VALUE',
    'STRIPE_WEBHOOK_SECRET',
    'TRUSTED_PROXY_ADDRESSES',
  ]);

  assert.deepEqual(groups.map((group) => ({ label: group.label, keys: group.keys })), [
    { label: 'Hosting, DNS, TLS, and proxy', keys: ['TRUSTED_PROXY_ADDRESSES'] },
    { label: 'Stripe billing', keys: ['STRIPE_WEBHOOK_SECRET'] },
    { label: 'Supabase storage', keys: ['SUPABASE_SERVICE_ROLE_KEY'] },
    { label: 'Release image promotion', keys: ['CHARITYPILOT_WEB_IMAGE'] },
    { label: 'Other', keys: ['UNKNOWN_VALUE'] },
  ]);
  assert.match(groups[0].items[0].hint, /Reverse-proxy IP\/CIDR/);
  assert.match(groups[1].items[0].hint, /webhook signing secret/);
  assert.match(groups[2].items[0].hint, /service role key/);
  assert.match(groups[3].items[0].hint, /Digest-pinned web image ref/);
  assert.match(groups[4].items[0].hint, /Operator-supplied production value/);
});

test('reports TLS and shared-cookie production drift before deploy preflight', () => {
  const env = productionEnv({
    AUTH_COOKIE_DOMAIN: '',
    CHARITYPILOT_WEB_DOMAIN: 'charitypilot.ie',
  });

  const s = assessLaunchState({ envExists: true, envContent: env });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, ['AUTH_COOKIE_DOMAIN', 'CHARITYPILOT_WEB_DOMAIN']);
  assert.deepEqual(
    s.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason, expected: issue.expected })),
    [
      { key: 'AUTH_COOKIE_DOMAIN', reason: 'missing', expected: undefined },
      { key: 'CHARITYPILOT_WEB_DOMAIN', reason: 'canonical-drift', expected: 'app.charitypilot.ie' },
    ],
  );
  assert.deepEqual(s.remainingKeyGroups.map((group) => ({ label: group.label, keys: group.keys })), [
    { label: 'Hosting, DNS, TLS, and proxy', keys: ['AUTH_COOKIE_DOMAIN', 'CHARITYPILOT_WEB_DOMAIN'] },
  ]);
  assert.match(s.remainingKeyGroups[0].items[0].hint, /Shared cookie domain/);
  assert.match(s.remainingKeyGroups[0].items[1].hint, /app\.charitypilot\.ie/);
  assert.ok(s.nextActions.some((a) => /correct drifted TLS\/cookie settings/.test(a)));
});

test('reports structurally invalid production values before ENV_COMPLETE', () => {
  const env = productionEnv({
    TRUSTED_PROXY_ADDRESSES: '0.0.0.0/0',
    DATABASE_URL: 'postgresql://charitypilot:secret@localhost:5432/charitypilot',
    FRONTEND_URL: 'http://app.charitypilot.ie/path',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie/v1',
  });

  const s = assessLaunchState({ envExists: true, envContent: env });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, [
    'TRUSTED_PROXY_ADDRESSES',
    'DATABASE_URL',
    'FRONTEND_URL',
    'NEXT_PUBLIC_API_URL',
  ]);
  assert.deepEqual(
    s.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason })),
    [
      { key: 'TRUSTED_PROXY_ADDRESSES', reason: 'preflight-invalid' },
      { key: 'DATABASE_URL', reason: 'preflight-invalid' },
      { key: 'FRONTEND_URL', reason: 'preflight-invalid' },
      { key: 'NEXT_PUBLIC_API_URL', reason: 'preflight-invalid' },
    ],
  );
  const details = s.remainingKeyDetails.map((issue) => issue.detail).join('\n');
  assert.match(details, /explicit proxy IP addresses or CIDR ranges/);
  assert.match(details, /must not point at localhost/);
  assert.match(details, /sslmode=require/);
  assert.match(details, /must use https:\/\//);
  assert.match(details, /origin-only URL/);
  assert.deepEqual(s.launchProgress.productionValues, { completed: 24, total: 28, remaining: 4 });
});

test('keeps placeholder issue reasons ahead of canonical drift checks', () => {
  const env = productionEnv({
    AUTH_COOKIE_DOMAIN: 'REPLACE_ME_SHARED_COOKIE_DOMAIN',
    CADDY_ACME_EMAIL: 'REPLACE_ME_ACME_EMAIL',
    CHARITYPILOT_WEB_DOMAIN: 'charitypilot.ie',
  });

  const s = assessLaunchState({ envExists: true, envContent: env });

  assert.deepEqual(
    s.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason, expected: issue.expected })),
    [
      { key: 'AUTH_COOKIE_DOMAIN', reason: 'placeholder', expected: undefined },
      { key: 'CADDY_ACME_EMAIL', reason: 'placeholder', expected: undefined },
      { key: 'CHARITYPILOT_WEB_DOMAIN', reason: 'canonical-drift', expected: 'app.charitypilot.ie' },
    ],
  );
});

test('reports launch evidence completion counts when the evidence ledger exists', () => {
  const env = productionEnv({
    DATABASE_URL: 'REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
  });
  const s = assessLaunchState({
    envExists: true,
    envContent: env,
    evidenceFileExists: true,
    evidenceContent: JSON.stringify({ approvedForLaunch: false, finalSignoff: { status: 'pending' }, areas: {} }),
  });

  assert.equal(s.evidenceLedger.exists, true);
  assert.equal(s.evidenceLedger.completedChecks, 0);
  assert.equal(s.evidenceLedger.totalChecks, 87);
  assert.equal(s.evidenceLedger.approvedForLaunch, false);
  assert.equal(s.evidenceLedger.evidenceStatusesComplete, false);
  assert.equal(s.evidenceLedger.approvedFinalSignoffRoles, 0);
  assert.equal(s.evidenceLedger.finalSignoffStatus, 'pending');
  assert.equal(s.evidenceLedger.totalFinalSignoffRoles, 5);
  assert.deepEqual(s.evidenceLedger.nextIncompleteChecks.slice(0, 3), [
    'releaseGate.npm-ci (missing)',
    'releaseGate.db-generate (missing)',
    'releaseGate.prisma-validate (missing)',
  ]);
  assert.deepEqual(
    s.evidenceLedger.nextIncompleteCheckDetails.slice(0, 2).map((check) => ({
      path: check.path,
      status: check.status,
      hints: check.requiredEvidenceHints,
    })),
    [
      { path: 'releaseGate.npm-ci', status: 'missing', hints: ['npm ci', 'exit 0'] },
      { path: 'releaseGate.db-generate', status: 'missing', hints: ['npm run db:generate -w @charitypilot/api', 'exit 0'] },
    ],
  );
  assert.match(s.evidenceLedger.headline, /Checklist checks complete: 0 \/ 87/);
  assert.match(s.evidenceLedger.validationCommand, /check:production:evidence -- --evidence-file/);
  assert.match(s.evidenceLedger.jsonValidationCommand, /check:production:evidence -- --json --evidence-file/);
  assert.equal(s.evidenceLedger.workQueueByArea[0].id, 'releaseGate');
  assert.equal(s.evidenceLedger.workQueueByArea[0].remaining, 20);
  assert.equal(s.evidenceLedger.workQueueByArea.find((area) => area.id === 'browserQa').remaining, 7);
});

test('reports missing operator-supplied production values instead of treating a trimmed env as complete', () => {
  const env = [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'DATABASE_URL=postgresql://u:p@db.charitypilot.ie:5432/cp?sslmode=require',
  ].join('\n');

  const s = assessLaunchState({ envExists: true, envContent: env, evidenceFileExists: false });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.ok(s.remainingKeys.includes('FRONTEND_URL'));
  assert.ok(s.remainingKeys.includes('STRIPE_SECRET_KEY'));
  assert.ok(s.remainingKeys.includes('CHARITYPILOT_WEB_IMAGE'));
  assert.deepEqual(s.launchProgress.productionValues, { completed: 1, total: 28, remaining: 27 });
  assert.deepEqual(s.remainingKeyDetails.find((issue) => issue.key === 'FRONTEND_URL'), {
    key: 'FRONTEND_URL',
    reason: 'missing',
    detail: 'Value is missing from .env.production or the approved production secret source.',
  });
  assert.ok(s.remainingKeyGroups.some((group) => group.label === 'Hosting, DNS, TLS, and proxy'));
  assert.ok(s.nextActions.some((a) => /resolve each listed value/.test(a)));
});

test('reports whether launch evidence is bound to a concrete release identity', () => {
  const templateEvidence = renderProductionLaunchEvidenceTemplate();
  const placeholderState = assessLaunchState({
    envExists: true,
    envContent: productionEnv(),
    evidenceFileExists: true,
    evidenceContent: templateEvidence,
  });

  assert.equal(placeholderState.evidenceLedger.releaseBinding.complete, false);
  assert.match(placeholderState.evidenceLedger.releaseBinding.headline, /not bound to a concrete release/);
  assert.ok(placeholderState.evidenceLedger.releaseBinding.missingFields.includes('release.commitSha'));
  assert.ok(placeholderState.evidenceLedger.releaseBinding.missingFields.includes('release.workflowRunUrl'));
  assert.ok(placeholderState.evidenceLedger.releaseBinding.missingFields.includes('release.imageDigestManifest.apiImage'));

  const concreteEvidence = JSON.parse(templateEvidence);
  concreteEvidence.release = {
    commitSha: 'a'.repeat(40),
    workflowRunUrl: 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/123456789',
    workflowFile: '.github/workflows/release-images.yml',
    gitRef: 'refs/heads/master',
    imageDigestManifest: {
      apiImage: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${'b'.repeat(64)}`,
      webImage: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${'c'.repeat(64)}`,
      migrationImage: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${'d'.repeat(64)}`,
      webBuildNextPublicApiUrl: 'https://api.charitypilot.ie',
      webBuildNextPublicSupabaseUrl: productionSupabaseUrl,
    },
  };

  const concreteState = assessLaunchState({
    envExists: true,
    envContent: productionEnv(),
    evidenceFileExists: true,
    evidenceContent: JSON.stringify(concreteEvidence),
  });
  const payload = JSON.parse(renderLaunchStatusJson(concreteState));

  assert.equal(concreteState.evidenceLedger.releaseBinding.complete, true);
  assert.equal(concreteState.evidenceLedger.releaseBinding.commitSha, 'a'.repeat(40));
  assert.deepEqual(concreteState.evidenceLedger.releaseBinding.missingFields, []);
  assert.equal(payload.evidenceLedger.releaseBinding.complete, true);
});

test('renders machine-readable launch status for operator dashboards', () => {
  const state = assessLaunchState({
    envExists: true,
    envContent: productionEnv({
      DATABASE_URL: 'REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
      STRIPE_SECRET_KEY: 'REPLACE_ME_STRIPE_LIVE_SECRET_KEY',
    }),
    evidenceFileExists: true,
    evidenceContent: renderProductionLaunchEvidenceTemplate(),
  });

  const payload = JSON.parse(renderLaunchStatusJson(state));

  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(payload.remainingKeys, ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
  assert.deepEqual(payload.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason })), [
    { key: 'DATABASE_URL', reason: 'placeholder' },
    { key: 'STRIPE_SECRET_KEY', reason: 'placeholder' },
  ]);
  assert.equal(payload.expectedProductionValueGroups.length, 8);
  assert.ok(payload.expectedProductionValueGroups.some((group) => group.keys.includes('EMAIL_FROM')));
  assert.ok(payload.expectedProductionValueGroups.some((group) => group.keys.includes('DATABASE_URL')));
  assert.ok(payload.expectedProductionValueGroups.some((group) => group.keys.includes('AUTH_COOKIE_DOMAIN')));
  assert.deepEqual(payload.launchProgress.productionValues, { completed: 26, total: 28, remaining: 2 });
  assert.deepEqual(payload.launchProgress.evidenceChecks, { completed: 0, total: 87, remaining: 87 });
  assert.deepEqual(payload.launchProgress.finalSignoffs, { approved: 0, total: 5, remaining: 5 });
  assert.deepEqual(payload.launchProgress.strictLaunchGates, { completed: 26, total: 120, remaining: 94 });
  assert.deepEqual(payload.launchProgress.percentages, {
    productionValues: 92.9,
    evidenceChecks: 0,
    finalSignoffs: 0,
    strictLaunchGates: 21.7,
  });
  assert.equal(payload.launchProgress.approvedForLaunch, false);
  assert.equal(payload.evidenceLedger.completedChecks, 0);
  assert.equal(payload.evidenceLedger.totalChecks, 87);
  assert.equal(payload.evidenceLedger.approvedForLaunch, false);
  assert.equal(payload.evidenceLedger.evidenceStatusesComplete, false);
  assert.equal(payload.evidenceLedger.approvedFinalSignoffRoles, 0);
  assert.equal(payload.evidenceLedger.totalFinalSignoffRoles, 5);
  assert.equal(payload.evidenceLedger.nextIncompleteCheckDetails[0].path, 'releaseGate.npm-ci');
  assert.equal(payload.evidenceLedger.nextIncompleteCheckDetails[0].status, 'pending');
  assert.deepEqual(payload.evidenceLedger.nextIncompleteCheckDetails[0].requiredEvidenceHints, ['npm ci', 'exit 0']);
  assert.equal(payload.evidenceLedger.workQueueByArea[0].id, 'releaseGate');
  assert.equal(payload.evidenceLedger.workQueueByArea[0].remaining, 20);
  assert.equal(payload.evidenceLedger.workQueueByArea.find((area) => area.id === 'browserQa').remaining, 7);
  assert.equal(
    payload.evidenceLedger.workQueueByArea.reduce((total, area) => total + area.remaining, 0),
    87,
  );
  assert.match(payload.evidenceLedger.statusCommand, /check:production:evidence:status/);
  assert.match(payload.evidenceLedger.jsonStatusCommand, /--json/);
  assert.match(payload.evidenceLedger.validationCommand, /check:production:evidence -- --evidence-file/);
  assert.match(payload.evidenceLedger.jsonValidationCommand, /check:production:evidence -- --json --evidence-file/);
  assertProductionLaunchCommands(payload.productionLaunchCommands);
  assertFinalLaunchEvidenceWorkflow(payload.finalLaunchEvidenceWorkflow);
  assertReleaseImagePromotion(payload.releaseImagePromotion);
  assertDeployedBrowserQaCommands(payload.deployedBrowserQa);
  assertLocalPersonalReadiness(payload.localPersonalReadiness);
  assertFinalSignoffRequirements(payload.finalSignoffRequirements);
  assert.ok(payload.nextActions.some((action) => action.includes('check:production')));
  assert.ok(payload.externalEvidenceGates.some((gate) => gate.includes('external penetration test')));
  assert.equal(payload.remainingKeyGroups[0].label, 'PostgreSQL');
  assert.equal(payload.remainingKeyGroups[1].label, 'Stripe billing');
});

test('launch status exposes repository state so release evidence is tied to a clean pushed ref', () => {
  const repositoryState = {
    branch: 'master',
    headSha: 'd'.repeat(40),
    upstreamRef: 'origin/master',
    upstreamSha: 'c'.repeat(40),
    dirty: true,
    syncedWithUpstream: false,
    launchEvidenceRisk: 'dirty_worktree',
    headline: 'Repository has uncommitted changes; do not collect launch evidence from this worktree.',
  };
  const state = assessLaunchState({
    envExists: true,
    envContent: productionEnv(),
    evidenceFileExists: true,
    evidenceContent: renderProductionLaunchEvidenceTemplate(),
    repositoryState,
  });

  const payload = JSON.parse(renderLaunchStatusJson(state));
  const text = renderLaunchStatusText(state);

  assert.deepEqual(payload.repositoryState, repositoryState);
  assert.match(text, /Repository state:/);
  assert.match(text, /Local personal data safety:/);
  assert.match(text, /npm run personal:ready/);
  assert.match(text, /Do not run the default full E2E suite/);
  assert.match(text, /GitHub production environment JSON:  npm run check:production:github-env -- --environment=production --json/);
  assert.match(
    text,
    /GitHub production secret-store JSON:  npm run check:production:github-secrets -- --environment=production --json/,
  );
  assert.match(
    text,
    /Release-run evidence JSON:  npm run check:production:release-run -- --json --evidence-file=.charitypilot-launch-evidence\/production-launch-evidence.json/,
  );
  assert.match(
    text,
    /Final evidence validation JSON:  npm run check:production:evidence -- --json --evidence-file=.charitypilot-launch-evidence\/production-launch-evidence.json/,
  );
  assert.match(text, /Validation artifact files:/);
  assert.match(text, /production-release-run-evidence\.json/);
  assert.match(text, /production-launch-evidence-validation\.json/);
  assert.match(text, /Upload workflow file:  \.github\/workflows\/upload-production-launch-evidence\.yml/);
  assert.match(text, /Prepare\/upload:  npm run prepare:production:evidence-upload -- --json \| gh workflow run upload-production-launch-evidence\.yml --ref master --json/);
  assert.match(text, /Upload evidence target:  Use the successful upload-production-launch-evidence\.yml run id as evidence_artifact_run_id/);
  assert.match(text, /Preflight GitHub environment JSON:  npm run check:production:github-env -- --environment=production --json/);
  assert.match(text, /branch: master/);
  assert.match(text, /head: dddddddddddddddddddddddddddddddddddddddd/);
  assert.match(text, /upstream: origin\/master/);
  assert.match(text, /dirty_worktree/);
  assert.match(text, /do not collect launch evidence/);
});

test('repository state collector classifies dirty and unpushed launch evidence risk', () => {
  const outputs = new Map([
    ['branch --show-current', { status: 0, stdout: 'master\n' }],
    ['rev-parse HEAD', { status: 0, stdout: `${'e'.repeat(40)}\n` }],
    ['rev-parse --abbrev-ref --symbolic-full-name @{upstream}', { status: 0, stdout: 'origin/master\n' }],
    ['rev-parse @{upstream}', { status: 0, stdout: `${'f'.repeat(40)}\n` }],
    ['status --porcelain', { status: 0, stdout: ' M scripts/launch-status.mjs\n' }],
  ]);

  const state = collectRepositoryState({
    runGit: (args) => outputs.get(args.join(' ')) ?? { status: 1, stdout: '', stderr: 'missing fixture' },
  });

  assert.deepEqual(state, {
    branch: 'master',
    headSha: 'e'.repeat(40),
    upstreamRef: 'origin/master',
    upstreamSha: 'f'.repeat(40),
    dirty: true,
    syncedWithUpstream: false,
    launchEvidenceRisk: 'dirty_worktree',
    headline: 'Repository has uncommitted changes; do not collect launch evidence from this worktree.',
  });
});

test('reports ENV_INCOMPLETE for CRLF production env files', () => {
  const env = productionEnv({
    DATABASE_URL: 'REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
  }).split('\n').join('\r\n');
  const s = assessLaunchState({ envExists: true, envContent: env });
  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, ['DATABASE_URL']);
});

test('reports ENV_COMPLETE and surfaces the remaining non-code gates', () => {
  const env = productionEnv();
  const s = assessLaunchState({ envExists: true, envContent: env });
  assert.equal(s.phase, 'ENV_COMPLETE');
  assert.match(s.headline, /no unresolved production value issues/);
  assert.equal(s.remainingKeys.length, 0);
  assert.deepEqual(s.expectedProductionValueGroups, []);
  assert.deepEqual(s.launchProgress.productionValues, { completed: 28, total: 28, remaining: 0 });
  assert.ok(s.nextActions.some((a) => a.includes('check:production')));
  assert.ok(s.nextActions.some((a) => a.includes('check:production:evidence:status')));
  assert.ok(s.nextActions.some((a) => a.includes('--json')));
  assertExternalLaunchEvidenceGates(s);
  assert.ok(
    s.nextActions.some((a) => /penetration test|sign-off|checklist/i.test(a)),
    'must remind the operator that external gates remain',
  );
});
