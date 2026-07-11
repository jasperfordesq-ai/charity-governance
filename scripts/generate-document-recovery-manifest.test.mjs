import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  posixOwnerOnlyStatMatches,
  runGenerateDocumentRecoveryManifestFromArgs,
} from './generate-document-recovery-manifest.mjs';
import {
  DOCUMENT_RECOVERY_HASH_CONTRACT,
  DOCUMENT_RECOVERY_LIMITS,
  runVerifyDocumentRecoveryFromArgs,
  validateDocumentRecoveryManifest,
} from './verify-document-recovery.mjs';

const NOW = new Date('2026-07-11T11:00:00.000Z');
const hash = (character) => character.repeat(64);
const contentHash = (value) => createHash('sha256').update(value).digest('hex');
const ACKNOWLEDGEMENT = 'This recovery exercise used isolated non-production database and object-storage targets; production was not overwritten.';

function evidenceReference(path, digest = hash('e')) {
  return `https://evidence.charitypilot.ie/recovery/${path}/${digest}`;
}

function validConfig() {
  return {
    kind: 'charitypilot-document-recovery-build-input',
    schemaVersion: 1,
    exercise: {
      id: 'DR-2026-001',
      owner: 'Recovery Operations Owner',
      startedAt: '2026-07-11T10:05:00.000Z',
      simulatedFailureAt: '2026-07-11T10:00:00.000Z',
      completedAt: '2026-07-11T10:45:00.000Z',
      maximumRecoveryPointSkewMinutes: 10,
      maximumDocumentProofAgeMinutes: 120,
      notes: 'Isolated joint recovery exercise completed without production writes.',
      evidenceReference: evidenceReference('DR-2026-001'),
    },
    source: {
      environment: 'production',
      recoverySetId: 'recovery-set-2026-001',
      databaseIdentity: {
        provider: 'supabase',
        projectRef: 'production-project-ref',
        databaseName: 'postgres',
        schemaName: 'public',
      },
      objectStoreIdentity: {
        provider: 'supabase-storage',
        projectRef: 'production-project-ref',
        bucketName: 'documents',
      },
      databaseDumpSha256: hash('9'),
      objectBackupManifestSha256: hash('0'),
      sourceCaptureReportSha256: hash('f'),
      sourceCaptureReference: evidenceReference('DR-2026-001/source-capture', hash('f')),
      recoverySetReference: evidenceReference('DR-2026-001/source'),
    },
    target: {
      environment: 'non-production',
      restoreTargetType: 'isolated-non-production',
      isolated: true,
      databaseIdentity: {
        provider: 'local-postgres',
        projectRef: 'isolated-restore-project',
        databaseName: 'charitypilot_restore',
        schemaName: 'public',
      },
      objectStoreIdentity: {
        provider: 'filesystem-fixture',
        projectRef: 'isolated-restore-project',
        bucketName: 'restored-documents',
      },
      isolationEvidenceReference: evidenceReference('DR-2026-001/isolation'),
    },
    backupControls: {
      database: {
        encrypted: true,
        versioned: true,
        owner: 'Database Backup Owner',
        retentionDays: 30,
        backupPolicyReference: evidenceReference('policies/database-backup'),
        retentionPolicyReference: evidenceReference('policies/retention'),
        monitoringReference: evidenceReference('monitoring/database-backup'),
        deletionPolicyReference: evidenceReference('policies/secure-deletion'),
      },
      documentBytes: {
        encrypted: true,
        versioned: true,
        owner: 'Document Backup Owner',
        retentionDays: 30,
        backupPolicyReference: evidenceReference('policies/document-backup'),
        retentionPolicyReference: evidenceReference('policies/retention'),
        monitoringReference: evidenceReference('monitoring/document-backup'),
        deletionPolicyReference: evidenceReference('policies/secure-deletion'),
      },
    },
    objectives: {
      database: { rpoMinutes: 60, rtoMinutes: 60, policyReference: evidenceReference('policies/recovery') },
      documentBytes: { rpoMinutes: 60, rtoMinutes: 60, policyReference: evidenceReference('policies/recovery') },
    },
    restore: {
      database: {
        completed: true,
        recoverySetId: 'recovery-set-2026-001',
        backupReference: evidenceReference('DR-2026-001/database-backup', hash('9')),
        recoveredThroughAt: '2026-07-11T09:30:00.000Z',
        verifiedAt: '2026-07-11T10:30:00.000Z',
      },
      documentBytes: {
        completed: true,
        recoverySetId: 'recovery-set-2026-001',
        backupReference: evidenceReference('DR-2026-001/document-backup', hash('0')),
        recoveredThroughAt: '2026-07-11T09:32:00.000Z',
        verifiedAt: '2026-07-11T10:40:00.000Z',
      },
    },
    reconciliation: {
      reportReferenceTemplate: 'https://evidence.charitypilot.ie/recovery/DR-2026-001/reconciliation/{reconciliationReportSha256}',
    },
    attestations: {
      productionDatabaseOverwritten: false,
      productionObjectStoreOverwritten: false,
      restoreCredentialsScopedToTarget: true,
      attestedBy: 'Recovery Operations Owner',
      attestedAt: '2026-07-11T10:50:00.000Z',
      productionProtectionEvidenceReference: evidenceReference('DR-2026-001/production-protection'),
      acknowledgement: ACKNOWLEDGEMENT,
    },
  };
}

function metadataRows() {
  return [
    { id: 'doc-one', organisationId: 'org-one', fileUrl: 'org-one/doc-one.txt', fileSize: 3, mimeType: 'text/plain' },
    { id: 'doc-two', organisationId: 'org-one', fileUrl: 'org-one/doc-two.txt', fileSize: 4, mimeType: 'text/plain' },
  ];
}

