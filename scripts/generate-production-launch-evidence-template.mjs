#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { FINAL_SIGNOFF_ROLES, REQUIRED_LAUNCH_AREAS } from './production-launch-evidence.mjs';

const placeholderTimestamp = 'REPLACE_WITH_ISO_TIMESTAMP';

const evidenceHintsByCheck = new Map([
  ['releaseGate.npm-ci', ['npm ci', 'exit 0']],
  ['releaseGate.db-generate', ['npm run db:generate -w @charitypilot/api', 'exit 0']],
  ['releaseGate.prisma-validate', ['npx prisma validate --schema apps/api/prisma/schema.prisma', 'exit 0']],
  ['releaseGate.lint', ['npm run lint', 'exit 0']],
  ['releaseGate.test', ['npm run test', 'exit 0']],
  ['releaseGate.build-shared', ['npm run build -w @charitypilot/shared', 'exit 0']],
  ['releaseGate.build-api', ['npm run build -w @charitypilot/api', 'exit 0']],
  ['releaseGate.build-web', ['npm run build -w @charitypilot/web', 'exit 0']],
  ['releaseGate.audit', ['npm audit --omit=dev --audit-level=moderate', 'no moderate-or-higher production vulnerabilities']],
  ['secretsAndEnv.real-production-values', ['.env.production', 'real production values']],
  ['secretsAndEnv.secret-source-excluded-from-git', ['secret store', 'excluded from git']],
  ['secretsAndEnv.node-env-production', ['NODE_ENV=production']],
  ['secretsAndEnv.jwt-secret-entropy', ['JWT_SECRET', '32 characters', 'high entropy']],
  ['secretsAndEnv.frontend-api-origins', ['https://app.charitypilot.ie', 'https://api.charitypilot.ie']],
  ['hostingDnsTls.web-origin', ['https://app.charitypilot.ie']],
  ['hostingDnsTls.api-origin', ['https://api.charitypilot.ie']],
  ['hostingDnsTls.dns-owner', ['DNS owner', 'approved owner', 'DNS record', 'app.charitypilot.ie', 'api.charitypilot.ie']],
  ['hostingDnsTls.tls-certificates', [
    'TLS certificate',
    'valid',
    'https://app.charitypilot.ie',
    'https://api.charitypilot.ie',
    'certificate issuer',
    'expiry date',
  ]],
  ['hostingDnsTls.cors-approved-origins', ['CORS', 'https://app.charitypilot.ie', 'only approved', 'rejected unapproved origin']],
  ['hostingDnsTls.security-headers', [
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Content-Security-Policy',
    'Strict-Transport-Security',
    'HSTS max-age',
  ]],
  ['database.database-check', ['--expect-operational-sentinel']],
  ['database.backups-enabled', ['managed backups or PITR', 'backup window', 'retention period', 'backup owner']],
  ['database.restore-tested', ['restore test', 'owner', 'restore date', 'recovery notes', 'operational sentinel']],
  ['supabaseStorage.readiness-storage-configured', ['storageConfigured: true']],
  ['supabaseStorage.readiness-storage-reachable', ['storageBucketReachable: true']],
  ['supabaseStorage.supabase-backups-enabled', [
    'Supabase backup policy',
    'managed backups or PITR',
    'backup window',
    'retention period',
    'backup owner',
  ]],
  ['supabaseStorage.supabase-restore-tested', ['Supabase restore test', 'owner', 'restore date', 'recovery notes']],
  ['jobs.scheduler-command', [
    'dist/jobs/production-scheduler.js',
    'dist/jobs/send-deadline-reminders.js',
    'dist/jobs/cleanup-document-storage.js',
  ]],
  ['billingAndEmail.stripe-products-prices', [
    'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
    'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
    'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
    'STRIPE_COMPLETE_YEARLY_PRICE_ID',
    'active live recurring Stripe prices',
  ]],
  ['billingAndEmail.stripe-webhook-endpoint', [
    'https://api.charitypilot.ie/api/v1/billing/webhooks',
    'checkout.session.completed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ]],
  ['billingAndEmail.providers-check', [
    'npm run check:production:providers -- --production-env-file=.env.production',
    'Production provider check passed',
    'enabled live billing webhook endpoint',
    'required subscription events',
    'checkout.session.completed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'verified Resend sender domain',
  ]],
  ['billingAndEmail.resend-send', [
    'EMAIL_FROM',
    'Resend test send',
    'accepted message id',
    'production sender domain',
    'verified Resend sender domain',
  ]],
  ['observability.api-logs', ['API logs', 'captured', 'log sink', 'retention']],
  ['observability.web-logs', ['web logs', 'platform events', 'captured', 'retention']],
  ['observability.error-alert-tested', [
    'error alert',
    'tested',
    'Production observability check passed',
    'sanitized test alert',
    'incident system confirmation',
  ]],
  ['observability.uptime-health', ['/api/v1/health', 'uptime monitoring', 'monitor owner', 'alert route']],
  ['observability.internal-readiness-monitoring', [
    '/api/v1/health/readiness',
    'x-charitypilot-readiness-key',
    'readiness monitor owner',
    'secret store',
  ]],
  ['observability.incident-owner', ['primary incident owner', 'backup owner', 'escalation path', 'outside git']],
  ['legalAndCompliance.privacy-policy-approved', [
    'privacy policy',
    'approved for production',
    'policy version',
    'effective date',
    'privacy approver',
  ]],
  ['legalAndCompliance.terms-approved', ['terms', 'approved for production', 'terms version', 'effective date']],
  ['legalAndCompliance.retention-policy-approved', [
    'data retention policy',
    'approved for production',
    'retention schedule',
    'deletion workflow',
  ]],
  ['legalAndCompliance.support-deletion-contact', [
    'support contact',
    'data deletion contact',
    'published',
    'published URL',
    'support mailbox',
  ]],
  ['legalAndCompliance.solicitor-governance-privacy-review', [
    'solicitor review',
    'governance review',
    'privacy review',
    'named solicitor',
    'named governance reviewer',
    'named privacy reviewer',
    'review date',
    'review-ready',
    'source-cited',
    'not a substitute for legal advice',
  ]],
  ['browserQa.browser-qa-completed', [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'npm run test:e2e:responsive',
    'or all four focused responsive chunks: test:e2e:responsive:public:desktop, test:e2e:responsive:public:mobile, test:e2e:responsive:dashboard:desktop, test:e2e:responsive:dashboard:mobile',
  ]],
  ['browserQa.desktop-coverage', [
    'desktop light and dark',
    'npm run test:e2e:responsive',
    'or both desktop chunks: test:e2e:responsive:public:desktop and test:e2e:responsive:dashboard:desktop',
  ]],
  ['browserQa.mobile-coverage', [
    'mobile light and dark',
    'npm run test:e2e:responsive',
    'or both mobile chunks: test:e2e:responsive:public:mobile and test:e2e:responsive:dashboard:mobile',
  ]],
  ['browserQa.accessibility-coverage', [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'E2E_OWNER_EMAIL',
    'E2E_OWNER_PASSWORD',
    'npm run test:e2e -- tests/accessibility.spec.ts',
    'light and dark',
  ]],
  ['browserQa.cross-browser-coverage', [
    'E2E_DEPLOYED_QA=true',
    'npm run test:e2e:deployed:responsive:cross-browser',
    'npm run test:e2e:deployed:accessibility:cross-browser',
    'deployed-chromium-desktop',
    'deployed-chromium-mobile',
    'deployed-firefox-desktop',
    'deployed-webkit-desktop',
  ]],
  ['browserQa.ios-safari-device-coverage', [
    'real iOS Safari',
    'manual or cloud-device evidence',
    'https://app.charitypilot.ie',
    'mobile light and dark',
  ]],
  ['browserQa.critical-flows-covered', [
    'docs/production-browser-qa.md',
    'Launch-Critical Route Inventory',
    'every route',
    'desktop, mobile, light-mode, and dark-mode evidence',
    'routes: /, /features, /pricing, /blog, /blog/[slug], /privacy, /terms, /login, /register, /forgot-password, /reset-password, /verify-email, /accept-invite, /dashboard, /compliance, /compliance/[principleId], /documents, /deadlines, /board, /registers, /regulator, /organisation, /team, /billing, /export',
    'auth flow',
    'dashboard flow',
    'billing flow',
    'document upload',
    'signed download',
    'logout',
    'error states',
    'zero critical or high-severity browser QA defects',
  ]],
  ['securityReview.penetration-test-complete', [
    'external penetration test',
    'testing provider',
    'testing scope',
    'https://app.charitypilot.ie',
    'https://api.charitypilot.ie',
    'release commit',
    'completed before real charity data',
  ]],
  ['securityReview.critical-high-findings', [
    'critical and high findings',
    'remediated or formally accepted',
    'accountable owner',
    'finding tracker',
    'risk acceptance approver',
    'acceptance date',
  ]],
  ['securityReview.retest-evidence', ['retest evidence', 'fixed findings', 'retest date', 'retest result']],
  ['securityReview.report-reference', [
    'penetration test report',
    'report reference',
    'stored outside git',
    'report version',
    'report date',
  ]],
]);

function evidenceHints(areaId, checkId) {
  return evidenceHintsByCheck.get(`${areaId}.${checkId}`) ?? [];
}

function evidenceTemplate() {
  return {
    version: 1,
    preparedBy: 'REPLACE_WITH_RELEASE_OWNER',
    preparedAt: placeholderTimestamp,
    approvedForLaunch: false,
    release: {
      commitSha: 'REPLACE_WITH_40_CHARACTER_GIT_SHA',
      workflowRunUrl: 'REPLACE_WITH_GITHUB_ACTIONS_RELEASE_WORKFLOW_RUN_URL',
      workflowFile: '.github/workflows/release-images.yml',
      gitRef: 'REPLACE_WITH_RELEASE_GIT_REF',
      imageDigestManifest: {
        apiImage: 'REPLACE_WITH_GHCR_API_IMAGE_SHA256_DIGEST',
        webImage: 'REPLACE_WITH_GHCR_WEB_IMAGE_SHA256_DIGEST',
        migrationImage: 'REPLACE_WITH_GHCR_MIGRATION_IMAGE_SHA256_DIGEST',
        webBuildNextPublicApiUrl: 'REPLACE_WITH_PRODUCTION_API_HTTPS_ORIGIN',
        webBuildNextPublicSupabaseUrl: 'REPLACE_WITH_PRODUCTION_SUPABASE_HTTPS_ORIGIN',
      },
    },
    areas: Object.fromEntries(REQUIRED_LAUNCH_AREAS.map((area) => [
      area.id,
      {
        owner: 'REPLACE_WITH_OWNER',
        status: 'pending',
        checks: Object.fromEntries(area.checks.map((check) => [
          check.id,
          {
            status: 'pending',
            requiredEvidenceHints: evidenceHints(area.id, check.id),
            evidence: [],
          },
        ])),
      },
    ])),
    finalSignoff: {
      status: 'pending',
      owner: 'REPLACE_WITH_ACCOUNTABLE_OWNER',
      approvedAt: placeholderTimestamp,
      approvals: Object.fromEntries(FINAL_SIGNOFF_ROLES.map((role) => [
        role.id,
        {
          status: 'pending',
          owner: `REPLACE_WITH_${role.id.toUpperCase()}_OWNER`,
          approvedAt: placeholderTimestamp,
          requiredEvidenceHints: [role.label, 'launch approval'],
          evidence: [],
        },
      ])),
      evidence: [],
    },
  };
}

export function renderProductionLaunchEvidenceTemplate() {
  return `${JSON.stringify(evidenceTemplate(), null, 2)}\n`;
}

function main() {
  process.stdout.write(renderProductionLaunchEvidenceTemplate());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
