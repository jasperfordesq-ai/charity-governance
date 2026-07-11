import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DOCUMENT_RECOVERY_HASH_CONTRACT,
  DOCUMENT_RECOVERY_LIMITS,
  canonicalDatabaseIdentitySha256,
  canonicalDocumentIdentitySha256,
  canonicalMetadataInventorySha256,
  canonicalMetadataBindingSha256,
  canonicalObjectKeySha256,
  canonicalObjectInventorySha256,
  canonicalObjectStoreIdentitySha256,
  canonicalSourceBindingSha256,
  canonicalStorageDeletionBindingSha256,
  canonicalStorageDeletionIdentitySha256,
  canonicalStorageDeletionInventorySha256,
  canonicalStorageDeletionRecoveryBindingSha256,
  canonicalStorageDeletionRecoveryIdentitySha256,
  canonicalStorageDeletionRecoveryInventorySha256,
  canonicalStorageDeletionRecoveryNonceSha256,
  documentRecoverySecretIssues,
  duplicateJsonKeyIssues,
  gitCommandResultIsConclusive,
  isPathWithinRoot,
  jsonStructureIssues,
  manifestStorageIssues,
  readStableManifest,
  redactDocumentRecoveryTranscript,
  runVerifyDocumentRecoveryFromArgs,
  validateDocumentRecoveryManifest,
} from './verify-document-recovery.mjs';

const NOW = new Date('2026-07-11T11:00:00.000Z');
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const hash = (character) => character.repeat(64);

function evidenceReference(path, digest = hash('e')) {
  return `https://evidence.charitypilot.ie/recovery/${path}/${digest}`;
}

function exactSummary(metadata, objects, storageDeletions = [], recoveryEvents = []) {
  const bytes = objects.reduce((total, entry) => total + entry.bytes, 0);
  return {
    expectedMetadataRows: metadata.length,
    restoredMetadataRows: metadata.length,
    matchedMetadataRows: metadata.length,
    expectedObjectCount: objects.length,
    restoredObjectCount: objects.length,
    matchedObjectCount: objects.length,
    missingMetadataRows: 0,
    unexpectedMetadataRows: 0,
    missingObjectCount: 0,
    unexpectedObjectCount: 0,
    metadataMismatchCount: 0,
    objectKeyMismatchCount: 0,
    sizeMismatchCount: 0,
    checksumMismatchCount: 0,
    orphanExpectedObjectCount: 0,
    orphanRestoredObjectCount: 0,
    expectedBytes: bytes,
    restoredBytes: bytes,
    expectedStorageDeletionRows: storageDeletions.length,
    restoredStorageDeletionRows: storageDeletions.length,
    matchedStorageDeletionRows: storageDeletions.length,
    missingStorageDeletionRows: 0,
    unexpectedStorageDeletionRows: 0,
    storageDeletionMismatchCount: 0,
    sourcePendingStorageDeletionCount: storageDeletions.filter((entry) => entry.state === 'PENDING').length,
    sourceDeadLetterStorageDeletionCount: storageDeletions.filter((entry) => entry.state === 'DEAD_LETTER').length,
    sourceProcessedStorageDeletionCount: storageDeletions.filter((entry) => entry.state === 'PROCESSED').length,
    restoredPendingStorageDeletionCount: storageDeletions.filter((entry) => entry.state === 'PENDING').length,
    restoredDeadLetterStorageDeletionCount: storageDeletions.filter((entry) => entry.state === 'DEAD_LETTER').length,
    restoredProcessedStorageDeletionCount: storageDeletions.filter((entry) => entry.state === 'PROCESSED').length,
    processedDeletionObjectResidueCount: 0,
    expectedRecoveryEventRows: recoveryEvents.length,
    restoredRecoveryEventRows: recoveryEvents.length,
    matchedRecoveryEventRows: recoveryEvents.length,
    missingRecoveryEventRows: 0,
    unexpectedRecoveryEventRows: 0,
    recoveryEventMismatchCount: 0,
  };
}

function refreshSourceBindings(manifest) {
  const metadata = manifest.reconciliation.metadataInventory.expected;
  const objects = manifest.reconciliation.objectInventory.expected;
  const storageDeletions = manifest.reconciliation.storageDeletionInventory.expected;
  const recoveryEvents = manifest.reconciliation.storageDeletionRecoveryInventory.expected;
  const captures = {
    sourceMetadataCapturedAt: manifest.reconciliation.metadataInventory.sourceCapturedAt,
    restoredMetadataCapturedAt: manifest.reconciliation.metadataInventory.restoredCapturedAt,
    sourceObjectInventoryCapturedAt: manifest.reconciliation.objectInventory.sourceCapturedAt,
    restoredObjectInventoryCapturedAt: manifest.reconciliation.objectInventory.restoredCapturedAt,
    sourceMetadataCaptureTransactionId: manifest.reconciliation.metadataInventory.sourceCaptureTransactionId,
    restoredMetadataCaptureTransactionId: manifest.reconciliation.metadataInventory.restoredCaptureTransactionId,
  };
  manifest.source.productionDocumentCount = metadata.length;
  manifest.source.metadataInventorySha256 = canonicalMetadataInventorySha256(
    metadata,
    captures.sourceMetadataCapturedAt,
    captures.sourceMetadataCaptureTransactionId,
  );
  manifest.source.objectInventorySha256 = canonicalObjectInventorySha256(objects, captures.sourceObjectInventoryCapturedAt);
  manifest.source.storageDeletionCount = storageDeletions.length;
  manifest.source.pendingStorageDeletionCount = storageDeletions.filter((entry) => entry.state === 'PENDING').length;
  manifest.source.deadLetterStorageDeletionCount = storageDeletions.filter((entry) => entry.state === 'DEAD_LETTER').length;
  manifest.source.processedStorageDeletionCount = storageDeletions.filter((entry) => entry.state === 'PROCESSED').length;
  manifest.source.storageDeletionInventorySha256 = canonicalStorageDeletionInventorySha256(
    storageDeletions,
    captures.sourceMetadataCapturedAt,
    captures.sourceMetadataCaptureTransactionId,
  );
  manifest.source.recoveryEventCount = recoveryEvents.length;
  manifest.source.recoveryEventInventorySha256 = canonicalStorageDeletionRecoveryInventorySha256(
    recoveryEvents,
    captures.sourceMetadataCapturedAt,
    captures.sourceMetadataCaptureTransactionId,
  );
  manifest.reconciliation.metadataInventory.sourceInventorySha256 = manifest.source.metadataInventorySha256;
  manifest.reconciliation.metadataInventory.restoredInventorySha256 = canonicalMetadataInventorySha256(
    manifest.reconciliation.metadataInventory.restored,
    captures.restoredMetadataCapturedAt,
    captures.restoredMetadataCaptureTransactionId,
  );
  manifest.reconciliation.objectInventory.sourceInventorySha256 = manifest.source.objectInventorySha256;
  manifest.reconciliation.objectInventory.restoredInventorySha256 = canonicalObjectInventorySha256(
    manifest.reconciliation.objectInventory.restored,
    captures.restoredObjectInventoryCapturedAt,
  );
  manifest.reconciliation.storageDeletionInventory.sourceInventorySha256 = manifest.source.storageDeletionInventorySha256;
  manifest.reconciliation.storageDeletionInventory.restoredInventorySha256 = canonicalStorageDeletionInventorySha256(
    manifest.reconciliation.storageDeletionInventory.restored,
    captures.restoredMetadataCapturedAt,
    captures.restoredMetadataCaptureTransactionId,
  );
  manifest.reconciliation.storageDeletionRecoveryInventory.sourceInventorySha256 = manifest.source.recoveryEventInventorySha256;
  manifest.reconciliation.storageDeletionRecoveryInventory.restoredInventorySha256 = canonicalStorageDeletionRecoveryInventorySha256(
    manifest.reconciliation.storageDeletionRecoveryInventory.restored,
    captures.restoredMetadataCapturedAt,
    captures.restoredMetadataCaptureTransactionId,
  );
  manifest.source.sourceBindingSha256 = canonicalSourceBindingSha256({
    exerciseId: manifest.exercise.id,
    recoverySetId: manifest.source.recoverySetId,
    sourceCaptureReportSha256: manifest.source.sourceCaptureReportSha256,
    databaseIdentitySha256: manifest.source.databaseIdentitySha256,
    objectStoreIdentitySha256: manifest.source.objectStoreIdentitySha256,
    databaseDumpSha256: manifest.source.databaseDumpSha256,
    objectBackupManifestSha256: manifest.source.objectBackupManifestSha256,
    productionDocumentCount: manifest.source.productionDocumentCount,
    storageDeletionCount: manifest.source.storageDeletionCount,
    pendingStorageDeletionCount: manifest.source.pendingStorageDeletionCount,
    deadLetterStorageDeletionCount: manifest.source.deadLetterStorageDeletionCount,
    processedStorageDeletionCount: manifest.source.processedStorageDeletionCount,
    recoveryEventCount: manifest.source.recoveryEventCount,
    maximumDocumentProofAgeMinutes: manifest.exercise.maximumDocumentProofAgeMinutes,
    ...captures,
    metadataInventorySha256: manifest.source.metadataInventorySha256,
    restoredMetadataInventorySha256: manifest.reconciliation.metadataInventory.restoredInventorySha256,
    objectInventorySha256: manifest.source.objectInventorySha256,
    restoredObjectInventorySha256: manifest.reconciliation.objectInventory.restoredInventorySha256,
    storageDeletionInventorySha256: manifest.source.storageDeletionInventorySha256,
    restoredStorageDeletionInventorySha256: manifest.reconciliation.storageDeletionInventory.restoredInventorySha256,
    recoveryEventInventorySha256: manifest.source.recoveryEventInventorySha256,
    restoredRecoveryEventInventorySha256: manifest.reconciliation.storageDeletionRecoveryInventory.restoredInventorySha256,
  });
  const preliminary = validateDocumentRecoveryManifest(manifest, { now: new Date('2026-07-11T11:00:00.000Z') });
  if (preliminary.reconciliationReportSha256) {
    manifest.reconciliation.reportReference = evidenceReference(
      `${manifest.exercise.id}/reconciliation`,
      preliminary.reconciliationReportSha256,
    );
  }
  return manifest;
}

function refreshCompleteReconciliation(manifest) {
  manifest.reconciliation.reportedSummary = exactSummary(
    manifest.reconciliation.metadataInventory.expected,
    manifest.reconciliation.objectInventory.expected,
    manifest.reconciliation.storageDeletionInventory.expected,
    manifest.reconciliation.storageDeletionRecoveryInventory.expected,
  );
  return refreshSourceBindings(manifest);
}

