import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildRestoreProofReport,
  calculateCapacityRequirement,
  captureHelperImplementationBinding,
  compareDatabaseFingerprints,
  createSourceDumpBindingSha256,
  linuxDockerHostUserArgs,
  openProtectedRegularFile,
  assertProtectedFileUnchanged,
  parseDatabaseFingerprintReport,
  preflightOutputFilesystemCapacity,
  redactPostgresTranscript,
  runPostgresBackupFromArgs,
  nextDumpByteCount,
  shouldScavengeProofContainer,
} from './postgres-backup.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

test('certified schema fingerprints bind recovery-relevant relation, inheritance, index, column, and routine state', () => {
  const source = readFileSync(join(scriptsDir, 'postgres-backup.mjs'), 'utf8');
  for (const field of [
    'pg_catalog.pg_inherits',
    'reloptions',
    'relreplident',
    'relam',
    'reltablespace',
    'relispopulated',
    'attstorage',
    'attcompression',
    'attstattarget',
    'attoptions',
    'attfdwoptions',
    'indisclustered',
    'indisreplident',
    'procost',
    'prorows',
    'prosupport',
    'pg_get_functiondef',
    'datcollate',
    'datctype',
    'datlocprovider',
    'datcollversion',
    'createdb',
    '--locale-provider',
  ]) {
    assert.match(source, new RegExp(field.replaceAll('.', '\\.')));
  }
  assert.ok((source.match(/pg_catalog\.pg_inherits/g) ?? []).length >= 2);
  assert.ok((source.match(/indisclustered/g) ?? []).length >= 2);
  assert.ok((source.match(/indisreplident/g) ?? []).length >= 2);
});

test('helper implementation binding hashes stable source bytes and binds canonical repository commit metadata', () => {
  const sourcePath = join(scriptsDir, 'postgres-backup.mjs');
  const binding = captureHelperImplementationBinding();
  assert.deepEqual(Object.keys(binding), [
    'format', 'repositoryUrl', 'commitSha', 'sourcePath', 'sourceSha256',
    'commitSourceSha256', 'sourceMatchesCommit', 'canonicalRepositoryMatched',
  ]);
  assert.equal(binding.format, 'charitypilot-postgres-proof-helper/v1');
  assert.equal(binding.repositoryUrl, 'https://github.com/jasperfordesq-ai/charity-governance');
  assert.equal(binding.sourcePath, 'scripts/postgres-backup.mjs');
  assert.equal(
    binding.sourceSha256,
    createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
  );
  assert.equal(binding.sourceMatchesCommit, binding.commitSourceSha256 === binding.sourceSha256);
  assert.equal(binding.canonicalRepositoryMatched, true);
  assert.match(binding.commitSha ?? '', /^[a-f0-9]{40}$/);
});

test('remote URL backup containers write as the native Linux deploy owner', () => {
  assert.deepEqual(
    linuxDockerHostUserArgs({ platform: 'linux', getuid: () => 1001, getgid: () => 1002 }),
    ['--user', '1001:1002'],
  );
  assert.deepEqual(
    linuxDockerHostUserArgs({ platform: 'win32', getuid: undefined, getgid: undefined }),
    [],
  );
  assert.throws(
    () => linuxDockerHostUserArgs({ platform: 'linux', getuid: () => -1, getgid: () => 1002 }),
    /Could not determine the Linux deploy owner uid:gid/,
  );
});

