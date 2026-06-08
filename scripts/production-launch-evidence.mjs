#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_LAUNCH_AREAS = [
  {
    id: 'releaseGate',
    label: 'Release Gate',
    checks: [
      ['npm-ci', 'npm ci completed on the release build machine'],
      ['db-generate', 'API Prisma client generation completed'],
      ['prisma-validate', 'Prisma schema validation completed'],
      ['lint', 'lint completed'],
      ['test', 'test suite completed'],
      ['build-shared', 'shared package build completed'],
      ['build-api', 'API build completed'],
      ['build-web', 'web build completed'],
      ['audit', 'production dependency audit completed'],
      ['check-production', 'production env validation completed against real secrets'],
      ['deploy-preflight', 'digest-pinned deploy preflight completed'],
      ['deploy-production', 'production Docker deployment completed'],
      ['deploy-smoke', 'post-deploy public HTTPS smoke completed'],
      ['deploy-rollback', 'rollback rehearsal completed'],
      ['cosign', 'cosign signature verification completed'],
      ['digest-manifest', 'release image digest manifest used'],
    ],
  },
  {
    id: 'secretsAndEnv',
    label: 'Secrets And Environment',
    checks: [
      ['real-production-values', 'real production values created from the template'],
      ['secret-source-excluded-from-git', 'production secret source excluded from git'],
      ['node-env-production', 'NODE_ENV set for production runtimes'],
      ['jwt-secret-entropy', 'JWT_SECRET has production entropy'],
      ['frontend-api-origins', 'frontend and API origins are HTTPS'],
      ['supabase-public-origin', 'Supabase public origins match'],
      ['web-compose-api-origin', 'web Compose API origin matches API URL'],
      ['web-compose-supabase-origin', 'web Compose Supabase origin matches public Supabase URL'],
      ['auth-cookie-domain', 'auth cookie domain matches deployment scope'],
      ['stripe-live-keys', 'Stripe keys are live mode'],
      ['resend-domain', 'Resend sender domain is verified'],
      ['supabase-service-role-secret-store', 'Supabase service role key is stored only in API secrets'],
    ],
  },
  {
    id: 'hostingDnsTls',
    label: 'Hosting, DNS, And TLS',
    checks: [
      ['web-origin', 'web app deployed at approved HTTPS origin'],
      ['api-origin', 'API deployed at approved HTTPS origin'],
      ['dns-owner', 'DNS records managed by approved owner'],
      ['tls-certificates', 'TLS certificates valid for web and API origins'],
      ['cors-approved-origins', 'API CORS allows only approved frontend origins'],
      ['security-headers', 'security headers are present on API responses'],
      ['hosting-check', 'production hosting/DNS/TLS checker completed'],
    ],
  },
  {
    id: 'database',
    label: 'Database And Migrations',
    checks: [
      ['postgres-provisioned', 'production PostgreSQL database provisioned'],
      ['database-url-secret-store', 'DATABASE_URL present only in secret store'],
      ['migrations-deployed', 'production migrations deployed'],
      ['database-check', 'production database backup and restore checker completed'],
      ['backups-enabled', 'managed backups or PITR enabled'],
      ['restore-tested', 'restore test evidence exists and has an owner'],
    ],
  },
  {
    id: 'supabaseStorage',
    label: 'Supabase Storage',
    checks: [
      ['separate-production-project', 'production Supabase project is separate'],
      ['documents-bucket-exists', 'documents bucket exists or configured bucket is approved'],
      ['bucket-private', 'bucket is private'],
      ['supabase-check', 'production Supabase storage checker completed'],
      ['readiness-storage-configured', 'readiness reports storageConfigured true'],
      ['readiness-storage-reachable', 'readiness reports storageBucketReachable true'],
      ['document-upload-download', 'document upload and signed download verified through deployed app'],
    ],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    checks: [
      ['scheduler-owned', 'production reminder scheduling is owned'],
      ['scheduler-command', 'scheduler runs the approved job command when used'],
      ['scheduler-secret-source', 'scheduler receives the production secret source'],
      ['scheduler-logs-alerts', 'scheduler logs and failure alerts are available'],
    ],
  },
  {
    id: 'billingAndEmail',
    label: 'Billing And Email',
    checks: [
      ['stripe-products-prices', 'Stripe live products and prices match expected IDs'],
      ['stripe-webhook-endpoint', 'Stripe webhook points to deployed API endpoint'],
      ['stripe-webhook-secret', 'Stripe webhook signing secret matches secret store value'],
      ['resend-send', 'Resend can send from EMAIL_FROM'],
      ['providers-check', 'production Stripe and Resend provider checker completed'],
      ['email-links-production-origin', 'email links point to production frontend origin'],
    ],
  },
  {
    id: 'observability',
    label: 'Observability And Incidents',
    checks: [
      ['api-logs', 'API logs are captured'],
      ['web-logs', 'web logs or platform events are captured'],
      ['error-alert-tested', 'error alert destination is configured and tested'],
      ['observability-check', 'production observability test alert checker completed'],
      ['uptime-health', 'public uptime monitoring checks health'],
      ['internal-readiness-monitoring', 'internal readiness monitoring checks keyed readiness'],
      ['incident-owner', 'incident owner and escalation path are recorded outside git'],
    ],
  },
  {
    id: 'legalAndCompliance',
    label: 'Legal And Compliance',
    checks: [
      ['privacy-policy-approved', 'privacy policy approved'],
      ['terms-approved', 'terms or service agreement approved'],
      ['retention-policy-approved', 'data retention policy approved'],
      ['support-deletion-contact', 'support and data deletion contact path published'],
    ],
  },
  {
    id: 'browserQa',
    label: 'Browser QA',
    checks: [
      ['browser-qa-completed', 'production browser QA checklist completed'],
      ['desktop-coverage', 'desktop browser coverage recorded'],
      ['mobile-coverage', 'mobile browser coverage recorded'],
      ['critical-flows-covered', 'critical production flows covered'],
    ],
  },
  {
    id: 'securityReview',
    label: 'External Security Review',
    checks: [
      ['penetration-test-complete', 'external penetration test complete'],
      ['critical-high-findings', 'critical and high findings remediated or accepted'],
      ['retest-evidence', 'retest evidence exists for fixed findings'],
      ['report-reference', 'report reference stored outside git'],
    ],
  },
].map((area) => ({
  ...area,
  checks: area.checks.map(([id, label]) => ({ id, label })),
}));