function validManifest() {
  const metadata = [
    {
      documentIdentitySha256: hash('1'),
      metadataBindingSha256: hash('2'),
      objectKeySha256: hash('3'),
      fileSize: 1234,
    },
    {
      documentIdentitySha256: hash('5'),
      metadataBindingSha256: hash('6'),
      objectKeySha256: hash('7'),
      fileSize: 2345,
    },
  ];
  const objects = [
    { objectKeySha256: hash('3'), bytes: 1234, sha256: hash('4') },
    { objectKeySha256: hash('7'), bytes: 2345, sha256: hash('8') },
  ];
  const storageDeletions = [{
    deletionIdentitySha256: hash('9'),
    lifecycleBindingSha256: hash('a'),
    objectKeySha256: hash('f'),
    state: 'PROCESSED',
    lastRecoveryIdentitySha256: hash('b'),
    lastRecoveryNonceSha256: hash('c'),
    lastRecoveryDisposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
    lastRecoveredAt: '2026-07-11T09:25:00.000Z',
  }];
  const recoveryEvents = [{
    recoveryIdentitySha256: hash('b'),
    recoveryNonceSha256: hash('c'),
    recoveryBindingSha256: hash('d'),
    transactionId: '1001',
    deletionIdentitySha256: hash('9'),
    actorType: 'PLATFORM_OPERATOR',
    disposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
    previousTerminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
    previousObjectKeySha256: hash('f'),
    correctedObjectKeySha256: null,
    createdAt: '2026-07-11T09:24:00.000Z',
  }];
  const manifest = {
    kind: 'charitypilot-document-recovery-manifest',
    schemaVersion: 1,
    hashContract: { ...DOCUMENT_RECOVERY_HASH_CONTRACT },
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
      databaseIdentitySha256: hash('a'),
      objectStoreIdentitySha256: hash('b'),
      databaseDumpSha256: hash('9'),
      objectBackupManifestSha256: hash('0'),
      sourceCaptureReportSha256: hash('f'),
      sourceCaptureReference: evidenceReference('DR-2026-001/source-capture', hash('f')),
      productionDocumentCount: 0,
      metadataInventorySha256: '',
      objectInventorySha256: '',
      storageDeletionCount: 0,
      pendingStorageDeletionCount: 0,
      deadLetterStorageDeletionCount: 0,
      processedStorageDeletionCount: 0,
      storageDeletionInventorySha256: '',
      recoveryEventCount: 0,
      recoveryEventInventorySha256: '',
      sourceBindingSha256: '',
      recoverySetReference: evidenceReference('DR-2026-001/source'),
    },
    target: {
      environment: 'non-production',
      restoreTargetType: 'isolated-non-production',
      isolated: true,
      databaseIdentitySha256: hash('c'),
      objectStoreIdentitySha256: hash('d'),
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
      checksumAlgorithm: 'sha256',
      reportedSummary: exactSummary(metadata, objects, storageDeletions, recoveryEvents),
      metadataInventory: {
        inventoryScope: 'complete-document-table',
        sourceCapturedAt: '2026-07-11T09:30:00.000Z',
        restoredCapturedAt: '2026-07-11T10:35:00.000Z',
        sourceCaptureTransactionId: '2001',
        restoredCaptureTransactionId: '3001',
        sourceInventorySha256: '',
        restoredInventorySha256: '',
        expected: structuredClone(metadata),
        restored: structuredClone(metadata),
      },
      objectInventory: {
        inventoryScope: 'complete-whole-bucket',
        sourceCapturedAt: '2026-07-11T09:32:00.000Z',
        restoredCapturedAt: '2026-07-11T10:40:00.000Z',
        sourceInventorySha256: '',
        restoredInventorySha256: '',
        expected: structuredClone(objects),
        restored: structuredClone(objects),
      },
      storageDeletionInventory: {
        inventoryScope: 'complete-storage-deletion-table',
        sourceCapturedAt: '2026-07-11T09:30:00.000Z',
        restoredCapturedAt: '2026-07-11T10:35:00.000Z',
        sourceCaptureTransactionId: '2001',
        restoredCaptureTransactionId: '3001',
        sourceInventorySha256: '',
        restoredInventorySha256: '',
        expected: structuredClone(storageDeletions),
        restored: structuredClone(storageDeletions),
      },
      storageDeletionRecoveryInventory: {
        inventoryScope: 'complete-storage-deletion-recovery-table',
        sourceCapturedAt: '2026-07-11T09:30:00.000Z',
        restoredCapturedAt: '2026-07-11T10:35:00.000Z',
        sourceCaptureTransactionId: '2001',
        restoredCaptureTransactionId: '3001',
        sourceInventorySha256: '',
        restoredInventorySha256: '',
        expected: structuredClone(recoveryEvents),
        restored: structuredClone(recoveryEvents),
      },
      reportReference: evidenceReference('DR-2026-001/reconciliation'),
    },
    attestations: {
      productionDatabaseOverwritten: false,
      productionObjectStoreOverwritten: false,
      restoreCredentialsScopedToTarget: true,
      attestedBy: 'Recovery Operations Owner',
      attestedAt: '2026-07-11T10:50:00.000Z',
      productionProtectionEvidenceReference: evidenceReference('DR-2026-001/production-protection'),
      acknowledgement: 'This recovery exercise used isolated non-production database and object-storage targets; production was not overwritten.',
    },
  };
  return refreshSourceBindings(manifest);
}

function rawSha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function bindingArgs(manifest, raw) {
  return [
    '--expected-recovery-manifest-sha256', rawSha256(raw),
    '--expected-source-binding-sha256', manifest.source.sourceBindingSha256,
    '--expected-database-dump-sha256', manifest.source.databaseDumpSha256,
    '--expected-object-backup-manifest-sha256', manifest.source.objectBackupManifestSha256,
    '--expected-source-capture-report-sha256', manifest.source.sourceCaptureReportSha256,
    '--expected-source-database-identity-sha256', manifest.source.databaseIdentitySha256,
    '--expected-source-object-store-identity-sha256', manifest.source.objectStoreIdentitySha256,
    '--expected-metadata-inventory-sha256', manifest.source.metadataInventorySha256,
    '--expected-object-inventory-sha256', manifest.source.objectInventorySha256,
    '--expected-restored-metadata-inventory-sha256', manifest.reconciliation.metadataInventory.restoredInventorySha256,
    '--expected-restored-object-inventory-sha256', manifest.reconciliation.objectInventory.restoredInventorySha256,
    '--expected-storage-deletion-inventory-sha256', manifest.source.storageDeletionInventorySha256,
    '--expected-restored-storage-deletion-inventory-sha256', manifest.reconciliation.storageDeletionInventory.restoredInventorySha256,
    '--expected-recovery-event-inventory-sha256', manifest.source.recoveryEventInventorySha256,
    '--expected-restored-recovery-event-inventory-sha256', manifest.reconciliation.storageDeletionRecoveryInventory.restoredInventorySha256,
    '--expected-production-document-count', String(manifest.source.productionDocumentCount),
    '--expected-storage-deletion-count', String(manifest.source.storageDeletionCount),
    '--expected-pending-storage-deletion-count', String(manifest.source.pendingStorageDeletionCount),
    '--expected-dead-letter-storage-deletion-count', String(manifest.source.deadLetterStorageDeletionCount),
    '--expected-processed-storage-deletion-count', String(manifest.source.processedStorageDeletionCount),
    '--expected-recovery-event-count', String(manifest.source.recoveryEventCount),
    '--expected-source-metadata-captured-at', manifest.reconciliation.metadataInventory.sourceCapturedAt,
    '--expected-restored-metadata-captured-at', manifest.reconciliation.metadataInventory.restoredCapturedAt,
    '--expected-source-object-inventory-captured-at', manifest.reconciliation.objectInventory.sourceCapturedAt,
    '--expected-restored-object-inventory-captured-at', manifest.reconciliation.objectInventory.restoredCapturedAt,
    '--expected-source-metadata-capture-transaction-id', manifest.reconciliation.metadataInventory.sourceCaptureTransactionId,
    '--expected-restored-metadata-capture-transaction-id', manifest.reconciliation.metadataInventory.restoredCaptureTransactionId,
    '--expected-maximum-document-proof-age-minutes', String(manifest.exercise.maximumDocumentProofAgeMinutes),
    '--expected-exercise-id', manifest.exercise.id,
    '--expected-recovery-set-id', manifest.source.recoverySetId,
  ];
}