function objectRows() {
  return [
    { fileUrl: 'org-one/doc-one.txt', bytes: 3, sha256: contentHash('one') },
    { fileUrl: 'org-one/doc-two.txt', bytes: 4, sha256: contentHash('four') },
  ];
}

function storageDeletionRows() {
  return [{
    id: 'storage-deletion-one',
    organisationId: 'org-one',
    storagePath: 'org-one/deleted-document.txt',
    state: 'PROCESSED',
    attempts: 5,
    lastError: null,
    lastAttemptAt: '2026-07-11T09:20:00.000Z',
    nextAttemptAt: null,
    claimedAt: null,
    deadLetteredAt: null,
    terminalReason: null,
    alertClaimToken: null,
    alertClaimedAt: null,
    alertedAt: null,
    processedAt: '2026-07-11T09:25:00.000Z',
    lastRecoveryId: 'storage-recovery-one',
    lastRecoveryNonce: '11111111-1111-4111-8111-111111111111',
    lastRecoveryDisposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
    lastRecoveredAt: '2026-07-11T09:25:00.000Z',
    createdAt: '2026-07-11T09:15:00.000Z',
    updatedAt: '2026-07-11T09:25:00.000Z',
  }];
}

function recoveryEventRows() {
  return [{
    id: 'storage-recovery-one',
    recoveryNonce: '11111111-1111-4111-8111-111111111111',
    transactionId: '1001',
    deletionId: 'storage-deletion-one',
    organisationId: 'org-one',
    actorType: 'PLATFORM_OPERATOR',
    actorUserId: null,
    operatorIdentity: 'platform-operator-17',
    reason: 'Object deletion was independently completed by platform operations.',
    disposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
    previousAttempts: 5,
    previousTerminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
    previousStoragePath: 'org-one/deleted-document.txt',
    correctedStoragePath: null,
    createdAt: '2026-07-11T09:24:00.000Z',
  }];
}

function exportEnvelope(kind, captureRole, rows) {
  const metadata = kind === 'charitypilot-document-metadata-inventory-export';
  const capturedAt = metadata
    ? (captureRole === 'source' ? '2026-07-11T09:30:00.000Z' : '2026-07-11T10:35:00.000Z')
    : (captureRole === 'source' ? '2026-07-11T09:32:00.000Z' : '2026-07-11T10:40:00.000Z');
  return {
    kind,
    schemaVersion: 1,
    captureRole,
    exerciseId: 'DR-2026-001',
    recoverySetId: 'recovery-set-2026-001',
    capturedAt,
    inventoryScope: metadata ? 'complete-document-and-storage-deletion-tables' : 'complete-whole-bucket',
    ...(metadata
      ? {
          documentRowCount: rows.length,
          storageDeletionRowCount: 1,
          recoveryEventRowCount: 1,
          captureTransactionId: captureRole === 'source' ? '2001' : '3001',
          documentStorageDeletions: storageDeletionRows(),
          documentStorageDeletionRecoveries: recoveryEventRows(),
        }
      : {
          bucketObjectCount: rows.length,
          bucketTotalBytes: rows.reduce((total, row) => total + row.bytes, 0),
        }),
    rows,
  };
}

