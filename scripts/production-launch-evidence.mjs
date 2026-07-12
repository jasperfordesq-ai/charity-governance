#!/usr/bin/env node

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evidenceHints as defaultEvidenceHints } from './generate-production-launch-evidence-template.mjs';

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
      ['github-environment', 'GitHub production environment variables verified before release image promotion'],
      ['github-secret-store', 'GitHub production secret names, including AUTH_RECOVERY_SECRET, verified without reading values'],
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
      ['jwt-secret-entropy', 'JWT_SECRET and the independent AUTH_RECOVERY_SECRET have production entropy'],
      ['auth-recovery-secret-rotation-rehearsal', 'auth recovery secret rotation was rehearsed end to end on an isolated recent restore'],
      ['frontend-api-origins', 'frontend and API origins are HTTPS'],
      ['supabase-api-only', 'Supabase URL, service role, and bucket are available only to API/server runtimes'],
      ['web-compose-api-origin', 'web Compose API origin matches API URL'],
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
    label: 'Document Object Storage (Supabase)',
    checks: [
      ['separate-production-project', 'production Supabase project is separate'],
      ['documents-bucket-exists', 'documents bucket exists or configured bucket is approved'],
      ['bucket-private', 'bucket is private'],
      ['supabase-check', 'production Supabase storage checker completed'],
      ['readiness-storage-configured', 'readiness reports storageConfigured true'],
      ['readiness-storage-reachable', 'readiness reports storageBucketReachable true'],
      ['document-upload-download', 'document upload and authenticated API byte download verified through deployed app'],
      ['supabase-backups-enabled', 'encrypted and versioned document-object-byte backup is separate from PostgreSQL and has owned recovery objectives'],
      ['supabase-restore-tested', 'isolated joint PostgreSQL-metadata and document-object restore is checksum reconciled'],
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
      ['auth-email-delivery-runtime', 'authentication email delivery worker runtime and isolated rehearsal are verified'],
      ['auth-delivery-anomaly-alert', 'authentication delivery anomaly alert claim, retry, acknowledgement, and incident routing are rehearsed'],
    ],
  },
  {
    id: 'billingAndEmail',
    label: 'Billing And Email',
    checks: [
      ['stripe-products-prices', 'Stripe live products and prices match expected IDs'],
      ['stripe-webhook-endpoint', 'Stripe webhook points to deployed API endpoint'],
      ['stripe-webhook-secret', 'Stripe webhook signing secret matches secret store value'],
      ['password-recovery-resend-delivery', 'deployed Resend recovery-link and post-reset notice delivery are independently proven'],
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

const sha256DigestPattern = /^[a-f0-9]{64}$/;
const jointRecoveryManifestFormat = 'charitypilot-document-recovery-manifest-v1';
const jointRecoveryTargetType = 'isolated-non-production';
const jointRecoveryVerifierBaseCommand =
  'npm run check:production:document-recovery -- --manifest-file=.charitypilot-launch-evidence/document-recovery-manifest.json';
const jointRecoveryVerifierCommandPrefix = 'npm run check:production:document-recovery --';
const jointRecoveryConsistencySuccessText =
  'Document recovery reconciliation consistency passed against independently supplied bindings.';
const jointRecoveryProvenanceLimitation =
  'Caller-supplied binding equality proves offline consistency only; it does not authenticate the source exports, source-capture report, provider, or operator provenance.';
const recoverySetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const postgresTransactionIdPattern = /^[1-9]\d{0,18}$/;
const maximumPostgresTransactionId = 9_223_372_036_854_775_807n;
const maximumDocumentProofAgeMinutes = 24 * 60;
const jointRecoveryDigestFields = [
  'recoveryManifestSha256',
  'sourceBindingSha256',
  'sourceCaptureReportSha256',
  'sourceDatabaseIdentitySha256',
  'sourceObjectStoreIdentitySha256',
  'databaseDumpSha256',
  'objectBackupManifestSha256',
  'sourceMetadataInventorySha256',
  'restoredMetadataInventorySha256',
  'sourceObjectInventorySha256',
  'restoredObjectInventorySha256',
  'sourceStorageDeletionInventorySha256',
  'restoredStorageDeletionInventorySha256',
  'sourceRecoveryEventInventorySha256',
  'restoredRecoveryEventInventorySha256',
  'reconciliationReportSha256',
];
const jointRecoveryCountFields = [
  'metadataRowCount',
  'expectedObjectCount',
  'restoredObjectCount',
  'matchedObjectCount',
  'missingObjectCount',
  'unexpectedObjectCount',
  'orphanExpectedObjectCount',
  'orphanRestoredObjectCount',
  'checksumMismatchCount',
  'expectedBytes',
  'restoredBytes',
  'storageDeletionCount',
  'pendingStorageDeletionCount',
  'deadLetterStorageDeletionCount',
  'processedStorageDeletionCount',
  'restoredStorageDeletionCount',
  'restoredPendingStorageDeletionCount',
  'restoredDeadLetterStorageDeletionCount',
  'restoredProcessedStorageDeletionCount',
  'recoveryEventCount',
  'restoredRecoveryEventCount',
  'processedDeletionObjectResidueCount',
];
const jointRecoveryTimestampFields = [
  'sourceMetadataCapturedAt',
  'restoredMetadataCapturedAt',
  'sourceObjectInventoryCapturedAt',
  'restoredObjectInventoryCapturedAt',
  'documentProofOldestCapturedAt',
  'documentProofFreshThroughAt',
  'reconciledAt',
];
const jointRecoveryVerifierPayloadFields = [
  'manifestFormat',
  'checksumAlgorithm',
  ...jointRecoveryDigestFields,
  'exerciseId',
  'recoverySetId',
  ...jointRecoveryCountFields,
  'sourceMetadataCapturedAt',
  'restoredMetadataCapturedAt',
  'sourceObjectInventoryCapturedAt',
  'restoredObjectInventoryCapturedAt',
  'sourceMetadataCaptureTransactionId',
  'restoredMetadataCaptureTransactionId',
  'documentProofOldestCapturedAt',
  'documentProofAgeMinutes',
  'maximumDocumentProofAgeMinutes',
  'documentProofFreshThroughAt',
  'documentProofFresh',
  'restoreTargetType',
  'isolationAttestationRecorded',
  'productionDatabaseNotOverwrittenAttestationRecorded',
  'productionObjectStoreNotOverwrittenAttestationRecorded',
  'restoreCredentialsScopedToTargetAttestationRecorded',
  'objectives',
  'reconciledAt',
  'ownerRecorded',
  'recoveryOperatorRecorded',
  'notesRecorded',
  'externalEvidenceReferencesRecorded',
  'independentBindingArgumentsMatched',
  'sourceProvenanceExternallyVerified',
  'provenanceLimitation',
  'secretValuesPrinted',
];
const databaseIdentityCaptureCommand =
  'npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json';
const databaseRestoreProofBaseCommand =
  'npm run check:production:database -- --production-env-file=.env.production';
const databaseCheckerCommandPrefix = 'npm run check:production:database --';
const databaseRestoreProofFormat = 'snapshot-bound-read-only-source-restored-sha256-reconciliation';
const databaseSourceIdentityEvidenceFormat = 'charitypilot-postgres-source-identity/v2';
const databaseRestoreReportFormat = 'charitypilot-postgres-restore-proof/v2';
const databaseHelperImplementationFormat = 'charitypilot-postgres-proof-helper/v1';
const databaseHelperRepositoryUrl = 'https://github.com/jasperfordesq-ai/charity-governance';
const databaseHelperSourcePath = 'scripts/postgres-backup.mjs';
const approvedDatabaseToolsImageReference =
  'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const approvedDatabaseToolsImageDigestSha256 =
  '5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const databaseSourceIdentityProvenanceLimitation =
  'The identity digest proves consistency with the supplied source endpoint and read-only server metadata; independent immutable capture and operator control remain external evidence.';
const databaseRestoreProofProvenanceLimitation =
  'This proof verifies a read-only source snapshot against one isolated restore. PostgreSQL ownership and ACL privileges are intentionally excluded by --no-owner and --no-privileges, sequence runtime state is excluded, and provider retention, immutable external custody, document-object recovery, and operator approval remain separate evidence.';
const databaseSequenceStateExclusionReason =
  'PostgreSQL sequence values are non-MVCC and cannot be bound to the exported snapshot; this proof therefore fails unless the public schema has zero sequences, identity columns, and nextval defaults.';
const databaseOwnershipExclusionReason =
  'The custom-format dump is captured and restored with --no-owner, so PostgreSQL object ownership is outside this proof.';
const databaseAclPrivilegesExclusionReason =
  'The custom-format dump is captured and restored with --no-privileges, so PostgreSQL ACL grants and default privileges are outside this proof.';
const databaseRestoreWorkloadSafety = Object.freeze({
  tempFileLimitBytes: '1073741824',
  maxPublicTables: 5000,
  maxRowsPerTable: 25000000,
  maxTotalRows: 100000000,
  maxFingerprintReportBytes: 16777216,
  maxDumpBytes: '68719476736',
  statementTimeoutMs: 1800000,
  lockTimeoutMs: 30000,
  idleTransactionTimeoutMs: 2640000,
});
const databaseSchemaCertificationScope = Object.freeze({
  certifiedSchemas: ['public'],
  certifiedDataClasses: ['ordinary-table-rows', 'partitioned-table-own-rows', 'materialized-view-rows'],
  certifiedObjectClasses: [
    'relations', 'columns', 'constraints', 'indexes', 'triggers', 'row-security-policies',
    'routines-and-bodies', 'types-domains-enums-and-ranges',
    'sequence-definitions-and-owned-by-relations', 'extended-statistics', 'user-rules',
  ],
  publicSchemaOnly: true,
  nonPublicSchemasIncluded: false,
  largeObjectsIncluded: false,
  largeObjectCount: 0,
  extensionMembershipIncluded: false,
  commentsIncluded: false,
  securityLabelsIncluded: false,
  databaseLevelObjectsIncluded: false,
  exclusions: [
    { scope: 'non-public-schemas', reason: 'Only objects in the public schema are fingerprinted and compared.' },
    { scope: 'large-objects', reason: 'PostgreSQL large objects are excluded and proof fails unless the source and restore contain zero large objects.' },
    { scope: 'extension-membership', reason: 'Extension installation and membership metadata are excluded; supported extension-owned objects in public are fingerprinted by object definition.' },
    { scope: 'comments-and-security-labels', reason: 'Comments and security labels are not recovery-critical application integrity data and are excluded.' },
    { scope: 'database-level-objects', reason: 'Roles, tablespaces, database settings, foreign-data wrappers and servers, publications, subscriptions, and event triggers are excluded.' },
  ],
});
const databaseRestoreProofMaximumAgeMs = 24 * 60 * 60 * 1000;
const databaseCapacityPreflightMethod = 'pg-database-size-factor-margin/v1';
const databaseCapacitySafetyFactor = 2;
const databaseCapacitySafetyMarginBytes = '1073741824';
const databaseRestoreDigestFields = [
  'expectedSourceDatabaseIdentitySha256',
  'sourceDatabaseIdentitySha256',
  'databaseDumpSha256',
  'dumpDescriptorSha256',
  'dumpSourceBindingSha256',
  'proofReportSha256',
  'sourceDatabaseFingerprintSha256',
  'restoredDatabaseFingerprintSha256',
  'publicSchemaSha256',
  'tableMembershipSha256',
  'snapshotIdSha256',
  'isolatedRestoreDatabaseIdentitySha256',
];
const databaseRestoreEnvironmentFields = [
  'sourceDatabaseEnvironment',
  'restoredDatabaseEnvironment',
  'restoreTargetDatabaseEnvironment',
  'restoreInitializedFromSourceDatabaseEnvironment',
  'databaseEnvironmentPreserved',
  'databaseEnvironmentMatched',
];

const placeholderOrLocalPattern = /\b(todo|tbd|pending(?!-navigation confirmation|-storage-deletion-count)|open|example(?:\.com|\.org|\.net)?|localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b|project_ref|change-me|your_|your-|file:\/\//i;
const sampleSupabaseProjectRefPattern = /https:\/\/(?:configured-project|example|ci-project|test-project|demo-project|sample-project)\.supabase\.co\b/i;
const directRawSecretPattern = /(?:sk_live_[A-Za-z0-9_=-]{8,}|whsec_[A-Za-z0-9_=-]{8,}|re_[A-Za-z0-9_=-]{8,}|gh[pousr]_[A-Za-z0-9_=-]{8,}|github_pat_[A-Za-z0-9_=-]{8,}|eyJ[A-Za-z0-9_-]{20,}|(?:postgres(?:ql)?|https?):\/\/[^\s/@:]+:[^\s/@]+@|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|Basic\s+[A-Za-z0-9+/]{8,}={0,2}|-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----)/i;
const sensitiveAssignmentPattern = /\b(?:DATABASE_URL|JWT_SECRET|AUTH_RECOVERY_SECRET|READINESS_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_BILLING_PORTAL_CONFIGURATION_ID|RESEND_API_KEY|SUPABASE_SERVICE_ROLE_KEY|ERROR_ALERT_WEBHOOK_URL|GITHUB_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|TOKEN|KEY|APIKEY|API_KEY|PRIVATE_KEY|CLIENT_SECRET|AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY|SERVICE[_-]?ROLE[_-]?KEY)\s*[:=]\s*["']?([^\s"',;}]+)/i;
const approvedEvidenceReferenceHosts = ['charitypilot.ie', 'github.com'];
const sensitiveEvidenceReferenceQueryKeys = new Set([
  'access_token',
  'apikey',
  'jwt',
  'key',
  'refresh_token',
  'secret',
  'signature',
  'sig',
  'token',
  'x-amz-credential',
  'x-amz-signature',
  'x-goog-signature',
]);
const imageRepositories = {
  apiImage: 'ghcr.io/jasperfordesq-ai/charity-governance-api',
  webImage: 'ghcr.io/jasperfordesq-ai/charity-governance-web',
  migrationImage: 'ghcr.io/jasperfordesq-ai/charity-governance-migrations',
};
const releaseWorkflowFile = '.github/workflows/release-images.yml';
const defaultEvidenceFile = '.charitypilot-launch-evidence/production-launch-evidence.json';
const maximumLaunchEvidenceFileBytes = 8 * 1024 * 1024;
const maximumLaunchEvidenceJsonDepth = 64;
const maximumLaunchEvidenceNodeCount = 100_000;
const maximumLaunchEvidenceStringBytes = maximumLaunchEvidenceFileBytes;
export const FINAL_SIGNOFF_ROLES = [
  ['engineering', 'Engineering owner'],
  ['operations', 'Operations owner'],
  ['security', 'Security owner'],
  ['legalCompliance', 'Legal/compliance owner'],
  ['business', 'Business owner'],
].map(([id, label]) => ({ id, label }));

const BROWSER_QA_RELEASE_BOUND_CHECKS = new Set([
  'browser-qa-completed',
  'desktop-coverage',
  'mobile-coverage',
  'accessibility-coverage',
  'cross-browser-coverage',
  'ios-safari-device-coverage',
  'critical-flows-covered',
]);

export const LAUNCH_CRITICAL_ROUTES = [
  '/',
  '/about',
  '/features',
  '/pricing',
  '/blog',
  '/blog/understanding-the-charities-governance-code',
  '/privacy',
  '/terms',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/accept-invite',
  '/dashboard',
  '/compliance',
  '/compliance/${principleId}',
  '/documents',
  '/deadlines',
  '/board',
  '/registers',
  '/regulator',
  '/organisation',
  '/team',
  '/billing',
  '/export',
];

function usage() {
  return 'Usage: node scripts/production-launch-evidence.mjs --evidence-file <path>\n';
}

function parseArgs(argv) {
  const options = {
    evidenceFile: defaultEvidenceFile,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--evidence-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence-file requires a value');
      options.evidenceFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--evidence-file=')) {
      const value = arg.slice('--evidence-file='.length);
      if (!value) throw new Error('--evidence-file requires a value');
      options.evidenceFile = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

export class LaunchEvidenceInputError extends Error {}

function stableFileIdentity(status) {
  return {
    dev: String(status.dev),
    ino: String(status.ino),
    size: String(status.size),
    mode: String(status.mode),
    mtimeNs: String(status.mtimeNs ?? BigInt(Math.trunc(Number(status.mtimeMs) * 1_000_000))),
    ctimeNs: String(status.ctimeNs ?? BigInt(Math.trunc(Number(status.ctimeMs) * 1_000_000))),
  };
}

function stableFileIdentitiesMatch(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function decodeLaunchEvidenceBytes(bytes) {
  let encoding = 'utf-8';
  let content = bytes;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    content = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    content = bytes.subarray(2);
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    content = bytes.subarray(3);
  }
  if (encoding.startsWith('utf-16') && content.length % 2 !== 0) {
    throw new LaunchEvidenceInputError('evidence file contains invalid Unicode encoding');
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(content);
  } catch {
    throw new LaunchEvidenceInputError('evidence file contains invalid Unicode encoding');
  }
}

function assertSafeJsonTextStructure(text) {
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      let closed = false;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === '\\') {
          index += 1;
          continue;
        }
        if (text[index] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new LaunchEvidenceInputError('evidence file is not valid JSON');
      const token = text.slice(start, index + 1);
      let decoded;
      try {
        decoded = JSON.parse(token);
      } catch {
        throw new LaunchEvidenceInputError('evidence file is not valid JSON');
      }
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? '')) lookahead += 1;
      const frame = stack.at(-1);
      if (text[lookahead] === ':' && frame?.type === 'object') {
        if (frame.keys.has(decoded)) {
          throw new LaunchEvidenceInputError('evidence file contains duplicate JSON object keys');
        }
        frame.keys.add(decoded);
      }
      continue;
    }
    if (character === '{' || character === '[') {
      if (stack.length >= maximumLaunchEvidenceJsonDepth) {
        throw new LaunchEvidenceInputError('evidence file exceeds the maximum JSON nesting depth');
      }
      stack.push(character === '{' ? { type: 'object', keys: new Set() } : { type: 'array' });
      continue;
    }
    if (character === '}' || character === ']') {
      const frame = stack.pop();
      if (!frame || (character === '}' && frame.type !== 'object') || (character === ']' && frame.type !== 'array')) {
        throw new LaunchEvidenceInputError('evidence file is not valid JSON');
      }
    }
  }
  if (stack.length !== 0) throw new LaunchEvidenceInputError('evidence file is not valid JSON');
}

export function readStableLaunchEvidenceFile(
  path,
  {
    lstat = lstatSync,
    open = openSync,
    fstat = fstatSync,
    read = readSync,
    close = closeSync,
  } = {},
) {
  const before = lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new LaunchEvidenceInputError('evidence file must be a regular non-symbolic-link file');
  }
  if (before.size > BigInt(maximumLaunchEvidenceFileBytes)) {
    throw new LaunchEvidenceInputError('evidence file exceeds the bounded input safety limit');
  }
  const beforeIdentity = stableFileIdentity(before);
  const descriptor = open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstat(descriptor, { bigint: true });
    const openedIdentity = stableFileIdentity(opened);
    if (!opened.isFile() || !stableFileIdentitiesMatch(beforeIdentity, openedIdentity)) {
      throw new LaunchEvidenceInputError('evidence file changed while its stable descriptor was opened');
    }
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size > maximumLaunchEvidenceFileBytes) {
      throw new LaunchEvidenceInputError('evidence file exceeds the bounded input safety limit');
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = read(descriptor, bytes, offset, size - offset, offset);
      if (bytesRead <= 0) {
        throw new LaunchEvidenceInputError('evidence file changed while it was being read');
      }
      offset += bytesRead;
    }
    const afterDescriptor = fstat(descriptor, { bigint: true });
    const afterPath = lstat(path, { bigint: true });
    if (!afterPath.isFile() || afterPath.isSymbolicLink() ||
      !stableFileIdentitiesMatch(openedIdentity, stableFileIdentity(afterDescriptor)) ||
      !stableFileIdentitiesMatch(openedIdentity, stableFileIdentity(afterPath))) {
      throw new LaunchEvidenceInputError('evidence file changed while it was being read');
    }
    const text = decodeLaunchEvidenceBytes(bytes);
    assertSafeJsonTextStructure(text);
    try {
      return JSON.parse(text);
    } catch {
      throw new LaunchEvidenceInputError('evidence file is not valid JSON');
    }
  } finally {
    close(descriptor);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isExplicitlyRedactedSecret(value) {
  return /^(?:\[redacted\]|<redacted>|redacted|not[-_ ]read)$/i.test(value);
}

function containsRawSecretText(value) {
  if (typeof value !== 'string') return false;
  if (directRawSecretPattern.test(value)) return true;
  const assignment = sensitiveAssignmentPattern.exec(value);
  return Boolean(assignment && !isExplicitlyRedactedSecret(assignment[1]));
}

function isSensitiveLedgerKey(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const last = words.at(-1);
  if (['password', 'passwd', 'token', 'secret'].includes(last)) return true;
  if (words.length >= 2 && ['api', 'private'].includes(words.at(-2)) && last === 'key') return true;
  if (
    last === 'key' &&
    (words.includes('secret') || words.includes('access') || (words.includes('service') && words.includes('role')))
  ) return true;
  return [
    'databaseurl', 'jwtsecret', 'readinessapikey', 'stripesecretkey',
    'stripewebhooksecret', 'resendapikey', 'supabaseservicerolekey',
    'erroralertwebhookurl', 'githubtoken',
  ].includes(words.join(''));
}

function safeLedgerPath(path, key) {
  if (containsRawSecretText(key) || String(key).length > 128) return `${path}.[unsafe-key]`;
  return path ? `${path}.${key}` : String(key);
}

function validateWholeLedgerSafety(evidence, issues) {
  const stack = [{ value: evidence, path: '', depth: 1 }];
  const seen = new WeakSet();
  let nodeCount = 0;
  let stringBytes = 0;
  let structurallySafe = true;
  const inspectString = (value, path, { sensitiveKey = false } = {}) => {
    stringBytes += Buffer.byteLength(value, 'utf8');
    if (stringBytes > maximumLaunchEvidenceStringBytes) {
      issues.push('evidence ledger exceeds the aggregate string safety limit');
      structurallySafe = false;
      return;
    }
    if (containsRawSecretText(value) || (sensitiveKey && !isExplicitlyRedactedSecret(value))) {
      issues.push(`${path || 'evidence'} must not contain raw secret-looking values`);
    }
  };

  while (stack.length > 0 && structurallySafe) {
    const entry = stack.pop();
    nodeCount += 1;
    if (nodeCount > maximumLaunchEvidenceNodeCount) {
      issues.push('evidence ledger exceeds the JSON node safety limit');
      structurallySafe = false;
      break;
    }
    if (entry.depth > maximumLaunchEvidenceJsonDepth) {
      issues.push('evidence ledger exceeds the maximum JSON nesting depth');
      structurallySafe = false;
      break;
    }
    const value = entry.value;
    if (typeof value === 'string') {
      inspectString(value, entry.path);
      continue;
    }
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        issues.push(`${entry.path || 'evidence'} must contain only JSON-compatible finite numbers`);
        structurallySafe = false;
      }
      continue;
    }
    if (typeof value !== 'object') {
      issues.push(`${entry.path || 'evidence'} must contain only JSON-compatible values`);
      structurallySafe = false;
      continue;
    }
    if (seen.has(value)) {
      issues.push(`${entry.path || 'evidence'} must be an acyclic JSON tree`);
      structurallySafe = false;
      continue;
    }
    seen.add(value);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      issues.push(`${entry.path || 'evidence'} must contain only plain JSON objects`);
      structurallySafe = false;
      continue;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (Array.isArray(value) && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) {
      issues.push(`${entry.path || 'evidence'} must not contain sparse or extended arrays`);
      structurallySafe = false;
      continue;
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const childPath = Array.isArray(value) ? `${entry.path}[${key}]` : safeLedgerPath(entry.path, key);
      inspectString(key, `${childPath} key`);
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        issues.push(`${childPath} must be a data property`);
        structurallySafe = false;
        break;
      }
      const child = descriptor.value;
      if (typeof child === 'string') {
        inspectString(child, childPath, { sensitiveKey: !Array.isArray(value) && isSensitiveLedgerKey(key) });
      } else {
        stack.push({ value: child, path: childPath, depth: entry.depth + 1 });
      }
    }
  }
  return structurallySafe;
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
  if (sampleSupabaseProjectRefPattern.test(trimmed)) {
    issues.push(`${path} must not use a sample Supabase project ref`);
  }
  if (containsRawSecretText(trimmed)) {
    issues.push(`${path} must not contain raw secret-looking values`);
  }
  if (/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('https://')) {
    issues.push(`${path} must be an https URL when a URL is provided`);
  }
}

