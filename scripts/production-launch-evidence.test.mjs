import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const evidenceScriptPath = join(scriptsDir, 'production-launch-evidence.mjs');
const evidenceTemplateScriptPath = join(scriptsDir, 'generate-production-launch-evidence-template.mjs');
const capturedAt = '2026-06-08T12:00:00.000Z';
const digest = 'a'.repeat(64);
const commitSha = 'b'.repeat(40);
const releaseWorkflowRunUrl = 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/123456789';
const releaseWorkflowFile = '.github/workflows/release-images.yml';
const releaseGitRef = 'refs/heads/master';
const apiImage = `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`;
const webImage = `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`;
const migrationImage = `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`;

async function loadEvidenceRunner() {
  assert.ok(existsSync(evidenceScriptPath), 'production launch evidence script must exist');
  const module = await import(pathToFileURL(evidenceScriptPath).href);
  assert.equal(typeof module.runProductionLaunchEvidenceFromArgs, 'function');
  assert.ok(Array.isArray(module.REQUIRED_LAUNCH_AREAS));
  return module;
}

async function loadEvidenceTemplateGenerator() {
  assert.ok(existsSync(evidenceTemplateScriptPath), 'production launch evidence template script must exist');
  const module = await import(pathToFileURL(evidenceTemplateScriptPath).href);
  assert.equal(typeof module.renderProductionLaunchEvidenceTemplate, 'function');
  return module;
}