function withWorkspace(fn) {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-document-manifest-'));
  try {
    const paths = {
      root,
      config: join(root, 'build-input.json'),
      sourceMetadata: join(root, 'source-metadata.json'),
      restoredMetadata: join(root, 'restored-metadata.json'),
      sourceObjects: join(root, 'source-objects.json'),
      restoredObjects: join(root, 'restored-objects.json'),
      output: join(root, 'document-recovery-manifest.json'),
      template: join(root, 'document-recovery-build-input.json'),
    };
    const fixtures = {
      config: validConfig(),
      sourceMetadata: exportEnvelope('charitypilot-document-metadata-inventory-export', 'source', metadataRows()),
      restoredMetadata: exportEnvelope('charitypilot-document-metadata-inventory-export', 'restored', metadataRows()),
      sourceObjects: exportEnvelope('charitypilot-document-object-inventory-export', 'source', objectRows()),
      restoredObjects: exportEnvelope('charitypilot-document-object-inventory-export', 'restored', objectRows()),
    };
    writeFixtures(paths, fixtures);
    return fn({ paths, fixtures });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixtures(paths, fixtures) {
  writeFileSync(paths.config, `${JSON.stringify(fixtures.config, null, 2)}\n`);
  writeFileSync(paths.sourceMetadata, `${JSON.stringify(fixtures.sourceMetadata, null, 2)}\n`);
  writeFileSync(paths.restoredMetadata, `${JSON.stringify(fixtures.restoredMetadata, null, 2)}\n`);
  writeFileSync(paths.sourceObjects, `${JSON.stringify(fixtures.sourceObjects, null, 2)}\n`);
  writeFileSync(paths.restoredObjects, `${JSON.stringify(fixtures.restoredObjects, null, 2)}\n`);
}

function buildArgs(paths, output = paths.output) {
  return [
    'build',
    '--config-file', paths.config,
    '--source-metadata-file', paths.sourceMetadata,
    '--restored-metadata-file', paths.restoredMetadata,
    '--source-object-inventory-file', paths.sourceObjects,
    '--restored-object-inventory-file', paths.restoredObjects,
    '--output-file', output,
    '--json',
  ];
}

function runBuild(paths, overrides = {}) {
  return runGenerateDocumentRecoveryManifestFromArgs(buildArgs(paths, overrides.output), {
    now: () => NOW,
    secureOwnerOnly: (path, { directory = false } = {}) => chmodSync(path, directory ? 0o700 : 0o600),
    ownerOnlyCheck: () => true,
    ...overrides,
  });
}

function verifierArgs(path, payload) {
  return [
    '--manifest-file', path,
    '--expected-recovery-manifest-sha256', payload.recoveryManifestSha256,
    '--expected-source-binding-sha256', payload.sourceBindingSha256,
    '--expected-database-dump-sha256', payload.databaseDumpSha256,
    '--expected-object-backup-manifest-sha256', payload.objectBackupManifestSha256,
    '--expected-source-capture-report-sha256', payload.sourceCaptureReportSha256,
    '--expected-source-database-identity-sha256', payload.sourceDatabaseIdentitySha256,
    '--expected-source-object-store-identity-sha256', payload.sourceObjectStoreIdentitySha256,
    '--expected-metadata-inventory-sha256', payload.metadataInventorySha256,
    '--expected-object-inventory-sha256', payload.objectInventorySha256,
    '--expected-restored-metadata-inventory-sha256', payload.restoredMetadataInventorySha256,
    '--expected-restored-object-inventory-sha256', payload.restoredObjectInventorySha256,
    '--expected-storage-deletion-inventory-sha256', payload.storageDeletionInventorySha256,
    '--expected-restored-storage-deletion-inventory-sha256', payload.restoredStorageDeletionInventorySha256,
    '--expected-recovery-event-inventory-sha256', payload.recoveryEventInventorySha256,
    '--expected-restored-recovery-event-inventory-sha256', payload.restoredRecoveryEventInventorySha256,
    '--expected-production-document-count', String(payload.productionDocumentCount),
    '--expected-storage-deletion-count', String(payload.storageDeletionCount),
    '--expected-pending-storage-deletion-count', String(payload.pendingStorageDeletionCount),
    '--expected-dead-letter-storage-deletion-count', String(payload.deadLetterStorageDeletionCount),
    '--expected-processed-storage-deletion-count', String(payload.processedStorageDeletionCount),
    '--expected-recovery-event-count', String(payload.recoveryEventCount),
    '--expected-source-metadata-captured-at', payload.sourceMetadataCapturedAt,
    '--expected-restored-metadata-captured-at', payload.restoredMetadataCapturedAt,
    '--expected-source-object-inventory-captured-at', payload.sourceObjectInventoryCapturedAt,
    '--expected-restored-object-inventory-captured-at', payload.restoredObjectInventoryCapturedAt,
    '--expected-source-metadata-capture-transaction-id', payload.sourceMetadataCaptureTransactionId,
    '--expected-restored-metadata-capture-transaction-id', payload.restoredMetadataCaptureTransactionId,
    '--expected-maximum-document-proof-age-minutes', String(payload.maximumDocumentProofAgeMinutes),
    '--expected-exercise-id', payload.exerciseId,
    '--expected-recovery-set-id', payload.recoverySetId,
    '--json',
  ];
}

function assertSchemaObjectsAreClosed(node, path = '$') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${path} must reject additional properties`);
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path} must require every declared field`);
  }
  for (const [key, value] of Object.entries(node)) assertSchemaObjectsAreClosed(value, `${path}.${key}`);
}

test('the v1 JSON Schema closes every object and records the exact verifier bounds and constants', () => {
  const schema = JSON.parse(readFileSync(new URL('./charitypilot-document-recovery-manifest-v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema['x-charitypilot-manifest-format'], 'charitypilot-document-recovery-manifest-v1');
  assert.equal(schema['x-charitypilot-max-serialized-bytes'], 16 * 1024 * 1024);
  assert.equal(schema['x-charitypilot-max-inventory-entries'], 5000);
  assert.equal(schema['x-charitypilot-max-document-bytes'], 10 * 1024 * 1024);
  assert.equal(schema['x-charitypilot-max-aggregate-object-bytes'], 5000 * 10 * 1024 * 1024);
  assert.equal(schema['x-charitypilot-max-document-proof-age-minutes'], 1440);
  assert.equal(schema.properties.kind.const, 'charitypilot-document-recovery-manifest');
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.$defs.metadataInventory.properties.expected.maxItems, 5000);
  assert.equal(schema.$defs.objectInventory.properties.restored.maxItems, 5000);
  assert.equal(schema.$defs.metadataEntry.properties.fileSize.maximum, 10 * 1024 * 1024);
  assert.equal(schema.$defs.objectEntry.properties.bytes.maximum, 10 * 1024 * 1024);
  assert.equal(schema.$defs.transactionId.maxLength, 19);
  assert.equal(schema.$defs.transactionId.pattern, '^[1-9][0-9]{0,18}$');
  assert.equal(schema.$defs.attestations.properties.acknowledgement.const, ACKNOWLEDGEMENT);
  assert.deepEqual(
    Object.fromEntries(Object.entries(schema.$defs.hashContract.properties).map(([key, value]) => [key, value.const])),
    { ...DOCUMENT_RECOVERY_HASH_CONTRACT },
  );
  assert.equal(schema['x-charitypilot-max-serialized-bytes'], DOCUMENT_RECOVERY_LIMITS.maxManifestBytes);
  assert.equal(schema['x-charitypilot-max-inventory-entries'], DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries);
  assert.equal(schema['x-charitypilot-max-document-bytes'], DOCUMENT_RECOVERY_LIMITS.maxDocumentBytes);
  assert.equal(schema['x-charitypilot-max-aggregate-object-bytes'], DOCUMENT_RECOVERY_LIMITS.maxAggregateBytes);
  assertSchemaObjectsAreClosed(schema);
});

test('CLI help is explicit about offline operation, no production mutation, and fail-closed bounds', () => {
  const help = runGenerateDocumentRecoveryManifestFromArgs(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /never connects to or mutates production/i);
  assert.match(help.stdout, /5,?000 documents|5000 documents/i);
  assert.match(help.stdout, /16777216 serialized manifest bytes/);
  assert.match(help.stdout, /refuses overwrites/i);
});

test('CLI rejects duplicate boolean flags instead of silently weakening strict option parsing', async (t) => {
  await t.test('--json', () => {
    const duplicate = runGenerateDocumentRecoveryManifestFromArgs(['template', '--output-file', 'unused.json', '--json', '--json']);
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /--json must be provided at most once/);
  });
  await t.test('--help', () => {
    const duplicate = runGenerateDocumentRecoveryManifestFromArgs(['--help', '-h']);
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /--help must be provided at most once/);
  });
});

