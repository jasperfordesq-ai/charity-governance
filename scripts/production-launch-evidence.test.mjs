import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const evidenceScriptPath = join(scriptsDir, 'production-launch-evidence.mjs');
const evidenceTemplateScriptPath = join(scriptsDir, 'generate-production-launch-evidence-template.mjs');
const capturedAt = '2026-06-08T12:00:00.000Z';
const validationNow = '2026-06-09T12:00:00.000Z';
const digest = 'a'.repeat(64);
const commitSha = 'b'.repeat(40);
const releaseWorkflowRunUrl = 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/123456789';
const releaseWorkflowFile = '.github/workflows/release-images.yml';
const releaseGitRef = 'refs/heads/master';
const apiImage = `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`;
const webImage = `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`;
const migrationImage = `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`;
const recoveryManifestSha256 = 'c'.repeat(64);
const sourceBindingSha256 = 'd'.repeat(64);
const databaseDumpSha256 = 'e'.repeat(64);
const objectBackupManifestSha256 = 'f'.repeat(64);
const metadataInventorySha256 = '1'.repeat(64);
const restoredMetadataInventorySha256 = '7'.repeat(64);
const objectInventorySha256 = '2'.repeat(64);
const restoredObjectInventorySha256 = '8'.repeat(64);
const storageDeletionInventorySha256 = '9'.repeat(64);
const restoredStorageDeletionInventorySha256 = '0'.repeat(64);
const recoveryEventInventorySha256 = 'a'.repeat(64);
const restoredRecoveryEventInventorySha256 = 'b'.repeat(64);
const reconciliationReportSha256 = '3'.repeat(64);
const sourceCaptureReportSha256 = '4'.repeat(64);
const sourceDatabaseIdentitySha256 = '5'.repeat(64);
const sourceObjectStoreIdentitySha256 = '6'.repeat(64);
const recoveryExerciseId = 'document-recovery-exercise-2026-06-08';
const recoverySetId = 'recovery-set-2026-06-08';
const recoveryConsistencySuccessText =
  'Document recovery reconciliation consistency passed against independently supplied bindings.';
const recoveryProvenanceLimitation =
  'Caller-supplied binding equality proves offline consistency only; it does not authenticate the source exports, source-capture report, provider, or operator provenance.';
