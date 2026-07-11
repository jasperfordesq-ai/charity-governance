import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  buildRestoreProofReport,
  canonicalSha256 as helperCanonicalSha256,
  compareDatabaseFingerprints,
  parseDatabaseFingerprintReport,
} from './postgres-backup.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const databaseScriptPath = join(scriptsDir, 'check-production-database.mjs');
const SOURCE_IDENTITY = 'a'.repeat(64);
const CAPTURED_SOURCE_IDENTITY = 'b'.repeat(64);
const RECOVERY_SET_ID = 'prod-recovery-2026-07-11';
const EXPECTED_RELEASE_COMMIT_SHA = '1'.repeat(40);
const RESTORE_PROOF_MARKER =
  'Production-safe database restore proof passed: source and isolated restore fingerprints match.';
const SOURCE_IDENTITY_PROVENANCE =
  'The identity digest proves consistency with the supplied source endpoint and read-only server metadata; independent immutable capture and operator control remain external evidence.';
const RESTORE_PROOF_PROVENANCE =
  'This proof verifies a read-only source snapshot against one isolated restore. PostgreSQL ownership and ACL privileges are intentionally excluded by --no-owner and --no-privileges, sequence runtime state is excluded, and provider retention, immutable external custody, document-object recovery, and operator approval remain separate evidence.';
const SEQUENCE_STATE_EXCLUSION_REASON =
  'PostgreSQL sequence values are non-MVCC and cannot be bound to the exported snapshot; this proof therefore fails unless the public schema has zero sequences, identity columns, and nextval defaults.';
const OWNERSHIP_EXCLUSION_REASON =
  'The custom-format dump is captured and restored with --no-owner, so PostgreSQL object ownership is outside this proof.';
const ACL_EXCLUSION_REASON =
  'The custom-format dump is captured and restored with --no-privileges, so PostgreSQL ACL grants and default privileges are outside this proof.';