function validateEvidenceReference(value, path, issues) {
  validateExternalText(value, path, issues);

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const approvedHost = approvedEvidenceReferenceHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    if (url.protocol !== 'https:' || !approvedHost) {
      issues.push(`${path} must be an https URL on an approved evidence host`);
    }
    if (hostname === 'github.com' && !url.pathname.startsWith('/jasperfordesq-ai/charity-governance/')) {
      issues.push(`${path} must use the canonical charity-governance GitHub repository when github.com is used`);
    }
    for (const key of url.searchParams.keys()) {
      const normalisedKey = key.toLowerCase();
      if (sensitiveEvidenceReferenceQueryKeys.has(normalisedKey) || /(?:token|secret|signature)/.test(normalisedKey)) {
        issues.push(`${path} must not contain token-bearing query parameters`);
        break;
      }
    }
  } catch {
    issues.push(`${path} must be a valid external evidence URL`);
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
    validateEvidenceReference(entry.reference, `${entryPath}.reference`, issues);
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

function requireDistinctCommandOutputEvidence(
  actualCheck,
  identityNeedles,
  label,
  requiredMarkers,
  checkPath,
  issues,
) {
  const matchingEntry = Array.isArray(actualCheck.evidence)
    ? actualCheck.evidence.find((entry) => {
        if (entry?.type !== 'command-output') return false;
        const text = evidenceText([entry]);
        return identityNeedles.every((needle) => text.includes(needle));
      })
    : null;
  if (!matchingEntry) {
    issues.push(`${checkPath}.evidence must include separate command-output evidence for ${label}`);
    return null;
  }

  const text = evidenceText([matchingEntry]);
  for (const marker of requiredMarkers) {
    requireEvidenceText(
      text,
      marker,
      `${checkPath}.evidence ${label} transcript must include ${marker}`,
      issues,
    );
  }
  return matchingEntry;
}

function requireDistinctEvidenceEntry(
  actualCheck,
  identityNeedles,
  label,
  requiredMarkers,
  checkPath,
  issues,
) {
  const matchingEntry = Array.isArray(actualCheck.evidence)
    ? actualCheck.evidence.find((entry) => {
        const text = evidenceText([entry]);
        return identityNeedles.every((needle) => text.includes(needle));
      })
    : null;
  if (!matchingEntry) {
    issues.push(`${checkPath}.evidence must include separate evidence for ${label}`);
    return null;
  }

  const text = evidenceText([matchingEntry]);
  for (const marker of requiredMarkers) {
    requireEvidenceText(
      text,
      marker,
      `${checkPath}.evidence ${label} entry must include ${marker}`,
      issues,
    );
  }
  return matchingEntry;
}

function validateSha256Digest(value, path, issues) {
  if (typeof value !== 'string' || !sha256DigestPattern.test(value)) {
    issues.push(`${path} must be a 64 character lowercase SHA-256 digest`);
    return false;
  }
  return true;
}

function validateJointRecoveryObjective(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(`${path} is required`);
    return;
  }

  const keys = [
    'rpoObjectiveMinutes',
    'achievedRpoMinutes',
    'rtoObjectiveMinutes',
    'achievedRtoMinutes',
    'met',
  ];
  if (!hasExactObjectKeys(value, keys)) {
    issues.push(`${path} must contain exactly the verifier objective fields`);
  }

  for (const field of ['rpoObjectiveMinutes', 'rtoObjectiveMinutes']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1) {
      issues.push(`${path}.${field} must be a positive safe integer`);
    }
  }
  for (const field of ['achievedRpoMinutes', 'achievedRtoMinutes']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      issues.push(`${path}.${field} must be a non-negative safe integer`);
    }
  }
  if (value.met !== true) {
    issues.push(`${path}.met must be true`);
  }
}