const databaseRecoverySetId = recoverySetId;
const databaseSourceIdentitySha256 = sourceDatabaseIdentitySha256;
const databaseRestoreDumpSha256 = databaseDumpSha256;
const databaseDumpDescriptorSha256 = '9'.repeat(64);
const databaseDumpSourceBindingSha256 = 'a'.repeat(64);
const databaseProofReportSha256 = 'b'.repeat(64);
const databaseFingerprintSha256 = 'c'.repeat(64);
const databasePublicSchemaSha256 = 'd'.repeat(64);
const databaseTableMembershipSha256 = 'e'.repeat(64);
const databaseSnapshotIdSha256 = 'f'.repeat(64);
const isolatedRestoreDatabaseIdentitySha256 = '0'.repeat(64);
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
const databaseWorkloadSafety = {
  tempFileLimitBytes: '1073741824',
  maxPublicTables: 5000,
  maxRowsPerTable: 25000000,
  maxTotalRows: 100000000,
  maxFingerprintReportBytes: 16777216,
  maxDumpBytes: '68719476736',
  statementTimeoutMs: 1800000,
  lockTimeoutMs: 30000,
  idleTransactionTimeoutMs: 2640000,
};
const databaseCapacityPreflight = {
  method: 'pg-database-size-factor-margin/v1',
  sourceDatabaseSizeBytes: '1048576',
  safetyFactor: 2,
  safetyMarginBytes: '1073741824',
  requiredAvailableBytes: '1075838976',
  maximumDumpBytes: '68719476736',
  verified: true,
};
const databaseEnvironment = {
  encoding: 'UTF8',
  collation: 'en_US.utf8',
  ctype: 'en_US.utf8',
  localeProvider: 'libc',
  collationVersion: null,
};
const databaseHelperImplementation = {
  format: 'charitypilot-postgres-proof-helper/v1',
  repositoryUrl: 'https://github.com/jasperfordesq-ai/charity-governance',
  commitSha,
  sourcePath: 'scripts/postgres-backup.mjs',
  sourceSha256: '8'.repeat(64),
  commitSourceSha256: '8'.repeat(64),
  sourceMatchesCommit: true,
  canonicalRepositoryMatched: true,
};
const databaseSchemaCertificationScope = {
  certifiedSchemas: ['public'],
  certifiedDataClasses: [
    'ordinary-table-rows',
    'partitioned-table-own-rows',
    'materialized-view-rows',
  ],
  certifiedObjectClasses: [
    'relations',
    'columns',
    'constraints',
    'indexes',
    'triggers',
    'row-security-policies',
    'routines-and-bodies',
    'types-domains-enums-and-ranges',
    'sequence-definitions-and-owned-by-relations',
    'extended-statistics',
    'user-rules',
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
};
const launchCriticalRoutes = [
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

function databaseRestoreProof() {
  return {
    format: 'charitypilot-postgres-restore-proof/v2',
    checksumAlgorithm: 'sha256',
    expectedReleaseCommitSha: commitSha,
    helperImplementation: structuredClone(databaseHelperImplementation),
    toolsImageReference: approvedDatabaseToolsImageReference,
    toolsImageDigestSha256: approvedDatabaseToolsImageDigestSha256,
    recoverySetId: databaseRecoverySetId,
    capturedAt,
    expectedSourceDatabaseIdentitySha256: databaseSourceIdentitySha256,
    sourceDatabaseIdentitySha256: databaseSourceIdentitySha256,
    sourceIdentityBindingMatched: true,
    databaseDumpSha256: databaseRestoreDumpSha256,
    databaseDumpBytes: '4096',
    capacityPreflight: { ...databaseCapacityPreflight },
    dumpDescriptorSha256: databaseDumpDescriptorSha256,
    dumpSourceBindingSha256: databaseDumpSourceBindingSha256,
    proofReportSha256: databaseProofReportSha256,
    sourceDatabaseFingerprintSha256: databaseFingerprintSha256,
    restoredDatabaseFingerprintSha256: databaseFingerprintSha256,
    sourceDatabaseEnvironment: { ...databaseEnvironment },
    restoredDatabaseEnvironment: { ...databaseEnvironment },
    restoreTargetDatabaseEnvironment: { ...databaseEnvironment },
    restoreInitializedFromSourceDatabaseEnvironment: true,
    databaseEnvironmentPreserved: true,
    databaseEnvironmentMatched: true,
    publicSchemaSha256: databasePublicSchemaSha256,
    tableMembershipSha256: databaseTableMembershipSha256,
    snapshotIdSha256: databaseSnapshotIdSha256,
    isolatedRestoreDatabaseIdentitySha256,
    tablesCompared: 24,
    mismatchCount: 0,
    sequenceStateIncluded: false,
    sequenceDefinitionAndOwnershipBound: true,
    publicSequenceCount: 0,
    applicationIdentityColumnCount: 0,
    applicationSequenceDefaultCount: 0,
    sequenceStateExclusionReason: databaseSequenceStateExclusionReason,
    ownershipIncluded: false,
    ownershipExclusionReason: databaseOwnershipExclusionReason,
    aclPrivilegesIncluded: false,
    aclPrivilegesExclusionReason: databaseAclPrivilegesExclusionReason,
    workloadSafety: { ...databaseWorkloadSafety },
    schemaCoverage: {
      publicObjectCount: 180,
      unsupportedPublicObjectCount: 0,
      publicSequenceCount: 0,
      applicationIdentityColumnCount: 0,
      applicationSequenceDefaultCount: 0,
      largeObjectCount: 0,
    },
    schemaCertificationScope: structuredClone(databaseSchemaCertificationScope),
    backupArtifactsRetained: true,
    snapshotBound: true,
    sourceReadOnlyVerified: true,
    sourceTlsServerAuthenticationVerified: true,
    sourceAndIsolatedRestoreFingerprintsMatch: true,
    productionWritten: false,
    secretValuesPrinted: false,
    provenanceLimitation: databaseRestoreProofProvenanceLimitation,
  };
}

function databaseIdentityCapturePayload(proof = databaseRestoreProof()) {
  return {
    format: 'charitypilot-postgres-source-identity/v2',
    ok: true,
    mode: 'capture-source-identity',
    checksumAlgorithm: 'sha256',
    expectedReleaseCommitSha: commitSha,
    helperImplementation: structuredClone(databaseHelperImplementation),
    toolsImageReference: approvedDatabaseToolsImageReference,
    toolsImageDigestSha256: approvedDatabaseToolsImageDigestSha256,
    sourceDatabaseIdentitySha256: proof.expectedSourceDatabaseIdentitySha256,
    sourceReadOnlyVerified: true,
    sourceTlsServerAuthenticationVerified: true,
    restoreProofVerified: false,
    productionWritten: false,
    secretValuesPrinted: false,
    provenanceLimitation: databaseSourceIdentityProvenanceLimitation,
  };
}

function databaseRestoreProofPayload(proof = databaseRestoreProof()) {
  return {
    format: proof.format,
    ok: true,
    mode: 'prove-restore',
    proof: 'snapshot-bound-read-only-source-restored-sha256-reconciliation',
    ...proof,
  };
}

function databaseIdentityCaptureCommand() {
  return `npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json --expected-release-commit-sha=${commitSha}`;
}

function databaseProofCommand(proof = databaseRestoreProof()) {
  return [
    'npm run check:production:database -- --production-env-file=.env.production',
    `--expected-release-commit-sha=${proof.expectedReleaseCommitSha}`,
    `--recovery-set-id=${proof.recoverySetId}`,
    `--expected-source-database-identity-sha256=${proof.expectedSourceDatabaseIdentitySha256}`,
    '--backup-output-dir=/mnt/encrypted/charitypilot/recovery/RECOVERY_SET_ID',
    '--keep-backup',
    '--json',
  ].join(' ');
}

function databaseEvidenceEntries() {
  const proof = databaseRestoreProof();
  return [
    {
      type: 'command-output',
      reference: 'https://evidence.charitypilot.ie/launch/database/source-identity',
      description: `${databaseIdentityCaptureCommand()} ${JSON.stringify(databaseIdentityCapturePayload(proof))}`,
      capturedAt,
    },
    {
      type: 'command-output',
      reference: 'https://evidence.charitypilot.ie/launch/database/restore-proof',
      description: `${databaseProofCommand(proof)} ${JSON.stringify(databaseRestoreProofPayload(proof))}`,
      capturedAt,
    },
    {
      type: 'report',
      reference: 'https://evidence.charitypilot.ie/launch/database/retained-restore-proof',
      description: [
        `recoverySetId=${proof.recoverySetId}`,
        `databaseDumpSha256=${proof.databaseDumpSha256}`,
        `proofReportSha256=${proof.proofReportSha256}`,
        `sourceDatabaseFingerprintSha256=${proof.sourceDatabaseFingerprintSha256}`,
        `restoredDatabaseFingerprintSha256=${proof.restoredDatabaseFingerprintSha256}`,
      ].join(' '),
      capturedAt,
    },
  ];
}

function jointRecoveryReconciliation() {
  return {
    manifestFormat: 'charitypilot-document-recovery-manifest-v1',
    checksumAlgorithm: 'sha256',
    recoveryManifestSha256,
    sourceBindingSha256,
    sourceCaptureReportSha256,
    sourceDatabaseIdentitySha256,
    sourceObjectStoreIdentitySha256,
    databaseDumpSha256,
    objectBackupManifestSha256,
    sourceMetadataInventorySha256: metadataInventorySha256,
    restoredMetadataInventorySha256,
    sourceObjectInventorySha256: objectInventorySha256,
    restoredObjectInventorySha256,
    sourceStorageDeletionInventorySha256: storageDeletionInventorySha256,
    restoredStorageDeletionInventorySha256,
    sourceRecoveryEventInventorySha256: recoveryEventInventorySha256,
    restoredRecoveryEventInventorySha256,
    reconciliationReportSha256,
    exerciseId: recoveryExerciseId,
    recoverySetId,
    metadataRowCount: 2,
    expectedObjectCount: 2,
    restoredObjectCount: 2,
    matchedObjectCount: 2,
    missingObjectCount: 0,
    unexpectedObjectCount: 0,
    orphanExpectedObjectCount: 0,
    orphanRestoredObjectCount: 0,
    checksumMismatchCount: 0,
    expectedBytes: 4096,
    restoredBytes: 4096,
    storageDeletionCount: 1,
    pendingStorageDeletionCount: 0,
    deadLetterStorageDeletionCount: 0,
    processedStorageDeletionCount: 1,
    restoredStorageDeletionCount: 1,
    restoredPendingStorageDeletionCount: 0,
    restoredDeadLetterStorageDeletionCount: 0,
    restoredProcessedStorageDeletionCount: 1,
    recoveryEventCount: 1,
    restoredRecoveryEventCount: 1,
    processedDeletionObjectResidueCount: 0,
    sourceMetadataCapturedAt: capturedAt,
    restoredMetadataCapturedAt: capturedAt,
    sourceObjectInventoryCapturedAt: capturedAt,
    restoredObjectInventoryCapturedAt: capturedAt,
    sourceMetadataCaptureTransactionId: '2001',
    restoredMetadataCaptureTransactionId: '3001',
    documentProofOldestCapturedAt: capturedAt,
    documentProofAgeMinutes: 0,
    maximumDocumentProofAgeMinutes: 1440,
    documentProofFreshThroughAt: validationNow,
    documentProofFresh: true,
    restoreTargetType: 'isolated-non-production',
    isolationAttestationRecorded: true,
    productionDatabaseNotOverwrittenAttestationRecorded: true,
    productionObjectStoreNotOverwrittenAttestationRecorded: true,
    restoreCredentialsScopedToTargetAttestationRecorded: true,
    objectives: {
      database: {
        rpoObjectiveMinutes: 60,
        achievedRpoMinutes: 15,
        rtoObjectiveMinutes: 120,
        achievedRtoMinutes: 45,
        met: true,
      },
      documentBytes: {
        rpoObjectiveMinutes: 60,
        achievedRpoMinutes: 15,
        rtoObjectiveMinutes: 120,
        achievedRtoMinutes: 50,
        met: true,
      },
    },
    reconciledAt: capturedAt,
    ownerRecorded: true,
    recoveryOperatorRecorded: true,
    notesRecorded: true,
    externalEvidenceReferencesRecorded: true,
    independentBindingArgumentsMatched: true,
    sourceProvenanceExternallyVerified: false,
    provenanceLimitation: recoveryProvenanceLimitation,
    secretValuesPrinted: false,
    reconciledBy: 'Recovery operator',
  };
}

function recoveryVerifierCommand(reconciliation) {
  return [
    'npm run check:production:document-recovery --',
    '--manifest-file=.charitypilot-launch-evidence/document-recovery-manifest.json',
    `--expected-recovery-manifest-sha256=${reconciliation.recoveryManifestSha256}`,
    `--expected-source-binding-sha256=${reconciliation.sourceBindingSha256}`,
    `--expected-source-capture-report-sha256=${reconciliation.sourceCaptureReportSha256}`,
    `--expected-source-database-identity-sha256=${reconciliation.sourceDatabaseIdentitySha256}`,
    `--expected-source-object-store-identity-sha256=${reconciliation.sourceObjectStoreIdentitySha256}`,
    `--expected-database-dump-sha256=${reconciliation.databaseDumpSha256}`,
    `--expected-object-backup-manifest-sha256=${reconciliation.objectBackupManifestSha256}`,
    `--expected-metadata-inventory-sha256=${reconciliation.sourceMetadataInventorySha256}`,
    `--expected-object-inventory-sha256=${reconciliation.sourceObjectInventorySha256}`,
    `--expected-restored-metadata-inventory-sha256=${reconciliation.restoredMetadataInventorySha256}`,
    `--expected-restored-object-inventory-sha256=${reconciliation.restoredObjectInventorySha256}`,
    `--expected-storage-deletion-inventory-sha256=${reconciliation.sourceStorageDeletionInventorySha256}`,
    `--expected-restored-storage-deletion-inventory-sha256=${reconciliation.restoredStorageDeletionInventorySha256}`,
    `--expected-recovery-event-inventory-sha256=${reconciliation.sourceRecoveryEventInventorySha256}`,
    `--expected-restored-recovery-event-inventory-sha256=${reconciliation.restoredRecoveryEventInventorySha256}`,
    `--expected-production-document-count=${reconciliation.metadataRowCount}`,
    `--expected-storage-deletion-count=${reconciliation.storageDeletionCount}`,
    `--expected-pending-storage-deletion-count=${reconciliation.pendingStorageDeletionCount}`,
    `--expected-dead-letter-storage-deletion-count=${reconciliation.deadLetterStorageDeletionCount}`,
    `--expected-processed-storage-deletion-count=${reconciliation.processedStorageDeletionCount}`,
    `--expected-recovery-event-count=${reconciliation.recoveryEventCount}`,
    `--expected-source-metadata-captured-at=${reconciliation.sourceMetadataCapturedAt}`,
    `--expected-restored-metadata-captured-at=${reconciliation.restoredMetadataCapturedAt}`,
    `--expected-source-object-inventory-captured-at=${reconciliation.sourceObjectInventoryCapturedAt}`,
    `--expected-restored-object-inventory-captured-at=${reconciliation.restoredObjectInventoryCapturedAt}`,
    `--expected-source-metadata-capture-transaction-id=${reconciliation.sourceMetadataCaptureTransactionId}`,
    `--expected-restored-metadata-capture-transaction-id=${reconciliation.restoredMetadataCaptureTransactionId}`,
    `--expected-maximum-document-proof-age-minutes=${reconciliation.maximumDocumentProofAgeMinutes}`,
    `--expected-exercise-id=${reconciliation.exerciseId}`,
    `--expected-recovery-set-id=${reconciliation.recoverySetId}`,
    '--json',
  ].join(' ');
}

function recoveryVerifierJson(reconciliation) {
  const verifierOutput = { ...reconciliation };
  delete verifierOutput.reconciledBy;
  return JSON.stringify({ ok: true, ...verifierOutput });
}

async function loadEvidenceRunner() {
  assert.ok(existsSync(evidenceScriptPath), 'production launch evidence script must exist');
  const module = await import(pathToFileURL(evidenceScriptPath).href);
  assert.equal(typeof module.runProductionLaunchEvidenceFromArgs, 'function');
  assert.ok(Array.isArray(module.REQUIRED_LAUNCH_AREAS));
  return {
    ...module,
    runProductionLaunchEvidenceFromArgs: (args, dependencies = {}) =>
      module.runProductionLaunchEvidenceFromArgs(args, {
        now: () => Date.parse(validationNow),
        ...dependencies,
      }),
  };
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

  if (areaId === 'database' && checkId === 'postgres-provisioned') {
    entry.description = [
      'production PostgreSQL database provisioned on the approved managed provider.',
      'The runtime DATABASE_URL requires TLS.',
      'The proof-only derived URL uses sslmode=verify-full and sslrootcert=system.',
    ].join(' ');
  }

  if (areaId === 'database' && checkId === 'database-url-secret-store') {
    entry.description = 'DATABASE_URL is stored only in the production secret store.';
  }

  if (areaId === 'database' && checkId === 'migrations-deployed') {
    entry.type = 'command-output';
    entry.description = 'npm run deploy:production completed with the migration image alone against production.';
  }

  if (areaId === 'database' && checkId === 'backups-enabled') {
    entry.description = [
      'managed backups or PITR are enabled for the production PostgreSQL database.',
      'backup window, retention period, and backup owner are recorded outside git.',
      'PostgreSQL RPO is 60 minutes and PostgreSQL RTO is 120 minutes.',
    ].join(' ');
  }

  if (areaId === 'database' && checkId === 'restore-tested') {
    const proof = databaseRestoreProof();
    entry.description = [
      'restore test evidence has an accountable owner, restore date, and recovery notes.',
      'The read-only source was restored only to an isolated non-production target, and the production database was not overwritten.',
      `recoverySetId=${proof.recoverySetId}`,
      `proofReportSha256=${proof.proofReportSha256}`,
    ].join(' ');
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

  if (areaId === 'secretsAndEnv' && checkId === 'supabase-api-only') {
    entry.description = 'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET are available to API/server runtimes only.';
  }

  if (areaId === 'secretsAndEnv' && checkId === 'web-compose-api-origin') {
    entry.description = 'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL matches NEXT_PUBLIC_API_URL in the production secret source.';
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

  if (areaId === 'releaseGate' && checkId === 'github-environment') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:github-env -- --environment=production',
      'Production GitHub environment check passed: production has the required release-image public API variable; secret values were not read.',
      'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'github-secret-store') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:github-secrets -- --environment=production',
      'Production GitHub secret-store check passed: production has 8 required secret name(s); secret values were not read.',
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
    entry.description =
      'DNS owner is the approved owner for charitypilot.ie production records. DNS record evidence covers app.charitypilot.ie and api.charitypilot.ie.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'tls-certificates') {
    entry.description =
      'TLS certificate evidence confirms valid certificates for https://app.charitypilot.ie and https://api.charitypilot.ie with certificate issuer and expiry date recorded.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'cors-approved-origins') {
    entry.description = 'CORS allows https://app.charitypilot.ie and rejected unapproved origin probes; only approved origins pass.';
  }

  if (areaId === 'hostingDnsTls' && checkId === 'security-headers') {
    entry.description = [
      'API response headers include X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, and Strict-Transport-Security.',
      'HSTS max-age is recorded in the hosting evidence.',
    ].join(' ');
  }

  if (areaId === 'supabaseStorage' && checkId === 'supabase-check') {
    entry.type = 'command-output';
    entry.description = [
      'npm run check:production:supabase -- --production-env-file=.env.production',
      'Production Supabase storage check passed: private bucket, service-role upload and download, anonymous access denial, and probe cleanup verified.',
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
    entry.description = 'document upload and authenticated API download were verified through the deployed app.';
  }

  if (areaId === 'supabaseStorage' && checkId === 'supabase-backups-enabled') {
    entry.description = [
      'The document object bytes use an encrypted, versioned backup separate from PostgreSQL backups and PITR.',
      'The backup schedule, document-object RPO, document-object RTO, retention period, and backup owner are recorded outside git.',
      'Backup monitoring and alerting plus secure deletion behavior are documented and owned.',
    ].join(' ');
  }

  if (areaId === 'supabaseStorage' && checkId === 'supabase-restore-tested') {
    const reconciliation = jointRecoveryReconciliation();
    entry.type = 'command-output';
    entry.description = [
      recoveryVerifierCommand(reconciliation),
      'The joint PostgreSQL metadata and document object-byte restore has an accountable owner, restore date, and recovery notes.',
      'It used an isolated restore target and non-production restore target; the production database was not overwritten and production object storage was not overwritten.',
      'The joint metadata/object reconciliation used SHA-256 and charitypilot-document-recovery-manifest-v1.',
      recoveryConsistencySuccessText,
      recoveryVerifierJson(reconciliation),
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

  if (areaId === 'billingAndEmail' && checkId === 'stripe-products-prices') {
    entry.description = [
      'Stripe product and price evidence confirms active live recurring Stripe prices for:',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID',
      'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
      'pinned Stripe billing portal configuration',
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
    entry.description = [
      'privacy policy approved for production by the accountable legal/compliance owner.',
      'policy version, effective date, and privacy approver are recorded outside git.',
    ].join(' ');
  }

  if (areaId === 'legalAndCompliance' && checkId === 'terms-approved') {
    entry.description = [
      'terms or service agreement approved for production by the accountable legal/compliance owner.',
      'terms version and effective date are recorded outside git.',
    ].join(' ');
  }

  if (areaId === 'legalAndCompliance' && checkId === 'retention-policy-approved') {
    entry.description = [
      'data retention policy approved for production by the accountable legal/compliance owner.',
      'retention schedule and deletion workflow evidence are recorded outside git.',
    ].join(' ');
  }

  if (areaId === 'legalAndCompliance' && checkId === 'support-deletion-contact') {
    entry.description = 'support contact and data deletion contact published for production users at the published URL with support mailbox evidence.';
  }

  if (areaId === 'legalAndCompliance' && checkId === 'solicitor-governance-privacy-review') {
    entry.description = [
      'solicitor review, governance review, and privacy review completed for production wording.',
      'named solicitor, named governance reviewer, named privacy reviewer, and review date are recorded outside git.',
      'Review confirms CharityPilot remains review-ready, source-cited, and not a substitute for legal advice.',
    ].join(' ');
  }

  if (areaId === 'securityReview' && checkId === 'penetration-test-complete') {
    entry.description = [
      'external penetration test by named testing provider completed before real charity data.',
      'testing scope covered https://app.charitypilot.ie and https://api.charitypilot.ie at the release commit under review.',
      `Promoted release commit: ${commitSha}.`,
    ].join(' ');
  }

  if (areaId === 'securityReview' && checkId === 'critical-high-findings') {
    entry.description = [
      'critical and high findings were remediated or formally accepted by the accountable owner.',
      'finding tracker, risk acceptance approver, and acceptance date are recorded outside git.',
    ].join(' ');
  }

  if (areaId === 'securityReview' && checkId === 'retest-evidence') {
    entry.description = 'retest evidence exists for fixed findings from the external penetration test, with retest date and retest result recorded.';
  }

  if (areaId === 'securityReview' && checkId === 'report-reference') {
    entry.description = 'penetration test report reference stored outside git in the approved evidence vault, with report version and report date recorded.';
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
      'npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers',
      'compose.production.yml and compose.production-tls.yml were used for the production deploy.',
      'release-image-digests.env supplied digest-pinned images for API, web, and migration services.',
      'The old runtime stopped before migration and a retained restore-verified backup completed.',
      'The migration image alone completed, followed by the live migration-history probe.',
      'The quiesced reminder cutover preparation completed with zero unresolved reminder outcomes.',
      'The host-wide production cutover lock covered preflight through smoke.',
      'Production deploy preflight passed: env, compose config, and image signatures verified.',
      'Production deploy smoke passed: public web, API health, CORS, and keyed readiness verified.',
      'Production compose deploy completed.',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'deploy-smoke') {
    entry.type = 'command-output';
    entry.description = [
      'npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers',
      'node scripts/smoke-production-deploy.mjs --production-env-file .env.production',
      'Production deploy smoke passed: public web, API health, CORS, and keyed readiness verified.',
      'Web origin: https://app.charitypilot.ie',
      'API origin: https://api.charitypilot.ie',
    ].join(' ');
  }

  if (areaId === 'releaseGate' && checkId === 'deploy-rollback') {
    entry.type = 'command-output';
    entry.description = [
      'npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env --schema-compatibility-attestation-file=/secure/schema-compatibility-attestation.json --backup-output-dir=/secure/charitypilot/rollback-cutovers',
      'Rollback used the previous signed digest manifest release-image-digests.previous.env.',
      'The live migration-history probe passed before the rollback runtime started.',
      'The host-wide production cutover lock covered rollback validation and delegated deploy.',
      'Production compose rollback completed.',
      'Production deploy smoke passed after rollback.',
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
      'CHARITYPILOT_DATABASE_COMPATIBILITY=p006-deadline-calendar-v1',
      'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
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
      `Browser QA release commit: ${commitSha}.`,
      'npm run check:production:browser-qa-env',
      'Deployed browser QA environment preflight passed.',
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
      `Browser QA release commit: ${commitSha}.`,
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
      `Browser QA release commit: ${commitSha}.`,
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
      `Browser QA release commit: ${commitSha}.`,
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
      `Browser QA release commit: ${commitSha}.`,
      'E2E_DEPLOYED_QA=true',
      'npm run test:e2e:deployed:responsive:cross-browser completed against deployed HTTPS production URL.',
      'npm run test:e2e:deployed:accessibility:cross-browser completed against deployed HTTPS production URL.',
      'Projects covered: deployed-chromium-desktop, deployed-chromium-mobile, deployed-firefox-desktop, deployed-webkit-desktop.',
    ].join(' ');
  }

  if (areaId === 'browserQa' && checkId === 'ios-safari-device-coverage') {
    entry.description = [
      `Browser QA release commit: ${commitSha}.`,
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
      'docs/production-browser-qa.md recorded auth flow, dashboard flow, billing flow, document upload, authenticated API download, logout, error states, pending-navigation confirmation, conditional obligations, and readiness blockers.',
      'Launch-Critical Route Inventory completed across every route in desktop, mobile, light-mode, and dark-mode evidence.',
      `Browser QA release commit: ${commitSha}.`,
      `Routes covered: ${launchCriticalRoutes.join(', ')}.`,
      'zero critical or high-severity browser QA defects remain unresolved.',
    ].join(' ');
  }

  return entry;
}

function evidenceEntries(areaId, checkId) {
  if (areaId === 'database' && checkId === 'database-check') {
    return databaseEvidenceEntries();
  }
  const entries = [evidenceEntry(areaId, checkId)];
  if (areaId === 'supabaseStorage' && checkId === 'supabase-restore-tested') {
    const reconciliation = jointRecoveryReconciliation();
    entries.push({
      type: 'report',
      reference: 'https://evidence.charitypilot.ie/launch/storage/joint-document-recovery-report',
      description: [
        'Machine-readable joint metadata/object reconciliation report.',
        'charitypilot-document-recovery-manifest-v1',
        ...[
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
        ].map((field) => `${field}=${reconciliation[field]}`),
        `exerciseId=${reconciliation.exerciseId}`,
        `recoverySetId=${reconciliation.recoverySetId}`,
        `sourceMetadataCaptureTransactionId=${reconciliation.sourceMetadataCaptureTransactionId}`,
        `restoredMetadataCaptureTransactionId=${reconciliation.restoredMetadataCaptureTransactionId}`,
      ].join(' '),
      capturedAt,
    });
  }
  return entries;
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
            evidence: evidenceEntries(area.id, check.id),
            ...(area.id === 'database' && check.id === 'database-check'
              ? { databaseRestoreProof: databaseRestoreProof() }
              : {}),
            ...(area.id === 'supabaseStorage' && check.id === 'supabase-restore-tested'
              ? { jointRecoveryReconciliation: jointRecoveryReconciliation() }
              : {}),
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
              description: `Engineering owner launch approval for release ${commitSha}`,
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
              description: `Operations owner launch approval for release ${commitSha}`,
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
              description: `Security owner launch approval for release ${commitSha}`,
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
              description: `Legal/compliance owner launch approval for release ${commitSha}`,
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
              description: `Business owner launch approval for release ${commitSha}`,
              capturedAt,
            },
          ],
        },
      },
      evidence: [
        {
          type: 'approval',
          reference: 'https://evidence.charitypilot.ie/launch/final-signoff/approval',
          description: `Accountable owner launch approval for release ${commitSha}`,
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

function writeRawEvidenceFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-launch-evidence-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  writeFileSync(evidencePath, content);
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
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const jointRecovery = evidence.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation;
  assert.notEqual(
    jointRecovery.recoveryManifestSha256,
    jointRecovery.reconciliationReportSha256,
    'the recovery manifest and domain-separated reconciliation report must retain independent digests',
  );
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production launch evidence passed/);
    assert.match(result.stdout, /11 area\(s\)/);
    assert.match(result.stdout, /86 check\(s\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence tolerates deprecated public Supabase fields from older ledgers', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.release.imageDigestManifest.webBuildNextPublicSupabaseUrl = 'https://legacy-project.supabase.co';
  evidence.areas.secretsAndEnv.checks['supabase-public-origin'] = {
    status: 'complete',
    evidence: [evidenceEntry('secretsAndEnv', 'supabase-public-origin')],
  };
  evidence.areas.secretsAndEnv.checks['web-compose-supabase-origin'] = {
    status: 'complete',
    evidence: [evidenceEntry('secretsAndEnv', 'web-compose-supabase-origin')],
  };
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator renders machine-readable JSON status', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const completeFile = writeEvidenceFile(completeEvidence(REQUIRED_LAUNCH_AREAS));
  const incomplete = completeEvidence(REQUIRED_LAUNCH_AREAS);
  incomplete.approvedForLaunch = false;
  incomplete.areas.releaseGate.checks['check-production'].status = 'pending';
  incomplete.areas.releaseGate.checks['check-production'].evidence = [];
  incomplete.areas.releaseGate.checks['check-production'].requiredEvidenceHints = [
    'obsolete stored production-check guidance',
  ];
  incomplete.finalSignoff.approvals.engineering.status = 'pending';
  const incompleteFile = writeEvidenceFile(incomplete);

  try {
    const failed = runProductionLaunchEvidenceFromArgs(['--json', '--evidence-file', incompleteFile.evidencePath]);
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr, '');
    const failurePayload = JSON.parse(failed.stdout);
    assert.equal(failurePayload.ok, false);
    assert.equal(failurePayload.approvedForLaunch, false);
    assert.equal(failurePayload.issueCount, failurePayload.issues.length);
    assert.ok(failurePayload.issueCount > 0);
    assert.deepEqual(failurePayload.nextIncompleteChecks.slice(0, 1), ['releaseGate.check-production (pending)']);
    assert.deepEqual(failurePayload.nextIncompleteCheckDetails.slice(0, 1), [
      {
        path: 'releaseGate.check-production',
        label: 'production env validation completed against real secrets',
        status: 'pending',
        requiredEvidenceHints: [
          'npm run check:production -- --production-env-file=.env.production',
          'Production preflight passed',
        ],
      },
    ]);
    assert.equal(failurePayload.incompleteCheckCount, 1);
    assert.deepEqual(failurePayload.progress, {
      checklistChecks: {
        completed: 85,
        total: 86,
        percentage: 98.8,
      },
      finalSignoffRoles: {
        approved: 4,
        total: 5,
        percentage: 80,
      },
    });

    const passed = runProductionLaunchEvidenceFromArgs(['--json', '--evidence-file', completeFile.evidencePath]);
    assert.equal(passed.status, 0);
    assert.equal(passed.stderr, '');
    const successPayload = JSON.parse(passed.stdout);
    assert.equal(successPayload.ok, true);
    assert.equal(successPayload.approvedForLaunch, true);
    assert.equal(successPayload.issueCount, 0);
    assert.deepEqual(successPayload.issues, []);
    assert.deepEqual(successPayload.progress, {
      checklistChecks: {
        completed: 86,
        total: 86,
        percentage: 100,
      },
      finalSignoffRoles: {
        approved: 5,
        total: 5,
        percentage: 100,
      },
    });
  } finally {
    rmSync(completeFile.tempDir, { recursive: true, force: true });
    rmSync(incompleteFile.tempDir, { recursive: true, force: true });
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

test('production launch evidence validator accepts evidence gathered after package preparation but before final approval', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.preparedAt = '2026-06-01T09:00:00.000Z';
  evidence.areas.releaseGate.checks.test.evidence[0].capturedAt = '2026-06-08T12:00:00.000Z';
  evidence.finalSignoff.approvedAt = '2026-06-09T12:00:00.000Z';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production launch evidence passed/);
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

test('production launch evidence requires an independent read-only source identity capture before restore proof', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.database.checks['database-check'];
  check.evidence = check.evidence.filter((entry) => !entry.description.includes('--capture-source-identity'));
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /database-check\.evidence must include exactly one source-identity command-output entry/);
    assert.match(result.stderr, /source-identity entry must contain exactly one allowlisted JSON payload/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects marker-only database proof and missing retained report evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.database.checks['database-check'];
  const proofEntry = check.evidence.find(
    (entry) => entry.type === 'command-output' && entry.description.includes('--recovery-set-id='),
  );
  proofEntry.description = `${databaseProofCommand()} Production database restore proof passed.`;
  check.evidence = check.evidence.filter((entry) => entry.type !== 'report');
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /prove-restore entry must contain exactly one allowlisted JSON success payload/);
    assert.match(result.stderr, /must include report evidence bound to the recovery set, dump, proof report, and both fingerprints/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects mismatched database flags, digests, and recovery identities', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.database.checks['database-check'];
  const proof = check.databaseRestoreProof;
  const proofEntry = check.evidence.find(
    (entry) => entry.type === 'command-output' && entry.description.includes('--recovery-set-id='),
  );
  const captureEntry = check.evidence.find(
    (entry) => entry.type === 'command-output' && entry.description.includes('--capture-source-identity'),
  );
  proofEntry.description = proofEntry.description
    .replace(`--expected-release-commit-sha=${commitSha}`, `--expected-release-commit-sha=${'0'.repeat(40)}`)
    .replace(`--recovery-set-id=${databaseRecoverySetId}`, '--recovery-set-id=different-recovery-set')
    .replace(databaseSourceIdentitySha256, '1'.repeat(64));
  captureEntry.description = captureEntry.description.replace(databaseSourceIdentitySha256, '4'.repeat(64));
  proof.sourceDatabaseIdentitySha256 = '2'.repeat(64);
  proof.restoredDatabaseFingerprintSha256 = '3'.repeat(64);
  proof.isolatedRestoreDatabaseIdentitySha256 = proof.sourceDatabaseIdentitySha256;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /expectedSourceDatabaseIdentitySha256 must match sourceDatabaseIdentitySha256/);
    assert.match(result.stderr, /sourceDatabaseFingerprintSha256 must match restoredDatabaseFingerprintSha256/);
    assert.match(result.stderr, /isolatedRestoreDatabaseIdentitySha256 must be distinct/);
    assert.match(result.stderr, /prove-restore command must bind --expected-release-commit-sha/);
    assert.match(result.stderr, /prove-restore command must bind --recovery-set-id/);
    assert.match(result.stderr, /source-identity JSON must exactly bind the read-only captured identity/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects duplicate, unknown, and weakening database checker options', async () => {
  const { validateLaunchEvidence, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const mutations = [
    {
      label: 'duplicate source binding',
      mutate(evidence) {
        const entry = evidence.areas.database.checks['database-check'].evidence.find(
          (candidate) => candidate.type === 'command-output' && candidate.description.includes('--recovery-set-id='),
        );
        const token = `--expected-source-database-identity-sha256=${databaseSourceIdentitySha256}`;
        entry.description = entry.description.replace(token, `${token} ${token}`);
      },
      issue: /prove-restore command must include --expected-source-database-identity-sha256 exactly once/,
    },
    {
      label: 'unknown option',
      mutate(evidence) {
        const entry = evidence.areas.database.checks['database-check'].evidence.find(
          (candidate) => candidate.type === 'command-output' && candidate.description.includes('--recovery-set-id='),
        );
        entry.description = entry.description.replace(' --json {', ' --json --attacker-unknown-flag=enabled {');
      },
      issue: /prove-restore command contains unsupported option --attacker-unknown-flag/,
    },
    {
      label: 'weakening capture mode',
      mutate(evidence) {
        const entry = evidence.areas.database.checks['database-check'].evidence.find(
          (candidate) => candidate.type === 'command-output' && candidate.description.includes('--recovery-set-id='),
        );
        entry.description = entry.description.replace(' --json {', ' --capture-source-identity --json {');
      },
      issue: /prove-restore command contains unsupported option --capture-source-identity/,
    },
  ];

  for (const mutation of mutations) {
    const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
    mutation.mutate(evidence);
    const issues = validateLaunchEvidence(evidence, { now: () => Date.parse(validationNow) });
    assert.ok(issues.some((issue) => mutation.issue.test(issue)), mutation.label);
  }
});

test('production launch evidence rejects duplicate keys inside embedded verifier JSON transcripts', async () => {
  const { validateLaunchEvidence, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const databaseCheck = evidence.areas.database.checks['database-check'];
  const captureEntry = databaseCheck.evidence.find(
    (candidate) => candidate.type === 'command-output' && candidate.description.includes('--capture-source-identity'),
  );
  const documentCheck = evidence.areas.supabaseStorage.checks['supabase-restore-tested'];
  const documentEntry = documentCheck.evidence.find(
    (candidate) => candidate.type === 'command-output' && candidate.description.includes('check:production:document-recovery'),
  );
  captureEntry.description = captureEntry.description.replace('"ok":true', '"ok":false,"ok":true');
  documentEntry.description = documentEntry.description.replace('"ok":true', '"ok":false,"ok":true');

  const issues = validateLaunchEvidence(evidence, { now: () => Date.parse(validationNow) });

  assert.ok(issues.some((issue) => /source-identity entry must contain exactly one allowlisted JSON payload/.test(issue)));
  assert.ok(issues.some((issue) => /exactly one verifier JSON success payload/.test(issue)));
});

test('production launch evidence binds database and joint document recovery to one source exercise', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const joint = evidence.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation;
  joint.recoverySetId = 'different-joint-recovery-set';
  joint.databaseDumpSha256 = '7'.repeat(64);
  joint.sourceDatabaseIdentitySha256 = '8'.repeat(64);
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /jointRecoveryReconciliation\.recoverySetId must match.*databaseRestoreProof\.recoverySetId/);
    assert.match(result.stderr, /jointRecoveryReconciliation\.databaseDumpSha256 must match.*databaseRestoreProof\.databaseDumpSha256/);
    assert.match(result.stderr, /jointRecoveryReconciliation\.sourceDatabaseIdentitySha256 must match.*databaseRestoreProof\.sourceDatabaseIdentitySha256/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects unsafe database proof and forbidden sentinel claims', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.database.checks['database-check'];
  check.databaseRestoreProof.tablesCompared = 0;
  check.databaseRestoreProof.mismatchCount = 1;
  check.databaseRestoreProof.backupArtifactsRetained = false;
  check.databaseRestoreProof.snapshotBound = false;
  check.databaseRestoreProof.sourceReadOnlyVerified = false;
  check.databaseRestoreProof.sourceTlsServerAuthenticationVerified = false;
  check.databaseRestoreProof.sourceAndIsolatedRestoreFingerprintsMatch = false;
  check.databaseRestoreProof.productionWritten = true;
  evidence.areas.database.checks['restore-tested'].evidence[0].description +=
    ' An operational sentinel was written before backup.';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /tablesCompared must be a positive safe integer/);
    assert.match(result.stderr, /mismatchCount must be 0/);
    assert.match(result.stderr, /backupArtifactsRetained must be true/);
    assert.match(result.stderr, /snapshotBound must be true/);
    assert.match(result.stderr, /sourceReadOnlyVerified must be true/);
    assert.match(result.stderr, /sourceTlsServerAuthenticationVerified must be true/);
    assert.match(result.stderr, /sourceAndIsolatedRestoreFingerprintsMatch must be true/);
    assert.match(result.stderr, /productionWritten must be false/);
    assert.match(result.stderr, /restore-tested\.evidence must not contain production sentinel instructions or claims/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence requires exact source-driven database environment preservation', async () => {
  const { validateLaunchEvidence, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const cases = [
    {
      label: 'unsupported source locale provider',
      mutate: (proof) => { proof.sourceDatabaseEnvironment.localeProvider = 'icu'; },
      issue: /sourceDatabaseEnvironment must contain the exact supported PostgreSQL database environment/,
    },
    {
      label: 'restored collation mismatch',
      mutate: (proof) => { proof.restoredDatabaseEnvironment.collation = 'C'; },
      issue: /source, restored, and restore-target database environments must match exactly/,
    },
    {
      label: 'restore target ctype mismatch',
      mutate: (proof) => { proof.restoreTargetDatabaseEnvironment.ctype = 'C'; },
      issue: /source, restored, and restore-target database environments must match exactly/,
    },
    {
      label: 'not initialized from source',
      mutate: (proof) => { proof.restoreInitializedFromSourceDatabaseEnvironment = false; },
      issue: /restoreInitializedFromSourceDatabaseEnvironment must be true/,
    },
    {
      label: 'environment not preserved',
      mutate: (proof) => { proof.databaseEnvironmentPreserved = false; },
      issue: /databaseEnvironmentPreserved must be true/,
    },
    {
      label: 'comparison not matched',
      mutate: (proof) => { proof.databaseEnvironmentMatched = false; },
      issue: /databaseEnvironmentMatched must be true/,
    },
  ];

  for (const entry of cases) {
    const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
    const check = evidence.areas.database.checks['database-check'];
    const proof = check.databaseRestoreProof;
    entry.mutate(proof);
    const commandEvidence = check.evidence.find(
      (candidate) => candidate.type === 'command-output' && candidate.description.includes('--recovery-set-id='),
    );
    commandEvidence.description = `${databaseProofCommand(proof)} ${JSON.stringify(databaseRestoreProofPayload(proof))}`;
    const issues = validateLaunchEvidence(evidence, { now: () => Date.parse(validationNow) });
    assert.ok(issues.some((issue) => entry.issue.test(issue)), entry.label);
  }
});

test('production launch evidence preserves database proof exclusions, workload bounds, and schema coverage', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const proof = evidence.areas.database.checks['database-check'].databaseRestoreProof;
  proof.format = 'charitypilot-postgres-restore-proof/v1';
  proof.expectedReleaseCommitSha = '0'.repeat(40);
  proof.helperImplementation.commitSha = '0'.repeat(40);
  proof.helperImplementation.commitSourceSha256 = '9'.repeat(64);
  proof.helperImplementation.sourceMatchesCommit = false;
  proof.helperImplementation.canonicalRepositoryMatched = false;
  proof.toolsImageReference = 'postgres@sha256:' + '0'.repeat(64);
  proof.toolsImageDigestSha256 = '0'.repeat(64);
  proof.databaseDumpBytes = '68719476737';
  proof.capacityPreflight.method = 'free-space-only/v1';
  proof.capacityPreflight.safetyFactor = 1;
  proof.capacityPreflight.safetyMarginBytes = '0';
  proof.capacityPreflight.requiredAvailableBytes = '1075838977';
  proof.capacityPreflight.maximumDumpBytes = '1';
  proof.capacityPreflight.verified = false;
  proof.capturedAt = 'not-a-timestamp';
  proof.sourceIdentityBindingMatched = false;
  proof.sequenceStateIncluded = true;
  proof.sequenceDefinitionAndOwnershipBound = false;
  proof.publicSequenceCount = 1;
  proof.sequenceStateExclusionReason = 'sequence state included';
  proof.ownershipIncluded = true;
  proof.ownershipExclusionReason = 'ownership restored';
  proof.aclPrivilegesIncluded = true;
  proof.aclPrivilegesExclusionReason = 'ACLs restored';
  proof.workloadSafety.tempFileLimitBytes = '0';
  proof.workloadSafety.maxDumpBytes = '0';
  proof.schemaCoverage.unsupportedPublicObjectCount = 1;
  proof.schemaCoverage.largeObjectCount = 1;
  proof.schemaCertificationScope.publicSchemaOnly = false;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /databaseRestoreProof\.format must be charitypilot-postgres-restore-proof\/v2/);
    assert.match(result.stderr, /expectedReleaseCommitSha must match release\.commitSha/);
    assert.match(result.stderr, /helperImplementation\.commitSha must match release\.commitSha/);
    assert.match(result.stderr, /helperImplementation source and committed-source SHA-256 digests must match/);
    assert.match(result.stderr, /helperImplementation\.sourceMatchesCommit must be true/);
    assert.match(result.stderr, /helperImplementation\.canonicalRepositoryMatched must be true/);
    assert.match(result.stderr, /toolsImageReference must match the approved PostgreSQL tools image/);
    assert.match(result.stderr, /toolsImageDigestSha256 must match the approved PostgreSQL tools image digest/);
    assert.match(result.stderr, /databaseDumpBytes must not exceed workloadSafety\.maxDumpBytes/);
    assert.match(result.stderr, /capacityPreflight\.method must match/);
    assert.match(result.stderr, /capacityPreflight\.safetyFactor must be 2/);
    assert.match(result.stderr, /capacityPreflight\.safetyMarginBytes must be 1073741824/);
    assert.match(result.stderr, /capacityPreflight\.maximumDumpBytes must match workloadSafety\.maxDumpBytes/);
    assert.match(result.stderr, /capacityPreflight\.verified must be true/);
    assert.match(result.stderr, /capacityPreflight\.requiredAvailableBytes must match the locked factor-and-margin formula/);
    assert.match(result.stderr, /capturedAt must be an ISO timestamp/);
    assert.match(result.stderr, /sourceIdentityBindingMatched must be true/);
    assert.match(result.stderr, /sequenceStateIncluded must be false/);
    assert.match(result.stderr, /sequenceDefinitionAndOwnershipBound must be true/);
    assert.match(result.stderr, /publicSequenceCount must be 0/);
    assert.match(result.stderr, /sequenceStateExclusionReason must match/);
    assert.match(result.stderr, /ownershipIncluded must be false/);
    assert.match(result.stderr, /ownershipExclusionReason must match/);
    assert.match(result.stderr, /aclPrivilegesIncluded must be false/);
    assert.match(result.stderr, /aclPrivilegesExclusionReason must match/);
    assert.match(result.stderr, /workloadSafety\.tempFileLimitBytes must match/);
    assert.match(result.stderr, /workloadSafety\.maxDumpBytes must match/);
    assert.match(result.stderr, /schemaCoverage\.unsupportedPublicObjectCount must be 0/);
    assert.match(result.stderr, /schemaCoverage\.largeObjectCount must be 0/);
    assert.match(result.stderr, /schemaCertificationScope must exactly match/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence accepts the exact 24-hour database-proof age boundary', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.database.checks['database-check'];
  const proof = check.databaseRestoreProof;
  proof.capturedAt = '2026-06-07T12:00:00.000Z';
  const captureEntry = check.evidence.find((entry) => entry.description.includes('--capture-source-identity'));
  const proofEntry = check.evidence.find((entry) => entry.description.includes('--recovery-set-id='));
  captureEntry.capturedAt = '2026-06-07T11:59:59.000Z';
  proofEntry.description = `${databaseProofCommand(proof)} ${JSON.stringify(databaseRestoreProofPayload(proof))}`;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath], {
      now: () => Date.parse('2026-06-08T12:00:00.000Z'),
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects a database proof older than 24 hours at validation time', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.database.checks['database-check'];
  const proof = check.databaseRestoreProof;
  proof.capturedAt = '2026-06-07T11:59:59.999Z';
  const captureEntry = check.evidence.find((entry) => entry.description.includes('--capture-source-identity'));
  const proofEntry = check.evidence.find((entry) => entry.description.includes('--recovery-set-id='));
  captureEntry.capturedAt = '2026-06-07T11:59:59.000Z';
  proofEntry.description = `${databaseProofCommand(proof)} ${JSON.stringify(databaseRestoreProofPayload(proof))}`;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath], {
      now: () => Date.parse('2026-06-08T12:00:00.000Z'),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /databaseRestoreProof\.capturedAt must be no more than 24 hours old at validation time/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects a stale database proof even when the complete ledger is backdated', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);
  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath], {
      now: () => Date.parse('2026-06-10T12:00:00.001Z'),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /databaseRestoreProof\.capturedAt must be no more than 24 hours old at validation time/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects future final approval and role approval after final signoff', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const futureEvidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  futureEvidence.finalSignoff.approvedAt = '2026-06-09T12:00:00.001Z';
  const futureFile = writeEvidenceFile(futureEvidence);
  const orderedEvidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  orderedEvidence.finalSignoff.approvals.operations.approvedAt = '2026-06-08T12:00:00.001Z';
  orderedEvidence.finalSignoff.approvals.engineering.approvedAt = '2026-06-08T11:59:00.000Z';
  orderedEvidence.finalSignoff.approvals.engineering.evidence[0].capturedAt = '2026-06-08T11:59:00.001Z';
  const orderedFile = writeEvidenceFile(orderedEvidence);
  try {
    const future = runProductionLaunchEvidenceFromArgs(['--evidence-file', futureFile.evidencePath]);
    assert.equal(future.status, 1);
    assert.match(future.stderr, /finalSignoff\.approvedAt must not be after the validation time/);

    const ordered = runProductionLaunchEvidenceFromArgs(['--evidence-file', orderedFile.evidencePath]);
    assert.equal(ordered.status, 1);
    assert.match(ordered.stderr, /finalSignoff\.approvals\.operations\.approvedAt must not be after finalSignoff\.approvedAt/);
    assert.match(ordered.stderr, /finalSignoff\.approvals\.engineering\.evidence\[0\]\.capturedAt must not be after finalSignoff\.approvals\.engineering\.approvedAt/);
  } finally {
    rmSync(futureFile.tempDir, { recursive: true, force: true });
    rmSync(orderedFile.tempDir, { recursive: true, force: true });
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
  evidence.areas.releaseGate.checks['github-environment'].evidence = [genericEvidence];
  evidence.areas.releaseGate.checks['github-secret-store'].evidence = [genericEvidence];
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
    assert.match(result.stderr, /areas\.releaseGate\.checks\.github-environment\.evidence must include the check:production:github-env command/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.github-environment\.evidence must include Production GitHub environment check passed/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.github-secret-store\.evidence must include the check:production:github-secrets command/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.github-secret-store\.evidence must include Production GitHub secret-store check passed/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.hosting-check\.evidence must include Production hosting check passed/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-check\.evidence must include the check:production:supabase command/);
    assert.match(result.stderr, /areas\.billingAndEmail\.checks\.providers-check\.evidence must include Production provider check passed/);
    assert.match(result.stderr, /areas\.observability\.checks\.observability-check\.evidence must include the check:production:observability command/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires GitHub production environment preflight evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  assert.ok(
    REQUIRED_LAUNCH_AREAS.find((area) => area.id === 'releaseGate')?.checks.some((check) => check.id === 'github-environment'),
    'releaseGate.github-environment must be part of REQUIRED_LAUNCH_AREAS',
  );
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.areas.releaseGate.checks['github-environment'];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /releaseGate\.checks\.github-environment is required/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires GitHub production secret-store evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  assert.ok(
    REQUIRED_LAUNCH_AREAS.find((area) => area.id === 'releaseGate')?.checks.some((check) => check.id === 'github-secret-store'),
    'releaseGate.github-secret-store must be part of REQUIRED_LAUNCH_AREAS',
  );
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.areas.releaseGate.checks['github-secret-store'];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /releaseGate\.checks\.github-secret-store is required/);
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
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.supabase-api-only\.evidence must include API\/server runtimes only/);
    assert.match(result.stderr, /areas\.secretsAndEnv\.checks\.web-compose-api-origin\.evidence must include CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL/);
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
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.dns-owner\.evidence must include DNS record/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.dns-owner\.evidence must include app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.dns-owner\.evidence must include api\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.tls-certificates\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.tls-certificates\.evidence must include https:\/\/api\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.tls-certificates\.evidence must include certificate issuer/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.tls-certificates\.evidence must include expiry date/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.cors-approved-origins\.evidence must include rejected unapproved origin/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.security-headers\.evidence must include Strict-Transport-Security/);
    assert.match(result.stderr, /areas\.hostingDnsTls\.checks\.security-headers\.evidence must include HSTS max-age/);
    assert.match(result.stderr, /areas\.database\.checks\.postgres-provisioned\.evidence must include production PostgreSQL/);
    assert.match(result.stderr, /areas\.database\.checks\.database-url-secret-store\.evidence must include DATABASE_URL/);
    assert.match(result.stderr, /areas\.database\.checks\.backups-enabled\.evidence must include managed backups or PITR/);
    assert.match(result.stderr, /areas\.database\.checks\.backups-enabled\.evidence must include backup window/);
    assert.match(result.stderr, /areas\.database\.checks\.backups-enabled\.evidence must include retention period/);
    assert.match(result.stderr, /areas\.database\.checks\.backups-enabled\.evidence must include backup owner/);
    assert.match(result.stderr, /areas\.database\.checks\.backups-enabled\.evidence must include PostgreSQL RPO/);
    assert.match(result.stderr, /areas\.database\.checks\.backups-enabled\.evidence must include PostgreSQL RTO/);
    assert.match(result.stderr, /areas\.database\.checks\.restore-tested\.evidence must include restore date/);
    assert.match(result.stderr, /areas\.database\.checks\.restore-tested\.evidence must include recovery notes/);
    assert.match(result.stderr, /areas\.database\.checks\.restore-tested\.evidence must include isolated non-production target/);
    assert.match(result.stderr, /areas\.database\.checks\.restore-tested\.evidence must include read-only source/);
    assert.match(result.stderr, /areas\.database\.checks\.restore-tested\.evidence must include production database was not overwritten/);
    assert.match(result.stderr, /areas\.database\.checks\.restore-tested\.evidence must include recovery-set-2026-06-08/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.separate-production-project\.evidence must include production Supabase project/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.bucket-private\.evidence must include private bucket/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.readiness-storage-reachable\.evidence must include storageBucketReachable: true/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.document-upload-download\.evidence must include authenticated API download/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include document object bytes/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include separate from PostgreSQL backups and PITR/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include encrypted/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include versioned/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include document-object RPO/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include document-object RTO/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include retention period/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include backup owner/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include monitoring and alerting/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-backups-enabled\.evidence must include secure deletion behavior/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include joint PostgreSQL metadata and document object-byte restore/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include restore date/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include recovery notes/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include isolated restore target/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include non-production restore target/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include production database was not overwritten/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include production object storage was not overwritten/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include joint metadata\/object reconciliation/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include SHA-256/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.supabaseStorage\.checks\.supabase-restore-tested\.evidence must include report evidence/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects database-only backup wording as document-object recovery evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.supabaseStorage.checks['supabase-backups-enabled'].evidence = [{
    type: 'report',
    reference: 'https://evidence.charitypilot.ie/launch/storage/database-backup-only',
    description: [
      'Supabase backup policy confirms managed backups or PITR.',
      'The backup window, retention period, and backup owner are recorded.',
    ].join(' '),
    capturedAt,
  }];
  const restoreCheck = evidence.areas.supabaseStorage.checks['supabase-restore-tested'];
  restoreCheck.evidence = [{
    type: 'report',
    reference: 'https://evidence.charitypilot.ie/launch/storage/database-restore-only',
    description: [
      'Supabase restore test has an owner, restore date, and recovery notes.',
      'An isolated non-production restore target was used and the production project was not overwritten.',
    ].join(' '),
    capturedAt,
  }];
  delete restoreCheck.jointRecoveryReconciliation;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /supabase-backups-enabled\.evidence must include document object bytes/);
    assert.match(result.stderr, /supabase-backups-enabled\.evidence must include separate from PostgreSQL backups and PITR/);
    assert.match(result.stderr, /supabase-restore-tested\.evidence must include joint PostgreSQL metadata and document object-byte restore/);
    assert.match(result.stderr, /supabase-restore-tested\.jointRecoveryReconciliation is required/);
    assert.match(result.stderr, /supabase-restore-tested\.evidence must include command-output evidence/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects inconsistent or unsafe joint document recovery reconciliation', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.supabaseStorage.checks['supabase-restore-tested'];
  const reconciliation = check.jointRecoveryReconciliation;
  reconciliation.metadataRowCount = 0;
  reconciliation.restoredObjectCount = 1;
  reconciliation.matchedObjectCount = 1;
  reconciliation.missingObjectCount = 1;
  reconciliation.unexpectedObjectCount = 1;
  reconciliation.orphanExpectedObjectCount = 1;
  reconciliation.orphanRestoredObjectCount = 1;
  reconciliation.checksumMismatchCount = 1;
  reconciliation.restoredBytes = 2048;
  reconciliation.restoredStorageDeletionCount = 2;
  reconciliation.pendingStorageDeletionCount = 1;
  reconciliation.deadLetterStorageDeletionCount = 1;
  reconciliation.processedStorageDeletionCount = 0;
  reconciliation.restoredPendingStorageDeletionCount = 1;
  reconciliation.restoredDeadLetterStorageDeletionCount = 1;
  reconciliation.restoredProcessedStorageDeletionCount = 0;
  reconciliation.restoredRecoveryEventCount = 2;
  reconciliation.processedDeletionObjectResidueCount = 1;
  reconciliation.restoreTargetType = 'production';
  reconciliation.isolationAttestationRecorded = false;
  reconciliation.productionDatabaseNotOverwrittenAttestationRecorded = false;
  reconciliation.productionObjectStoreNotOverwrittenAttestationRecorded = false;
  reconciliation.restoreCredentialsScopedToTargetAttestationRecorded = false;
  reconciliation.objectives.documentBytes.met = false;
  reconciliation.secretValuesPrinted = true;
  reconciliation.reconciledBy = 'TBD';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /metadataRowCount must be at least 1 so recovery proof is not vacuous/);
    assert.match(result.stderr, /restoredObjectCount must match expectedObjectCount/);
    assert.match(result.stderr, /matchedObjectCount must match expectedObjectCount/);
    assert.match(result.stderr, /missingObjectCount must be 0/);
    assert.match(result.stderr, /unexpectedObjectCount must be 0/);
    assert.match(result.stderr, /orphanExpectedObjectCount must be 0/);
    assert.match(result.stderr, /orphanRestoredObjectCount must be 0/);
    assert.match(result.stderr, /checksumMismatchCount must be 0/);
    assert.match(result.stderr, /restoredBytes must match expectedBytes/);
    assert.match(result.stderr, /restoredStorageDeletionCount must match storageDeletionCount/);
    assert.match(result.stderr, /pendingStorageDeletionCount must be 0/);
    assert.match(result.stderr, /deadLetterStorageDeletionCount must be 0/);
    assert.match(result.stderr, /processedStorageDeletionCount must match storageDeletionCount/);
    assert.match(result.stderr, /restoredRecoveryEventCount must match recoveryEventCount/);
    assert.match(result.stderr, /processedDeletionObjectResidueCount must be 0/);
    assert.match(result.stderr, /restoreTargetType must be isolated-non-production/);
    assert.match(result.stderr, /isolationAttestationRecorded must be true/);
    assert.match(result.stderr, /productionDatabaseNotOverwrittenAttestationRecorded must be true/);
    assert.match(result.stderr, /productionObjectStoreNotOverwrittenAttestationRecorded must be true/);
    assert.match(result.stderr, /restoreCredentialsScopedToTargetAttestationRecorded must be true/);
    assert.match(result.stderr, /objectives\.documentBytes\.met must be true/);
    assert.match(result.stderr, /secretValuesPrinted must be false/);
    assert.match(result.stderr, /reconciledBy must not be a placeholder/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects malformed joint recovery verifier fields', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const reconciliation =
    evidence.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation;
  reconciliation.manifestFormat = 'legacy-recovery-report';
  reconciliation.checksumAlgorithm = 'md5';
  reconciliation.recoveryManifestSha256 = 'ABC123';
  reconciliation.exerciseId = 'x';
  reconciliation.recoverySetId = 'x';
  reconciliation.expectedObjectCount = 1.5;
  reconciliation.expectedBytes = -1;
  reconciliation.objectives.database.rpoObjectiveMinutes = 0;
  reconciliation.objectives.database.achievedRtoMinutes = -1;
  reconciliation.reconciledAt = 'not-a-date';
  reconciliation.sourceMetadataCaptureTransactionId = '0';
  reconciliation.restoredMetadataCaptureTransactionId = '9223372036854775808';
  reconciliation.maximumDocumentProofAgeMinutes = 0;
  reconciliation.documentProofAgeMinutes = -1;
  reconciliation.documentProofFresh = false;
  reconciliation.reconciledBy = '';
  reconciliation.recoveryOperatorRecorded = false;
  reconciliation.independentBindingArgumentsMatched = false;
  reconciliation.sourceProvenanceExternallyVerified = true;
  reconciliation.provenanceLimitation = 'Source provenance is fully guaranteed.';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifestFormat must be charitypilot-document-recovery-manifest-v1/);
    assert.match(result.stderr, /checksumAlgorithm must be sha256/);
    assert.match(result.stderr, /recoveryManifestSha256 must be a 64 character lowercase SHA-256 digest/);
    assert.match(result.stderr, /exerciseId must be a bounded operational identifier/);
    assert.match(result.stderr, /recoverySetId must be a bounded operational identifier/);
    assert.match(result.stderr, /expectedObjectCount must be a non-negative safe integer/);
    assert.match(result.stderr, /expectedBytes must be a non-negative safe integer/);
    assert.match(result.stderr, /objectives\.database\.rpoObjectiveMinutes must be a positive safe integer/);
    assert.match(result.stderr, /objectives\.database\.achievedRtoMinutes must be a non-negative safe integer/);
    assert.match(result.stderr, /reconciledAt must be an ISO timestamp/);
    assert.match(result.stderr, /sourceMetadataCaptureTransactionId must be a canonical bounded PostgreSQL transaction identifier/);
    assert.match(result.stderr, /restoredMetadataCaptureTransactionId must be a canonical bounded PostgreSQL transaction identifier/);
    assert.match(result.stderr, /maximumDocumentProofAgeMinutes must be between 1 and 1440/);
    assert.match(result.stderr, /documentProofAgeMinutes must be a non-negative safe integer/);
    assert.match(result.stderr, /documentProofFresh must be true/);
    assert.match(result.stderr, /reconciledBy is required/);
    assert.match(result.stderr, /recoveryOperatorRecorded must be true/);
    assert.match(result.stderr, /independentBindingArgumentsMatched must be true/);
    assert.match(result.stderr, /sourceProvenanceExternallyVerified must be false/);
    assert.match(result.stderr, /provenanceLimitation must match the verifier's offline consistency limitation/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence requires the exact final verifier schema and forbids legacy overclaims', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.supabaseStorage.checks['supabase-restore-tested'];
  delete check.jointRecoveryReconciliation.sourceRecoveryEventInventorySha256;
  check.jointRecoveryReconciliation.isolationVerified = true;
  check.evidence[0].description += [
    ' --expected-recovery-event-count=1',
    ' --expected-unknown-binding=unexpected',
    ' "productionDatabaseOverwritten": false',
  ].join('');
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must contain exactly the verifier success payload fields plus reconciledBy/);
    assert.match(result.stderr, /sourceRecoveryEventInventorySha256 must be a 64 character lowercase SHA-256 digest/);
    assert.match(result.stderr, /must include exactly 30 document recovery verifier binding flags/);
    assert.match(result.stderr, /must include --expected-recovery-event-count exactly once/);
    assert.match(result.stderr, /must not include legacy automated verifier field productionDatabaseOverwritten/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence independently enforces document capture chronology and freshness', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const reconciliation =
    evidence.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation;
  reconciliation.sourceMetadataCapturedAt = '2026-06-08T12:00:00.001Z';
  reconciliation.documentProofOldestCapturedAt = '2026-06-08T12:00:00.001Z';
  reconciliation.documentProofFreshThroughAt = '2026-06-09T11:59:59.999Z';
  reconciliation.maximumDocumentProofAgeMinutes = 60;
  reconciliation.documentProofAgeMinutes = 100;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documentProofOldestCapturedAt must equal the oldest bound inventory capture/);
    assert.match(result.stderr, /documentProofFreshThroughAt must be derived from the oldest capture and maximum age/);
    assert.match(result.stderr, /document recovery proof must still be fresh at validation time/);
    assert.match(result.stderr, /documentProofAgeMinutes must not exceed maximumDocumentProofAgeMinutes/);
    assert.match(result.stderr, /verifier evidence capture must not be before the oldest inventory capture/);
    assert.match(result.stderr, /sourceMetadataCapturedAt must not be after reconciledAt/);
    assert.match(result.stderr, /sourceMetadataCapturedAt must not be after restoredMetadataCapturedAt/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence binds the reported document proof age to verifier capture time', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.supabaseStorage.checks[
    'supabase-restore-tested'
  ].jointRecoveryReconciliation.documentProofAgeMinutes = 100;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documentProofAgeMinutes must match the verifier evidence capture time/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence fixture carries all 30 independent document verifier bindings', () => {
  const reconciliation = jointRecoveryReconciliation();
  const command = recoveryVerifierCommand(reconciliation);
  assert.equal(command.match(/(?:^|\s)--expected-/g)?.length, 30);
  for (const marker of [
    '--expected-recovery-event-inventory-sha256=',
    '--expected-restored-recovery-event-inventory-sha256=',
    '--expected-recovery-event-count=',
    '--expected-source-metadata-capture-transaction-id=',
    '--expected-restored-metadata-capture-transaction-id=',
  ]) {
    assert.ok(command.includes(marker), marker);
  }
});

test('production launch evidence rejects duplicate, unknown, and help options in the document verifier command', async () => {
  const { validateLaunchEvidence, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const mutations = [
    {
      label: 'duplicate manifest path',
      command: (command) => command.replace(
        '--manifest-file=.charitypilot-launch-evidence/document-recovery-manifest.json',
        '--manifest-file=.charitypilot-launch-evidence/document-recovery-manifest.json --manifest-file=/attacker/second.json',
      ),
      issue: /document recovery verifier command must include --manifest-file exactly once/,
    },
    {
      label: 'unknown option',
      command: (command) => `${command} --attacker-unknown-flag=enabled`,
      issue: /document recovery verifier command contains unsupported option --attacker-unknown-flag/,
    },
    {
      label: 'help bypass',
      command: (command) => `${command} --help`,
      issue: /document recovery verifier command contains unsupported option --help/,
    },
  ];

  for (const mutation of mutations) {
    const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
    const check = evidence.areas.supabaseStorage.checks['supabase-restore-tested'];
    const entry = check.evidence.find(
      (candidate) => candidate.type === 'command-output' && candidate.description.includes('check:production:document-recovery'),
    );
    const canonicalCommand = recoveryVerifierCommand(check.jointRecoveryReconciliation);
    entry.description = entry.description.replace(canonicalCommand, mutation.command(canonicalCommand));
    const issues = validateLaunchEvidence(evidence, { now: () => Date.parse(validationNow) });
    assert.ok(issues.some((issue) => mutation.issue.test(issue)), mutation.label);
  }
});

test('production launch evidence rejects drifted verifier CLI, JSON, and report bindings', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.supabaseStorage.checks['supabase-restore-tested'];
  check.evidence[0].description = check.evidence[0].description
    .replace(
      `--expected-database-dump-sha256=${databaseDumpSha256}`,
      `--expected-database-dump-sha256=${'9'.repeat(64)}`,
    )
    .replace(
      `--expected-source-capture-report-sha256=${sourceCaptureReportSha256}`,
      `--expected-source-capture-report-sha256=${'7'.repeat(64)}`,
    )
    .replace('--expected-production-document-count=2', '--expected-production-document-count=99')
    .replace('--expected-recovery-event-count=1', '--expected-recovery-event-count=99')
    .replace('--expected-source-metadata-capture-transaction-id=2001', '--expected-source-metadata-capture-transaction-id=9999')
    .replace(recoveryConsistencySuccessText, 'Document recovery verification passed.')
    .replace('"ok":true', '"ok":false')
    .replace('"sourceProvenanceExternallyVerified":false', '"sourceProvenanceExternallyVerified":true')
    .replace(JSON.stringify(recoveryProvenanceLimitation), JSON.stringify('Source provenance is fully guaranteed.'))
    .replace('"secretValuesPrinted":false', '"secretValuesPrinted":true');
  check.evidence[1].description = check.evidence[1].description
    .replace(reconciliationReportSha256, '8'.repeat(64))
    .replace(sourceCaptureReportSha256, '9'.repeat(64));
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /evidence must bind --expected-database-dump-sha256 to jointRecoveryReconciliation/);
    assert.match(result.stderr, /evidence must bind --expected-source-capture-report-sha256 to jointRecoveryReconciliation/);
    assert.match(result.stderr, /evidence must bind --expected-production-document-count to jointRecoveryReconciliation/);
    assert.match(result.stderr, /evidence must bind --expected-recovery-event-count to jointRecoveryReconciliation/);
    assert.match(result.stderr, /evidence must bind --expected-source-metadata-capture-transaction-id to jointRecoveryReconciliation/);
    assert.match(result.stderr, /evidence must include Document recovery reconciliation consistency passed against independently supplied bindings\./);
    assert.match(result.stderr, /evidence must bind verifier JSON field ok/);
    assert.match(result.stderr, /evidence must bind verifier JSON field sourceProvenanceExternallyVerified/);
    assert.match(result.stderr, /evidence must bind verifier JSON field provenanceLimitation/);
    assert.match(result.stderr, /evidence must bind verifier JSON field secretValuesPrinted/);
    assert.match(result.stderr, /report evidence must include reconciliationReportSha256/);
    assert.match(result.stderr, /report evidence must include sourceCaptureReportSha256/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence binds joint recovery chronology and both verifier evidence forms', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const check = evidence.areas.supabaseStorage.checks['supabase-restore-tested'];
  check.jointRecoveryReconciliation.reconciledAt = '2026-06-08T13:00:00.001Z';
  check.evidence = check.evidence.filter((entry) => entry.type !== 'report');
  check.evidence[0].description = 'Joint recovery was reviewed without the verifier transcript or digest binding.';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /reconciledAt must not be after finalSignoff\.approvedAt/);
    assert.match(result.stderr, /evidence\[0\]\.capturedAt must not be before .*jointRecoveryReconciliation\.reconciledAt/);
    assert.match(result.stderr, /evidence must include report evidence for the joint recovery manifest/);
    assert.match(result.stderr, /evidence must include the document recovery verifier base command/);
    assert.match(result.stderr, /evidence must bind --expected-recovery-manifest-sha256/);
    assert.match(result.stderr, /evidence must include the document recovery verifier --json flag/);
    assert.match(result.stderr, /evidence must include Document recovery reconciliation consistency passed against independently supplied bindings\./);
    assert.match(result.stderr, /evidence must include exactly one verifier JSON success payload with the final allowlisted schema/);
    assert.match(result.stderr, /report evidence must include reconciliationReportSha256/);
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
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include npm run check:production:browser-qa-env/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include Deployed browser QA environment preflight passed/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include npm run test:e2e:responsive or all four focused responsive route chunks/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.desktop-coverage\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.desktop-coverage\.evidence must include desktop light and dark/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.desktop-coverage\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.mobile-coverage\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.mobile-coverage\.evidence must include mobile light and dark/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.mobile-coverage\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.accessibility-coverage\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.accessibility-coverage\.evidence must include npm run test:e2e -- tests\/accessibility\.spec\.ts/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.accessibility-coverage\.evidence must include light and dark/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.accessibility-coverage\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.cross-browser-coverage\.evidence must include test:e2e:deployed:responsive:cross-browser/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.cross-browser-coverage\.evidence must include deployed-firefox-desktop/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.cross-browser-coverage\.evidence must include deployed-webkit-desktop/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.cross-browser-coverage\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.ios-safari-device-coverage\.evidence must include real iOS Safari/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.ios-safari-device-coverage\.evidence must include manual or cloud-device evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.ios-safari-device-coverage\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include docs\/production-browser-qa\.md/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include auth flow/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include document upload/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include pending-navigation confirmation/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include conditional obligations/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include readiness blockers/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include Launch-Critical Route Inventory/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include every route/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include desktop, mobile, light-mode, and dark-mode evidence/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include release\.commitSha/);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include zero critical or high-severity browser QA defects/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator accepts complete chunked responsive QA transcripts', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);

  evidence.areas.browserQa.checks['browser-qa-completed'].evidence[0].description = [
    `Browser QA release commit: ${commitSha}.`,
    'npm run check:production:browser-qa-env',
    'Deployed browser QA environment preflight passed.',
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
    `Browser QA release commit: ${commitSha}.`,
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'npm run test:e2e:responsive:public:desktop',
    'npm run test:e2e:responsive:dashboard:desktop',
    'desktop light and dark route coverage completed',
  ].join(' ');
  evidence.areas.browserQa.checks['mobile-coverage'].evidence[0].description = [
    `Browser QA release commit: ${commitSha}.`,
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

test('production launch evidence validator requires deployed browser QA env preflight evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);

  evidence.areas.browserQa.checks['browser-qa-completed'].evidence[0].description = [
    `Browser QA release commit: ${commitSha}.`,
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD supplied from the secret store',
    'npm run test:e2e:responsive',
    'responsive-smoke.spec.ts passed against deployed HTTPS production URL',
  ].join(' ');
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /areas\.browserQa\.checks\.browser-qa-completed\.evidence must include npm run check:production:browser-qa-env/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires every launch-critical route in browser QA evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.browserQa.checks['critical-flows-covered'].evidence[0].description = [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD supplied from the secret store',
    'docs/production-browser-qa.md recorded auth flow, dashboard flow, billing flow, document upload, authenticated API download, logout, error states, pending-navigation confirmation, conditional obligations, and readiness blockers.',
    'Launch-Critical Route Inventory completed across every route in desktop, mobile, light-mode, and dark-mode evidence.',
    `Routes covered: ${launchCriticalRoutes.filter((route) => route !== '/export').join(', ')}.`,
    'zero critical or high-severity browser QA defects remain unresolved.',
  ].join(' ');
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include launch route \/export/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence route inventory matches the browser QA checklist', async () => {
  const { LAUNCH_CRITICAL_ROUTES } = await loadEvidenceRunner();
  const browserQa = readFileSync(join(repoRoot, 'docs', 'production-browser-qa.md'), 'utf8');
  const routeRows = Array.from(browserQa.matchAll(/^\| `([^`]+)` \|/gm), (match) => match[1]);

  assert.deepEqual(LAUNCH_CRITICAL_ROUTES, launchCriticalRoutes);
  assert.deepEqual(routeRows, launchCriticalRoutes);
});

test('production launch evidence validator treats the root route as an explicit route token', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.browserQa.checks['critical-flows-covered'].evidence[0].description = [
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD supplied from the secret store',
    'docs/production-browser-qa.md recorded auth flow, dashboard flow, billing flow, document upload, authenticated API download, logout, error states, pending-navigation confirmation, conditional obligations, and readiness blockers.',
    'Launch-Critical Route Inventory completed across every route in desktop, mobile, light-mode, and dark-mode evidence.',
    `Routes covered: ${launchCriticalRoutes.filter((route) => route !== '/').join(', ')}.`,
    'zero critical or high-severity browser QA defects remain unresolved.',
  ].join(' ');
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.browserQa\.checks\.critical-flows-covered\.evidence must include launch route \//);
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

test('production launch evidence validator accepts managed TLS deploy evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.releaseGate.checks['deploy-production'].evidence[0].description = [
    'npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers --no-tls-proxy',
    'compose.production.yml was used for the production deploy.',
    'Managed load balancer TLS terminated HTTPS for https://app.charitypilot.ie and https://api.charitypilot.ie.',
    'External TLS certificate evidence confirmed app.charitypilot.ie and api.charitypilot.ie certificates.',
    'release-image-digests.env supplied digest-pinned images for API, web, and migration services.',
    'The old runtime stopped before migration and a retained restore-verified backup completed.',
    'The migration image alone completed, followed by the live migration-history probe.',
    'The quiesced reminder cutover preparation completed with zero unresolved reminder outcomes.',
    'The host-wide production cutover lock covered preflight through smoke.',
    'Production deploy preflight passed: env, compose config, and image signatures verified.',
    'Production deploy smoke passed: public web, API health, CORS, and keyed readiness verified.',
    'Production compose deploy completed.',
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
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include compose\.production\.yml/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include compose\.production-tls\.yml/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include release-image-digests\.env/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include digest-pinned images/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include quiesced reminder cutover preparation/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-production\.evidence must include zero unresolved reminder outcomes/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include the production rollback command/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include Production compose rollback completed/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include previous signed digest manifest/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include release-image-digests\.previous\.env/);
    assert.match(result.stderr, /areas\.releaseGate\.checks\.deploy-rollback\.evidence must include Production deploy smoke passed/);
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

  const redactedResult = runProductionLaunchEvidenceFromArgs([
    '--evidence-file',
    join(tmpdir(), 'missing-launch-evidence.json?token=secret-token&GITHUB_TOKEN=ghp_secretToken'),
  ]);

  assert.equal(redactedResult.status, 1);
  assert.match(redactedResult.stderr, /token=\[redacted\]/);
  assert.match(redactedResult.stderr, /GITHUB_TOKEN=\[redacted\]/);
  assert.doesNotMatch(redactedResult.stderr, /secret-token|ghp_secretToken/);
});

test('production launch evidence rejects duplicate keys, deep JSON, and oversized input before validation', async () => {
  const { runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();
  const duplicateFile = writeRawEvidenceFile('{"version":1,"version":1}');
  const deepFile = writeRawEvidenceFile(`{"extra":${'['.repeat(65)}0${']'.repeat(65)}}`);
  const oversizedFile = writeRawEvidenceFile(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  try {
    const duplicate = runProductionLaunchEvidenceFromArgs(['--evidence-file', duplicateFile.evidencePath]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /duplicate JSON object keys/);

    const deep = runProductionLaunchEvidenceFromArgs(['--evidence-file', deepFile.evidencePath]);
    assert.equal(deep.status, 1);
    assert.match(deep.stderr, /maximum JSON nesting depth/);

    const oversized = runProductionLaunchEvidenceFromArgs(['--evidence-file', oversizedFile.evidencePath]);
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /bounded input safety limit/);
  } finally {
    rmSync(duplicateFile.tempDir, { recursive: true, force: true });
    rmSync(deepFile.tempDir, { recursive: true, force: true });
    rmSync(oversizedFile.tempDir, { recursive: true, force: true });
  }
});

test('stable launch evidence reader rejects input growth during descriptor-bound reads', async () => {
  const { readStableLaunchEvidenceFile, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const { tempDir, evidencePath } = writeEvidenceFile(completeEvidence(REQUIRED_LAUNCH_AREAS));
  let grew = false;
  try {
    assert.throws(
      () => readStableLaunchEvidenceFile(evidencePath, {
        read: (...args) => {
          const bytesRead = readSync(...args);
          if (!grew) {
            appendFileSync(evidencePath, ' ');
            grew = true;
          }
          return bytesRead;
        },
      }),
      /changed while it was being read/,
    );
    assert.equal(grew, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence rejects symbolic-link input where supported', async (context) => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const { tempDir, evidencePath } = writeEvidenceFile(completeEvidence(REQUIRED_LAUNCH_AREAS));
  const linkPath = join(tempDir, 'linked-production-launch-evidence.json');
  try {
    try {
      symlinkSync(evidencePath, linkPath, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        context.skip('Windows symbolic-link privilege is unavailable');
        return;
      }
      throw error;
    }
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', linkPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /regular non-symbolic-link file/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('whole-ledger scanner rejects secrets in unknown extras while allowing secret names and redaction', async () => {
  const {
    redactLaunchEvidenceTranscript,
    runProductionLaunchEvidenceFromArgs,
    validateLaunchEvidence,
    REQUIRED_LAUNCH_AREAS,
  } = await loadEvidenceRunner();
  const awsSecretAccessKey = [
    'AbCdEfGhIjKlMnOpQrStUvWxYz',
    '0123456789ABCD',
  ].join('');
  const basicCredential = ['dXNlcjpwYXNz', 'd29yZA=='].join('');
  const cliEvidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  cliEvidence.unrecognised = {
    nested: [{ diagnostic: 'JWT_SECRET=actual-super-secret-value' }],
  };
  const cliFile = writeEvidenceFile(cliEvidence);
  try {
    const cliResult = runProductionLaunchEvidenceFromArgs(['--evidence-file', cliFile.evidencePath]);
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stderr, /unrecognised\.nested\[0\]\.diagnostic must not contain raw secret-looking values/);
    assert.doesNotMatch(cliResult.stderr, /actual-super-secret-value/);

    const programmaticEvidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
    programmaticEvidence.unrecognised = {
      accessToken: 'opaque-but-sensitive-value',
      awsSecretAccessKey,
      authorization: `Basic ${basicCredential}`,
    };
    const programmaticIssues = validateLaunchEvidence(programmaticEvidence, {
      now: () => Date.parse(validationNow),
    });
    assert.ok(programmaticIssues.some((issue) =>
      /unrecognised\.accessToken must not contain raw secret-looking values/.test(issue)));
    assert.ok(programmaticIssues.some((issue) =>
      /unrecognised\.awsSecretAccessKey must not contain raw secret-looking values/.test(issue)));
    assert.ok(programmaticIssues.some((issue) =>
      /unrecognised\.authorization must not contain raw secret-looking values/.test(issue)));

    const awsAssignmentEvidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
    awsAssignmentEvidence.operatorNotes = {
      diagnostic: `awsSecretAccessKey=${awsSecretAccessKey}`,
    };
    assert.ok(validateLaunchEvidence(awsAssignmentEvidence, {
      now: () => Date.parse(validationNow),
    }).some((issue) => /operatorNotes\.diagnostic must not contain raw secret-looking values/.test(issue)));

    const redactedCredentials = redactLaunchEvidenceTranscript(
      `Authorization: Basic ${basicCredential} awsSecretAccessKey=${awsSecretAccessKey}`,
    );
    assert.doesNotMatch(redactedCredentials, /AbCdEfGhIjKlMnOpQrStUvWxYz/);
    assert.equal(redactedCredentials.includes(basicCredential), false);
    assert.equal(redactedCredentials.includes(awsSecretAccessKey), false);

    const namesOnlyEvidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
    namesOnlyEvidence.operatorNotes = {
      secretName: 'JWT_SECRET',
      databaseSecretName: 'DATABASE_URL',
      explicitRedaction: 'JWT_SECRET=[redacted]',
    };
    assert.deepEqual(validateLaunchEvidence(namesOnlyEvidence, {
      now: () => Date.parse(validationNow),
    }), []);
  } finally {
    rmSync(cliFile.tempDir, { recursive: true, force: true });
  }
});

test('programmatic launch evidence validation rejects excessive object depth without recursion', async () => {
  const { validateLaunchEvidence, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  let nested = { leaf: true };
  for (let depth = 0; depth < 70; depth += 1) nested = { nested };
  evidence.unrecognised = nested;
  const issues = validateLaunchEvidence(evidence, { now: () => Date.parse(validationNow) });
  assert.ok(issues.some((issue) => /maximum JSON nesting depth/.test(issue)));
});

test('production launch evidence validator rejects empty evidence file option as usage error', async () => {
  const { runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();

  const result = runProductionLaunchEvidenceFromArgs(['--evidence-file=']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--evidence-file requires a value/);
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

test('production launch evidence validator binds final signoff evidence to the promoted commit', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.finalSignoff.evidence[0].description = 'Accountable owner launch approval';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /finalSignoff\.evidence must include release\.commitSha/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator binds every final approval role to the promoted commit', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.finalSignoff.approvals.operations.evidence[0].description = 'Operations owner launch approval';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /finalSignoff\.approvals\.operations\.evidence must include release\.commitSha/);
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
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.privacy-policy-approved\.evidence must include policy version/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.privacy-policy-approved\.evidence must include effective date/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.privacy-policy-approved\.evidence must include privacy approver/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.terms-approved\.evidence must include approved for production/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.terms-approved\.evidence must include terms version/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.terms-approved\.evidence must include effective date/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.retention-policy-approved\.evidence must include data retention policy/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.retention-policy-approved\.evidence must include retention schedule/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.retention-policy-approved\.evidence must include deletion workflow/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.support-deletion-contact\.evidence must include data deletion contact/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.support-deletion-contact\.evidence must include published URL/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.support-deletion-contact\.evidence must include support mailbox/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.solicitor-governance-privacy-review\.evidence must include solicitor review/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.solicitor-governance-privacy-review\.evidence must include named solicitor/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.solicitor-governance-privacy-review\.evidence must include named governance reviewer/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.solicitor-governance-privacy-review\.evidence must include named privacy reviewer/);
    assert.match(result.stderr, /areas\.legalAndCompliance\.checks\.solicitor-governance-privacy-review\.evidence must include review date/);
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
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include testing scope/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include https:\/\/app\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include https:\/\/api\.charitypilot\.ie/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include release commit/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include completed before real charity data/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.critical-high-findings\.evidence must include remediated or formally accepted/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.critical-high-findings\.evidence must include finding tracker/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.critical-high-findings\.evidence must include risk acceptance approver/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.critical-high-findings\.evidence must include acceptance date/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.retest-evidence\.evidence must include fixed findings/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.retest-evidence\.evidence must include retest date/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.retest-evidence\.evidence must include retest result/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.report-reference\.evidence must include stored outside git/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.report-reference\.evidence must include report version/);
    assert.match(result.stderr, /areas\.securityReview\.checks\.report-reference\.evidence must include report date/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator binds penetration test evidence to the promoted commit', async () => {
  const { REQUIRED_LAUNCH_AREAS, runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.securityReview.checks['penetration-test-complete'].evidence[0].description = [
    'external penetration test by named testing provider completed before real charity data.',
    'testing scope covered https://app.charitypilot.ie and https://api.charitypilot.ie at the release commit under review.',
  ].join(' ');
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.securityReview\.checks\.penetration-test-complete\.evidence must include release\.commitSha/);
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
      for (const check of area.checks) {
        assert.ok(
          template.areas[area.id].checks[check.id].requiredEvidenceHints.length > 0,
          `${area.id}.${check.id} must include operator evidence hints`,
        );
      }
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
      [
        'TLS certificate',
        'valid',
        'https://app.charitypilot.ie',
        'https://api.charitypilot.ie',
        'certificate issuer',
        'expiry date',
      ],
    );
    assert.deepEqual(
      template.areas.releaseGate.checks['npm-ci'].requiredEvidenceHints,
      ['npm ci', 'exit 0'],
    );
    assert.deepEqual(
      template.areas.releaseGate.checks['github-environment'].requiredEvidenceHints,
      [
        'npm run check:production:github-env -- --environment=production',
        'Production GitHub environment check passed',
        'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
        'secret values were not read',
      ],
    );
    assert.deepEqual(
      template.areas.releaseGate.checks['github-secret-store'].requiredEvidenceHints,
      [
        'npm run check:production:github-secrets -- --environment=production',
        'Production GitHub secret-store check passed',
        'required secret name(s)',
        'secret values were not read',
      ],
    );
    assert.deepEqual(
      template.areas.releaseGate.checks.audit.requiredEvidenceHints,
      ['npm audit --omit=dev --audit-level=moderate', 'no moderate-or-higher production vulnerabilities'],
    );
    assert.deepEqual(
      template.areas.releaseGate.checks['deploy-smoke'].requiredEvidenceHints,
      [
        'npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers',
        'node scripts/smoke-production-deploy.mjs --production-env-file .env.production',
        'Production deploy smoke passed',
        'https://app.charitypilot.ie',
        'https://api.charitypilot.ie',
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(template.areas.releaseGate.checks['deploy-smoke'].requiredEvidenceHints),
      /smoke:production-deploy/,
    );
    assert.deepEqual(
      template.areas.releaseGate.checks['deploy-production'].requiredEvidenceHints,
      [
        'npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers',
        'compose.production.yml',
        'compose.production-tls.yml or --no-tls-proxy with managed TLS certificate evidence',
        'release-image-digests.env',
        'digest-pinned images',
        'host-wide production cutover lock',
        'quiesced reminder cutover preparation',
        'zero unresolved reminder outcomes',
        'post-deploy smoke',
      ],
    );
    assert.ok(
      template.areas.database.checks['database-check'].requiredEvidenceHints.includes(
        'npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json',
      ),
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.checksumAlgorithm,
      'sha256',
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.format,
      'charitypilot-postgres-restore-proof/v2',
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.expectedReleaseCommitSha,
      'REPLACE_WITH_40_CHARACTER_GIT_SHA',
    );
    assert.deepEqual(
      template.areas.database.checks['database-check'].databaseRestoreProof.helperImplementation,
      {
        format: 'charitypilot-postgres-proof-helper/v1',
        repositoryUrl: 'https://github.com/jasperfordesq-ai/charity-governance',
        commitSha: 'REPLACE_WITH_40_CHARACTER_GIT_SHA',
        sourcePath: 'scripts/postgres-backup.mjs',
        sourceSha256: 'REPLACE_WITH_HELPER_SOURCE_SHA256',
        commitSourceSha256: 'REPLACE_WITH_COMMITTED_HELPER_SOURCE_SHA256',
        sourceMatchesCommit: null,
        canonicalRepositoryMatched: null,
      },
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.toolsImageReference,
      approvedDatabaseToolsImageReference,
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.toolsImageDigestSha256,
      approvedDatabaseToolsImageDigestSha256,
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.workloadSafety.maxDumpBytes,
      '68719476736',
    );
    assert.deepEqual(
      template.areas.database.checks['database-check'].databaseRestoreProof.capacityPreflight,
      {
        method: 'pg-database-size-factor-margin/v1',
        sourceDatabaseSizeBytes: null,
        safetyFactor: 2,
        safetyMarginBytes: '1073741824',
        requiredAvailableBytes: null,
        maximumDumpBytes: '68719476736',
        verified: null,
      },
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.schemaCoverage.largeObjectCount,
      null,
    );
    assert.deepEqual(
      template.areas.database.checks['database-check'].databaseRestoreProof.schemaCertificationScope,
      databaseSchemaCertificationScope,
    );
    assert.equal(
      template.areas.database.checks['database-check'].databaseRestoreProof.tablesCompared,
      null,
    );
    assert.ok(
      template.areas.supabaseStorage.checks['supabase-backups-enabled'].requiredEvidenceHints.includes(
        'document object bytes',
      ),
    );
    assert.ok(
      template.areas.supabaseStorage.checks['supabase-restore-tested'].requiredEvidenceHints.includes(
        'joint PostgreSQL metadata and document object-byte restore',
      ),
    );
    assert.ok(
      template.areas.supabaseStorage.checks['supabase-restore-tested'].requiredEvidenceHints.includes(
        'isolated restore target',
      ),
    );
    assert.ok(
      template.areas.supabaseStorage.checks['supabase-restore-tested'].requiredEvidenceHints.includes(
        'production object storage was not overwritten',
      ),
    );
    assert.equal(
      template.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation.manifestFormat,
      'charitypilot-document-recovery-manifest-v1',
    );
    assert.equal(
      template.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation.metadataRowCount,
      null,
    );
    const jointTemplate =
      template.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation;
    assert.deepEqual(Object.keys(jointTemplate), Object.keys(jointRecoveryReconciliation()));
    const jointHints =
      template.areas.supabaseStorage.checks['supabase-restore-tested'].requiredEvidenceHints;
    assert.equal(jointHints.filter((hint) => hint.startsWith('--expected-')).length, 30);
    for (const hint of [
      '--expected-recovery-event-inventory-sha256=',
      '--expected-restored-recovery-event-inventory-sha256=',
      '--expected-recovery-event-count=',
      '--expected-source-metadata-capture-transaction-id=',
      '--expected-restored-metadata-capture-transaction-id=',
    ]) {
      assert.ok(jointHints.includes(hint), hint);
    }
    for (const forbidden of ['isolationVerified', 'sourceProvenanceExternallyBound']) {
      assert.doesNotMatch(JSON.stringify(jointTemplate), new RegExp(forbidden));
    }
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
      template.areas.browserQa.checks['browser-qa-completed'].requiredEvidenceHints.includes(
        'npm run check:production:browser-qa-env',
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['browser-qa-completed'].requiredEvidenceHints.includes(
        'Deployed browser QA environment preflight passed',
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
    for (const checkId of [
      'browser-qa-completed',
      'desktop-coverage',
      'mobile-coverage',
      'accessibility-coverage',
      'cross-browser-coverage',
      'ios-safari-device-coverage',
      'critical-flows-covered',
    ]) {
      assert.ok(
        template.areas.browserQa.checks[checkId].requiredEvidenceHints.includes('release.commitSha'),
        `${checkId} should tell operators to bind evidence to release.commitSha`,
      );
    }
    assert.ok(
      template.areas.browserQa.checks['critical-flows-covered'].requiredEvidenceHints.includes(
        'Launch-Critical Route Inventory',
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['critical-flows-covered'].requiredEvidenceHints.includes(
        'desktop, mobile, light-mode, and dark-mode evidence',
      ),
    );
    assert.ok(
      template.areas.browserQa.checks['critical-flows-covered'].requiredEvidenceHints.some((hint) =>
        hint.includes('/compliance/${principleId}') && hint.includes('/export'),
      ),
    );
    assert.ok(
      template.areas.securityReview.checks['penetration-test-complete'].requiredEvidenceHints.includes(
        'completed before real charity data',
      ),
    );
    assert.deepEqual(
      template.finalSignoff.approvals.legalCompliance.requiredEvidenceHints,
      ['Legal/compliance owner', 'launch approval', 'release.commitSha'],
    );
    assert.deepEqual(template.finalSignoff.requiredEvidenceHints, ['launch approval', 'release.commitSha']);
    assert.doesNotMatch(JSON.stringify(template), /sk_live_|whsec_|re_[A-Za-z0-9]|postgres(?:ql)?:\/\/|SUPABASE_SERVICE_ROLE_KEY=/);

    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Checklist checks complete: 0 \/ 86 \(0% complete\)/);
    assert.match(result.stderr, /Final approval roles approved: 0 \/ 5 \(0% complete\)/);
    assert.match(
      result.stderr,
      /Track progress with: npm run check:production:evidence:status -- --evidence-file=/,
    );
    assert.match(result.stderr, /approvedForLaunch must be true/);
    assert.match(result.stderr, /areas\.releaseGate\.status must be complete/);
    assert.match(result.stderr, /finalSignoff\.approvals\.engineering\.status must be approved/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence template uses the strict check-production success marker', async () => {
  const { renderProductionLaunchEvidenceTemplate } = await loadEvidenceTemplateGenerator();
  const template = JSON.parse(renderProductionLaunchEvidenceTemplate());
  const hints = template.areas.releaseGate.checks['check-production'].requiredEvidenceHints;

  assert.deepEqual(hints, [
    'npm run check:production -- --production-env-file=.env.production',
    'Production preflight passed',
  ]);
  assert.doesNotMatch(JSON.stringify(hints), /Production configuration check passed/);
});

test('production launch evidence template requires reminder cutover clearance proof', async () => {
  const { renderProductionLaunchEvidenceTemplate } = await loadEvidenceTemplateGenerator();
  const template = JSON.parse(renderProductionLaunchEvidenceTemplate());
  const hints = template.areas.releaseGate.checks['deploy-production'].requiredEvidenceHints;

  assert.ok(hints.includes('quiesced reminder cutover preparation'));
  assert.ok(hints.includes('zero unresolved reminder outcomes'));
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
    assert.match(result.stderr, /releaseGate\.checks\.test\.evidence\[0\]\.capturedAt must not be after finalSignoff\.approvedAt/);
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
  evidence.areas.supabaseStorage.checks['separate-production-project'].evidence[0].description =
    'Supabase project remains https://your-project.supabase.co';
  evidence.areas.securityReview.checks['report-reference'].evidence[0].reference = 'https://unapproved-audit-vault.invalid/report';
  evidence.areas.legalAndCompliance.checks['privacy-policy-approved'].evidence[0].reference =
    'https://evidence.charitypilot.ie/launch/legal/privacy?token=temporary-secret';
  evidence.finalSignoff.approvals.engineering.evidence[0].reference = 'https://github.com/other-owner/other-repo/actions/runs/1';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /hostingDnsTls\.checks\.web-origin\.evidence\[0\]\.reference must be an https URL when a URL is provided/);
    assert.match(result.stderr, /securityReview\.checks\.report-reference\.evidence\[0\]\.reference must be an https URL on an approved evidence host/);
    assert.match(result.stderr, /legalAndCompliance\.checks\.privacy-policy-approved\.evidence\[0\]\.reference must not contain token-bearing query parameters/);
    assert.match(result.stderr, /finalSignoff\.approvals\.engineering\.evidence\[0\]\.reference must use the canonical charity-governance GitHub repository when github\.com is used/);
    assert.match(result.stderr, /observability\.checks\.incident-owner\.evidence\[0\]\.reference must not be a placeholder or local reference/);
    assert.match(result.stderr, /supabaseStorage\.checks\.separate-production-project\.evidence\[0\]\.description must not be a placeholder or local reference/);
    assert.match(result.stderr, /billingAndEmail\.checks\.stripe-webhook-secret\.evidence\[0\]\.description must not contain raw secret-looking values/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