function withRawFile(raw, callback) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-document-recovery-'));
  const manifestPath = join(tempDir, 'document-recovery.json');
  writeFileSync(manifestPath, raw);
  chmodSync(manifestPath, 0o600);
  try {
    return callback({ tempDir, manifestPath });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runJson(manifest, { argsFrom = manifest, raw = JSON.stringify(manifest, null, 2), rawForBindings = raw } = {}) {
  return withRawFile(raw, ({ manifestPath }) => {
    const result = runVerifyDocumentRecoveryFromArgs(
      ['--manifest-file', manifestPath, ...bindingArgs(argsFrom, rawForBindings), '--json'],
      { now: () => NOW },
    );
    return { result, payload: result.stdout ? JSON.parse(result.stdout) : null };
  });
}

function fakeBigIntStats({
  dev = 1n,
  ino = 2n,
  size = 2n,
  mtimeNs = 3n,
  ctimeNs = 4n,
  mode = 0o100600n,
  uid = BigInt(typeof process.getuid === 'function' ? process.getuid() : 0),
  file = true,
  symbolicLink = false,
} = {}) {
  return {
    dev,
    ino,
    size,
    mtimeNs,
    ctimeNs,
    mode,
    uid,
    isFile: () => file,
    isSymbolicLink: () => symbolicLink,
  };
}

test('canonical hash helpers match executable v1 known vectors and exact contract literals', () => {
  assert.deepEqual(DOCUMENT_RECOVERY_HASH_CONTRACT, {
    algorithm: 'sha256',
    textEncoding: 'utf-8',
    canonicalEncoding: 'domain-newline-json-array-v1',
    backupArtifactEncoding: 'raw-bytes-v1',
    documentIdentityDomain: 'charitypilot:document-identity:v1',
    metadataBindingDomain: 'charitypilot:document-metadata-binding:v1',
    metadataBindingFields: 'id|organisationId|fileUrl|fileSize|mimeType',
    objectKeyDomain: 'charitypilot:document-object-key:v1',
    databaseIdentityDomain: 'charitypilot:database-identity:v1',
    databaseIdentityFields: 'provider|projectRef|databaseName|schemaName',
    objectStoreIdentityDomain: 'charitypilot:object-store-identity:v1',
    objectStoreIdentityFields: 'provider|projectRef|bucketName',
    metadataInventoryDomain: 'charitypilot:document-metadata-inventory:v1',
    metadataInventoryFields: 'inventoryScope=complete-document-table|capturedAt|captureTransactionId|documentIdentitySha256|metadataBindingSha256|objectKeySha256|fileSize',
    objectInventoryDomain: 'charitypilot:document-object-inventory:v1',
    objectInventoryFields: 'inventoryScope=complete-whole-bucket|capturedAt|objectKeySha256|bytes|sha256',
    storageDeletionIdentityDomain: 'charitypilot:document-storage-deletion-identity:v1',
    storageDeletionBindingDomain: 'charitypilot:document-storage-deletion-binding:v1',
    storageDeletionBindingFields: 'id|organisationId|storagePath|state|attempts|lastError|lastAttemptAt|nextAttemptAt|claimedAt|deadLetteredAt|terminalReason|alertClaimToken|alertClaimedAt|alertedAt|processedAt|lastRecoveryId|lastRecoveryNonce|lastRecoveryDisposition|lastRecoveredAt|createdAt|updatedAt',
    storageDeletionInventoryDomain: 'charitypilot:document-storage-deletion-inventory:v1',
    storageDeletionInventoryFields: 'inventoryScope=complete-storage-deletion-table|capturedAt|captureTransactionId|deletionIdentitySha256|lifecycleBindingSha256|objectKeySha256|state|lastRecoveryIdentitySha256|lastRecoveryNonceSha256|lastRecoveryDisposition|lastRecoveredAt',
    storageDeletionRecoveryIdentityDomain: 'charitypilot:document-storage-deletion-recovery-identity:v1',
    storageDeletionRecoveryNonceDomain: 'charitypilot:document-storage-deletion-recovery-nonce:v1',
    storageDeletionRecoveryBindingDomain: 'charitypilot:document-storage-deletion-recovery-binding:v1',
    storageDeletionRecoveryBindingFields: 'id|recoveryNonce|transactionId|deletionId|organisationId|actorType|actorUserId|operatorIdentity|reason|disposition|previousAttempts|previousTerminalReason|previousStoragePath|correctedStoragePath|createdAt',
    storageDeletionRecoveryInventoryDomain: 'charitypilot:document-storage-deletion-recovery-inventory:v1',
    storageDeletionRecoveryInventoryFields: 'inventoryScope=complete-storage-deletion-recovery-table|capturedAt|captureTransactionId|recoveryIdentitySha256|recoveryNonceSha256|recoveryBindingSha256|transactionId|deletionIdentitySha256|actorType|disposition|previousTerminalReason|previousObjectKeySha256|correctedObjectKeySha256|createdAt',
    sourceBindingDomain: 'charitypilot:document-recovery-source-binding:v1',
    sourceBindingFields: 'exerciseId|recoverySetId|sourceCaptureReportSha256|databaseIdentitySha256|objectStoreIdentitySha256|databaseDumpSha256|objectBackupManifestSha256|productionDocumentCount|storageDeletionCount|pendingStorageDeletionCount|deadLetterStorageDeletionCount|processedStorageDeletionCount|recoveryEventCount|maximumDocumentProofAgeMinutes|sourceMetadataCapturedAt|restoredMetadataCapturedAt|sourceObjectInventoryCapturedAt|restoredObjectInventoryCapturedAt|sourceMetadataCaptureTransactionId|restoredMetadataCaptureTransactionId|metadataInventorySha256|restoredMetadataInventorySha256|objectInventorySha256|restoredObjectInventorySha256|storageDeletionInventorySha256|restoredStorageDeletionInventorySha256|recoveryEventInventorySha256|restoredRecoveryEventInventorySha256',
    reconciliationReportDomain: 'charitypilot:document-reconciliation-report:v1',
  });
  assert.equal(
    canonicalDocumentIdentitySha256('doc-123'),
    '3b3588fa98ee91466ab05ba6fb8c7a8a9d83565df42a621d49a3bef1a820b2b9',
  );
  assert.equal(
    canonicalMetadataBindingSha256({
      id: 'doc-123',
      organisationId: 'org-456',
      fileUrl: 'org-456/path/report.csv',
      fileSize: 0,
      mimeType: 'text/csv',
    }),
    'eb32901fc570af3d273f26eed42199c80ccaaadd50a6d96d95d803bd530a50c1',
  );
  assert.equal(
    canonicalObjectKeySha256('org-456/path/report.csv'),
    'e04fe652e4fb4326ae878812c9e9695aa792dae92e307dfb34ba058745002014',
  );
  assert.equal(
    canonicalDatabaseIdentitySha256({
      provider: 'supabase-postgres',
      projectRef: 'project-ref',
      databaseName: 'charitypilot',
      schemaName: 'public',
    }),
    '600aeb8267ccbcaba780eadaa2150d7672747ff31e958e45bda0211a7703a7ca',
  );
  assert.equal(
    canonicalObjectStoreIdentitySha256({
      provider: 'supabase-storage',
      projectRef: 'project-ref',
      bucketName: 'documents',
    }),
    '5998d51cfb5cf631b8de350a0bd2acd29ab59e22b763545ef142ecfa4d445a40',
  );
  const lifecycle = {
    id: 'delete-123',
    organisationId: 'org-456',
    storagePath: 'org-456/deleted.pdf',
    state: 'PROCESSED',
    attempts: 2,
    lastError: null,
    lastAttemptAt: '2026-07-11T09:00:00.000Z',
    nextAttemptAt: null,
    claimedAt: null,
    deadLetteredAt: null,
    terminalReason: null,
    alertClaimToken: null,
    alertClaimedAt: null,
    alertedAt: null,
    processedAt: '2026-07-11T09:05:00.000Z',
    lastRecoveryId: 'recovery-123',
    lastRecoveryNonce: 'nonce-123',
    lastRecoveryDisposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
    lastRecoveredAt: '2026-07-11T09:04:00.000Z',
    createdAt: '2026-07-11T08:00:00.000Z',
    updatedAt: '2026-07-11T09:05:00.000Z',
  };
  const deletionIdentity = canonicalStorageDeletionIdentitySha256(lifecycle.id);
  const lifecycleBinding = canonicalStorageDeletionBindingSha256(lifecycle);
  assert.equal(deletionIdentity, '1492ce587a4bf7eac88e63c63fa1b97d7d3fdc04e418c0afa03f042b7d592dbd');
  assert.equal(lifecycleBinding, 'cf3cb25c7d3ebca73466b119cae9d52fc03d75ea9dc632a203f20d25fbaa58d6');
  assert.equal(
    canonicalStorageDeletionInventorySha256([{
      deletionIdentitySha256: deletionIdentity,
      lifecycleBindingSha256: lifecycleBinding,
      objectKeySha256: hash('a'),
      state: 'PROCESSED',
      lastRecoveryIdentitySha256: hash('b'),
      lastRecoveryNonceSha256: hash('c'),
      lastRecoveryDisposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
      lastRecoveredAt: '2026-07-11T09:04:00.000Z',
    }], '2026-07-11T09:30:00.000Z', '2001'),
    '4a4175388f30d88079f0b511d3d6b465883da933d9d911f163b54bf13e4b85d5',
  );
  assert.equal(
    canonicalMetadataInventorySha256([{
      documentIdentitySha256: hash('1'),
      metadataBindingSha256: hash('2'),
      objectKeySha256: hash('3'),
      fileSize: 0,
    }], '2026-07-11T09:30:00.000Z', '2001'),
    'b7647ace2c9b3f56c0fe093a6ce2931329fdf02d67c85e53aeac8852611a1c56',
  );
  assert.equal(
    canonicalObjectInventorySha256([{
      objectKeySha256: hash('3'),
      bytes: 0,
      sha256: EMPTY_SHA256,
    }], '2026-07-11T09:32:00.000Z'),
    'e507a094e70b860c59e2cb0312eb9ffb460de077e2be112299279c88ca8c1c42',
  );
  const recovery = {
    id: 'recovery-123',
    recoveryNonce: 'nonce-123',
    transactionId: '1001',
    deletionId: 'delete-123',
    organisationId: 'org-456',
    actorType: 'PLATFORM_OPERATOR',
    actorUserId: null,
    operatorIdentity: 'operator-123',
    reason: 'Externally remediated after independent review.',
    disposition: 'COMPLETE_EXTERNALLY_REMEDIATED',
    previousAttempts: 2,
    previousTerminalReason: 'MAX_ATTEMPTS_EXHAUSTED',
    previousStoragePath: 'org-456/deleted.pdf',
    correctedStoragePath: null,
    createdAt: '2026-07-11T09:03:00.000Z',
  };
  const recoveryIdentity = canonicalStorageDeletionRecoveryIdentitySha256(recovery.id);
  const recoveryNonce = canonicalStorageDeletionRecoveryNonceSha256(recovery.recoveryNonce);
  const recoveryBinding = canonicalStorageDeletionRecoveryBindingSha256(recovery);
  assert.equal(recoveryIdentity, '5563822ff1d628c50755e8e1893bd9457f8d71753b3a1d83360588bdd5d9278a');
  assert.equal(recoveryNonce, '87684c397fefcf36c591261ee069ce91f5c10a9c877897e8ddb8afaee6e24954');
  assert.equal(recoveryBinding, '50b90b7d3031858fbc5944f62d6a5448503f85deac47215e34428a1afc279c5f');
  assert.equal(
    canonicalStorageDeletionRecoveryInventorySha256([{
      recoveryIdentitySha256: recoveryIdentity,
      recoveryNonceSha256: recoveryNonce,
      recoveryBindingSha256: recoveryBinding,
      transactionId: recovery.transactionId,
      deletionIdentitySha256: deletionIdentity,
      actorType: recovery.actorType,
      disposition: recovery.disposition,
      previousTerminalReason: recovery.previousTerminalReason,
      previousObjectKeySha256: canonicalObjectKeySha256(recovery.previousStoragePath),
      correctedObjectKeySha256: null,
      createdAt: recovery.createdAt,
    }], '2026-07-11T09:30:00.000Z', '2001'),
    '865bbf9b304baf16ae31fcaacf6bda8e3b2867363f3bf624c6e43610346b902a',
  );
  assert.equal(
    canonicalSourceBindingSha256({
      exerciseId: 'DR-2026-001',
      recoverySetId: 'recovery-set-2026-001',
      sourceCaptureReportSha256: hash('f'),
      databaseIdentitySha256: hash('a'),
      objectStoreIdentitySha256: hash('b'),
      databaseDumpSha256: hash('9'),
      objectBackupManifestSha256: hash('0'),
      productionDocumentCount: 2,
      storageDeletionCount: 1,
      pendingStorageDeletionCount: 0,
      deadLetterStorageDeletionCount: 0,
      processedStorageDeletionCount: 1,
      recoveryEventCount: 1,
      maximumDocumentProofAgeMinutes: 120,
      sourceMetadataCapturedAt: '2026-07-11T09:30:00.000Z',
      restoredMetadataCapturedAt: '2026-07-11T10:35:00.000Z',
      sourceObjectInventoryCapturedAt: '2026-07-11T09:32:00.000Z',
      restoredObjectInventoryCapturedAt: '2026-07-11T10:40:00.000Z',
      sourceMetadataCaptureTransactionId: '2001',
      restoredMetadataCaptureTransactionId: '3001',
      metadataInventorySha256: hash('1'),
      restoredMetadataInventorySha256: hash('2'),
      objectInventorySha256: hash('3'),
      restoredObjectInventorySha256: hash('4'),
      storageDeletionInventorySha256: hash('5'),
      restoredStorageDeletionInventorySha256: hash('6'),
      recoveryEventInventorySha256: hash('7'),
      restoredRecoveryEventInventorySha256: hash('8'),
    }),
    '2f650a2a6ba9c37b44c9992f5215574664a439aa6251fb0f37d3fa845ea4bd1d',
  );
});

test('pure validator proves independently inventoried metadata and document bytes', () => {
  const validation = validateDocumentRecoveryManifest(validManifest(), { now: NOW });

  assert.equal(validation.ok, true, validation.issues.join('\n'));
  assert.equal(validation.summary.expectedMetadataRows, 2);
  assert.equal(validation.summary.expectedObjectCount, 2);
  assert.equal(validation.summary.orphanExpectedObjectCount, 0);
  assert.notEqual(validation.bindings.expectedMetadataInventorySha256, validation.bindings.restoredMetadataInventorySha256);
  assert.notEqual(validation.bindings.expectedObjectInventorySha256, validation.bindings.restoredObjectInventorySha256);
  assert.equal(validation.summary.expectedStorageDeletionRows, 1);
  assert.equal(validation.summary.sourcePendingStorageDeletionCount, 0);
  assert.equal(validation.documentProof.fresh, true);
  assert.match(validation.reconciliationReportSha256, /^[a-f0-9]{64}$/);
  assert.equal(validation.objectiveResults.database.achievedRtoMinutes, 30);
  assert.equal(validation.objectiveResults.documentBytes.achievedRtoMinutes, 40);
});

test('CLI requires every independent source binding and emits a redacted canonical report', () => {
  const manifest = validManifest();
  const { result, payload } = runJson(manifest);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.ok, true);
  assert.equal(payload.manifestFormat, 'charitypilot-document-recovery-manifest-v1');
  assert.equal(payload.exerciseId, 'DR-2026-001');
  assert.match(payload.recoveryManifestSha256, /^[a-f0-9]{64}$/);
  assert.match(payload.reconciliationReportSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(payload.reconciliationReportSha256, payload.recoveryManifestSha256);
  assert.notEqual(payload.sourceMetadataInventorySha256, payload.restoredMetadataInventorySha256);
  assert.notEqual(payload.sourceObjectInventorySha256, payload.restoredObjectInventorySha256);
  assert.equal(payload.sourceCaptureReportSha256, manifest.source.sourceCaptureReportSha256);
  assert.equal(payload.recoveryOperatorRecorded, true);
  assert.equal(payload.reconciledByRecorded, undefined);
  assert.equal(payload.independentBindingArgumentsMatched, true);
  assert.equal(payload.sourceProvenanceExternallyVerified, false);
  assert.equal(Object.hasOwn(payload, 'sourceProvenanceExternallyBound'), false);
  assert.equal(Object.hasOwn(payload, 'isolationVerified'), false);
  assert.equal(Object.hasOwn(payload, 'productionDatabaseOverwritten'), false);
  assert.equal(Object.hasOwn(payload, 'productionObjectStoreOverwritten'), false);
  assert.equal(payload.isolationAttestationRecorded, true);
  assert.equal(payload.productionDatabaseNotOverwrittenAttestationRecorded, true);
  assert.equal(payload.productionObjectStoreNotOverwrittenAttestationRecorded, true);
  assert.equal(payload.restoreCredentialsScopedToTargetAttestationRecorded, true);
  assert.match(payload.provenanceLimitation, /does not authenticate/);
  assert.equal(payload.pendingStorageDeletionCount, 0);
  assert.equal(payload.deadLetterStorageDeletionCount, 0);
  assert.equal(payload.restoredStorageDeletionCount, 1);
  assert.equal(payload.restoredPendingStorageDeletionCount, 0);
  assert.equal(payload.restoredDeadLetterStorageDeletionCount, 0);
  assert.equal(payload.restoredProcessedStorageDeletionCount, 1);
  assert.equal(payload.recoveryEventCount, 1);
  assert.equal(payload.restoredRecoveryEventCount, 1);
  assert.equal(payload.sourceRecoveryEventInventorySha256, manifest.source.recoveryEventInventorySha256);
  assert.equal(
    payload.restoredRecoveryEventInventorySha256,
    manifest.reconciliation.storageDeletionRecoveryInventory.restoredInventorySha256,
  );
  assert.equal(payload.sourceMetadataCaptureTransactionId, '2001');
  assert.equal(payload.restoredMetadataCaptureTransactionId, '3001');
  assert.equal(payload.documentProofFresh, true);
  assert.equal(payload.metadataRowCount, 2);
  assert.equal(payload.matchedObjectCount, 2);
  assert.equal(payload.secretValuesPrinted, false);
  assert.doesNotMatch(result.stdout, /Recovery Operations Owner|Isolated joint recovery|evidence\.charitypilot\.ie/);
  assert.doesNotMatch(result.stdout, new RegExp(hash('1')));
});

test('text success states consistency scope and the external source-provenance limitation exactly', () => {
  const manifest = validManifest();
  const raw = JSON.stringify(manifest, null, 2);
  withRawFile(raw, ({ manifestPath }) => {
    const result = runVerifyDocumentRecoveryFromArgs(
      ['--manifest-file', manifestPath, ...bindingArgs(manifest, raw)],
      { now: () => NOW },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /reconciliation consistency passed against independently supplied bindings/);
    assert.match(result.stdout, /argument equality does not authenticate source exports/);
    assert.match(result.stdout, /attestation was recorded and was internally consistent/);
    assert.match(result.stdout, /does not authenticate those attestations/);
    assert.doesNotMatch(result.stdout, /isolation verified|production was not overwritten by this verifier/i);
    assert.doesNotMatch(result.stdout, /^Document recovery verification passed\.$/m);
  });
});

test('recoveryOperatorRecorded is derived from the validated attestation operator', () => {
  const manifest = validManifest();
  let validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
  assert.equal(validation.recoveryOperatorRecorded, true);

  manifest.attestations.attestedBy = '';
  validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
  assert.equal(validation.ok, false);
  assert.equal(validation.recoveryOperatorRecorded, false);
  assert.match(validation.issues.join('\n'), /attestations\.attestedBy/);
});

test('a self-consistent subset cannot pass independent source bindings', () => {
  const original = validManifest();
  const originalRaw = JSON.stringify(original, null, 2);
  const subset = structuredClone(original);
  subset.reconciliation.metadataInventory.expected.pop();
  subset.reconciliation.metadataInventory.restored.pop();
  subset.reconciliation.objectInventory.expected.pop();
  subset.reconciliation.objectInventory.restored.pop();
  subset.reconciliation.reportedSummary = exactSummary(
    subset.reconciliation.metadataInventory.expected,
    subset.reconciliation.objectInventory.expected,
    subset.reconciliation.storageDeletionInventory.expected,
    subset.reconciliation.storageDeletionRecoveryInventory.expected,
  );
  refreshSourceBindings(subset);
  const { result, payload } = runJson(subset, { argsFrom: original, rawForBindings: originalRaw });

  assert.equal(result.status, 1);
  assert.match(payload.issues.join('\n'), /independently supplied recovery manifest SHA-256/);
  assert.match(payload.issues.join('\n'), /independently supplied source binding SHA-256/);
  assert.match(payload.issues.join('\n'), /independently supplied production Document count/);
  assert.doesNotMatch(result.stdout, new RegExp(original.source.sourceBindingSha256));
});

test('source capture report and source identity substitution cannot pass independent bindings', () => {
  const original = validManifest();
  const substituted = structuredClone(original);
  substituted.source.sourceCaptureReportSha256 = hash('1');
  substituted.source.databaseIdentitySha256 = hash('2');
  substituted.source.objectStoreIdentitySha256 = hash('3');
  refreshSourceBindings(substituted);
  const substitutedRaw = JSON.stringify(substituted, null, 2);
  const { result, payload } = runJson(substituted, {
    argsFrom: original,
    raw: substitutedRaw,
    rawForBindings: substitutedRaw,
  });

  assert.equal(result.status, 1);
  assert.match(payload.issues.join('\n'), /independently supplied source-capture report SHA-256/);
  assert.match(payload.issues.join('\n'), /independently supplied source database identity SHA-256/);
  assert.match(payload.issues.join('\n'), /independently supplied source object-store identity SHA-256/);
});

test('CLI rejects missing, duplicate, malformed, and weakening binding options as usage errors', () => {
  const missing = runVerifyDocumentRecoveryFromArgs(['--manifest-file', 'ignored.json']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--expected-recovery-manifest-sha256 is required/);

  const manifest = validManifest();
  const raw = JSON.stringify(manifest);
  const args = ['--manifest-file', 'ignored.json', ...bindingArgs(manifest, raw)];
  const duplicate = runVerifyDocumentRecoveryFromArgs([...args, '--expected-production-document-count', '2']);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /must be provided exactly once/);

  const unknownArgs = ['--manifest-file', 'super-secret-evidence.json', ...bindingArgs(manifest, raw), '--allow-production'];
  const unknown = runVerifyDocumentRecoveryFromArgs(unknownArgs);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option/);
  assert.doesNotMatch(unknown.stderr, /super-secret-evidence\.json/);
});