function cleanEnv() {
  const env = {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

function runBackupCli(args, env = {}) {
  return runPostgresBackupFromArgs(args, { ...cleanEnv(), ...env });
}

const digest = (character) => character.repeat(64);
const identifierHex = (value) => Buffer.from(value, 'utf8').toString('hex');

function rawFingerprintReport({
  identitySha256 = digest('1'),
  snapshotSha256 = digest('2'),
  publicSchemaSha256 = digest('3'),
  documentRowsSha256 = digest('4'),
  documentRowCount = '2',
  readableFlag = '1',
  tempFileLimitBytes = '1073741824',
  publicSequenceCount = '0',
  identityColumnCount = '0',
  sequenceDefaultCount = '0',
  unsupportedObjectCount = '0',
  largeObjectCount = '0',
  databaseEncoding = 'UTF8',
  databaseCollation = 'en_US.utf8',
  databaseCtype = 'en_US.utf8',
  databaseLocaleProvider = 'c',
  databaseCollationVersion = '',
  maxPublicTables = '5000',
  maxRowsPerTable = '25000000',
  maxTotalRows = '100000000',
  sourceDatabaseSizeBytes,
  capacityRequiredBytes,
  capacityPreflightVerified = '1',
  extraLines = [],
} = {}) {
  return [
    `meta|source_snapshot_sha256|${snapshotSha256}`,
    `meta|database_identity_sha256|${identitySha256}`,
    `meta|database_encoding_hex|${identifierHex(databaseEncoding)}`,
    `meta|database_collation_hex|${identifierHex(databaseCollation)}`,
    `meta|database_ctype_hex|${identifierHex(databaseCtype)}`,
    `meta|database_locale_provider|${databaseLocaleProvider}`,
    `meta|database_collation_version_hex|${identifierHex(databaseCollationVersion)}`,
    `meta|public_schema_sha256|${publicSchemaSha256}`,
    'meta|settings_verified|1',
    'meta|access_share_locks_verified|1',
    `meta|temp_file_limit_bytes|${tempFileLimitBytes}`,
    `meta|max_public_tables|${maxPublicTables}`,
    `meta|max_rows_per_table|${maxRowsPerTable}`,
    `meta|max_total_rows|${maxTotalRows}`,
    'meta|public_object_count|12',
    `meta|public_sequence_count|${publicSequenceCount}`,
    `meta|application_identity_column_count|${identityColumnCount}`,
    `meta|application_sequence_default_count|${sequenceDefaultCount}`,
    `meta|unsupported_public_object_count|${unsupportedObjectCount}`,
    `meta|large_object_count|${largeObjectCount}`,
    ...(sourceDatabaseSizeBytes === undefined ? [] : [
      `meta|source_database_size_bytes|${sourceDatabaseSizeBytes}`,
    ]),
    ...(capacityRequiredBytes === undefined ? [] : [
      `meta|capacity_required_bytes|${capacityRequiredBytes}`,
    ]),
    ...(sourceDatabaseSizeBytes === undefined && capacityRequiredBytes === undefined ? [] : [
      `meta|capacity_preflight_verified|${capacityPreflightVerified}`,
    ]),
    `table|${identifierHex('public')}|${identifierHex('Document')}|r|0|${readableFlag}|${documentRowCount}|${digest('5')}|${documentRowsSha256}`,
    `table|${identifierHex('public')}|${identifierHex('Organisation')}|r|0|1|1|${digest('6')}|${digest('7')}`,
    ...extraLines,
    '',
  ].join('\n');
}

test('postgres backup transcript redaction removes database credentials from evidence output', () => {
  const transcript = [
    'pg_restore failed for postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    'DATABASE_URL=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot',
    '--database-url=postgres://backup-user:secret@db.charitypilot.ie:5432/charitypilot',
    'connection string backup-user:secret@db.charitypilot.ie was rejected',
  ].join('\n');

  const redacted = redactPostgresTranscript(transcript);

  assert.match(redacted, /\[redacted-database-url\]/);
  assert.match(redacted, /DATABASE_URL=\[redacted\]/);
  assert.match(redacted, /--database-url=\[redacted\]/);
  assert.match(redacted, /\[redacted-credentials\]@db\.charitypilot\.ie/);
  assert.doesNotMatch(redacted, /backup-user:secret/);
  assert.doesNotMatch(redacted, /postgresql:\/\/backup-user/);
});

test('database fingerprint parser binds every public table, schema membership, counts, and row fingerprints', () => {
  const report = parseDatabaseFingerprintReport(rawFingerprintReport());

  assert.equal(report.tableCount, 2);
  assert.equal(report.totalRows, '3');
  assert.equal(report.databaseIdentitySha256, digest('1'));
  assert.equal(report.snapshotSha256, digest('2'));
  assert.equal(report.publicSchemaSha256, digest('3'));
  assert.deepEqual(report.databaseEnvironment, {
    encoding: 'UTF8',
    collation: 'en_US.utf8',
    ctype: 'en_US.utf8',
    localeProvider: 'libc',
    collationVersion: null,
  });
  assert.match(report.tableMembershipSha256, /^[a-f0-9]{64}$/);
  assert.match(report.databaseFingerprintSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.tables.map((table) => `${table.schema}.${table.table}`), [
    'public.Document',
    'public.Organisation',
  ]);
  assert.equal(report.tables[0].rowCount, '2');
  assert.equal(report.tables[0].rowsSha256, digest('4'));
  assert.match(report.tables[0].tableFingerprintSha256, /^[a-f0-9]{64}$/);
});

test('database fingerprint parser fails closed on empty, unreadable, duplicate, and malformed reports', () => {
  assert.throws(
    () => parseDatabaseFingerprintReport([
      `meta|source_snapshot_sha256|${digest('2')}`,
      `meta|database_identity_sha256|${digest('1')}`,
      `meta|public_schema_sha256|${digest('3')}`,
      'meta|settings_verified|1',
      'meta|access_share_locks_verified|1',
    ].join('\n')),
    /did not contain any public application tables/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ readableFlag: '0' })),
    /was not fully readable/,
  );
  const duplicateLine = `table|${identifierHex('public')}|${identifierHex('Document')}|r|0|1|2|${digest('5')}|${digest('4')}`;
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ extraLines: [duplicateLine] })),
    /repeats a public table/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(`${rawFingerprintReport()}unsupported|record\n`),
    /unsupported or malformed record/,
  );
});

test('database fingerprint parser enforces workload, sequence-state, and unsupported-object bounds', () => {
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ tempFileLimitBytes: '0' })),
    /out-of-range temp_file_limit_bytes/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ publicSequenceCount: '1' })),
    /sequence values are non-MVCC/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ identityColumnCount: '1' })),
    /sequence values are non-MVCC/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ sequenceDefaultCount: '1' })),
    /sequence values are non-MVCC/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ unsupportedObjectCount: '1' })),
    /unsupported objects/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ largeObjectCount: '1' })),
    /large objects are excluded/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ databaseLocaleProvider: 'i' })),
    /locale provider is unsupported/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ databaseCollation: 'unsafe locale' })),
    /not a supported libc locale name/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({ maxTotalRows: '2' })),
    /aggregate row bound/,
  );
  const capacityBound = parseDatabaseFingerprintReport(rawFingerprintReport({
    sourceDatabaseSizeBytes: '1048576',
    capacityRequiredBytes: '1075838976',
  }));
  assert.equal(capacityBound.capacityPreflight.requiredAvailableBytes, '1075838976');
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({
      sourceDatabaseSizeBytes: '1048576',
      capacityRequiredBytes: undefined,
    })),
    /incomplete source capacity preflight evidence/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({
      sourceDatabaseSizeBytes: '01',
      capacityRequiredBytes: '1073741826',
    })),
    /canonical nonnegative decimal/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({
      sourceDatabaseSizeBytes: '1048576',
      capacityRequiredBytes: '1075838977',
    })),
    /does not match the locked factor-and-margin formula/,
  );
  assert.throws(
    () => parseDatabaseFingerprintReport(rawFingerprintReport({
      sourceDatabaseSizeBytes: '1048576',
      capacityRequiredBytes: '1075838976',
      capacityPreflightVerified: '0',
    })),
    /did not verify its source capacity preflight/,
  );
});

test('canonical policy descriptors preserve PUBLIC roles and fail closed on unknown role OIDs', () => {
  const implementation = readFileSync(join(scriptsDir, 'postgres-backup.mjs'), 'utf8');
  assert.equal((implementation.match(/role_ids\.oid = 0 THEN 'PUBLIC'/g) ?? []).length, 4);
  assert.equal((implementation.match(/LEFT JOIN pg_catalog\.pg_roles roles ON roles\.oid = role_ids\.oid/g) ?? []).length, 3);
  assert.match(implementation, /role_ids\.oid <> 0 AND roles\.oid IS NULL/);
  assert.match(implementation, /<UNKNOWN-ROLE-OID>/);
  assert.match(implementation, /pg_catalog\.pg_statistic_ext/);
  assert.match(implementation, /pg_catalog\.pg_get_statisticsobjdef/);
  assert.match(implementation, /pg_catalog\.pg_rewrite/);
  assert.match(implementation, /pg_catalog\.pg_get_ruledef/);
});