const allowedEvidenceTypes = new Set([
  'approval',
  'artifact',
  'command-output',
  'report',
  'screenshot',
  'ticket',
  'url',
]);

const placeholderOrLocalPattern = /\b(todo|tbd|pending|open|example(?:\.com|\.org|\.net)?|localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b|file:\/\//i;
const rawSecretPattern = /\b(sk_live_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\/[^@\s]+@|DATABASE_URL=|JWT_SECRET=|SUPABASE_SERVICE_ROLE_KEY=|STRIPE_SECRET_KEY=|STRIPE_WEBHOOK_SECRET=|RESEND_API_KEY=)\b/;
const imageRepositories = {
  apiImage: 'ghcr.io/jasperfordesq-ai/charity-governance-api',
  webImage: 'ghcr.io/jasperfordesq-ai/charity-governance-web',
  migrationImage: 'ghcr.io/jasperfordesq-ai/charity-governance-migrations',
};

function usage() {
  return 'Usage: node scripts/production-launch-evidence.mjs --evidence-file <path>\n';
}

function parseArgs(argv) {
  const options = {
    evidenceFile: 'production-launch-evidence.json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--evidence-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence-file requires a value');
      options.evidenceFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--evidence-file=')) {
      options.evidenceFile = arg.slice('--evidence-file='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isoTimestamp(value) {
  return isIsoDate(value) ? Date.parse(value) : null;
}

function validateExternalText(value, path, issues) {
  if (typeof value !== 'string' || value.trim().length < 8) {
    issues.push(`${path} must be a non-empty external evidence reference`);
  }

  const trimmed = String(value ?? '').trim();
  if (placeholderOrLocalPattern.test(trimmed)) {
    issues.push(`${path} must not be a placeholder or local reference`);
  }
  if (rawSecretPattern.test(trimmed)) {
    issues.push(`${path} must not contain raw secret-looking values`);
  }
  if (/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('https://')) {
    issues.push(`${path} must be an https URL when a URL is provided`);
  }
}

function validateReleaseWorkflowUrl(value, path, issues) {
  validateExternalText(value, path, issues);

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'github.com' ||
      !/^\/jasperfordesq-ai\/charity-governance\/actions\/runs\/\d+$/.test(url.pathname)
    ) {
      issues.push(`${path} must be a GitHub Actions release workflow run URL for charity-governance`);
    }
  } catch {
    issues.push(`${path} must be a valid URL`);
  }
}

function validateHttpsOrigin(value, path, issues, options = {}) {
  validateExternalText(value, path, issues);

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.origin !== value.replace(/\/+$/, '')) {
      issues.push(`${path} must be an origin-only https URL`);
    }
    if (options.hostSuffix && hostname !== options.hostSuffix && !hostname.endsWith(`.${options.hostSuffix}`)) {
      issues.push(`${path} must use an approved ${options.hostSuffix} hostname`);
    }
  } catch {
    issues.push(`${path} must be a valid URL`);
  }
}