function requireJsonEvidenceBinding(text, field, value, checkPath, issues) {
  const pattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*${escapeRegExp(JSON.stringify(value))}`);
  if (!pattern.test(text)) {
    issues.push(`${checkPath}.evidence must bind verifier JSON field ${field}`);
  }
}

function embeddedVerifierJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const embeddedText = text.slice(start, end + 1);
    assertSafeJsonTextStructure(embeddedText);
    const value = JSON.parse(embeddedText);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function hasWhitespaceDelimitedToken(text, token) {
  return new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?=\\s|$)`).test(text);
}

function validateCanonicalCommandOptions(text, commandPrefix, optionKinds, checkPath, label, issues) {
  const trimmed = typeof text === 'string' ? text.trimStart() : '';
  if (!trimmed.startsWith(`${commandPrefix} `)) {
    issues.push(`${checkPath}.evidence ${label} must begin with the exact checker command`);
    return;
  }

  const tokens = trimmed.slice(commandPrefix.length).trimStart().split(/\s+/);
  const optionTokens = [];
  for (const token of tokens) {
    if (!token.startsWith('--')) break;
    optionTokens.push(token);
  }

  const counts = new Map();
  for (const token of optionTokens) {
    const equalsIndex = token.indexOf('=');
    const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const kind = optionKinds.get(flag);
    if (!kind) {
      issues.push(`${checkPath}.evidence ${label} contains unsupported option ${flag}`);
      continue;
    }
    counts.set(flag, (counts.get(flag) ?? 0) + 1);
    if (kind === 'value' && (equalsIndex === -1 || equalsIndex === token.length - 1)) {
      issues.push(`${checkPath}.evidence ${label} must use one non-empty canonical ${flag}=value option`);
    }
    if (kind === 'boolean' && equalsIndex !== -1) {
      issues.push(`${checkPath}.evidence ${label} must use ${flag} as a boolean option`);
    }
  }

  for (const flag of optionKinds.keys()) {
    if ((counts.get(flag) ?? 0) !== 1) {
      issues.push(`${checkPath}.evidence ${label} must include ${flag} exactly once`);
    }
  }
}

function hasExactObjectKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === keys.length && keys.slice().sort().every((key, index) => key === actualKeys[index]);
}

function isValidDatabaseEnvironment(value) {
  if (!hasExactObjectKeys(value, ['encoding', 'collation', 'ctype', 'localeProvider', 'collationVersion'])) {
    return false;
  }
  if (!/^[A-Z0-9_]{1,32}$/.test(value.encoding ?? '') || value.localeProvider !== 'libc') {
    return false;
  }
  for (const locale of [value.collation, value.ctype]) {
    if (typeof locale !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(locale)) {
      return false;
    }
  }
  return value.collationVersion === null || (
    typeof value.collationVersion === 'string' &&
    value.collationVersion.length > 0 &&
    Buffer.byteLength(value.collationVersion, 'utf8') <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value.collationVersion)
  );
}