test('verifier CLI rejects duplicate boolean flags', () => {
  const duplicateJson = runVerifyDocumentRecoveryFromArgs(['--json', '--json']);
  assert.equal(duplicateJson.status, 2);
  assert.match(duplicateJson.stderr, /--json must be provided at most once/);

  const duplicateHelp = runVerifyDocumentRecoveryFromArgs(['--help', '-h']);
  assert.equal(duplicateHelp.status, 2);
  assert.match(duplicateHelp.stderr, /--help must be provided at most once/);
});

test('recovery-event count and source/restored inventory bindings are mandatory and independently matched', () => {
  const manifest = validManifest();
  const raw = JSON.stringify(manifest);
  withRawFile(raw, ({ manifestPath }) => {
    const base = bindingArgs(manifest, raw);
    for (const flag of [
      '--expected-recovery-event-inventory-sha256',
      '--expected-restored-recovery-event-inventory-sha256',
      '--expected-recovery-event-count',
    ]) {
      const index = base.indexOf(flag);
      const missing = [...base.slice(0, index), ...base.slice(index + 2)];
      const result = runVerifyDocumentRecoveryFromArgs(['--manifest-file', manifestPath, ...missing, '--json']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, new RegExp(`${flag} is required`));
    }

    for (const [flag, replacement, issue] of [
      ['--expected-recovery-event-inventory-sha256', hash('e'), /recovery-event inventory SHA-256/],
      ['--expected-restored-recovery-event-inventory-sha256', hash('e'), /restored recovery-event inventory SHA-256/],
      ['--expected-recovery-event-count', '0', /recovery-event count/],
    ]) {
      const changed = [...base];
      changed[changed.indexOf(flag) + 1] = replacement;
      const result = runVerifyDocumentRecoveryFromArgs(
        ['--manifest-file', manifestPath, ...changed, '--json'],
        { now: () => NOW },
      );
      assert.equal(result.status, 1);
      assert.match(JSON.parse(result.stdout).issues.join('\n'), issue);
    }
  });
});