test('template creates an owner-scoped deliberately invalid placeholder and refuses overwrite', () => withWorkspace(({ paths }) => {
  const first = runGenerateDocumentRecoveryManifestFromArgs(
    ['template', '--output-file', paths.template, '--json'],
    {
      secureOwnerOnly: (path, { directory = false } = {}) => chmodSync(path, directory ? 0o700 : 0o600),
      ownerOnlyCheck: () => true,
    },
  );
  assert.equal(first.status, 0, first.stderr);
  const payload = JSON.parse(first.stdout);
  const generated = JSON.parse(readFileSync(paths.template, 'utf8'));
  assert.equal(payload.safePlaceholder, true);
  assert.equal(payload.productionConnected, false);
  assert.equal(payload.productionMutated, false);
  assert.equal(payload.publication.atomicNoOverwritePublished, true);
  assert.equal(payload.publication.ownerOnlyDirectoryVerified, true);
  assert.equal(payload.publication.ownerOnlyFileVerified, true);
  assert.equal(payload.publication.platformPathIdentityChecksUsed, true);
  assert.equal(payload.publication.exactBytesAndSha256Verified, true);
  assert.equal(generated.kind, 'charitypilot-document-recovery-build-input');
  assert.match(generated.exercise.id, /REPLACE_WITH/);
  assert.equal(generated.target.isolated, false);
  assert.equal(generated.restore.database.completed, false);
  assert.equal(generated.attestations.restoreCredentialsScopedToTarget, false);
  assert.notEqual(generated.attestations.acknowledgement, ACKNOWLEDGEMENT);
  if (process.platform !== 'win32') assert.equal(statSync(paths.template).mode & 0o777, 0o600);

  const second = runGenerateDocumentRecoveryManifestFromArgs(
    ['template', '--output-file', paths.template, '--json'],
    { ownerOnlyCheck: () => true },
  );
  assert.equal(second.status, 1);
  assert.match(JSON.parse(second.stdout).issues.join('\n'), /overwrites are forbidden/);
}));

test('completed independent exports generate a hashed manifest that passes the authoritative verifier', () => withWorkspace(({ paths }) => {
  const built = runBuild(paths);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const payload = JSON.parse(built.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.manifestFormat, 'charitypilot-document-recovery-manifest-v1');
  assert.equal(payload.productionDocumentCount, 2);
  assert.equal(payload.exerciseId, 'DR-2026-001');
  assert.equal(payload.sourceCaptureRequired, true);
  assert.equal(payload.independentBindingArgumentsMatched, false);
  assert.equal(payload.sourceProvenanceExternallyVerified, false);
  assert.equal(Object.hasOwn(payload, 'sourceProvenanceExternallyBound'), false);
  assert.equal(payload.providerOperatorProvenanceVerified, false);
  assert.equal(payload.pendingStorageDeletionCount, 0);
  assert.equal(payload.deadLetterStorageDeletionCount, 0);
  assert.equal(payload.processedStorageDeletionCount, 1);
  assert.equal(payload.restoredStorageDeletionCount, 1);
  assert.equal(payload.restoredPendingStorageDeletionCount, 0);
  assert.equal(payload.restoredDeadLetterStorageDeletionCount, 0);
  assert.equal(payload.restoredProcessedStorageDeletionCount, 1);
  assert.equal(payload.recoveryEventCount, 1);
  assert.match(payload.recoveryEventInventorySha256, /^[a-f0-9]{64}$/);
  assert.match(payload.restoredRecoveryEventInventorySha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.sourceMetadataCaptureTransactionId, '2001');
  assert.equal(payload.restoredMetadataCaptureTransactionId, '3001');
  assert.equal(payload.documentProofFresh, true);
  assert.equal(payload.productionConnected, false);
  assert.equal(payload.productionMutated, false);
  assert.equal(payload.secretValuesPrinted, false);
  assert.equal(payload.publication.atomicNoOverwritePublished, true);
  assert.equal(payload.publication.stableDirectoryIdentityVerified, true);
  assert.equal(payload.publication.ownerOnlyDirectoryVerified, true);
  assert.equal(payload.publication.ownerOnlyFileVerified, true);
  assert.equal(payload.publication.exactBytesAndSha256Verified, true);
  assert.match(payload.reconciliationReportSha256, /^[a-f0-9]{64}$/);
  const raw = readFileSync(paths.output, 'utf8');
  assert.equal(payload.publication.outputSha256, contentHash(raw));
  const manifest = JSON.parse(raw);
  assert.equal(validateDocumentRecoveryManifest(manifest, { now: NOW, rawText: raw }).ok, true);
  assert.doesNotMatch(raw, /doc-one|org-one\/doc-one|production-project-ref/);
  assert.doesNotMatch(raw, /storage-deletion-one|org-one\/deleted-document\.txt/);
  assert.doesNotMatch(raw, /storage-recovery-one|11111111-1111-4111-8111-111111111111|platform-operator-17/);
  assert.doesNotMatch(raw, /independently completed by platform operations/);
  assert.equal(manifest.reconciliation.metadataInventory.sourceCapturedAt, '2026-07-11T09:30:00.000Z');
  assert.equal(manifest.reconciliation.objectInventory.restoredCapturedAt, '2026-07-11T10:40:00.000Z');
  assert.equal(manifest.reconciliation.storageDeletionInventory.expected[0].state, 'PROCESSED');
  assert.equal(manifest.reconciliation.storageDeletionRecoveryInventory.expected.length, 1);
  assert.equal(manifest.reconciliation.storageDeletionRecoveryInventory.sourceCaptureTransactionId, '2001');
  assert.match(manifest.reconciliation.metadataInventory.expected[0].documentIdentitySha256, /^[a-f0-9]{64}$/);

  const verified = runVerifyDocumentRecoveryFromArgs(verifierArgs(paths.output, payload), { now: () => NOW });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  const verification = JSON.parse(verified.stdout);
  assert.equal(verification.ok, true);
  assert.equal(verification.reconciliationReportSha256, payload.reconciliationReportSha256);
  assert.equal(verification.recoveryManifestSha256, payload.recoveryManifestSha256);
}));