function validateDatabaseRestoreProof(actualCheck, checkPath, issues, finalApprovedAt, validationNow, release) {
  const path = `${checkPath}.databaseRestoreProof`;
  const proof = actualCheck.databaseRestoreProof;
  const allEvidenceText = evidenceText(actualCheck.evidence);
  if (/sentinel/i.test(allEvidenceText)) {
    issues.push(`${checkPath}.evidence must not contain production sentinel instructions or claims`);
  }
  if (!isPlainObject(proof)) {
    issues.push(`${path} is required`);
    return;
  }

  if (proof.format !== databaseRestoreReportFormat) {
    issues.push(`${path}.format must be ${databaseRestoreReportFormat}`);
  }
  if (proof.checksumAlgorithm !== 'sha256') {
    issues.push(`${path}.checksumAlgorithm must be sha256`);
  }
  if (proof.expectedReleaseCommitSha !== release?.commitSha) {
    issues.push(`${path}.expectedReleaseCommitSha must match release.commitSha`);
  }
  const helperImplementationKeys = [
    'format', 'repositoryUrl', 'commitSha', 'sourcePath', 'sourceSha256',
    'commitSourceSha256', 'sourceMatchesCommit', 'canonicalRepositoryMatched',
  ];
  if (!hasExactObjectKeys(proof.helperImplementation, helperImplementationKeys)) {
    issues.push(`${path}.helperImplementation must contain exactly the approved helper source binding`);
  } else {
    if (proof.helperImplementation.format !== databaseHelperImplementationFormat) {
      issues.push(`${path}.helperImplementation.format must be ${databaseHelperImplementationFormat}`);
    }
    if (proof.helperImplementation.repositoryUrl !== databaseHelperRepositoryUrl) {
      issues.push(`${path}.helperImplementation.repositoryUrl must match the canonical repository`);
    }
    if (proof.helperImplementation.commitSha !== release?.commitSha ||
      proof.helperImplementation.commitSha !== proof.expectedReleaseCommitSha) {
      issues.push(`${path}.helperImplementation.commitSha must match release.commitSha and expectedReleaseCommitSha`);
    }
    if (proof.helperImplementation.sourcePath !== databaseHelperSourcePath) {
      issues.push(`${path}.helperImplementation.sourcePath must be ${databaseHelperSourcePath}`);
    }
    validateSha256Digest(
      proof.helperImplementation.sourceSha256,
      `${path}.helperImplementation.sourceSha256`,
      issues,
    );
    validateSha256Digest(
      proof.helperImplementation.commitSourceSha256,
      `${path}.helperImplementation.commitSourceSha256`,
      issues,
    );
    if (proof.helperImplementation.sourceSha256 !== proof.helperImplementation.commitSourceSha256) {
      issues.push(`${path}.helperImplementation source and committed-source SHA-256 digests must match`);
    }
    if (proof.helperImplementation.sourceMatchesCommit !== true) {
      issues.push(`${path}.helperImplementation.sourceMatchesCommit must be true`);
    }
    if (proof.helperImplementation.canonicalRepositoryMatched !== true) {
      issues.push(`${path}.helperImplementation.canonicalRepositoryMatched must be true`);
    }
  }
  if (proof.toolsImageReference !== approvedDatabaseToolsImageReference) {
    issues.push(`${path}.toolsImageReference must match the approved PostgreSQL tools image`);
  }
  if (proof.toolsImageDigestSha256 !== approvedDatabaseToolsImageDigestSha256) {
    issues.push(`${path}.toolsImageDigestSha256 must match the approved PostgreSQL tools image digest`);
  }
  if (!isIsoDate(proof.capturedAt)) {
    issues.push(`${path}.capturedAt must be an ISO timestamp`);
  } else if (typeof finalApprovedAt === 'number' && Date.parse(proof.capturedAt) > finalApprovedAt) {
    issues.push(`${path}.capturedAt must not be after finalSignoff.approvedAt`);
  } else if (Date.parse(proof.capturedAt) > validationNow) {
    issues.push(`${path}.capturedAt must not be after the validation time`);
  } else if (validationNow - Date.parse(proof.capturedAt) > databaseRestoreProofMaximumAgeMs) {
    issues.push(`${path}.capturedAt must be no more than 24 hours old at validation time`);
  }
  if (typeof proof.recoverySetId !== 'string' || !recoverySetIdPattern.test(proof.recoverySetId)) {
    issues.push(`${path}.recoverySetId must be a bounded operational identifier`);
  }
  for (const field of databaseRestoreDigestFields) {
    validateSha256Digest(proof[field], `${path}.${field}`, issues);
  }
  if (proof.expectedSourceDatabaseIdentitySha256 !== proof.sourceDatabaseIdentitySha256) {
    issues.push(`${path}.expectedSourceDatabaseIdentitySha256 must match sourceDatabaseIdentitySha256`);
  }
  if (proof.sourceDatabaseFingerprintSha256 !== proof.restoredDatabaseFingerprintSha256) {
    issues.push(`${path}.sourceDatabaseFingerprintSha256 must match restoredDatabaseFingerprintSha256`);
  }
  for (const field of [
    'sourceDatabaseEnvironment',
    'restoredDatabaseEnvironment',
    'restoreTargetDatabaseEnvironment',
  ]) {
    if (!isValidDatabaseEnvironment(proof[field])) {
      issues.push(`${path}.${field} must contain the exact supported PostgreSQL database environment`);
    }
  }
  if (
    isValidDatabaseEnvironment(proof.sourceDatabaseEnvironment) &&
    (
      JSON.stringify(proof.sourceDatabaseEnvironment) !== JSON.stringify(proof.restoredDatabaseEnvironment) ||
      JSON.stringify(proof.sourceDatabaseEnvironment) !== JSON.stringify(proof.restoreTargetDatabaseEnvironment)
    )
  ) {
    issues.push(`${path} source, restored, and restore-target database environments must match exactly`);
  }
  for (const field of [
    'restoreInitializedFromSourceDatabaseEnvironment',
    'databaseEnvironmentPreserved',
    'databaseEnvironmentMatched',
  ]) {
    if (proof[field] !== true) {
      issues.push(`${path}.${field} must be true`);
    }
  }
  if (proof.isolatedRestoreDatabaseIdentitySha256 === proof.sourceDatabaseIdentitySha256) {
    issues.push(`${path}.isolatedRestoreDatabaseIdentitySha256 must be distinct from the production source identity`);
  }
  if (
    typeof proof.databaseDumpBytes !== 'string' ||
    !/^[1-9]\d*$/.test(proof.databaseDumpBytes) ||
    !Number.isSafeInteger(Number(proof.databaseDumpBytes))
  ) {
    issues.push(`${path}.databaseDumpBytes must be a positive integer string`);
  } else if (BigInt(proof.databaseDumpBytes) > BigInt(databaseRestoreWorkloadSafety.maxDumpBytes)) {
    issues.push(`${path}.databaseDumpBytes must not exceed workloadSafety.maxDumpBytes`);
  }
  const capacityPreflightKeys = [
    'method', 'sourceDatabaseSizeBytes', 'safetyFactor', 'safetyMarginBytes',
    'requiredAvailableBytes', 'maximumDumpBytes', 'verified',
  ];
  if (!hasExactObjectKeys(proof.capacityPreflight, capacityPreflightKeys)) {
    issues.push(`${path}.capacityPreflight must contain exactly the source-size-aware capacity proof`);
  } else {
    const sourceSizeIsCanonical =
      typeof proof.capacityPreflight.sourceDatabaseSizeBytes === 'string' &&
      /^(?:0|[1-9]\d*)$/.test(proof.capacityPreflight.sourceDatabaseSizeBytes) &&
      proof.capacityPreflight.sourceDatabaseSizeBytes.length <= 24;
    const requiredBytesAreCanonical =
      typeof proof.capacityPreflight.requiredAvailableBytes === 'string' &&
      /^(?:0|[1-9]\d*)$/.test(proof.capacityPreflight.requiredAvailableBytes) &&
      proof.capacityPreflight.requiredAvailableBytes.length <= 24;
    if (proof.capacityPreflight.method !== databaseCapacityPreflightMethod) {
      issues.push(`${path}.capacityPreflight.method must match the approved source-size-aware preflight`);
    }
    if (!sourceSizeIsCanonical) {
      issues.push(`${path}.capacityPreflight.sourceDatabaseSizeBytes must be a canonical decimal integer`);
    }
    if (proof.capacityPreflight.safetyFactor !== databaseCapacitySafetyFactor) {
      issues.push(`${path}.capacityPreflight.safetyFactor must be ${databaseCapacitySafetyFactor}`);
    }
    if (proof.capacityPreflight.safetyMarginBytes !== databaseCapacitySafetyMarginBytes) {
      issues.push(`${path}.capacityPreflight.safetyMarginBytes must be ${databaseCapacitySafetyMarginBytes}`);
    }
    if (!requiredBytesAreCanonical) {
      issues.push(`${path}.capacityPreflight.requiredAvailableBytes must be a canonical decimal integer`);
    }
    if (proof.capacityPreflight.maximumDumpBytes !== databaseRestoreWorkloadSafety.maxDumpBytes) {
      issues.push(`${path}.capacityPreflight.maximumDumpBytes must match workloadSafety.maxDumpBytes`);
    }
    if (proof.capacityPreflight.verified !== true) {
      issues.push(`${path}.capacityPreflight.verified must be true`);
    }
    if (sourceSizeIsCanonical && requiredBytesAreCanonical) {
      const calculated = BigInt(proof.capacityPreflight.sourceDatabaseSizeBytes) *
        BigInt(databaseCapacitySafetyFactor) + BigInt(databaseCapacitySafetyMarginBytes);
      const maximum = BigInt(databaseRestoreWorkloadSafety.maxDumpBytes);
      const expected = calculated > maximum ? maximum : calculated;
      if (proof.capacityPreflight.requiredAvailableBytes !== expected.toString()) {
        issues.push(`${path}.capacityPreflight.requiredAvailableBytes must match the locked factor-and-margin formula`);
      }
    }
  }
  if (!Number.isSafeInteger(proof.tablesCompared) || proof.tablesCompared < 1) {
    issues.push(`${path}.tablesCompared must be a positive safe integer`);
  }
  if (proof.mismatchCount !== 0) {
    issues.push(`${path}.mismatchCount must be 0`);
  }
  for (const field of [
    'backupArtifactsRetained',
    'snapshotBound',
    'sourceReadOnlyVerified',
    'sourceTlsServerAuthenticationVerified',
    'sourceAndIsolatedRestoreFingerprintsMatch',
    'sourceIdentityBindingMatched',
    'sequenceDefinitionAndOwnershipBound',
  ]) {
    if (proof[field] !== true) {
      issues.push(`${path}.${field} must be true`);
    }
  }
  for (const field of ['productionWritten', 'secretValuesPrinted', 'sequenceStateIncluded', 'ownershipIncluded', 'aclPrivilegesIncluded']) {
    if (proof[field] !== false) {
      issues.push(`${path}.${field} must be false`);
    }
  }
  if (proof.provenanceLimitation !== databaseRestoreProofProvenanceLimitation) {
    issues.push(`${path}.provenanceLimitation must match the production database checker's limitation`);
  }
  for (const [field, expected] of [
    ['publicSequenceCount', 0],
    ['applicationIdentityColumnCount', 0],
    ['applicationSequenceDefaultCount', 0],
  ]) {
    if (proof[field] !== expected) issues.push(`${path}.${field} must be ${expected}`);
  }
  if (proof.sequenceStateExclusionReason !== databaseSequenceStateExclusionReason) {
    issues.push(`${path}.sequenceStateExclusionReason must match the production database checker's limitation`);
  }
  if (proof.ownershipExclusionReason !== databaseOwnershipExclusionReason) {
    issues.push(`${path}.ownershipExclusionReason must match the production database checker's limitation`);
  }
  if (proof.aclPrivilegesExclusionReason !== databaseAclPrivilegesExclusionReason) {
    issues.push(`${path}.aclPrivilegesExclusionReason must match the production database checker's limitation`);
  }
  const workloadSafetyKeys = Object.keys(databaseRestoreWorkloadSafety);
  if (!hasExactObjectKeys(proof.workloadSafety, workloadSafetyKeys)) {
    issues.push(`${path}.workloadSafety must contain exactly the production database checker's workload bounds`);
  } else {
    for (const [field, expected] of Object.entries(databaseRestoreWorkloadSafety)) {
      if (proof.workloadSafety[field] !== expected) {
        issues.push(`${path}.workloadSafety.${field} must match the production database checker`);
      }
    }
  }
  const schemaCoverageKeys = [
    'publicObjectCount',
    'unsupportedPublicObjectCount',
    'publicSequenceCount',
    'applicationIdentityColumnCount',
    'applicationSequenceDefaultCount',
    'largeObjectCount',
  ];
  if (!hasExactObjectKeys(proof.schemaCoverage, schemaCoverageKeys)) {
    issues.push(`${path}.schemaCoverage must contain exactly the production database checker's coverage fields`);
  } else {
    if (!Number.isSafeInteger(proof.schemaCoverage.publicObjectCount) || proof.schemaCoverage.publicObjectCount < 1) {
      issues.push(`${path}.schemaCoverage.publicObjectCount must be a positive safe integer`);
    }
    if (proof.schemaCoverage.unsupportedPublicObjectCount !== 0) {
      issues.push(`${path}.schemaCoverage.unsupportedPublicObjectCount must be 0`);
    }
    if (proof.schemaCoverage.largeObjectCount !== 0) {
      issues.push(`${path}.schemaCoverage.largeObjectCount must be 0`);
    }
    for (const field of ['publicSequenceCount', 'applicationIdentityColumnCount', 'applicationSequenceDefaultCount']) {
      if (proof.schemaCoverage[field] !== proof[field]) {
        issues.push(`${path}.schemaCoverage.${field} must bind ${path}.${field}`);
      }
    }
  }
  if (JSON.stringify(proof.schemaCertificationScope) !== JSON.stringify(databaseSchemaCertificationScope)) {
    issues.push(`${path}.schemaCertificationScope must exactly match the approved database certification scope and exclusions`);
  }

  const commandEntries = Array.isArray(actualCheck.evidence)
    ? actualCheck.evidence.filter((entry) => entry?.type === 'command-output')
    : [];
  const captureEntries = commandEntries.filter(
    (entry) => typeof entry?.description === 'string' &&
      hasWhitespaceDelimitedToken(entry.description, databaseIdentityCaptureCommand),
  );
  const proofEntries = commandEntries.filter(
    (entry) => typeof entry?.description === 'string' &&
      hasWhitespaceDelimitedToken(entry.description, databaseRestoreProofBaseCommand) &&
      entry.description.includes('--recovery-set-id='),
  );
  if (captureEntries.length !== 1) {
    issues.push(`${checkPath}.evidence must include exactly one source-identity command-output entry`);
  }
  if (proofEntries.length !== 1) {
    issues.push(`${checkPath}.evidence must include exactly one prove-restore command-output entry`);
  }
  if (captureEntries[0] && proofEntries[0] && captureEntries[0] === proofEntries[0]) {
    issues.push(`${checkPath}.evidence source identity and prove-restore commands must be distinct entries`);
  }
  if (captureEntries.length === 1) {
    validateCanonicalCommandOptions(
      captureEntries[0].description,
      databaseCheckerCommandPrefix,
      new Map([
        ['--production-env-file', 'value'],
        ['--capture-source-identity', 'boolean'],
        ['--json', 'boolean'],
        ['--expected-release-commit-sha', 'value'],
      ]),
      checkPath,
      'source-identity command',
      issues,
    );
  }
  if (proofEntries.length === 1) {
    validateCanonicalCommandOptions(
      proofEntries[0].description,
      databaseCheckerCommandPrefix,
      new Map([
        ['--production-env-file', 'value'],
        ['--expected-release-commit-sha', 'value'],
        ['--recovery-set-id', 'value'],
        ['--expected-source-database-identity-sha256', 'value'],
        ['--backup-output-dir', 'value'],
        ['--keep-backup', 'boolean'],
        ['--json', 'boolean'],
      ]),
      checkPath,
      'prove-restore command',
      issues,
    );
  }
  if (captureEntries.length === 1 && !hasWhitespaceDelimitedToken(
    captureEntries[0].description,
    `--expected-release-commit-sha=${proof.expectedReleaseCommitSha}`,
  )) {
    issues.push(`${checkPath}.evidence source-identity command must bind --expected-release-commit-sha`);
  }

  const capturePayload = captureEntries.length === 1 ? embeddedVerifierJson(captureEntries[0].description) : null;
  const captureKeys = [
    'format',
    'ok',
    'mode',
    'checksumAlgorithm',
    'expectedReleaseCommitSha',
    'helperImplementation',
    'toolsImageReference',
    'toolsImageDigestSha256',
    'sourceDatabaseIdentitySha256',
    'sourceReadOnlyVerified',
    'sourceTlsServerAuthenticationVerified',
    'restoreProofVerified',
    'productionWritten',
    'secretValuesPrinted',
    'provenanceLimitation',
  ];
  if (!capturePayload || !hasExactObjectKeys(capturePayload, captureKeys)) {
    issues.push(`${checkPath}.evidence source-identity entry must contain exactly one allowlisted JSON payload`);
  } else {
    if (
      capturePayload.ok !== true ||
      capturePayload.format !== databaseSourceIdentityEvidenceFormat ||
      capturePayload.mode !== 'capture-source-identity' ||
      capturePayload.checksumAlgorithm !== 'sha256' ||
      capturePayload.expectedReleaseCommitSha !== release?.commitSha ||
      JSON.stringify(capturePayload.helperImplementation) !== JSON.stringify(proof.helperImplementation) ||
      capturePayload.toolsImageReference !== approvedDatabaseToolsImageReference ||
      capturePayload.toolsImageDigestSha256 !== approvedDatabaseToolsImageDigestSha256 ||
      capturePayload.sourceDatabaseIdentitySha256 !== proof.expectedSourceDatabaseIdentitySha256 ||
      capturePayload.sourceReadOnlyVerified !== true ||
      capturePayload.sourceTlsServerAuthenticationVerified !== true ||
      capturePayload.restoreProofVerified !== false ||
      capturePayload.productionWritten !== false ||
      capturePayload.secretValuesPrinted !== false ||
      capturePayload.provenanceLimitation !== databaseSourceIdentityProvenanceLimitation
    ) {
      issues.push(`${checkPath}.evidence source-identity JSON must exactly bind the read-only captured identity`);
    }
  }

  const proofEntry = proofEntries.length === 1 ? proofEntries[0] : null;
  const proofText = proofEntry?.description ?? '';
  const proofCliBindings = [
    [`--expected-release-commit-sha=${proof.expectedReleaseCommitSha}`, '--expected-release-commit-sha'],
    [`--recovery-set-id=${proof.recoverySetId}`, '--recovery-set-id'],
    [
      `--expected-source-database-identity-sha256=${proof.expectedSourceDatabaseIdentitySha256}`,
      '--expected-source-database-identity-sha256',
    ],
    ['--keep-backup', '--keep-backup'],
    ['--json', '--json'],
  ];
  for (const [token, label] of proofCliBindings) {
    if (!hasWhitespaceDelimitedToken(proofText, token)) {
      issues.push(`${checkPath}.evidence prove-restore command must bind ${label}`);
    }
  }
  const backupOutputMatch = proofText.match(/(?:^|\s)--backup-output-dir=(\/[A-Za-z0-9._/-]+)(?=\s|$)/);
  const backupOutputPath = backupOutputMatch?.[1] ?? '';
  const backupOutputSegments = backupOutputPath.split('/').filter(Boolean);
  const unsafeBackupPrefix = /^(?:\/tmp(?:\/|$)|\/var\/tmp(?:\/|$)|\/workspace(?:\/|$)|\/app(?:\/|$)|\/repo(?:\/|$))/;
  if (
    !backupOutputMatch ||
    backupOutputPath.includes('//') ||
    backupOutputSegments.some((segment) => segment === '.' || segment === '..') ||
    backupOutputSegments.length < 3 ||
    unsafeBackupPrefix.test(backupOutputPath)
  ) {
    issues.push(`${checkPath}.evidence prove-restore command must use an explicit absolute non-repository --backup-output-dir; approved encryption and custody require separate evidence`);
  }

  const proofPayload = proofEntry ? embeddedVerifierJson(proofText) : null;
  const proofPayloadKeys = [
    'format',
    'ok',
    'mode',
    'proof',
    'checksumAlgorithm',
    'expectedReleaseCommitSha',
    'helperImplementation',
    'toolsImageReference',
    'toolsImageDigestSha256',
    'snapshotBound',
    'sourceReadOnlyVerified',
    'sourceTlsServerAuthenticationVerified',
    'sourceAndIsolatedRestoreFingerprintsMatch',
    'productionWritten',
    'recoverySetId',
    'capturedAt',
    ...databaseRestoreDigestFields,
    ...databaseRestoreEnvironmentFields,
    'databaseDumpBytes',
    'capacityPreflight',
    'tablesCompared',
    'mismatchCount',
    'sourceIdentityBindingMatched',
    'sequenceStateIncluded',
    'sequenceDefinitionAndOwnershipBound',
    'publicSequenceCount',
    'applicationIdentityColumnCount',
    'applicationSequenceDefaultCount',
    'sequenceStateExclusionReason',
    'ownershipIncluded',
    'ownershipExclusionReason',
    'aclPrivilegesIncluded',
    'aclPrivilegesExclusionReason',
    'workloadSafety',
    'schemaCoverage',
    'schemaCertificationScope',
    'backupArtifactsRetained',
    'secretValuesPrinted',
    'provenanceLimitation',
  ];
  if (!proofPayload || !hasExactObjectKeys(proofPayload, proofPayloadKeys)) {
    issues.push(`${checkPath}.evidence prove-restore entry must contain exactly one allowlisted JSON success payload`);
  } else {
    if (
      proofPayload.ok !== true ||
      proofPayload.format !== databaseRestoreReportFormat ||
      proofPayload.mode !== 'prove-restore' ||
      proofPayload.proof !== databaseRestoreProofFormat
    ) {
      issues.push(`${checkPath}.evidence prove-restore JSON must contain the exact checker success identity`);
    }
    const boundFields = [
      'format',
      'checksumAlgorithm',
      'expectedReleaseCommitSha',
      'helperImplementation',
      'toolsImageReference',
      'toolsImageDigestSha256',
      'snapshotBound',
      'sourceReadOnlyVerified',
      'sourceTlsServerAuthenticationVerified',
      'sourceAndIsolatedRestoreFingerprintsMatch',
      'productionWritten',
      'recoverySetId',
      'capturedAt',
      ...databaseRestoreDigestFields,
      ...databaseRestoreEnvironmentFields,
      'databaseDumpBytes',
      'capacityPreflight',
      'tablesCompared',
      'mismatchCount',
      'sourceIdentityBindingMatched',
      'sequenceStateIncluded',
      'sequenceDefinitionAndOwnershipBound',
      'publicSequenceCount',
      'applicationIdentityColumnCount',
      'applicationSequenceDefaultCount',
      'sequenceStateExclusionReason',
      'ownershipIncluded',
      'ownershipExclusionReason',
      'aclPrivilegesIncluded',
      'aclPrivilegesExclusionReason',
      'workloadSafety',
      'schemaCoverage',
      'schemaCertificationScope',
      'backupArtifactsRetained',
      'secretValuesPrinted',
      'provenanceLimitation',
    ];
    for (const field of boundFields) {
      const nestedBinding = field === 'helperImplementation' || field === 'capacityPreflight' ||
        field.endsWith('DatabaseEnvironment') ||
        field === 'workloadSafety' || field === 'schemaCoverage' ||
        field === 'schemaCertificationScope';
      if (nestedBinding ? JSON.stringify(proofPayload[field]) !== JSON.stringify(proof[field]) : proofPayload[field] !== proof[field]) {
        issues.push(`${checkPath}.evidence prove-restore JSON must bind databaseRestoreProof.${field}`);
      }
    }
  }

  const reportEntries = Array.isArray(actualCheck.evidence)
    ? actualCheck.evidence.filter((entry) => entry?.type === 'report')
    : [];
  const report = reportEntries.find((entry) => {
    const description = entry?.description ?? '';
    return [
      proof.proofReportSha256,
      proof.databaseDumpSha256,
      proof.recoverySetId,
      proof.sourceDatabaseFingerprintSha256,
      proof.restoredDatabaseFingerprintSha256,
    ].every((marker) => typeof marker === 'string' && description.includes(marker));
  });
  if (!report) {
    issues.push(`${checkPath}.evidence must include report evidence bound to the recovery set, dump, proof report, and both fingerprints`);
  }

  const captureAt = captureEntries.length === 1 ? isoTimestamp(captureEntries[0].capturedAt) : null;
  const proofCapturedAt = isoTimestamp(proof.capturedAt);
  const provedAt = proofEntry ? isoTimestamp(proofEntry.capturedAt) : null;
  const reportAt = report ? isoTimestamp(report.capturedAt) : null;
  if (captureAt !== null && proofCapturedAt !== null && captureAt > proofCapturedAt) {
    issues.push(`${checkPath}.evidence source identity capture must not be after the helper proof capture`);
  }
  if (proofCapturedAt !== null && provedAt !== null && proofCapturedAt > provedAt) {
    issues.push(`${checkPath}.evidence prove-restore command capture must not predate the helper proof capture`);
  }
  if (provedAt !== null && reportAt !== null && provedAt > reportAt) {
    issues.push(`${checkPath}.evidence report capture must not be before prove-restore evidence`);
  }
  if (provedAt !== null && typeof finalApprovedAt === 'number' && provedAt > finalApprovedAt) {
    issues.push(`${checkPath}.evidence prove-restore capture must not be after finalSignoff.approvedAt`);
  }
}