function validateImageRef(value, path, repository, issues) {
  validateExternalText(value, path, issues);

  const expected = new RegExp(`^${repository.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`);
  if (typeof value !== 'string' || !expected.test(value)) {
    issues.push(`${path} must use ${repository}@sha256:<64 lowercase hex chars>`);
  }
}

function validateReleaseBinding(release, issues) {
  if (!isPlainObject(release)) {
    issues.push('release is required');
    return;
  }

  if (typeof release.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(release.commitSha)) {
    issues.push('release.commitSha must be a 40 character lowercase git SHA');
  }
  validateReleaseWorkflowUrl(release.workflowRunUrl, 'release.workflowRunUrl', issues);

  if (!isPlainObject(release.imageDigestManifest)) {
    issues.push('release.imageDigestManifest is required');
    return;
  }

  validateImageRef(release.imageDigestManifest.apiImage, 'release.imageDigestManifest.apiImage', imageRepositories.apiImage, issues);
  validateImageRef(release.imageDigestManifest.webImage, 'release.imageDigestManifest.webImage', imageRepositories.webImage, issues);
  validateImageRef(
    release.imageDigestManifest.migrationImage,
    'release.imageDigestManifest.migrationImage',
    imageRepositories.migrationImage,
    issues,
  );
  validateHttpsOrigin(
    release.imageDigestManifest.webBuildNextPublicApiUrl,
    'release.imageDigestManifest.webBuildNextPublicApiUrl',
    issues,
    { hostSuffix: 'charitypilot.ie' },
  );
  validateHttpsOrigin(
    release.imageDigestManifest.webBuildNextPublicSupabaseUrl,
    'release.imageDigestManifest.webBuildNextPublicSupabaseUrl',
    issues,
    { hostSuffix: 'supabase.co' },
  );
}

function validateEvidenceEntries(entries, path, issues, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    issues.push(`${path} must include at least one evidence entry`);
    return;
  }

  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(`${entryPath} must be an object`);
      return;
    }

    if (!allowedEvidenceTypes.has(entry.type)) {
      issues.push(`${entryPath}.type must be one of ${Array.from(allowedEvidenceTypes).join(', ')}`);
    }
    validateExternalText(entry.reference, `${entryPath}.reference`, issues);
    validateExternalText(entry.description, `${entryPath}.description`, issues);
    const capturedAt = isoTimestamp(entry.capturedAt);
    if (capturedAt === null) {
      issues.push(`${entryPath}.capturedAt must be an ISO timestamp`);
    } else if (typeof options.notAfter === 'number' && capturedAt > options.notAfter) {
      issues.push(`${entryPath}.capturedAt must not be after ${options.notAfterLabel}`);
    }
  });
}