test('capture chronology and bounded proof freshness reject skew, premature restored capture, and old exports', async (t) => {
  await t.test('source capture skew', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.config.restore.database.recoveredThroughAt = '2026-07-11T09:00:00.000Z';
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /source metadata capturedAt exceeds the declared skew/);
  }));

  await t.test('restored capture before restore completion', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.restoredMetadata.capturedAt = '2026-07-11T10:29:59.999Z';
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /restored metadata capturedAt must not be before database restore completion/);
  }));

  await t.test('old exports wrapped in a later launch check', () => withWorkspace(({ paths }) => {
    const built = runBuild(paths, { now: () => new Date('2026-07-11T12:00:01.000Z') });
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /exceeds exercise\.maximumDocumentProofAgeMinutes/);
  }));

  await t.test('still-fresh exports replayed under a different exercise ID', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.config.exercise.id = 'DR-2026-002';
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /exerciseId must match the completed build input/);
  }));
});

test('DocumentStorageDeletion certification rejects outstanding queues, preserves processed history, and binds restore fidelity', async (t) => {
  await t.test('pending row', () => withWorkspace(({ paths, fixtures }) => {
    for (const metadata of [fixtures.sourceMetadata, fixtures.restoredMetadata]) {
      const row = metadata.documentStorageDeletions[0];
      row.state = 'PENDING';
      row.attempts = 0;
      row.lastAttemptAt = null;
      row.nextAttemptAt = '2026-07-11T09:30:00.000Z';
      row.processedAt = null;
      row.lastRecoveryId = null;
      row.lastRecoveryNonce = null;
      row.lastRecoveryDisposition = null;
      row.lastRecoveredAt = null;
      metadata.recoveryEventRowCount = 0;
      metadata.documentStorageDeletionRecoveries = [];
    }
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /zero outstanding PENDING or DEAD_LETTER/);
  }));

  await t.test('dead-letter row', () => withWorkspace(({ paths, fixtures }) => {
    for (const metadata of [fixtures.sourceMetadata, fixtures.restoredMetadata]) {
      const row = metadata.documentStorageDeletions[0];
      row.state = 'DEAD_LETTER';
      row.attempts = 5;
      row.lastError = 'name=StorageProviderError code=DELETE_FAILED';
      row.lastAttemptAt = '2026-07-11T09:24:00.000Z';
      row.deadLetteredAt = '2026-07-11T09:25:00.000Z';
      row.terminalReason = 'MAX_ATTEMPTS_EXHAUSTED';
      row.processedAt = null;
      row.lastRecoveryId = null;
      row.lastRecoveryNonce = null;
      row.lastRecoveryDisposition = null;
      row.lastRecoveredAt = null;
      metadata.recoveryEventRowCount = 0;
      metadata.documentStorageDeletionRecoveries = [];
    }
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /zero outstanding PENDING or DEAD_LETTER/);
  }));

  await t.test('processed history mismatch', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.restoredMetadata.documentStorageDeletions[0].processedAt = '2026-07-11T09:26:00.000Z';
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /do not reconcile exactly/);
  }));
});

