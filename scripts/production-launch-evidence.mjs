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
      ['release-workflow-identity', 'release workflow identity and git ref verified'],
      ['release-run-api-verification', 'GitHub release workflow run API verification completed'],
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
      ['supabase-backups-enabled', 'Supabase backup policy or PITR enabled'],
      ['supabase-restore-tested', 'Supabase restore test evidence exists and has an owner'],
    ],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    checks: [
      ['scheduler-owned', 'production reminder scheduling is owned'],
      ['scheduler-command', 'scheduler runs the approved production scheduler and job commands'],
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
      ['solicitor-governance-privacy-review', 'solicitor, governance, and privacy review completed'],
    ],
  },
  {
    id: 'browserQa',
    label: 'Browser QA',
    checks: [
      ['browser-qa-completed', 'production browser QA checklist completed'],
      ['desktop-coverage', 'desktop browser coverage recorded'],
      ['mobile-coverage', 'mobile browser coverage recorded'],
      ['accessibility-coverage', 'deployed accessibility coverage recorded'],
      ['cross-browser-coverage', 'deployed cross-browser automation coverage recorded'],
      ['ios-safari-device-coverage', 'real iOS Safari device coverage recorded'],
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
const releaseWorkflowFile = '.github/workflows/release-images.yml';
const defaultEvidenceFile = '.charitypilot-launch-evidence/production-launch-evidence.json';
export const FINAL_SIGNOFF_ROLES = [
  ['engineering', 'Engineering owner'],
  ['operations', 'Operations owner'],
  ['security', 'Security owner'],
  ['legalCompliance', 'Legal/compliance owner'],
  ['business', 'Business owner'],
].map(([id, label]) => ({ id, label }));

function usage() {
  return 'Usage: node scripts/production-launch-evidence.mjs --evidence-file <path>\n';
}

function parseArgs(argv) {
  const options = {
    evidenceFile: defaultEvidenceFile,
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

function decodeJsonFile(path) {
  const bytes = readFileSync(path);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return swapped.toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }

  return bytes.toString('utf8');
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
  if (release.workflowFile !== releaseWorkflowFile) {
    issues.push(`release.workflowFile must be ${releaseWorkflowFile}`);
  }
  if (typeof release.gitRef !== 'string' || !/^refs\/(?:heads\/master|tags\/v.+)$/.test(release.gitRef)) {
    issues.push('release.gitRef must be refs/heads/master or refs/tags/v*');
  }

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

function evidenceText(entries) {
  return Array.isArray(entries)
    ? entries.map((entry) => `${entry?.type ?? ''} ${entry?.reference ?? ''} ${entry?.description ?? ''}`).join('\n')
    : '';
}

function hasEvidenceType(actualCheck, type) {
  return Array.isArray(actualCheck.evidence) && actualCheck.evidence.some((entry) => entry?.type === type);
}

function requireEvidenceText(text, needle, message, issues) {
  if (!text.includes(needle)) {
    issues.push(message);
  }
}

const responsiveFullCommand = 'npm run test:e2e:responsive';
const responsiveChunkCommands = {
  all: [
    'npm run test:e2e:responsive:public:desktop',
    'npm run test:e2e:responsive:public:mobile',
    'npm run test:e2e:responsive:dashboard:desktop',
    'npm run test:e2e:responsive:dashboard:mobile',
  ],
  desktop: [
    'npm run test:e2e:responsive:public:desktop',
    'npm run test:e2e:responsive:dashboard:desktop',
  ],
  mobile: [
    'npm run test:e2e:responsive:public:mobile',
    'npm run test:e2e:responsive:dashboard:mobile',
  ],
};

function hasEveryMarker(text, markers) {
  return markers.every((marker) => text.includes(marker));
}

function requireResponsiveCommandEvidence(text, checkPath, issues, mode = 'all') {
  if (text.includes(responsiveFullCommand) || hasEveryMarker(text, responsiveChunkCommands[mode])) {
    return;
  }

  const chunkLabel = mode === 'all' ? 'all four focused responsive route chunks' : `both ${mode} focused responsive route chunks`;
  issues.push(`${checkPath}.evidence must include ${responsiveFullCommand} or ${chunkLabel}`);
}

function releaseImageRefs(release) {
  return [
    ['apiImage', release?.imageDigestManifest?.apiImage],
    ['webImage', release?.imageDigestManifest?.webImage],
    ['migrationImage', release?.imageDigestManifest?.migrationImage],
  ].filter(([, value]) => typeof value === 'string' && value.length > 0);
}

const executableCheckerEvidenceRequirements = new Map([
  ['releaseGate.check-production', {
    commandLabel: 'check:production',
    command: 'npm run check:production -- --production-env-file=.env.production',
    successText: 'Production preflight passed',
  }],
  ['hostingDnsTls.hosting-check', {
    commandLabel: 'check:production:hosting',
    command: 'npm run check:production:hosting -- --production-env-file=.env.production',
    successText: 'Production hosting check passed',
  }],
  ['database.database-check', {
    commandLabel: 'check:production:database',
    command: 'npm run check:production:database -- --production-env-file=.env.production',
    successText: 'Production database check passed',
  }],
  ['supabaseStorage.supabase-check', {
    commandLabel: 'check:production:supabase',
    command: 'npm run check:production:supabase -- --production-env-file=.env.production',
    successText: 'Production Supabase storage check passed',
  }],
  ['billingAndEmail.providers-check', {
    commandLabel: 'check:production:providers',
    command: 'npm run check:production:providers -- --production-env-file=.env.production',
    successText: 'Production provider check passed',
  }],
  ['observability.observability-check', {
    commandLabel: 'check:production:observability',
    command: 'npm run check:production:observability -- --production-env-file=.env.production',
    successText: 'Production observability check passed',
  }],
]);

function validateExecutableCheckerEvidence(areaId, checkId, actualCheck, checkPath, issues) {
  const requirement = executableCheckerEvidenceRequirements.get(`${areaId}.${checkId}`);
  if (!requirement) return;

  if (!hasEvidenceType(actualCheck, 'command-output')) {
    issues.push(`${checkPath}.evidence must include command-output evidence`);
  }

  const text = evidenceText(actualCheck.evidence);
  requireEvidenceText(
    text,
    requirement.command,
    `${checkPath}.evidence must include the ${requirement.commandLabel} command`,
    issues,
  );
  requireEvidenceText(text, requirement.successText, `${checkPath}.evidence must include ${requirement.successText}`, issues);
}

function validateReleaseGateEvidence(checkId, actualCheck, checkPath, release, issues) {
  const text = evidenceText(actualCheck.evidence);
  const images = releaseImageRefs(release);

  const basicReleaseGateCommands = {
    'npm-ci': {
      command: 'npm ci',
      successText: 'exit 0',
    },
    'db-generate': {
      command: 'npm run db:generate -w @charitypilot/api',
      successText: 'exit 0',
    },
    'prisma-validate': {
      command: 'npx prisma validate --schema apps/api/prisma/schema.prisma',
      successText: 'exit 0',
    },
    lint: {
      command: 'npm run lint',
      successText: 'exit 0',
    },
    test: {
      command: 'npm run test',
      successText: 'exit 0',
    },
    'build-shared': {
      command: 'npm run build -w @charitypilot/shared',
      successText: 'exit 0',
    },
    'build-api': {
      command: 'npm run build -w @charitypilot/api',
      successText: 'exit 0',
    },
    'build-web': {
      command: 'npm run build -w @charitypilot/web',
      successText: 'exit 0',
    },
    audit: {
      command: 'npm audit --omit=dev --audit-level=moderate',
      successText: 'no moderate-or-higher production vulnerabilities',
    },
  };

  const basicReleaseGateCommand = basicReleaseGateCommands[checkId];
  if (basicReleaseGateCommand) {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }
    requireEvidenceText(
      text,
      basicReleaseGateCommand.command,
      `${checkPath}.evidence must include ${basicReleaseGateCommand.command}`,
      issues,
    );
    requireEvidenceText(
      text,
      basicReleaseGateCommand.successText,
      `${checkPath}.evidence must include ${basicReleaseGateCommand.successText}`,
      issues,
    );
  }

  if (checkId === 'release-workflow-identity') {
    if (typeof release?.workflowRunUrl === 'string') {
      requireEvidenceText(text, release.workflowRunUrl, `${checkPath}.evidence must reference release.workflowRunUrl`, issues);
    }
    if (typeof release?.workflowFile === 'string') {
      requireEvidenceText(text, release.workflowFile, `${checkPath}.evidence must include release.workflowFile`, issues);
    }
    if (typeof release?.gitRef === 'string') {
      requireEvidenceText(text, release.gitRef, `${checkPath}.evidence must include release.gitRef`, issues);
    }
    if (typeof release?.commitSha === 'string') {
      requireEvidenceText(text, release.commitSha, `${checkPath}.evidence must include release.commitSha`, issues);
    }
    if (!/\bconclusion\s*[:=]?\s*success\b/i.test(text)) {
      issues.push(`${checkPath}.evidence must include successful workflow conclusion`);
    }
    requireEvidenceText(text, 'release-image-digests', `${checkPath}.evidence must include release-image-digests artifact`, issues);
  }

  if (checkId === 'deploy-preflight') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }
    requireEvidenceText(text, 'Production deploy preflight passed', `${checkPath}.evidence must include Production deploy preflight passed`, issues);
    for (const [, image] of images) {
      requireEvidenceText(text, image, `${checkPath}.evidence must include ${image}`, issues);
    }
  }

  if (checkId === 'deploy-production') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }
    requireEvidenceText(
      text,
      'npm run deploy:production -- --production-env-file=.env.production',
      `${checkPath}.evidence must include the production deploy command`,
      issues,
    );
    requireEvidenceText(
      text,
      'Production compose deploy completed',
      `${checkPath}.evidence must include Production compose deploy completed`,
      issues,
    );
  }

  if (checkId === 'deploy-smoke') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }
    requireEvidenceText(
      text,
      'npm run deploy:production -- --production-env-file=.env.production',
      `${checkPath}.evidence must include the production deploy smoke command`,
      issues,
    );
    requireEvidenceText(
      text,
      'node scripts/smoke-production-deploy.mjs',
      `${checkPath}.evidence must include the smoke-production-deploy command`,
      issues,
    );
    requireEvidenceText(
      text,
      'Production deploy smoke passed',
      `${checkPath}.evidence must include Production deploy smoke passed`,
      issues,
    );
    requireEvidenceText(text, 'https://app.charitypilot.ie', `${checkPath}.evidence must include https://app.charitypilot.ie`, issues);
    requireEvidenceText(text, 'https://api.charitypilot.ie', `${checkPath}.evidence must include https://api.charitypilot.ie`, issues);
  }

  if (checkId === 'deploy-rollback') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }
    requireEvidenceText(
      text,
      'npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env',
      `${checkPath}.evidence must include the production rollback command`,
      issues,
    );
    requireEvidenceText(
      text,
      'Production compose rollback completed',
      `${checkPath}.evidence must include Production compose rollback completed`,
      issues,
    );
  }

  if (checkId === 'cosign') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }
    requireEvidenceText(text, 'cosign verify', `${checkPath}.evidence must include cosign verify`, issues);
    requireEvidenceText(text, 'release-images', `${checkPath}.evidence must include release-images workflow identity`, issues);
    requireEvidenceText(
      text,
      'https://token.actions.githubusercontent.com',
      `${checkPath}.evidence must include GitHub Actions OIDC issuer`,
      issues,
    );
    for (const [, image] of images) {
      requireEvidenceText(text, image, `${checkPath}.evidence must include ${image}`, issues);
    }
  }

  if (checkId === 'digest-manifest') {
    requireEvidenceText(text, 'release-image-digests', `${checkPath}.evidence must include release-image-digests artifact`, issues);
    for (const [, image] of images) {
      requireEvidenceText(text, image, `${checkPath}.evidence must include ${image}`, issues);
    }
    if (typeof release?.imageDigestManifest?.webBuildNextPublicApiUrl === 'string') {
      requireEvidenceText(
        text,
        release.imageDigestManifest.webBuildNextPublicApiUrl,
        `${checkPath}.evidence must include release.imageDigestManifest.webBuildNextPublicApiUrl`,
        issues,
      );
    }
    if (typeof release?.imageDigestManifest?.webBuildNextPublicSupabaseUrl === 'string') {
      requireEvidenceText(
        text,
        release.imageDigestManifest.webBuildNextPublicSupabaseUrl,
        `${checkPath}.evidence must include release.imageDigestManifest.webBuildNextPublicSupabaseUrl`,
        issues,
      );
    }
  }

  if (checkId === 'release-run-api-verification') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }
    requireEvidenceText(
      text,
      `npm run check:production:release-run -- --evidence-file=${defaultEvidenceFile}`,
      `${checkPath}.evidence must include the check:production:release-run command`,
      issues,
    );
    requireEvidenceText(
      text,
      'Production release run evidence passed',
      `${checkPath}.evidence must include Production release run evidence passed`,
      issues,
    );
    if (typeof release?.workflowRunUrl === 'string') {
      requireEvidenceText(text, release.workflowRunUrl, `${checkPath}.evidence must reference release.workflowRunUrl`, issues);
    }
    for (const [, image] of images) {
      requireEvidenceText(text, image, `${checkPath}.evidence must include ${image}`, issues);
    }
    if (typeof release?.imageDigestManifest?.webBuildNextPublicApiUrl === 'string') {
      requireEvidenceText(
        text,
        release.imageDigestManifest.webBuildNextPublicApiUrl,
        `${checkPath}.evidence must include release.imageDigestManifest.webBuildNextPublicApiUrl`,
        issues,
      );
    }
    if (typeof release?.imageDigestManifest?.webBuildNextPublicSupabaseUrl === 'string') {
      requireEvidenceText(
        text,
        release.imageDigestManifest.webBuildNextPublicSupabaseUrl,
        `${checkPath}.evidence must include release.imageDigestManifest.webBuildNextPublicSupabaseUrl`,
        issues,
      );
    }
  }
}