function validateLaunchEvidence(evidence) {
  const issues = [];

  if (!isPlainObject(evidence)) {
    return ['evidence file must contain a JSON object'];
  }
  if (evidence.version !== 1) {
    issues.push('version must be 1');
  }
  if (typeof evidence.preparedBy !== 'string' || evidence.preparedBy.trim().length < 3) {
    issues.push('preparedBy is required');
  }
  const preparedAt = isoTimestamp(evidence.preparedAt);
  if (preparedAt === null) {
    issues.push('preparedAt must be an ISO timestamp');
  }
  if (evidence.approvedForLaunch !== true) {
    issues.push('approvedForLaunch must be true');
  }
  validateReleaseBinding(evidence.release, issues);
  if (!isPlainObject(evidence.areas)) {
    issues.push('areas is required');
    return issues;
  }

  for (const area of REQUIRED_LAUNCH_AREAS) {
    const areaPath = `areas.${area.id}`;
    const actualArea = evidence.areas[area.id];
    if (!isPlainObject(actualArea)) {
      issues.push(`${areaPath} is required`);
      continue;
    }
    if (actualArea.status !== 'complete') {
      issues.push(`${areaPath}.status must be complete`);
    }
    if (typeof actualArea.owner !== 'string' || actualArea.owner.trim().length < 3) {
      issues.push(`${areaPath}.owner is required`);
    }
    if (!isPlainObject(actualArea.checks)) {
      issues.push(`${areaPath}.checks is required`);
      continue;
    }

    for (const check of area.checks) {
      const checkPath = `${areaPath}.checks.${check.id}`;
      const actualCheck = actualArea.checks[check.id];
      if (!isPlainObject(actualCheck)) {
        issues.push(`${area.id}.checks.${check.id} is required`);
        continue;
      }
      if (actualCheck.status !== 'complete') {
        issues.push(`${checkPath}.status must be complete`);
      }
      validateEvidenceEntries(actualCheck.evidence, `${checkPath}.evidence`, issues, {
        notAfter: preparedAt,
        notAfterLabel: 'preparedAt',
      });
    }
  }

  if (!isPlainObject(evidence.finalSignoff)) {
    issues.push('finalSignoff is required');
  } else {
    if (evidence.finalSignoff.status !== 'approved') {
      issues.push('finalSignoff.status must be approved');
    }
    if (typeof evidence.finalSignoff.owner !== 'string' || evidence.finalSignoff.owner.trim().length < 3) {
      issues.push('finalSignoff.owner is required');
    }
    const approvedAt = isoTimestamp(evidence.finalSignoff.approvedAt);
    if (approvedAt === null) {
      issues.push('finalSignoff.approvedAt must be an ISO timestamp');
    } else if (preparedAt !== null && approvedAt < preparedAt) {
      issues.push('finalSignoff.approvedAt must not be before preparedAt');
    }
    validateEvidenceEntries(evidence.finalSignoff.evidence, 'finalSignoff.evidence', issues, {
      notAfter: approvedAt,
      notAfterLabel: 'finalSignoff.approvedAt',
    });
  }

  return issues;
}

function countChecks() {
  return REQUIRED_LAUNCH_AREAS.reduce((total, area) => total + area.checks.length, 0);
}

export function runProductionLaunchEvidenceFromArgs(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const evidencePath = resolve(process.cwd(), options.evidenceFile);
  if (!existsSync(evidencePath)) {
    return result(1, '', `Production launch evidence failed: evidence file not found: ${options.evidenceFile}\n`);
  }

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    return result(1, '', `Production launch evidence failed: evidence file is not valid JSON. ${error.message}\n`);
  }

  const issues = validateLaunchEvidence(evidence);
  if (issues.length > 0) {
    return result(
      1,
      '',
      [
        `Production launch evidence failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  return result(
    0,
    `Production launch evidence passed: ${REQUIRED_LAUNCH_AREAS.length} area(s), ${countChecks()} check(s) complete with final signoff.\n`,
  );
}

function main() {
  const evidenceResult = runProductionLaunchEvidenceFromArgs();
  if (evidenceResult.stdout) process.stdout.write(evidenceResult.stdout);
  if (evidenceResult.stderr) process.stderr.write(evidenceResult.stderr);
  process.exit(evidenceResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
