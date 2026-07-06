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

  if (areaId === 'database' && checkId === 'postgres-provisioned') {
    entry.description = 'production PostgreSQL database provisioned on the approved managed provider.';
  }

  if (areaId === 'database' && checkId === 'database-url-secret-store') {
    entry.description = 'DATABASE_URL is stored only in the production secret store.';
  }

  if (areaId === 'database' && checkId === 'migrations-deployed') {
    entry.type = 'command-output';
    entry.description = 'npm run db:migrate:deploy -w @charitypilot/api completed against production.';
  }

  if (areaId === 'database' && checkId === 'backups-enabled') {
    entry.description = 'managed backups or PITR are enabled for the production PostgreSQL database.';
  }

  if (areaId === 'database' && checkId === 'restore-tested') {
    entry.description = 'restore test evidence exists with an accountable owner and recovery notes.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'real-production-values') {
    entry.description = '.env.production was materialized from the approved secret source with real production values.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'secret-source-excluded-from-git') {
    entry.description = 'Production secret store path is excluded from git and .env.production remains uncommitted.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'node-env-production') {
    entry.description = 'NODE_ENV=production is configured for API, web, migration, and scheduled job runtimes.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'jwt-secret-entropy') {
    entry.description = 'JWT_SECRET is high entropy and at least 32 characters in the production secret store.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'frontend-api-origins') {
    entry.description = 'Production origins are fixed to https://app.charitypilot.ie and https://api.charitypilot.ie.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'supabase-public-origin') {
    entry.description = 'SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL use the same HTTPS Supabase project.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'web-compose-api-origin') {
    entry.description = 'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL matches NEXT_PUBLIC_API_URL in the production secret source.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'web-compose-supabase-origin') {
    entry.description = 'CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL matches NEXT_PUBLIC_SUPABASE_URL in the production secret source.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'auth-cookie-domain') {
    entry.description = 'AUTH_COOKIE_DOMAIN=.charitypilot.ie covers the canonical web and API subdomains.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'stripe-live-keys') {
    entry.description = 'STRIPE_SECRET_KEY and related billing values were verified as Stripe live mode production keys.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'resend-domain') {
    entry.description = 'Resend sender domain is verified for the production EMAIL_FROM address.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'supabase-service-role-secret-store') {
    entry.description = 'SUPABASE_SERVICE_ROLE_KEY is stored only in the API secret store.';
  }

  if (areaId === 'releaseGate' && checkId === 'check-production') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production -- --production-env-file=.env.production',
      'Production preflight passed using .env.production',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'npm-ci') {
    entry.type = 'command-output';
    entry.description = 'npm ci completed on the release build machine with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'db-generate') {
    entry.type = 'command-output';
    entry.description = 'npm run db:generate -w @charitypilot/api completed with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'prisma-validate') {
    entry.type = 'command-output';
    entry.description = 'npx prisma validate --schema apps/api/prisma/schema.prisma completed with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'lint') {
    entry.type = 'command-output';
    entry.description = 'npm run lint completed with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'test') {
    entry.type = 'command-output';
    entry.description = 'npm run test completed with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'build-shared') {
    entry.type = 'command-output';
    entry.description = 'npm run build -w @charitypilot/shared completed with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'build-api') {
    entry.type = 'command-output';
    entry.description = 'npm run build -w @charitypilot/api completed with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'build-web') {
    entry.type = 'command-output';
    entry.description = 'npm run build -w @charitypilot/web completed with exit 0.';
  }

  if (areaId === 'releaseGate' && checkId === 'audit') {
    entry.type = 'command-output';
    entry.description = 'npm audit --omit=dev --audit-level=moderate completed with no moderate-or-higher production vulnerabilities.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'hosting-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:hosting -- --production-env-file=.env.production',
      'Production hosting check passed: 2 HTTPS origin(s) resolved publicly, served authorized TLS, responded over HTTPS, and included baseline security headers.',
    ].join(' ');
  }

  if (areaId === 'hostingDnsTls' && checkId === 'web-origin') {
    entry.description = 'Web app deployed at https://app.charitypilot.ie.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'api-origin') {
    entry.description = 'API deployed at https://api.charitypilot.ie.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'dns-owner') {
    entry.description = 'DNS owner is the approved owner for charitypilot.ie production records.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'tls-certificates') {
    entry.description =
      'TLS certificate evidence confirms valid certificates for https://app.charitypilot.ie and https://api.charitypilot.ie.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'cors-approved-origins') {
    entry.description = 'CORS allows https://app.charitypilot.ie and rejects all non-approved browser origins; only approved origins pass.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'security-headers') {
    entry.description = [
      'API response headers include X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, and Strict-Transport-Security.',
    ].join(' ');
  }

  if (areaId === 'supabaseStorage' && checkId === 'supabase-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:supabase -- --production-env-file=.env.production',
      'Production Supabase storage check passed: private bucket, service-role probe upload, signed URL creation, anonymous access denial, and probe cleanup verified.',
    ].join(' ');
  }

  if (areaId === 'supabaseStorage' && checkId === 'separate-production-project') {
    entry.description = 'production Supabase project is separate from local and staging projects.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'documents-bucket-exists') {
    entry.description = 'documents bucket exists in the production Supabase project.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'bucket-private') {
    entry.description = 'private bucket setting verified for the production documents bucket.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'readiness-storage-configured') {
    entry.description = 'Keyed readiness response reports storageConfigured: true.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'readiness-storage-reachable') {
    entry.description = 'Keyed readiness response reports storageBucketReachable: true.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'document-upload-download') {
    entry.description = 'document upload and signed download were verified through the deployed app.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'supabase-backups-enabled') {
    entry.description = 'Supabase backup policy evidence confirms managed backups or PITR are enabled for the production Supabase project.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'supabase-restore-tested') {
    entry.description = 'Supabase restore test evidence exists with an accountable owner and recovery notes for the production Supabase project.';
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

  if (areaId === 'billingAndEmail' && checkId === 'stripe-products-prices') {
    entry.description = [
      'Stripe product and price evidence confirms active live recurring Stripe prices for:',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID',
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
      'The verified Resend sender domain matches the production EMAIL_FROM address.',
      'Operator recorded the accepted message id and delivery log reference without raw API keys.',
    ].join(' ');
  }

  if (areaId === 'billingAndEmail' && checkId === 'email-links-production-origin') {
    entry.description = [
      'password reset and email verification messages were requested in production.',
      'Both email links used https://app.charitypilot.ie as the frontend origin.',
    ].join(' ');
  }

  if (areaId === 'legalAndCompliance' && checkId === 'privacy-policy-approved') {
    entry.description = 'privacy policy approved for production by the accountable legal/compliance owner.';
  }

  if (areaId === 'legalAndCompliance' && checkId === 'terms-approved') {
    entry.description = 'terms or service agreement approved for production by the accountable legal/compliance owner.';
  }

  if (areaId === 'legalAndCompliance' && checkId === 'retention-policy-approved') {
    entry.description = 'data retention policy approved for production by the accountable legal/compliance owner.';
  }

  if (areaId === 'legalAndCompliance' && checkId === 'support-deletion-contact') {
    entry.description = 'support contact and data deletion contact published for production users.';
  }

  if (areaId === 'legalAndCompliance' && checkId === 'solicitor-governance-privacy-review') {
    entry.description = [
      'solicitor review, governance review, and privacy review completed for production wording.',
      'Review confirms CharityPilot remains review-ready, source-cited, and not a substitute for legal advice.',
    ].join(' ');
  }

  if (areaId === 'securityReview' && checkId === 'penetration-test-complete') {
    entry.description = 'external penetration test by named testing provider completed before real charity data.';
  }

  if (areaId === 'securityReview' && checkId === 'critical-high-findings') {
    entry.description = 'critical and high findings were remediated or formally accepted by the accountable owner.';
  }

  if (areaId === 'securityReview' && checkId === 'retest-evidence') {
    entry.description = 'retest evidence exists for fixed findings from the external penetration test.';
  }

  if (areaId === 'securityReview' && checkId === 'report-reference') {
    entry.description = 'penetration test report reference stored outside git in the approved evidence vault.';
  }

  if (areaId === 'observability' && checkId === 'observability-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:observability -- --production-env-file=.env.production',
      'Production observability check passed: sent sanitized test alert to redacted webhook.',
    ].join(' ');
  }

  if (areaId === 'observability' && checkId === 'api-logs') {
    entry.description = 'API logs are captured by the production platform log sink with retention policy evidence.';
  }

  if (areaId === 'observability' && checkId === 'web-logs') {
    entry.description = 'web logs and platform events are captured by the production platform log sink with retention policy evidence.';
  }

  if (areaId === 'observability' && checkId === 'error-alert-tested') {
    entry.description = [
      'error alert destination was configured and tested with a sanitized test alert.',
      'Production observability check passed and incident system confirmation was recorded outside git.',
    ].join(' ');
  }

  if (areaId === 'observability' && checkId === 'uptime-health') {
    entry.description = 'uptime monitoring checks /api/v1/health on the production API origin with monitor owner and alert route evidence.';
  }

  if (areaId === 'observability' && checkId === 'internal-readiness-monitoring') {
    entry.description = [
      'internal monitoring checks /api/v1/health/readiness with x-charitypilot-readiness-key.',
      'The readiness monitor owner and readiness-key secret store reference are recorded outside git.',
    ].join(' ');
  }

  if (areaId === 'observability' && checkId === 'incident-owner') {
    entry.description = 'primary incident owner, backup owner, and escalation path are recorded outside git in the approved runbook system.';
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
      'npm run check:production:release-run -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
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

  if (areaId === 'jobs' && checkId === 'scheduler-owned') {
    entry.description = 'Docker Compose production-scheduler service has an accountable owner for production job scheduling.';
  }

  if (areaId === 'jobs' && checkId === 'scheduler-secret-source') {
    entry.description = 'Scheduler receives the same production secret source as the API via the non-committed .env.production materialization.';
  }

  if (areaId === 'jobs' && checkId === 'scheduler-logs-alerts') {
    entry.type = 'command-output';
    entry.description = [
      'scheduler logs are captured by the production platform log sink.',
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

  if (areaId === 'browserQa' && checkId === 'desktop-coverage') {
    entry.type = 'command-output';
    entry.description = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'npm run test:e2e:responsive',
      'responsive-smoke.spec.ts passed against deployed HTTPS production URL',
      'desktop light and dark route coverage completed',
    ].join(' ');
  }

  if (areaId === 'browserQa' && checkId === 'mobile-coverage') {
    entry.type = 'command-output';
    entry.description = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'npm run test:e2e:responsive',
      'responsive-smoke.spec.ts passed against deployed HTTPS production URL',
      'mobile light and dark route coverage completed',
    ].join(' ');
  }

  if (areaId === 'browserQa' && checkId === 'accessibility-coverage') {
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

  if (areaId === 'browserQa' && checkId === 'cross-browser-coverage') {
    entry.type = 'command-output';
    entry.description = [
      'E2E_DEPLOYED_QA=true',
      'npm run test:e2e:deployed:responsive:cross-browser completed against deployed HTTPS production URL.',
      'npm run test:e2e:deployed:accessibility:cross-browser completed against deployed HTTPS production URL.',
      'Projects covered: deployed-chromium-desktop, deployed-chromium-mobile, deployed-firefox-desktop, deployed-webkit-desktop.',
    ].join(' ');
  }

  if (areaId === 'browserQa' && checkId === 'ios-safari-device-coverage') {
    entry.description = [
      'real iOS Safari manual or cloud-device evidence recorded for https://app.charitypilot.ie.',
      'The run covered mobile light and dark rendering, navigation, login, dashboard, documents, and sign-out.',
    ].join(' ');
  }

  if (areaId === 'browserQa' && checkId === 'critical-flows-covered') {
    entry.type = 'command-output';
    entry.description = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD supplied from the secret store',
      'docs/production-browser-qa.md recorded auth flow, dashboard flow, billing flow, document upload, signed download, logout, and error states.',
      'zero critical or high-severity browser QA defects remain unresolved.',
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

function writeUtf16EvidenceFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-launch-evidence-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  const json = `${JSON.stringify(content, null, 2)}\n`;
  writeFileSync(evidencePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]));
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
    assert.match(result.stdout, /85 check\(s\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator accepts UTF-16 JSON emitted by Windows shells', async () => {
  const { runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();
  const { renderProductionLaunchEvidenceTemplate } = await loadEvidenceTemplateGenerator();
  const { tempDir, evidencePath } = writeUtf16EvidenceFile(JSON.parse(renderProductionLaunchEvidenceTemplate()));

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /not valid JSON/);
    assert.match(result.stderr, /approvedForLaunch must be true/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires concrete basic release gate command transcripts', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/release/basic-gates-reviewed',
    description: 'Basic release gates reviewed by release owner',
    capturedAt,
  };
  for (const checkId of [
    'npm-ci',
    'db-generate',
    'prisma-validate',
    'lint',
    'test',
    'build-shared',
    'build-api',
    'build-web',
    'audit',
  ]) {
    evidence.areas.releaseGate.checks[checkId].evidence = [genericEvidence];
  }
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.npm-ci\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.npm-ci\.evidence must include npm ci/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.db-generate\.evidence must include npm run db:generate -w @charitypilot\/api/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.prisma-validate\.evidence must include npx prisma validate --schema apps\/api\/prisma\/schema\.prisma/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.lint\.evidence must include npm run lint/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.test\.evidence must include npm run test/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.build-shared\.evidence must include npm run build -w @charitypilot\/shared/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.build-api\.evidence must include npm run build -w @charitypilot\/api/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.build-web\.evidence must include npm run build -w @charitypilot\/web/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.audit\.evidence must include no moderate-or-higher production vulnerabilities/);
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

test('production launch evidence validator requires concrete secrets and environment evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/secrets/env-reviewed',
    description: 'Production environment reviewed by operator',
    capturedAt,
  };
  for (const checkId of Object.keys(evidence.areas.secretsAndEnv.checks)) {
    evidence.areas.secretsAndEnv.checks[checkId].evidence = [genericEvidence];
  }
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.real-production-values\.evidence must include \.env\.production/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.secret-source-excluded-from-git\.evidence must include secret store/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.node-env-production\.evidence must include NODE_ENV=production/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.jwt-secret-entropy\.evidence must include high entropy/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.frontend-api-origins\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.supabase-public-origin\.evidence must include same HTTPS Supabase project/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.web-compose-api-origin\.evidence must include CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.web-compose-supabase-origin\.evidence must include CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.auth-cookie-domain\.evidence must include AUTH_COOKIE_DOMAIN=\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.stripe-live-keys\.evidence must include Stripe live mode/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.resend-domain\.evidence must include verified/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.supabase-service-role-secret-store\.evidence must include API secret store/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires concrete hosting database and Supabase evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const supabaseArea = REQUIRED_LAUNCH_AREAS.find((area) => area.id === 'supabaseStorage');
  assert.ok(
    supabaseArea?.checks.some((check) => check.id === 'supabase-backups-enabled'),
    'supabaseStorage must include backup policy evidence',
  );
  assert.ok(
    supabaseArea?.checks.some((check) => check.id === 'supabase-restore-tested'),
    'supabaseStorage must include restore-test evidence',
  );
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/ops/reviewed',
    description: 'Production infrastructure reviewed by operator',
    capturedAt,
  };
  for (const checkId of [
    'web-origin',
    'api-origin',
    'dns-owner',
    'tls-certificates',
    'cors-approved-origins',
    'security-headers',
  ]) {
    evidence.areas.hostingDnsTls.checks[checkId].evidence = [genericEvidence];
  }
  for (const checkId of [
    'postgres-provisioned',
    'database-url-secret-store',
    'migrations-deployed',
    'backups-enabled',
    'restore-tested',
  ]) {
    evidence.areas.database.checks[checkId].evidence = [genericEvidence];
  }
  for (const checkId of [
    'separate-production-project',
    'documents-bucket-exists',
    'bucket-private',
    'readiness-storage-configured',
    'readiness-storage-reachable',
    'document-upload-download',
    'supabase-backups-enabled',
    'supabase-restore-tested',
  ]) {
    evidence.areas.supabaseStorage.checks[checkId].evidence = [genericEvidence];
  }
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.web-origin\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.api-origin\.evidence must include https:\/\/api\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.dns-owner\.evidence must include approved owner/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.tls-certificates\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.tls-certificates\.evidence must include https:\/\/api\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.security-headers\.evidence must include Strict-Transport-Security/);
    assert.match(result.stderr, /areas\.database\.checks\.postgres-provisioned\.evidence must include production PostgreSQL/);
    assert.match(result.stderr, /areas\.database\.checks\.database-url-secret-store\.evidence must include DATABASE_URL/);
    assert.match(result.stderr, /areas\.database\.checks\.backups-enabled\.evidence must include managed backups or PITR/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.separate-production-project\.evidence must include production Supabase project/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.bucket-private\.evidence must include private bucket/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.readiness-storage-reachable\.evidence must include storageBucketReachable: true/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.document-upload-download\.evidence must include signed download/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include Supabase backup policy/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include Supabase restore test/);
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
  evidence.areas.billingAndEmail.checks['stripe-products-prices'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['stripe-webhook-endpoint'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['stripe-webhook-secret'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['resend-send'].evidence = [genericEvidence];
  evidence.areas.billingAndEmail.checks['email-links-production-origin'].evidence = [genericEvidence];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-products-prices\.evidence must include STRIPE_ESSENTIALS_MONTHLY_PRICE_ID/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-products-prices\.evidence must include STRIPE_COMPLETE_YEARLY_PRICE_ID/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-products-prices\.evidence must include active live recurring Stripe prices/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include required subscription events/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include checkout\.session\.completed/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include enabled live billing webhook endpoint/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include verified Resend sender domain/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-webhook-endpoint\.evidence must include https:\/\/api\.charitypilot\.ie\/api\/v1\/billing\/webhooks/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-webhook-secret\.evidence must include STRIPE_WEBHOOK_SECRET/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.stripe-webhook-secret\.evidence must include Stripe signing secret/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.resend-send\.evidence must include Resend test send/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.resend-send\.evidence must include accepted message id/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.resend-send\.evidence must include production sender domain/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.resend-send\.evidence must include verified Resend sender domain/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.email-links-production-origin\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.email-links-production-origin\.evidence must include password reset/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.email-links-production-origin\.evidence must include email verification/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires deployed browser QA command transcripts', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const browserQaArea = REQUIRED_LAUNCH_AREAS.find((area) => area.id === 'browserQa');
  assert.ok(
    browserQaArea?.checks.some((check) => check.id === 'accessibility-coverage'),
    'browserQa must include a dedicated deployed accessibility evidence check',
  );
  assert.ok(
    browserQaArea?.checks.some((check) => check.id === 'cross-browser-coverage'),
    'browserQa must include deployed cross-browser evidence',
  );
  assert.ok(
    browserQaArea?.checks.some((check) => check.id === 'ios-safari-device-coverage'),
    'browserQa must include real-device or cloud-device iOS Safari evidence',
  );

  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericBrowserEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/browser/generic',
    description: 'Browser QA checklist reviewed without deployed Playwright command output',
    capturedAt,
  };
  evidence.areas.browserQa.checks['browser-qa-completed'].evidence = [genericBrowserEvidence];
  evidence.areas.browserQa.checks['desktop-coverage'].evidence = [genericBrowserEvidence];
  evidence.areas.browserQa.checks['mobile-coverage'].evidence = [genericBrowserEvidence];
  evidence.areas.browserQa.checks['accessibility-coverage'].evidence = [genericBrowserEvidence];
  evidence.areas.browserQa.checks['cross-browser-coverage'].evidence = [genericBrowserEvidence];
  evidence.areas.browserQa.checks['ios-safari-device-coverage'].evidence = [genericBrowserEvidence];
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
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include npm run test:e2e:responsive or all four focused responsive route chunks/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.desktop-coverage\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.desktop-coverage\.evidence must include desktop light and dark/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.mobile-coverage\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.mobile-coverage\.evidence must include mobile light and dark/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.accessibility-coverage\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.accessibility-coverage\.evidence must include npm run test:e2e -- tests\/accessibility\.spec\.ts/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.accessibility-coverage\.evidence must include light and dark/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.cross-browser-coverage\.evidence must include test:e2e:deployed:responsive:cross-browser/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.cross-browser-coverage\.evidence must include deployed-firefox-desktop/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.cross-browser-coverage\.evidence must include deployed-webkit-desktop/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.ios-safari-device-coverage\.evidence must include real iOS Safari/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.ios-safari-device-coverage\.evidence must include manual or cloud-device evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include docs\/production-browser-qa\.md/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include auth flow/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include document upload/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include zero critical or high-severity browser QA defects/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator accepts complete chunked responsive QA transcripts', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);

  evidence.areas.browserQa.checks['browser-qa-completed'].evidence[0].description = [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD supplied from the secret store',
    'npm run test:e2e:responsive:public:desktop',
    'npm run test:e2e:responsive:public:mobile',
    'npm run test:e2e:responsive:dashboard:desktop',
    'npm run test:e2e:responsive:dashboard:mobile',
    'all four focused responsive route chunks passed against deployed HTTPS production URL',
  ].join(' ');
  evidence.areas.browserQa.checks['desktop-coverage'].evidence[0].description = [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'npm run test:e2e:responsive:public:desktop',
    'npm run test:e2e:responsive:dashboard:desktop',
    'desktop light and dark route coverage completed',
  ].join(' ');
  evidence.areas.browserQa.checks['mobile-coverage'].evidence[0].description = [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'npm run test:e2e:responsive:public:mobile',
    'npm run test:e2e:responsive:dashboard:mobile',
    'mobile light and dark route coverage completed',
  ].join(' ');
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production launch evidence passed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires concrete observability and scheduler evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'artifact',
    reference: 'https://evidence.charitypilot.ie/launch/ops/monitoring-reviewed',
    description: 'Monitoring and scheduler setup reviewed by operator',
    capturedAt,
  };
  for (const checkId of [
    'api-logs',
    'web-logs',
    'error-alert-tested',
    'uptime-health',
    'internal-readiness-monitoring',
    'incident-owner',
  ]) {
    evidence.areas.observability.checks[checkId].evidence = [genericEvidence];
  }
  evidence.areas.jobs.checks['scheduler-owned'].evidence = [genericEvidence];
  evidence.areas.jobs.checks['scheduler-secret-source'].evidence = [genericEvidence];
  evidence.areas.jobs.checks['scheduler-logs-alerts'].evidence = [{
    ...genericEvidence,
    type: 'command-output',
    description: 'deadline-reminders failure alert and document-storage-cleanup failure alert delivered',
  }];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.observability\.checks\.api-logs\.evidence must include API logs/);
    assert.match(result.stderr, /areas\.observability\.checks\.api-logs\.evidence must include log sink/);
    assert.match(result.stderr, /areas\.observability\.checks\.api-logs\.evidence must include retention/);
    assert.match(result.stderr, /areas\.observability\.checks\.web-logs\.evidence must include web logs/);
    assert.match(result.stderr, /areas\.observability\.checks\.web-logs\.evidence must include platform events/);
    assert.match(result.stderr, /areas\.observability\.checks\.web-logs\.evidence must include retention/);
    assert.match(result.stderr, /areas\.observability\.checks\.error-alert-tested\.evidence must include error alert/);
    assert.match(result.stderr, /areas\.observability\.checks\.error-alert-tested\.evidence must include Production observability check passed/);
    assert.match(result.stderr, /areas\.observability\.checks\.error-alert-tested\.evidence must include sanitized test alert/);
    assert.match(result.stderr, /areas\.observability\.checks\.error-alert-tested\.evidence must include incident system confirmation/);
    assert.match(result.stderr, /areas\.observability\.checks\.uptime-health\.evidence must include \/api\/v1\/health/);
    assert.match(result.stderr, /areas\.observability\.checks\.uptime-health\.evidence must include monitor owner/);
    assert.match(result.stderr, /areas\.observability\.checks\.uptime-health\.evidence must include alert route/);
    assert.match(result.stderr, /areas\.observability\.checks\.internal-readiness-monitoring\.evidence must include x-charitypilot-readiness-key/);
    assert.match(result.stderr, /areas\.observability\.checks\.internal-readiness-monitoring\.evidence must include readiness monitor owner/);
    assert.match(result.stderr, /areas\.observability\.checks\.internal-readiness-monitoring\.evidence must include secret store/);
    assert.match(result.stderr, /areas\.observability\.checks\.incident-owner\.evidence must include escalation path/);
    assert.match(result.stderr, /areas\.observability\.checks\.incident-owner\.evidence must include primary incident owner/);
    assert.match(result.stderr, /areas\.observability\.checks\.incident-owner\.evidence must include backup owner/);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-owned\.evidence must include production-scheduler/);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-secret-source\.evidence must include same production secret source/);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-logs-alerts\.evidence must include scheduler logs evidence/);
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