function validateDatabaseRestoreHumanEvidence(actualCheck, databaseCheck, checkPath, issues) {
  const proof = databaseCheck?.databaseRestoreProof;
  const text = evidenceText(actualCheck.evidence);
  if (/sentinel/i.test(text)) {
    issues.push(`${checkPath}.evidence must not contain production sentinel instructions or claims`);
  }
  for (const marker of [
    'restore test',
    'owner',
    'restore date',
    'recovery notes',
    'isolated non-production target',
    'read-only source',
    'production database was not overwritten',
    proof?.recoverySetId,
    proof?.proofReportSha256,
  ]) {
    if (typeof marker !== 'string' || !text.includes(marker)) {
      issues.push(`${checkPath}.evidence must include ${marker ?? 'database restore proof binding'}`);
    }
  }
}

function validateJointRecoveryReconciliation(
  actualCheck,
  checkPath,
  issues,
  finalApprovedAt,
  validationNow,
) {
  const path = `${checkPath}.jointRecoveryReconciliation`;
  if (!hasEvidenceType(actualCheck, 'command-output')) {
    issues.push(`${checkPath}.evidence must include command-output evidence from the document recovery verifier`);
  }
  if (!hasEvidenceType(actualCheck, 'report')) {
    issues.push(`${checkPath}.evidence must include report evidence for the joint recovery manifest`);
  }
  const commandEntries = Array.isArray(actualCheck.evidence)
    ? actualCheck.evidence.filter((entry) => entry?.type === 'command-output')
    : [];
  const verifierCommandEntry = commandEntries.find(
    (entry) => typeof entry?.description === 'string' && entry.description.includes(jointRecoveryVerifierBaseCommand),
  );
  const verifierCommandText = evidenceText(verifierCommandEntry ? [verifierCommandEntry] : []);
  const reportText = evidenceText(
    Array.isArray(actualCheck.evidence)
      ? actualCheck.evidence.filter((entry) => entry?.type === 'report')
      : [],
  );
  const reconciliation = actualCheck.jointRecoveryReconciliation;
  if (!isPlainObject(reconciliation)) {
    issues.push(`${path} is required`);
    return;
  }

  if (!hasExactObjectKeys(reconciliation, [...jointRecoveryVerifierPayloadFields, 'reconciledBy'])) {
    issues.push(`${path} must contain exactly the verifier success payload fields plus reconciledBy`);
  }

  if (reconciliation.manifestFormat !== jointRecoveryManifestFormat) {
    issues.push(`${path}.manifestFormat must be ${jointRecoveryManifestFormat}`);
  }
  if (reconciliation.checksumAlgorithm !== 'sha256') {
    issues.push(`${path}.checksumAlgorithm must be sha256`);
  }

  for (const field of jointRecoveryDigestFields) {
    validateSha256Digest(reconciliation[field], `${path}.${field}`, issues);
  }
  if (typeof reconciliation.exerciseId !== 'string' || !recoverySetIdPattern.test(reconciliation.exerciseId)) {
    issues.push(`${path}.exerciseId must be a bounded operational identifier`);
  }
  if (typeof reconciliation.recoverySetId !== 'string' || !recoverySetIdPattern.test(reconciliation.recoverySetId)) {
    issues.push(`${path}.recoverySetId must be a bounded operational identifier`);
  }

  const validCounts = new Map();
  for (const field of jointRecoveryCountFields) {
    const valid = Number.isSafeInteger(reconciliation[field]) && reconciliation[field] >= 0;
    validCounts.set(field, valid);
    if (!valid) {
      issues.push(`${path}.${field} must be a non-negative safe integer`);
    }
  }

  if (validCounts.get('metadataRowCount') && reconciliation.metadataRowCount < 1) {
    issues.push(`${path}.metadataRowCount must be at least 1 so recovery proof is not vacuous`);
  }
  if (
    validCounts.get('metadataRowCount') &&
    validCounts.get('expectedObjectCount') &&
    reconciliation.metadataRowCount !== reconciliation.expectedObjectCount
  ) {
    issues.push(`${path}.metadataRowCount must match expectedObjectCount`);
  }
  for (const field of ['restoredObjectCount', 'matchedObjectCount']) {
    if (
      validCounts.get('expectedObjectCount') &&
      validCounts.get(field) &&
      reconciliation[field] !== reconciliation.expectedObjectCount
    ) {
      issues.push(`${path}.${field} must match expectedObjectCount`);
    }
  }
  for (const field of [
    'missingObjectCount',
    'unexpectedObjectCount',
    'orphanExpectedObjectCount',
    'orphanRestoredObjectCount',
    'checksumMismatchCount',
  ]) {
    if (validCounts.get(field) && reconciliation[field] !== 0) {
      issues.push(`${path}.${field} must be 0`);
    }
  }
  if (
    validCounts.get('expectedBytes') &&
    validCounts.get('restoredBytes') &&
    reconciliation.expectedBytes !== reconciliation.restoredBytes
  ) {
    issues.push(`${path}.restoredBytes must match expectedBytes`);
  }

  if (
    validCounts.get('storageDeletionCount') &&
    validCounts.get('restoredStorageDeletionCount') &&
    reconciliation.storageDeletionCount !== reconciliation.restoredStorageDeletionCount
  ) {
    issues.push(`${path}.restoredStorageDeletionCount must match storageDeletionCount`);
  }
  for (const field of [
    'pendingStorageDeletionCount',
    'deadLetterStorageDeletionCount',
    'restoredPendingStorageDeletionCount',
    'restoredDeadLetterStorageDeletionCount',
    'processedDeletionObjectResidueCount',
  ]) {
    if (validCounts.get(field) && reconciliation[field] !== 0) {
      issues.push(`${path}.${field} must be 0`);
    }
  }
  if (
    validCounts.get('storageDeletionCount') &&
    validCounts.get('processedStorageDeletionCount') &&
    reconciliation.storageDeletionCount !== reconciliation.processedStorageDeletionCount
  ) {
    issues.push(`${path}.processedStorageDeletionCount must match storageDeletionCount`);
  }
  if (
    validCounts.get('restoredStorageDeletionCount') &&
    validCounts.get('restoredProcessedStorageDeletionCount') &&
    reconciliation.restoredStorageDeletionCount !== reconciliation.restoredProcessedStorageDeletionCount
  ) {
    issues.push(`${path}.restoredProcessedStorageDeletionCount must match restoredStorageDeletionCount`);
  }
  if (
    validCounts.get('recoveryEventCount') &&
    validCounts.get('restoredRecoveryEventCount') &&
    reconciliation.recoveryEventCount !== reconciliation.restoredRecoveryEventCount
  ) {
    issues.push(`${path}.restoredRecoveryEventCount must match recoveryEventCount`);
  }

  if (reconciliation.restoreTargetType !== jointRecoveryTargetType) {
    issues.push(`${path}.restoreTargetType must be ${jointRecoveryTargetType}`);
  }
  for (const field of [
    'isolationAttestationRecorded',
    'productionDatabaseNotOverwrittenAttestationRecorded',
    'productionObjectStoreNotOverwrittenAttestationRecorded',
    'restoreCredentialsScopedToTargetAttestationRecorded',
  ]) {
    if (reconciliation[field] !== true) {
      issues.push(`${path}.${field} must be true`);
    }
  }

  if (!isPlainObject(reconciliation.objectives) ||
    !hasExactObjectKeys(reconciliation.objectives, ['database', 'documentBytes'])) {
    issues.push(`${path}.objectives is required`);
  } else {
    validateJointRecoveryObjective(reconciliation.objectives.database, `${path}.objectives.database`, issues);
    validateJointRecoveryObjective(
      reconciliation.objectives.documentBytes,
      `${path}.objectives.documentBytes`,
      issues,
    );
  }

  for (const field of [
    'ownerRecorded',
    'recoveryOperatorRecorded',
    'notesRecorded',
    'externalEvidenceReferencesRecorded',
    'independentBindingArgumentsMatched',
  ]) {
    if (reconciliation[field] !== true) {
      issues.push(`${path}.${field} must be true`);
    }
  }
  if (reconciliation.sourceProvenanceExternallyVerified !== false) {
    issues.push(`${path}.sourceProvenanceExternallyVerified must be false`);
  }
  if (reconciliation.secretValuesPrinted !== false) {
    issues.push(`${path}.secretValuesPrinted must be false`);
  }
  if (reconciliation.provenanceLimitation !== jointRecoveryProvenanceLimitation) {
    issues.push(`${path}.provenanceLimitation must match the verifier's offline consistency limitation`);
  }

  const parsedTimestamps = new Map();
  for (const field of jointRecoveryTimestampFields) {
    const parsed = isoTimestamp(reconciliation[field]);
    parsedTimestamps.set(field, parsed);
    if (parsed === null) {
      issues.push(`${path}.${field} must be an ISO timestamp`);
    }
  }

  for (const field of [
    'sourceMetadataCaptureTransactionId',
    'restoredMetadataCaptureTransactionId',
  ]) {
    const value = reconciliation[field];
    if (
      typeof value !== 'string' ||
      !postgresTransactionIdPattern.test(value) ||
      BigInt(value) > maximumPostgresTransactionId
    ) {
      issues.push(`${path}.${field} must be a canonical bounded PostgreSQL transaction identifier`);
    }
  }

  const maximumAge = reconciliation.maximumDocumentProofAgeMinutes;
  if (!Number.isSafeInteger(maximumAge) || maximumAge < 1 || maximumAge > maximumDocumentProofAgeMinutes) {
    issues.push(`${path}.maximumDocumentProofAgeMinutes must be between 1 and ${maximumDocumentProofAgeMinutes}`);
  }
  if (!Number.isSafeInteger(reconciliation.documentProofAgeMinutes) || reconciliation.documentProofAgeMinutes < 0) {
    issues.push(`${path}.documentProofAgeMinutes must be a non-negative safe integer`);
  } else if (Number.isSafeInteger(maximumAge) && reconciliation.documentProofAgeMinutes > maximumAge) {
    issues.push(`${path}.documentProofAgeMinutes must not exceed maximumDocumentProofAgeMinutes`);
  }
  if (reconciliation.documentProofFresh !== true) {
    issues.push(`${path}.documentProofFresh must be true`);
  }

  const captureTimes = [
    parsedTimestamps.get('sourceMetadataCapturedAt'),
    parsedTimestamps.get('restoredMetadataCapturedAt'),
    parsedTimestamps.get('sourceObjectInventoryCapturedAt'),
    parsedTimestamps.get('restoredObjectInventoryCapturedAt'),
  ];
  const oldestCapturedAt = parsedTimestamps.get('documentProofOldestCapturedAt');
  const freshThroughAt = parsedTimestamps.get('documentProofFreshThroughAt');
  if (captureTimes.every((value) => value !== null) &&
    oldestCapturedAt !== Math.min(...captureTimes)) {
    issues.push(`${path}.documentProofOldestCapturedAt must equal the oldest bound inventory capture`);
  }
  if (oldestCapturedAt !== null && Number.isSafeInteger(maximumAge) &&
    freshThroughAt !== oldestCapturedAt + maximumAge * 60_000) {
    issues.push(`${path}.documentProofFreshThroughAt must be derived from the oldest capture and maximum age`);
  }
  if (oldestCapturedAt !== null && oldestCapturedAt > validationNow) {
    issues.push(`${path}.document recovery captures must not be in the future`);
  }
  if (freshThroughAt !== null && validationNow > freshThroughAt) {
    issues.push(`${path}.document recovery proof must still be fresh at validation time`);
  }
  if (oldestCapturedAt !== null && Number.isSafeInteger(reconciliation.documentProofAgeMinutes)) {
    const currentAgeMinutes = Math.ceil(Math.max(0, validationNow - oldestCapturedAt) / 60_000);
    if (reconciliation.documentProofAgeMinutes > currentAgeMinutes) {
      issues.push(`${path}.documentProofAgeMinutes must not exceed the age at validation time`);
    }
    const verifierEvidenceAt = isoTimestamp(verifierCommandEntry?.capturedAt);
    if (verifierEvidenceAt !== null) {
      if (verifierEvidenceAt < oldestCapturedAt) {
        issues.push(`${checkPath}.verifier evidence capture must not be before the oldest inventory capture`);
      } else {
        const evidenceAgeMinutes = Math.ceil((verifierEvidenceAt - oldestCapturedAt) / 60_000);
        if (Math.abs(reconciliation.documentProofAgeMinutes - evidenceAgeMinutes) > 1) {
          issues.push(`${path}.documentProofAgeMinutes must match the verifier evidence capture time`);
        }
      }
      if (freshThroughAt !== null && verifierEvidenceAt > freshThroughAt) {
        issues.push(`${checkPath}.verifier evidence must be captured before documentProofFreshThroughAt`);
      }
    }
  }

  const reconciledAt = parsedTimestamps.get('reconciledAt');
  if (reconciledAt === null) {
    // The field-specific timestamp error above is sufficient.
  } else {
    if (typeof finalApprovedAt === 'number' && reconciledAt > finalApprovedAt) {
      issues.push(`${path}.reconciledAt must not be after finalSignoff.approvedAt`);
    }
    const chronologyEvidence = Array.isArray(actualCheck.evidence) ? actualCheck.evidence : [];
    for (const [index, entry] of chronologyEvidence.entries()) {
      if (entry?.type !== 'command-output' && entry?.type !== 'report') continue;
      const capturedAt = isoTimestamp(entry.capturedAt);
      if (capturedAt !== null && capturedAt < reconciledAt) {
        issues.push(`${checkPath}.evidence[${index}].capturedAt must not be before ${path}.reconciledAt`);
      }
    }
    for (const field of [
      'sourceMetadataCapturedAt',
      'restoredMetadataCapturedAt',
      'sourceObjectInventoryCapturedAt',
      'restoredObjectInventoryCapturedAt',
    ]) {
      const capturedAt = parsedTimestamps.get(field);
      if (capturedAt !== null && capturedAt > reconciledAt) {
        issues.push(`${path}.${field} must not be after reconciledAt`);
      }
    }
    for (const [sourceField, restoredField] of [
      ['sourceMetadataCapturedAt', 'restoredMetadataCapturedAt'],
      ['sourceObjectInventoryCapturedAt', 'restoredObjectInventoryCapturedAt'],
    ]) {
      const sourceAt = parsedTimestamps.get(sourceField);
      const restoredAt = parsedTimestamps.get(restoredField);
      if (sourceAt !== null && restoredAt !== null && sourceAt > restoredAt) {
        issues.push(`${path}.${sourceField} must not be after ${restoredField}`);
      }
    }
  }
  if (typeof reconciliation.reconciledBy !== 'string' || reconciliation.reconciledBy.trim().length < 3) {
    issues.push(`${path}.reconciledBy is required`);
  } else {
    const reconciledBy = reconciliation.reconciledBy.trim();
    if (/^REPLACE_WITH_/i.test(reconciledBy) || placeholderOrLocalPattern.test(reconciledBy)) {
      issues.push(`${path}.reconciledBy must not be a placeholder or local reference`);
    }
    if (containsRawSecretText(reconciledBy)) {
      issues.push(`${path}.reconciledBy must not contain raw secret-looking values`);
    }
  }

  const cliBindings = [
    ['--expected-recovery-manifest-sha256', reconciliation.recoveryManifestSha256],
    ['--expected-source-binding-sha256', reconciliation.sourceBindingSha256],
    ['--expected-database-dump-sha256', reconciliation.databaseDumpSha256],
    ['--expected-object-backup-manifest-sha256', reconciliation.objectBackupManifestSha256],
    ['--expected-source-capture-report-sha256', reconciliation.sourceCaptureReportSha256],
    ['--expected-source-database-identity-sha256', reconciliation.sourceDatabaseIdentitySha256],
    ['--expected-source-object-store-identity-sha256', reconciliation.sourceObjectStoreIdentitySha256],
    ['--expected-metadata-inventory-sha256', reconciliation.sourceMetadataInventorySha256],
    ['--expected-object-inventory-sha256', reconciliation.sourceObjectInventorySha256],
    ['--expected-restored-metadata-inventory-sha256', reconciliation.restoredMetadataInventorySha256],
    ['--expected-restored-object-inventory-sha256', reconciliation.restoredObjectInventorySha256],
    ['--expected-storage-deletion-inventory-sha256', reconciliation.sourceStorageDeletionInventorySha256],
    ['--expected-restored-storage-deletion-inventory-sha256', reconciliation.restoredStorageDeletionInventorySha256],
    ['--expected-recovery-event-inventory-sha256', reconciliation.sourceRecoveryEventInventorySha256],
    ['--expected-restored-recovery-event-inventory-sha256', reconciliation.restoredRecoveryEventInventorySha256],
    ['--expected-production-document-count', reconciliation.metadataRowCount],
    ['--expected-storage-deletion-count', reconciliation.storageDeletionCount],
    ['--expected-pending-storage-deletion-count', reconciliation.pendingStorageDeletionCount],
    ['--expected-dead-letter-storage-deletion-count', reconciliation.deadLetterStorageDeletionCount],
    ['--expected-processed-storage-deletion-count', reconciliation.processedStorageDeletionCount],
    ['--expected-recovery-event-count', reconciliation.recoveryEventCount],
    ['--expected-source-metadata-captured-at', reconciliation.sourceMetadataCapturedAt],
    ['--expected-restored-metadata-captured-at', reconciliation.restoredMetadataCapturedAt],
    ['--expected-source-object-inventory-captured-at', reconciliation.sourceObjectInventoryCapturedAt],
    ['--expected-restored-object-inventory-captured-at', reconciliation.restoredObjectInventoryCapturedAt],
    ['--expected-source-metadata-capture-transaction-id', reconciliation.sourceMetadataCaptureTransactionId],
    ['--expected-restored-metadata-capture-transaction-id', reconciliation.restoredMetadataCaptureTransactionId],
    ['--expected-maximum-document-proof-age-minutes', reconciliation.maximumDocumentProofAgeMinutes],
    ['--expected-exercise-id', reconciliation.exerciseId],
    ['--expected-recovery-set-id', reconciliation.recoverySetId],
  ];
  validateCanonicalCommandOptions(
    verifierCommandEntry?.description ?? '',
    jointRecoveryVerifierCommandPrefix,
    new Map([
      ['--manifest-file', 'value'],
      ...cliBindings.map(([flag]) => [flag, 'value']),
      ['--json', 'boolean'],
    ]),
    checkPath,
    'document recovery verifier command',
    issues,
  );
  if (!hasWhitespaceDelimitedToken(verifierCommandText, jointRecoveryVerifierBaseCommand)) {
    issues.push(`${checkPath}.evidence must include the document recovery verifier base command`);
  }
  const expectedFlagCount = [...verifierCommandText.matchAll(/(?:^|\s)--expected-[a-z0-9-]+=/g)].length;
  if (expectedFlagCount !== cliBindings.length) {
    issues.push(`${checkPath}.evidence must include exactly ${cliBindings.length} document recovery verifier binding flags`);
  }
  for (const [flag, value] of cliBindings) {
    const occurrenceCount = [...verifierCommandText.matchAll(
      new RegExp(`(?:^|\\s)${escapeRegExp(flag)}=`, 'g'),
    )].length;
    if (occurrenceCount !== 1) {
      issues.push(`${checkPath}.evidence must include ${flag} exactly once`);
    }
    if (!hasWhitespaceDelimitedToken(verifierCommandText, `${flag}=${value}`)) {
      issues.push(`${checkPath}.evidence must bind ${flag} to jointRecoveryReconciliation`);
    }
  }
  const jsonFlagCount = [...verifierCommandText.matchAll(/(?:^|\s)--json(?=\s|$)/g)].length;
  if (jsonFlagCount !== 1) {
    issues.push(`${checkPath}.evidence must include the document recovery verifier --json flag`);
  }
  if (!verifierCommandText.includes(jointRecoveryConsistencySuccessText)) {
    issues.push(`${checkPath}.evidence must include ${jointRecoveryConsistencySuccessText}`);
  }
  for (const forbiddenField of [
    'isolationVerified',
    'sourceProvenanceExternallyBound',
    'productionDatabaseOverwritten',
    'productionObjectStoreOverwritten',
  ]) {
    if (new RegExp(`"${forbiddenField}"\\s*:`).test(verifierCommandText)) {
      issues.push(`${checkPath}.evidence must not include legacy automated verifier field ${forbiddenField}`);
    }
  }

  const verifierPayload = embeddedVerifierJson(verifierCommandText);
  if (!verifierPayload || !hasExactObjectKeys(verifierPayload, ['ok', ...jointRecoveryVerifierPayloadFields])) {
    issues.push(`${checkPath}.evidence must include exactly one verifier JSON success payload with the final allowlisted schema`);
  } else {
    if (verifierPayload.ok !== true) {
      issues.push(`${checkPath}.evidence must bind verifier JSON field ok`);
    }
    for (const field of jointRecoveryVerifierPayloadFields) {
      const verifierValue = verifierPayload[field];
      const ledgerValue = reconciliation[field];
      const matches = isPlainObject(ledgerValue)
        ? JSON.stringify(verifierValue) === JSON.stringify(ledgerValue)
        : verifierValue === ledgerValue;
      if (!matches) {
        issues.push(`${checkPath}.evidence must bind verifier JSON field ${field}`);
      }
    }
  }
  for (const [marker, label] of [
    ...jointRecoveryDigestFields.map((field) => [reconciliation[field], field]),
    [reconciliation.exerciseId, 'exerciseId'],
    [reconciliation.recoverySetId, 'recoverySetId'],
    [reconciliation.sourceMetadataCaptureTransactionId, 'sourceMetadataCaptureTransactionId'],
    [reconciliation.restoredMetadataCaptureTransactionId, 'restoredMetadataCaptureTransactionId'],
  ]) {
    if (typeof marker !== 'string' || !reportText.includes(marker)) {
      issues.push(`${checkPath}.report evidence must include ${label}`);
    }
  }
}