const APPROVED_TOOLS_IMAGE_REFERENCE =
  'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const APPROVED_TOOLS_IMAGE_DIGEST_SHA256 =
  '5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const SOURCE_IDENTITY_WORKLOAD_SAFETY = {
  tempFileLimitBytes: '1073741824',
  statementTimeoutMs: 120000,
  lockTimeoutMs: 15000,
  idleTransactionTimeoutMs: 180000,
};
const SCHEMA_CERTIFICATION_SCOPE = {
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
};
const CAPACITY_PREFLIGHT = {
  method: 'pg-database-size-factor-margin/v1',
  sourceDatabaseSizeBytes: '1048576',
  safetyFactor: 2,
  safetyMarginBytes: '1073741824',
  requiredAvailableBytes: '1075838976',
  maximumDumpBytes: '68719476736',
  verified: true,
};
const DATABASE_ENVIRONMENT = {
  encoding: 'UTF8',
  collation: 'en_US.utf8',
  ctype: 'en_US.utf8',
  localeProvider: 'libc',
  collationVersion: null,
};
const HELPER_IMPLEMENTATION = {
  format: 'charitypilot-postgres-proof-helper/v1',
  repositoryUrl: 'https://github.com/jasperfordesq-ai/charity-governance',
  commitSha: EXPECTED_RELEASE_COMMIT_SHA,
  sourcePath: 'scripts/postgres-backup.mjs',
  sourceSha256: '8'.repeat(64),
  commitSourceSha256: '8'.repeat(64),
  sourceMatchesCommit: true,
  canonicalRepositoryMatched: true,
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceIdentityHelperPayload(overrides = {}) {
  return {
    format: 'charitypilot-postgres-source-identity/v2',
    ok: true,
    checksumAlgorithm: 'sha256',
    helperImplementation: structuredClone(HELPER_IMPLEMENTATION),
    toolsImageReference: APPROVED_TOOLS_IMAGE_REFERENCE,
    toolsImageDigestSha256: APPROVED_TOOLS_IMAGE_DIGEST_SHA256,
    sourceDatabaseIdentitySha256: CAPTURED_SOURCE_IDENTITY,
    sourceReadOnlyVerified: true,
    workloadSafety: { ...SOURCE_IDENTITY_WORKLOAD_SAFETY },
    secretValuesPrinted: false,
    provenanceLimitation: SOURCE_IDENTITY_PROVENANCE,
    ...overrides,
  };
}

function sourceIdentityHelperStdout(overrides = {}) {
  return `${JSON.stringify(sourceIdentityHelperPayload(overrides))}\n`;
}

async function loadDatabaseRunner() {
  assert.ok(existsSync(databaseScriptPath), 'production database checker script must exist');
  const module = await import(pathToFileURL(databaseScriptPath).href);
  assert.equal(typeof module.runProductionDatabaseCheckFromArgs, 'function');
  return (args, dependencies = {}) => module.runProductionDatabaseCheckFromArgs(args, {
    repoRoot: join(tmpdir(), 'charitypilot-checker-test-forbidden-repository'),
    osTempRoots: [join(tmpdir(), 'charitypilot-checker-test-forbidden-os-temp')],
    captureHelperImplementationBinding: () => structuredClone(HELPER_IMPLEMENTATION),
    ...dependencies,
  });
}

function productionEnv(overrides = {}) {
  const values = {
    DATABASE_URL: 'postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    ...overrides,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function writeEnvFile(content = productionEnv(), prefix = 'charitypilot-production-database-') {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const envPath = join(tempDir, 'production.env');
  writeFileSync(envPath, content);
  return { tempDir, envPath };
}

function proofArgs(envPath, extras = []) {
  const hasOutputDirectory = extras.some((arg) =>
    arg === '--backup-output-dir' || arg.startsWith('--backup-output-dir='));
  return [
    '--production-env-file', envPath,
    '--expected-release-commit-sha', EXPECTED_RELEASE_COMMIT_SHA,
    '--recovery-set-id', RECOVERY_SET_ID,
    '--expected-source-database-identity-sha256', SOURCE_IDENTITY,
    ...(hasOutputDirectory ? [] : ['--backup-output-dir', join(dirname(envPath), 'proof-output')]),
    ...extras,
  ];
}

function sourceIdentityArgs(envPath, extras = []) {
  return [
    '--production-env-file', envPath,
    '--expected-release-commit-sha', EXPECTED_RELEASE_COMMIT_SHA,
    '--capture-source-identity',
    ...extras,
  ];
}

function proofReport(args, dumpContent) {
  const dumpSha256 = sha256(dumpContent);
  const expectedIdentity = args
    .find((arg) => arg.startsWith('--expected-source-database-identity-sha256='))
    .slice('--expected-source-database-identity-sha256='.length);
  const recoverySetId = args
    .find((arg) => arg.startsWith('--recovery-set-id='))
    .slice('--recovery-set-id='.length);
  const table = {
    schema: 'public',
    table: 'Organisation',
    relationKind: 'r',
    isPartition: false,
    rowCount: '4',
    schemaSha256: '6'.repeat(64),
    rowsSha256: '7'.repeat(64),
  };
  table.tableFingerprintSha256 = helperCanonicalSha256('charitypilot-table-fingerprint/v2', [
    Buffer.from(table.schema).toString('hex'),
    Buffer.from(table.table).toString('hex'),
    table.relationKind,
    table.isPartition ? 'partition' : 'not-partition',
    table.rowCount,
    table.schemaSha256,
    table.rowsSha256,
  ]);
  const tableMembershipSha256 = helperCanonicalSha256('charitypilot-public-table-membership/v2', [
    [
      Buffer.from(table.schema).toString('hex'),
      Buffer.from(table.table).toString('hex'),
      table.relationKind,
      table.isPartition ? '1' : '0',
    ].join('|'),
  ]);
  const publicSchemaSha256 = '5'.repeat(64);
  const databaseFingerprintSha256 = helperCanonicalSha256('charitypilot-database-fingerprint/v2', [
    DATABASE_ENVIRONMENT.encoding,
    DATABASE_ENVIRONMENT.collation,
    DATABASE_ENVIRONMENT.ctype,
    DATABASE_ENVIRONMENT.localeProvider,
    DATABASE_ENVIRONMENT.collationVersion ?? '',
    tableMembershipSha256,
    publicSchemaSha256,
    [
      Buffer.from(table.schema).toString('hex'),
      Buffer.from(table.table).toString('hex'),
      table.relationKind,
      table.isPartition ? '1' : '0',
      table.rowCount,
      table.schemaSha256,
      table.rowsSha256,
      table.tableFingerprintSha256,
    ].join('|'),
  ]);
  const workloadSafety = {
    tempFileLimitBytes: '1073741824',
    maxPublicTables: 5000,
    maxRowsPerTable: 25000000,
    maxTotalRows: 100000000,
    maxFingerprintReportBytes: 16777216,
  };
  const schemaCoverage = {
    publicObjectCount: 1,
    unsupportedPublicObjectCount: 0,
    publicSequenceCount: 0,
    applicationIdentityColumnCount: 0,
    applicationSequenceDefaultCount: 0,
    largeObjectCount: 0,
  };
  const fingerprintBody = {
    databaseEnvironment: { ...DATABASE_ENVIRONMENT },
    publicSchemaSha256,
    tableMembershipSha256,
    databaseFingerprintSha256,
    tableCount: 1,
    totalRows: '4',
    workloadSafety,
    schemaCoverage,
    tables: [table],
  };
  const fingerprintReportSha256 = sha256(`${JSON.stringify(fingerprintBody, null, 2)}\n`);
  const dumpDescriptorSha256 = '2'.repeat(64);
  const sourceBindingSha256 = sha256([
    'charitypilot-source-dump-binding/v2',
    recoverySetId,
    expectedIdentity,
    HELPER_IMPLEMENTATION.sourceSha256,
    HELPER_IMPLEMENTATION.commitSha,
    dumpSha256,
    String(Buffer.byteLength(dumpContent)),
    dumpDescriptorSha256,
    databaseFingerprintSha256,
    fingerprintReportSha256,
  ].join('\n'));
  return {
    format: 'charitypilot-postgres-restore-proof/v2',
    ok: true,
    checksumAlgorithm: 'sha256',
    helperImplementation: structuredClone(HELPER_IMPLEMENTATION),
    toolsImageReference: APPROVED_TOOLS_IMAGE_REFERENCE,
    toolsImageDigestSha256: APPROVED_TOOLS_IMAGE_DIGEST_SHA256,
    recoverySetId,
    capturedAt: new Date().toISOString(),
    sourceDatabaseIdentitySha256: expectedIdentity,
    expectedSourceDatabaseIdentitySha256: expectedIdentity,
    sourceIdentityBindingMatched: true,
    sourceReadOnlyVerified: true,
    snapshot: {
      isolationLevel: 'repeatable read',
      readOnly: true,
      rowSecurityOff: true,
      accessShareLocks: true,
      exported: true,
      snapshotIdSha256: '1'.repeat(64),
    },
    dump: {
      fileName: 'production-check.dump',
      sha256: dumpSha256,
      bytes: String(Buffer.byteLength(dumpContent)),
      descriptorSha256: dumpDescriptorSha256,
      descriptorEntryCount: 19,
      rehashAfterRestoreSha256: dumpSha256,
      bytesAfterRestore: String(Buffer.byteLength(dumpContent)),
      descriptorAfterRestoreSha256: dumpDescriptorSha256,
      unchangedDuringProof: true,
      sourceBindingSha256,
      capacityPreflight: { ...CAPACITY_PREFLIGHT },
    },
    source: {
      fingerprintReportSha256,
      databaseEnvironment: { ...DATABASE_ENVIRONMENT },
      publicSchemaSha256,
      tableMembershipSha256,
      databaseFingerprintSha256,
      tableCount: 1,
      totalRows: '4',
      workloadSafety: { ...workloadSafety },
      schemaCoverage: { ...schemaCoverage },
      tables: [table],
    },
    restored: {
      fingerprintReportSha256,
      databaseEnvironment: { ...DATABASE_ENVIRONMENT },
      publicSchemaSha256,
      tableMembershipSha256,
      databaseFingerprintSha256,
      tableCount: 1,
      totalRows: '4',
      workloadSafety: { ...workloadSafety },
      schemaCoverage: { ...schemaCoverage },
      tables: [{ ...table }],
      databaseIdentitySha256: 'd'.repeat(64),
    },
    restoreTarget: {
      type: 'isolated-disposable-postgresql',
      identitySha256: 'd'.repeat(64),
      databaseEnvironment: { ...DATABASE_ENVIRONMENT },
      initializedFromSourceDatabaseEnvironment: true,
      databaseEnvironmentPreserved: true,
      networkPublished: false,
      hostVolumeForDatabase: false,
      ephemeralData: true,
      productionOverwritten: false,
      cleanupVerified: true,
    },
    comparison: {
      databaseEnvironmentMatched: true,
      tableMembershipMatched: true,
      schemaMatched: true,
      rowCountsMatched: true,
      rowFingerprintsMatched: true,
      databaseFingerprintMatched: true,
      tablesCompared: 1,
      mismatchCount: 0,
    },
    schemaCertificationScope: structuredClone(SCHEMA_CERTIFICATION_SCOPE),
    sequenceStateIncluded: false,
    sequenceDefinitionAndOwnershipBound: true,
    publicSequenceCount: 0,
    applicationIdentityColumnCount: 0,
    applicationSequenceDefaultCount: 0,
    sequenceStateExclusionReason: SEQUENCE_STATE_EXCLUSION_REASON,
    ownershipIncluded: false,
    ownershipExclusionReason: OWNERSHIP_EXCLUSION_REASON,
    aclPrivilegesIncluded: false,
    aclPrivilegesExclusionReason: ACL_EXCLUSION_REASON,
    workloadSafety: {
      ...workloadSafety,
      maxDumpBytes: '68719476736',
      statementTimeoutMs: 1800000,
      lockTimeoutMs: 30000,
      idleTransactionTimeoutMs: 2640000,
    },
    provenanceLimitation: RESTORE_PROOF_PROVENANCE,
    secretValuesPrinted: false,
  };
}

function writeProofArtifacts(args, { dumpContent = 'safe proof artifact', mutateReport } = {}) {
  const outputDir = args.find((arg) => arg.startsWith('--output-dir=')).slice('--output-dir='.length);
  const dumpName = args.find((arg) => arg.startsWith('--output-file=')).slice('--output-file='.length);
  const reportName = args.find((arg) => arg.startsWith('--report-file=')).slice('--report-file='.length);
  writeFileSync(join(outputDir, dumpName), dumpContent);
  const report = proofReport(args, dumpContent);
  mutateReport?.(report);
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(outputDir, reportName), reportBytes);
  return { report, reportSha256: sha256(reportBytes), dumpSha256: sha256(dumpContent) };
}

function rawHelperFingerprint({ databaseIdentitySha256, snapshotSha256, includeCapacityPreflight = false }) {
  return [
    `meta|source_snapshot_sha256|${snapshotSha256}`,
    `meta|database_identity_sha256|${databaseIdentitySha256}`,
    `meta|database_encoding_hex|${Buffer.from('UTF8').toString('hex')}`,
    `meta|database_collation_hex|${Buffer.from('en_US.utf8').toString('hex')}`,
    `meta|database_ctype_hex|${Buffer.from('en_US.utf8').toString('hex')}`,
    'meta|database_locale_provider|c',
    'meta|database_collation_version_hex|',
    `meta|public_schema_sha256|${'5'.repeat(64)}`,
    'meta|settings_verified|1',
    'meta|access_share_locks_verified|1',
    'meta|temp_file_limit_bytes|1073741824',
    'meta|max_public_tables|5000',
    'meta|max_rows_per_table|25000000',
    'meta|max_total_rows|100000000',
    'meta|public_object_count|1',
    'meta|public_sequence_count|0',
    'meta|application_identity_column_count|0',
    'meta|application_sequence_default_count|0',
    'meta|unsupported_public_object_count|0',
    'meta|large_object_count|0',
    ...(includeCapacityPreflight ? [
      `meta|source_database_size_bytes|${CAPACITY_PREFLIGHT.sourceDatabaseSizeBytes}`,
      `meta|capacity_required_bytes|${CAPACITY_PREFLIGHT.requiredAvailableBytes}`,
      'meta|capacity_preflight_verified|1',
    ] : []),
    `table|${Buffer.from('public').toString('hex')}|${Buffer.from('MaterializedSummary').toString('hex')}|m|0|1|4|${'6'.repeat(64)}|${'7'.repeat(64)}`,
    '',
  ].join('\n');
}

function writeHelperContractProofArtifacts(args, dumpContent = 'helper contract proof artifact') {
  const outputDir = args.find((arg) => arg.startsWith('--output-dir=')).slice('--output-dir='.length);
  const dumpName = args.find((arg) => arg.startsWith('--output-file=')).slice('--output-file='.length);
  const reportName = args.find((arg) => arg.startsWith('--report-file=')).slice('--report-file='.length);
  const recoverySetId = args.find((arg) => arg.startsWith('--recovery-set-id='))
    .slice('--recovery-set-id='.length);
  const expectedIdentity = args.find((arg) => arg.startsWith('--expected-source-database-identity-sha256='))
    .slice('--expected-source-database-identity-sha256='.length);
  const source = parseDatabaseFingerprintReport(rawHelperFingerprint({
    databaseIdentitySha256: expectedIdentity,
    snapshotSha256: '1'.repeat(64),
    includeCapacityPreflight: true,
  }));
  const restored = parseDatabaseFingerprintReport(rawHelperFingerprint({
    databaseIdentitySha256: 'd'.repeat(64),
    snapshotSha256: '8'.repeat(64),
  }));
  const comparison = compareDatabaseFingerprints(source, restored);
  const dumpSha256 = sha256(dumpContent);
  const dumpBytes = Buffer.byteLength(dumpContent);
  const dumpDescriptor = { sha256: '2'.repeat(64), entryCount: 19 };
  const report = buildRestoreProofReport({
    recoverySetId,
    capturedAt: new Date().toISOString(),
    expectedSourceDatabaseIdentitySha256: expectedIdentity,
    outputFile: dumpName,
    dumpSha256Before: dumpSha256,
    dumpBytesBefore: dumpBytes,
    dumpDescriptorBefore: dumpDescriptor,
    dumpSha256After: dumpSha256,
    dumpBytesAfter: dumpBytes,
    dumpDescriptorAfter: dumpDescriptor,
    source,
    restored,
    comparison,
    helperImplementation: structuredClone(HELPER_IMPLEMENTATION),
  });
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(outputDir, dumpName), dumpContent);
  writeFileSync(join(outputDir, reportName), reportBytes);
  return { report, reportSha256: sha256(reportBytes) };
}