test('production launch evidence validator requires role-specific final approval evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericApproval = {
    type: 'approval',
    reference: 'https://evidence.charitypilot.ie/launch/final-signoff/generic-approval',
    description: 'Accountable owner launch approval recorded for launch',
    capturedAt,
  };
  evidence.finalSignoff.approvals.security.evidence = [genericApproval];
  evidence.finalSignoff.approvals.legalCompliance.evidence = [genericApproval];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /finalSignoff\.approvals\.security\.evidence must include Security owner/);
    assert.match(result.stderr, /finalSignoff\.approvals\.legalCompliance\.evidence must include Legal\/compliance owner/);
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

test('production launch evidence validator requires concrete legal and policy approval evidence', async () => {
  const { REQUIRED_LAUNCH_AREAS, runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'approval',
    reference: 'https://evidence.charitypilot.ie/launch/legal/generic-review',
    description: 'Legal checklist reviewed by accountable owner',
    capturedAt,
  };
  evidence.areas.legalAndCompliance.checks['privacy-policy-approved'].evidence = [genericEvidence];
  evidence.areas.legalAndCompliance.checks['terms-approved'].evidence = [genericEvidence];
  evidence.areas.legalAndCompliance.checks['retention-policy-approved'].evidence = [genericEvidence];
  evidence.areas.legalAndCompliance.checks['support-deletion-contact'].evidence = [genericEvidence];
  evidence.areas.legalAndCompliance.checks['solicitor-governance-privacy-review'].evidence = [genericEvidence];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.privacy-policy-approved\.evidence must include privacy policy/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.terms-approved\.evidence must include approved for production/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.retention-policy-approved\.evidence must include data retention policy/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.support-deletion-contact\.evidence must include data deletion contact/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.solicitor-governance-privacy-review\.evidence must include solicitor review/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.solicitor-governance-privacy-review\.evidence must include not a substitute for legal advice/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires concrete external security review evidence', async () => {
  const { REQUIRED_LAUNCH_AREAS, runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const genericEvidence = {
    type: 'report',
    reference: 'https://evidence.charitypilot.ie/launch/security/generic-review',
    description: 'Security review completed',
    capturedAt,
  };
  evidence.areas.securityReview.checks['penetration-test-complete'].evidence = [genericEvidence];
  evidence.areas.securityReview.checks['critical-high-findings'].evidence = [genericEvidence];
  evidence.areas.securityReview.checks['retest-evidence'].evidence = [genericEvidence];
  evidence.areas.securityReview.checks['report-reference'].evidence = [genericEvidence];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include external penetration test/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include completed before real charity data/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.critical-high-findings\.evidence must include remediated or formally accepted/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.retest-evidence\.evidence must include fixed findings/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.report-reference\.evidence must include stored outside git/);
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
    assert.deepEqual(
      template.areas.secretsAndEnv.checks['frontend-api-origins'].requiredEvidenceHints,
      ['https://app.charitypilot.ie', 'https://api.charitypilot.ie'],
    );
    assert.deepEqual(
      template.areas.hostingDnsTls.checks['tls-certificates'].requiredEvidenceHints,
      ['TLS certificate', 'valid', 'https://app.charitypilot.ie', 'https://api.charitypilot.ie'],
    );
    assert.deepEqual(
      template.areas.releaseGate.checks['npm-ci'].requiredEvidenceHints,
      ['npm ci', 'exit 0'],
    );
    assert.deepEqual(
      template.areas.releaseGate.checks.audit.requiredEvidenceHints,
      ['npm audit --omit=dev --audit-level=moderate', 'no moderate-or-higher production vulnerabilities'],
    );
    assert.ok(
      template.areas.supabaseStorage.checks['supabase-backups-enabled'].requiredEvidenceHints.includes(
        'Supabase backup policy',
      ),
    );
    assert.ok(
      template.areas.supabaseStorage.checks['supabase-restore-tested'].requiredEvidenceHints.includes(
        'Supabase restore test',
      ),
    );
    assert.ok(
      template.areas.billingAndEmail.checks['stripe-products-prices'].requiredEvidenceHints.includes(
        'STRIPE_COMPLETE_YEARLY_PRICE_ID',
      ),
    );
    assert.ok(
      template.areas.billingAndEmail.checks['stripe-products-prices'].requiredEvidenceHints.includes(
        'active live recurring Stripe prices',
      ),
    );
    assert.ok(
      template.areas.legalAndCompliance.checks['solicitor-governance-privacy-review'].requiredEvidenceHints.includes(
        'not a substitute for legal advice',
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['accessibility-coverage'].requiredEvidenceHints.includes(
        'npm run test:e2e -- tests/accessibility.spec.ts',
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['browser-qa-completed'].requiredEvidenceHints.some((hint) =>
        hint.includes('test:e2e:responsive:dashboard:mobile'),
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['desktop-coverage'].requiredEvidenceHints.some((hint) =>
        hint.includes('test:e2e:responsive:dashboard:desktop'),
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['mobile-coverage'].requiredEvidenceHints.some((hint) =>
        hint.includes('test:e2e:responsive:dashboard:mobile'),
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['accessibility-coverage'].requiredEvidenceHints.includes('light and dark'),
    );
    assert.ok(
      template.areas.browserQa.checks['cross-browser-coverage'].requiredEvidenceHints.includes(
        'deployed-firefox-desktop',
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['ios-safari-device-coverage'].requiredEvidenceHints.includes(
        'real iOS Safari',
      ),
    );
    assert.ok(
      template.areas.securityReview.checks['penetration-test-complete'].requiredEvidenceHints.includes(
        'completed before real charity data',
      ),
    );
    assert.deepEqual(
      template.finalSignoff.approvals.legalCompliance.requiredEvidenceHints,
      ['Legal/compliance owner', 'launch approval'],
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