test('canonical hash contract and source binding reject ambiguity or artifact substitution', () => {
  const manifest = validManifest();
  manifest.hashContract.canonicalEncoding = 'json-ish';
  manifest.source.databaseDumpSha256 = hash('f');
  const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });

  assert.equal(validation.ok, false);
  assert.match(validation.issues.join('\n'), /hashContract\.canonicalEncoding/);
  assert.match(validation.issues.join('\n'), /source\.sourceBindingSha256 must bind/);
});

test('separate inventories detect missing, unexpected, and orphan objects', () => {
  const missing = validManifest();
  missing.reconciliation.objectInventory.restored.pop();
  let validation = validateDocumentRecoveryManifest(missing, { now: NOW });
  assert.match(validation.issues.join('\n'), /missingObjectCount to be zero/);
  assert.equal(validation.summary.missingObjectCount, 1, 'one absent object key must be counted once across inventory and metadata checks');

  const unexpected = validManifest();
  unexpected.reconciliation.objectInventory.restored.push({ objectKeySha256: hash('f'), bytes: 1, sha256: hash('a') });
  validation = validateDocumentRecoveryManifest(unexpected, { now: NOW });
  assert.match(validation.issues.join('\n'), /unexpectedObjectCount to be zero/);

  const orphan = validManifest();
  orphan.reconciliation.objectInventory.expected.push({ objectKeySha256: hash('f'), bytes: 1, sha256: hash('a') });
  orphan.reconciliation.objectInventory.restored.push({ objectKeySha256: hash('f'), bytes: 1, sha256: hash('a') });
  validation = validateDocumentRecoveryManifest(orphan, { now: NOW });
  assert.match(validation.issues.join('\n'), /orphanExpectedObjectCount to be zero/);
  assert.match(validation.issues.join('\n'), /orphanRestoredObjectCount to be zero/);
});

test('metadata and object mismatches are independently detected', () => {
  for (const [mutate, issue] of [
    [(manifest) => { manifest.reconciliation.metadataInventory.restored[0].metadataBindingSha256 = hash('f'); }, /metadataMismatchCount/],
    [(manifest) => { manifest.reconciliation.metadataInventory.restored[0].objectKeySha256 = hash('f'); }, /objectKeyMismatchCount/],
    [(manifest) => { manifest.reconciliation.objectInventory.restored[0].bytes += 1; }, /sizeMismatchCount/],
    [(manifest) => { manifest.reconciliation.objectInventory.restored[0].sha256 = hash('f'); }, /checksumMismatchCount/],
  ]) {
    const manifest = validManifest();
    mutate(manifest);
    const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
    assert.equal(validation.ok, false);
    assert.match(validation.issues.join('\n'), issue);
  }
});

test('RTO is measured from simulated failure even when exercise work starts later', () => {
  const manifest = validManifest();
  manifest.exercise.startedAt = '2026-07-11T10:20:00.000Z';
  manifest.restore.database.verifiedAt = '2026-07-11T10:30:00.000Z';
  manifest.objectives.database.rtoMinutes = 20;
  const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });

  assert.equal(validation.objectiveResults.database.achievedRtoMinutes, 30);
  assert.match(validation.issues.join('\n'), /database recovery exceeded its RTO objective/);
});

test('database and object backups must share one recovery set and bounded recovery-point skew', () => {
  const manifest = validManifest();
  manifest.restore.documentBytes.recoverySetId = 'different-recovery-set';
  manifest.restore.documentBytes.recoveredThroughAt = '2026-07-11T09:10:00.000Z';
  const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });

  assert.equal(validation.ok, false);
  assert.match(validation.issues.join('\n'), /recoverySetId must match source/);
  assert.match(validation.issues.join('\n'), /recovery points exceed the declared maximum skew/);

  const unbounded = validManifest();
  unbounded.exercise.maximumRecoveryPointSkewMinutes = 61;
  assert.match(validateDocumentRecoveryManifest(unbounded, { now: NOW }).issues.join('\n'), /safe integer from 0 to 60/);
});

test('all four capture timestamps are hash-bound, chronologically constrained, and freshness bounded', () => {
  const replayedExercise = validManifest();
  replayedExercise.exercise.id = 'DR-2026-002';
  let validation = validateDocumentRecoveryManifest(replayedExercise, { now: NOW });
  assert.match(validation.issues.join('\n'), /source\.sourceBindingSha256 must bind all four capture times/);

  const unboundMutation = validManifest();
  unboundMutation.reconciliation.metadataInventory.sourceCapturedAt = '2026-07-11T09:31:00.000Z';
  validation = validateDocumentRecoveryManifest(unboundMutation, { now: NOW });
  assert.match(validation.issues.join('\n'), /sourceInventorySha256 must match|source\.metadataInventorySha256 must match/);
  assert.match(validation.issues.join('\n'), /source\.sourceBindingSha256 must bind all four capture times/);

  const skewed = validManifest();
  skewed.reconciliation.metadataInventory.sourceCapturedAt = '2026-07-11T09:00:00.000Z';
  skewed.reconciliation.storageDeletionInventory.sourceCapturedAt = '2026-07-11T09:00:00.000Z';
  refreshSourceBindings(skewed);
  validation = validateDocumentRecoveryManifest(skewed, { now: NOW });
  assert.match(validation.issues.join('\n'), /source metadata capturedAt exceeds the declared skew/);

  const premature = validManifest();
  premature.reconciliation.metadataInventory.restoredCapturedAt = '2026-07-11T10:29:59.999Z';
  premature.reconciliation.storageDeletionInventory.restoredCapturedAt = '2026-07-11T10:29:59.999Z';
  refreshSourceBindings(premature);
  validation = validateDocumentRecoveryManifest(premature, { now: NOW });
  assert.match(validation.issues.join('\n'), /restored metadata capturedAt must not be before database restore completion/);

  const stale = validManifest();
  validation = validateDocumentRecoveryManifest(stale, { now: new Date('2026-07-11T12:00:01.000Z') });
  assert.match(validation.issues.join('\n'), /exceeds exercise\.maximumDocumentProofAgeMinutes/);
  assert.equal(validation.documentProof.fresh, false);
});

test('database capture transaction IDs bind metadata, deletion, recovery, source digest, and CLI arguments', () => {
  const unboundMutation = validManifest();
  for (const inventory of ['metadataInventory', 'storageDeletionInventory', 'storageDeletionRecoveryInventory']) {
    unboundMutation.reconciliation[inventory].sourceCaptureTransactionId = '2002';
  }
  let validation = validateDocumentRecoveryManifest(unboundMutation, { now: NOW });
  assert.match(validation.issues.join('\n'), /sourceInventorySha256 must match|source\.sourceBindingSha256 must bind/);

  const splitCapture = validManifest();
  splitCapture.reconciliation.storageDeletionRecoveryInventory.sourceCaptureTransactionId = '2002';
  validation = validateDocumentRecoveryManifest(splitCapture, { now: NOW });
  assert.match(validation.issues.join('\n'), /must equal the source metadata capture transaction/);

  const manifest = validManifest();
  const raw = JSON.stringify(manifest);
  const args = bindingArgs(manifest, raw);
  const index = args.indexOf('--expected-source-metadata-capture-transaction-id');
  args[index + 1] = '2002';
  const result = withRawFile(raw, ({ manifestPath }) => runVerifyDocumentRecoveryFromArgs(
    ['--manifest-file', manifestPath, ...args, '--json'],
    { now: () => NOW },
  ));
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).issues.join('\n'), /independently supplied source metadata capture transaction/);
});

test('storage-deletion lifecycle inventories require zero outstanding work and exact processed history parity', () => {
  for (const state of ['PENDING', 'DEAD_LETTER']) {
    const outstanding = validManifest();
    for (const inventory of ['expected', 'restored']) {
      outstanding.reconciliation.storageDeletionInventory[inventory][0].state = state;
    }
    outstanding.reconciliation.reportedSummary = exactSummary(
      outstanding.reconciliation.metadataInventory.expected,
      outstanding.reconciliation.objectInventory.expected,
      outstanding.reconciliation.storageDeletionInventory.expected,
      outstanding.reconciliation.storageDeletionRecoveryInventory.expected,
    );
    refreshSourceBindings(outstanding);
    const validation = validateDocumentRecoveryManifest(outstanding, { now: NOW });
    assert.match(validation.issues.join('\n'), new RegExp(`source${state === 'PENDING' ? 'Pending' : 'DeadLetter'}StorageDeletionCount to be zero`));
  }

  const mismatchedProcessedHistory = validManifest();
  mismatchedProcessedHistory.reconciliation.storageDeletionInventory.restored[0].lifecycleBindingSha256 = hash('b');
  refreshSourceBindings(mismatchedProcessedHistory);
  const mismatchValidation = validateDocumentRecoveryManifest(mismatchedProcessedHistory, { now: NOW });
  assert.match(mismatchValidation.issues.join('\n'), /storageDeletionMismatchCount to be zero/);
  assert.match(mismatchValidation.issues.join('\n'), /lifecycle inventories must match exactly/);
});

