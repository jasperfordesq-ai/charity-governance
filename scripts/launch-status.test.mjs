import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assessLaunchState, groupRemainingKeys, renderLaunchStatusJson } from './launch-status.mjs';
import { renderProductionLaunchEvidenceTemplate } from './generate-production-launch-evidence-template.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertExternalLaunchEvidenceGates(state) {
  assert.ok(
    Array.isArray(state.externalEvidenceGates),
    'launch status must expose the external evidence gates separately from env placeholders',
  );
  const gates = state.externalEvidenceGates.join('\n');
  assert.match(gates, /production-launch-evidence\.json/);
  assert.match(gates, /85 machine-readable checks/);
  assert.match(gates, /browserQa\.checks\.accessibility-coverage/);
  assert.match(gates, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(gates, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(gates, /E2E_DEPLOYED_QA=true/);
  assert.match(gates, /all four focused route chunks/);
  assert.match(gates, /npm run test:e2e:responsive/);
  assert.match(gates, /Launch-Critical Route Inventory/);
  assert.match(gates, /every route in desktop, mobile, light-mode, and dark-mode evidence/);
  assert.match(gates, /every browser QA evidence slot must bind to the exact promoted release\.commitSha/);
  assert.match(gates, /browserQa\.checks\.browser-qa-completed/);
  assert.match(gates, /browserQa\.checks\.desktop-coverage/);
  assert.match(gates, /browserQa\.checks\.mobile-coverage/);
  assert.match(gates, /browserQa\.checks\.critical-flows/);
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

function assertProductionLaunchCommands(commands) {
  assert.equal(commands.corePreflight, 'npm run check:production -- --production-env-file=.env.production');
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
    commands.finalEvidenceValidation,
    'npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
  );
}

function assertFinalLaunchEvidenceWorkflow(workflow) {
  assert.equal(workflow.workflowFile, '.github/workflows/production-launch-evidence.yml');
  assert.equal(workflow.githubEnvironment, 'production');
  assert.equal(workflow.requiredInput, 'evidence_artifact_run_id');
  assert.equal(workflow.defaultArtifactName, 'production-launch-evidence');
  assert.equal(workflow.defaultEvidenceFileName, 'production-launch-evidence.json');
  assert.equal(workflow.validationArtifactName, 'production-launch-evidence-validation');
  assert.equal(
    workflow.runCommand,
    'gh workflow run production-launch-evidence.yml --ref master -f evidence_artifact_run_id=EVIDENCE_ARTIFACT_RUN_ID -f evidence_artifact_name=production-launch-evidence -f evidence_file_name=production-launch-evidence.json',
  );
  assert.match(workflow.evidenceTarget, /protected workflow run URL/);
  assert.match(workflow.evidenceTarget, /production-launch-evidence-validation/);
}

function assertReleaseImagePromotion(promotion) {
  assert.equal(promotion.githubEnvironment, 'production');
  assert.deepEqual(promotion.requiredGitHubEnvironmentVariables, [
    'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
    'NEXT_PUBLIC_SUPABASE_URL=https://YOUR_SUPABASE_PROJECT_REF.supabase.co',
  ]);
  assert.deepEqual(promotion.configureCommands, [
    'gh variable set NEXT_PUBLIC_API_URL --env production --body https://api.charitypilot.ie',
    'gh variable set NEXT_PUBLIC_SUPABASE_URL --env production --body "https://YOUR_SUPABASE_PROJECT_REF.supabase.co"',
  ]);
  assert.equal(promotion.workflowCommand, 'gh workflow run release-images.yml --ref master');
  assert.equal(promotion.watchCommand, 'gh run watch RELEASE_RUN_ID --exit-status');
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
  assert.deepEqual(payload.launchProgress.strictLaunchGates, { completed: 0, total: 118, remaining: 118 });
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
  assertFinalSignoffRequirements(payload.finalSignoffRequirements);
  assertExternalLaunchEvidenceGates(s);
});