test('DocumentStorageDeletionRecovery exports enforce exact fields, database invariants, latest linkage, and parity', async (t) => {
  const forBothMetadataExports = (fixtures, mutate) => {
    for (const metadata of [fixtures.sourceMetadata, fixtures.restoredMetadata]) mutate(metadata);
  };
  const expectBuildIssue = (mutate, pattern) => withWorkspace(({ paths, fixtures }) => {
    mutate(fixtures);
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), pattern);
  });

  await t.test('exact recovery row fields', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      delete metadata.documentStorageDeletionRecoveries[0].operatorIdentity;
    });
  }, /must contain exactly the documented fields/));

  await t.test('canonical database-supplied transaction identifier', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries[0].transactionId = '01001';
    });
  }, /canonical bounded decimal transaction identifier/));

  await t.test('transaction identifier cannot exceed PostgreSQL bigint', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries[0].transactionId = '9223372036854775808';
    });
  }, /canonical bounded decimal transaction identifier/));

  await t.test('source recovery transaction must predate its capture transaction', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries[0].transactionId = '9001';
    });
  }, /must predate the source metadata capture transaction/));

  await t.test('recovery event timestamp cannot postdate its metadata capture', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries[0].createdAt = '2026-07-11T09:31:00.000Z';
    });
  }, /createdAt must not be after the metadata capture/));

  await t.test('last-recovery timestamp cannot postdate its metadata capture', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletions[0].lastRecoveredAt = '2026-07-11T09:31:00.000Z';
    });
  }, /lastRecoveredAt must not be after the metadata capture/));

  await t.test('canonical UUID-v4 recovery nonce', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries[0].recoveryNonce = 'not-a-database-recovery-nonce';
      metadata.documentStorageDeletions[0].lastRecoveryNonce = 'not-a-database-recovery-nonce';
    });
  }, /canonical lowercase UUID v4/));

  await t.test('duplicate recovery IDs and nonces', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries.push({
        ...structuredClone(metadata.documentStorageDeletionRecoveries[0]),
        recoveryNonce: '22222222-2222-4222-8222-222222222222',
      });
      metadata.recoveryEventRowCount = 2;
    });
  }, /duplicate recovery-event IDs/));

  await t.test('duplicate recovery nonces across distinct event IDs', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries.push({
        ...structuredClone(metadata.documentStorageDeletionRecoveries[0]),
        id: 'storage-recovery-two',
      });
      metadata.recoveryEventRowCount = 2;
    });
  }, /duplicate recovery-event nonces/));

  await t.test('all-or-none deletion binding', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletions[0].lastRecoveryNonce = null;
    });
  }, /all-or-none last-recovery binding/));

  await t.test('recovery events require the deletion binding', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      Object.assign(metadata.documentStorageDeletions[0], {
        lastRecoveryId: null,
        lastRecoveryNonce: null,
        lastRecoveryDisposition: null,
        lastRecoveredAt: null,
      });
    });
  }, /recovery events without the deletion's exact last-recovery binding/));

  await t.test('exact ID, nonce, deletion, organisation, and disposition link', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletions[0].lastRecoveryNonce = '33333333-3333-4333-8333-333333333333';
    });
  }, /last-recovery binding does not match its exact recovery event/));

  await t.test('tenant actor cannot use platform dispositions', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      Object.assign(metadata.documentStorageDeletionRecoveries[0], {
        actorType: 'TENANT_USER',
        actorUserId: 'tenant-admin-one',
        operatorIdentity: null,
      });
    });
  }, /invalid tenant-user actor or disposition binding/));

  await t.test('platform actor must be specifically named', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries[0].operatorIdentity = 'operator';
    });
  }, /invalid named platform-operator actor binding/));

  await t.test('corrected paths reject live-document and deletion collisions', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      Object.assign(metadata.documentStorageDeletionRecoveries[0], {
        disposition: 'REQUEUE_CORRECTED_PATH',
        correctedStoragePath: 'org-one/doc-one.txt',
      });
    });
  }, /invalid corrected-path disposition/));

  await t.test('permanently rejected paths cannot be requeued unchanged', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      Object.assign(metadata.documentStorageDeletionRecoveries[0], {
        disposition: 'REQUEUE_UNCHANGED',
        previousTerminalReason: 'PERMANENT_STORAGE_PATH_REJECTED',
      });
    });
  }, /cannot requeue a permanently rejected storage path unchanged/));

  await t.test('last binding must point at the latest recovery transaction', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries.push({
        ...structuredClone(metadata.documentStorageDeletionRecoveries[0]),
        id: 'storage-recovery-two',
        recoveryNonce: '22222222-2222-4222-8222-222222222222',
        transactionId: '1002',
        createdAt: '2026-07-11T09:24:30.000Z',
      });
      metadata.recoveryEventRowCount = 2;
    });
  }, /last-recovery binding is not its latest recovery transaction/));

  await t.test('latest transaction cannot contain an unbound duplicate recovery event', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletionRecoveries.push({
        ...structuredClone(metadata.documentStorageDeletionRecoveries[0]),
        id: 'storage-recovery-two',
        recoveryNonce: '22222222-2222-4222-8222-222222222222',
      });
      metadata.recoveryEventRowCount = 2;
    });
  }, /last-recovery binding is not its latest recovery transaction/));

  await t.test('external completion preserves the terminal attempt count', () => expectBuildIssue((fixtures) => {
    forBothMetadataExports(fixtures, (metadata) => {
      metadata.documentStorageDeletions[0].attempts = 6;
    });
  }, /external completion must preserve the dead letter's attempt count/));

  await t.test('source and restored recovery histories must match exactly', () => expectBuildIssue((fixtures) => {
    fixtures.restoredMetadata.documentStorageDeletionRecoveries[0].reason =
      'Object deletion was externally completed and independently reviewed.';
  }, /DocumentStorageDeletionRecovery.*do not reconcile exactly/));
});

test('whole-bucket object exports reject filtered scope, processed-path residue, and arbitrary bucket orphans', async (t) => {
  await t.test('filtered false claim', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.sourceObjects.inventoryScope = 'live-document-keys-only';
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /inventoryScope must be complete-whole-bucket/);
  }));

  await t.test('processed deletion path still has bytes', () => withWorkspace(({ paths, fixtures }) => {
    for (const objects of [fixtures.sourceObjects, fixtures.restoredObjects]) {
      objects.rows.push({ fileUrl: 'org-one/deleted-document.txt', bytes: 1, sha256: contentHash('x') });
      objects.bucketObjectCount += 1;
      objects.bucketTotalBytes += 1;
    }
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /equal complete counts/);
  }));

  await t.test('full-bucket orphan', () => withWorkspace(({ paths, fixtures }) => {
    for (const objects of [fixtures.sourceObjects, fixtures.restoredObjects]) {
      objects.rows.push({ fileUrl: 'unowned/orphan.bin', bytes: 1, sha256: contentHash('z') });
      objects.bucketObjectCount += 1;
      objects.bucketTotalBytes += 1;
    }
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /equal complete counts/);
  }));
});

test('a source/restored mismatch fails closed without writing a manifest', () => withWorkspace(({ paths, fixtures }) => {
  fixtures.restoredObjects.rows[0].sha256 = contentHash('two');
  writeFixtures(paths, fixtures);
  const built = runBuild(paths);
  assert.equal(built.status, 1);
  assert.match(JSON.parse(built.stdout).issues.join('\n'), /do not reconcile exactly/);
  assert.throws(() => statSync(paths.output), /ENOENT/);
}));

test('duplicate metadata IDs and duplicate object keys are independently rejected', async (t) => {
  await t.test('metadata IDs', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.sourceMetadata.rows.push({ ...fixtures.sourceMetadata.rows[0], fileUrl: 'org-one/another.txt' });
    fixtures.sourceMetadata.documentRowCount += 1;
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /duplicate document IDs/);
  }));
  await t.test('object keys', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.sourceObjects.rows.push({ ...fixtures.sourceObjects.rows[0] });
    fixtures.sourceObjects.bucketObjectCount += 1;
    fixtures.sourceObjects.bucketTotalBytes += fixtures.sourceObjects.rows[0].bytes;
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /duplicate object keys/);
  }));
});