test('recovery-event inventories independently enforce bindings, invariants, and source/restore parity', async (t) => {
  const mutateBoth = (manifest, mutateDeletion, mutateRecovery) => {
    for (const inventory of ['expected', 'restored']) {
      if (mutateDeletion) mutateDeletion(manifest.reconciliation.storageDeletionInventory[inventory][0]);
      if (mutateRecovery) mutateRecovery(manifest.reconciliation.storageDeletionRecoveryInventory[inventory][0]);
    }
    refreshCompleteReconciliation(manifest);
    return validateDocumentRecoveryManifest(manifest, { now: NOW });
  };

  await t.test('all-or-none last-recovery fields', () => {
    const manifest = validManifest();
    const validation = mutateBoth(manifest, (deletion) => { deletion.lastRecoveryNonceSha256 = null; });
    assert.match(validation.issues.join('\n'), /all-or-none last-recovery binding/);
  });

  await t.test('duplicate recovery identity and nonce inventories', () => {
    const manifest = validManifest();
    for (const inventory of ['expected', 'restored']) {
      manifest.reconciliation.storageDeletionRecoveryInventory[inventory].push({
        ...structuredClone(manifest.reconciliation.storageDeletionRecoveryInventory[inventory][0]),
        recoveryIdentitySha256: hash('e'),
      });
    }
    refreshCompleteReconciliation(manifest);
    const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
    assert.match(validation.issues.join('\n'), /duplicate recovery-event nonces/);
  });

  await t.test('last binding must identify the unique latest recovery transaction', () => {
    const manifest = validManifest();
    for (const inventory of ['expected', 'restored']) {
      manifest.reconciliation.storageDeletionRecoveryInventory[inventory].push({
        ...structuredClone(manifest.reconciliation.storageDeletionRecoveryInventory[inventory][0]),
        recoveryIdentitySha256: hash('e'),
        recoveryNonceSha256: hash('f'),
        recoveryBindingSha256: hash('0'),
        transactionId: '1002',
        createdAt: '2026-07-11T09:24:30.000Z',
      });
    }
    refreshCompleteReconciliation(manifest);
    const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
    assert.match(validation.issues.join('\n'), /last-recovery binding is not its latest recovery transaction/);
  });

  await t.test('source recovery transactions must predate the source capture transaction', () => {
    const manifest = validManifest();
    const validation = mutateBoth(manifest, null, (recovery) => { recovery.transactionId = '2001'; });
    assert.match(validation.issues.join('\n'), /does not predate its source capture transaction/);
  });

  await t.test('recovery lifecycle timestamps cannot postdate their metadata capture', () => {
    const manifest = validManifest();
    const validation = mutateBoth(
      manifest,
      (deletion) => { deletion.lastRecoveredAt = '2026-07-11T09:46:00.000Z'; },
      (recovery) => { recovery.createdAt = '2026-07-11T09:45:00.000Z'; },
    );
    assert.match(validation.issues.join('\n'), /recovery event created after its metadata capture/);
    assert.match(validation.issues.join('\n'), /deletion recovered after its metadata capture/);
  });

  await t.test('event histories require a deletion last-recovery binding', () => {
    const manifest = validManifest();
    const validation = mutateBoth(manifest, (deletion) => {
      deletion.lastRecoveryIdentitySha256 = null;
      deletion.lastRecoveryNonceSha256 = null;
      deletion.lastRecoveryDisposition = null;
      deletion.lastRecoveredAt = null;
    });
    assert.match(validation.issues.join('\n'), /recovery events without the deletion's exact last-recovery binding/);
  });

  await t.test('exact event identity, nonce, deletion, and disposition linkage', () => {
    const manifest = validManifest();
    const validation = mutateBoth(manifest, (deletion) => { deletion.lastRecoveryNonceSha256 = hash('e'); });
    assert.match(validation.issues.join('\n'), /last-recovery binding does not match its exact recovery event/);
  });

  await t.test('recovery events cannot reference an absent deletion', () => {
    const manifest = validManifest();
    const validation = mutateBoth(manifest, null, (recovery) => { recovery.deletionIdentitySha256 = hash('e'); });
    assert.match(validation.issues.join('\n'), /recovery event whose deletion identity is absent/);
  });

  await t.test('tenant actors may only requeue unchanged', () => {
    const manifest = validManifest();
    const validation = mutateBoth(manifest, null, (recovery) => { recovery.actorType = 'TENANT_USER'; });
    assert.match(validation.issues.join('\n'), /tenant-user recovery may only requeue an unchanged path/);
  });

  await t.test('corrected-path disposition must bind the deletion to its distinct corrected key', () => {
    const manifest = validManifest();
    const validation = mutateBoth(
      manifest,
      (deletion) => { deletion.lastRecoveryDisposition = 'REQUEUE_CORRECTED_PATH'; },
      (recovery) => {
        recovery.disposition = 'REQUEUE_CORRECTED_PATH';
        recovery.correctedObjectKeySha256 = hash('e');
      },
    );
    assert.match(validation.issues.join('\n'), /corrected-path recovery does not match the deletion object-key identity/);
  });

  await t.test('permanently rejected paths cannot be requeued unchanged', () => {
    const manifest = validManifest();
    const validation = mutateBoth(
      manifest,
      (deletion) => { deletion.lastRecoveryDisposition = 'REQUEUE_UNCHANGED'; },
      (recovery) => {
        recovery.disposition = 'REQUEUE_UNCHANGED';
        recovery.previousTerminalReason = 'PERMANENT_STORAGE_PATH_REJECTED';
      },
    );
    assert.match(validation.issues.join('\n'), /cannot requeue a permanently rejected path unchanged/);
  });

  await t.test('lastRecoveredAt cannot predate the linked event', () => {
    const manifest = validManifest();
    const validation = mutateBoth(manifest, (deletion) => {
      deletion.lastRecoveredAt = '2026-07-11T09:23:59.999Z';
    });
    assert.match(validation.issues.join('\n'), /deletion recovered before its linked event/);
  });

  await t.test('source and restored recovery histories must match exactly', () => {
    const manifest = validManifest();
    manifest.reconciliation.storageDeletionRecoveryInventory.restored.pop();
    refreshCompleteReconciliation(manifest);
    const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
    assert.match(validation.issues.join('\n'), /recoveryEventMismatchCount|Recovery inventories must match exactly/);
  });

  await t.test('source and restored last-recovery fields must match exactly', () => {
    const manifest = validManifest();
    manifest.reconciliation.storageDeletionInventory.restored[0].lastRecoveredAt = '2026-07-11T09:26:00.000Z';
    refreshCompleteReconciliation(manifest);
    const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
    assert.match(validation.issues.join('\n'), /storageDeletionMismatchCount to be zero/);
  });
});

test('complete-whole-bucket scope and processed-path residue cannot be filtered out of reconciliation', () => {
  const filteredClaim = validManifest();
  filteredClaim.reconciliation.objectInventory.inventoryScope = 'live-document-keys-only';
  assert.match(
    validateDocumentRecoveryManifest(filteredClaim, { now: NOW }).issues.join('\n'),
    /inventoryScope must be complete-whole-bucket/,
  );

  const residue = validManifest();
  const staleObject = { objectKeySha256: hash('f'), bytes: 1, sha256: hash('b') };
  residue.reconciliation.objectInventory.expected.push(staleObject);
  residue.reconciliation.objectInventory.restored.push(structuredClone(staleObject));
  residue.reconciliation.reportedSummary = exactSummary(
    residue.reconciliation.metadataInventory.expected,
    residue.reconciliation.objectInventory.expected,
    residue.reconciliation.storageDeletionInventory.expected,
    residue.reconciliation.storageDeletionRecoveryInventory.expected,
  );
  refreshSourceBindings(residue);
  const residueValidation = validateDocumentRecoveryManifest(residue, { now: NOW });
  assert.equal(residueValidation.summary.processedDeletionObjectResidueCount, 1);
  assert.match(residueValidation.issues.join('\n'), /processedDeletionObjectResidueCount to be zero/);
  assert.match(residueValidation.issues.join('\n'), /orphanExpectedObjectCount to be zero/);
});

test('zero-byte objects are supported with the exact empty-byte digest and each object is capped at 10 MiB', () => {
  const zero = validManifest();
  for (const inventory of ['expected', 'restored']) {
    zero.reconciliation.metadataInventory[inventory][0].fileSize = 0;
    zero.reconciliation.objectInventory[inventory][0].bytes = 0;
    zero.reconciliation.objectInventory[inventory][0].sha256 = EMPTY_SHA256;
  }
  zero.reconciliation.reportedSummary = exactSummary(
    zero.reconciliation.metadataInventory.expected,
    zero.reconciliation.objectInventory.expected,
    zero.reconciliation.storageDeletionInventory.expected,
    zero.reconciliation.storageDeletionRecoveryInventory.expected,
  );
  refreshSourceBindings(zero);
  assert.equal(validateDocumentRecoveryManifest(zero, { now: NOW }).ok, true);

  const maximum = validManifest();
  for (const inventory of ['expected', 'restored']) {
    maximum.reconciliation.metadataInventory[inventory][0].fileSize = 10 * 1024 * 1024;
    maximum.reconciliation.objectInventory[inventory][0].bytes = 10 * 1024 * 1024;
  }
  maximum.reconciliation.reportedSummary = exactSummary(
    maximum.reconciliation.metadataInventory.expected,
    maximum.reconciliation.objectInventory.expected,
    maximum.reconciliation.storageDeletionInventory.expected,
    maximum.reconciliation.storageDeletionRecoveryInventory.expected,
  );
  refreshSourceBindings(maximum);
  assert.equal(validateDocumentRecoveryManifest(maximum, { now: NOW }).ok, true);

  const oversized = structuredClone(maximum);
  oversized.reconciliation.metadataInventory.restored[0].fileSize += 1;
  oversized.reconciliation.objectInventory.restored[0].bytes += 1;
  assert.match(validateDocumentRecoveryManifest(oversized, { now: NOW }).issues.join('\n'), /safe integer from 0 to 10485760/);
});

test('the maximum inventory is representable inside the manifest byte limit and one extra entry is rejected', () => {
  const manifest = validManifest();
  const metadata = [];
  const objects = [];
  for (let index = 0; index < DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries; index += 1) {
    const id = `boundary-document-${index}`;
    const organisationId = `boundary-org-${index % 10}`;
    const fileUrl = `${organisationId}/boundary-${index}.csv`;
    const objectKeySha256 = canonicalObjectKeySha256(fileUrl);
    metadata.push({
      documentIdentitySha256: canonicalDocumentIdentitySha256(id),
      metadataBindingSha256: canonicalMetadataBindingSha256({
        id,
        organisationId,
        fileUrl,
        fileSize: 0,
        mimeType: 'text/csv',
      }),
      objectKeySha256,
      fileSize: 0,
    });
    objects.push({ objectKeySha256, bytes: 0, sha256: EMPTY_SHA256 });
  }
  manifest.reconciliation.metadataInventory = {
    ...manifest.reconciliation.metadataInventory,
    expected: metadata,
    restored: structuredClone(metadata),
  };
  manifest.reconciliation.objectInventory = {
    ...manifest.reconciliation.objectInventory,
    expected: objects,
    restored: structuredClone(objects),
  };
  manifest.reconciliation.reportedSummary = exactSummary(
    metadata,
    objects,
    manifest.reconciliation.storageDeletionInventory.expected,
    manifest.reconciliation.storageDeletionRecoveryInventory.expected,
  );
  refreshSourceBindings(manifest);
  const raw = JSON.stringify(manifest);

  assert.ok(Buffer.byteLength(raw) <= DOCUMENT_RECOVERY_LIMITS.maxManifestBytes);
  assert.equal(validateDocumentRecoveryManifest(manifest, { now: NOW, rawText: raw }).ok, true);

  const extraId = 'boundary-document-extra';
  const extraOrganisationId = 'boundary-org-extra';
  const extraFileUrl = `${extraOrganisationId}/boundary-extra.csv`;
  const extraObjectKey = canonicalObjectKeySha256(extraFileUrl);
  const extraMetadata = {
    documentIdentitySha256: canonicalDocumentIdentitySha256(extraId),
    metadataBindingSha256: canonicalMetadataBindingSha256({
      id: extraId,
      organisationId: extraOrganisationId,
      fileUrl: extraFileUrl,
      fileSize: 0,
      mimeType: 'text/csv',
    }),
    objectKeySha256: extraObjectKey,
    fileSize: 0,
  };
  const extraObject = { objectKeySha256: extraObjectKey, bytes: 0, sha256: EMPTY_SHA256 };
  manifest.reconciliation.metadataInventory.expected.push(extraMetadata);
  manifest.reconciliation.metadataInventory.restored.push(structuredClone(extraMetadata));
  manifest.reconciliation.objectInventory.expected.push(extraObject);
  manifest.reconciliation.objectInventory.restored.push(structuredClone(extraObject));
  manifest.reconciliation.reportedSummary = exactSummary(
    manifest.reconciliation.metadataInventory.expected,
    manifest.reconciliation.objectInventory.expected,
    manifest.reconciliation.storageDeletionInventory.expected,
    manifest.reconciliation.storageDeletionRecoveryInventory.expected,
  );
  refreshSourceBindings(manifest);
  assert.match(
    validateDocumentRecoveryManifest(manifest, { now: NOW }).issues.join('\n'),
    /exceeds the maximum supported inventory size|safe integer from 1 to 5000/,
  );
});

test('duplicate scanning is non-recursive, bounded, and fails closed for deep or malformed JSON', () => {
  const duplicateRaw = '{"a":1,"a":2}';
  assert.match(duplicateJsonKeyIssues(duplicateRaw).join('\n'), /duplicate object keys/);

  const deeplyNested = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
  assert.match(jsonStructureIssues(deeplyNested).join('\n'), /maximum JSON nesting depth/);
  assert.match(jsonStructureIssues('{"a":').join('\n'), /could not be scanned safely/);
});

test('CLI rejects deep JSON before JSON.parse without overflowing the stack', () => {
  const manifest = validManifest();
  const raw = `${'['.repeat(1000)}0${']'.repeat(1000)}`;
  const { result, payload } = runJson(manifest, { raw, rawForBindings: raw });
  assert.equal(result.status, 1);
  assert.match(payload.issues.join('\n'), /maximum JSON nesting depth/);
});

test('path containment rejects Windows cross-drive paths and Git checks must be conclusive 0/1 results', () => {
  assert.equal(isPathWithinRoot('C:\\repo\\evidence.json', 'C:\\repo'), true);
  assert.equal(isPathWithinRoot('D:\\evidence\\recovery.json', 'C:\\repo'), false);
  assert.equal(gitCommandResultIsConclusive({ status: 0, signal: null }), true);
  assert.equal(gitCommandResultIsConclusive({ status: 1, signal: null }), true);
  assert.equal(gitCommandResultIsConclusive({ status: 2, signal: null }), false);
  assert.equal(gitCommandResultIsConclusive({ status: 0, signal: 'SIGTERM' }), false);
  assert.equal(gitCommandResultIsConclusive({ status: 0, signal: null, error: new Error('git missing') }), false);
});

test('in-repository evidence must be ignored and untracked while external evidence is accepted', () => {
  const repo = 'C:\\repo';
  const inside = 'C:\\repo\\.charitypilot-launch-evidence\\recovery.json';
  assert.deepEqual(manifestStorageIssues(inside, {
    repoRoot: repo,
    gitPathStatus: () => ({ available: true, tracked: false, ignored: true }),
  }), []);
  assert.match(manifestStorageIssues(inside, {
    repoRoot: repo,
    gitPathStatus: () => ({ available: false, tracked: false, ignored: false }),
  }).join('\n'), /conclusive Git ignore and tracking checks/);
  assert.deepEqual(manifestStorageIssues('D:\\external\\recovery.json', {
    repoRoot: repo,
    gitPathStatus: () => ({ available: false }),
  }), []);
});

test('stable reader opens first, proves descriptor identity, applies policy, then performs a bounded read', () => {
  const events = [];
  let descriptorStatCalls = 0;
  let readCalls = 0;
  let closed = false;
  const result = readStableManifest('C:\\repo\\.charitypilot-launch-evidence\\recovery.json', {
    repoRoot: 'C:\\repo',
    pathLstat: () => {
      events.push('lstat');
      return fakeBigIntStats();
    },
    openFile: (_path, flags) => {
      events.push('open');
      assert.equal(flags, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      return 7;
    },
    closeFile: () => {
      events.push('close');
      closed = true;
    },
    descriptorStat: () => {
      events.push('fstat');
      descriptorStatCalls += 1;
      return fakeBigIntStats();
    },
    resolveRealPath: () => {
      events.push('realpath');
      return 'C:\\repo\\.charitypilot-launch-evidence\\recovery.json';
    },
    pathStat: () => {
      events.push('stat');
      return fakeBigIntStats();
    },
    gitPathStatus: () => {
      events.push('policy');
      return { available: true, tracked: false, ignored: true };
    },
    readDescriptor: (_descriptor, buffer, offset, length, position) => {
      events.push('read');
      assert.ok(length <= DOCUMENT_RECOVERY_LIMITS.maxManifestBytes + 1);
      readCalls += 1;
      if (position > 0) return 0;
      Buffer.from('{}').copy(buffer, offset);
      return 2;
    },
  });

  assert.deepEqual(result.issues, []);
  assert.equal(result.rawText, '{}');
  assert.equal(descriptorStatCalls, 2);
  assert.equal(readCalls, 2);
  assert.equal(closed, true);
  assert.ok(events.indexOf('lstat') < events.indexOf('open'));
  assert.ok(events.indexOf('open') < events.indexOf('policy'));
  assert.ok(events.indexOf('policy') < events.indexOf('read'));
});

test('stable reader fails closed on descriptor/path identity mismatch or path swap', () => {
  const mismatch = readStableManifest('C:\\repo\\.charitypilot-launch-evidence\\recovery.json', {
    repoRoot: 'C:\\repo',
    pathLstat: () => fakeBigIntStats({ ino: 2n }),
    openFile: () => 7,
    closeFile: () => {},
    descriptorStat: () => fakeBigIntStats({ ino: 2n }),
    resolveRealPath: () => 'C:\\repo\\.charitypilot-launch-evidence\\recovery.json',
    pathStat: () => fakeBigIntStats({ ino: 9n }),
    gitPathStatus: () => ({ available: true, tracked: false, ignored: true }),
    readDescriptor: () => 0,
  });
  assert.match(mismatch.issues.join('\n'), /descriptor does not match the resolved policy target/);

  let realpathCalls = 0;
  let readPosition = 0;
  const swapped = readStableManifest('C:\\repo\\.charitypilot-launch-evidence\\recovery.json', {
    repoRoot: 'C:\\repo',
    pathLstat: () => fakeBigIntStats(),
    openFile: () => 7,
    closeFile: () => {},
    descriptorStat: () => fakeBigIntStats(),
    resolveRealPath: () => {
      realpathCalls += 1;
      return realpathCalls === 1
        ? 'C:\\repo\\.charitypilot-launch-evidence\\recovery.json'
        : 'C:\\repo\\.charitypilot-launch-evidence\\replacement.json';
    },
    pathStat: () => fakeBigIntStats(),
    gitPathStatus: () => ({ available: true, tracked: false, ignored: true }),
    readDescriptor: (_descriptor, buffer, offset, _length, position) => {
      if (position > 0) return 0;
      readPosition += 1;
      Buffer.from('{}').copy(buffer, offset);
      return 2;
    },
  });
  assert.equal(readPosition, 1);
  assert.match(swapped.issues.join('\n'), /path or descriptor identity changed/);
});

test('stable reader caps concurrent growth at MAX_MANIFEST_BYTES plus one before rejection', () => {
  let requestedLength = 0;
  const maximum = BigInt(DOCUMENT_RECOVERY_LIMITS.maxManifestBytes);
  const result = readStableManifest('D:\\external\\recovery.json', {
    repoRoot: 'C:\\repo',
    pathLstat: () => fakeBigIntStats({ size: maximum }),
    openFile: () => 7,
    closeFile: () => {},
    descriptorStat: () => fakeBigIntStats({ size: maximum }),
    resolveRealPath: () => 'D:\\external\\recovery.json',
    pathStat: () => fakeBigIntStats({ size: maximum }),
    gitPathStatus: () => {
      throw new Error('external paths must not call Git');
    },
    readDescriptor: (_descriptor, _buffer, _offset, length) => {
      requestedLength = length;
      return length;
    },
  });

  assert.equal(requestedLength, DOCUMENT_RECOVERY_LIMITS.maxManifestBytes + 1);
  assert.match(result.issues.join('\n'), /exceeds the maximum supported size/);
});

test('stable reader detects same-inode same-size timestamp mutation and hash-binds accepted bytes', () => {
  let descriptorStatCalls = 0;
  let pathStatCalls = 0;
  let pathLstatCalls = 0;
  const result = readStableManifest('D:\\external\\recovery.json', {
    repoRoot: 'C:\\repo',
    pathLstat: () => {
      pathLstatCalls += 1;
      return fakeBigIntStats({ ctimeNs: pathLstatCalls === 1 ? 4n : 5n });
    },
    openFile: () => 7,
    closeFile: () => {},
    descriptorStat: () => {
      descriptorStatCalls += 1;
      return fakeBigIntStats({ ctimeNs: descriptorStatCalls === 1 ? 4n : 5n });
    },
    resolveRealPath: () => 'D:\\external\\recovery.json',
    pathStat: () => {
      pathStatCalls += 1;
      return fakeBigIntStats({ ctimeNs: pathStatCalls === 1 ? 4n : 5n });
    },
    readDescriptor: (_descriptor, buffer, offset, _length, position) => {
      if (position > 0) return 0;
      Buffer.from('{}').copy(buffer, offset);
      return 2;
    },
  });
  assert.match(result.issues.join('\n'), /path or descriptor identity changed during validation/);

  const stable = readStableManifest('D:\\external\\recovery.json', {
    repoRoot: 'C:\\repo',
    pathLstat: () => fakeBigIntStats(),
    openFile: () => 7,
    closeFile: () => {},
    descriptorStat: () => fakeBigIntStats(),
    resolveRealPath: () => 'D:\\external\\recovery.json',
    pathStat: () => fakeBigIntStats(),
    readDescriptor: (_descriptor, buffer, offset, _length, position) => {
      if (position > 0) return 0;
      Buffer.from('{}').copy(buffer, offset);
      return 2;
    },
  });
  assert.deepEqual(stable.issues, []);
  assert.equal(stable.sha256, rawSha256('{}'));
  assert.equal(stable.stableFacts.ctimeNs, 4n);
});

test('stable reader rejects symbolic-link paths and unsafe POSIX owner or mode facts before reading bytes', () => {
  let opened = false;
  const symbolic = readStableManifest('/external/recovery.json', {
    platform: 'linux',
    currentUid: 1000,
    pathLstat: () => fakeBigIntStats({ symbolicLink: true }),
    openFile: () => {
      opened = true;
      return 7;
    },
  });
  assert.equal(opened, false);
  assert.match(symbolic.issues.join('\n'), /regular non-symbolic-link file/);

  for (const [facts, issue] of [
    [fakeBigIntStats({ mode: 0o100644n, uid: 1000n }), /owner-only mode 0600/],
    [fakeBigIntStats({ mode: 0o100600n, uid: 1001n }), /owned by the current POSIX user/],
  ]) {
    const unsafe = readStableManifest('/external/recovery.json', {
      platform: 'linux',
      currentUid: 1000,
      pathLstat: () => facts,
      openFile: () => 7,
      closeFile: () => {},
      descriptorStat: () => facts,
    });
    assert.match(unsafe.issues.join('\n'), issue);
  }
});

test('manifest bytes use fatal UTF-8 decoding and failures never echo the path', () => {
  const manifest = validManifest();
  const invalidBytes = Buffer.from([0xff, 0xfe, 0xfd]);
  withRawFile(invalidBytes, ({ manifestPath }) => {
    const result = runVerifyDocumentRecoveryFromArgs(
      ['--manifest-file', manifestPath, ...bindingArgs(manifest, invalidBytes)],
      { now: () => NOW },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid UTF-8 encoding/);
    assert.doesNotMatch(result.stderr, new RegExp(manifestPath.replaceAll('\\', '\\\\')));
  });
});

test('immutable evidence references require digest-bound paths or commit-bound canonical GitHub URLs', () => {
  const manifest = validManifest();
  manifest.exercise.evidenceReference = 'https://evidence.charitypilot.ie/recovery/latest';
  manifest.source.recoverySetReference = `https://github.com/jasperfordesq-ai/charity-governance/blob/${'a'.repeat(39)}z/docs/recovery.md`;
  manifest.reconciliation.reportReference = `https://evidence.charitypilot.ie/report/${hash('e')}?token=secret`;
  manifest.restore.database.backupReference = evidenceReference('wrong-database-backup', hash('e'));
  manifest.restore.documentBytes.backupReference = evidenceReference('wrong-object-backup', hash('e'));
  const { result, payload } = runJson(manifest);

  assert.equal(result.status, 1);
  assert.match(payload.issues.join('\n'), /digest-bound or use a commit-bound/);
  assert.match(payload.issues.join('\n'), /query parameters or fragments|secret-looking material/);
  assert.match(payload.issues.join('\n'), /restore\.database\.backupReference must contain the exact databaseDumpSha256/);
  assert.match(payload.issues.join('\n'), /restore\.documentBytes\.backupReference must contain the exact objectBackupManifestSha256/);
  assert.match(payload.issues.join('\n'), /reconciliation\.reportReference must contain the exact reconciliationReportSha256/);
  assert.doesNotMatch(result.stdout, /latest|token=secret|github\.com/);

  const github = validManifest();
  github.exercise.evidenceReference = `https://github.com/jasperfordesq-ai/charity-governance/blob/${'a'.repeat(40)}/docs/recovery.md`;
  assert.equal(validateDocumentRecoveryManifest(github, { now: NOW }).ok, true);
});

test('PEM, AWS, provider, database, and signed URL secrets are rejected and redacted', () => {
  const awsSecretAccessKey = [
    'AbCdEfGhIjKlMnOpQrStUvWxYz',
    '0123456789ABCD',
  ].join('');
  const awsAccessKeyId = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const awsEnvSecret = ['aws', 'secret', 'value'].join('-');
  const basicCredential = ['dXNlcjpwYXNz', 'd29yZA=='].join('');
  const databaseUrl = ['postgresql://operator:', 'password@db.charitypilot.ie/production'].join('');
  const manifest = validManifest();
  manifest.exercise.notes = [
    '-----BEGIN PRIVATE KEY-----',
    'private-material',
    '-----END PRIVATE KEY-----',
    `AWS_SECRET_ACCESS_KEY=${awsEnvSecret}`,
    `awsSecretAccessKey=${awsSecretAccessKey}`,
    `Authorization: Basic ${basicCredential}`,
    databaseUrl,
  ].join('\n');
  const { result, payload } = runJson(manifest);
  assert.equal(result.status, 1);
  assert.match(payload.issues.join('\n'), /secret-looking material/);
  assert.doesNotMatch(result.stdout, /PRIVATE KEY|AbCdEfGhIjKlMnOpQrStUvWxYz|postgresql:\/\//);
  for (const secret of [awsEnvSecret, basicCredential, databaseUrl]) {
    assert.equal(result.stdout.includes(secret), false);
  }

  const redacted = redactDocumentRecoveryTranscript([
    '-----BEGIN PRIVATE KEY-----',
    'private-material',
    '-----END PRIVATE KEY-----',
    `AWS_SECRET_ACCESS_KEY=${awsEnvSecret}`,
    `awsSecretAccessKey=${awsSecretAccessKey}`,
    `Authorization: Basic ${basicCredential}`,
    awsAccessKeyId,
  ].join('\n'));
  assert.doesNotMatch(redacted, /private-material|AbCdEfGhIjKlMnOpQrStUvWxYz/);
  assert.equal(redacted.includes(awsAccessKeyId), false);
  assert.equal(redacted.includes(awsSecretAccessKey), false);
  assert.equal(redacted.includes(awsEnvSecret), false);
  assert.equal(redacted.includes(basicCredential), false);
});

test('raw and recursive secret scanning blocks generic, escaped-key, Slack, Supabase, and common-provider credentials', () => {
  const slackToken = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
  const supabaseToken = ['sb', 'secret', 'abcdefghijklmnopqrstuvwxyz'].join('_');
  const openAiToken = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  const basicCredential = ['dXNlcjpwYXNz', 'd29yZA=='].join('');
  const awsSecretAccessKey = [
    'AbCdEfGhIjKlMnOpQrStUvWxYz',
    '0123456789ABCD',
  ].join('');
  const rawCases = [
    '{"client_secret":"generic-client-secret-value"}',
    '{"client\\u005fsecret":"escaped-client-secret-value"}',
    '{"nested":{"credentials":{"password":"nested-password-value"}}}',
    JSON.stringify({ notes: slackToken }),
    JSON.stringify({ notes: supabaseToken }),
    JSON.stringify({ notes: openAiToken }),
    JSON.stringify({ notes: `Authorization: Basic ${basicCredential}` }),
    JSON.stringify({ notes: `awsSecretAccessKey=${awsSecretAccessKey}` }),
  ];
  for (const raw of rawCases) {
    const parsed = JSON.parse(raw);
    assert.match(documentRecoverySecretIssues(raw, parsed).join('\n'), /secret-looking material/);
    const redacted = redactDocumentRecoveryTranscript(raw);
    if (!raw.includes('\\u005f')) {
      assert.notEqual(redacted, raw);
      for (const value of Object.values(parsed).flatMap((entry) => typeof entry === 'string' ? [entry] : [])) {
        assert.doesNotMatch(redacted, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    }
  }

  const manifest = validManifest();
  manifest.exercise.notes = `Recovery operator supplied ${slackToken} during evidence preparation.`;
  const { result, payload } = runJson(manifest);
  assert.equal(result.status, 1);
  assert.match(payload.issues.join('\n'), /secret-looking material/);
  assert.doesNotMatch(result.stdout, new RegExp(slackToken));
  assert.doesNotMatch(result.stderr, new RegExp(slackToken));
});

test('production targets, source identity reuse, and overwrite attestations remain forbidden', () => {
  const manifest = validManifest();
  manifest.target.environment = 'production';
  manifest.target.databaseIdentitySha256 = manifest.source.databaseIdentitySha256;
  manifest.attestations.productionDatabaseOverwritten = true;
  manifest.attestations.productionObjectStoreOverwritten = true;
  manifest.attestations.restoreCredentialsScopedToTarget = false;
  const validation = validateDocumentRecoveryManifest(manifest, { now: NOW });
  assert.match(validation.issues.join('\n'), /target\.environment must be non-production/);
  assert.match(validation.issues.join('\n'), /identity must differ/);
  assert.match(validation.issues.join('\n'), /productionDatabaseOverwritten must be false/);
  assert.match(validation.issues.join('\n'), /restoreCredentialsScopedToTarget must be true/);
});