function successfulProofHelper(calls) {
  return async (args, env) => {
    calls.push({ args, env });
    const evidence = writeProofArtifacts(args);
    return {
      status: 0,
      stdout: `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${evidence.reportSha256}\nProof report file: production-check.restore-proof.json\n`,
      stderr: '',
    };
  };
}

test('production checker invokes prove-restore once, passes DATABASE_URL only through helper env, and deletes default artifacts', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const backupDir = join(tempDir, 'sensitive-output-path');
  const calls = [];
  try {
    const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir]), {
      runPostgresBackupFromArgs: successfulProofHelper(calls),
    });

    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      'prove-restore',
      `--recovery-set-id=${RECOVERY_SET_ID}`,
      `--expected-source-database-identity-sha256=${SOURCE_IDENTITY}`,
      `--output-dir=${backupDir}`,
      '--output-file=production-check.dump',
      '--report-file=production-check.restore-proof.json',
    ]);
    assert.equal(calls[0].env.DATABASE_URL, 'postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write');
    assert.equal(calls[0].env.CHARITYPILOT_POSTGRES_TOOLS_IMAGE, APPROVED_TOOLS_IMAGE_REFERENCE);
    assert.doesNotMatch(calls[0].args.join(' '), /postgres(?:ql)?:\/\/|backup-user|secret/);
    assert.match(outcome.stdout, /snapshot-bound read-only source\/restored SHA-256 reconciliation passed/);
    assert.match(outcome.stdout, /production was not written/);
    assert.match(outcome.stdout, /Source TLS server authentication verified: true/);
    assert.match(outcome.stdout, new RegExp(RECOVERY_SET_ID));
    assert.match(outcome.stdout, new RegExp(SOURCE_IDENTITY));
    assert.doesNotMatch(outcome.stdout + outcome.stderr, /backup-user|secret|sensitive-output-path|postgres(?:ql)?:\/\//);
    assert.equal(existsSync(backupDir), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checker independently binds the stable helper source to canonical git evidence', async () => {
  const module = await import(pathToFileURL(databaseScriptPath).href);
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-helper-binding-'));
  const sourceDir = join(tempDir, 'scripts');
  const sourceFile = join(sourceDir, 'postgres-backup.mjs');
  const sourceBytes = Buffer.from('export const helper = true;\n', 'utf8');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(sourceFile, sourceBytes);
  const gitCalls = [];
  try {
    const binding = module.captureExpectedHelperImplementationBinding({
      repoRoot: tempDir,
      sourceFile,
      runGit: (_command, args) => {
        const gitArgs = args.slice(2);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === 'rev-parse') {
          return { status: 0, stdout: `${EXPECTED_RELEASE_COMMIT_SHA}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'show') return { status: 0, stdout: sourceBytes, stderr: Buffer.alloc(0) };
        if (gitArgs[0] === 'remote') {
          return { status: 0, stdout: 'git@github.com:jasperfordesq-ai/charity-governance.git\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      },
    });
    const sourceSha256 = sha256(sourceBytes);
    assert.deepEqual(binding, {
      ...HELPER_IMPLEMENTATION,
      sourceSha256,
      commitSourceSha256: sourceSha256,
    });
    assert.deepEqual(gitCalls, [
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      ['show', `${EXPECTED_RELEASE_COMMIT_SHA}:scripts/postgres-backup.mjs`],
      ['remote', 'get-url', 'origin'],
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker rejects dirty, mismatched, or drifting helper implementation bindings', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    let helperCalled = false;
    const dirty = await run(sourceIdentityArgs(envPath), {
      captureHelperImplementationBinding: () => ({
        ...structuredClone(HELPER_IMPLEMENTATION),
        commitSourceSha256: '9'.repeat(64),
        sourceMatchesCommit: false,
      }),
      runPostgresBackupFromArgs: async () => {
        helperCalled = true;
        return { status: 0, stdout: sourceIdentityHelperStdout(), stderr: '' };
      },
    });
    assert.equal(dirty.status, 1);
    assert.equal(helperCalled, false);
    assert.match(dirty.stderr, /approved helper implementation could not be bound/);

    for (const mode of ['identity', 'proof']) {
      let captureCount = 0;
      const outputDir = join(tempDir, `${mode}-drift`);
      const outcome = await run(
        mode === 'identity'
          ? sourceIdentityArgs(envPath)
          : proofArgs(envPath, ['--backup-output-dir', outputDir]),
        {
          captureHelperImplementationBinding: () => {
            captureCount += 1;
            return captureCount === 1
              ? structuredClone(HELPER_IMPLEMENTATION)
              : { ...structuredClone(HELPER_IMPLEMENTATION), sourceSha256: '9'.repeat(64) };
          },
          runPostgresBackupFromArgs: mode === 'identity'
            ? async () => ({ status: 0, stdout: sourceIdentityHelperStdout(), stderr: '' })
            : successfulProofHelper([]),
        },
      );
      assert.equal(outcome.status, 1, mode);
      assert.equal(captureCount, 2, mode);
      assert.match(outcome.stderr, /helper implementation changed or lost its release binding/, mode);
      assert.equal(existsSync(outputDir), false, mode);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker accepts the helper-export-built v2 contract including materialized views', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const backupDir = join(tempDir, 'helper-contract-output');
  let helperEvidence;
  try {
    const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir, '--json']), {
      runPostgresBackupFromArgs: async (args) => {
        helperEvidence = writeHelperContractProofArtifacts(args);
        return {
          status: 0,
          stdout: `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${helperEvidence.reportSha256}\nProof report file: production-check.restore-proof.json\n`,
          stderr: '',
        };
      },
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    const payload = JSON.parse(outcome.stdout);
    assert.equal(payload.sourceDatabaseFingerprintSha256, helperEvidence.report.source.databaseFingerprintSha256);
    assert.equal(payload.restoredDatabaseFingerprintSha256, helperEvidence.report.restored.databaseFingerprintSha256);
    assert.equal(helperEvidence.report.source.tables[0].relationKind, 'm');
    assert.equal(existsSync(backupDir), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker emits an allowlisted JSON restore-proof payload', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const backupDir = join(tempDir, 'json-output');
  try {
    const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir, '--json']), {
      runPostgresBackupFromArgs: successfulProofHelper([]),
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stderr, '');
    const payload = JSON.parse(outcome.stdout);
    assert.deepEqual(Object.keys(payload), [
      'format', 'ok', 'mode', 'proof', 'checksumAlgorithm', 'expectedReleaseCommitSha',
      'helperImplementation', 'toolsImageReference',
      'toolsImageDigestSha256', 'snapshotBound', 'sourceReadOnlyVerified',
      'sourceTlsServerAuthenticationVerified',
      'sourceAndIsolatedRestoreFingerprintsMatch', 'productionWritten', 'recoverySetId',
      'capturedAt', 'expectedSourceDatabaseIdentitySha256', 'sourceDatabaseIdentitySha256',
      'sourceIdentityBindingMatched',
      'databaseDumpSha256', 'databaseDumpBytes', 'capacityPreflight', 'dumpDescriptorSha256',
      'dumpSourceBindingSha256', 'proofReportSha256', 'sourceDatabaseFingerprintSha256',
      'restoredDatabaseFingerprintSha256', 'sourceDatabaseEnvironment',
      'restoredDatabaseEnvironment', 'restoreTargetDatabaseEnvironment',
      'restoreInitializedFromSourceDatabaseEnvironment', 'databaseEnvironmentPreserved',
      'databaseEnvironmentMatched', 'publicSchemaSha256', 'tableMembershipSha256',
      'snapshotIdSha256', 'isolatedRestoreDatabaseIdentitySha256', 'tablesCompared',
      'mismatchCount', 'sequenceStateIncluded', 'sequenceDefinitionAndOwnershipBound',
      'publicSequenceCount', 'applicationIdentityColumnCount', 'applicationSequenceDefaultCount',
      'sequenceStateExclusionReason', 'ownershipIncluded', 'ownershipExclusionReason',
      'aclPrivilegesIncluded', 'aclPrivilegesExclusionReason', 'workloadSafety',
      'schemaCoverage', 'schemaCertificationScope', 'backupArtifactsRetained',
      'secretValuesPrinted', 'provenanceLimitation',
    ]);
    assert.equal(payload.ok, true);
    assert.equal(payload.format, 'charitypilot-postgres-restore-proof/v2');
    assert.equal(payload.mode, 'prove-restore');
    assert.equal(payload.proof, 'snapshot-bound-read-only-source-restored-sha256-reconciliation');
    assert.equal(payload.expectedReleaseCommitSha, EXPECTED_RELEASE_COMMIT_SHA);
    assert.deepEqual(payload.helperImplementation, HELPER_IMPLEMENTATION);
    assert.equal(payload.toolsImageReference, APPROVED_TOOLS_IMAGE_REFERENCE);
    assert.equal(payload.toolsImageDigestSha256, APPROVED_TOOLS_IMAGE_DIGEST_SHA256);
    assert.equal(payload.snapshotBound, true);
    assert.equal(payload.sourceReadOnlyVerified, true);
    assert.equal(payload.sourceTlsServerAuthenticationVerified, true);
    assert.equal(payload.sourceAndIsolatedRestoreFingerprintsMatch, true);
    assert.equal(payload.productionWritten, false);
    assert.equal(payload.recoverySetId, RECOVERY_SET_ID);
    assert.equal(payload.expectedSourceDatabaseIdentitySha256, SOURCE_IDENTITY);
    assert.equal(payload.sourceDatabaseIdentitySha256, SOURCE_IDENTITY);
    assert.equal(payload.sourceIdentityBindingMatched, true);
    assert.equal(payload.databaseDumpSha256, sha256('safe proof artifact'));
    assert.equal(payload.databaseDumpBytes, '19');
    assert.deepEqual(payload.capacityPreflight, CAPACITY_PREFLIGHT);
    assert.match(payload.proofReportSha256, /^[a-f0-9]{64}$/);
    assert.equal(payload.sourceDatabaseFingerprintSha256, payload.restoredDatabaseFingerprintSha256);
    assert.deepEqual(payload.sourceDatabaseEnvironment, DATABASE_ENVIRONMENT);
    assert.deepEqual(payload.restoredDatabaseEnvironment, DATABASE_ENVIRONMENT);
    assert.deepEqual(payload.restoreTargetDatabaseEnvironment, DATABASE_ENVIRONMENT);
    assert.equal(payload.restoreInitializedFromSourceDatabaseEnvironment, true);
    assert.equal(payload.databaseEnvironmentPreserved, true);
    assert.equal(payload.databaseEnvironmentMatched, true);
    assert.equal(payload.tablesCompared, 1);
    assert.equal(payload.mismatchCount, 0);
    assert.equal(payload.sequenceStateIncluded, false);
    assert.equal(payload.sequenceDefinitionAndOwnershipBound, true);
    assert.equal(payload.publicSequenceCount, 0);
    assert.equal(payload.applicationIdentityColumnCount, 0);
    assert.equal(payload.applicationSequenceDefaultCount, 0);
    assert.equal(payload.sequenceStateExclusionReason, SEQUENCE_STATE_EXCLUSION_REASON);
    assert.equal(payload.ownershipIncluded, false);
    assert.equal(payload.ownershipExclusionReason, OWNERSHIP_EXCLUSION_REASON);
    assert.equal(payload.aclPrivilegesIncluded, false);
    assert.equal(payload.aclPrivilegesExclusionReason, ACL_EXCLUSION_REASON);
    assert.deepEqual(payload.workloadSafety, {
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
    assert.deepEqual(payload.schemaCoverage, {
      publicObjectCount: 1,
      unsupportedPublicObjectCount: 0,
      publicSequenceCount: 0,
      applicationIdentityColumnCount: 0,
      applicationSequenceDefaultCount: 0,
      largeObjectCount: 0,
    });
    assert.deepEqual(payload.schemaCertificationScope, SCHEMA_CERTIFICATION_SCOPE);
    assert.equal(payload.backupArtifactsRetained, false);
    assert.equal(payload.secretValuesPrinted, false);
    assert.equal(payload.provenanceLimitation, RESTORE_PROOF_PROVENANCE);
    assert.doesNotMatch(outcome.stdout, /DATABASE_URL|postgres(?:ql)?:\/\/|json-output/);
    assert.equal(existsSync(backupDir), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker retains proof artifacts only with explicit output directory and keep flag', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const outputDir = join(tempDir, 'retained-proof');
  try {
    const outcome = await run(proofArgs(envPath, [
      `--backup-output-dir=${outputDir}`,
      '--keep-backup',
    ]), { runPostgresBackupFromArgs: successfulProofHelper([]) });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(readdirSync(outputDir).sort(), [
      'production-check.dump',
      'production-check.restore-proof.json',
    ]);
    if (process.platform !== 'win32') assert.equal(statSync(outputDir).mode & 0o077, 0);
    assert.match(outcome.stdout, /retained in the caller-selected output directory/);
    assert.doesNotMatch(outcome.stdout, /retained-proof/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker removes only its named artifacts from a pre-existing output directory', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const outputDir = join(tempDir, 'existing-output');
  try {
    writeFileSync(join(tempDir, 'placeholder'), 'parent exists');
    mkdirSync(outputDir, { mode: 0o700 });
    writeFileSync(join(outputDir, 'user-owned.txt'), 'preserve me');
    const outcome = await run(proofArgs(envPath, ['--backup-output-dir', outputDir]), {
      runPostgresBackupFromArgs: successfulProofHelper([]),
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(readdirSync(outputDir), ['user-owned.txt']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker rejects missing or malformed independent bindings before helper invocation', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const releaseArgs = [
    '--production-env-file', envPath,
    '--expected-release-commit-sha', EXPECTED_RELEASE_COMMIT_SHA,
  ];
  const invalidCases = [
    { args: ['--production-env-file', envPath], message: /--expected-release-commit-sha is required/ },
    { args: releaseArgs, message: /--recovery-set-id is required/ },
    { args: [...releaseArgs, '--recovery-set-id', 'ab'], message: /bounded operational identifier/ },
    { args: [...releaseArgs, '--recovery-set-id', `${'a'.repeat(129)}`], message: /bounded operational identifier/ },
    { args: [...releaseArgs, '--recovery-set-id', 'unsafe id'], message: /bounded operational identifier/ },
    { args: [...releaseArgs, '--recovery-set-id', RECOVERY_SET_ID], message: /expected-source-database-identity-sha256 is required/ },
    { args: [...releaseArgs, '--recovery-set-id', RECOVERY_SET_ID, '--expected-source-database-identity-sha256', 'A'.repeat(64)], message: /lowercase SHA-256 digest/ },
    { args: [...releaseArgs, '--recovery-set-id', RECOVERY_SET_ID, '--expected-source-database-identity-sha256', 'a'.repeat(63)], message: /lowercase SHA-256 digest/ },
  ];
  try {
    for (const invalidCase of invalidCases) {
      let called = false;
      const outcome = await run(invalidCase.args, {
        runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
      });
      assert.equal(outcome.status, 2);
      assert.equal(called, false);
      assert.match(outcome.stderr, invalidCase.message);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker rejects legacy sentinel semantics and proof without an explicit destination', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    for (const args of [
      [...proofArgs(envPath), '--expect-operational-sentinel'],
      [...proofArgs(envPath), '--expect-operational-sentinel=true'],
      [
        '--production-env-file', envPath,
        '--expected-release-commit-sha', EXPECTED_RELEASE_COMMIT_SHA,
        '--recovery-set-id', RECOVERY_SET_ID,
        '--expected-source-database-identity-sha256', SOURCE_IDENTITY,
      ],
    ]) {
      let called = false;
      const outcome = await run(args, {
        runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
      });
      assert.equal(outcome.status, 2);
      assert.equal(called, false);
      assert.match(outcome.stderr, /production sentinel writes are unsafe|--backup-output-dir is required/);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker requires the exact restore-proof marker and suppresses arbitrary helper output', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    for (const stdout of [
      '',
      `${RESTORE_PROOF_MARKER} almost\n`,
      `prefix ${RESTORE_PROOF_MARKER}\n`,
    ]) {
      const backupDir = join(tempDir, `marker-${Math.random().toString(16).slice(2)}`);
      const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir]), {
        runPostgresBackupFromArgs: async (args) => {
          writeProofArtifacts(args);
          return { status: 0, stdout: `${stdout} postgresql://leaked-user:leaked-pass@secret.example/private`, stderr: '' };
        },
      });
      assert.equal(outcome.status, 1);
      assert.match(outcome.stderr, /required safe success marker/);
      assert.doesNotMatch(outcome.stderr + outcome.stdout, /leaked-user|leaked-pass|secret\.example|private|postgres(?:ql)?:\/\//);
      assert.equal(existsSync(backupDir), false);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker rejects every critical malformed or inconsistent proof-report field', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const invalidCases = [
    ['extra top-level field', (proof) => { proof.unapproved = true; }],
    ['wrong format', (proof) => { proof.format = 'charitypilot-postgres-restore-proof/v1'; }],
    ['helper commit differs from expected release', (proof) => { proof.helperImplementation.commitSha = '2'.repeat(40); }],
    ['helper source differs from committed source', (proof) => { proof.helperImplementation.commitSourceSha256 = '9'.repeat(64); }],
    ['helper source match is false', (proof) => { proof.helperImplementation.sourceMatchesCommit = false; }],
    ['helper canonical repository is false', (proof) => { proof.helperImplementation.canonicalRepositoryMatched = false; }],
    ['not ok', (proof) => { proof.ok = false; }],
    ['wrong checksum algorithm', (proof) => { proof.checksumAlgorithm = 'md5'; }],
    ['unapproved tools image reference', (proof) => { proof.toolsImageReference = `postgres@sha256:${'e'.repeat(64)}`; }],
    ['unapproved tools image digest', (proof) => { proof.toolsImageDigestSha256 = 'e'.repeat(64); }],
    ['wrong recovery set', (proof) => { proof.recoverySetId = 'different-recovery-set'; }],
    ['actual source identity not externally bound', (proof) => { proof.sourceDatabaseIdentitySha256 = 'e'.repeat(64); }],
    ['expected source identity not externally bound', (proof) => { proof.expectedSourceDatabaseIdentitySha256 = 'e'.repeat(64); }],
    ['source identity binding false', (proof) => { proof.sourceIdentityBindingMatched = false; }],
    ['source read-only false', (proof) => { proof.sourceReadOnlyVerified = false; }],
    ['invalid capture timestamp', (proof) => { proof.capturedAt = 'not-an-iso-timestamp'; }],
    ['capture timestamp predates helper invocation', (proof) => { proof.capturedAt = new Date(Date.now() - 60_000).toISOString(); }],
    ['capture timestamp follows helper completion', (proof) => { proof.capturedAt = new Date(Date.now() + 60_000).toISOString(); }],
    ['snapshot not repeatable read', (proof) => { proof.snapshot.isolationLevel = 'read committed'; }],
    ['snapshot not read-only', (proof) => { proof.snapshot.readOnly = false; }],
    ['row security not disabled', (proof) => { proof.snapshot.rowSecurityOff = false; }],
    ['table locks absent', (proof) => { proof.snapshot.accessShareLocks = false; }],
    ['snapshot not exported', (proof) => { proof.snapshot.exported = false; }],
    ['extra snapshot field', (proof) => { proof.snapshot.unapproved = true; }],
    ['dump hash does not match bytes', (proof) => { proof.dump.sha256 = 'e'.repeat(64); }],
    ['dump byte count does not match bytes', (proof) => { proof.dump.bytes = '999'; }],
    ['dump descriptor malformed', (proof) => { proof.dump.descriptorSha256 = 'bad'; }],
    ['dump rehash differs', (proof) => { proof.dump.rehashAfterRestoreSha256 = 'e'.repeat(64); }],
    ['dump post-restore bytes differ', (proof) => { proof.dump.bytesAfterRestore = '20'; }],
    ['dump post-restore descriptor differs', (proof) => { proof.dump.descriptorAfterRestoreSha256 = 'e'.repeat(64); }],
    ['dump changed during proof', (proof) => { proof.dump.unchangedDuringProof = false; }],
    ['capacity preflight missing', (proof) => { delete proof.dump.capacityPreflight; }],
    ['capacity preflight method changed', (proof) => { proof.dump.capacityPreflight.method = 'free-space-only/v1'; }],
    ['capacity preflight source size is not canonical', (proof) => { proof.dump.capacityPreflight.sourceDatabaseSizeBytes = '01'; }],
    ['capacity preflight formula changed', (proof) => { proof.dump.capacityPreflight.requiredAvailableBytes = '1075838977'; }],
    ['capacity preflight maximum changed', (proof) => { proof.dump.capacityPreflight.maximumDumpBytes = '1'; }],
    ['capacity preflight not verified', (proof) => { proof.dump.capacityPreflight.verified = false; }],
    ['extra dump field', (proof) => { proof.dump.unapproved = true; }],
    ['source fingerprint malformed', (proof) => { proof.source.databaseFingerprintSha256 = 'bad'; }],
    ['source database encoding malformed', (proof) => { proof.source.databaseEnvironment.encoding = 'utf-8'; }],
    ['source database environment has extra fields', (proof) => { proof.source.databaseEnvironment.unapproved = true; }],
    ['source total rows inconsistent', (proof) => { proof.source.totalRows = '5'; }],
    ['source workload table limit changed', (proof) => { proof.source.workloadSafety.maxPublicTables = 4999; }],
    ['source temp-file limit below bound', (proof) => { proof.source.workloadSafety.tempFileLimitBytes = '67108863'; }],
    ['source schema has unsupported objects', (proof) => { proof.source.schemaCoverage.unsupportedPublicObjectCount = 1; }],
    ['source schema has large objects', (proof) => { proof.source.schemaCoverage.largeObjectCount = 1; }],
    ['duplicate source table', (proof) => { proof.source.tables.push({ ...proof.source.tables[0] }); proof.source.tableCount = 2; proof.source.totalRows = '8'; }],
    ['restored public schema differs', (proof) => { proof.restored.publicSchemaSha256 = 'e'.repeat(64); }],
    ['restored database fingerprint differs', (proof) => { proof.restored.databaseFingerprintSha256 = 'e'.repeat(64); }],
    ['restored database collation differs', (proof) => { proof.restored.databaseEnvironment.collation = 'C'; }],
    ['restored table rows differ', (proof) => { proof.restored.tables[0].rowsSha256 = 'e'.repeat(64); }],
    ['restore target not isolated', (proof) => { proof.restoreTarget.type = 'production-postgresql'; }],
    ['restore target identity does not bind restored identity', (proof) => { proof.restoreTarget.identitySha256 = 'e'.repeat(64); }],
    ['restore target identity equals source identity', (proof) => { proof.restoreTarget.identitySha256 = SOURCE_IDENTITY; proof.restored.databaseIdentitySha256 = SOURCE_IDENTITY; }],
    ['restore target database environment differs', (proof) => { proof.restoreTarget.databaseEnvironment.ctype = 'C'; }],
    ['restore target was not initialized from source environment', (proof) => { proof.restoreTarget.initializedFromSourceDatabaseEnvironment = false; }],
    ['restore target environment was not preserved', (proof) => { proof.restoreTarget.databaseEnvironmentPreserved = false; }],
    ['restore target publishes a network port', (proof) => { proof.restoreTarget.networkPublished = true; }],
    ['restore target uses a database host volume', (proof) => { proof.restoreTarget.hostVolumeForDatabase = true; }],
    ['restore target not ephemeral', (proof) => { proof.restoreTarget.ephemeralData = false; }],
    ['production overwritten', (proof) => { proof.restoreTarget.productionOverwritten = true; }],
    ['cleanup not verified', (proof) => { proof.restoreTarget.cleanupVerified = false; }],
    ['comparison membership false', (proof) => { proof.comparison.tableMembershipMatched = false; }],
    ['comparison database environment false', (proof) => { proof.comparison.databaseEnvironmentMatched = false; }],
    ['comparison schema false', (proof) => { proof.comparison.schemaMatched = false; }],
    ['comparison row counts false', (proof) => { proof.comparison.rowCountsMatched = false; }],
    ['comparison row fingerprints false', (proof) => { proof.comparison.rowFingerprintsMatched = false; }],
    ['comparison database fingerprint false', (proof) => { proof.comparison.databaseFingerprintMatched = false; }],
    ['comparison table count inconsistent', (proof) => { proof.comparison.tablesCompared = 2; }],
    ['comparison mismatch count nonzero', (proof) => { proof.comparison.mismatchCount = 1; }],
    ['sequence state claimed included', (proof) => { proof.sequenceStateIncluded = true; }],
    ['sequence definition not bound', (proof) => { proof.sequenceDefinitionAndOwnershipBound = false; }],
    ['public sequence count nonzero', (proof) => { proof.publicSequenceCount = 1; }],
    ['identity column count nonzero', (proof) => { proof.applicationIdentityColumnCount = 1; }],
    ['sequence default count nonzero', (proof) => { proof.applicationSequenceDefaultCount = 1; }],
    ['sequence exclusion reason changed', (proof) => { proof.sequenceStateExclusionReason = 'Sequence state excluded.'; }],
    ['ownership claimed included', (proof) => { proof.ownershipIncluded = true; }],
    ['ownership exclusion reason changed', (proof) => { proof.ownershipExclusionReason = 'Ownership excluded.'; }],
    ['ACL privileges claimed included', (proof) => { proof.aclPrivilegesIncluded = true; }],
    ['ACL exclusion reason changed', (proof) => { proof.aclPrivilegesExclusionReason = 'ACL excluded.'; }],
    ['top-level workload timeout changed', (proof) => { proof.workloadSafety.statementTimeoutMs = 1; }],
    ['top-level workload does not match source', (proof) => { proof.workloadSafety.tempFileLimitBytes = '536870912'; }],
    ['top-level maximum dump bound changed', (proof) => { proof.workloadSafety.maxDumpBytes = '1'; }],
    ['schema certification scope changed', (proof) => { proof.schemaCertificationScope.publicSchemaOnly = false; }],
    ['provenance limitation changed', (proof) => { proof.provenanceLimitation = 'complete proof'; }],
    ['secret values claimed printed', (proof) => { proof.secretValuesPrinted = true; }],
  ];

  try {
    for (const [index, [label, mutateReport]] of invalidCases.entries()) {
      const backupDir = join(tempDir, `invalid-report-${index}`);
      const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir]), {
        runPostgresBackupFromArgs: async (args) => {
          const evidence = writeProofArtifacts(args, { mutateReport });
          return {
            status: 0,
            stdout: `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${evidence.reportSha256}\nProof report file: production-check.restore-proof.json\n`,
            stderr: '',
          };
        },
      });
      assert.equal(outcome.status, 1, `${label} must fail closed`);
      assert.match(outcome.stderr, /proof evidence was missing, malformed, unstable, or inconsistent/, label);
      assert.doesNotMatch(outcome.stdout + outcome.stderr, /leaked|secret|db\.private|private|postgres(?:ql)?:\/\//, label);
      assert.equal(existsSync(backupDir), false, `${label} artifacts must be deleted`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker accepts capturedAt anywhere inside a long-running helper invocation window', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const backupDir = join(tempDir, 'long-running-proof');
  const startedAtMs = Date.now();
  const capturedAtMs = startedAtMs + 9 * 60 * 1000;
  const completedAtMs = startedAtMs + 10 * 60 * 1000;
  const clock = [startedAtMs, completedAtMs];
  try {
    const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir]), {
      now: () => clock.shift(),
      runPostgresBackupFromArgs: async (args) => {
        const evidence = writeProofArtifacts(args, {
          mutateReport: (proof) => { proof.capturedAt = new Date(capturedAtMs).toISOString(); },
        });
        return {
          status: 0,
          stdout: `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${evidence.reportSha256}\nProof report file: production-check.restore-proof.json\n`,
          stderr: '',
        };
      },
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(existsSync(backupDir), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker binds the helper transcript digest and expected report basename to stable report bytes', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    const cases = [
      {
        name: 'missing digest',
        stdout: () => `${RESTORE_PROOF_MARKER}\nProof report file: production-check.restore-proof.json\n`,
        expected: /required safe success marker|proof evidence was missing, malformed, unstable, or inconsistent/,
      },
      {
        name: 'wrong digest',
        stdout: () => `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${'f'.repeat(64)}\nProof report file: production-check.restore-proof.json\n`,
        expected: /required safe success marker|proof evidence was missing, malformed, unstable, or inconsistent/,
      },
      {
        name: 'duplicate digest',
        stdout: (sha) => `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${sha}\nProof report SHA-256: ${sha}\nProof report file: production-check.restore-proof.json\n`,
        expected: /required safe success marker|proof evidence was missing, malformed, unstable, or inconsistent/,
      },
      {
        name: 'wrong report basename',
        stdout: (sha) => `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${sha}\nProof report file: attacker.json\n`,
        expected: /did not identify the expected proof report/,
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const backupDir = join(tempDir, `transcript-binding-${index}`);
      const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir]), {
        runPostgresBackupFromArgs: async (args) => {
          const evidence = writeProofArtifacts(args);
          return { status: 0, stdout: entry.stdout(evidence.reportSha256), stderr: '' };
        },
      });
      assert.equal(outcome.status, 1, entry.name);
      assert.match(outcome.stderr, entry.expected, entry.name);
      assert.equal(existsSync(backupDir), false, entry.name);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker fails closed for absent, invalid UTF-8, invalid JSON, empty, or oversized proof artifacts', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const cases = [
    {
      name: 'missing report',
      write: (args) => {
        const outputDir = args.find((arg) => arg.startsWith('--output-dir=')).slice('--output-dir='.length);
        writeFileSync(join(outputDir, 'production-check.dump'), 'safe proof artifact');
        return Buffer.from('missing');
      },
    },
    {
      name: 'invalid UTF-8',
      write: (args) => {
        const outputDir = args.find((arg) => arg.startsWith('--output-dir=')).slice('--output-dir='.length);
        writeFileSync(join(outputDir, 'production-check.dump'), 'safe proof artifact');
        const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
        writeFileSync(join(outputDir, 'production-check.restore-proof.json'), bytes);
        return bytes;
      },
    },
    {
      name: 'invalid JSON',
      write: (args) => {
        const outputDir = args.find((arg) => arg.startsWith('--output-dir=')).slice('--output-dir='.length);
        writeFileSync(join(outputDir, 'production-check.dump'), 'safe proof artifact');
        const bytes = Buffer.from('{not-json}\n');
        writeFileSync(join(outputDir, 'production-check.restore-proof.json'), bytes);
        return bytes;
      },
    },
    {
      name: 'empty dump',
      write: (args) => {
        const outputDir = args.find((arg) => arg.startsWith('--output-dir=')).slice('--output-dir='.length);
        writeFileSync(join(outputDir, 'production-check.dump'), '');
        const bytes = Buffer.from('{}\n');
        writeFileSync(join(outputDir, 'production-check.restore-proof.json'), bytes);
        return bytes;
      },
    },
    {
      name: 'oversized report',
      write: (args) => {
        const outputDir = args.find((arg) => arg.startsWith('--output-dir=')).slice('--output-dir='.length);
        writeFileSync(join(outputDir, 'production-check.dump'), 'safe proof artifact');
        const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
        writeFileSync(join(outputDir, 'production-check.restore-proof.json'), bytes);
        return bytes;
      },
    },
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const backupDir = join(tempDir, `invalid-artifact-${index}`);
      const outcome = await run(proofArgs(envPath, ['--backup-output-dir', backupDir]), {
        runPostgresBackupFromArgs: async (args) => {
          const reportBytes = entry.write(args);
          return {
            status: 0,
            stdout: `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${sha256(reportBytes)}\nProof report file: production-check.restore-proof.json\n`,
            stderr: '',
          };
        },
      });
      assert.equal(outcome.status, 1, entry.name);
      assert.match(outcome.stderr, /proof evidence was missing, malformed, unstable, or inconsistent/, entry.name);
      assert.equal(existsSync(backupDir), false, entry.name);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker refuses pre-existing named proof artifacts without invoking or deleting them', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const outputDir = join(tempDir, 'pre-existing-artifacts');
  mkdirSync(outputDir, { mode: 0o700 });
  writeFileSync(join(outputDir, 'production-check.dump'), 'user-owned-dump');
  writeFileSync(join(outputDir, 'production-check.restore-proof.json'), 'user-owned-report');
  let called = false;
  try {
    const outcome = await run(proofArgs(envPath, ['--backup-output-dir', outputDir]), {
      runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(outcome.status, 1);
    assert.equal(called, false);
    assert.match(outcome.stderr, /artifact names already exist/);
    assert.equal(String(readFileSync(join(outputDir, 'production-check.dump'))), 'user-owned-dump');
    assert.equal(String(readFileSync(join(outputDir, 'production-check.restore-proof.json'))), 'user-owned-report');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker bounds and suppresses helper failures, exceptions, secrets, and paths', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    const failedOutputDir = join(tempDir, 'failed-helper');
    const failed = await run(proofArgs(envPath, ['--backup-output-dir', failedOutputDir]), {
      runPostgresBackupFromArgs: async () => ({
        status: 19,
        stdout: 'DATABASE_URL=postgresql://leaked:secret@db.private/path',
        stderr: 'C:\\sensitive\\restore-proof.json',
      }),
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /exit status 19/);
    assert.match(failed.stderr, /diagnostics were suppressed/);
    assert.doesNotMatch(failed.stderr + failed.stdout, /leaked|secret|db\.private|sensitive|postgres(?:ql)?:\/\//);
    assert.equal(existsSync(join(tempDir, 'failed-helper')), false);

    const thrownOutputDir = join(tempDir, 'thrown-helper');
    const thrown = await run(proofArgs(envPath, ['--backup-output-dir', thrownOutputDir]), {
      runPostgresBackupFromArgs: async () => {
        throw new Error('postgresql://leaked:secret@db.private C:\\sensitive\\dump');
      },
    });
    assert.equal(thrown.status, 1);
    assert.match(thrown.stderr, /helper threw an error/);
    assert.doesNotMatch(thrown.stderr + thrown.stdout, /leaked|secret|db\.private|sensitive|postgres(?:ql)?:\/\//);
    assert.equal(existsSync(join(tempDir, 'thrown-helper')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('capture-source-identity invokes the read-only helper once and emits provenance-limited text', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const calls = [];
  try {
    const outcome = await run(sourceIdentityArgs(envPath), {
      runPostgresBackupFromArgs: async (args, env) => {
        calls.push({ args, env });
        return {
          status: 0,
          stdout: sourceIdentityHelperStdout(),
          stderr: '',
        };
      },
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['source-identity', '--json']);
    assert.match(calls[0].env.DATABASE_URL, /^postgresql:\/\//);
    assert.equal(calls[0].env.CHARITYPILOT_POSTGRES_TOOLS_IMAGE, APPROVED_TOOLS_IMAGE_REFERENCE);
    assert.doesNotMatch(calls[0].args.join(' '), /postgres(?:ql)?:\/\/|backup-user|secret/);
    assert.match(outcome.stdout, new RegExp(CAPTURED_SOURCE_IDENTITY));
    assert.match(outcome.stdout, /does not prove restore recovery/);
    assert.match(outcome.stdout, /production was not written/);
    assert.match(outcome.stdout, /independent immutable capture/);
    assert.doesNotMatch(outcome.stdout, /backup-user|secret|postgres(?:ql)?:\/\//);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('capture-source-identity emits an allowlisted JSON payload that cannot be mistaken for restore proof', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    const outcome = await run(sourceIdentityArgs(envPath, ['--json']), {
      runPostgresBackupFromArgs: async () => ({
        status: 0,
        stdout: sourceIdentityHelperStdout(),
        stderr: '',
      }),
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), {
      format: 'charitypilot-postgres-source-identity/v2',
      ok: true,
      mode: 'capture-source-identity',
      checksumAlgorithm: 'sha256',
      expectedReleaseCommitSha: EXPECTED_RELEASE_COMMIT_SHA,
      helperImplementation: HELPER_IMPLEMENTATION,
      toolsImageReference: APPROVED_TOOLS_IMAGE_REFERENCE,
      toolsImageDigestSha256: APPROVED_TOOLS_IMAGE_DIGEST_SHA256,
      sourceDatabaseIdentitySha256: CAPTURED_SOURCE_IDENTITY,
      sourceReadOnlyVerified: true,
      sourceTlsServerAuthenticationVerified: true,
      restoreProofVerified: false,
      productionWritten: false,
      secretValuesPrinted: false,
      provenanceLimitation: SOURCE_IDENTITY_PROVENANCE,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('capture-source-identity is mutually exclusive with proof and artifact options', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const incompatible = [
    ['--recovery-set-id', RECOVERY_SET_ID],
    ['--expected-source-database-identity-sha256', SOURCE_IDENTITY],
    ['--backup-output-dir', join(tempDir, 'not-created')],
    ['--keep-backup'],
  ];
  try {
    for (const extra of incompatible) {
      let called = false;
      const outcome = await run(sourceIdentityArgs(envPath, extra), {
        runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
      });
      assert.equal(outcome.status, 2);
      assert.equal(called, false);
      assert.match(outcome.stderr, /cannot be combined/);
      assert.doesNotMatch(outcome.stderr, /not-created/);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('capture-source-identity requires an exact expected release commit before helper binding', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    for (const [args, expected] of [
      [['--production-env-file', envPath, '--capture-source-identity'], /--expected-release-commit-sha is required/],
      [[
        '--production-env-file', envPath,
        '--expected-release-commit-sha', 'A'.repeat(40),
        '--capture-source-identity',
      ], /lowercase 40-character git commit SHA/],
    ]) {
      let called = false;
      const outcome = await run(args, {
        captureHelperImplementationBinding: () => {
          called = true;
          return structuredClone(HELPER_IMPLEMENTATION);
        },
      });
      assert.equal(outcome.status, 2);
      assert.equal(called, false);
      assert.match(outcome.stderr, expected);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('capture-source-identity rejects missing, malformed, or ambiguous helper evidence and suppresses transcripts', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const invalidOutputs = [
    '',
    sourceIdentityHelperStdout({ format: 'charitypilot-postgres-source-identity/v1' }),
    sourceIdentityHelperStdout({ sourceDatabaseIdentitySha256: 'A'.repeat(64) }),
    `${JSON.stringify({ ok: true, sourceDatabaseIdentitySha256: CAPTURED_SOURCE_IDENTITY })}\n`,
    `${sourceIdentityHelperStdout()}${sourceIdentityHelperStdout({ sourceDatabaseIdentitySha256: SOURCE_IDENTITY })}`,
    sourceIdentityHelperStdout({ toolsImageReference: `attacker@sha256:${'f'.repeat(64)}` }),
    sourceIdentityHelperStdout({
      helperImplementation: { ...structuredClone(HELPER_IMPLEMENTATION), sourceMatchesCommit: false },
    }),
  ];
  try {
    for (const stdout of invalidOutputs) {
      const outcome = await run(sourceIdentityArgs(envPath), {
        runPostgresBackupFromArgs: async () => ({
          status: 0,
          stdout: `${stdout}postgresql://leaked:secret@db.private/path\n`,
          stderr: '',
        }),
      });
      assert.equal(outcome.status, 1);
      assert.match(outcome.stderr, /required allowlisted JSON identity evidence/);
      assert.doesNotMatch(outcome.stderr + outcome.stdout, /leaked|secret|db\.private|sensitive|postgres(?:ql)?:\/\//);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('capture-source-identity suppresses nonzero and thrown helper diagnostics', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    const failed = await run(sourceIdentityArgs(envPath), {
      runPostgresBackupFromArgs: async () => ({ status: 7, stdout: 'postgresql://leaked:secret@db.private', stderr: 'C:\\secret' }),
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /exit status 7/);
    assert.doesNotMatch(failed.stderr, /leaked|db\.private|postgres(?:ql)?:\/\//);

    const thrown = await run(sourceIdentityArgs(envPath), {
      runPostgresBackupFromArgs: async () => { throw new Error('postgresql://leaked:secret@db.private'); },
    });
    assert.equal(thrown.status, 1);
    assert.match(thrown.stderr, /helper threw an error/);
    assert.doesNotMatch(thrown.stderr, /leaked|db\.private|postgres(?:ql)?:\/\//);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker rejects unsafe production DATABASE_URL values before either helper mode', async () => {
  const run = await loadDatabaseRunner();
  const unsafe = [
    { url: '', message: /missing or still contains a placeholder/ },
    { url: 'postgresql://user:secret@localhost:5432/db', message: /must not point at localhost/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie:5432/db', message: /must require TLS/ },
    { url: 'postgresql://user:secret@db.charitypilot.example:5432/db?sslmode=verify-full', message: /reserved documentation hostname/ },
    { url: 'mysql://user:secret@db.charitypilot.ie/db?sslmode=verify-full', message: /must use a PostgreSQL/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?host=localhost&sslmode=verify-full', message: /unsupported or routing-sensitive connection option/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?hostaddr=127.0.0.1&sslmode=verify-full', message: /unsupported or routing-sensitive connection option/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?service=production&sslmode=verify-full', message: /unsupported or routing-sensitive connection option/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?dbname=other&sslmode=verify-full', message: /unsupported or routing-sensitive connection option/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?sslmode=verify-full#unsafe', message: /must not contain a URL fragment/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?sslmode=verify-full&sslmode=disable', message: /must not repeat or ambiguously case connection options/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?SSLMode=require', message: /must not repeat or ambiguously case connection options/ },
    { url: 'postgresql://user:secret@db.charitypilot.ie/db?sslmode=verify-full&postgresql%3A%2F%2Fleaked%3Apassword%40db.private=1', message: /unsupported or routing-sensitive connection option/ },
  ];
  for (const [index, entry] of unsafe.entries()) {
    const { tempDir, envPath } = writeEnvFile(productionEnv({ DATABASE_URL: entry.url }), `charitypilot-unsafe-${index}-`);
    try {
      let called = false;
      const outcome = await run(index % 2 === 0
        ? proofArgs(envPath)
        : sourceIdentityArgs(envPath), {
        runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
      });
      assert.equal(outcome.status, 1);
      assert.equal(called, false);
      assert.match(outcome.stderr, entry.message);
      assert.doesNotMatch(outcome.stderr, /user:secret|leaked|password|db\.private|postgres(?:ql)?:\/\/|charitypilot\.example/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('production checker upgrades a safe Prisma runtime DSN to strict proof-only TLS', async () => {
  const run = await loadDatabaseRunner();
  const databaseUrl = 'postgresql://user:secret@db.charitypilot.ie:5432/charitypilot?' + [
    'application_name=CharityPilot.proof%3A1',
    'connect_timeout=30',
    'sslmode=require',
    'sslcert=%2Frun%2Fsecrets%2Fclient.crt',
    'sslkey=%2Frun%2Fsecrets%2Fclient.key',
    'sslrootcert=%2Frun%2Fsecrets%2Fca.pem',
  ].join('&');
  const { tempDir, envPath } = writeEnvFile(productionEnv({ DATABASE_URL: databaseUrl }));
  let helperDatabaseUrl;
  try {
    const outcome = await run(sourceIdentityArgs(envPath), {
      runPostgresBackupFromArgs: async (_args, env) => {
        helperDatabaseUrl = env.DATABASE_URL;
        return { status: 0, stdout: sourceIdentityHelperStdout(), stderr: '' };
      },
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(
      helperDatabaseUrl,
      'postgresql://user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write',
    );
    assert.doesNotMatch(outcome.stdout + outcome.stderr, /client\.crt|client\.key|ca\.pem|postgres(?:ql)?:\/\//);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker redacts env paths and unknown argument values in usage failures', async () => {
  const run = await loadDatabaseRunner();
  const missingPath = join(tmpdir(), 'private-customer-secret', 'missing.env');
  const missing = await run(proofArgs(missingPath), {
    runPostgresBackupFromArgs: async () => assert.fail('helper must not run'),
  });
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr, /private-customer-secret|missing\.env/);

  const unknown = await run(['--unknown=C:\\private\\postgresql://user:secret@host/db'], {
    runPostgresBackupFromArgs: async () => assert.fail('helper must not run'),
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown argument/);
  assert.doesNotMatch(unknown.stderr, /private|user:secret|postgres(?:ql)?:\/\//);
});

test('production checker rejects empty value options as usage errors', async () => {
  const run = await loadDatabaseRunner();
  for (const flag of [
    '--production-env-file=',
    '--backup-output-dir=',
    '--recovery-set-id=',
    '--expected-source-database-identity-sha256=',
    '--expected-release-commit-sha=',
  ]) {
    let called = false;
    const outcome = await run([flag], {
      runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(outcome.status, 2);
    assert.equal(called, false);
    assert.match(outcome.stderr, /requires a value/);
  }
});

test('production checker rejects repeated options before invoking either helper mode', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const duplicateCases = [
    [...proofArgs(envPath), '--production-env-file', envPath],
    [...proofArgs(envPath), '--recovery-set-id', 'another-recovery-set'],
    [...proofArgs(envPath), '--expected-release-commit-sha', '2'.repeat(40)],
    [...proofArgs(envPath), '--expected-source-database-identity-sha256', 'e'.repeat(64)],
    [...proofArgs(envPath), '--json', '--json'],
    [...proofArgs(envPath), '--backup-output-dir', join(tempDir, 'one'), '--backup-output-dir', join(tempDir, 'two')],
    [...proofArgs(envPath), '--backup-output-dir', join(tempDir, 'kept'), '--keep-backup', '--keep-backup'],
    sourceIdentityArgs(envPath, ['--capture-source-identity']),
  ];
  try {
    for (const args of duplicateCases) {
      let called = false;
      const outcome = await run(args, {
        runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
      });
      assert.equal(outcome.status, 2);
      assert.equal(called, false);
      assert.match(outcome.stderr, /must not be repeated/);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker fails safely when the proof artifact directory cannot be prepared', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const blockingFile = join(tempDir, 'private-blocking-file');
  writeFileSync(blockingFile, 'not a directory');
  let called = false;
  try {
    const outcome = await run(proofArgs(envPath, [
      '--backup-output-dir', join(blockingFile, 'secret-output'),
    ]), {
      runPostgresBackupFromArgs: async () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(outcome.status, 1);
    assert.equal(called, false);
    assert.match(outcome.stderr, /artifact directory could not be prepared/);
    assert.doesNotMatch(outcome.stderr, /private-blocking-file|secret-output/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker requires an absolute proof directory outside repository and OS temporary roots', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const cases = [
    {
      name: 'relative path',
      args: proofArgs(envPath, ['--backup-output-dir', 'private-relative-output']),
      dependencies: {},
      status: 2,
      message: /absolute protected path/,
    },
    {
      name: 'repository path',
      args: proofArgs(envPath, ['--backup-output-dir', join(tempDir, 'private-repository-output')]),
      dependencies: { repoRoot: tempDir },
      status: 1,
      message: /proof artifact directory could not be prepared/,
    },
    {
      name: 'OS temporary path',
      args: proofArgs(envPath, ['--backup-output-dir', join(tempDir, 'private-temp-output')]),
      dependencies: { osTempRoots: [tempDir] },
      status: 1,
      message: /proof artifact directory could not be prepared/,
    },
    {
      name: 'ancestor of repository path',
      args: proofArgs(envPath, ['--backup-output-dir', tempDir]),
      dependencies: { repoRoot: join(tempDir, 'nested-private-repository') },
      status: 1,
      message: /proof artifact directory could not be prepared/,
    },
  ];
  try {
    for (const entry of cases) {
      let called = false;
      const outcome = await run(entry.args, {
        ...entry.dependencies,
        runPostgresBackupFromArgs: async () => {
          called = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(outcome.status, entry.status, entry.name);
      assert.equal(called, false, entry.name);
      assert.match(outcome.stderr, entry.message, entry.name);
      assert.doesNotMatch(outcome.stderr, /private-relative-output|private-repository-output|private-temp-output/, entry.name);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker rejects rather than chmods a pre-existing non-owner-only directory', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  const outputDir = join(tempDir, 'wide-private-output');
  mkdirSync(outputDir, { mode: 0o755 });
  chmodSync(outputDir, 0o755);
  const modeBefore = statSync(outputDir).mode & 0o777;
  let called = false;
  try {
    const outcome = await run(proofArgs(envPath, ['--backup-output-dir', outputDir]), {
      platform: 'linux',
      getuid: undefined,
      runPostgresBackupFromArgs: async () => {
        called = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(outcome.status, 1);
    assert.equal(called, false);
    assert.match(outcome.stderr, /proof artifact directory could not be prepared/);
    assert.equal(statSync(outputDir).mode & 0o777, modeBefore);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production checker reads only stable, bounded, unambiguous UTF-8 production env files', async () => {
  const run = await loadDatabaseRunner();
  const safeHelper = async () => ({
    status: 0,
    stdout: sourceIdentityHelperStdout(),
    stderr: '',
  });
  const exactBound = writeEnvFile();
  const baseBytes = Buffer.from(productionEnv(), 'utf8');
  writeFileSync(exactBound.envPath, Buffer.concat([
    baseBytes,
    Buffer.alloc(1024 * 1024 - baseBytes.length, 0x20),
  ]));
  try {
    const accepted = await run(sourceIdentityArgs(exactBound.envPath), {
      runPostgresBackupFromArgs: safeHelper,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(exactBound.tempDir, { recursive: true, force: true });
  }

  const invalidCases = [
    {
      name: 'oversized',
      content: Buffer.alloc(1024 * 1024 + 1, 0x20),
    },
    {
      name: 'invalid UTF-8',
      content: Buffer.concat([Buffer.from(productionEnv(), 'utf8'), Buffer.from([0xff])]),
    },
    {
      name: 'duplicate key',
      content: Buffer.from(`${productionEnv()}DATABASE_URL=postgresql://second:secret@db.private:5432/db?sslmode=verify-full\n`),
    },
  ];
  for (const entry of invalidCases) {
    const { tempDir: caseDir, envPath: casePath } = writeEnvFile();
    writeFileSync(casePath, entry.content);
    let called = false;
    try {
      const outcome = await run(sourceIdentityArgs(casePath), {
        runPostgresBackupFromArgs: async () => {
          called = true;
          return safeHelper();
        },
      });
      assert.equal(outcome.status, 1, entry.name);
      assert.equal(called, false, entry.name);
      assert.equal(outcome.stderr, 'Production database check failed: the production env file could not be read.\n', entry.name);
      assert.doesNotMatch(outcome.stderr + outcome.stdout, /second|secret|db\.private|postgres(?:ql)?:\/\//, entry.name);
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  }
});

test('production checker rejects nonempty helper stderr on otherwise successful proof and identity captures', async () => {
  const run = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile();
  try {
    const proofDir = join(tempDir, 'proof-stderr');
    const proofOutcome = await run(proofArgs(envPath, ['--backup-output-dir', proofDir]), {
      runPostgresBackupFromArgs: async (args) => {
        const evidence = writeProofArtifacts(args);
        return {
          status: 0,
          stdout: `${RESTORE_PROOF_MARKER}\nProof report SHA-256: ${evidence.reportSha256}\nProof report file: production-check.restore-proof.json\n`,
          stderr: 'postgresql://leaked:secret@db.private C:\\private\\proof.log',
        };
      },
    });
    assert.equal(proofOutcome.status, 1);
    assert.match(proofOutcome.stderr, /unsafe success transcript/);
    assert.doesNotMatch(proofOutcome.stderr, /leaked|secret|db\.private|postgres(?:ql)?:\/\//);
    assert.equal(existsSync(proofDir), false);

    const identityOutcome = await run(sourceIdentityArgs(envPath), {
      runPostgresBackupFromArgs: async () => ({
        status: 0,
        stdout: sourceIdentityHelperStdout(),
        stderr: 'postgresql://leaked:secret@db.private C:\\private\\identity.log',
      }),
    });
    assert.equal(identityOutcome.status, 1);
    assert.match(identityOutcome.stderr, /unsafe success transcript/);
    assert.doesNotMatch(identityOutcome.stderr, /leaked|secret|db\.private|postgres(?:ql)?:\/\//);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