test('duplicate JSON object keys are rejected before parsing', () => withWorkspace(({ paths }) => {
  const raw = readFileSync(paths.config, 'utf8').trimEnd();
  writeFileSync(paths.config, raw.replace('{', '{"kind":"duplicate",'));
  const built = runBuild(paths);
  assert.equal(built.status, 1);
  assert.match(JSON.parse(built.stdout).issues.join('\n'), /duplicate object keys/);
}));

test('the 5,000-document and 10 MiB per-document bounds fail closed', async (t) => {
  await t.test('inventory count', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.sourceMetadata.rows = Array.from({ length: 5001 }, (_, index) => ({
      id: `doc-${index}`,
      organisationId: 'org-one',
      fileUrl: `org-one/doc-${index}.txt`,
      fileSize: 0,
      mimeType: 'text/plain',
    }));
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /1 to 5000 entries/);
  }));
  await t.test('document bytes', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.sourceObjects.rows[0].bytes = (10 * 1024 * 1024) + 1;
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /safe integer from 0 to 10485760/);
  }));
});

test('secret-looking provider and database values are rejected without echoing them', () => withWorkspace(({ paths, fixtures }) => {
  fixtures.config.exercise.notes = 'DATABASE_URL=postgresql://operator:super-secret@db.charitypilot.ie/production';
  writeFixtures(paths, fixtures);
  const built = runBuild(paths);
  assert.equal(built.status, 1);
  assert.match(JSON.parse(built.stdout).issues.join('\n'), /secret-looking material/);
  assert.doesNotMatch(built.stdout, /super-secret|operator:|postgresql:\/\//);
  assert.doesNotMatch(built.stderr, /super-secret|operator:|postgresql:\/\//);
}));

test('generic and escaped credential keys plus Slack and Supabase tokens fail closed without disclosure', async (t) => {
  for (const [label, rawKey] of [
    ['exact client_secret key', 'client_secret'],
    ['escaped client_secret key', 'client\\u005fsecret'],
  ]) {
    await t.test(label, () => withWorkspace(({ paths, fixtures }) => {
      const credential = `fixture-${label.replaceAll(' ', '-')}-value`;
      const configWithCredential = { ...fixtures.config, client_secret: credential };
      const raw = `${JSON.stringify(configWithCredential, null, 2)}\n`
        .replace('"client_secret"', `"${rawKey}"`);
      writeFileSync(paths.config, raw);
      const built = runBuild(paths);
      assert.equal(built.status, 1);
      assert.match(JSON.parse(built.stdout).issues.join('\n'), /secret-looking material/);
      assert.doesNotMatch(built.stdout, new RegExp(credential));
      assert.doesNotMatch(built.stderr, new RegExp(credential));
    }));
  }

  const slackToken = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
  const supabaseToken = ['sb', 'secret', 'abcdefghijklmnopqrstuvwxyz'].join('_');
  for (const [label, token] of [
    ['Slack', slackToken],
    ['Supabase', supabaseToken],
  ]) {
    await t.test(label, () => withWorkspace(({ paths, fixtures }) => {
      fixtures.config.exercise.notes = `Credential accidentally included: ${token}`;
      writeFixtures(paths, fixtures);
      const built = runBuild(paths);
      assert.equal(built.status, 1);
      assert.match(JSON.parse(built.stdout).issues.join('\n'), /secret-looking material/);
      assert.doesNotMatch(built.stdout, new RegExp(token));
      assert.doesNotMatch(built.stderr, new RegExp(token));
    }));
  }
});

test('in-repository output must be conclusively ignored and untracked', () => withWorkspace(({ paths }) => {
  const output = resolve(process.cwd(), 'document-recovery-unsafe-output.json');
  const built = runGenerateDocumentRecoveryManifestFromArgs(buildArgs(paths, output), {
    repoRoot: process.cwd(),
    now: () => NOW,
    gitPathStatus: () => ({ available: true, tracked: true, ignored: false }),
    secureOwnerOnly: (path) => chmodSync(path, 0o600),
    ownerOnlyCheck: () => true,
  });
  assert.equal(built.status, 1);
  assert.match(JSON.parse(built.stdout).issues.join('\n'), /must not be tracked|ignored path/);
  assert.throws(() => statSync(output), /ENOENT/);
}));

test('build refuses to overwrite an existing manifest and leaves its bytes unchanged', () => withWorkspace(({ paths }) => {
  const first = runBuild(paths);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const before = readFileSync(paths.output);
  const second = runBuild(paths);
  assert.equal(second.status, 1);
  assert.match(JSON.parse(second.stdout).issues.join('\n'), /overwrites are forbidden/);
  assert.deepEqual(readFileSync(paths.output), before);
}));

test('unsupported fields and recovery-set swaps fail closed', async (t) => {
  await t.test('unsupported row field', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.sourceMetadata.rows[0].signedUrl = 'not-accepted';
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /exactly the documented fields/);
  }));
  await t.test('recovery-set mismatch', () => withWorkspace(({ paths, fixtures }) => {
    fixtures.restoredObjects.recoverySetId = 'another-recovery-set';
    writeFixtures(paths, fixtures);
    const built = runBuild(paths);
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /recoverySetId must match/);
  }));
});