function evidenceEntry(areaId, checkId) {
  const entry = {
    type: 'artifact',
    reference: `https://evidence.charitypilot.ie/launch/${areaId}/${checkId}`,
    description: `${areaId} ${checkId} evidence`,
    capturedAt,
  };

  if (areaId === 'database' && checkId === 'database-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel',
      'Production database check passed: production PostgreSQL backup completed and restore verification succeeded with operational sentinel checks.',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'check-production') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production -- --production-env-file=.env.production',
      'Production preflight passed using .env.production',
    ].join(' ');
  }

  if (areaId === 'hostingDnsTls' && checkId === 'hosting-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:hosting -- --production-env-file=.env.production',
      'Production hosting check passed: 2 HTTPS origin(s) resolved publicly, served authorized TLS, responded over HTTPS, and included baseline security headers.',
    ].join(' ');
  }

  if (areaId === 'supabaseStorage' && checkId === 'supabase-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:supabase -- --production-env-file=.env.production',
      'Production Supabase storage check passed: private bucket, service-role probe upload, signed URL creation, anonymous access denial, and probe cleanup verified.',
    ].join(' ');
  }

  if (areaId === 'billingAndEmail' && checkId === 'providers-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:providers -- --production-env-file=.env.production',
      'Production provider check passed: active live recurring Stripe prices, enabled live billing webhook endpoint with required subscription events, and verified Resend sender domain confirmed.',
      'required subscription events:',
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ].join(' ');
  }

  if (areaId === 'billingAndEmail' && checkId === 'stripe-webhook-endpoint') {
    entry.description = [
      'Stripe live webhook endpoint verified for https://api.charitypilot.ie/api/v1/billing/webhooks.',
      'Subscribed events:',
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ].join(' ');
  }

  if (areaId === 'billingAndEmail' && checkId === 'stripe-webhook-secret') {
    entry.description = [
      'Stripe signing secret was compared with STRIPE_WEBHOOK_SECRET in the production secret store.',
      'Evidence records the secret-store path and approver without exposing the raw value.',
    ].join(' ');
  }

  if (areaId === 'billingAndEmail' && checkId === 'resend-send') {
    entry.description = [
      'Resend test send completed from EMAIL_FROM using the production sender domain.',
      'Operator recorded the accepted message id and delivery log reference without raw API keys.',
    ].join(' ');
  }

  if (areaId === 'billingAndEmail' && checkId === 'email-links-production-origin') {
    entry.description = [
      'password reset and email verification messages were requested in production.',
      'Both email links used https://app.charitypilot.ie as the frontend origin.',
    ].join(' ');
  }

  if (areaId === 'observability' && checkId === 'observability-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:observability -- --production-env-file=.env.production',
      'Production observability check passed: sent sanitized test alert to redacted webhook.',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'release-workflow-identity') {
    entry.type = 'command-output';
    entry.reference = releaseWorkflowRunUrl;
    entry.description = [
      'gh run view evidence:',
      `path ${releaseWorkflowFile}`,
      `headSha ${commitSha}`,
      `headRef ${releaseGitRef}`,
      'conclusion success',
      'artifact release-image-digests',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'release-run-api-verification') {
    entry.type = 'command-output';
    entry.reference = releaseWorkflowRunUrl;
    entry.description = [
      'npm run check:production:release-run -- --evidence-file=production-launch-evidence.json',
      'Production release run evidence passed',
      releaseWorkflowRunUrl,
      'release-image-digests',
      `apiImage=${apiImage}`,
      `webImage=${webImage}`,
      `migrationImage=${migrationImage}`,
      'webBuildNextPublicApiUrl=https://api.charitypilot.ie',
      'webBuildNextPublicSupabaseUrl=https://configured-project.supabase.co',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'deploy-preflight') {
    entry.type = 'command-output';
    entry.description = [
      'Production deploy preflight passed: env, compose config, and image signatures verified.',
      apiImage,
      webImage,
      migrationImage,
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'deploy-production') {
    entry.type = 'command-output';
    entry.description = [
      'npm run deploy:production -- --production-env-file=.env.production',
      'Production deploy preflight passed: env, compose config, and image signatures verified.',
      'Production deploy smoke passed: public web, API health, CORS, and keyed readiness verified.',
      'Production compose deploy completed.',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'deploy-smoke') {
    entry.type = 'command-output';
    entry.description = [
      'npm run deploy:production -- --production-env-file=.env.production',
      'node scripts/smoke-production-deploy.mjs --production-env-file .env.production',
      'Production deploy smoke passed: public web, API health, CORS, and keyed readiness verified.',
      'Web origin: https://app.charitypilot.ie',
      'API origin: https://api.charitypilot.ie',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'deploy-rollback') {
    entry.type = 'command-output';
    entry.description = [
      'npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env',
      'Production compose rollback completed.',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'cosign') {
    entry.type = 'command-output';
    entry.description = [
      'cosign verify',
      '--certificate-identity-regexp ^https://github.com/jasperfordesq-ai/charity-governance/\\.github/workflows/release-images\\.yml@refs/(heads/master|tags/v.*)$',
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
      apiImage,
      webImage,
      migrationImage,
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'digest-manifest') {
    entry.reference = `${releaseWorkflowRunUrl}/artifacts/release-image-digests`;
    entry.description = [
      'release-image-digests artifact from release workflow',
      apiImage,
      webImage,
      migrationImage,
      'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
      'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL=https://configured-project.supabase.co',
    ].join(' ');
  }

  if (areaId === 'jobs' && checkId === 'scheduler-command') {
    entry.type = 'command-output';
    entry.description = [
      'Production Compose job commands verified:',
      'node dist/jobs/production-scheduler.js',
      'node dist/jobs/send-deadline-reminders.js',
      'node dist/jobs/cleanup-document-storage.js',
    ].join(' ');
  }

  if (areaId === 'jobs' && checkId === 'scheduler-logs-alerts') {
    entry.type = 'command-output';
    entry.description = [
      'Production scheduler logs captured.',
      'deadline-reminders failure alert evidence recorded.',
      'document-storage-cleanup failure alert evidence recorded.',
    ].join(' ');
  }

  if (areaId === 'browserQa' && checkId === 'browser-qa-completed') {
    entry.type = 'command-output';
    entry.description = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD supplied from the secret store',
      'npm run test:e2e:responsive',
      'responsive-smoke.spec.ts passed against deployed HTTPS production URL',
    ].join(' ');
  }

  if (areaId === 'browserQa' && checkId === 'critical-flows-covered') {
    entry.type = 'command-output';
    entry.description = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD supplied from the secret store',
      'npm run test:e2e -- tests/accessibility.spec.ts',
      'accessibility.spec.ts passed against deployed HTTPS production URL in light and dark themes',
    ].join(' ');
  }

  return entry;
}

function completeEvidence(requiredAreas) {
  return {
    version: 1,
    preparedBy: 'Release owner',
    preparedAt: capturedAt,
    approvedForLaunch: true,
    release: {
      commitSha,
      workflowRunUrl: releaseWorkflowRunUrl,
      workflowFile: releaseWorkflowFile,
      gitRef: releaseGitRef,
      imageDigestManifest: {
        apiImage,
        webImage,
        migrationImage,
        webBuildNextPublicApiUrl: 'https://api.charitypilot.ie',
        webBuildNextPublicSupabaseUrl: 'https://configured-project.supabase.co',
      },
    },
    areas: Object.fromEntries(requiredAreas.map((area) => [
      area.id,
      {
        owner: `${area.label} owner`,
        status: 'complete',
        checks: Object.fromEntries(area.checks.map((check) => [
          check.id,
          {
            status: 'complete',
            evidence: [evidenceEntry(area.id, check.id)],
          },
        ])),
      },
    ])),
    finalSignoff: {
      status: 'approved',
      owner: 'Accountable owner',
      approvedAt: capturedAt,
      approvals: {
        engineering: {
          status: 'approved',
          owner: 'Engineering owner',
          approvedAt: capturedAt,
          evidence: [
            {
              type: 'approval',
              reference: 'https://evidence.charitypilot.ie/launch/final-signoff/engineering',
              description: 'Engineering owner launch approval',
              capturedAt,
            },
          ],
        },
        operations: {
          status: 'approved',
          owner: 'Operations owner',
          approvedAt: capturedAt,
          evidence: [
            {
              type: 'approval',
              reference: 'https://evidence.charitypilot.ie/launch/final-signoff/operations',
              description: 'Operations owner launch approval',
              capturedAt,
            },
          ],
        },
        security: {
          status: 'approved',
          owner: 'Security owner',
          approvedAt: capturedAt,
          evidence: [
            {
              type: 'approval',
              reference: 'https://evidence.charitypilot.ie/launch/final-signoff/security',
              description: 'Security owner launch approval',
              capturedAt,
            },
          ],
        },
        legalCompliance: {
          status: 'approved',
          owner: 'Legal/compliance owner',
          approvedAt: capturedAt,
          evidence: [
            {
              type: 'approval',
              reference: 'https://evidence.charitypilot.ie/launch/final-signoff/legal-compliance',
              description: 'Legal/compliance owner launch approval',
              capturedAt,
            },
          ],
        },
        business: {
          status: 'approved',
          owner: 'Business owner',
          approvedAt: capturedAt,
          evidence: [
            {
              type: 'approval',
              reference: 'https://evidence.charitypilot.ie/launch/final-signoff/business',
              description: 'Business owner launch approval',
              capturedAt,
            },
          ],
        },
      },
      evidence: [
        {
          type: 'approval',
          reference: 'https://evidence.charitypilot.ie/launch/final-signoff/approval',
          description: 'Accountable owner launch approval',
          capturedAt,
        },
      ],
    },
  };
}

function writeEvidenceFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-launch-evidence-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(content, null, 2));
  return { tempDir, evidencePath };
}

test('production launch evidence validator accepts complete dated external evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const { tempDir, evidencePath } = writeEvidenceFile(completeEvidence(REQUIRED_LAUNCH_AREAS));

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production launch evidence passed/);
    assert.match(result.stdout, /11 area\(s\)/);
    assert.match(result.stdout, /80 check\(s\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires a bound release artifact identity', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.release.commitSha = 'not-a-sha';
  evidence.release.workflowRunUrl = 'https://github.com/jasperfordesq-ai/charity-governance/actions';
  evidence.release.workflowFile = '.github/workflows/ci.yml';
  evidence.release.gitRef = 'refs/heads/feature-preview';
  evidence.release.imageDigestManifest.webImage = 'ghcr.io/jasperfordesq-ai/charity-governance-web:latest';
  evidence.release.imageDigestManifest.webBuildNextPublicApiUrl = 'https://api.attacker.example';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release\.commitSha must be a 40 character lowercase git SHA/);
    assert.match(result.stderr, /release\.workflowRunUrl must be a GitHub Actions release workflow run URL/);
    assert.match(result.stderr, /release\.workflowFile must be \.github\/workflows\/release-images\.yml/);
    assert.match(result.stderr, /release\.gitRef must be refs\/heads\/master or refs\/tags\/v/);
    assert.match(result.stderr, /release\.imageDigestManifest\.webImage must use ghcr\.io\/jasperfordesq-ai\/charity-governance-web@sha256/);
    assert.match(result.stderr, /release\.imageDigestManifest\.webBuildNextPublicApiUrl must use an approved charitypilot\.ie hostname/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator fails when release binding is missing', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.release;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release is required/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires all executable production checker evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const requiredCommandChecks = {
    hostingDnsTls: 'hosting-check',
    database: 'database-check',
    supabaseStorage: 'supabase-check',
    billingAndEmail: 'providers-check',
    observability: 'observability-check',
  };

  for (const [areaId, checkId] of Object.entries(requiredCommandChecks)) {
    assert.ok(
      REQUIRED_LAUNCH_AREAS.find((area) => area.id === areaId)?.checks.some((check) => check.id === checkId),
      `${areaId}.${checkId} must be part of REQUIRED_LAUNCH_AREAS`,
    );
    delete evidence.areas[areaId].checks[checkId];
  }

  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /hostingDnsTls\.checks\.hosting-check is required/);
    assert.match(result.stderr, /database\.checks\.database-check is required/);
    assert.match(result.stderr, /supabaseStorage\.checks\.supabase-check is required/);
    assert.match(result.stderr, /billingAndEmail\.checks\.providers-check is required/);
    assert.match(result.stderr, /observability\.checks\.observability-check is required/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires operational sentinel database check evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.database.checks['database-check'].evidence = [
    {
      type: 'artifact',
      reference: 'https://evidence.charitypilot.ie/launch/database/database-check',
      description: 'npm run check:production:database -- --production-env-file=.env.production completed',
      capturedAt,
    },
  ];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.database\.checks\.database-check\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.database\.checks\.database-check\.evidence must show check:production:database was run with --expect-operational-sentinel/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires executable checker command transcripts', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/generic/checker',
    description: 'Checker was reviewed in release evidence',
    capturedAt,
  };
  evidence.areas.releaseGate.checks['check-production'].evidence = [genericEvidence];
  evidence.areas.hostingDnsTls.checks['hosting-check'].evidence = [genericEvidence];
  evidence.areas.supabaseStorage.checks['supabase-check'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['providers-check'].evidence = [genericEvidence];
  evidence.areas.observability.checks['observability-check'].evidence = [genericEvidence];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.check-production\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.check-production\.evidence must include the check:production command/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.hosting-check\.evidence must include Production hosting check passed/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-check\.evidence must include the check:production:supabase command/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include Production provider check passed/);
    assert.match(result.stderr, /areas\.observability\.checks\.observability-check\.evidence must include the check:production:observability command/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires concrete billing and email production evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/billing/generic',
    description: 'Billing and email provider setup was reviewed',
    capturedAt,
  };
  evidence.areas.billingAndEmail.checks['providers-check'].evidence = [{
    ...genericEvidence,
    type: 'command-output',
    description: 'npm run check:production:providers -- --production-env-file=.env.production Production provider check passed',
  }];
  evidence.areas.billingAndEmail.checks['stripe-webhook-endpoint'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['stripe-webhook-secret'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['resend-send'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['email-links-production-origin'].evidence = [genericEvidence];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include required subscription events/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include checkout\.session\.completed/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-webhook-endpoint\.evidence must include https:\/\/api\.charitypilot\.ie\/api\/v1\/billing\/webhooks/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-webhook-secret\.evidence must include STRIPE_WEBHOOK_SECRET/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-webhook-secret\.evidence must include Stripe signing secret/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.resend-send\.evidence must include Resend test send/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.resend-send\.evidence must include accepted message id/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.email-links-production-origin\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.email-links-production-origin\.evidence must include password reset/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.email-links-production-origin\.evidence must include email verification/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires deployed browser QA command transcripts', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericBrowserEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/browser/generic',
    description: 'Browser QA checklist reviewed without deployed Playwright command output',
    capturedAt,
  };
  evidence.areas.browserQa.checks['browser-qa-completed'].evidence = [genericBrowserEvidence];
  evidence.areas.browserQa.checks['critical-flows-covered'].evidence = [genericBrowserEvidence];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include E2E_DEPLOYED_QA=true/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include E2E_WEB_URL=https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include E2E_API_URL=https:\/\/api\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include E2E_OWNER_EMAIL/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include E2E_OWNER_PASSWORD/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include npm run test:e2e:responsive/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include npm run test:e2e -- tests\/accessibility\.spec\.ts/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires every production job command surface', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.jobs.checks['scheduler-command'].evidence[0].description =
    'Production scheduler evidence only mentioned node dist/jobs/send-deadline-reminders.js';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-command\.evidence must include dist\/jobs\/production-scheduler\.js/);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-command\.evidence must include dist\/jobs\/cleanup-document-storage\.js/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires both production job failure alerts', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.jobs.checks['scheduler-logs-alerts'].evidence[0].description =
    'Production scheduler logs captured without named failure alert evidence';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-logs-alerts\.evidence must include deadline-reminders failure alert evidence/);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-logs-alerts\.evidence must include document-storage-cleanup failure alert evidence/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator binds release-gate evidence to the exact workflow and promoted digests', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.releaseGate.checks['release-workflow-identity'].evidence[0].reference =
    'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/999999999';
  evidence.areas.releaseGate.checks['release-workflow-identity'].evidence[0].description =
    'GitHub Actions run completed successfully';
  evidence.areas.releaseGate.checks['deploy-preflight'].evidence[0].description =
    'Production deploy preflight passed for promoted images';
  evidence.areas.releaseGate.checks.cosign.evidence[0].description =
    'cosign signature verification completed';
  evidence.areas.releaseGate.checks['digest-manifest'].evidence[0].description =
    'release-image-digests artifact downloaded';
  evidence.areas.releaseGate.checks['release-run-api-verification'].evidence[0].description =
    'GitHub release run was checked';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.release-workflow-identity\.evidence must reference release\.workflowRunUrl/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.release-workflow-identity\.evidence must include release\.workflowFile/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.release-workflow-identity\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.release-workflow-identity\.evidence must include successful workflow conclusion/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-preflight\.evidence must include ghcr\.io\/jasperfordesq-ai\/charity-governance-api@sha256/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.cosign\.evidence must include release-images/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.digest-manifest\.evidence must include ghcr\.io\/jasperfordesq-ai\/charity-governance-web@sha256/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.release-run-api-verification\.evidence must include the check:production:release-run command/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.release-run-api-verification\.evidence must include ghcr\.io\/jasperfordesq-ai\/charity-governance-api@sha256/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.release-run-api-verification\.evidence must include release\.imageDigestManifest\.webBuildNextPublicApiUrl/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires post-deploy smoke command output', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.releaseGate.checks['deploy-smoke'].evidence[0].type = 'artifact';
  evidence.areas.releaseGate.checks['deploy-smoke'].evidence[0].description =
    'Post-deploy smoke was reviewed in the release notes';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-smoke\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-smoke\.evidence must include the production deploy smoke command/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-smoke\.evidence must include Production deploy smoke passed/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-smoke\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-smoke\.evidence must include https:\/\/api\.charitypilot\.ie/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires production deploy and rollback command output', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.releaseGate.checks['deploy-production'].evidence[0].type = 'artifact';
  evidence.areas.releaseGate.checks['deploy-production'].evidence[0].description =
    'Production deployment was noted in the release log';
  evidence.areas.releaseGate.checks['deploy-rollback'].evidence[0].type = 'artifact';
  evidence.areas.releaseGate.checks['deploy-rollback'].evidence[0].description =
    'Rollback rehearsal was noted in the release log';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include the production deploy command/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include Production compose deploy completed/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include the production rollback command/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include Production compose rollback completed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator fails closed when evidence file is missing', async () => {
  const { runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();

  const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', join(tmpdir(), 'missing-launch-evidence.json')]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production launch evidence failed/);
  assert.match(result.stderr, /evidence file not found/);
});

test('production launch evidence validator requires every checklist check to be complete', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.areas.releaseGate.checks['deploy-production'];
  evidence.finalSignoff.status = 'pending';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /releaseGate\.checks\.deploy-production is required/);
    assert.match(result.stderr, /finalSignoff\.status must be approved/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires every final signoff role approval', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.finalSignoff.approvals.security;
  evidence.finalSignoff.approvals.operations.status = 'pending';
  evidence.finalSignoff.approvals.business.approvedAt = '2026-06-07T12:00:00.000Z';
  evidence.finalSignoff.approvals.engineering.evidence = [];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /finalSignoff\.approvals\.security is required/);
    assert.match(result.stderr, /finalSignoff\.approvals\.operations\.status must be approved/);
    assert.match(result.stderr, /finalSignoff\.approvals\.business\.approvedAt must not be before preparedAt/);
    assert.match(result.stderr, /finalSignoff\.approvals\.engineering\.evidence must include at least one evidence entry/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires solicitor governance and privacy review evidence', async () => {
  const { REQUIRED_LAUNCH_AREAS, runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();
  const legalArea = REQUIRED_LAUNCH_AREAS.find((area) => area.id === 'legalAndCompliance');
  assert.ok(
    legalArea?.checks.some((check) => check.id === 'solicitor-governance-privacy-review'),
    'legalAndCompliance must include the solicitor/governance/privacy review check',
  );

  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.areas.legalAndCompliance.checks['solicitor-governance-privacy-review'];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /legalAndCompliance\.checks\.solicitor-governance-privacy-review is required/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence final signoff requires legal and compliance approval', async () => {
  const { FINAL_SIGNOFF_ROLES, REQUIRED_LAUNCH_AREAS, runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();
  assert.ok(
    FINAL_SIGNOFF_ROLES.some((role) => role.id === 'legalCompliance' && /Legal\/compliance owner/.test(role.label)),
    'final launch signoff must include the legal/compliance owner role',
  );

  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.finalSignoff.approvals.legalCompliance;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /finalSignoff\.approvals\.legalCompliance is required/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence template covers every required area and final signoff role but cannot launch', async () => {
  const {
    FINAL_SIGNOFF_ROLES,
    REQUIRED_LAUNCH_AREAS,
    runProductionLaunchEvidenceFromArgs,
  } = await loadEvidenceRunner();
  const { renderProductionLaunchEvidenceTemplate } = await loadEvidenceTemplateGenerator();
  const template = JSON.parse(renderProductionLaunchEvidenceTemplate());
  const { tempDir, evidencePath } = writeEvidenceFile(template);

  try {
    assert.equal(template.approvedForLaunch, false);
    assert.equal(template.release.workflowFile, '.github/workflows/release-images.yml');
    assert.equal(template.release.gitRef, 'REPLACE_WITH_RELEASE_GIT_REF');
    assert.equal(template.finalSignoff.status, 'pending');
    assert.deepEqual(Object.keys(template.areas).sort(), REQUIRED_LAUNCH_AREAS.map((area) => area.id).sort());
    for (const area of REQUIRED_LAUNCH_AREAS) {
      assert.deepEqual(
        Object.keys(template.areas[area.id].checks).sort(),
        area.checks.map((check) => check.id).sort(),
      );
    }
    assert.deepEqual(
      Object.keys(template.finalSignoff.approvals).sort(),
      FINAL_SIGNOFF_ROLES.map((role) => role.id).sort(),
    );
    assert.doesNotMatch(JSON.stringify(template), /sk_live_|whsec_|re_[A-Za-z0-9]|postgres(?:ql)?:\/\/|SUPABASE_SERVICE_ROLE_KEY=/);

    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /approvedForLaunch must be true/);
    assert.match(result.stderr, /areas\.releaseGate\.status must be complete/);
    assert.match(result.stderr, /finalSignoff\.approvals\.engineering\.status must be approved/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator rejects chronologically impossible evidence dates', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.releaseGate.checks.test.evidence[0].capturedAt = '2026-06-09T12:00:00.000Z';
  evidence.finalSignoff.approvedAt = '2026-06-07T12:00:00.000Z';
  evidence.finalSignoff.evidence[0].capturedAt = '2026-06-08T12:00:00.000Z';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /releaseGate\.checks\.test\.evidence\[0\]\.capturedAt must not be after preparedAt/);
    assert.match(result.stderr, /finalSignoff\.approvedAt must not be before preparedAt/);
    assert.match(result.stderr, /finalSignoff\.evidence\[0\]\.capturedAt must not be after finalSignoff\.approvedAt/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator rejects placeholders, local URLs, and raw secrets', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.hostingDnsTls.checks['web-origin'].evidence[0].reference = 'http://localhost:3000/todo';
  evidence.areas.billingAndEmail.checks['stripe-webhook-secret'].evidence[0].description = 'whsec_rawWebhookSecretMustNotAppear';
  evidence.areas.observability.checks['incident-owner'].evidence[0].reference = 'TBD';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /hostingDnsTls\.checks\.web-origin\.evidence\[0\]\.reference must be an https URL when a URL is provided/);
    assert.match(result.stderr, /observability\.checks\.incident-owner\.evidence\[0\]\.reference must not be a placeholder or local reference/);
    assert.match(result.stderr, /billingAndEmail\.checks\.stripe-webhook-secret\.evidence\[0\]\.description must not contain raw secret-looking values/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