function hasManagedTlsDeployEvidence(text) {
  const lowerText = text.toLowerCase();
  return (
    lowerText.includes('--no-tls-proxy') &&
    (
      lowerText.includes('managed load balancer tls') ||
      lowerText.includes('managed hosting platform tls') ||
      lowerText.includes('external tls')
    ) &&
    lowerText.includes('tls certificate evidence')
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasRouteToken(text, route) {
  const routePattern = new RegExp(`(?:^|[\\s,(])${escapeRegExp(route)}(?=$|[\\s,.)])`);
  return routePattern.test(text);
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
  ['releaseGate.github-environment', {
    commandLabel: 'check:production:github-env',
    command: 'npm run check:production:github-env -- --environment=production',
    successText: 'Production GitHub environment check passed',
  }],
  ['releaseGate.github-secret-store', {
    commandLabel: 'check:production:github-secrets',
    command: 'npm run check:production:github-secrets -- --environment=production',
    successText: 'Production GitHub secret-store check passed',
    requiredMarkers: ['AUTH_RECOVERY_SECRET'],
  }],
  ['hostingDnsTls.hosting-check', {
    commandLabel: 'check:production:hosting',
    command: 'npm run check:production:hosting -- --production-env-file=.env.production',
    successText: 'Production hosting check passed',
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
  for (const marker of requirement.requiredMarkers ?? []) {
    requireEvidenceText(text, marker, `${checkPath}.evidence must include ${marker}`, issues);
  }
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
    requireEvidenceText(text, '--backup-output-dir=', `${checkPath}.evidence must include protected backup output`, issues);
    requireEvidenceText(
      text,
      'Production compose deploy completed',
      `${checkPath}.evidence must include Production compose deploy completed`,
      issues,
    );
    for (const marker of [
      'compose.production.yml',
      'release-image-digests.env',
      'digest-pinned images',
      'old runtime stopped before migration',
      'migration image alone',
      'live migration-history probe',
      'quiesced reminder cutover preparation',
      'zero unresolved reminder outcomes',
      'retained restore-verified backup',
      'host-wide production cutover lock',
    ]) {
      requireEvidenceText(text, marker, `${checkPath}.evidence must include ${marker}`, issues);
    }
    if (!hasManagedTlsDeployEvidence(text)) {
      requireEvidenceText(
        text,
        'compose.production-tls.yml',
        `${checkPath}.evidence must include compose.production-tls.yml or --no-tls-proxy with managed TLS certificate evidence`,
        issues,
      );
    }
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
    requireEvidenceText(text, '--backup-output-dir=', `${checkPath}.evidence must include protected backup output`, issues);
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
      '--schema-compatibility-attestation-file=',
      `${checkPath}.evidence must include the fresh manifest-bound schema compatibility attestation`,
      issues,
    );
    requireEvidenceText(text, '--backup-output-dir=', `${checkPath}.evidence must include protected backup output`, issues);
    requireEvidenceText(
      text,
      'Production compose rollback completed',
      `${checkPath}.evidence must include Production compose rollback completed`,
      issues,
    );
    for (const marker of [
      'previous signed digest manifest',
      'release-image-digests.previous.env',
      'Production deploy smoke passed',
      'live migration-history probe',
      'host-wide production cutover lock',
    ]) {
      requireEvidenceText(text, marker, `${checkPath}.evidence must include ${marker}`, issues);
    }
    const sameLineRollbackEvidence = requireDistinctCommandOutputEvidence(
      actualCheck,
      [
        'npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env',
        '--schema-compatibility-attestation-file=',
      ],
      'the same-line P1-07A-compatible rollback rehearsal',
      [
        '--backup-output-dir=',
        'previous signed digest manifest',
        'live migration-history probe',
        'host-wide production cutover lock',
        'Production compose rollback completed',
        'Production deploy smoke passed',
      ],
      checkPath,
      issues,
    );
    const p109RecoveryEvidence = requireDistinctCommandOutputEvidence(
      actualCheck,
      ['npm run deploy:recover:p109 -- --production-env-file=.env.production'],
      'the failed P1-09 recovery rehearsal',
      [
        '--backup-output-dir=',
        '--recovery-attestation-file=',
        'P1-09 recovery attestation',
        '20 selected-image migration SHA-256 values',
        'exact 19-migration applied predecessor chain plus one unresolved failed P1-09 target',
        'P1-09 failed migration was resolved as rolled back and immediately recovered through the complete production deploy path',
      ],
      checkPath,
      issues,
    );
    const p107aRecoveryEvidence = requireDistinctCommandOutputEvidence(
      actualCheck,
      ['npm run deploy:recover:p107a -- --production-env-file=.env.production'],
      'the failed P1-07A recovery rehearsal',
      [
        '--backup-output-dir=',
        '--recovery-attestation-file=',
        'P1-07A recovery attestation',
        '21 selected-image migration SHA-256 values',
        'exact 20-migration applied predecessor chain plus one unresolved failed P1-07A target',
        'P1-07A failed migration was resolved as rolled back and immediately recovered through the complete production deploy path',
      ],
      checkPath,
      issues,
    );
    const p109RestoreRollbackEvidence = requireDistinctCommandOutputEvidence(
      actualCheck,
      [
        'npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env',
        '--database-restore-attestation-file=',
        '--restored-backup-file=',
      ],
      'the P1-09 restore-only cross-boundary rollback rehearsal',
      [
        '--backup-output-dir=',
        'p109-restored',
        '20260711230000_add_domain_invariants_referential_safety',
        '20260712013000_add_password_recovery_integrity',
        'P1-07A migration absent',
        'Exact P1-09 restored-history checksum and P1-07A-absence probe passed before any migration',
        'Production compose rollback completed',
        'Production deploy smoke passed',
      ],
      checkPath,
      issues,
    );
    const requiredRollbackEntries = [
      sameLineRollbackEvidence,
      p109RecoveryEvidence,
      p107aRecoveryEvidence,
      p109RestoreRollbackEvidence,
    ].filter(Boolean);
    if (
      requiredRollbackEntries.length === 4 &&
      new Set(requiredRollbackEntries).size !== 4
    ) {
      issues.push(
        `${checkPath}.evidence must keep the same-line rollback, P1-09 recovery, P1-07A recovery, and P1-09 restore-only rollback in four distinct command-output entries`,
      );
    }
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
    requireEvidenceText(
      text,
      'CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1',
      `${checkPath}.evidence must include the reviewed database compatibility marker`,
      issues,
    );
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
  }
}

function validateCheckSpecificEvidence(
  areaId,
  checkId,
  actualCheck,
  actualArea,
  checkPath,
  issues,
  release,
  finalApprovedAt,
  validationNow,
) {
  validateExecutableCheckerEvidence(areaId, checkId, actualCheck, checkPath, issues);

  if (areaId === 'browserQa' && BROWSER_QA_RELEASE_BOUND_CHECKS.has(checkId) && typeof release?.commitSha === 'string') {
    const text = evidenceText(actualCheck.evidence);
    requireEvidenceText(text, release.commitSha, `${checkPath}.evidence must include release.commitSha`, issues);
  }

  if (areaId === 'releaseGate') {
    validateReleaseGateEvidence(checkId, actualCheck, checkPath, release, issues);
  }

  if (areaId === 'secretsAndEnv') {
    const text = evidenceText(actualCheck.evidence);

    const secretsMarkersByCheck = {
      'real-production-values': ['.env.production', 'real production values'],
      'secret-source-excluded-from-git': ['secret store', 'excluded from git'],
      'node-env-production': ['NODE_ENV=production'],
      'jwt-secret-entropy': ['JWT_SECRET', 'AUTH_RECOVERY_SECRET', '32 to 64 bytes', 'independent', 'high entropy'],
      'frontend-api-origins': ['https://app.charitypilot.ie', 'https://api.charitypilot.ie'],
      'supabase-api-only': ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET', 'API/server runtimes only'],
      'web-compose-api-origin': ['CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_API_URL'],
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

    if (checkId === 'auth-recovery-secret-rotation-rehearsal') {
      const dryRunEvidence = requireDistinctCommandOutputEvidence(
        actualCheck,
        ['node dist/jobs/rotate-auth-recovery-secret.js', '--dry-run'],
        'the auth-recovery secret rotation dry-run rehearsal',
        [
          'isolated recent restore',
          '--confirm-api-and-scheduler-quiesced',
          'DRY_RUN',
          'mutationApplied: false',
          'databaseIdentitySha256',
          'deploymentProfile: production',
        ],
        checkPath,
        issues,
      );
      const executeEvidence = requireDistinctCommandOutputEvidence(
        actualCheck,
        ['node dist/jobs/rotate-auth-recovery-secret.js', '--execute'],
        'the auth-recovery secret rotation execution rehearsal',
        [
          'isolated recent restore',
          '--confirm-api-and-scheduler-quiesced',
          '--confirm-outbox-preservation-understood',
          '--expected-database-identity-sha256',
          '--expected-deployment-profile production',
          'EXECUTED',
          'recoveryBlocked: true',
          'terminationReason: KEY_ROTATED',
          'remainingCapabilities: 0',
          'remainingRequestEvidenceRows: 0',
          'remainingLegacySlots: 0',
          'remainingRateBuckets: 0',
        ],
        checkPath,
        issues,
      );
      const activationEvidence = requireDistinctCommandOutputEvidence(
        actualCheck,
        ['node dist/jobs/rotate-auth-recovery-secret.js', '--activate-after-replacement'],
        'the auth-recovery replacement-secret activation rehearsal',
        [
          'isolated recent restore',
          '--confirm-api-and-scheduler-quiesced',
          '--expected-database-identity-sha256',
          '--expected-deployment-profile production',
          'different replacement secret',
          'ACTIVATED',
          'recoveryBlocked: false',
          'credentialsIssued: false',
        ],
        checkPath,
        issues,
      );
      const postActivationEvidence = requireDistinctCommandOutputEvidence(
        actualCheck,
        ['post-activation recovery rehearsal'],
        'the auth-recovery post-activation smoke rehearsal',
        [
          'isolated recent restore',
          'old-key process rejected by database fence',
          'new recovery request',
          'reset consumption',
          'preserved completion-notice worker',
        ],
        checkPath,
        issues,
      );
      const rotationEntries = [
        dryRunEvidence,
        executeEvidence,
        activationEvidence,
        postActivationEvidence,
      ].filter(Boolean);
      if (rotationEntries.length === 4 && new Set(rotationEntries).size !== 4) {
        issues.push(
          `${checkPath}.evidence must keep dry-run, execute, replacement activation, and post-activation smoke in four distinct command-output entries`,
        );
      }
      for (const entry of rotationEntries) {
        if (typeof release?.commitSha === 'string') {
          requireEvidenceText(
            evidenceText([entry]),
            release.commitSha,
            `${checkPath}.evidence every rotation rehearsal transcript must include release.commitSha`,
            issues,
          );
        }
        if (typeof release?.imageDigestManifest?.apiImage === 'string') {
          requireEvidenceText(
            evidenceText([entry]),
            release.imageDigestManifest.apiImage,
            `${checkPath}.evidence every rotation rehearsal transcript must include the promoted API image digest`,
            issues,
          );
        }
      }
    }
  }

  if (areaId === 'hostingDnsTls') {
    const text = evidenceText(actualCheck.evidence);

    const hostingMarkersByCheck = {
      'web-origin': ['https://app.charitypilot.ie'],
      'api-origin': ['https://api.charitypilot.ie'],
      'dns-owner': ['DNS owner', 'approved owner', 'DNS record', 'app.charitypilot.ie', 'api.charitypilot.ie'],
      'tls-certificates': [
        'TLS certificate',
        'valid',
        'https://app.charitypilot.ie',
        'https://api.charitypilot.ie',
        'certificate issuer',
        'expiry date',
      ],
      'cors-approved-origins': ['CORS', 'https://app.charitypilot.ie', 'only approved', 'rejected unapproved origin'],
      'security-headers': [
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Content-Security-Policy',
        'Strict-Transport-Security',
        'HSTS max-age',
      ],
    };

    for (const marker of hostingMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
  }

  if (areaId === 'database') {
    const text = evidenceText(actualCheck.evidence);

    const databaseMarkersByCheck = {
      'postgres-provisioned': [
        'production PostgreSQL', 'provisioned', 'sslmode=verify-full', 'sslrootcert=system',
      ],
      'database-url-secret-store': ['DATABASE_URL', 'secret store'],
      'migrations-deployed': ['deploy:production', 'migration image alone', 'production'],
      'backups-enabled': [
        'managed backups or PITR',
        'backup window',
        'retention period',
        'backup owner',
        'PostgreSQL RPO',
        'PostgreSQL RTO',
      ],
      'restore-tested': [
        'restore test',
        'owner',
        'restore date',
        'recovery notes',
        'isolated non-production target',
        'read-only source',
        'production database was not overwritten',
      ],
    };

    for (const marker of databaseMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }

    if (checkId === 'database-check') {
      validateDatabaseRestoreProof(actualCheck, checkPath, issues, finalApprovedAt, validationNow, release);
    }
    if (checkId === 'restore-tested') {
      validateDatabaseRestoreHumanEvidence(actualCheck, actualArea?.checks?.['database-check'], checkPath, issues);
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
      'document-upload-download': ['document upload', 'authenticated API download', 'deployed app'],
      'supabase-backups-enabled': [
        'document object bytes',
        'separate from PostgreSQL backups and PITR',
        'encrypted',
        'versioned',
        'backup schedule',
        'document-object RPO',
        'document-object RTO',
        'retention period',
        'backup owner',
        'monitoring and alerting',
        'secure deletion behavior',
      ],
      'supabase-restore-tested': [
        'joint PostgreSQL metadata and document object-byte restore',
        'owner',
        'restore date',
        'recovery notes',
        'isolated restore target',
        'non-production restore target',
        'production database was not overwritten',
        'production object storage was not overwritten',
        'joint metadata/object reconciliation',
        'SHA-256',
      ],
    };

    for (const marker of supabaseMarkersByCheck[checkId] ?? []) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }

    if (checkId === 'supabase-restore-tested') {
      validateJointRecoveryReconciliation(
        actualCheck,
        checkPath,
        issues,
        finalApprovedAt,
        validationNow,
      );
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
        'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
        'active live recurring Stripe prices',
        'pinned Stripe billing portal configuration',
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

    if (checkId === 'password-recovery-resend-delivery') {
      const recoveryLinkEvidence = requireDistinctEvidenceEntry(
        actualCheck,
        ['deployed recovery-link email', 'Resend accepted'],
        'the deployed Resend recovery-link email',
        [
          'EMAIL_FROM',
          'verified production sender domain',
          'accepted message id or equivalent provider delivery reference',
          'https://app.charitypilot.ie',
          'deterministic HTML and plain-text alternatives',
          'complete fragment link',
          'redacted provider reference',
          'no raw token',
        ],
        checkPath,
        issues,
      );
      const postResetNoticeEvidence = requireDistinctEvidenceEntry(
        actualCheck,
        ['deployed post-reset registered-address notice', 'Resend accepted'],
        'the deployed Resend post-reset registered-address notice',
        [
          'EMAIL_FROM',
          'verified production sender domain',
          'accepted message id or equivalent provider delivery reference',
          'deterministic HTML and plain-text alternatives',
          'redacted provider reference',
          'no raw token',
        ],
        checkPath,
        issues,
      );
      if (
        recoveryLinkEvidence &&
        postResetNoticeEvidence &&
        recoveryLinkEvidence === postResetNoticeEvidence
      ) {
        issues.push(
          `${checkPath}.evidence must keep the deployed recovery-link email and post-reset registered-address notice in two distinct evidence entries`,
        );
      }
      for (const entry of [recoveryLinkEvidence, postResetNoticeEvidence].filter(Boolean)) {
        if (typeof release?.commitSha === 'string') {
          requireEvidenceText(
            evidenceText([entry]),
            release.commitSha,
            `${checkPath}.evidence each deployed Resend proof must include release.commitSha`,
            issues,
          );
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
    if (checkId === 'penetration-test-complete' && typeof release?.commitSha === 'string') {
      requireEvidenceText(text, release.commitSha, `${checkPath}.evidence must include release.commitSha`, issues);
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

  if (areaId === 'jobs' && checkId === 'auth-email-delivery-runtime') {
    const runtimeEvidence = requireDistinctCommandOutputEvidence(
      actualCheck,
      ['deployed authentication email delivery runtime', 'production-scheduler'],
      'the deployed authentication email delivery runtime',
      [
        'node dist/jobs/process-auth-email-delivery.js',
        'digest-pinned API image',
        'same production secret source',
      ],
      checkPath,
      issues,
    );
    const rehearsalEvidence = requireDistinctCommandOutputEvidence(
      actualCheck,
      ['node dist/jobs/process-auth-email-delivery.js', '[AuthEmailDelivery] completed'],
      'the isolated authentication email delivery worker rehearsal',
      [
        'isolated non-production data',
        'recovery control ready',
        'exit 0',
      ],
      checkPath,
      issues,
    );
    if (runtimeEvidence && rehearsalEvidence && runtimeEvidence === rehearsalEvidence) {
      issues.push(
        `${checkPath}.evidence must keep deployed runtime proof and isolated worker rehearsal in two distinct command-output entries`,
      );
    }
    for (const entry of [runtimeEvidence, rehearsalEvidence].filter(Boolean)) {
      if (typeof release?.commitSha === 'string') {
        requireEvidenceText(
          evidenceText([entry]),
          release.commitSha,
          `${checkPath}.evidence each runtime/rehearsal transcript must include release.commitSha`,
          issues,
        );
      }
      if (typeof release?.imageDigestManifest?.apiImage === 'string') {
        requireEvidenceText(
          evidenceText([entry]),
          release.imageDigestManifest.apiImage,
          `${checkPath}.evidence each runtime/rehearsal transcript must include the promoted API image digest`,
          issues,
        );
      }
    }
  }

  if (areaId === 'jobs' && checkId === 'auth-delivery-anomaly-alert') {
    const rehearsalEvidence = requireDistinctCommandOutputEvidence(
      actualCheck,
      ['authentication-delivery anomaly alert rehearsal'],
      'the isolated authentication-delivery anomaly alert rehearsal',
      [
        'isolated non-production data',
        'REJECTED',
        'UNCERTAIN',
        'KEY_UNAVAILABLE',
        'STALE_QUARANTINED',
        'count-only sanitized alert',
        'webhook failure released the claim for retry',
        'stale claim was reclaimed',
        'confirmed webhook response acknowledged the exact claim',
        'unacknowledged rows survived cleanup',
      ],
      checkPath,
      issues,
    );
    const incidentConfirmationEvidence = requireDistinctEvidenceEntry(
      actualCheck,
      ['authentication-delivery anomaly alert', 'incident system confirmation'],
      'the external incident-system confirmation for the authentication-delivery anomaly alert',
      [
        'redacted alert reference',
        'accountable incident owner',
        'no recipient, token, request, account, or secret value',
      ],
      checkPath,
      issues,
    );
    if (
      rehearsalEvidence &&
      incidentConfirmationEvidence &&
      rehearsalEvidence === incidentConfirmationEvidence
    ) {
      issues.push(
        `${checkPath}.evidence must keep the anomaly rehearsal transcript and external incident-system confirmation in two distinct entries`,
      );
    }
    for (const entry of [rehearsalEvidence, incidentConfirmationEvidence].filter(Boolean)) {
      if (typeof release?.commitSha === 'string') {
        requireEvidenceText(
          evidenceText([entry]),
          release.commitSha,
          `${checkPath}.evidence each anomaly rehearsal/confirmation entry must include release.commitSha`,
          issues,
        );
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
      'npm run check:production:browser-qa-env',
      'Deployed browser QA environment preflight passed',
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
      'authenticated API download',
      'logout',
      'error states',
      'pending-navigation confirmation',
      'conditional obligations',
      'readiness blockers',
      'Launch-Critical Route Inventory',
      'every route',
      'desktop, mobile, light-mode, and dark-mode evidence',
      'zero critical or high-severity browser QA defects',
    ];
    for (const marker of requiredMarkers) {
      if (!text.includes(marker)) {
        issues.push(`${checkPath}.evidence must include ${marker}`);
      }
    }
    for (const route of LAUNCH_CRITICAL_ROUTES) {
      if (!hasRouteToken(text, route)) {
        issues.push(`${checkPath}.evidence must include launch route ${route}`);
      }
    }
  }
}

function validateFinalSignoffApprovals(finalSignoff, release, preparedAt, finalApprovedAt, validationNow, issues) {
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
    } else if (finalApprovedAt !== null && approvedAt > finalApprovedAt) {
      issues.push(`${approvalPath}.approvedAt must not be after finalSignoff.approvedAt`);
    } else if (approvedAt > validationNow) {
      issues.push(`${approvalPath}.approvedAt must not be after the validation time`);
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
    if (typeof release?.commitSha === 'string' && !evidenceText(approval.evidence).includes(release.commitSha)) {
      issues.push(`${approvalPath}.evidence must include release.commitSha`);
    }
  }
}

function validateFinalSignoffEvidence(finalSignoff, release, issues) {
  const text = evidenceText(finalSignoff.evidence);
  requireEvidenceText(text, 'launch approval', 'finalSignoff.evidence must include launch approval', issues);
  if (typeof release?.commitSha === 'string') {
    requireEvidenceText(text, release.commitSha, 'finalSignoff.evidence must include release.commitSha', issues);
  }
}

export function validateLaunchEvidence(evidence, { now = Date.now } = {}) {
  const issues = [];

  try {
    if (!isPlainObject(evidence)) {
      return ['evidence file must contain a JSON object'];
    }
  } catch {
    return ['evidence ledger could not be safely inspected'];
  }
  let validationNow;
  try {
    validationNow = now();
  } catch {
    return ['validation time could not be established'];
  }
  if (!Number.isSafeInteger(validationNow)) {
    return ['validation time must be a safe integer timestamp'];
  }
  try {
    if (!validateWholeLedgerSafety(evidence, issues)) return issues;
  } catch {
    return ['evidence ledger could not be safely scanned'];
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
  } else if (preparedAt > validationNow) {
    issues.push('preparedAt must not be after the validation time');
  }
  const finalApprovedAt = isPlainObject(evidence.finalSignoff) ? isoTimestamp(evidence.finalSignoff.approvedAt) : null;
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
        notAfter: finalApprovedAt,
        notAfterLabel: 'finalSignoff.approvedAt',
      });
      validateCheckSpecificEvidence(
        area.id,
        check.id,
        actualCheck,
        actualArea,
        checkPath,
        issues,
        evidence.release,
        finalApprovedAt,
        validationNow,
      );
    }
  }

  const databaseRestoreProof = evidence.areas?.database?.checks?.['database-check']?.databaseRestoreProof;
  const jointRecovery = evidence.areas?.supabaseStorage?.checks?.['supabase-restore-tested']?.jointRecoveryReconciliation;
  if (isPlainObject(databaseRestoreProof) && isPlainObject(jointRecovery)) {
    for (const [field, label] of [
      ['recoverySetId', 'recovery-set identifier'],
      ['databaseDumpSha256', 'database dump SHA-256'],
      ['sourceDatabaseIdentitySha256', 'source database identity SHA-256'],
    ]) {
      if (jointRecovery[field] !== databaseRestoreProof[field]) {
        issues.push(
          `areas.supabaseStorage.checks.supabase-restore-tested.jointRecoveryReconciliation.${field} must match ` +
          `areas.database.checks.database-check.databaseRestoreProof.${field} so both proofs describe the same ${label}`,
        );
      }
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
    } else if (approvedAt > validationNow) {
      issues.push('finalSignoff.approvedAt must not be after the validation time');
    }
    validateEvidenceEntries(evidence.finalSignoff.evidence, 'finalSignoff.evidence', issues, {
      notAfter: approvedAt,
      notAfterLabel: 'finalSignoff.approvedAt',
    });
    validateFinalSignoffEvidence(evidence.finalSignoff, evidence.release, issues);
    validateFinalSignoffApprovals(
      evidence.finalSignoff,
      evidence.release,
      preparedAt,
      approvedAt,
      validationNow,
      issues,
    );
  }

  return issues;
}

function countChecks() {
  return REQUIRED_LAUNCH_AREAS.reduce((total, area) => total + area.checks.length, 0);
}

function completionPercent(completed, total) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((Math.max(0, completed) / total) * 1000) / 10;
}

function countCompletedChecks(evidence) {
  if (!isPlainObject(evidence?.areas)) return 0;

  return REQUIRED_LAUNCH_AREAS.reduce((total, area) => {
    const actualArea = evidence.areas[area.id];
    if (!isPlainObject(actualArea?.checks)) return total;

    return total + area.checks.filter((check) => actualArea.checks[check.id]?.status === 'complete').length;
  }, 0);
}

function countApprovedFinalSignoffRoles(evidence) {
  const approvals = evidence?.finalSignoff?.approvals;
  if (!isPlainObject(approvals)) return 0;

  return FINAL_SIGNOFF_ROLES.filter((role) => approvals[role.id]?.status === 'approved').length;
}

function launchProgress(evidence) {
  const completedChecks = countCompletedChecks(evidence);
  const totalChecks = countChecks();
  const approvedFinalSignoffRoles = countApprovedFinalSignoffRoles(evidence);
  const totalFinalSignoffRoles = FINAL_SIGNOFF_ROLES.length;

  return {
    checklistChecks: {
      completed: completedChecks,
      total: totalChecks,
      percentage: completionPercent(completedChecks, totalChecks),
    },
    finalSignoffRoles: {
      approved: approvedFinalSignoffRoles,
      total: totalFinalSignoffRoles,
      percentage: completionPercent(approvedFinalSignoffRoles, totalFinalSignoffRoles),
    },
  };
}

function statusOf(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'missing';
}

function currentEvidenceHints(areaId, checkId, storedHints) {
  const canonicalHints = defaultEvidenceHints(areaId, checkId);
  const candidates = canonicalHints.length > 0 ? canonicalHints : storedHints;
  return [...new Set(
    candidates
      .filter((hint) => typeof hint === 'string')
      .map((hint) => hint.trim())
      .filter((hint) => hint.length > 0),
  )];
}

function nextIncompleteCheckSummary(evidence) {
  const incompleteChecks = [];
  const incompleteCheckDetails = [];

  for (const area of REQUIRED_LAUNCH_AREAS) {
    const actualArea = evidence?.areas?.[area.id];
    for (const check of area.checks) {
      const actualCheck = actualArea?.checks?.[check.id];
      if (actualCheck?.status === 'complete') continue;

      const path = `${area.id}.${check.id}`;
      const status = statusOf(actualCheck?.status);
      const storedHints = Array.isArray(actualCheck?.requiredEvidenceHints)
        ? actualCheck.requiredEvidenceHints.filter((hint) => typeof hint === 'string' && hint.trim().length > 0)
        : [];
      const requiredEvidenceHints = currentEvidenceHints(area.id, check.id, storedHints);

      incompleteChecks.push(`${path} (${status})`);
      incompleteCheckDetails.push({
        path,
        label: check.label,
        status,
        requiredEvidenceHints,
      });
    }
  }

  return {
    incompleteCheckCount: incompleteChecks.length,
    nextIncompleteChecks: incompleteChecks.slice(0, 10),
    nextIncompleteCheckDetails: incompleteCheckDetails.slice(0, 10),
  };
}

function renderFailureProgress(evidence, evidenceFile) {
  const progress = launchProgress(evidence);

  return [
    `Checklist checks complete: ${progress.checklistChecks.completed} / ${progress.checklistChecks.total} (${progress.checklistChecks.percentage}% complete)`,
    `Final approval roles approved: ${progress.finalSignoffRoles.approved} / ${progress.finalSignoffRoles.total} (${progress.finalSignoffRoles.percentage}% complete)`,
    `Track progress with: npm run check:production:evidence:status -- --evidence-file=${redactLaunchEvidenceTranscript(evidenceFile)}`,
  ];
}

function renderJsonStatus(evidence, issues) {
  const incompleteCheckSummary = nextIncompleteCheckSummary(evidence);
  return `${JSON.stringify(
    {
      ok: issues.length === 0,
      approvedForLaunch: evidence?.approvedForLaunch === true,
      areaCount: REQUIRED_LAUNCH_AREAS.length,
      issueCount: issues.length,
      issues,
      progress: launchProgress(evidence),
      ...incompleteCheckSummary,
    },
    null,
    2,
  )}\n`;
}

export function redactLaunchEvidenceTranscript(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s'")]+/gi, '[redacted-database-url]')
    .replace(
      /\b((?:DATABASE_URL|JWT_SECRET|AUTH_RECOVERY_SECRET|READINESS_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_BILLING_PORTAL_CONFIGURATION_ID|RESEND_API_KEY|SUPABASE_SERVICE_ROLE_KEY|ERROR_ALERT_WEBHOOK_URL|NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY|GITHUB_TOKEN)=)[^\s'")]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]+/g, '[redacted-stripe-key]')
    .replace(/\bwhsec_[A-Za-z0-9_=-]+/g, '[redacted-stripe-webhook-secret]')
    .replace(/\bre_[A-Za-z0-9_=-]+/g, '[redacted-resend-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_=-]+/g, '[redacted-github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_=-]+/g, '[redacted-github-token]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic [redacted]')
    .replace(
      /(\b(?:AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY|SERVICE[_-]?ROLE[_-]?KEY)\s*[=:]\s*["']?)[^\s,"'}\]]+/gi,
      '$1[redacted]',
    )
    .replace(/apikey[=:]\s*[A-Za-z0-9._~+/=-]+/gi, 'apikey=[redacted]')
    .replace(/([?&](?:token|signature|key|apikey|access_token|refresh_token)=)[^&\s'")]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9._%+-]+:[^@\s'")]+@/g, '[redacted-credentials]@');
}

export function runProductionLaunchEvidenceFromArgs(
  args = process.argv.slice(2),
  { now = Date.now, readEvidenceFile = readStableLaunchEvidenceFile } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const evidencePath = resolve(process.cwd(), options.evidenceFile);
  if (!existsSync(evidencePath)) {
    return result(1, '', `Production launch evidence failed: evidence file not found: ${redactLaunchEvidenceTranscript(options.evidenceFile)}\n`);
  }

  let evidence;
  try {
    evidence = readEvidenceFile(evidencePath);
  } catch (error) {
    const safeMessage = error instanceof LaunchEvidenceInputError
      ? error.message
      : 'evidence file could not be read as bounded, stable JSON';
    return result(
      1,
      '',
      `Production launch evidence failed: ${safeMessage}.\n`,
    );
  }

  const issues = validateLaunchEvidence(evidence, { now });
  if (issues.length > 0) {
    if (options.json) {
      return result(1, renderJsonStatus(evidence, issues));
    }

    return result(
      1,
      '',
      [
        `Production launch evidence failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        ...renderFailureProgress(evidence, options.evidenceFile),
        '',
        ...issues.map((issue) => `- ${issue}`),
        '',
      ].join('\n'),
    );
  }

  if (options.json) {
    return result(0, renderJsonStatus(evidence, []));
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