test('manifest publication rejects unsafe directories, directory swaps, and post-publication substitution', async (t) => {
  await t.test('unsafe existing directory', () => withWorkspace(({ paths }) => {
    const unsafeDirectory = join(paths.root, 'unsafe-output');
    mkdirSync(unsafeDirectory, { mode: 0o777 });
    const output = join(unsafeDirectory, 'manifest.json');
    const built = runBuild(paths, {
      output,
      ownerOnlyCheck: (path, { directory = false } = {}) => !(directory && path === unsafeDirectory),
    });
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /output directory must already be restricted to the current owner/);
    assert.throws(() => statSync(output), /ENOENT/);
  }));

  await t.test('directory identity swap before publish', () => withWorkspace(({ paths }) => {
    const output = join(paths.root, 'swappable-output', 'manifest.json');
    const built = runBuild(paths, {
      output,
      publicationHooks: {
        beforePublish({ outputDirectory }) {
          renameSync(outputDirectory, `${outputDirectory}-original`);
          mkdirSync(outputDirectory, { mode: 0o700 });
        },
      },
    });
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /output directory identity.*changed during publication/);
  }));

  await t.test('failure after canonical link clears canonical and temporary paths so retry is safe', () => withWorkspace(({ paths }) => {
    const output = join(paths.root, 'post-link-failure-output', 'manifest.json');
    const failed = runBuild(paths, {
      output,
      publicationHooks: {
        afterCanonicalLink() {
          throw new Error('injected failure after canonical link publication');
        },
      },
    });
    assert.equal(failed.status, 1);
    assert.match(JSON.parse(failed.stdout).issues.join('\n'), /retry is safe/);
    assert.throws(() => statSync(output), /ENOENT/);
    assert.equal(
      readdirSync(dirname(output)).some((name) => name.endsWith('.tmp')),
      false,
      'temporary publication link must not remain at its canonical temporary path',
    );

    const retried = runBuild(paths, { output });
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.ok(statSync(output).isFile());
  }));

  await t.test('post-publication path substitution', () => withWorkspace(({ paths }) => {
    const output = join(paths.root, 'substitution-output', 'manifest.json');
    let replacement;
    const built = runBuild(paths, {
      output,
      publicationHooks: {
        afterPublish({ outputPath }) {
          const publishedBytes = readFileSync(outputPath);
          renameSync(outputPath, `${outputPath}.published`);
          replacement = Buffer.from(publishedBytes);
          replacement[0] ^= 1;
          writeFileSync(outputPath, replacement, { mode: 0o600 });
        },
      },
    });
    assert.equal(built.status, 1);
    assert.match(JSON.parse(built.stdout).issues.join('\n'), /substituted after publication/);
    assert.throws(() => statSync(output), /ENOENT/);
    const quarantine = readdirSync(dirname(output), { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.includes('.unusable.'));
    assert.ok(quarantine, 'substituted path must be retained in an explicit unusable quarantine');
    assert.deepEqual(
      readFileSync(join(dirname(output), quarantine.name, 'UNUSABLE-ARTIFACT.json')),
      replacement,
    );
    assert.ok(statSync(`${output}.published`).isFile(), 'the originally published inode must not be deleted');
  }));

  await t.test('same-inode same-size mutation is quarantined and a clean retry can publish', () => withWorkspace(({ paths }) => {
    const output = join(paths.root, 'same-inode-output', 'manifest.json');
    let sameIdentity = false;
    let mutatedBytes;
    const failed = runBuild(paths, {
      output,
      publicationHooks: {
        afterPublish({ outputPath }) {
          const before = statSync(outputPath, { bigint: true });
          mutatedBytes = readFileSync(outputPath);
          mutatedBytes[mutatedBytes.length - 2] ^= 1;
          writeFileSync(outputPath, mutatedBytes, { mode: 0o600 });
          const after = statSync(outputPath, { bigint: true });
          sameIdentity = before.dev === after.dev && before.ino === after.ino && before.size === after.size;
        },
      },
    });
    assert.equal(sameIdentity, true);
    assert.equal(failed.status, 1);
    assert.match(JSON.parse(failed.stdout).issues.join('\n'), /bytes, hash, size, mode, or path identity changed/);
    assert.throws(() => statSync(output), /ENOENT/);
    const quarantine = readdirSync(dirname(output), { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.includes('.unusable.'));
    assert.ok(quarantine);
    assert.deepEqual(
      readFileSync(join(dirname(output), quarantine.name, 'UNUSABLE-ARTIFACT.json')),
      mutatedBytes,
    );

    const retried = runBuild(paths, { output });
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.ok(statSync(output).isFile());
  }));
});

test('default publication security enforces owner-only directory and file controls on the current platform', () => withWorkspace(({ paths }) => {
  const output = join(paths.root, 'default-owner-only', 'template.json');
  const generated = runGenerateDocumentRecoveryManifestFromArgs(
    ['template', '--output-file', output, '--json'],
  );
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const payload = JSON.parse(generated.stdout);
  assert.equal(payload.publication.ownerOnlyDirectoryVerified, true);
  assert.equal(payload.publication.ownerOnlyFileVerified, true);
  assert.equal(payload.publication.noFollowReopenUsed, process.platform !== 'win32');
  assert.equal(payload.publication.platformPathIdentityChecksUsed, true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(paths.root, 'default-owner-only')).mode & 0o777, 0o700);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  }
}));

test('POSIX owner-only facts require both restrictive mode and the current UID when available', () => {
  assert.equal(posixOwnerOnlyStatMatches({ mode: 0o100600, uid: 1000 }, { currentUid: 1000 }), true);
  assert.equal(posixOwnerOnlyStatMatches({ mode: 0o100600, uid: 1001 }, { currentUid: 1000 }), false);
  assert.equal(posixOwnerOnlyStatMatches({ mode: 0o100640, uid: 1000 }, { currentUid: 1000 }), false);
  assert.equal(posixOwnerOnlyStatMatches({ mode: 0o040700, uid: 1000 }, { directory: true, currentUid: 1000 }), true);
  assert.equal(posixOwnerOnlyStatMatches({ mode: 0o040700, uid: 1001 }, { directory: true, currentUid: 1000 }), false);
});