test('abnormal proof residue cleanup preserves bounded-age runs and reaps stale running or stopped crash residue', () => {
  const nowMs = 10_000_000;
  assert.equal(shouldScavengeProofContainer({ createdAtMs: nowMs - 3_600_001, running: false, nowMs }), true);
  assert.equal(shouldScavengeProofContainer({ createdAtMs: nowMs - 3_600_000, running: false, nowMs }), false);
  assert.equal(shouldScavengeProofContainer({ createdAtMs: 0, running: true, nowMs }), true);
  assert.equal(shouldScavengeProofContainer({ createdAtMs: nowMs - 3_600_000, running: true, nowMs }), false);
  assert.equal(shouldScavengeProofContainer({ createdAtMs: nowMs + 1, running: false, nowMs }), false);
  assert.throws(
    () => shouldScavengeProofContainer({ createdAtMs: Number.NaN, running: false, nowMs }),
    /timestamps failed strict validation/,
  );
});

test('legacy backup and restore paths retain owner-only artifacts and bounded subprocess cleanup', () => {
  const implementation = readFileSync(join(scriptsDir, 'postgres-backup.mjs'), 'utf8');
  assert.match(implementation, /createWriteStream\(tempPath, \{ flags: 'wx', mode: 0o600 \}\)/);
  assert.match(implementation, /mkdirSync\(outputDir, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(implementation, /umask 077;[\s\S]*pg_dump/);
  assert.match(implementation, /docker', \['rm', '-f', '-v', containerName\]/);
  assert.match(implementation, /child\.kill\('SIGKILL'\)/);
  assert.match(implementation, /DEFAULT_COMMAND_TIMEOUT_MS/);
  assert.match(implementation, /const MAX_DUMP_BYTES = 64 \* 1024 \* 1024 \* 1024/);
  assert.match(implementation, /statfs\(outputDir, \{ bigint: true \}\)/);
  assert.match(implementation, /ulimit -f/);
  assert.match(implementation, /PostgreSQL dump stream exceeds maxDumpBytes/);
});

test('dump bounds fail before capacity exhaustion and at the streaming byte boundary', () => {
  const maxDumpBytes = 64 * 1024 * 1024 * 1024;
  assert.equal(nextDumpByteCount(maxDumpBytes - 1, 1), maxDumpBytes);
  assert.throws(() => nextDumpByteCount(maxDumpBytes, 1), /exceeds maxDumpBytes/);
  assert.throws(() => nextDumpByteCount(-1, 1), /counters failed strict validation/);
  assert.equal(calculateCapacityRequirement('0'), '1073741824');
  assert.equal(calculateCapacityRequirement('1048576'), '1075838976');
  assert.equal(calculateCapacityRequirement('33822867456'), '68719476736');
  assert.equal(calculateCapacityRequirement('33822867457'), '68719476736');
  assert.throws(() => calculateCapacityRequirement('01'), /canonical nonnegative decimal/);

  const exactCapacity = preflightOutputFilesystemCapacity('/proof', maxDumpBytes, {
    statfs: () => ({ bavail: 64n, bsize: 1024n * 1024n * 1024n }),
  });
  assert.equal(exactCapacity, BigInt(maxDumpBytes));
  assert.throws(
    () => preflightOutputFilesystemCapacity('/proof', maxDumpBytes, {
      statfs: () => ({ bavail: 63n, bsize: 1024n * 1024n * 1024n }),
    }),
    /at least 68719476736 are required by maxDumpBytes/,
  );
  assert.equal(
    preflightOutputFilesystemCapacity('/proof', maxDumpBytes, {
      statfs: () => { const error = new Error('unsupported'); error.code = 'ENOSYS'; throw error; },
    }),
    undefined,
  );
});

test('held O_NOFOLLOW proof descriptors detect path substitution and content mutation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-proof-descriptor-'));
  chmodSync(directory, 0o700);
  const artifact = join(directory, 'artifact.dump');
  const retained = join(directory, 'retained.dump');
  writeFileSync(artifact, 'original', { mode: 0o600 });
  const handle = openProtectedRegularFile(artifact, 'test proof artifact');
  try {
    assert.doesNotThrow(() => assertProtectedFileUnchanged(handle, 'during baseline'));
    renameSync(artifact, retained);
    writeFileSync(artifact, 'replacement', { mode: 0o600 });
    assert.throws(
      () => assertProtectedFileUnchanged(handle, 'during substitution test'),
      /changed or was substituted/,
    );
  } finally {
    closeSync(handle.fd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('held proof descriptors reject symbolic-link artifacts', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-proof-symlink-'));
  const target = join(directory, 'target.dump');
  const link = join(directory, 'linked.dump');
  writeFileSync(target, 'target', { mode: 0o600 });
  try {
    try {
      symlinkSync(target, link, 'file');
    } catch (error) {
      if (error?.code === 'EPERM') {
        context.skip('Windows symbolic-link privilege is unavailable');
        return;
      }
      throw error;
    }
    assert.throws(() => openProtectedRegularFile(link, 'linked proof artifact'), /symbolic-link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database fingerprint comparison fails on restored count, schema, row, and membership mismatches', () => {
  const source = parseDatabaseFingerprintReport(rawFingerprintReport());
  const matchingRestore = parseDatabaseFingerprintReport(rawFingerprintReport({
    identitySha256: digest('8'),
    snapshotSha256: digest('9'),
  }));
  const comparison = compareDatabaseFingerprints(source, matchingRestore);
  assert.deepEqual(comparison, {
    databaseEnvironmentMatched: true,
    tableMembershipMatched: true,
    schemaMatched: true,
    rowCountsMatched: true,
    rowFingerprintsMatched: true,
    databaseFingerprintMatched: true,
    tablesCompared: 2,
    mismatchCount: 0,
  });

  const countMismatch = parseDatabaseFingerprintReport(rawFingerprintReport({
    identitySha256: digest('8'),
    documentRowCount: '3',
  }));
  assert.throws(() => compareDatabaseFingerprints(source, countMismatch), /row count public\.Document/);

  const rowMismatch = parseDatabaseFingerprintReport(rawFingerprintReport({
    identitySha256: digest('8'),
    documentRowsSha256: digest('a'),
  }));
  assert.throws(() => compareDatabaseFingerprints(source, rowMismatch), /rows public\.Document/);

  const schemaMismatch = parseDatabaseFingerprintReport(rawFingerprintReport({
    identitySha256: digest('8'),
    publicSchemaSha256: digest('b'),
  }));
  assert.throws(() => compareDatabaseFingerprints(source, schemaMismatch), /public schema/);

  const collationMismatch = parseDatabaseFingerprintReport(rawFingerprintReport({
    identitySha256: digest('8'),
    databaseCollation: 'C',
    databaseCtype: 'C',
  }));
  assert.throws(
    () => compareDatabaseFingerprints(source, collationMismatch),
    /database encoding\/collation environment/,
  );
});

test('dump binding and proof report are sensitive to dump identity and expose only safe evidence', () => {
  const source = parseDatabaseFingerprintReport(rawFingerprintReport({
    sourceDatabaseSizeBytes: '1048576',
    capacityRequiredBytes: '1075838976',
  }));
  const restored = parseDatabaseFingerprintReport(rawFingerprintReport({
    identitySha256: digest('8'),
    snapshotSha256: digest('9'),
  }));
  const comparison = compareDatabaseFingerprints(source, restored);
  const helperImplementation = {
    format: 'charitypilot-postgres-proof-helper/v1',
    repositoryUrl: 'https://github.com/jasperfordesq-ai/charity-governance',
    commitSha: '1'.repeat(40),
    sourcePath: 'scripts/postgres-backup.mjs',
    sourceSha256: digest('6'),
    commitSourceSha256: digest('6'),
    sourceMatchesCommit: true,
    canonicalRepositoryMatched: true,
  };
  const bindingInput = {
    recoverySetId: 'CP-2026-07-11-001',
    sourceDatabaseIdentitySha256: digest('1'),
    helperImplementationSourceSha256: helperImplementation.sourceSha256,
    helperImplementationCommitSha: helperImplementation.commitSha,
    dumpSha256: digest('c'),
    dumpBytes: '4096',
    dumpDescriptorSha256: digest('d'),
    sourceDatabaseFingerprintSha256: source.databaseFingerprintSha256,
    sourceFingerprintReportSha256: digest('e'),
  };
  const binding = createSourceDumpBindingSha256(bindingInput);
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.notEqual(binding, createSourceDumpBindingSha256({ ...bindingInput, dumpSha256: digest('f') }));
  assert.notEqual(binding, createSourceDumpBindingSha256({ ...bindingInput, recoverySetId: 'CP-2026-07-11-002' }));
  assert.notEqual(binding, createSourceDumpBindingSha256({ ...bindingInput, helperImplementationSourceSha256: digest('7') }));
  assert.notEqual(binding, createSourceDumpBindingSha256({ ...bindingInput, helperImplementationCommitSha: '2'.repeat(40) }));

  const report = buildRestoreProofReport({
    recoverySetId: bindingInput.recoverySetId,
    capturedAt: '2026-07-11T12:00:00.000Z',
    expectedSourceDatabaseIdentitySha256: digest('1'),
    outputFile: 'production-2026-07-11.dump',
    dumpSha256Before: digest('c'),
    dumpBytesBefore: 4096,
    dumpDescriptorBefore: { sha256: digest('d'), entryCount: 42 },
    dumpSha256After: digest('c'),
    dumpBytesAfter: 4096,
    dumpDescriptorAfter: { sha256: digest('d'), entryCount: 42 },
    source,
    restored,
    comparison,
    helperImplementation,
  });
  assert.equal(report.format, 'charitypilot-postgres-restore-proof/v2');
  assert.equal(report.checksumAlgorithm, 'sha256');
  assert.deepEqual(report.helperImplementation, helperImplementation);
  assert.equal(
    report.toolsImageReference,
    'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c',
  );
  assert.equal(
    report.toolsImageDigestSha256,
    '5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c',
  );
  assert.equal(report.recoverySetId, bindingInput.recoverySetId);
  assert.equal(report.dump.sha256, report.dump.rehashAfterRestoreSha256);
  assert.equal(report.dump.sourceBindingSha256, createSourceDumpBindingSha256({
    ...bindingInput,
    sourceFingerprintReportSha256: report.source.fingerprintReportSha256,
  }));
  assert.equal(report.dump.descriptorSha256, report.dump.descriptorAfterRestoreSha256);
  assert.equal(report.dump.unchangedDuringProof, true);
  assert.deepEqual(report.source.databaseEnvironment, source.databaseEnvironment);
  assert.deepEqual(report.restored.databaseEnvironment, restored.databaseEnvironment);
  assert.deepEqual(report.dump.capacityPreflight, {
    method: 'pg-database-size-factor-margin/v1',
    sourceDatabaseSizeBytes: '1048576',
    safetyFactor: 2,
    safetyMarginBytes: '1073741824',
    requiredAvailableBytes: '1075838976',
    maximumDumpBytes: '68719476736',
    verified: true,
  });
  assert.equal(report.restoreTarget.identitySha256, report.restored.databaseIdentitySha256);
  assert.deepEqual(report.restoreTarget.databaseEnvironment, source.databaseEnvironment);
  assert.equal(report.restoreTarget.initializedFromSourceDatabaseEnvironment, true);
  assert.equal(report.restoreTarget.databaseEnvironmentPreserved, true);
  assert.equal(report.restoreTarget.networkPublished, false);
  assert.equal(report.restoreTarget.productionOverwritten, false);
  assert.equal(report.comparison.mismatchCount, 0);
  assert.equal(report.sequenceStateIncluded, false);
  assert.equal(report.sequenceDefinitionAndOwnershipBound, true);
  assert.equal(report.sourceIdentityBindingMatched, true);
  assert.equal(report.publicSequenceCount, 0);
  assert.equal(report.applicationIdentityColumnCount, 0);
  assert.equal(report.applicationSequenceDefaultCount, 0);
  assert.equal(
    report.sequenceStateExclusionReason,
    'PostgreSQL sequence values are non-MVCC and cannot be bound to the exported snapshot; this proof therefore fails unless the public schema has zero sequences, identity columns, and nextval defaults.',
  );
  assert.equal(report.ownershipIncluded, false);
  assert.equal(report.aclPrivilegesIncluded, false);
  assert.match(report.ownershipExclusionReason, /--no-owner/);
  assert.match(report.aclPrivilegesExclusionReason, /--no-privileges/);
  assert.deepEqual(report.workloadSafety, {
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
  assert.deepEqual(report.schemaCertificationScope, {
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
  assert.equal(report.secretValuesPrinted, false);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /db\.charitypilot\.ie|backup-user|secret-value|postgres(?:ql)?:\/\//i);
});

test('postgres backup CLI fails safely without a database URL or local database container', async () => {
  const result = await runBackupCli(['backup', '--dry-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL or --database-container is required/);
});

test('postgres backup CLI rejects usage errors distinctly from backup failures', async () => {
  const unknownCommand = await runBackupCli(['--surprise']);
  assert.equal(unknownCommand.status, 2);
  assert.match(unknownCommand.stderr, /Unknown command: --surprise/);
  assert.match(unknownCommand.stderr, /Usage:/);

  const missingValue = await runBackupCli(['backup', '--output-dir']);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /Missing value for --output-dir/);
});

test('postgres backup CLI rejects duplicate, empty, unknown, boolean-value, and cross-command options', async () => {
  const cases = [
    [['backup', '--output-dir=a', '--output-dir=b', '--dry-run'], /Duplicate option --output-dir/],
    [['backup', '--output-dir=', '--dry-run'], /Empty value for --output-dir/],
    [['backup', '--surprise=value', '--dry-run'], /Unknown option --surprise for backup/],
    [['backup', '--dry-run=true'], /--dry-run does not accept a value/],
    [['source-identity', '--dump-file=x', '--dry-run'], /Unknown option --dump-file for source-identity/],
    [['verify-restore', '--database-url=postgresql:\/\/u:p@localhost\/db', '--dry-run'], /Unknown option --database-url for verify-restore/],
  ];
  for (const [args, expected] of cases) {
    const result = await runBackupCli(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, expected);
  }
});

test('postgres backup CLI renders a local Docker database dump command without writing a dump in dry-run mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-backup-dry-run-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-container=charitypilot-db',
      `--output-dir=${tempDir}`,
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker exec charitypilot-db pg_dump/);
    assert.match(result.stdout, /--format=custom/);
    assert.deepEqual(readdirSync(tempDir), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI does not leave a final dump file when local Docker backup fails', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-failed-backup-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-container=charitypilot-missing-db',
      `--output-dir=${tempDir}`,
      '--output-file=failed.dump',
    ]);

    assert.equal(result.status, 1);
    assert.equal(existsSync(join(tempDir, 'failed.dump')), false);
    assert.deepEqual(readdirSync(tempDir), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI preserves PATH when invoked with the live process environment', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-live-env-backup-'));

  try {
    const originalPath = process.env.PATH;
    const result = await runPostgresBackupFromArgs([
      'backup',
      '--database-container=charitypilot-missing-db',
      `--output-dir=${tempDir}`,
      '--output-file=missing.dump',
    ], process.env);

    assert.equal(result.status, 1);
    assert.equal(process.env.PATH, originalPath);
    assert.doesNotMatch(result.stderr, /Docker is not available/);
    assert.equal(existsSync(join(tempDir, 'missing.dump')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI preserves an existing dump when overwrite backup fails', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-overwrite-backup-'));
  const dumpPath = join(tempDir, 'existing.dump');
  writeFileSync(dumpPath, 'existing dump');

  try {
    const result = await runBackupCli([
      'backup',
      '--database-container=charitypilot-missing-db',
      `--output-dir=${tempDir}`,
      '--output-file=existing.dump',
      '--overwrite',
    ]);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Backup file already exists|EEXIST/);
    assert.equal(readFileSync(dumpPath, 'utf8'), 'existing dump');
    assert.deepEqual(readdirSync(tempDir), ['existing.dump']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI renders a database URL dump command without exposing the URL in dry-run mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-url-backup-dry-run-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
      `--output-dir=${tempDir}`,
      '--output-file=remote.dump',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker run --rm/);
    assert.match(result.stdout, /CHARITYPILOT_BACKUP_DATABASE_URL/);
    assert.match(result.stdout, /pg_dump --dbname/);
    assert.match(result.stdout, /postgres@sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(result.stdout, /postgres:16\.4-alpine/);
    assert.doesNotMatch(result.stdout, /backup-user:secret/);
    assert.equal(existsSync(join(tempDir, 'remote.dump')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI accepts only the exact repository-approved Postgres tools image', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-url-backup-mutable-tools-image-'));

  try {
    for (const image of [
      'postgres:16.4-alpine',
      `postgres@sha256:${'a'.repeat(64)}`,
      `attacker.example/postgres@sha256:${'5'.repeat(64)}`,
    ]) {
      const result = await runBackupCli([
        'backup',
        '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
        `--output-dir=${tempDir}`,
        '--output-file=remote.dump',
        '--dry-run',
      ], { CHARITYPILOT_POSTGRES_TOOLS_IMAGE: image });

      assert.equal(result.status, 1, image);
      assert.match(result.stderr, /must exactly match the repository-approved tools image/);
      assert.doesNotMatch(result.stdout, /pg_dump --dbname/);
    }
    const approved = await runBackupCli([
      'backup',
      '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
      `--output-dir=${tempDir}`,
      '--output-file=remote.dump',
      '--dry-run',
    ], {
      CHARITYPILOT_POSTGRES_TOOLS_IMAGE:
        'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c',
    });
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(existsSync(join(tempDir, 'remote.dump')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI supports host networking for database URL dumps in CI', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-url-backup-network-dry-run-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-url=postgresql://backup-user:secret@localhost:5432/charitypilot_ci',
      '--docker-network=host',
      `--output-dir=${tempDir}`,
      '--output-file=remote.dump',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker run --rm --name charitypilot-url-backup-[^\s]+(?: --user \d+:\d+)? --network host/);
    assert.match(result.stdout, /CHARITYPILOT_BACKUP_DATABASE_URL/);
    assert.doesNotMatch(result.stdout, /backup-user:secret/);
    assert.equal(existsSync(join(tempDir, 'remote.dump')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('source identity dry run is remote-safe, read-only, parseable by contract, and never prints credentials', async () => {
  const result = await runBackupCli([
    'source-identity',
    '--database-url=postgresql://identity-user:identity-secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&sslrootcert=system',
    '--docker-network=production-egress',
    '--json',
    '--dry-run',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(result.stdout, /pg_export_snapshot/);
  assert.match(result.stdout, /SET LOCAL row_security = 'off'|SET LOCAL row_security = off/);
  assert.match(result.stdout, /--network production-egress/);
  assert.match(result.stdout, /Source database identity dry run rendered; no identity was captured\./);
  assert.doesNotMatch(result.stdout, /identity-user|identity-secret|db\.charitypilot\.ie|postgresql:\/\//);
  assert.doesNotMatch(result.stdout, /"ok":true|Source database identity SHA-256:/);
  assert.deepEqual(readdirSync(repoRoot).filter((name) => name.includes('source-identity')), []);
});

test('proof/source URLs reject libpq routing overrides, duplicate parameters, and ambiguous identities', async () => {
  const rejectedUrls = [
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?host=attacker.example',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?hostaddr=203.0.113.1',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?service=production',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?options=-csearch_path%3Devil',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?sslmode=verify-full&sslmode=require',
    'postgresql://proof-user:secret@db1.example,db2.example/charitypilot',
    'postgresql://:secret@db.charitypilot.ie/charitypilot',
  ];
  for (const databaseUrl of rejectedUrls) {
    const result = await runBackupCli(['source-identity', `--database-url=${databaseUrl}`, '--dry-run']);
    assert.equal(result.status, 1, databaseUrl);
    assert.match(result.stderr, /not allowlisted|repeats parameter|exactly one host, database, and user/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret|attacker\.example|203\.0\.113\.1|production|evil|db1\.example/);
  }
});

test('remote proof/source URLs require authenticated verify-full TLS and an aligned bounded option set', async () => {
  for (const databaseUrl of [
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?sslmode=require',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?sslmode=verify-ca',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?SSLMODE=verify-full',
    'postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?sslmode=verify-full&channel_binding=prefer',
    'postgresql://proof-user:secret@localhost/charitypilot_ci?sslmode=verify-full',
  ]) {
    const result = await runBackupCli(['source-identity', `--database-url=${databaseUrl}`, '--dry-run']);
    assert.equal(result.status, 1, databaseUrl);
    assert.match(result.stderr, /verify-full|canonical lowercase|channel_binding|Loopback/);
    assert.doesNotMatch(result.stdout + result.stderr, /proof-user|secret@|db\.charitypilot\.ie/);
  }

  const accepted = await runBackupCli([
    'source-identity',
    '--database-url=postgresql://proof-user:secret@db.charitypilot.ie/charitypilot?sslmode=verify-full&sslrootcert=system&channel_binding=require&target_session_attrs=read-only&connect_timeout=30&application_name=charitypilot_restore_proof',
    '--dry-run',
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(accepted.stdout + accepted.stderr, /proof-user|secret@|db\.charitypilot\.ie/);
});

test('prove-restore requires an explicit absolute protected output directory', async () => {
  const common = [
    'prove-restore',
    '--database-url=postgresql://proof-user:proof-secret@db.charitypilot.ie/charitypilot?sslmode=verify-full&sslrootcert=system',
    '--recovery-set-id=CP-2026-07-11-001',
    `--expected-source-database-identity-sha256=${digest('a')}`,
    '--dry-run',
  ];
  const missing = await runBackupCli(common);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--output-dir is required/);

  const relative = await runBackupCli([...common, '--output-dir=relative-proof']);
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /explicit absolute path/);
});

test('source fingerprint temp-file limit is configurable only within the safe bounded range', async () => {
  for (const value of ['0', '63', '2049', '-1', '1.5', 'unlimited']) {
    const result = await runBackupCli([
      'source-identity',
      '--database-url=postgresql://proof-user:proof-secret@db.charitypilot.ie/charitypilot?sslmode=verify-full&sslrootcert=system',
      `--temp-file-limit-mb=${value}`,
      '--dry-run',
    ]);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /must be an integer from 64 to 2048/);
  }
  const accepted = await runBackupCli([
    'source-identity',
    '--database-url=postgresql://proof-user:proof-secret@db.charitypilot.ie/charitypilot?sslmode=verify-full&sslrootcert=system',
    '--temp-file-limit-mb=64',
    '--dry-run',
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /CHARITYPILOT_TEMP_FILE_LIMIT_KB/);
});

test('prove-restore dry run accepts a remote source only through a locked read-only snapshot and isolated target', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-proof-dry-run-'));
  try {
    const result = await runBackupCli([
      'prove-restore',
      '--database-url=postgresql://proof-user:proof-secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&sslrootcert=system',
      '--docker-network=production-egress',
      '--recovery-set-id=CP-2026-07-11-001',
      `--expected-source-database-identity-sha256=${digest('a')}`,
      `--output-dir=${tempDir}`,
      '--output-file=production.dump',
      '--report-file=production.restore-proof.json',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REPEATABLE READ READ ONLY/);
    assert.match(result.stdout, /LOCK TABLE ONLY %I\.%I IN ACCESS SHARE MODE/);
    assert.match(result.stdout, /pg_export_snapshot/);
    assert.match(result.stdout, /No public application tables were available to fingerprint/);
    assert.match(result.stdout, /Snapshot-bound dump or fingerprint action failed/);
    assert.match(result.stdout, /RAISE EXCEPTION 'No public application tables were available to fingerprint\.'/);
    assert.doesNotMatch(result.stdout, /SELECT 1 \/ 0/);
    assert.match(result.stdout, /pg_dump --snapshot <validated-exported-snapshot>/);
    assert.match(result.stdout, /CHARITYPILOT_MAX_DUMP_BYTES/);
    assert.match(result.stdout, /read-only pg_database_size\(current_database\(\)\)/);
    assert.match(result.stdout, /requiredAvailableBytes=min\(maxDumpBytes, sourceDatabaseSizeBytes\*2\+1073741824\)/);
    assert.match(result.stdout, /df -Pk \/proof/);
    assert.match(result.stdout, /ulimit -f/);
    assert.match(result.stdout, /--no-blobs/);
    assert.match(result.stdout, /all supported public schema objects/);
    assert.match(result.stdout, /canonical length\/hex\/JSON-framed SHA-256/);
    assert.match(result.stdout, /pg_restore --list/);
    assert.equal((result.stdout.match(/pg_restore --list/g) ?? []).length, 2);
    assert.match(result.stdout, /--tmpfs "?\/var\/lib\/postgresql\/data:rw,noexec,nosuid,size=4g"?/);
    assert.match(result.stdout, /docker ps -a --filter label=charitypilot\.restore-proof=true/);
    assert.match(result.stdout, /docker run -d --rm --name charitypilot-isolated-restore-[^\n]+ --network none/);
    assert.match(result.stdout, /docker exec -e PGPASSWORD charitypilot-isolated-restore-[^\n]+ createdb/);
    assert.match(result.stdout, /--template template0/);
    assert.match(result.stdout, /--encoding "<source-database-encoding>"/);
    assert.match(result.stdout, /--locale-provider libc/);
    assert.match(result.stdout, /--lc-collate "<source-database-collation>"/);
    assert.match(result.stdout, /--lc-ctype "<source-database-ctype>"/);
    assert.match(result.stdout, /--network container:charitypilot-isolated-restore-/);
    assert.match(result.stdout, /-e POSTGRES_PASSWORD(?:\s|$)/);
    assert.doesNotMatch(result.stdout, /(?:^|\s)-p(?:\s|$)|--publish/);
    const isolatedStart = result.stdout.split(/\r?\n/).find((line) => line.includes('docker run -d --rm --name charitypilot-isolated-restore-'));
    assert.ok(isolatedStart);
    assert.doesNotMatch(isolatedStart, /(?:^|\s)-v(?:\s|$)|--volume/);
    assert.match(isolatedStart, /-e POSTGRES_PASSWORD(?:\s|$)/);
    assert.doesNotMatch(isolatedStart, /POSTGRES_PASSWORD=/);
    assert.doesNotMatch(result.stdout, /PGPASSWORD=/);
    assert.doesNotMatch(result.stdout, /proof-user|proof-secret|db\.charitypilot\.ie|postgresql:\/\//);
    assert.match(result.stdout, /docker rm -f -v charitypilot-source-snapshot-/);
    assert.match(result.stdout, /docker rm -f -v charitypilot-isolated-restore-/);
    assert.match(result.stdout, /dry run rendered; no evidence was captured/);
    assert.doesNotMatch(result.stdout, /Production-safe database restore proof passed/);
    assert.deepEqual(readdirSync(tempDir), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CI and release restore gates require source-initialized database environment parity', () => {
  for (const workflowPath of [
    '.github/workflows/ci.yml',
    '.github/workflows/release-images.yml',
  ]) {
    const workflow = readFileSync(join(repoRoot, workflowPath), 'utf8');
    assert.match(workflow, /value\.restoreTarget\?\.databaseEnvironmentPreserved !== true/);
    assert.match(workflow, /value\.restoreTarget\?\.initializedFromSourceDatabaseEnvironment !== true/);
    assert.match(workflow, /sourceDatabaseEnvironment\.localeProvider !== "libc"/);
    assert.match(
      workflow,
      /JSON\.stringify\(sourceDatabaseEnvironment\) !== JSON\.stringify\(restoredDatabaseEnvironment\)/,
    );
    assert.match(workflow, /comparison\.databaseEnvironmentMatched !== true/);
  }
});

test('prove-restore requires external identity and recovery-set bindings and never overwrites evidence', async () => {
  const baseArgs = [
    'prove-restore',
    '--database-url=postgresql://proof-user:proof-secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&sslrootcert=system',
    '--dry-run',
  ];
  const missingRecoverySet = await runBackupCli(baseArgs);
  assert.equal(missingRecoverySet.status, 1);
  assert.match(missingRecoverySet.stderr, /--recovery-set-id is required/);

  const missingIdentity = await runBackupCli([...baseArgs, '--recovery-set-id=CP-2026-07-11-001']);
  assert.equal(missingIdentity.status, 1);
  assert.match(missingIdentity.stderr, /--expected-source-database-identity-sha256 must be exactly 64/);

  const invalidRecoverySet = await runBackupCli([
    ...baseArgs,
    '--recovery-set-id=unsafe recovery set',
    `--expected-source-database-identity-sha256=${digest('a')}`,
  ]);
  assert.equal(invalidRecoverySet.status, 1);
  assert.match(invalidRecoverySet.stderr, /3-128 safe characters/);

  const removedOverwrite = await runBackupCli([
    ...baseArgs,
    '--recovery-set-id=CP-2026-07-11-001',
    `--expected-source-database-identity-sha256=${digest('a')}`,
    '--overwrite',
  ]);
  assert.equal(removedOverwrite.status, 2);
  assert.match(removedOverwrite.stderr, /Unknown option --overwrite for prove-restore/);
  assert.doesNotMatch(removedOverwrite.stderr, /proof-user:proof-secret/);

  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-proof-exclusive-'));
  writeFileSync(join(tempDir, 'retained.dump'), 'retained');
  try {
    const retained = await runBackupCli([
      'prove-restore',
      '--database-url=postgresql://proof-user:proof-secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&sslrootcert=system',
      '--recovery-set-id=CP-2026-07-11-001',
      `--expected-source-database-identity-sha256=${digest('a')}`,
      `--output-dir=${tempDir}`,
      '--output-file=retained.dump',
      '--report-file=retained.json',
    ]);
    assert.equal(retained.status, 1);
    assert.match(retained.stderr, /Proof output already exists/);
    assert.equal(readFileSync(join(tempDir, 'retained.dump'), 'utf8'), 'retained');
    assert.deepEqual(readdirSync(tempDir), ['retained.dump']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI renders operational restore sentinel seeding without exposing the database URL', async () => {
  const result = await runBackupCli([
    'seed-restore-sentinel',
    '--database-url=postgresql://backup-user:secret@localhost:5432/charitypilot_ci',
    '--docker-network=host',
    '--dry-run',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docker run --rm --name charitypilot-restore-sentinel-seed-[^\s]+ --network host/);
  assert.match(result.stdout, /CHARITYPILOT_RESTORE_SENTINEL_DATABASE_URL/);
  assert.match(result.stdout, /charitypilot-restore-sentinel-org/);
  assert.match(result.stdout, /charitypilot-restore-sentinel-user/);
  assert.match(result.stdout, /charitypilot-restore-sentinel-document/);
  assert.match(result.stdout, /"ComplianceRecord"/);
  assert.match(result.stdout, /"DocumentStorageDeletionRecovery"/);
  assert.match(result.stdout, /charitypilot-restore-sentinel-storage-recovery/);
  assert.match(result.stdout, /00000000-0000-4000-8000-000000000001/);
  assert.match(result.stdout, /"lastRecoveryDisposition" = 'REQUEUE_UNCHANGED'/);
  assert.match(result.stdout, /"state" = 'PROCESSED'/);
  assert.match(result.stdout, /ON CONFLICT/);
  assert.doesNotMatch(result.stdout, /backup-user:secret/);
});

test('postgres backup CLI always refuses remote operational sentinel seeding', async () => {
  const result = await runBackupCli([
    'seed-restore-sentinel',
    '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    '--dry-run',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /confirmed local CI\/test\/e2e\/disposable database with no URI routing options/);
  assert.doesNotMatch(result.stdout, /INSERT INTO "Organisation"/);
  assert.doesNotMatch(result.stderr, /backup-user:secret/);
});

test('postgres backup CLI refuses URI-routed or personal local sentinel targets', async () => {
  for (const databaseUrl of [
    'postgresql://backup-user:secret@localhost:5432/charitypilot_ci?host=db.example.org',
    'postgresql://backup-user:secret@localhost:5432/charitypilot_ci?hostaddr=203.0.113.10',
    'postgresql://backup-user:secret@localhost:5432/charitypilot_ci?service=remote-production',
    'postgresql://backup-user:secret@localhost:5432/charitypilot_ci?servicefile=/tmp/pg-service.conf',
    'postgresql://backup-user:secret@localhost:5432/charitypilot',
    'postgresql://backup-user:secret@127.0.0.1:5432/postgres',
  ]) {
    const result = await runBackupCli([
      'seed-restore-sentinel',
      `--database-url=${databaseUrl}`,
      '--dry-run',
    ]);

    assert.equal(result.status, 1, databaseUrl);
    assert.match(result.stderr, /confirmed local CI\/test\/e2e\/disposable database with no URI routing options/);
    assert.doesNotMatch(result.stdout, /INSERT INTO "Organisation"/);
    assert.doesNotMatch(result.stdout + result.stderr, /db\.example\.org|203\.0\.113\.10|remote-production|pg-service\.conf/);
  }
});

test('postgres backup CLI rejects the removed remote sentinel escape hatch without executing SQL', async () => {
  const result = await runBackupCli([
    'seed-restore-sentinel',
    '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    '--allow-remote-sentinel',
    '--dry-run',
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--allow-remote-sentinel has been removed/);
  assert.doesNotMatch(result.stdout, /INSERT INTO "Organisation"/);
  assert.doesNotMatch(result.stdout, /docker run --rm/);
  assert.doesNotMatch(result.stdout, /backup-user:secret/);
  assert.doesNotMatch(result.stderr, /backup-user:secret/);
});

test('postgres backup CLI renders restore verification commands in dry-run mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-restore-dry-run-'));
  const dumpPath = join(tempDir, 'charitypilot-postgres.dump');
  writeFileSync(dumpPath, 'not-a-real-dump');

  try {
    const result = await runBackupCli(['verify-restore', `--dump-file=${dumpPath}`, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /charitypilot-restore-verify-\d+-\d+-[a-f0-9]{8}/);
    assert.match(result.stdout, /pg_isready -h 127\.0\.0\.1/);
    assert.match(result.stdout, /pg_restore/);
    assert.match(result.stdout, /docker run -d --rm --name charitypilot-restore-verify-[^\n]+ --network none/);
    assert.match(result.stdout, /--tmpfs "?\/var\/lib\/postgresql\/data:rw,noexec,nosuid,size=4g"?/);
    assert.match(result.stdout, /-e POSTGRES_PASSWORD(?:\s|$)/);
    assert.doesNotMatch(result.stdout, /POSTGRES_PASSWORD=|postgresql:\/\/charitypilot:/);
    const restoreDatabaseStart = result.stdout.split(/\r?\n/).find((line) => line.includes('docker run -d --rm --name charitypilot-restore-verify-'));
    assert.ok(restoreDatabaseStart);
    assert.doesNotMatch(restoreDatabaseStart, /(?:^|\s)-v(?:\s|$)|--volume/);
    assert.match(result.stdout, /docker rm -f -v charitypilot-restore-verify-/);
    assert.match(result.stdout, /select table_name from information_schema\.tables/);
    assert.match(result.stdout, /'_prisma_migrations'/);
    assert.match(result.stdout, /'Organisation'/);
    assert.match(result.stdout, /'User'/);
    assert.match(result.stdout, /'Document'/);
    assert.match(result.stdout, /'DocumentStorageDeletion'/);
    assert.match(result.stdout, /'DocumentStorageDeletionRecovery'/);
    assert.match(result.stdout, /'StripeWebhookEvent'/);
    assert.match(result.stdout, /'Deadline'/);
    assert.match(result.stdout, /'DeadlineReminderLog'/);
    assert.match(result.stdout, /'SecurityAuditEvent'/);
    assert.match(result.stdout, /'BillingAuthorityGrant'/);
    assert.match(result.stdout, /from "GovernancePrinciple"/);
    assert.match(result.stdout, /from "GovernanceStandard"/);
    assert.match(result.stdout, /core_standards/);
    assert.match(result.stdout, /additional_standards/);
    assert.match(result.stdout, /principle_signature/);
    assert.match(result.stdout, /standard_signature/);
    assert.match(result.stdout, /md5\(string_agg/);
    assert.match(result.stdout, /"title"/);
    assert.match(result.stdout, /"sortOrder"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI renders operational sentinel verification in dry-run mode when requested', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-restore-sentinel-dry-run-'));
  const dumpPath = join(tempDir, 'charitypilot-postgres.dump');
  writeFileSync(dumpPath, 'not-a-real-dump');

  try {
    const result = await runBackupCli([
      'verify-restore',
      `--dump-file=${dumpPath}`,
      '--expect-operational-sentinel',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /from "Organisation"/);
    assert.match(result.stdout, /from "User"/);
    assert.match(result.stdout, /from "Document"/);
    assert.match(result.stdout, /from "ComplianceRecord"/);
    assert.match(result.stdout, /from "DocumentStorageDeletion"/);
    assert.match(result.stdout, /from "DocumentStorageDeletionRecovery"/);
    assert.match(result.stdout, /charitypilot-restore-sentinel-storage-recovery/);
    assert.match(result.stdout, /"lastRecoveryNonce"/);
    assert.match(result.stdout, /"previousTerminalReason"/);
    assert.match(result.stdout, /from "StripeWebhookEvent"/);
    assert.match(result.stdout, /charitypilot-restore-sentinel-org/);
    assert.match(result.stdout, /operational_signature/);
    assert.match(result.stdout, /md5\(concat_ws/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('package scripts expose database backup and restore verification commands', () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts['db:backup'], 'node scripts/postgres-backup.mjs backup');
  assert.equal(packageJson.scripts['db:restore:verify'], 'node scripts/postgres-backup.mjs verify-restore');
  assert.match(packageJson.scripts['test:production-check'], /scripts\/postgres-backup\.test\.mjs/);
});