test('reports ENV_INCOMPLETE and lists the unfilled keys', () => {
  const env = [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
    'STRIPE_SECRET_KEY=REPLACE_ME_STRIPE_LIVE_SECRET_KEY',
    'EMAIL_FROM=noreply@charitypilot.ie',
  ].join('\n');
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
  assert.equal(s.evidenceLedger.exists, true);
  assert.deepEqual(s.launchProgress.productionValues, { completed: 26, total: 28, remaining: 2 });
  assert.match(s.evidenceLedger.nextAction, /check:production:evidence:status/);
  assert.match(s.evidenceLedger.validationCommand, /check:production:evidence -- --evidence-file/);
  assert.match(s.evidenceLedger.jsonValidationCommand, /check:production:evidence -- --json --evidence-file/);
  assert.ok(s.nextActions.some((a) => /replace placeholders, fill real provider values, or correct drifted TLS\/cookie settings/.test(a)));
  assert.ok(s.nextActions.some((a) => a.includes('check:production')));
  assertExternalLaunchEvidenceGates(s);
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
  const env = [
    'NODE_ENV=production',
    'AUTH_COOKIE_DOMAIN=',
    'CADDY_ACME_EMAIL=ops@charitypilot.ie',
    'CHARITYPILOT_WEB_DOMAIN=charitypilot.ie',
    'CHARITYPILOT_API_DOMAIN=api.charitypilot.ie',
  ].join('\n');

  const s = assessLaunchState({ envExists: true, envContent: env });

  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, ['AUTH_COOKIE_DOMAIN', 'CHARITYPILOT_WEB_DOMAIN']);
  assert.deepEqual(
    s.remainingKeyDetails.map((issue) => ({ key: issue.key, reason: issue.reason, expected: issue.expected })),
    [
      { key: 'AUTH_COOKIE_DOMAIN', reason: 'canonical-drift', expected: '.charitypilot.ie' },
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

test('keeps placeholder issue reasons ahead of canonical drift checks', () => {
  const env = [
    'NODE_ENV=production',
    'AUTH_COOKIE_DOMAIN=REPLACE_ME_SHARED_COOKIE_DOMAIN',
    'CADDY_ACME_EMAIL=REPLACE_ME_ACME_EMAIL',
    'CHARITYPILOT_WEB_DOMAIN=charitypilot.ie',
  ].join('\n');

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
  const env = [
    'NODE_ENV=production',
    'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
  ].join('\n');
  const s = assessLaunchState({
    envExists: true,
    envContent: env,
    evidenceFileExists: true,
    evidenceContent: JSON.stringify({ approvedForLaunch: false, finalSignoff: { status: 'pending' }, areas: {} }),
  });

  assert.equal(s.evidenceLedger.exists, true);
  assert.equal(s.evidenceLedger.completedChecks, 0);
  assert.equal(s.evidenceLedger.totalChecks, 85);
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
  assert.match(s.evidenceLedger.headline, /Checklist checks complete: 0 \/ 85/);
  assert.match(s.evidenceLedger.validationCommand, /check:production:evidence -- --evidence-file/);
  assert.match(s.evidenceLedger.jsonValidationCommand, /check:production:evidence -- --json --evidence-file/);
});

test('reports whether launch evidence is bound to a concrete release identity', () => {
  const templateEvidence = renderProductionLaunchEvidenceTemplate();
  const placeholderState = assessLaunchState({
    envExists: true,
    envContent: 'NODE_ENV=production',
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
      migrationImage: `ghcr.io/jasperfordesq-ai/charity-governance-migration@sha256:${'d'.repeat(64)}`,
      webBuildNextPublicApiUrl: 'https://api.charitypilot.ie',
      webBuildNextPublicSupabaseUrl: 'https://configured-project.supabase.co',
    },
  };

  const concreteState = assessLaunchState({
    envExists: true,
    envContent: 'NODE_ENV=production',
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
    envContent: [
      'NODE_ENV=production',
      'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
      'STRIPE_SECRET_KEY=REPLACE_ME_STRIPE_LIVE_SECRET_KEY',
    ].join('\n'),
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
  assert.deepEqual(payload.launchProgress.evidenceChecks, { completed: 0, total: 85, remaining: 85 });
  assert.deepEqual(payload.launchProgress.finalSignoffs, { approved: 0, total: 5, remaining: 5 });
  assert.deepEqual(payload.launchProgress.strictLaunchGates, { completed: 26, total: 118, remaining: 92 });
  assert.deepEqual(payload.launchProgress.percentages, {
    productionValues: 92.9,
    evidenceChecks: 0,
    finalSignoffs: 0,
    strictLaunchGates: 22,
  });
  assert.equal(payload.launchProgress.approvedForLaunch, false);
  assert.equal(payload.evidenceLedger.completedChecks, 0);
  assert.equal(payload.evidenceLedger.totalChecks, 85);
  assert.equal(payload.evidenceLedger.approvedForLaunch, false);
  assert.equal(payload.evidenceLedger.evidenceStatusesComplete, false);
  assert.equal(payload.evidenceLedger.approvedFinalSignoffRoles, 0);
  assert.equal(payload.evidenceLedger.totalFinalSignoffRoles, 5);
  assert.equal(payload.evidenceLedger.nextIncompleteCheckDetails[0].path, 'releaseGate.npm-ci');
  assert.equal(payload.evidenceLedger.nextIncompleteCheckDetails[0].status, 'pending');
  assert.deepEqual(payload.evidenceLedger.nextIncompleteCheckDetails[0].requiredEvidenceHints, ['npm ci', 'exit 0']);
  assert.match(payload.evidenceLedger.statusCommand, /check:production:evidence:status/);
  assert.match(payload.evidenceLedger.jsonStatusCommand, /--json/);
  assert.match(payload.evidenceLedger.validationCommand, /check:production:evidence -- --evidence-file/);
  assert.match(payload.evidenceLedger.jsonValidationCommand, /check:production:evidence -- --json --evidence-file/);
  assertProductionLaunchCommands(payload.productionLaunchCommands);
  assertFinalLaunchEvidenceWorkflow(payload.finalLaunchEvidenceWorkflow);
  assertReleaseImagePromotion(payload.releaseImagePromotion);
  assertDeployedBrowserQaCommands(payload.deployedBrowserQa);
  assertFinalSignoffRequirements(payload.finalSignoffRequirements);
  assert.ok(payload.nextActions.some((action) => action.includes('check:production')));
  assert.ok(payload.externalEvidenceGates.some((gate) => gate.includes('external penetration test')));
  assert.equal(payload.remainingKeyGroups[0].label, 'PostgreSQL');
  assert.equal(payload.remainingKeyGroups[1].label, 'Stripe billing');
});

test('reports ENV_INCOMPLETE for CRLF production env files', () => {
  const env = [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
    'READINESS_API_KEY=already-generated-readiness-key-1234567890',
  ].join('\r\n');
  const s = assessLaunchState({ envExists: true, envContent: env });
  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, ['DATABASE_URL']);
});

test('reports ENV_COMPLETE and surfaces the remaining non-code gates', () => {
  const env = [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'DATABASE_URL=postgresql://u:p@db.example.com:5432/cp?sslmode=require',
  ].join('\n');
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