function validateCheckSpecificEvidence(areaId, checkId, actualCheck, checkPath, issues, release) {
  validateExecutableCheckerEvidence(areaId, checkId, actualCheck, checkPath, issues);

  if (areaId === 'releaseGate') {
    validateReleaseGateEvidence(checkId, actualCheck, checkPath, release, issues);
  }

  if (areaId === 'secretsAndEnv') {
    const text = evidenceText(actualCheck.evidence);

    const secretsMarkersByCheck = {
      'real-production-values': ['.env.production', 'real production values'],
      'secret-source-excluded-from-git': ['secret store', 'excluded from git'],
      'node-env-production': ['NODE_ENV=production'],
      'jwt-secret-entropy': ['JWT_SECRET', '32 characters', 'high entropy'],
      'frontend-api-origins': ['https://app.charitypilot.ie', 'https://api.charitypilot.ie'],
      'supabase-public-origin': ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'same HTTPS Supabase project'],
      'web-compose-api-origin': ['CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_API_URL'],
      'web-compose-supabase-origin': ['CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'],
      'auth-cookie-domain': ['AUTH_COOKIE_DOMAIN=.charitypilot.ie'],
      'stripe-live-keys': ['STRIPE_SECRET_KEY', 'Stripe live mode'],
      'resend-domain': ['Resend sender domain', 'verified'],
      'supabase-service-role-secret-store': ['SUPABASE_SERVICE_ROLE_KEY', 'API secret store'],
    };

    for (const marker of secretsMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'hostingDnsTls') {
    const text = evidenceText(actualCheck.evidence);

    const hostingMarkersByCheck = {
      'web-origin': ['https://app.charitypilot.ie'],
      'api-origin': ['https://api.charitypilot.ie'],
      'dns-owner': ['DNS owner', 'approved owner'],
      'tls-certificates': ['TLS certificate', 'valid', 'https://app.charitypilot.ie', 'https://api.charitypilot.ie'],
      'cors-approved-origins': ['CORS', 'https://app.charitypilot.ie', 'only approved'],
      'security-headers': ['X-Content-Type-Options', 'X-Frame-Options', 'Content-Security-Policy', 'Strict-Transport-Security'],
    };

    for (const marker of hostingMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'database' && checkId === 'database-check') {
    if (!evidenceText(actualCheck.evidence).includes('--expect-operational-sentinel')) {
      issues.push(`${checkPath}.evidence must show check:production:database was run with --expect-operational-sentinel`);
    }
  }

  if (areaId === 'database') {
    const text = evidenceText(actualCheck.evidence);

    const databaseMarkersByCheck = {
      'postgres-provisioned': ['production PostgreSQL', 'provisioned'],
      'database-url-secret-store': ['DATABASE_URL', 'secret store'],
      'migrations-deployed': ['db:migrate:deploy', 'production'],
      'backups-enabled': ['managed backups or PITR'],
      'restore-tested': ['restore test', 'owner'],
    };

    for (const marker of databaseMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'supabaseStorage') {
    const text = evidenceText(actualCheck.evidence);

    const supabaseMarkersByCheck = {
      'separate-production-project': ['production Supabase project', 'separate'],
      'documents-bucket-exists': ['documents bucket'],
      'bucket-private': ['private bucket'],
      'readiness-storage-configured': ['storageConfigured: true'],
      'readiness-storage-reachable': ['storageBucketReachable: true'],
      'document-upload-download': ['document upload', 'signed download', 'deployed app'],
      'supabase-backups-enabled': ['Supabase backup policy', 'managed backups or PITR'],
      'supabase-restore-tested': ['Supabase restore test', 'owner'],
    };

    for (const marker of supabaseMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'billingAndEmail') {
    const text = evidenceText(actualCheck.evidence);

    if (checkId === 'stripe-products-prices') {
      const requiredMarkers = [
        'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
        'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
        'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
        'STRIPE_COMPLETE_YEARLY_PRICE_ID',
        'active live recurring Stripe prices',
      ];
      for (const marker of requiredMarkers) {
        if (!text.includes(marker)) {
          issues.push(`${checkPath}.evidence must include ${marker}`);
        }
      }
    }

    if (checkId === 'providers-check') {
      for (const marker of [
        'enabled live billing webhook endpoint',
        'required subscription events',
        'checkout.session.completed',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'verified Resend sender domain',
      ]) {
        if (!text.includes(marker)) {
          issues.push(`${checkPath}.evidence must include ${marker}`);
        }
      }
    }

    if (checkId === 'stripe-webhook-endpoint') {
      const requiredMarkers = [
        'https://api.charitypilot.ie/api/v1/billing/webhooks',
        'checkout.session.completed',
        'customer.subscription.updated',
        'customer.subscription.deleted',
      ];
      for (const marker of requiredMarkers) {
        if (!text.includes(marker)) {
          issues.push(`${checkPath}.evidence must include ${marker}`);
        }
      }
    }

    if (checkId === 'stripe-webhook-secret') {
      const requiredMarkers = [
        'STRIPE_WEBHOOK_SECRET',
        'Stripe signing secret',
        'secret store',
      ];
      for (const marker of requiredMarkers) {
        if (!text.includes(marker)) {
          issues.push(`${checkPath}.evidence must include ${marker}`);
        }
      }
    }

    if (checkId === 'resend-send') {
      const requiredMarkers = [
        'EMAIL_FROM',
        'Resend test send',
        'accepted message id',
        'production sender domain',
        'verified Resend sender domain',
      ];
      for (const marker of requiredMarkers) {
        if (!text.includes(marker)) {
          issues.push(`${checkPath}.evidence must include ${marker}`);
        }
      }
    }

    if (checkId === 'email-links-production-origin') {
      const requiredMarkers = [
        'https://app.charitypilot.ie',
        'password reset',
        'email verification',
      ];
      for (const marker of requiredMarkers) {
        if (!text.includes(marker)) {
          issues.push(`${checkPath}.evidence must include ${marker}`);
        }
      }
    }
  }

  if (areaId === 'legalAndCompliance') {
    const text = evidenceText(actualCheck.evidence);

    const legalMarkersByCheck = {
      'privacy-policy-approved': [
        'privacy policy',
        'approved for production',
        'policy version',
        'effective date',
        'privacy approver',
      ],
      'terms-approved': ['terms', 'approved for production', 'terms version', 'effective date'],
      'retention-policy-approved': [
        'data retention policy',
        'approved for production',
        'retention schedule',
        'deletion workflow',
      ],
      'support-deletion-contact': ['support contact', 'data deletion contact', 'published', 'published URL', 'support mailbox'],
      'solicitor-governance-privacy-review': [
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
      ],
    };

    for (const marker of legalMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'securityReview') {
    const text = evidenceText(actualCheck.evidence);

    const securityMarkersByCheck = {
      'penetration-test-complete': [
        'external penetration test',
        'testing provider',
        'testing scope',
        'https://app.charitypilot.ie',
        'https://api.charitypilot.ie',
        'release commit',
        'completed before real charity data',
      ],
      'critical-high-findings': [
        'critical and high findings',
        'remediated or formally accepted',
        'accountable owner',
        'finding tracker',
        'risk acceptance approver',
        'acceptance date',
      ],
      'retest-evidence': ['retest evidence', 'fixed findings', 'retest date', 'retest result'],
      'report-reference': ['penetration test report', 'report reference', 'stored outside git', 'report version', 'report date'],
    };

    for (const marker of securityMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'jobs' && checkId === 'scheduler-command') {
    const text = evidenceText(actualCheck.evidence);
    const requiredJobCommands = [
      'dist/jobs/production-scheduler.js',
      'dist/jobs/send-deadline-reminders.js',
      'dist/jobs/cleanup-document-storage.js',
    ];
    for (const command of requiredJobCommands) {
      if (!text.includes(command)) {
        issues.push(`${checkPath}.evidence must include ${command}`);
      }
    }
  }

  if (areaId === 'jobs' && checkId === 'scheduler-owned') {
    const text = evidenceText(actualCheck.evidence);
    for (const marker of ['production-scheduler', 'owner']) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'jobs' && checkId === 'scheduler-secret-source') {
    const text = evidenceText(actualCheck.evidence);
    for (const marker of ['same production secret source', '.env.production']) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'jobs' && checkId === 'scheduler-logs-alerts') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }

    const text = evidenceText(actualCheck.evidence);
    const requiredFailureAlerts = [
      'scheduler logs',
      'deadline-reminders failure alert',
      'document-storage-cleanup failure alert',
    ];
    for (const alertEvidence of requiredFailureAlerts) {
      if (!text.includes(alertEvidence)) {
        issues.push(`${checkPath}.evidence must include ${alertEvidence} evidence`);
      }
    }
  }

  if (areaId === 'observability') {
    const text = evidenceText(actualCheck.evidence);

    const observabilityMarkersByCheck = {
      'api-logs': ['API logs', 'captured', 'log sink', 'retention'],
      'web-logs': ['web logs', 'captured', 'platform events', 'retention'],
      'error-alert-tested': [
        'error alert',
        'tested',
        'Production observability check passed',
        'sanitized test alert',
        'incident system confirmation',
      ],
      'uptime-health': ['/api/v1/health', 'uptime monitoring', 'monitor owner', 'alert route'],
      'internal-readiness-monitoring': [
        '/api/v1/health/readiness',
        'x-charitypilot-readiness-key',
        'readiness monitor owner',
        'secret store',
      ],
      'incident-owner': ['incident owner', 'escalation path', 'outside git', 'primary incident owner', 'backup owner'],
    };

    for (const marker of observabilityMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'browserQa' && checkId === 'browser-qa-completed') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }

    const text = evidenceText(actualCheck.evidence);
    const requiredMarkers = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'E2E_OWNER_EMAIL',
      'E2E_OWNER_PASSWORD',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
    requireResponsiveCommandEvidence(text, checkPath, issues);
  }

  if (areaId === 'browserQa' && checkId === 'desktop-coverage') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }

    const text = evidenceText(actualCheck.evidence);
    const requiredMarkers = [
      'E2E_DEPLOYED_QA=true',
      'desktop light and dark',
      'https://app.charitypilot.ie',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
    requireResponsiveCommandEvidence(text, checkPath, issues, 'desktop');
  }

  if (areaId === 'browserQa' && checkId === 'mobile-coverage') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }

    const text = evidenceText(actualCheck.evidence);
    const requiredMarkers = [
      'E2E_DEPLOYED_QA=true',
      'mobile light and dark',
      'https://app.charitypilot.ie',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
    requireResponsiveCommandEvidence(text, checkPath, issues, 'mobile');
  }

  if (areaId === 'browserQa' && checkId === 'accessibility-coverage') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }

    const text = evidenceText(actualCheck.evidence);
    const requiredMarkers = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'E2E_OWNER_EMAIL',
      'E2E_OWNER_PASSWORD',
      'npm run test:e2e -- tests/accessibility.spec.ts',
      'accessibility.spec.ts',
      'light and dark',
      'https://app.charitypilot.ie',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'browserQa' && checkId === 'cross-browser-coverage') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }

    const text = evidenceText(actualCheck.evidence);
    const requiredMarkers = [
      'E2E_DEPLOYED_QA=true',
      'test:e2e:deployed:responsive:cross-browser',
      'test:e2e:deployed:accessibility:cross-browser',
      'deployed-chromium-desktop',
      'deployed-chromium-mobile',
      'deployed-firefox-desktop',
      'deployed-webkit-desktop',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'browserQa' && checkId === 'ios-safari-device-coverage') {
    const text = evidenceText(actualCheck.evidence);
    const requiredMarkers = [
      'real iOS Safari',
      'manual or cloud-device evidence',
      'https://app.charitypilot.ie',
      'mobile light and dark',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'browserQa' && checkId === 'critical-flows-covered') {
    if (!hasEvidenceType(actualCheck, 'command-output')) {
      issues.push(`${checkPath}.evidence must include command-output evidence`);
    }

    const text = evidenceText(actualCheck.evidence);
    const requiredMarkers = [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'E2E_OWNER_EMAIL',
      'E2E_OWNER_PASSWORD',
      'docs/production-browser-qa.md',
      'auth flow',
      'dashboard flow',
      'billing flow',
      'document upload',
      'signed download',
      'logout',
      'error states',
      'zero critical or high-severity browser QA defects',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }
}

function validateFinalSignoffApprovals(finalSignoff, preparedAt, issues) {
  if (!isPlainObject(finalSignoff.approvals)) {
    issues.push('finalSignoff.approvals is required');
    return;
  }

  for (const role of FINAL_SIGNOFF_ROLES) {
    const approvalPath = `finalSignoff.approvals.${role.id}`;
    const approval = finalSignoff.approvals[role.id];
    if (!isPlainObject(approval)) {
      issues.push(`${approvalPath} is required`);
      continue;
    }

    if (approval.status !== 'approved') {
      issues.push(`${approvalPath}.status must be approved`);
    }
    if (typeof approval.owner !== 'string' || approval.owner.trim().length < 3) {
      issues.push(`${approvalPath}.owner is required`);
    }
    const approvedAt = isoTimestamp(approval.approvedAt);
    if (approvedAt === null) {
      issues.push(`${approvalPath}.approvedAt must be an ISO timestamp`);
    } else if (preparedAt !== null && approvedAt < preparedAt) {
      issues.push(`${approvalPath}.approvedAt must not be before preparedAt`);
    }
    validateEvidenceEntries(approval.evidence, `${approvalPath}.evidence`, issues, {
      notAfter: approvedAt,
      notAfterLabel: `${approvalPath}.approvedAt`,
    });

    const approvalEvidenceText = evidenceText(approval.evidence).toLowerCase();
    const requiredRoleMarker = role.label.toLowerCase();
    if (!approvalEvidenceText.includes(requiredRoleMarker)) {
      issues.push(`${approvalPath}.evidence must include ${role.label}`);
    }
    if (!approvalEvidenceText.includes('launch approval')) {
      issues.push(`${approvalPath}.evidence must include launch approval`);
    }
  }
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
      validateCheckSpecificEvidence(area.id, check.id, actualCheck, checkPath, issues, evidence.release);
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
    validateFinalSignoffApprovals(evidence.finalSignoff, preparedAt, issues);
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
    evidence = JSON.parse(decodeJsonFile(evidencePath));
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
