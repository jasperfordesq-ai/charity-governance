#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultRepoRoot = resolve(scriptsDir, '..');
const MANIFEST_KIND = 'charitypilot-document-recovery-manifest';
const MANIFEST_FORMAT = 'charitypilot-document-recovery-manifest-v1';
const TARGET_TYPE = 'isolated-non-production';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_INVENTORY_ENTRIES = 5_000;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = MAX_INVENTORY_ENTRIES * MAX_DOCUMENT_BYTES;
const MAX_JSON_NESTING = 64;
const MAX_SECRET_SCAN_NODES = 1_000_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_OBJECTIVE_MINUTES = 365 * 24 * 60;
const MAX_RECOVERY_POINT_SKEW_MINUTES = 60;
const MAX_DOCUMENT_PROOF_AGE_MINUTES = 24 * 60;
const MAX_RETENTION_DAYS = 3650;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const APPROVED_REFERENCE_HOSTS = ['charitypilot.ie', 'github.com'];
const PLACEHOLDER_PATTERN = /\b(?:todo|tbd|pending|placeholder|replace[_-]?me|change[_-]?me|example(?:\.com|\.org|\.net)?|localhost)\b|your[_-]/i;
const ACKNOWLEDGEMENT = 'This recovery exercise used isolated non-production database and object-storage targets; production was not overwritten.';
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export const DOCUMENT_RECOVERY_HASH_CONTRACT = Object.freeze({
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

export const DOCUMENT_RECOVERY_LIMITS = Object.freeze({
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxInventoryEntries: MAX_INVENTORY_ENTRIES,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxAggregateBytes: MAX_AGGREGATE_BYTES,
});

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /postgres(?:ql)?:\/\/[^\s"']+@/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/i,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]{8,}/,
  /\bsk-(?:proj-|svcacct-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}/i,
  /\bwhsec_[A-Za-z0-9_=-]{8,}/,
  /\bre_[A-Za-z0-9_=-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{12,}/,
  /\bnpm_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/i,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/i,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/i,
  /\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bAIza[A-Za-z0-9_-]{20,}/,
  /\bSK[a-f0-9]{32}\b/i,
  /\bshpat_[A-Za-z0-9]{20,}/i,
  /\bkey-[A-Za-z0-9]{20,}/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DATABASE_URL|JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|RESEND_API_KEY|PASSWORD)\b\s*[=:]/i,
  /\bAWS[_-]?SECRET[_-]?ACCESS[_-]?KEY\s*[=:]\s*["']?[^\s,"'}\]]{8,}/i,
  /[?&](?:access[_-]?token|api[_-]?key|credential|jwt|key|password|refresh[_-]?token|secret|signature|sig|token|x-amz-credential|x-amz-signature)=/i,
  /\b(?:client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|credential|private[_-]?key|password|refresh[_-]?token|secret|secret[_-]?key|service[_-]?role[_-]?key|signing[_-]?secret|token)\b["']?\s*[=:]\s*(?!null\b|true\b|false\b|"?REPLACE_)["']?[^\s,"'}]{4,}/i,
  /\bAccountKey=[A-Za-z0-9+/=]{16,}/i,
];
const CREDENTIAL_VALUE_PATTERNS = SECRET_PATTERNS.filter((pattern) => !pattern.source.includes('client'));
const SENSITIVE_KEY_PATTERN = /(?:clientsecret|apikey|accesstoken|authtoken|credential|credentials|privatekey|password|refreshtoken|secret|secretkey|servicerolekey|signingsecret|token|webhooksecret)$/;

const TOP_LEVEL_KEYS = new Set([
  'kind',
  'schemaVersion',
  'hashContract',
  'exercise',
  'source',
  'target',
  'backupControls',
  'objectives',
  'restore',
  'reconciliation',
  'attestations',
]);
const HASH_CONTRACT_KEYS = new Set(Object.keys(DOCUMENT_RECOVERY_HASH_CONTRACT));
const EXERCISE_KEYS = new Set([
  'id',
  'owner',
  'startedAt',
  'simulatedFailureAt',
  'completedAt',
  'maximumRecoveryPointSkewMinutes',
  'maximumDocumentProofAgeMinutes',
  'notes',
  'evidenceReference',
]);
const SOURCE_KEYS = new Set([
  'environment',
  'recoverySetId',
  'databaseIdentitySha256',
  'objectStoreIdentitySha256',
  'databaseDumpSha256',
  'objectBackupManifestSha256',
  'sourceCaptureReportSha256',
  'sourceCaptureReference',
  'productionDocumentCount',
  'metadataInventorySha256',
  'objectInventorySha256',
  'storageDeletionCount',
  'pendingStorageDeletionCount',
  'deadLetterStorageDeletionCount',
  'processedStorageDeletionCount',
  'storageDeletionInventorySha256',
  'recoveryEventCount',
  'recoveryEventInventorySha256',
  'sourceBindingSha256',
  'recoverySetReference',
]);
const TARGET_KEYS = new Set([
  'environment',
  'restoreTargetType',
  'isolated',
  'databaseIdentitySha256',
  'objectStoreIdentitySha256',
  'isolationEvidenceReference',
]);
const LAYER_KEYS = new Set(['database', 'documentBytes']);
const CONTROL_KEYS = new Set([
  'encrypted',
  'versioned',
  'owner',
  'retentionDays',
  'backupPolicyReference',
  'retentionPolicyReference',
  'monitoringReference',
  'deletionPolicyReference',
]);
const OBJECTIVE_KEYS = new Set(['rpoMinutes', 'rtoMinutes', 'policyReference']);
const RESTORE_KEYS = new Set(['completed', 'recoverySetId', 'backupReference', 'recoveredThroughAt', 'verifiedAt']);
const RECONCILIATION_KEYS = new Set([
  'checksumAlgorithm',
  'reportedSummary',
  'metadataInventory',
  'objectInventory',
  'storageDeletionInventory',
  'storageDeletionRecoveryInventory',
  'reportReference',
]);
const INVENTORY_KEYS = new Set([
  'inventoryScope',
  'sourceCapturedAt',
  'restoredCapturedAt',
  'sourceInventorySha256',
  'restoredInventorySha256',
  'expected',
  'restored',
]);
const DATABASE_INVENTORY_KEYS = new Set([
  ...INVENTORY_KEYS,
  'sourceCaptureTransactionId',
  'restoredCaptureTransactionId',
]);
const METADATA_ENTRY_KEYS = new Set([
  'documentIdentitySha256',
  'metadataBindingSha256',
  'objectKeySha256',
  'fileSize',
]);
const OBJECT_ENTRY_KEYS = new Set(['objectKeySha256', 'bytes', 'sha256']);
const STORAGE_DELETION_ENTRY_KEYS = new Set([
  'deletionIdentitySha256',
  'lifecycleBindingSha256',
  'objectKeySha256',
  'state',
  'lastRecoveryIdentitySha256',
  'lastRecoveryNonceSha256',
  'lastRecoveryDisposition',
  'lastRecoveredAt',
]);
const STORAGE_DELETION_RECOVERY_ENTRY_KEYS = new Set([
  'recoveryIdentitySha256',
  'recoveryNonceSha256',
  'recoveryBindingSha256',
  'transactionId',
  'deletionIdentitySha256',
  'actorType',
  'disposition',
  'previousTerminalReason',
  'previousObjectKeySha256',
  'correctedObjectKeySha256',
  'createdAt',
]);
const ATTESTATION_KEYS = new Set([
  'productionDatabaseOverwritten',
  'productionObjectStoreOverwritten',
  'restoreCredentialsScopedToTarget',
  'attestedBy',
  'attestedAt',
  'productionProtectionEvidenceReference',
  'acknowledgement',
]);
const SUMMARY_KEYS = [
  'expectedMetadataRows',
  'restoredMetadataRows',
  'matchedMetadataRows',
  'expectedObjectCount',
  'restoredObjectCount',
  'matchedObjectCount',
  'missingMetadataRows',
  'unexpectedMetadataRows',
  'missingObjectCount',
  'unexpectedObjectCount',
  'metadataMismatchCount',
  'objectKeyMismatchCount',
  'sizeMismatchCount',
  'checksumMismatchCount',
  'orphanExpectedObjectCount',
  'orphanRestoredObjectCount',
  'expectedBytes',
  'restoredBytes',
  'expectedStorageDeletionRows',
  'restoredStorageDeletionRows',
  'matchedStorageDeletionRows',
  'missingStorageDeletionRows',
  'unexpectedStorageDeletionRows',
  'storageDeletionMismatchCount',
  'sourcePendingStorageDeletionCount',
  'sourceDeadLetterStorageDeletionCount',
  'sourceProcessedStorageDeletionCount',
  'restoredPendingStorageDeletionCount',
  'restoredDeadLetterStorageDeletionCount',
  'restoredProcessedStorageDeletionCount',
  'processedDeletionObjectResidueCount',
  'expectedRecoveryEventRows',
  'restoredRecoveryEventRows',
  'matchedRecoveryEventRows',
  'missingRecoveryEventRows',
  'unexpectedRecoveryEventRows',
  'recoveryEventMismatchCount',
];
const SUMMARY_KEY_SET = new Set(SUMMARY_KEYS);

export const DOCUMENT_RECOVERY_REQUIRED_BINDING_FLAGS = Object.freeze([
  ['--expected-recovery-manifest-sha256', 'expectedRecoveryManifestSha256', 'sha256'],
  ['--expected-source-binding-sha256', 'expectedSourceBindingSha256', 'sha256'],
  ['--expected-database-dump-sha256', 'expectedDatabaseDumpSha256', 'sha256'],
  ['--expected-object-backup-manifest-sha256', 'expectedObjectBackupManifestSha256', 'sha256'],
  ['--expected-source-capture-report-sha256', 'expectedSourceCaptureReportSha256', 'sha256'],
  ['--expected-source-database-identity-sha256', 'expectedSourceDatabaseIdentitySha256', 'sha256'],
  ['--expected-source-object-store-identity-sha256', 'expectedSourceObjectStoreIdentitySha256', 'sha256'],
  ['--expected-metadata-inventory-sha256', 'expectedMetadataInventorySha256', 'sha256'],
  ['--expected-object-inventory-sha256', 'expectedObjectInventorySha256', 'sha256'],
  ['--expected-restored-metadata-inventory-sha256', 'expectedRestoredMetadataInventorySha256', 'sha256'],
  ['--expected-restored-object-inventory-sha256', 'expectedRestoredObjectInventorySha256', 'sha256'],
  ['--expected-storage-deletion-inventory-sha256', 'expectedStorageDeletionInventorySha256', 'sha256'],
  ['--expected-restored-storage-deletion-inventory-sha256', 'expectedRestoredStorageDeletionInventorySha256', 'sha256'],
  ['--expected-recovery-event-inventory-sha256', 'expectedRecoveryEventInventorySha256', 'sha256'],
  ['--expected-restored-recovery-event-inventory-sha256', 'expectedRestoredRecoveryEventInventorySha256', 'sha256'],
  ['--expected-production-document-count', 'expectedProductionDocumentCount', 'count'],
  ['--expected-storage-deletion-count', 'expectedStorageDeletionCount', 'nonnegativeCount'],
  ['--expected-pending-storage-deletion-count', 'expectedPendingStorageDeletionCount', 'nonnegativeCount'],
  ['--expected-dead-letter-storage-deletion-count', 'expectedDeadLetterStorageDeletionCount', 'nonnegativeCount'],
  ['--expected-processed-storage-deletion-count', 'expectedProcessedStorageDeletionCount', 'nonnegativeCount'],
  ['--expected-recovery-event-count', 'expectedRecoveryEventCount', 'nonnegativeCount'],
  ['--expected-source-metadata-captured-at', 'expectedSourceMetadataCapturedAt', 'timestamp'],
  ['--expected-restored-metadata-captured-at', 'expectedRestoredMetadataCapturedAt', 'timestamp'],
  ['--expected-source-object-inventory-captured-at', 'expectedSourceObjectInventoryCapturedAt', 'timestamp'],
  ['--expected-restored-object-inventory-captured-at', 'expectedRestoredObjectInventoryCapturedAt', 'timestamp'],
  ['--expected-source-metadata-capture-transaction-id', 'expectedSourceMetadataCaptureTransactionId', 'transactionId'],
  ['--expected-restored-metadata-capture-transaction-id', 'expectedRestoredMetadataCaptureTransactionId', 'transactionId'],
  ['--expected-maximum-document-proof-age-minutes', 'expectedMaximumDocumentProofAgeMinutes', 'proofAge'],
  ['--expected-exercise-id', 'expectedExerciseId', 'id'],
  ['--expected-recovery-set-id', 'expectedRecoverySetId', 'id'],
]);
const REQUIRED_BINDING_FLAGS = DOCUMENT_RECOVERY_REQUIRED_BINDING_FLAGS;

function usage() {
  return [
    'Usage: node scripts/verify-document-recovery.mjs --manifest-file <external-or-ignored.json>',
    '  --expected-recovery-manifest-sha256 <sha256>',
    '  --expected-source-binding-sha256 <sha256>',
    '  --expected-database-dump-sha256 <sha256>',
    '  --expected-object-backup-manifest-sha256 <sha256>',
    '  --expected-source-capture-report-sha256 <sha256>',
    '  --expected-source-database-identity-sha256 <sha256>',
    '  --expected-source-object-store-identity-sha256 <sha256>',
    '  --expected-metadata-inventory-sha256 <sha256>',
    '  --expected-object-inventory-sha256 <sha256>',
    '  --expected-restored-metadata-inventory-sha256 <sha256>',
    '  --expected-restored-object-inventory-sha256 <sha256>',
    '  --expected-storage-deletion-inventory-sha256 <sha256>',
    '  --expected-restored-storage-deletion-inventory-sha256 <sha256>',
    '  --expected-recovery-event-inventory-sha256 <sha256>',
    '  --expected-restored-recovery-event-inventory-sha256 <sha256>',
    '  --expected-production-document-count <positive-integer>',
    '  --expected-storage-deletion-count <nonnegative-integer>',
    '  --expected-pending-storage-deletion-count <nonnegative-integer>',
    '  --expected-dead-letter-storage-deletion-count <nonnegative-integer>',
    '  --expected-processed-storage-deletion-count <nonnegative-integer>',
    '  --expected-recovery-event-count <nonnegative-integer>',
    '  --expected-source-metadata-captured-at <UTC-timestamp>',
    '  --expected-restored-metadata-captured-at <UTC-timestamp>',
    '  --expected-source-object-inventory-captured-at <UTC-timestamp>',
    '  --expected-restored-object-inventory-captured-at <UTC-timestamp>',
    '  --expected-source-metadata-capture-transaction-id <decimal-transaction-id>',
    '  --expected-restored-metadata-capture-transaction-id <decimal-transaction-id>',
    '  --expected-maximum-document-proof-age-minutes <positive-integer>',
    '  --expected-exercise-id <id>',
    '  --expected-recovery-set-id <id> [--json]',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(domain, rows) {
  return sha256(Buffer.from(`${domain}\n${JSON.stringify(rows)}`, 'utf8'));
}

function canonicalString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export function canonicalDocumentIdentitySha256(id) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.documentIdentityDomain, [[
    canonicalString(id, 'Document.id'),
  ]]);
}

export function canonicalMetadataBindingSha256({ id, organisationId, fileUrl, fileSize, mimeType }) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize > MAX_DOCUMENT_BYTES) {
    throw new TypeError('Document.fileSize must be a safe integer within the document byte limit');
  }
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.metadataBindingDomain, [[
    canonicalString(id, 'Document.id'),
    canonicalString(organisationId, 'Document.organisationId'),
    canonicalString(fileUrl, 'Document.fileUrl'),
    fileSize,
    canonicalString(mimeType, 'Document.mimeType'),
  ]]);
}

export function canonicalObjectKeySha256(fileUrl) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.objectKeyDomain, [[
    canonicalString(fileUrl, 'Document.fileUrl'),
  ]]);
}

export function canonicalDatabaseIdentitySha256({ provider, projectRef, databaseName, schemaName }) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.databaseIdentityDomain, [[
    canonicalString(provider, 'database provider'),
    canonicalString(projectRef, 'database projectRef'),
    canonicalString(databaseName, 'database name'),
    canonicalString(schemaName, 'database schema'),
  ]]);
}

export function canonicalObjectStoreIdentitySha256({ provider, projectRef, bucketName }) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.objectStoreIdentityDomain, [[
    canonicalString(provider, 'object-store provider'),
    canonicalString(projectRef, 'object-store projectRef'),
    canonicalString(bucketName, 'object-store bucket'),
  ]]);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be an ISO-8601 UTC timestamp with milliseconds`);
  }
  return value;
}

function canonicalTransactionId(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,18}$/.test(value) ||
    BigInt(value) > MAX_POSTGRES_BIGINT
  ) {
    throw new TypeError(`${label} must be a canonical bounded decimal transaction identifier`);
  }
  return value;
}

export function canonicalMetadataInventorySha256(entries, capturedAt, captureTransactionId) {
  const rows = entries
    .map((entry) => [
      entry.documentIdentitySha256,
      entry.metadataBindingSha256,
      entry.objectKeySha256,
      entry.fileSize,
    ])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.metadataInventoryDomain, [[
    canonicalTimestamp(capturedAt, 'metadata inventory capturedAt'),
    canonicalTransactionId(captureTransactionId, 'metadata inventory captureTransactionId'),
    rows,
  ]]);
}

export function canonicalObjectInventorySha256(entries, capturedAt) {
  const rows = entries
    .map((entry) => [entry.objectKeySha256, entry.bytes, entry.sha256])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.objectInventoryDomain, [[
    canonicalTimestamp(capturedAt, 'object inventory capturedAt'),
    rows,
  ]]);
}

export function canonicalStorageDeletionIdentitySha256(id) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.storageDeletionIdentityDomain, [[
    canonicalString(id, 'DocumentStorageDeletion.id'),
  ]]);
}

export function canonicalStorageDeletionBindingSha256(input) {
  const nullableString = (value, label) => {
    if (value === null) return null;
    if (typeof value !== 'string') throw new TypeError(`${label} must be a string or null`);
    return value;
  };
  const nullableTimestamp = (value, label) => value === null ? null : canonicalTimestamp(value, label);
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 0) {
    throw new TypeError('DocumentStorageDeletion.attempts must be a nonnegative safe integer');
  }
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.storageDeletionBindingDomain, [[
    canonicalString(input.id, 'DocumentStorageDeletion.id'),
    canonicalString(input.organisationId, 'DocumentStorageDeletion.organisationId'),
    canonicalString(input.storagePath, 'DocumentStorageDeletion.storagePath'),
    canonicalString(input.state, 'DocumentStorageDeletion.state'),
    input.attempts,
    nullableString(input.lastError, 'DocumentStorageDeletion.lastError'),
    nullableTimestamp(input.lastAttemptAt, 'DocumentStorageDeletion.lastAttemptAt'),
    nullableTimestamp(input.nextAttemptAt, 'DocumentStorageDeletion.nextAttemptAt'),
    nullableTimestamp(input.claimedAt, 'DocumentStorageDeletion.claimedAt'),
    nullableTimestamp(input.deadLetteredAt, 'DocumentStorageDeletion.deadLetteredAt'),
    nullableString(input.terminalReason, 'DocumentStorageDeletion.terminalReason'),
    nullableString(input.alertClaimToken, 'DocumentStorageDeletion.alertClaimToken'),
    nullableTimestamp(input.alertClaimedAt, 'DocumentStorageDeletion.alertClaimedAt'),
    nullableTimestamp(input.alertedAt, 'DocumentStorageDeletion.alertedAt'),
    nullableTimestamp(input.processedAt, 'DocumentStorageDeletion.processedAt'),
    nullableString(input.lastRecoveryId, 'DocumentStorageDeletion.lastRecoveryId'),
    nullableString(input.lastRecoveryNonce, 'DocumentStorageDeletion.lastRecoveryNonce'),
    nullableString(input.lastRecoveryDisposition, 'DocumentStorageDeletion.lastRecoveryDisposition'),
    nullableTimestamp(input.lastRecoveredAt, 'DocumentStorageDeletion.lastRecoveredAt'),
    canonicalTimestamp(input.createdAt, 'DocumentStorageDeletion.createdAt'),
    canonicalTimestamp(input.updatedAt, 'DocumentStorageDeletion.updatedAt'),
  ]]);
}

export function canonicalStorageDeletionInventorySha256(entries, capturedAt, captureTransactionId) {
  const rows = entries
    .map((entry) => [
      entry.deletionIdentitySha256,
      entry.lifecycleBindingSha256,
      entry.objectKeySha256,
      entry.state,
      entry.lastRecoveryIdentitySha256,
      entry.lastRecoveryNonceSha256,
      entry.lastRecoveryDisposition,
      entry.lastRecoveredAt,
    ])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.storageDeletionInventoryDomain, [[
    canonicalTimestamp(capturedAt, 'storage deletion inventory capturedAt'),
    canonicalTransactionId(captureTransactionId, 'storage deletion inventory captureTransactionId'),
    rows,
  ]]);
}

export function canonicalStorageDeletionRecoveryIdentitySha256(id) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.storageDeletionRecoveryIdentityDomain, [[
    canonicalString(id, 'DocumentStorageDeletionRecovery.id'),
  ]]);
}

export function canonicalStorageDeletionRecoveryNonceSha256(recoveryNonce) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.storageDeletionRecoveryNonceDomain, [[
    canonicalString(recoveryNonce, 'DocumentStorageDeletionRecovery.recoveryNonce'),
  ]]);
}

export function canonicalStorageDeletionRecoveryBindingSha256(input) {
  const nullableString = (value, label) => {
    if (value === null) return null;
    if (typeof value !== 'string') throw new TypeError(`${label} must be a string or null`);
    return value;
  };
  const transactionId = canonicalTransactionId(
    input.transactionId,
    'DocumentStorageDeletionRecovery.transactionId',
  );
  if (!Number.isSafeInteger(input.previousAttempts) || input.previousAttempts < 1) {
    throw new TypeError('DocumentStorageDeletionRecovery.previousAttempts must be a positive safe integer');
  }
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.storageDeletionRecoveryBindingDomain, [[
    canonicalString(input.id, 'DocumentStorageDeletionRecovery.id'),
    canonicalString(input.recoveryNonce, 'DocumentStorageDeletionRecovery.recoveryNonce'),
    transactionId,
    canonicalString(input.deletionId, 'DocumentStorageDeletionRecovery.deletionId'),
    canonicalString(input.organisationId, 'DocumentStorageDeletionRecovery.organisationId'),
    canonicalString(input.actorType, 'DocumentStorageDeletionRecovery.actorType'),
    nullableString(input.actorUserId, 'DocumentStorageDeletionRecovery.actorUserId'),
    nullableString(input.operatorIdentity, 'DocumentStorageDeletionRecovery.operatorIdentity'),
    canonicalString(input.reason, 'DocumentStorageDeletionRecovery.reason'),
    canonicalString(input.disposition, 'DocumentStorageDeletionRecovery.disposition'),
    input.previousAttempts,
    canonicalString(input.previousTerminalReason, 'DocumentStorageDeletionRecovery.previousTerminalReason'),
    canonicalString(input.previousStoragePath, 'DocumentStorageDeletionRecovery.previousStoragePath'),
    nullableString(input.correctedStoragePath, 'DocumentStorageDeletionRecovery.correctedStoragePath'),
    canonicalTimestamp(input.createdAt, 'DocumentStorageDeletionRecovery.createdAt'),
  ]]);
}

export function canonicalStorageDeletionRecoveryInventorySha256(entries, capturedAt, captureTransactionId) {
  const rows = entries
    .map((entry) => [
      entry.recoveryIdentitySha256,
      entry.recoveryNonceSha256,
      entry.recoveryBindingSha256,
      canonicalTransactionId(entry.transactionId, 'DocumentStorageDeletionRecovery.transactionId'),
      entry.deletionIdentitySha256,
      entry.actorType,
      entry.disposition,
      entry.previousTerminalReason,
      entry.previousObjectKeySha256,
      entry.correctedObjectKeySha256,
      entry.createdAt,
    ])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.storageDeletionRecoveryInventoryDomain, [[
    canonicalTimestamp(capturedAt, 'storage deletion recovery inventory capturedAt'),
    canonicalTransactionId(captureTransactionId, 'storage deletion recovery inventory captureTransactionId'),
    rows,
  ]]);
}

export function canonicalSourceBindingSha256({
  exerciseId,
  recoverySetId,
  sourceCaptureReportSha256,
  databaseIdentitySha256,
  objectStoreIdentitySha256,
  databaseDumpSha256,
  objectBackupManifestSha256,
  productionDocumentCount,
  storageDeletionCount,
  pendingStorageDeletionCount,
  deadLetterStorageDeletionCount,
  processedStorageDeletionCount,
  recoveryEventCount,
  maximumDocumentProofAgeMinutes,
  sourceMetadataCapturedAt,
  restoredMetadataCapturedAt,
  sourceObjectInventoryCapturedAt,
  restoredObjectInventoryCapturedAt,
  sourceMetadataCaptureTransactionId,
  restoredMetadataCaptureTransactionId,
  metadataInventorySha256,
  restoredMetadataInventorySha256,
  objectInventorySha256,
  restoredObjectInventorySha256,
  storageDeletionInventorySha256,
  restoredStorageDeletionInventorySha256,
  recoveryEventInventorySha256,
  restoredRecoveryEventInventorySha256,
}) {
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.sourceBindingDomain, [[
    exerciseId,
    recoverySetId,
    sourceCaptureReportSha256,
    databaseIdentitySha256,
    objectStoreIdentitySha256,
    databaseDumpSha256,
    objectBackupManifestSha256,
    productionDocumentCount,
    storageDeletionCount,
    pendingStorageDeletionCount,
    deadLetterStorageDeletionCount,
    processedStorageDeletionCount,
    recoveryEventCount,
    maximumDocumentProofAgeMinutes,
    sourceMetadataCapturedAt,
    restoredMetadataCapturedAt,
    sourceObjectInventoryCapturedAt,
    restoredObjectInventoryCapturedAt,
    sourceMetadataCaptureTransactionId,
    restoredMetadataCaptureTransactionId,
    metadataInventorySha256,
    restoredMetadataInventorySha256,
    objectInventorySha256,
    restoredObjectInventorySha256,
    storageDeletionInventorySha256,
    restoredStorageDeletionInventorySha256,
    recoveryEventInventorySha256,
    restoredRecoveryEventInventorySha256,
  ]]);
}

function addUnsupportedKeyIssue(value, allowedKeys, path, issues) {
  if (isPlainObject(value) && Object.keys(value).some((key) => !allowedKeys.has(key))) {
    issues.push(`${path} contains unsupported field(s)`);
  }
}

function requireObject(value, path, allowedKeys, issues) {
  if (!isPlainObject(value)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  addUnsupportedKeyIssue(value, allowedKeys, path, issues);
  return value;
}

function requireText(value, path, issues, { min = 1, max = 4000, allowPlaceholder = false } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    issues.push(`${path} must be a non-empty bounded string`);
    return '';
  }
  const trimmed = value.trim();
  if (!allowPlaceholder && PLACEHOLDER_PATTERN.test(trimmed)) {
    issues.push(`${path} must not contain placeholder or local-only text`);
  }
  return trimmed;
}

function requireIdentifier(value, path, issues) {
  const identifier = requireText(value, path, issues, { max: 128 });
  if (identifier && !IDENTIFIER_PATTERN.test(identifier)) {
    issues.push(`${path} must use a bounded operational identifier`);
    return '';
  }
  return identifier;
}

function requireSha256(value, path, issues) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    issues.push(`${path} must be a lowercase SHA-256 digest`);
    return '';
  }
  return value;
}

function requireSafeInteger(value, path, issues, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    issues.push(`${path} must be a safe integer from ${min} to ${max}`);
    return null;
  }
  return value;
}

function requireTimestamp(value, path, issues) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    issues.push(`${path} must be an ISO-8601 UTC timestamp with milliseconds`);
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    issues.push(`${path} must be a valid ISO-8601 UTC timestamp`);
    return null;
  }
  return milliseconds;
}

function requireTransactionId(value, path, issues) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,18}$/.test(value) ||
    BigInt(value) > MAX_POSTGRES_BIGINT
  ) {
    issues.push(`${path} must be a canonical bounded decimal transaction identifier`);
    return '';
  }
  return value;
}

function referenceIsImmutable(url) {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    return (
      parts[0] === 'jasperfordesq-ai' &&
      parts[1] === 'charity-governance' &&
      ['blob', 'commit'].includes(parts[2]) &&
      GIT_COMMIT_PATTERN.test(parts[3] ?? '')
    );
  }
  return url.pathname.split('/').some((part) => SHA256_PATTERN.test(part));
}

function requireReference(value, path, issues) {
  const reference = requireText(value, path, issues, { max: 2048 });
  if (!reference) return '';
  try {
    const url = new URL(reference);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const approvedHost = APPROVED_REFERENCE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    if (url.protocol !== 'https:' || !approvedHost) {
      issues.push(`${path} must be a stable HTTPS URL on an approved evidence host`);
    }
    if (url.username || url.password) issues.push(`${path} must not contain URL credentials`);
    if (url.search || url.hash) issues.push(`${path} must not contain query parameters or fragments`);
    if (!referenceIsImmutable(url)) {
      issues.push(`${path} must be digest-bound or use a commit-bound canonical GitHub reference`);
    }
  } catch {
    issues.push(`${path} must be a valid immutable HTTPS evidence reference`);
  }
  return reference;
}

function referenceContainsDigest(reference, digest) {
  try {
    return new URL(reference).pathname.split('/').includes(digest);
  } catch {
    return false;
  }
}

export function documentRecoverySecretIssues(rawText, parsedValue) {
  let found = SECRET_PATTERNS.some((pattern) => pattern.test(rawText));
  let scanBoundExceeded = false;
  if (!found && parsedValue !== undefined) {
    const stack = [{ value: parsedValue, depth: 0 }];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_SECRET_SCAN_NODES && !found) {
      const { value, depth } = stack.pop();
      visited += 1;
      if (typeof value === 'string') {
        found = CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
        continue;
      }
      if (!value || typeof value !== 'object' || depth >= MAX_JSON_NESTING) continue;
      if (Array.isArray(value)) {
        for (const item of value) stack.push({ value: item, depth: depth + 1 });
        continue;
      }
      for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (
          SENSITIVE_KEY_PATTERN.test(normalizedKey) &&
          typeof child === 'string' &&
          child.trim().length > 0
        ) {
          found = true;
          break;
        }
        stack.push({ value: child, depth: depth + 1 });
      }
    }
    scanBoundExceeded = stack.length > 0;
  }
  if (found) return ['manifest contains secret-looking material; remove credentials, tokens, private keys, or signed URLs'];
  if (scanBoundExceeded) return ['manifest credential scan exceeded its bounded traversal and cannot certify the artifact'];
  return [];
}

function validateHashContract(value, issues) {
  const contract = requireObject(value, 'hashContract', HASH_CONTRACT_KEYS, issues);
  if (!contract) return;
  for (const [key, expected] of Object.entries(DOCUMENT_RECOVERY_HASH_CONTRACT)) {
    if (contract[key] !== expected) issues.push(`hashContract.${key} must match the v1 canonical hash contract`);
  }
}

function validateMetadataInventory(entries, path, issues) {
  if (!Array.isArray(entries)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  if (entries.length === 0) issues.push(`${path} must contain at least one production Document row`);
  if (entries.length > MAX_INVENTORY_ENTRIES) issues.push(`${path} exceeds the maximum supported inventory size`);
  const validated = [];
  const documents = new Set();
  const objectKeys = new Set();
  let duplicateDocument = false;
  let duplicateObjectKey = false;
  for (let index = 0; index < Math.min(entries.length, MAX_INVENTORY_ENTRIES); index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = requireObject(entries[index], entryPath, METADATA_ENTRY_KEYS, issues);
    if (!entry) continue;
    const documentIdentitySha256 = requireSha256(entry.documentIdentitySha256, `${entryPath}.documentIdentitySha256`, issues);
    const metadataBindingSha256 = requireSha256(entry.metadataBindingSha256, `${entryPath}.metadataBindingSha256`, issues);
    const objectKeySha256 = requireSha256(entry.objectKeySha256, `${entryPath}.objectKeySha256`, issues);
    const fileSize = requireSafeInteger(entry.fileSize, `${entryPath}.fileSize`, issues, { min: 0, max: MAX_DOCUMENT_BYTES });
    if (documentIdentitySha256 && documents.has(documentIdentitySha256)) duplicateDocument = true;
    if (objectKeySha256 && objectKeys.has(objectKeySha256)) duplicateObjectKey = true;
    if (documentIdentitySha256) documents.add(documentIdentitySha256);
    if (objectKeySha256) objectKeys.add(objectKeySha256);
    if (documentIdentitySha256 && metadataBindingSha256 && objectKeySha256 && fileSize !== null) {
      validated.push({ documentIdentitySha256, metadataBindingSha256, objectKeySha256, fileSize });
    }
  }
  if (duplicateDocument) issues.push(`${path} contains duplicate document identities`);
  if (duplicateObjectKey) issues.push(`${path} contains duplicate metadata object-key identities`);
  return validated;
}

function validateObjectInventory(entries, path, issues) {
  if (!Array.isArray(entries)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  if (entries.length === 0) issues.push(`${path} must contain at least one backed-up document object`);
  if (entries.length > MAX_INVENTORY_ENTRIES) issues.push(`${path} exceeds the maximum supported inventory size`);
  const validated = [];
  const objectKeys = new Set();
  let duplicateObjectKey = false;
  let aggregateBytes = 0;
  for (let index = 0; index < Math.min(entries.length, MAX_INVENTORY_ENTRIES); index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = requireObject(entries[index], entryPath, OBJECT_ENTRY_KEYS, issues);
    if (!entry) continue;
    const objectKeySha256 = requireSha256(entry.objectKeySha256, `${entryPath}.objectKeySha256`, issues);
    const bytes = requireSafeInteger(entry.bytes, `${entryPath}.bytes`, issues, { min: 0, max: MAX_DOCUMENT_BYTES });
    const objectSha256 = requireSha256(entry.sha256, `${entryPath}.sha256`, issues);
    if (bytes === 0 && objectSha256 && objectSha256 !== EMPTY_SHA256) {
      issues.push(`${entryPath}.sha256 must equal the SHA-256 of empty bytes when bytes is zero`);
    }
    if (objectKeySha256 && objectKeys.has(objectKeySha256)) duplicateObjectKey = true;
    if (objectKeySha256) objectKeys.add(objectKeySha256);
    if (bytes !== null) {
      if (!Number.isSafeInteger(aggregateBytes + bytes) || aggregateBytes + bytes > MAX_AGGREGATE_BYTES) {
        issues.push(`${path} aggregate bytes exceed the safe bounded maximum`);
      } else {
        aggregateBytes += bytes;
      }
    }
    if (objectKeySha256 && bytes !== null && objectSha256) {
      validated.push({ objectKeySha256, bytes, sha256: objectSha256 });
    }
  }
  if (duplicateObjectKey) issues.push(`${path} contains duplicate object-key identities`);
  return validated;
}

function validateStorageDeletionInventory(entries, path, issues) {
  if (!Array.isArray(entries)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  if (entries.length > MAX_INVENTORY_ENTRIES) issues.push(`${path} exceeds the maximum supported inventory size`);
  const validated = [];
  const identities = new Set();
  const objectKeys = new Set();
  let duplicateIdentity = false;
  let duplicateObjectKey = false;
  for (let index = 0; index < Math.min(entries.length, MAX_INVENTORY_ENTRIES); index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = requireObject(entries[index], entryPath, STORAGE_DELETION_ENTRY_KEYS, issues);
    if (!entry) continue;
    const deletionIdentitySha256 = requireSha256(
      entry.deletionIdentitySha256,
      `${entryPath}.deletionIdentitySha256`,
      issues,
    );
    const lifecycleBindingSha256 = requireSha256(
      entry.lifecycleBindingSha256,
      `${entryPath}.lifecycleBindingSha256`,
      issues,
    );
    const objectKeySha256 = requireSha256(entry.objectKeySha256, `${entryPath}.objectKeySha256`, issues);
    const state = ['PENDING', 'DEAD_LETTER', 'PROCESSED'].includes(entry.state) ? entry.state : '';
    if (!state) issues.push(`${entryPath}.state must be PENDING, DEAD_LETTER, or PROCESSED`);
    const lastRecoveryIdentitySha256 = entry.lastRecoveryIdentitySha256 === null
      ? null
      : requireSha256(entry.lastRecoveryIdentitySha256, `${entryPath}.lastRecoveryIdentitySha256`, issues);
    const lastRecoveryNonceSha256 = entry.lastRecoveryNonceSha256 === null
      ? null
      : requireSha256(entry.lastRecoveryNonceSha256, `${entryPath}.lastRecoveryNonceSha256`, issues);
    const lastRecoveryDisposition = entry.lastRecoveryDisposition === null
      ? null
      : ['REQUEUE_UNCHANGED', 'REQUEUE_CORRECTED_PATH', 'COMPLETE_EXTERNALLY_REMEDIATED'].includes(entry.lastRecoveryDisposition)
        ? entry.lastRecoveryDisposition
        : '';
    if (entry.lastRecoveryDisposition !== null && !lastRecoveryDisposition) {
      issues.push(`${entryPath}.lastRecoveryDisposition is not supported`);
    }
    const lastRecoveredAtMs = entry.lastRecoveredAt === null
      ? null
      : requireTimestamp(entry.lastRecoveredAt, `${entryPath}.lastRecoveredAt`, issues);
    const recoveryBindingValues = [
      lastRecoveryIdentitySha256,
      lastRecoveryNonceSha256,
      lastRecoveryDisposition,
      lastRecoveredAtMs,
    ];
    if (
      recoveryBindingValues.some((value) => value === null || value === '') &&
      recoveryBindingValues.some((value) => value !== null && value !== '')
    ) {
      issues.push(`${entryPath} must use an all-or-none last-recovery binding`);
    }
    if (deletionIdentitySha256 && identities.has(deletionIdentitySha256)) duplicateIdentity = true;
    if (objectKeySha256 && objectKeys.has(objectKeySha256)) duplicateObjectKey = true;
    if (deletionIdentitySha256) identities.add(deletionIdentitySha256);
    if (objectKeySha256) objectKeys.add(objectKeySha256);
    if (deletionIdentitySha256 && lifecycleBindingSha256 && objectKeySha256 && state) {
      validated.push({
        deletionIdentitySha256,
        lifecycleBindingSha256,
        objectKeySha256,
        state,
        lastRecoveryIdentitySha256,
        lastRecoveryNonceSha256,
        lastRecoveryDisposition: lastRecoveryDisposition || null,
        lastRecoveredAt: lastRecoveredAtMs === null ? null : entry.lastRecoveredAt,
      });
    }
  }
  if (duplicateIdentity) issues.push(`${path} contains duplicate storage-deletion identities`);
  if (duplicateObjectKey) issues.push(`${path} contains duplicate storage-deletion object-key identities`);
  return validated;
}

function stateCount(entries, state) {
  return entries.filter((entry) => entry.state === state).length;
}

function validateStorageDeletionRecoveryInventory(entries, path, issues) {
  if (!Array.isArray(entries)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  if (entries.length > MAX_INVENTORY_ENTRIES) issues.push(`${path} exceeds the maximum supported inventory size`);
  const validated = [];
  const identities = new Set();
  const nonces = new Set();
  for (let index = 0; index < Math.min(entries.length, MAX_INVENTORY_ENTRIES); index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = requireObject(entries[index], entryPath, STORAGE_DELETION_RECOVERY_ENTRY_KEYS, issues);
    if (!entry) continue;
    const recoveryIdentitySha256 = requireSha256(
      entry.recoveryIdentitySha256,
      `${entryPath}.recoveryIdentitySha256`,
      issues,
    );
    const recoveryNonceSha256 = requireSha256(
      entry.recoveryNonceSha256,
      `${entryPath}.recoveryNonceSha256`,
      issues,
    );
    const recoveryBindingSha256 = requireSha256(
      entry.recoveryBindingSha256,
      `${entryPath}.recoveryBindingSha256`,
      issues,
    );
    const transactionId = requireTransactionId(entry.transactionId, `${entryPath}.transactionId`, issues);
    const deletionIdentitySha256 = requireSha256(
      entry.deletionIdentitySha256,
      `${entryPath}.deletionIdentitySha256`,
      issues,
    );
    const actorType = ['TENANT_USER', 'PLATFORM_OPERATOR'].includes(entry.actorType) ? entry.actorType : '';
    if (!actorType) issues.push(`${entryPath}.actorType is not supported`);
    const disposition = [
      'REQUEUE_UNCHANGED',
      'REQUEUE_CORRECTED_PATH',
      'COMPLETE_EXTERNALLY_REMEDIATED',
    ].includes(entry.disposition) ? entry.disposition : '';
    if (!disposition) issues.push(`${entryPath}.disposition is not supported`);
    const previousTerminalReason = [
      'MAX_ATTEMPTS_EXHAUSTED',
      'PERMANENT_STORAGE_PATH_REJECTED',
    ].includes(entry.previousTerminalReason) ? entry.previousTerminalReason : '';
    if (!previousTerminalReason) issues.push(`${entryPath}.previousTerminalReason is not supported`);
    const previousObjectKeySha256 = requireSha256(
      entry.previousObjectKeySha256,
      `${entryPath}.previousObjectKeySha256`,
      issues,
    );
    const correctedObjectKeySha256 = entry.correctedObjectKeySha256 === null
      ? null
      : requireSha256(entry.correctedObjectKeySha256, `${entryPath}.correctedObjectKeySha256`, issues);
    const createdAtMs = requireTimestamp(entry.createdAt, `${entryPath}.createdAt`, issues);
    if (recoveryIdentitySha256 && identities.has(recoveryIdentitySha256)) {
      issues.push(`${path} contains duplicate recovery-event identities`);
    }
    if (recoveryNonceSha256 && nonces.has(recoveryNonceSha256)) {
      issues.push(`${path} contains duplicate recovery-event nonces`);
    }
    if (recoveryIdentitySha256) identities.add(recoveryIdentitySha256);
    if (recoveryNonceSha256) nonces.add(recoveryNonceSha256);
    if (actorType === 'TENANT_USER' && disposition && disposition !== 'REQUEUE_UNCHANGED') {
      issues.push(`${entryPath} tenant-user recovery may only requeue an unchanged path`);
    }
    if (disposition === 'REQUEUE_CORRECTED_PATH') {
      if (!correctedObjectKeySha256 || correctedObjectKeySha256 === previousObjectKeySha256) {
        issues.push(`${entryPath} corrected-path recovery requires a distinct corrected object-key digest`);
      }
    } else if (correctedObjectKeySha256 !== null) {
      issues.push(`${entryPath}.correctedObjectKeySha256 must be null outside corrected-path recovery`);
    }
    if (
      previousTerminalReason === 'PERMANENT_STORAGE_PATH_REJECTED' &&
      disposition === 'REQUEUE_UNCHANGED'
    ) {
      issues.push(`${entryPath} cannot requeue a permanently rejected path unchanged`);
    }
    if (
      recoveryIdentitySha256 &&
      recoveryNonceSha256 &&
      recoveryBindingSha256 &&
      transactionId &&
      deletionIdentitySha256 &&
      actorType &&
      disposition &&
      previousTerminalReason &&
      previousObjectKeySha256 &&
      createdAtMs !== null
    ) {
      validated.push({
        recoveryIdentitySha256,
        recoveryNonceSha256,
        recoveryBindingSha256,
        transactionId,
        deletionIdentitySha256,
        actorType,
        disposition,
        previousTerminalReason,
        previousObjectKeySha256,
        correctedObjectKeySha256,
        createdAt: entry.createdAt,
      });
    }
  }
  return validated;
}

function validateRecoveryLinks(
  deletions,
  recoveryEvents,
  path,
  issues,
  { capturedAt = '', captureTransactionId = '', enforceCaptureTransactionOrder = false } = {},
) {
  const deletionByIdentity = new Map(deletions.map((entry) => [entry.deletionIdentitySha256, entry]));
  const recoveryByIdentity = new Map(recoveryEvents.map((entry) => [entry.recoveryIdentitySha256, entry]));
  const deletionIdentitiesWithRecoveryEvents = new Set();
  const recoveriesByDeletionIdentity = new Map();
  for (const recovery of recoveryEvents) {
    if (capturedAt && Date.parse(recovery.createdAt) > Date.parse(capturedAt)) {
      issues.push(`${path} contains a recovery event created after its metadata capture`);
    }
    if (
      enforceCaptureTransactionOrder &&
      captureTransactionId &&
      BigInt(recovery.transactionId) >= BigInt(captureTransactionId)
    ) {
      issues.push(`${path} contains a recovery event transaction that does not predate its source capture transaction`);
    }
    if (!deletionByIdentity.has(recovery.deletionIdentitySha256)) {
      issues.push(`${path} contains a recovery event whose deletion identity is absent`);
    } else {
      deletionIdentitiesWithRecoveryEvents.add(recovery.deletionIdentitySha256);
      const recoveries = recoveriesByDeletionIdentity.get(recovery.deletionIdentitySha256) ?? [];
      recoveries.push(recovery);
      recoveriesByDeletionIdentity.set(recovery.deletionIdentitySha256, recoveries);
    }
  }
  for (const deletion of deletions) {
    if (deletion.state !== 'PROCESSED') {
      issues.push(`${path} requires every storage-deletion row to be terminally PROCESSED`);
    }
    if (!deletion.lastRecoveryIdentitySha256) {
      if (deletionIdentitiesWithRecoveryEvents.has(deletion.deletionIdentitySha256)) {
        issues.push(`${path} contains recovery events without the deletion's exact last-recovery binding`);
      }
      continue;
    }
    if (capturedAt && Date.parse(deletion.lastRecoveredAt) > Date.parse(capturedAt)) {
      issues.push(`${path} contains a deletion recovered after its metadata capture`);
    }
    const recovery = recoveryByIdentity.get(deletion.lastRecoveryIdentitySha256);
    if (
      !recovery ||
      recovery.deletionIdentitySha256 !== deletion.deletionIdentitySha256 ||
      recovery.recoveryNonceSha256 !== deletion.lastRecoveryNonceSha256 ||
      recovery.disposition !== deletion.lastRecoveryDisposition
    ) {
      issues.push(`${path} contains a deletion whose last-recovery binding does not match its exact recovery event`);
      continue;
    }
    const deletionRecoveries = recoveriesByDeletionIdentity.get(deletion.deletionIdentitySha256) ?? [];
    const latestTransactionId = deletionRecoveries.reduce(
      (latest, event) => BigInt(event.transactionId) > latest ? BigInt(event.transactionId) : latest,
      0n,
    );
    const latestTransactionEvents = deletionRecoveries.filter(
      (event) => BigInt(event.transactionId) === latestTransactionId,
    );
    if (
      BigInt(recovery.transactionId) !== latestTransactionId ||
      latestTransactionEvents.length !== 1 ||
      latestTransactionEvents[0].recoveryIdentitySha256 !== recovery.recoveryIdentitySha256
    ) {
      issues.push(`${path} contains a deletion whose last-recovery binding is not its latest recovery transaction`);
    }
    if (Date.parse(deletion.lastRecoveredAt) < Date.parse(recovery.createdAt)) {
      issues.push(`${path} contains a deletion recovered before its linked event`);
    }
    if (recovery.disposition === 'REQUEUE_CORRECTED_PATH') {
      if (deletion.objectKeySha256 !== recovery.correctedObjectKeySha256) {
        issues.push(`${path} corrected-path recovery does not match the deletion object-key identity`);
      }
    } else if (deletion.objectKeySha256 !== recovery.previousObjectKeySha256) {
      issues.push(`${path} unchanged or external recovery must preserve its previous object-key identity`);
    }
    if (
      recovery.disposition === 'COMPLETE_EXTERNALLY_REMEDIATED' &&
      (recovery.actorType !== 'PLATFORM_OPERATOR' || deletion.state !== 'PROCESSED')
    ) {
      issues.push(`${path} external completion requires a platform operator and a terminally processed deletion`);
    }
  }
}

function reconcileInventories(
  expectedMetadata,
  restoredMetadata,
  expectedObjects,
  restoredObjects,
  expectedStorageDeletions,
  restoredStorageDeletions,
  expectedRecoveryEvents,
  restoredRecoveryEvents,
) {
  const expectedMetadataByDocument = new Map(expectedMetadata.map((entry) => [entry.documentIdentitySha256, entry]));
  const restoredMetadataByDocument = new Map(restoredMetadata.map((entry) => [entry.documentIdentitySha256, entry]));
  const expectedObjectsByKey = new Map(expectedObjects.map((entry) => [entry.objectKeySha256, entry]));
  const restoredObjectsByKey = new Map(restoredObjects.map((entry) => [entry.objectKeySha256, entry]));
  const expectedMetadataObjectKeys = new Set(expectedMetadata.map((entry) => entry.objectKeySha256));
  const restoredMetadataObjectKeys = new Set(restoredMetadata.map((entry) => entry.objectKeySha256));
  let matchedMetadataRows = 0;
  let missingMetadataRows = 0;
  let metadataMismatchCount = 0;
  let objectKeyMismatchCount = 0;
  const sizeMismatchKeys = new Set();
  let matchedObjectCount = 0;
  let checksumMismatchCount = 0;
  const expectedStorageDeletionByIdentity = new Map(
    expectedStorageDeletions.map((entry) => [entry.deletionIdentitySha256, entry]),
  );
  const restoredStorageDeletionByIdentity = new Map(
    restoredStorageDeletions.map((entry) => [entry.deletionIdentitySha256, entry]),
  );
  let matchedStorageDeletionRows = 0;
  let missingStorageDeletionRows = 0;
  let storageDeletionMismatchCount = 0;
  const expectedRecoveryByIdentity = new Map(
    expectedRecoveryEvents.map((entry) => [entry.recoveryIdentitySha256, entry]),
  );
  const restoredRecoveryByIdentity = new Map(
    restoredRecoveryEvents.map((entry) => [entry.recoveryIdentitySha256, entry]),
  );
  let matchedRecoveryEventRows = 0;
  let missingRecoveryEventRows = 0;
  let recoveryEventMismatchCount = 0;

  for (const expected of expectedMetadata) {
    const restored = restoredMetadataByDocument.get(expected.documentIdentitySha256);
    if (!restored) {
      missingMetadataRows += 1;
      continue;
    }
    const metadataMatches = expected.metadataBindingSha256 === restored.metadataBindingSha256;
    const keyMatches = expected.objectKeySha256 === restored.objectKeySha256;
    const sizeMatches = expected.fileSize === restored.fileSize;
    if (!metadataMatches) metadataMismatchCount += 1;
    if (!keyMatches) objectKeyMismatchCount += 1;
    if (!sizeMatches) sizeMismatchKeys.add(expected.objectKeySha256);
    if (metadataMatches && keyMatches && sizeMatches) matchedMetadataRows += 1;
  }

  for (const expected of expectedObjects) {
    const restored = restoredObjectsByKey.get(expected.objectKeySha256);
    if (!restored) continue;
    const sizeMatches = expected.bytes === restored.bytes;
    const checksumMatches = expected.sha256 === restored.sha256;
    if (!sizeMatches) sizeMismatchKeys.add(expected.objectKeySha256);
    if (!checksumMatches) checksumMismatchCount += 1;
    if (sizeMatches && checksumMatches) matchedObjectCount += 1;
  }

  for (const metadata of expectedMetadata) {
    const object = expectedObjectsByKey.get(metadata.objectKeySha256);
    if (object && object.bytes !== metadata.fileSize) sizeMismatchKeys.add(metadata.objectKeySha256);
  }
  for (const metadata of restoredMetadata) {
    const object = restoredObjectsByKey.get(metadata.objectKeySha256);
    if (object && object.bytes !== metadata.fileSize) sizeMismatchKeys.add(metadata.objectKeySha256);
  }

  for (const expected of expectedStorageDeletions) {
    const restored = restoredStorageDeletionByIdentity.get(expected.deletionIdentitySha256);
    if (!restored) {
      missingStorageDeletionRows += 1;
      continue;
    }
    if (
      expected.lifecycleBindingSha256 === restored.lifecycleBindingSha256 &&
      expected.objectKeySha256 === restored.objectKeySha256 &&
      expected.state === restored.state &&
      expected.lastRecoveryIdentitySha256 === restored.lastRecoveryIdentitySha256 &&
      expected.lastRecoveryNonceSha256 === restored.lastRecoveryNonceSha256 &&
      expected.lastRecoveryDisposition === restored.lastRecoveryDisposition &&
      expected.lastRecoveredAt === restored.lastRecoveredAt
    ) {
      matchedStorageDeletionRows += 1;
    } else {
      storageDeletionMismatchCount += 1;
    }
  }
  for (const expected of expectedRecoveryEvents) {
    const restored = restoredRecoveryByIdentity.get(expected.recoveryIdentitySha256);
    if (!restored) {
      missingRecoveryEventRows += 1;
      continue;
    }
    if (JSON.stringify(expected) === JSON.stringify(restored)) {
      matchedRecoveryEventRows += 1;
    } else {
      recoveryEventMismatchCount += 1;
    }
  }

  const expectedBytes = expectedObjects.reduce((total, entry) => total + entry.bytes, 0);
  const restoredBytes = restoredObjects.reduce((total, entry) => total + entry.bytes, 0);
  const missingObjectKeys = new Set();
  for (const key of expectedMetadataObjectKeys) {
    if (!expectedObjectsByKey.has(key)) missingObjectKeys.add(key);
  }
  for (const key of restoredMetadataObjectKeys) {
    if (!restoredObjectsByKey.has(key)) missingObjectKeys.add(key);
  }
  for (const entry of expectedObjects) {
    if (!restoredObjectsByKey.has(entry.objectKeySha256)) missingObjectKeys.add(entry.objectKeySha256);
  }
  const processedDeletionKeys = new Set([
    ...expectedStorageDeletions,
    ...restoredStorageDeletions,
  ].filter((entry) => entry.state === 'PROCESSED').map((entry) => entry.objectKeySha256));
  const processedResidueKeys = new Set();
  for (const object of expectedObjects) {
    if (processedDeletionKeys.has(object.objectKeySha256) && !expectedMetadataObjectKeys.has(object.objectKeySha256)) {
      processedResidueKeys.add(object.objectKeySha256);
    }
  }
  for (const object of restoredObjects) {
    if (processedDeletionKeys.has(object.objectKeySha256) && !restoredMetadataObjectKeys.has(object.objectKeySha256)) {
      processedResidueKeys.add(object.objectKeySha256);
    }
  }

  return {
    expectedMetadataRows: expectedMetadata.length,
    restoredMetadataRows: restoredMetadata.length,
    matchedMetadataRows,
    expectedObjectCount: expectedObjects.length,
    restoredObjectCount: restoredObjects.length,
    matchedObjectCount,
    missingMetadataRows,
    unexpectedMetadataRows: restoredMetadata.filter((entry) => !expectedMetadataByDocument.has(entry.documentIdentitySha256)).length,
    missingObjectCount: missingObjectKeys.size,
    unexpectedObjectCount: restoredObjects.filter((entry) => !expectedObjectsByKey.has(entry.objectKeySha256)).length,
    metadataMismatchCount,
    objectKeyMismatchCount,
    sizeMismatchCount: sizeMismatchKeys.size,
    checksumMismatchCount,
    orphanExpectedObjectCount: expectedObjects.filter((entry) => !expectedMetadataObjectKeys.has(entry.objectKeySha256)).length,
    orphanRestoredObjectCount: restoredObjects.filter((entry) => !restoredMetadataObjectKeys.has(entry.objectKeySha256)).length,
    expectedBytes,
    restoredBytes,
    expectedStorageDeletionRows: expectedStorageDeletions.length,
    restoredStorageDeletionRows: restoredStorageDeletions.length,
    matchedStorageDeletionRows,
    missingStorageDeletionRows,
    unexpectedStorageDeletionRows: restoredStorageDeletions.filter(
      (entry) => !expectedStorageDeletionByIdentity.has(entry.deletionIdentitySha256),
    ).length,
    storageDeletionMismatchCount,
    sourcePendingStorageDeletionCount: stateCount(expectedStorageDeletions, 'PENDING'),
    sourceDeadLetterStorageDeletionCount: stateCount(expectedStorageDeletions, 'DEAD_LETTER'),
    sourceProcessedStorageDeletionCount: stateCount(expectedStorageDeletions, 'PROCESSED'),
    restoredPendingStorageDeletionCount: stateCount(restoredStorageDeletions, 'PENDING'),
    restoredDeadLetterStorageDeletionCount: stateCount(restoredStorageDeletions, 'DEAD_LETTER'),
    restoredProcessedStorageDeletionCount: stateCount(restoredStorageDeletions, 'PROCESSED'),
    processedDeletionObjectResidueCount: processedResidueKeys.size,
    expectedRecoveryEventRows: expectedRecoveryEvents.length,
    restoredRecoveryEventRows: restoredRecoveryEvents.length,
    matchedRecoveryEventRows,
    missingRecoveryEventRows,
    unexpectedRecoveryEventRows: restoredRecoveryEvents.filter(
      (entry) => !expectedRecoveryByIdentity.has(entry.recoveryIdentitySha256),
    ).length,
    recoveryEventMismatchCount,
  };
}

function validateReportedSummary(value, computed, issues) {
  const summary = requireObject(value, 'reconciliation.reportedSummary', SUMMARY_KEY_SET, issues);
  if (!summary) return;
  for (const key of SUMMARY_KEYS) {
    const number = requireSafeInteger(summary[key], `reconciliation.reportedSummary.${key}`, issues, { max: MAX_AGGREGATE_BYTES });
    if (number !== null && number !== computed[key]) {
      issues.push(`reconciliation.reportedSummary.${key} does not match the computed reconciliation`);
    }
  }
}

function validateControls(value, issues) {
  const controls = requireObject(value, 'backupControls', LAYER_KEYS, issues);
  if (!controls) return;
  for (const layer of LAYER_KEYS) {
    const path = `backupControls.${layer}`;
    const control = requireObject(controls[layer], path, CONTROL_KEYS, issues);
    if (!control) continue;
    if (control.encrypted !== true) issues.push(`${path}.encrypted must be true`);
    if (control.versioned !== true) issues.push(`${path}.versioned must be true`);
    requireText(control.owner, `${path}.owner`, issues, { max: 200 });
    requireSafeInteger(control.retentionDays, `${path}.retentionDays`, issues, { min: 1, max: MAX_RETENTION_DAYS });
    requireReference(control.backupPolicyReference, `${path}.backupPolicyReference`, issues);
    requireReference(control.retentionPolicyReference, `${path}.retentionPolicyReference`, issues);
    requireReference(control.monitoringReference, `${path}.monitoringReference`, issues);
    requireReference(control.deletionPolicyReference, `${path}.deletionPolicyReference`, issues);
  }
}

function validateObjectives(value, issues) {
  const objectives = requireObject(value, 'objectives', LAYER_KEYS, issues);
  const validated = {};
  if (!objectives) return validated;
  for (const layer of LAYER_KEYS) {
    const path = `objectives.${layer}`;
    const objective = requireObject(objectives[layer], path, OBJECTIVE_KEYS, issues);
    if (!objective) continue;
    const rpoMinutes = requireSafeInteger(objective.rpoMinutes, `${path}.rpoMinutes`, issues, { min: 1, max: MAX_OBJECTIVE_MINUTES });
    const rtoMinutes = requireSafeInteger(objective.rtoMinutes, `${path}.rtoMinutes`, issues, { min: 1, max: MAX_OBJECTIVE_MINUTES });
    requireReference(objective.policyReference, `${path}.policyReference`, issues);
    if (rpoMinutes !== null && rtoMinutes !== null) validated[layer] = { rpoMinutes, rtoMinutes };
  }
  return validated;
}

function validateRestore(value, bindings, issues) {
  const restore = requireObject(value, 'restore', LAYER_KEYS, issues);
  const validated = {};
  if (!restore) return validated;
  for (const layer of LAYER_KEYS) {
    const path = `restore.${layer}`;
    const entry = requireObject(restore[layer], path, RESTORE_KEYS, issues);
    if (!entry) continue;
    if (entry.completed !== true) issues.push(`${path}.completed must be true`);
    const entryRecoverySetId = requireIdentifier(entry.recoverySetId, `${path}.recoverySetId`, issues);
    if (bindings.recoverySetId && entryRecoverySetId && entryRecoverySetId !== bindings.recoverySetId) {
      issues.push(`${path}.recoverySetId must match source.recoverySetId`);
    }
    const backupReference = requireReference(entry.backupReference, `${path}.backupReference`, issues);
    const expectedBackupSha256 = layer === 'database'
      ? bindings.databaseDumpSha256
      : bindings.objectBackupManifestSha256;
    if (expectedBackupSha256 && backupReference && !referenceContainsDigest(backupReference, expectedBackupSha256)) {
      issues.push(`${path}.backupReference must contain the exact ${layer === 'database' ? 'databaseDumpSha256' : 'objectBackupManifestSha256'} as an immutable path segment`);
    }
    const recoveredThroughAt = requireTimestamp(entry.recoveredThroughAt, `${path}.recoveredThroughAt`, issues);
    const verifiedAt = requireTimestamp(entry.verifiedAt, `${path}.verifiedAt`, issues);
    if (recoveredThroughAt !== null && verifiedAt !== null) validated[layer] = { recoveredThroughAt, verifiedAt };
  }
  return validated;
}

function validateChronology({
  exerciseTimes,
  restoreTimes,
  objectives,
  captureTimes,
  attestedAt,
  maximumSkewMinutes,
  maximumDocumentProofAgeMinutes,
  now,
}, issues) {
  const { startedAt, simulatedFailureAt, completedAt } = exerciseTimes;
  if ([startedAt, simulatedFailureAt, completedAt].some((value) => value === null)) {
    return { objectiveResults: {}, documentProof: null };
  }
  if (simulatedFailureAt > startedAt) issues.push('exercise.simulatedFailureAt must not be after exercise.startedAt');
  if (startedAt > completedAt) issues.push('exercise.startedAt must not be after exercise.completedAt');
  if (completedAt > now + MAX_FUTURE_SKEW_MS) issues.push('exercise.completedAt must not be in the future');
  if (attestedAt !== null) {
    if (attestedAt < completedAt) issues.push('attestations.attestedAt must not be before exercise.completedAt');
    if (attestedAt > now + MAX_FUTURE_SKEW_MS) issues.push('attestations.attestedAt must not be in the future');
  }
  const captureEntries = [
    ['source metadata', captureTimes.sourceMetadataCapturedAt],
    ['source object inventory', captureTimes.sourceObjectInventoryCapturedAt],
    ['restored metadata', captureTimes.restoredMetadataCapturedAt],
    ['restored object inventory', captureTimes.restoredObjectInventoryCapturedAt],
  ];
  for (const [label, capturedAt] of captureEntries) {
    if (capturedAt !== null && capturedAt > now + MAX_FUTURE_SKEW_MS) {
      issues.push(`${label} capturedAt must not be in the future`);
    }
  }
  if (captureTimes.sourceMetadataCapturedAt !== null && restoreTimes.database && maximumSkewMinutes !== null) {
    const skew = Math.abs(captureTimes.sourceMetadataCapturedAt - restoreTimes.database.recoveredThroughAt);
    if (skew > maximumSkewMinutes * 60_000) {
      issues.push('source metadata capturedAt exceeds the declared skew from the database recovery point');
    }
  }
  if (captureTimes.sourceObjectInventoryCapturedAt !== null && restoreTimes.documentBytes && maximumSkewMinutes !== null) {
    const skew = Math.abs(captureTimes.sourceObjectInventoryCapturedAt - restoreTimes.documentBytes.recoveredThroughAt);
    if (skew > maximumSkewMinutes * 60_000) {
      issues.push('source object inventory capturedAt exceeds the declared skew from the document-byte recovery point');
    }
  }
  if (captureTimes.sourceMetadataCapturedAt !== null && captureTimes.sourceMetadataCapturedAt > simulatedFailureAt) {
    issues.push('source metadata capturedAt must not be after exercise.simulatedFailureAt');
  }
  if (captureTimes.sourceObjectInventoryCapturedAt !== null && captureTimes.sourceObjectInventoryCapturedAt > simulatedFailureAt) {
    issues.push('source object inventory capturedAt must not be after exercise.simulatedFailureAt');
  }
  if (captureTimes.restoredMetadataCapturedAt !== null && restoreTimes.database) {
    if (captureTimes.restoredMetadataCapturedAt < restoreTimes.database.verifiedAt) {
      issues.push('restored metadata capturedAt must not be before database restore completion');
    }
    if (captureTimes.restoredMetadataCapturedAt > completedAt) {
      issues.push('restored metadata capturedAt must not be after exercise.completedAt');
    }
    if (attestedAt !== null && captureTimes.restoredMetadataCapturedAt > attestedAt) {
      issues.push('restored metadata capturedAt must not be after attestations.attestedAt');
    }
  }
  if (captureTimes.restoredObjectInventoryCapturedAt !== null && restoreTimes.documentBytes) {
    if (captureTimes.restoredObjectInventoryCapturedAt < restoreTimes.documentBytes.verifiedAt) {
      issues.push('restored object inventory capturedAt must not be before document-byte restore completion');
    }
    if (captureTimes.restoredObjectInventoryCapturedAt > completedAt) {
      issues.push('restored object inventory capturedAt must not be after exercise.completedAt');
    }
    if (attestedAt !== null && captureTimes.restoredObjectInventoryCapturedAt > attestedAt) {
      issues.push('restored object inventory capturedAt must not be after attestations.attestedAt');
    }
  }
  if (restoreTimes.database && restoreTimes.documentBytes && maximumSkewMinutes !== null) {
    const skewMs = Math.abs(restoreTimes.database.recoveredThroughAt - restoreTimes.documentBytes.recoveredThroughAt);
    if (skewMs > maximumSkewMinutes * 60_000) {
      issues.push('database and document-byte recovery points exceed the declared maximum skew');
    }
  }

  const achievement = {};
  for (const layer of LAYER_KEYS) {
    const restored = restoreTimes[layer];
    const objective = objectives[layer];
    if (!restored || !objective) continue;
    if (restored.recoveredThroughAt > simulatedFailureAt) {
      issues.push(`restore.${layer}.recoveredThroughAt must not be after exercise.simulatedFailureAt`);
    }
    if (restored.verifiedAt < startedAt || restored.verifiedAt > completedAt) {
      issues.push(`restore.${layer}.verifiedAt must fall within the recovery exercise window`);
    }
    const rpoMs = simulatedFailureAt - restored.recoveredThroughAt;
    const rtoMs = restored.verifiedAt - simulatedFailureAt;
    if (rpoMs >= 0 && rpoMs > objective.rpoMinutes * 60_000) issues.push(`${layer} recovery exceeded its RPO objective`);
    if (rtoMs >= 0 && rtoMs > objective.rtoMinutes * 60_000) issues.push(`${layer} recovery exceeded its RTO objective`);
    achievement[layer] = {
      rpoObjectiveMinutes: objective.rpoMinutes,
      achievedRpoMinutes: rpoMs >= 0 ? Math.ceil(rpoMs / 60_000) : null,
      rtoObjectiveMinutes: objective.rtoMinutes,
      achievedRtoMinutes: rtoMs >= 0 ? Math.ceil(rtoMs / 60_000) : null,
      met: rpoMs >= 0 && rtoMs >= 0 && rpoMs <= objective.rpoMinutes * 60_000 && rtoMs <= objective.rtoMinutes * 60_000,
    };
  }
  let documentProof = null;
  const completeCaptureTimes = captureEntries.map(([, value]) => value);
  if (
    completeCaptureTimes.every((value) => value !== null) &&
    maximumDocumentProofAgeMinutes !== null
  ) {
    const oldestCapturedAt = Math.min(...completeCaptureTimes);
    const freshThroughAt = oldestCapturedAt + maximumDocumentProofAgeMinutes * 60_000;
    const ageMs = now - oldestCapturedAt;
    if (ageMs < 0) issues.push('document recovery proof captures must not be in the future');
    if (now > freshThroughAt) {
      issues.push('document recovery proof exceeds exercise.maximumDocumentProofAgeMinutes');
    }
    documentProof = {
      oldestCapturedAt: new Date(oldestCapturedAt).toISOString(),
      ageMinutes: ageMs >= 0 ? Math.ceil(ageMs / 60_000) : null,
      maximumAgeMinutes: maximumDocumentProofAgeMinutes,
      freshThroughAt: new Date(freshThroughAt).toISOString(),
      fresh: ageMs >= 0 && now <= freshThroughAt,
    };
  }
  return { objectiveResults: achievement, documentProof };
}

function canonicalReconciliationReportSha256({
  bindings,
  summary,
  target,
  objectiveResults,
  captureTimes,
  maximumSkewMinutes,
  maximumDocumentProofAgeMinutes,
  documentProof,
  reconciledAt,
}) {
  const objectiveRows = [...LAYER_KEYS].map((layer) => {
    const value = objectiveResults[layer] ?? {};
    return [
      layer,
      value.rpoObjectiveMinutes ?? null,
      value.achievedRpoMinutes ?? null,
      value.rtoObjectiveMinutes ?? null,
      value.achievedRtoMinutes ?? null,
      value.met === true,
    ];
  });
  return canonicalDigest(DOCUMENT_RECOVERY_HASH_CONTRACT.reconciliationReportDomain, [[
    bindings.recoverySetId,
    bindings.exerciseId,
    bindings.sourceCaptureReportSha256,
    bindings.sourceDatabaseIdentitySha256,
    bindings.sourceObjectStoreIdentitySha256,
    bindings.databaseDumpSha256,
    bindings.objectBackupManifestSha256,
    bindings.productionDocumentCount,
    bindings.expectedMetadataInventorySha256,
    bindings.restoredMetadataInventorySha256,
    bindings.expectedObjectInventorySha256,
    bindings.restoredObjectInventorySha256,
    bindings.expectedStorageDeletionInventorySha256,
    bindings.restoredStorageDeletionInventorySha256,
    bindings.expectedRecoveryEventInventorySha256,
    bindings.restoredRecoveryEventInventorySha256,
    captureTimes.sourceMetadataCapturedAtText,
    captureTimes.restoredMetadataCapturedAtText,
    captureTimes.sourceObjectInventoryCapturedAtText,
    captureTimes.restoredObjectInventoryCapturedAtText,
    captureTimes.sourceMetadataCaptureTransactionId,
    captureTimes.restoredMetadataCaptureTransactionId,
    ...SUMMARY_KEYS.map((key) => summary[key]),
    target.restoreTargetType,
    target.databaseIdentitySha256,
    target.objectStoreIdentitySha256,
    maximumSkewMinutes,
    maximumDocumentProofAgeMinutes,
    documentProof?.oldestCapturedAt ?? null,
    documentProof?.freshThroughAt ?? null,
    reconciledAt,
    objectiveRows,
    false,
    false,
    true,
  ]]);
}

export function validateDocumentRecoveryManifest(manifest, { now = new Date(), rawText } = {}) {
  const issues = [];
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  issues.push(...documentRecoverySecretIssues(
    typeof rawText === 'string' ? rawText : JSON.stringify(manifest),
    manifest,
  ));
  const root = requireObject(manifest, 'manifest', TOP_LEVEL_KEYS, issues);
  if (!root) return { ok: false, issues };
  if (root.kind !== MANIFEST_KIND) issues.push(`kind must be ${MANIFEST_KIND}`);
  if (root.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  validateHashContract(root.hashContract, issues);

  const exercise = requireObject(root.exercise, 'exercise', EXERCISE_KEYS, issues);
  const exerciseTimes = { startedAt: null, simulatedFailureAt: null, completedAt: null };
  let maximumSkewMinutes = null;
  let maximumDocumentProofAgeMinutes = null;
  let exerciseId = '';
  let exerciseOwner = '';
  if (exercise) {
    exerciseId = requireIdentifier(exercise.id, 'exercise.id', issues);
    exerciseOwner = requireText(exercise.owner, 'exercise.owner', issues, { max: 200 });
    exerciseTimes.startedAt = requireTimestamp(exercise.startedAt, 'exercise.startedAt', issues);
    exerciseTimes.simulatedFailureAt = requireTimestamp(exercise.simulatedFailureAt, 'exercise.simulatedFailureAt', issues);
    exerciseTimes.completedAt = requireTimestamp(exercise.completedAt, 'exercise.completedAt', issues);
    maximumSkewMinutes = requireSafeInteger(
      exercise.maximumRecoveryPointSkewMinutes,
      'exercise.maximumRecoveryPointSkewMinutes',
      issues,
      { min: 0, max: MAX_RECOVERY_POINT_SKEW_MINUTES },
    );
    maximumDocumentProofAgeMinutes = requireSafeInteger(
      exercise.maximumDocumentProofAgeMinutes,
      'exercise.maximumDocumentProofAgeMinutes',
      issues,
      { min: 1, max: MAX_DOCUMENT_PROOF_AGE_MINUTES },
    );
    requireText(exercise.notes, 'exercise.notes', issues, { min: 10, max: 4000 });
    requireReference(exercise.evidenceReference, 'exercise.evidenceReference', issues);
  }

  const source = requireObject(root.source, 'source', SOURCE_KEYS, issues);
  const bindings = {
    exerciseId,
    recoverySetId: '',
    sourceCaptureReportSha256: '',
    sourceDatabaseIdentitySha256: '',
    sourceObjectStoreIdentitySha256: '',
    databaseDumpSha256: '',
    objectBackupManifestSha256: '',
    productionDocumentCount: null,
    expectedMetadataInventorySha256: '',
    expectedObjectInventorySha256: '',
    restoredMetadataInventorySha256: '',
    restoredObjectInventorySha256: '',
    expectedStorageDeletionInventorySha256: '',
    restoredStorageDeletionInventorySha256: '',
    expectedRecoveryEventInventorySha256: '',
    restoredRecoveryEventInventorySha256: '',
    storageDeletionCount: null,
    pendingStorageDeletionCount: null,
    deadLetterStorageDeletionCount: null,
    processedStorageDeletionCount: null,
    recoveryEventCount: null,
    sourceBindingSha256: '',
  };
  let sourceDatabaseIdentity = '';
  let sourceObjectIdentity = '';
  if (source) {
    if (source.environment !== 'production') issues.push('source.environment must be production');
    bindings.recoverySetId = requireIdentifier(source.recoverySetId, 'source.recoverySetId', issues);
    sourceDatabaseIdentity = requireSha256(source.databaseIdentitySha256, 'source.databaseIdentitySha256', issues);
    sourceObjectIdentity = requireSha256(source.objectStoreIdentitySha256, 'source.objectStoreIdentitySha256', issues);
    bindings.sourceDatabaseIdentitySha256 = sourceDatabaseIdentity;
    bindings.sourceObjectStoreIdentitySha256 = sourceObjectIdentity;
    bindings.databaseDumpSha256 = requireSha256(source.databaseDumpSha256, 'source.databaseDumpSha256', issues);
    bindings.objectBackupManifestSha256 = requireSha256(source.objectBackupManifestSha256, 'source.objectBackupManifestSha256', issues);
    bindings.sourceCaptureReportSha256 = requireSha256(source.sourceCaptureReportSha256, 'source.sourceCaptureReportSha256', issues);
    const sourceCaptureReference = requireReference(source.sourceCaptureReference, 'source.sourceCaptureReference', issues);
    if (
      bindings.sourceCaptureReportSha256 &&
      sourceCaptureReference &&
      !referenceContainsDigest(sourceCaptureReference, bindings.sourceCaptureReportSha256)
    ) {
      issues.push('source.sourceCaptureReference must contain the exact sourceCaptureReportSha256 as an immutable path segment');
    }
    bindings.productionDocumentCount = requireSafeInteger(source.productionDocumentCount, 'source.productionDocumentCount', issues, {
      min: 1,
      max: MAX_INVENTORY_ENTRIES,
    });
    bindings.expectedMetadataInventorySha256 = requireSha256(source.metadataInventorySha256, 'source.metadataInventorySha256', issues);
    bindings.expectedObjectInventorySha256 = requireSha256(source.objectInventorySha256, 'source.objectInventorySha256', issues);
    bindings.storageDeletionCount = requireSafeInteger(
      source.storageDeletionCount,
      'source.storageDeletionCount',
      issues,
      { min: 0, max: MAX_INVENTORY_ENTRIES },
    );
    bindings.pendingStorageDeletionCount = requireSafeInteger(
      source.pendingStorageDeletionCount,
      'source.pendingStorageDeletionCount',
      issues,
      { min: 0, max: MAX_INVENTORY_ENTRIES },
    );
    bindings.deadLetterStorageDeletionCount = requireSafeInteger(
      source.deadLetterStorageDeletionCount,
      'source.deadLetterStorageDeletionCount',
      issues,
      { min: 0, max: MAX_INVENTORY_ENTRIES },
    );
    bindings.processedStorageDeletionCount = requireSafeInteger(
      source.processedStorageDeletionCount,
      'source.processedStorageDeletionCount',
      issues,
      { min: 0, max: MAX_INVENTORY_ENTRIES },
    );
    bindings.expectedStorageDeletionInventorySha256 = requireSha256(
      source.storageDeletionInventorySha256,
      'source.storageDeletionInventorySha256',
      issues,
    );
    bindings.recoveryEventCount = requireSafeInteger(
      source.recoveryEventCount,
      'source.recoveryEventCount',
      issues,
      { min: 0, max: MAX_INVENTORY_ENTRIES },
    );
    bindings.expectedRecoveryEventInventorySha256 = requireSha256(
      source.recoveryEventInventorySha256,
      'source.recoveryEventInventorySha256',
      issues,
    );
    bindings.sourceBindingSha256 = requireSha256(source.sourceBindingSha256, 'source.sourceBindingSha256', issues);
    requireReference(source.recoverySetReference, 'source.recoverySetReference', issues);
  }

  const target = requireObject(root.target, 'target', TARGET_KEYS, issues);
  const validatedTarget = { restoreTargetType: '', databaseIdentitySha256: '', objectStoreIdentitySha256: '' };
  if (target) {
    if (target.environment !== 'non-production') issues.push('target.environment must be non-production');
    if (target.restoreTargetType !== TARGET_TYPE) issues.push(`target.restoreTargetType must be ${TARGET_TYPE}`);
    validatedTarget.restoreTargetType = target.restoreTargetType;
    if (target.isolated !== true) issues.push('target.isolated must be true');
    validatedTarget.databaseIdentitySha256 = requireSha256(target.databaseIdentitySha256, 'target.databaseIdentitySha256', issues);
    validatedTarget.objectStoreIdentitySha256 = requireSha256(target.objectStoreIdentitySha256, 'target.objectStoreIdentitySha256', issues);
    if (sourceDatabaseIdentity && validatedTarget.databaseIdentitySha256 === sourceDatabaseIdentity) {
      issues.push('target database identity must differ from the production source identity');
    }
    if (sourceObjectIdentity && validatedTarget.objectStoreIdentitySha256 === sourceObjectIdentity) {
      issues.push('target object-store identity must differ from the production source identity');
    }
    requireReference(target.isolationEvidenceReference, 'target.isolationEvidenceReference', issues);
  }

  validateControls(root.backupControls, issues);
  const objectives = validateObjectives(root.objectives, issues);
  const restoreTimes = validateRestore(root.restore, bindings, issues);

  let computedSummary = null;
  const captureTimes = {
    sourceMetadataCapturedAt: null,
    sourceMetadataCapturedAtText: '',
    restoredMetadataCapturedAt: null,
    restoredMetadataCapturedAtText: '',
    sourceObjectInventoryCapturedAt: null,
    sourceObjectInventoryCapturedAtText: '',
    restoredObjectInventoryCapturedAt: null,
    restoredObjectInventoryCapturedAtText: '',
    sourceMetadataCaptureTransactionId: '',
    restoredMetadataCaptureTransactionId: '',
  };
  let reconciliationReportReference = '';
  const reconciliation = requireObject(root.reconciliation, 'reconciliation', RECONCILIATION_KEYS, issues);
  if (reconciliation) {
    if (reconciliation.checksumAlgorithm !== DOCUMENT_RECOVERY_HASH_CONTRACT.algorithm) {
      issues.push('reconciliation.checksumAlgorithm must be sha256');
    }
    reconciliationReportReference = requireReference(
      reconciliation.reportReference,
      'reconciliation.reportReference',
      issues,
    );
    const metadataInventory = requireObject(reconciliation.metadataInventory, 'reconciliation.metadataInventory', DATABASE_INVENTORY_KEYS, issues);
    const objectInventory = requireObject(reconciliation.objectInventory, 'reconciliation.objectInventory', INVENTORY_KEYS, issues);
    const storageDeletionInventory = requireObject(
      reconciliation.storageDeletionInventory,
      'reconciliation.storageDeletionInventory',
      DATABASE_INVENTORY_KEYS,
      issues,
    );
    const storageDeletionRecoveryInventory = requireObject(
      reconciliation.storageDeletionRecoveryInventory,
      'reconciliation.storageDeletionRecoveryInventory',
      DATABASE_INVENTORY_KEYS,
      issues,
    );
    if (metadataInventory && objectInventory && storageDeletionInventory && storageDeletionRecoveryInventory) {
      if (metadataInventory.inventoryScope !== 'complete-document-table') {
        issues.push('reconciliation.metadataInventory.inventoryScope must be complete-document-table');
      }
      if (objectInventory.inventoryScope !== 'complete-whole-bucket') {
        issues.push('reconciliation.objectInventory.inventoryScope must be complete-whole-bucket');
      }
      if (storageDeletionInventory.inventoryScope !== 'complete-storage-deletion-table') {
        issues.push('reconciliation.storageDeletionInventory.inventoryScope must be complete-storage-deletion-table');
      }
      if (storageDeletionRecoveryInventory.inventoryScope !== 'complete-storage-deletion-recovery-table') {
        issues.push('reconciliation.storageDeletionRecoveryInventory.inventoryScope must be complete-storage-deletion-recovery-table');
      }
      captureTimes.sourceMetadataCapturedAt = requireTimestamp(
        metadataInventory.sourceCapturedAt,
        'reconciliation.metadataInventory.sourceCapturedAt',
        issues,
      );
      captureTimes.sourceMetadataCapturedAtText = captureTimes.sourceMetadataCapturedAt === null
        ? ''
        : metadataInventory.sourceCapturedAt;
      captureTimes.restoredMetadataCapturedAt = requireTimestamp(
        metadataInventory.restoredCapturedAt,
        'reconciliation.metadataInventory.restoredCapturedAt',
        issues,
      );
      captureTimes.restoredMetadataCapturedAtText = captureTimes.restoredMetadataCapturedAt === null
        ? ''
        : metadataInventory.restoredCapturedAt;
      captureTimes.sourceMetadataCaptureTransactionId = requireTransactionId(
        metadataInventory.sourceCaptureTransactionId,
        'reconciliation.metadataInventory.sourceCaptureTransactionId',
        issues,
      );
      captureTimes.restoredMetadataCaptureTransactionId = requireTransactionId(
        metadataInventory.restoredCaptureTransactionId,
        'reconciliation.metadataInventory.restoredCaptureTransactionId',
        issues,
      );
      captureTimes.sourceObjectInventoryCapturedAt = requireTimestamp(
        objectInventory.sourceCapturedAt,
        'reconciliation.objectInventory.sourceCapturedAt',
        issues,
      );
      captureTimes.sourceObjectInventoryCapturedAtText = captureTimes.sourceObjectInventoryCapturedAt === null
        ? ''
        : objectInventory.sourceCapturedAt;
      captureTimes.restoredObjectInventoryCapturedAt = requireTimestamp(
        objectInventory.restoredCapturedAt,
        'reconciliation.objectInventory.restoredCapturedAt',
        issues,
      );
      captureTimes.restoredObjectInventoryCapturedAtText = captureTimes.restoredObjectInventoryCapturedAt === null
        ? ''
        : objectInventory.restoredCapturedAt;
      if (storageDeletionInventory.sourceCapturedAt !== metadataInventory.sourceCapturedAt) {
        issues.push('reconciliation.storageDeletionInventory.sourceCapturedAt must equal the source metadata capture');
      }
      if (storageDeletionInventory.restoredCapturedAt !== metadataInventory.restoredCapturedAt) {
        issues.push('reconciliation.storageDeletionInventory.restoredCapturedAt must equal the restored metadata capture');
      }
      for (const [inventory, inventoryPath] of [
        [storageDeletionInventory, 'reconciliation.storageDeletionInventory'],
        [storageDeletionRecoveryInventory, 'reconciliation.storageDeletionRecoveryInventory'],
      ]) {
        if (inventory.sourceCapturedAt !== metadataInventory.sourceCapturedAt) {
          issues.push(`${inventoryPath}.sourceCapturedAt must equal the source metadata capture`);
        }
        if (inventory.restoredCapturedAt !== metadataInventory.restoredCapturedAt) {
          issues.push(`${inventoryPath}.restoredCapturedAt must equal the restored metadata capture`);
        }
        if (inventory.sourceCaptureTransactionId !== metadataInventory.sourceCaptureTransactionId) {
          issues.push(`${inventoryPath}.sourceCaptureTransactionId must equal the source metadata capture transaction`);
        }
        if (inventory.restoredCaptureTransactionId !== metadataInventory.restoredCaptureTransactionId) {
          issues.push(`${inventoryPath}.restoredCaptureTransactionId must equal the restored metadata capture transaction`);
        }
      }
      const expectedMetadata = validateMetadataInventory(metadataInventory.expected, 'reconciliation.metadataInventory.expected', issues);
      const restoredMetadata = validateMetadataInventory(metadataInventory.restored, 'reconciliation.metadataInventory.restored', issues);
      const expectedObjects = validateObjectInventory(objectInventory.expected, 'reconciliation.objectInventory.expected', issues);
      const restoredObjects = validateObjectInventory(objectInventory.restored, 'reconciliation.objectInventory.restored', issues);
      const expectedStorageDeletions = validateStorageDeletionInventory(
        storageDeletionInventory.expected,
        'reconciliation.storageDeletionInventory.expected',
        issues,
      );
      const restoredStorageDeletions = validateStorageDeletionInventory(
        storageDeletionInventory.restored,
        'reconciliation.storageDeletionInventory.restored',
        issues,
      );
      const expectedRecoveryEvents = validateStorageDeletionRecoveryInventory(
        storageDeletionRecoveryInventory.expected,
        'reconciliation.storageDeletionRecoveryInventory.expected',
        issues,
      );
      const restoredRecoveryEvents = validateStorageDeletionRecoveryInventory(
        storageDeletionRecoveryInventory.restored,
        'reconciliation.storageDeletionRecoveryInventory.restored',
        issues,
      );
      validateRecoveryLinks(
        expectedStorageDeletions,
        expectedRecoveryEvents,
        'reconciliation source recovery inventory',
        issues,
        {
          capturedAt: captureTimes.sourceMetadataCapturedAtText,
          captureTransactionId: captureTimes.sourceMetadataCaptureTransactionId,
          enforceCaptureTransactionOrder: true,
        },
      );
      validateRecoveryLinks(
        restoredStorageDeletions,
        restoredRecoveryEvents,
        'reconciliation restored recovery inventory',
        issues,
        {
          capturedAt: captureTimes.restoredMetadataCapturedAtText,
          captureTransactionId: captureTimes.restoredMetadataCaptureTransactionId,
        },
      );
      const computedMetadataInventorySha256 = captureTimes.sourceMetadataCapturedAtText
        && captureTimes.sourceMetadataCaptureTransactionId
        ? canonicalMetadataInventorySha256(
            expectedMetadata,
            captureTimes.sourceMetadataCapturedAtText,
            captureTimes.sourceMetadataCaptureTransactionId,
          )
        : '';
      bindings.restoredMetadataInventorySha256 = captureTimes.restoredMetadataCapturedAtText
        && captureTimes.restoredMetadataCaptureTransactionId
        ? canonicalMetadataInventorySha256(
            restoredMetadata,
            captureTimes.restoredMetadataCapturedAtText,
            captureTimes.restoredMetadataCaptureTransactionId,
          )
        : '';
      const computedObjectInventorySha256 = captureTimes.sourceObjectInventoryCapturedAtText
        ? canonicalObjectInventorySha256(expectedObjects, captureTimes.sourceObjectInventoryCapturedAtText)
        : '';
      bindings.restoredObjectInventorySha256 = captureTimes.restoredObjectInventoryCapturedAtText
        ? canonicalObjectInventorySha256(restoredObjects, captureTimes.restoredObjectInventoryCapturedAtText)
        : '';
      const computedStorageDeletionInventorySha256 = captureTimes.sourceMetadataCapturedAtText
        && captureTimes.sourceMetadataCaptureTransactionId
        ? canonicalStorageDeletionInventorySha256(
            expectedStorageDeletions,
            captureTimes.sourceMetadataCapturedAtText,
            captureTimes.sourceMetadataCaptureTransactionId,
          )
        : '';
      bindings.restoredStorageDeletionInventorySha256 = captureTimes.restoredMetadataCapturedAtText
        && captureTimes.restoredMetadataCaptureTransactionId
        ? canonicalStorageDeletionInventorySha256(
            restoredStorageDeletions,
            captureTimes.restoredMetadataCapturedAtText,
            captureTimes.restoredMetadataCaptureTransactionId,
          )
        : '';
      const computedRecoveryEventInventorySha256 = captureTimes.sourceMetadataCapturedAtText
        && captureTimes.sourceMetadataCaptureTransactionId
        ? canonicalStorageDeletionRecoveryInventorySha256(
            expectedRecoveryEvents,
            captureTimes.sourceMetadataCapturedAtText,
            captureTimes.sourceMetadataCaptureTransactionId,
          )
        : '';
      bindings.restoredRecoveryEventInventorySha256 = captureTimes.restoredMetadataCapturedAtText
        && captureTimes.restoredMetadataCaptureTransactionId
        ? canonicalStorageDeletionRecoveryInventorySha256(
            restoredRecoveryEvents,
            captureTimes.restoredMetadataCapturedAtText,
            captureTimes.restoredMetadataCaptureTransactionId,
          )
        : '';
      computedSummary = reconcileInventories(
        expectedMetadata,
        restoredMetadata,
        expectedObjects,
        restoredObjects,
        expectedStorageDeletions,
        restoredStorageDeletions,
        expectedRecoveryEvents,
        restoredRecoveryEvents,
      );
      validateReportedSummary(reconciliation.reportedSummary, computedSummary, issues);
      if (bindings.productionDocumentCount !== null && bindings.productionDocumentCount !== expectedMetadata.length) {
        issues.push('source.productionDocumentCount must equal the complete expected metadata inventory length');
      }
      if (bindings.expectedMetadataInventorySha256 && bindings.expectedMetadataInventorySha256 !== computedMetadataInventorySha256) {
        issues.push('source.metadataInventorySha256 must match the canonical expected metadata inventory');
      }
      if (bindings.expectedObjectInventorySha256 && bindings.expectedObjectInventorySha256 !== computedObjectInventorySha256) {
        issues.push('source.objectInventorySha256 must match the canonical expected object inventory');
      }
      if (
        bindings.expectedStorageDeletionInventorySha256 &&
        bindings.expectedStorageDeletionInventorySha256 !== computedStorageDeletionInventorySha256
      ) {
        issues.push('source.storageDeletionInventorySha256 must match the canonical source storage-deletion inventory');
      }
      if (
        bindings.expectedRecoveryEventInventorySha256 &&
        bindings.expectedRecoveryEventInventorySha256 !== computedRecoveryEventInventorySha256
      ) {
        issues.push('source.recoveryEventInventorySha256 must match the canonical source recovery-event inventory');
      }
      for (const [declared, computed, path] of [
        [metadataInventory.sourceInventorySha256, computedMetadataInventorySha256, 'reconciliation.metadataInventory.sourceInventorySha256'],
        [metadataInventory.restoredInventorySha256, bindings.restoredMetadataInventorySha256, 'reconciliation.metadataInventory.restoredInventorySha256'],
        [objectInventory.sourceInventorySha256, computedObjectInventorySha256, 'reconciliation.objectInventory.sourceInventorySha256'],
        [objectInventory.restoredInventorySha256, bindings.restoredObjectInventorySha256, 'reconciliation.objectInventory.restoredInventorySha256'],
        [storageDeletionInventory.sourceInventorySha256, computedStorageDeletionInventorySha256, 'reconciliation.storageDeletionInventory.sourceInventorySha256'],
        [storageDeletionInventory.restoredInventorySha256, bindings.restoredStorageDeletionInventorySha256, 'reconciliation.storageDeletionInventory.restoredInventorySha256'],
        [storageDeletionRecoveryInventory.sourceInventorySha256, computedRecoveryEventInventorySha256, 'reconciliation.storageDeletionRecoveryInventory.sourceInventorySha256'],
        [storageDeletionRecoveryInventory.restoredInventorySha256, bindings.restoredRecoveryEventInventorySha256, 'reconciliation.storageDeletionRecoveryInventory.restoredInventorySha256'],
      ]) {
        const declaredDigest = requireSha256(declared, path, issues);
        if (declaredDigest && computed && declaredDigest !== computed) issues.push(`${path} must match its canonical captured inventory`);
      }
      const expectedStateCounts = {
        storageDeletionCount: expectedStorageDeletions.length,
        pendingStorageDeletionCount: computedSummary.sourcePendingStorageDeletionCount,
        deadLetterStorageDeletionCount: computedSummary.sourceDeadLetterStorageDeletionCount,
        processedStorageDeletionCount: computedSummary.sourceProcessedStorageDeletionCount,
        recoveryEventCount: expectedRecoveryEvents.length,
      };
      for (const [key, expected] of Object.entries(expectedStateCounts)) {
        if (bindings[key] !== null && bindings[key] !== expected) {
          issues.push(`source.${key} must match the complete source storage-deletion inventory`);
        }
      }
      for (const key of [
        'missingMetadataRows',
        'unexpectedMetadataRows',
        'missingObjectCount',
        'unexpectedObjectCount',
        'metadataMismatchCount',
        'objectKeyMismatchCount',
        'sizeMismatchCount',
        'checksumMismatchCount',
        'orphanExpectedObjectCount',
        'orphanRestoredObjectCount',
        'missingStorageDeletionRows',
        'unexpectedStorageDeletionRows',
        'storageDeletionMismatchCount',
        'sourcePendingStorageDeletionCount',
        'sourceDeadLetterStorageDeletionCount',
        'restoredPendingStorageDeletionCount',
        'restoredDeadLetterStorageDeletionCount',
        'processedDeletionObjectResidueCount',
        'missingRecoveryEventRows',
        'unexpectedRecoveryEventRows',
        'recoveryEventMismatchCount',
      ]) {
        if (computedSummary[key] !== 0) issues.push(`computed reconciliation requires ${key} to be zero`);
      }
      if (
        computedSummary.expectedMetadataRows !== computedSummary.restoredMetadataRows ||
        computedSummary.expectedMetadataRows !== computedSummary.matchedMetadataRows ||
        computedSummary.expectedObjectCount !== computedSummary.restoredObjectCount ||
        computedSummary.expectedObjectCount !== computedSummary.matchedObjectCount ||
        computedSummary.expectedMetadataRows !== computedSummary.expectedObjectCount
      ) {
        issues.push('complete database metadata and independent document-object inventories must match exactly');
      }
      if (
        computedSummary.expectedRecoveryEventRows !== computedSummary.restoredRecoveryEventRows ||
        computedSummary.expectedRecoveryEventRows !== computedSummary.matchedRecoveryEventRows
      ) {
        issues.push('source and restored DocumentStorageDeletionRecovery inventories must match exactly');
      }
      if (
        computedSummary.expectedStorageDeletionRows !== computedSummary.restoredStorageDeletionRows ||
        computedSummary.expectedStorageDeletionRows !== computedSummary.matchedStorageDeletionRows
      ) {
        issues.push('source and restored DocumentStorageDeletion lifecycle inventories must match exactly');
      }
    }
  }

  if (
    bindings.exerciseId &&
    bindings.recoverySetId &&
    bindings.sourceCaptureReportSha256 &&
    bindings.sourceDatabaseIdentitySha256 &&
    bindings.sourceObjectStoreIdentitySha256 &&
    bindings.databaseDumpSha256 &&
    bindings.objectBackupManifestSha256 &&
    bindings.productionDocumentCount !== null &&
    bindings.storageDeletionCount !== null &&
    bindings.pendingStorageDeletionCount !== null &&
    bindings.deadLetterStorageDeletionCount !== null &&
    bindings.processedStorageDeletionCount !== null &&
    bindings.recoveryEventCount !== null &&
    maximumDocumentProofAgeMinutes !== null &&
    captureTimes.sourceMetadataCapturedAtText &&
    captureTimes.restoredMetadataCapturedAtText &&
    captureTimes.sourceObjectInventoryCapturedAtText &&
    captureTimes.restoredObjectInventoryCapturedAtText &&
    captureTimes.sourceMetadataCaptureTransactionId &&
    captureTimes.restoredMetadataCaptureTransactionId &&
    bindings.expectedMetadataInventorySha256 &&
    bindings.restoredMetadataInventorySha256 &&
    bindings.expectedObjectInventorySha256 &&
    bindings.restoredObjectInventorySha256 &&
    bindings.expectedStorageDeletionInventorySha256 &&
    bindings.restoredStorageDeletionInventorySha256 &&
    bindings.expectedRecoveryEventInventorySha256 &&
    bindings.restoredRecoveryEventInventorySha256
  ) {
    const computedSourceBinding = canonicalSourceBindingSha256({
      exerciseId: bindings.exerciseId,
      recoverySetId: bindings.recoverySetId,
      sourceCaptureReportSha256: bindings.sourceCaptureReportSha256,
      databaseIdentitySha256: bindings.sourceDatabaseIdentitySha256,
      objectStoreIdentitySha256: bindings.sourceObjectStoreIdentitySha256,
      databaseDumpSha256: bindings.databaseDumpSha256,
      objectBackupManifestSha256: bindings.objectBackupManifestSha256,
      productionDocumentCount: bindings.productionDocumentCount,
      storageDeletionCount: bindings.storageDeletionCount,
      pendingStorageDeletionCount: bindings.pendingStorageDeletionCount,
      deadLetterStorageDeletionCount: bindings.deadLetterStorageDeletionCount,
      processedStorageDeletionCount: bindings.processedStorageDeletionCount,
      recoveryEventCount: bindings.recoveryEventCount,
      maximumDocumentProofAgeMinutes,
      sourceMetadataCapturedAt: captureTimes.sourceMetadataCapturedAtText,
      restoredMetadataCapturedAt: captureTimes.restoredMetadataCapturedAtText,
      sourceObjectInventoryCapturedAt: captureTimes.sourceObjectInventoryCapturedAtText,
      restoredObjectInventoryCapturedAt: captureTimes.restoredObjectInventoryCapturedAtText,
      sourceMetadataCaptureTransactionId: captureTimes.sourceMetadataCaptureTransactionId,
      restoredMetadataCaptureTransactionId: captureTimes.restoredMetadataCaptureTransactionId,
      metadataInventorySha256: bindings.expectedMetadataInventorySha256,
      restoredMetadataInventorySha256: bindings.restoredMetadataInventorySha256,
      objectInventorySha256: bindings.expectedObjectInventorySha256,
      restoredObjectInventorySha256: bindings.restoredObjectInventorySha256,
      storageDeletionInventorySha256: bindings.expectedStorageDeletionInventorySha256,
      restoredStorageDeletionInventorySha256: bindings.restoredStorageDeletionInventorySha256,
      recoveryEventInventorySha256: bindings.expectedRecoveryEventInventorySha256,
      restoredRecoveryEventInventorySha256: bindings.restoredRecoveryEventInventorySha256,
    });
    if (bindings.sourceBindingSha256 && bindings.sourceBindingSha256 !== computedSourceBinding) {
      issues.push('source.sourceBindingSha256 must bind all four capture times, freshness policy, source identities, recovery set, backup artifacts, complete inventories, and storage-deletion lifecycle counts');
    }
  }

  const attestations = requireObject(root.attestations, 'attestations', ATTESTATION_KEYS, issues);
  let attestedAt = null;
  let recoveryOperator = '';
  if (attestations) {
    if (attestations.productionDatabaseOverwritten !== false) issues.push('attestations.productionDatabaseOverwritten must be false');
    if (attestations.productionObjectStoreOverwritten !== false) issues.push('attestations.productionObjectStoreOverwritten must be false');
    if (attestations.restoreCredentialsScopedToTarget !== true) issues.push('attestations.restoreCredentialsScopedToTarget must be true');
    recoveryOperator = requireText(attestations.attestedBy, 'attestations.attestedBy', issues, { max: 200 });
    attestedAt = requireTimestamp(attestations.attestedAt, 'attestations.attestedAt', issues);
    requireReference(attestations.productionProtectionEvidenceReference, 'attestations.productionProtectionEvidenceReference', issues);
    if (attestations.acknowledgement !== ACKNOWLEDGEMENT) {
      issues.push('attestations.acknowledgement must exactly confirm isolated non-production recovery and no production overwrite');
    }
  }

  const chronology = validateChronology({
    exerciseTimes,
    restoreTimes,
    objectives,
    captureTimes,
    attestedAt,
    maximumSkewMinutes,
    maximumDocumentProofAgeMinutes,
    now: Number.isFinite(nowMs) ? nowMs : Date.now(),
  }, issues);
  const objectiveResults = chronology.objectiveResults;
  const documentProof = chronology.documentProof;

  let reconciliationReportSha256 = '';
  if (computedSummary && exercise?.completedAt) {
    reconciliationReportSha256 = canonicalReconciliationReportSha256({
      bindings,
      summary: computedSummary,
      target: validatedTarget,
      objectiveResults,
      captureTimes,
      maximumSkewMinutes,
      maximumDocumentProofAgeMinutes,
      documentProof,
      reconciledAt: exercise.completedAt,
    });
  }
  if (
    reconciliationReportSha256 &&
    reconciliationReportReference &&
    !referenceContainsDigest(reconciliationReportReference, reconciliationReportSha256)
  ) {
    issues.push('reconciliation.reportReference must contain the exact reconciliationReportSha256 as an immutable path segment');
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: computedSummary,
    bindings,
    objectiveResults,
    captureTimes: {
      sourceMetadataCapturedAt: captureTimes.sourceMetadataCapturedAtText || null,
      restoredMetadataCapturedAt: captureTimes.restoredMetadataCapturedAtText || null,
      sourceObjectInventoryCapturedAt: captureTimes.sourceObjectInventoryCapturedAtText || null,
      restoredObjectInventoryCapturedAt: captureTimes.restoredObjectInventoryCapturedAtText || null,
      sourceMetadataCaptureTransactionId: captureTimes.sourceMetadataCaptureTransactionId || null,
      restoredMetadataCaptureTransactionId: captureTimes.restoredMetadataCaptureTransactionId || null,
    },
    maximumDocumentProofAgeMinutes,
    documentProof,
    reconciliationReportSha256,
    reconciledAt: exercise?.completedAt ?? null,
    ownerRecorded: Boolean(exerciseOwner),
    recoveryOperatorRecorded: Boolean(recoveryOperator),
  };
}

function nextJsonToken(text, state) {
  while (/\s/.test(text[state.index] ?? '')) state.index += 1;
  if (state.index >= text.length) return { type: 'eof' };
  const character = text[state.index];
  if ('{}[]:,'.includes(character)) {
    state.index += 1;
    return { type: character };
  }
  if (character === '"') {
    const start = state.index;
    state.index += 1;
    while (state.index < text.length) {
      const current = text[state.index];
      if (current === '"') {
        state.index += 1;
        return { type: 'string', value: JSON.parse(text.slice(start, state.index)) };
      }
      if (current === '\\') {
        state.index += 1;
        if (state.index >= text.length) throw new Error('unterminated escape');
        if (text[state.index] === 'u') {
          if (!/^[a-f0-9]{4}$/i.test(text.slice(state.index + 1, state.index + 5))) throw new Error('invalid unicode escape');
          state.index += 5;
        } else {
          if (!/["\\/bfnrt]/.test(text[state.index])) throw new Error('invalid escape');
          state.index += 1;
        }
        continue;
      }
      if (current.charCodeAt(0) < 0x20) throw new Error('control character in string');
      state.index += 1;
    }
    throw new Error('unterminated string');
  }
  const token = text.slice(state.index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/)?.[0];
  if (!token) throw new Error('invalid token');
  state.index += token.length;
  return { type: 'primitive' };
}

function acceptValueToken(token, stack, issues) {
  if (token.type === '{') {
    if (stack.length >= MAX_JSON_NESTING + 1) {
      issues.push(`manifest exceeds the maximum JSON nesting depth of ${MAX_JSON_NESTING}`);
      return false;
    }
    stack.push({ type: 'object', state: 'keyOrEnd', seen: new Set() });
    return true;
  }
  if (token.type === '[') {
    if (stack.length >= MAX_JSON_NESTING + 1) {
      issues.push(`manifest exceeds the maximum JSON nesting depth of ${MAX_JSON_NESTING}`);
      return false;
    }
    stack.push({ type: 'array', state: 'valueOrEnd' });
    return true;
  }
  return token.type === 'string' || token.type === 'primitive';
}

export function jsonStructureIssues(rawText) {
  const issues = [];
  const state = { index: 0 };
  const stack = [{ type: 'root', state: 'value' }];
  try {
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const token = nextJsonToken(rawText, state);
      if (frame.type === 'root') {
        if (frame.state === 'value') {
          frame.state = 'done';
          if (!acceptValueToken(token, stack, issues)) throw new Error('root value');
          if (issues.length) return issues;
          continue;
        }
        if (token.type !== 'eof') throw new Error('trailing data');
        stack.pop();
        continue;
      }
      if (frame.type === 'object') {
        if (frame.state === 'keyOrEnd' || frame.state === 'key') {
          if (token.type === '}' && frame.state === 'keyOrEnd') {
            stack.pop();
            continue;
          }
          if (token.type !== 'string') throw new Error('object key');
          if (frame.seen.has(token.value)) issues.push('manifest contains duplicate object keys');
          frame.seen.add(token.value);
          frame.state = 'colon';
          continue;
        }
        if (frame.state === 'colon') {
          if (token.type !== ':') throw new Error('object colon');
          frame.state = 'value';
          continue;
        }
        if (frame.state === 'value') {
          frame.state = 'commaOrEnd';
          if (!acceptValueToken(token, stack, issues)) throw new Error('object value');
          if (issues.length && issues.some((issue) => issue.includes('nesting depth'))) return issues;
          continue;
        }
        if (token.type === '}') {
          stack.pop();
          continue;
        }
        if (token.type !== ',') throw new Error('object comma');
        frame.state = 'key';
        continue;
      }
      if (frame.state === 'valueOrEnd' || frame.state === 'value') {
        if (token.type === ']' && frame.state === 'valueOrEnd') {
          stack.pop();
          continue;
        }
        frame.state = 'commaOrEnd';
        if (!acceptValueToken(token, stack, issues)) throw new Error('array value');
        if (issues.length && issues.some((issue) => issue.includes('nesting depth'))) return issues;
        continue;
      }
      if (token.type === ']') {
        stack.pop();
        continue;
      }
      if (token.type !== ',') throw new Error('array comma');
      frame.state = 'value';
    }
  } catch {
    issues.push('manifest JSON structure could not be scanned safely');
  }
  return [...new Set(issues)];
}

export function duplicateJsonKeyIssues(rawText) {
  return jsonStructureIssues(rawText).filter((issue) => issue.includes('duplicate object keys'));
}

export function redactDocumentRecoveryTranscript(value) {
  return String(value)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gi, '[redacted-private-key]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"\)]+/gi, '[redacted-database-url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic [redacted]')
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]+/g, '[redacted-provider-key]')
    .replace(/\bsk-(?:proj-|svcacct-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}/gi, '[redacted-provider-key]')
    .replace(/\bwhsec_[A-Za-z0-9_=-]+/g, '[redacted-provider-secret]')
    .replace(/\bre_[A-Za-z0-9_=-]+/g, '[redacted-provider-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, '[redacted-github-token]')
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, '[redacted-gitlab-token]')
    .replace(/\bnpm_[A-Za-z0-9]+/g, '[redacted-npm-token]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+/gi, '[redacted-slack-token]')
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/gi, '[redacted-slack-webhook]')
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/gi, '[redacted-supabase-key]')
    .replace(/\bSG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-sendgrid-key]')
    .replace(/\bAIza[A-Za-z0-9_-]+/g, '[redacted-google-key]')
    .replace(/\bSK[a-f0-9]{32}\b/gi, '[redacted-provider-key]')
    .replace(/\bshpat_[A-Za-z0-9]{20,}/gi, '[redacted-shopify-token]')
    .replace(/\bkey-[A-Za-z0-9]{20,}/gi, '[redacted-provider-key]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted-aws-access-key]')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|credential|jwt|key|password|refresh[_-]?token|secret|signature|sig|token|x-amz-credential|x-amz-signature)=)[^&\s'"\)]+/gi, '$1[redacted]')
    .replace(/(\b(?:client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|credential|private[_-]?key|password|refresh[_-]?token|secret|secret[_-]?key|service[_-]?role[_-]?key|signing[_-]?secret|token)\b["']?\s*[=:]\s*["']?)[^\s,'"}\]]+/gi, '$1[redacted]')
    .replace(/\b(AccountKey=)[A-Za-z0-9+/=]+/gi, '$1[redacted]')
    .replace(/(\bAWS[_-]?SECRET[_-]?ACCESS[_-]?KEY\s*[=:]\s*["']?)[^\s,'"}\]]+/gi, '$1[redacted]')
    .replace(/\b((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DATABASE_URL|JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|RESEND_API_KEY|PASSWORD)\s*[=:]\s*)[^\s,'"}]+/gi, '$1[redacted]');
}

function parseArgs(args) {
  const options = { json: false, manifestFile: null, help: false };
  const flagMap = new Map([
    ['--manifest-file', ['manifestFile', 'path']],
    ...REQUIRED_BINDING_FLAGS.map(([flag, key, type]) => [flag, [key, type]]),
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      if (options.json) throw new Error('--json must be provided at most once');
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      if (options.help) throw new Error('--help must be provided at most once');
      options.help = true;
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const definition = flagMap.get(flag);
    if (!definition) throw new Error('Unknown option');
    let value = equalsIndex === -1 ? args[index + 1] : arg.slice(equalsIndex + 1);
    if (!value || (equalsIndex === -1 && value.startsWith('--'))) throw new Error(`${flag} requires a value`);
    if (equalsIndex === -1) index += 1;
    const [key, type] = definition;
    if (options[key] !== undefined && options[key] !== null) throw new Error(`${flag} must be provided exactly once`);
    if (type === 'sha256' && !SHA256_PATTERN.test(value)) throw new Error(`${flag} must be a lowercase SHA-256 digest`);
    if (type === 'count') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_INVENTORY_ENTRIES) {
        throw new Error(`${flag} must be a positive bounded integer`);
      }
      value = Number(value);
    }
    if (type === 'nonnegativeCount') {
      if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_INVENTORY_ENTRIES) {
        throw new Error(`${flag} must be a nonnegative bounded integer`);
      }
      value = Number(value);
    }
    if (type === 'proofAge') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_DOCUMENT_PROOF_AGE_MINUTES) {
        throw new Error(`${flag} must be a positive bounded document-proof age`);
      }
      value = Number(value);
    }
    if (type === 'timestamp') {
      if (!ISO_TIMESTAMP_PATTERN.test(value) || new Date(value).toISOString() !== value) {
        throw new Error(`${flag} must be an ISO-8601 UTC timestamp with milliseconds`);
      }
    }
    if (type === 'transactionId') {
      if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > MAX_POSTGRES_BIGINT) {
        throw new Error(`${flag} must be a canonical bounded decimal transaction identifier`);
      }
    }
    if (type === 'id' && !IDENTIFIER_PATTERN.test(value)) throw new Error(`${flag} must be a bounded operational identifier`);
    options[key] = value;
  }
  if (options.help) return options;
  if (!options.manifestFile) throw new Error('--manifest-file is required');
  for (const [flag, key] of REQUIRED_BINDING_FLAGS) {
    if (options[key] === undefined || options[key] === null) throw new Error(`${flag} is required`);
  }
  return options;
}

function windowsStylePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

export function isPathWithinRoot(path, root) {
  const useWindows = windowsStylePath(path) || windowsStylePath(root);
  const relativePath = useWindows ? win32.relative(root, path) : relative(root, path);
  const relativeIsAbsolute = useWindows ? win32.isAbsolute(relativePath) : isAbsolute(relativePath);
  const parentPrefix = useWindows ? `..${win32.sep}` : `..${sep}`;
  return relativePath === '' || (!relativeIsAbsolute && relativePath !== '..' && !relativePath.startsWith(parentPrefix));
}

export function gitCommandResultIsConclusive(commandResult) {
  return (
    commandResult &&
    !commandResult.error &&
    commandResult.signal === null &&
    (commandResult.status === 0 || commandResult.status === 1)
  );
}

function defaultGitPathStatus(repoRoot, relativePath) {
  const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', relativePath], { stdio: 'ignore' });
  const ignored = spawnSync('git', ['-C', repoRoot, 'check-ignore', '-q', '--', relativePath], { stdio: 'ignore' });
  return {
    available: gitCommandResultIsConclusive(tracked) && gitCommandResultIsConclusive(ignored),
    tracked: tracked.status === 0,
    ignored: ignored.status === 0,
  };
}

export function manifestStorageIssues(manifestPath, { repoRoot = defaultRepoRoot, gitPathStatus = defaultGitPathStatus } = {}) {
  if (!isPathWithinRoot(manifestPath, repoRoot)) return [];
  const relativePath = relative(repoRoot, manifestPath).replaceAll('\\', '/');
  const status = gitPathStatus(repoRoot, relativePath);
  const issues = [];
  if (!status?.available) return ['in-repository recovery evidence requires conclusive Git ignore and tracking checks'];
  if (status.tracked) issues.push('recovery evidence must not be tracked by Git');
  if (!status.ignored) issues.push('in-repository recovery evidence must be stored at an ignored path');
  return issues;
}

function fileIdentity(stats) {
  const dev = stats?.dev;
  const ino = stats?.ino;
  const validDev = typeof dev === 'bigint' ? dev >= 0n : Number.isSafeInteger(dev) && dev >= 0;
  const validIno = typeof ino === 'bigint' ? ino > 0n : Number.isSafeInteger(ino) && ino > 0;
  if (!validDev || !validIno) return null;
  return `${String(dev)}:${String(ino)}`;
}

function stableFileFacts(stats) {
  return {
    identity: fileIdentity(stats),
    size: Number(stats.size),
    mtimeNs: typeof stats.mtimeNs === 'bigint' ? stats.mtimeNs : BigInt(Math.trunc(Number(stats.mtimeMs) * 1_000_000)),
    ctimeNs: typeof stats.ctimeNs === 'bigint' ? stats.ctimeNs : BigInt(Math.trunc(Number(stats.ctimeMs) * 1_000_000)),
    mode: Number(stats.mode),
    uid: stats.uid === undefined ? null : Number(stats.uid),
  };
}

function sameStableFileFacts(left, right) {
  return (
    left.identity !== null &&
    left.identity === right.identity &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function posixOwnerModeIssues(facts, { platform = process.platform, currentUid } = {}) {
  if (platform === 'win32') return [];
  const issues = [];
  if ((facts.mode & 0o777) !== 0o600) issues.push('manifest file permissions must be owner-only mode 0600');
  const expectedUid = currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (expectedUid !== null && facts.uid !== expectedUid) {
    issues.push('manifest file must be owned by the current POSIX user');
  }
  return issues;
}

export function readStableManifest(
  requestedPath,
  {
    repoRoot = defaultRepoRoot,
    gitPathStatus = defaultGitPathStatus,
    pathLstat = (path) => lstatSync(path, { bigint: true }),
    openFile = (path, flags) => openSync(path, flags),
    closeFile = closeSync,
    descriptorStat = (descriptor) => fstatSync(descriptor, { bigint: true }),
    pathStat = (path) => statSync(path, { bigint: true }),
    resolveRealPath = realpathSync,
    readDescriptor = readSync,
    platform = process.platform,
    currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
  } = {},
) {
  let descriptor;
  try {
    const pathBeforeOpenStats = pathLstat(requestedPath);
    if (pathBeforeOpenStats.isSymbolicLink() || !pathBeforeOpenStats.isFile()) {
      return { issues: ['manifest path must identify a regular non-symbolic-link file'] };
    }
    const pathBeforeOpen = stableFileFacts(pathBeforeOpenStats);
    if (!pathBeforeOpen.identity) return { issues: ['manifest path identity could not be proven conclusively'] };
    const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    descriptor = openFile(requestedPath, openFlags);
    const beforeStats = descriptorStat(descriptor);
    if (!beforeStats.isFile()) return { issues: ['manifest path must identify a regular file'] };
    const before = stableFileFacts(beforeStats);
    if (!before.identity) return { issues: ['manifest descriptor identity could not be proven conclusively'] };
    if (before.size <= 0) return { issues: ['manifest file must not be empty'] };
    if (before.size > MAX_MANIFEST_BYTES) return { issues: ['manifest file exceeds the maximum supported size'] };
    if (!sameStableFileFacts(pathBeforeOpen, before)) {
      return { issues: ['manifest path changed while it was being opened without following links'] };
    }
    const ownerModeIssues = posixOwnerModeIssues(before, { platform, currentUid });
    if (ownerModeIssues.length > 0) return { issues: ownerModeIssues };

    const resolvedPath = resolveRealPath(requestedPath);
    const resolvedBefore = stableFileFacts(pathStat(resolvedPath));
    if (!sameStableFileFacts(resolvedBefore, before)) {
      return { issues: ['manifest descriptor does not match the resolved policy target'] };
    }
    const policyIssuesBefore = manifestStorageIssues(resolvedPath, { repoRoot, gitPathStatus });
    if (policyIssuesBefore.length > 0) return { issues: policyIssuesBefore };

    const capacity = MAX_MANIFEST_BYTES + 1;
    const boundedBuffer = Buffer.allocUnsafe(capacity);
    let total = 0;
    while (total < capacity) {
      const bytesRead = readDescriptor(descriptor, boundedBuffer, total, capacity - total, total);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > capacity - total) {
        return { issues: ['manifest descriptor returned an invalid bounded-read result'] };
      }
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_MANIFEST_BYTES) return { issues: ['manifest file exceeds the maximum supported size'] };

    const afterStats = descriptorStat(descriptor);
    const after = stableFileFacts(afterStats);
    const resolvedAfterPath = resolveRealPath(requestedPath);
    const resolvedAfter = stableFileFacts(pathStat(resolvedAfterPath));
    const pathAfter = stableFileFacts(pathLstat(requestedPath));
    const policyIssuesAfter = manifestStorageIssues(resolvedAfterPath, { repoRoot, gitPathStatus });
    if (
      !sameStableFileFacts(before, after) ||
      !sameStableFileFacts(before, resolvedAfter) ||
      !sameStableFileFacts(before, pathAfter) ||
      resolvedPath !== resolvedAfterPath
    ) {
      return { issues: ['manifest path or descriptor identity changed during validation'] };
    }
    if (policyIssuesAfter.length > 0) return { issues: policyIssuesAfter };
    if (
      total !== before.size
    ) {
      return { issues: ['manifest file changed while it was being read'] };
    }

    const buffer = boundedBuffer.subarray(0, total);
    let rawText;
    try {
      rawText = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return { issues: ['manifest must use valid UTF-8 encoding'] };
    }
    return {
      buffer,
      rawText,
      sha256: sha256(buffer),
      resolvedPath,
      stableFacts: before,
      issues: [],
    };
  } catch {
    return { issues: ['manifest file could not be opened and validated through one stable descriptor'] };
  } finally {
    if (descriptor !== undefined) closeFile(descriptor);
  }
}

function independentBindingIssues(options, recoveryManifestSha256, validation) {
  const expectedPairs = [
    ['expectedRecoveryManifestSha256', recoveryManifestSha256, 'recovery manifest SHA-256'],
    ['expectedSourceBindingSha256', validation.bindings.sourceBindingSha256, 'source binding SHA-256'],
    ['expectedSourceCaptureReportSha256', validation.bindings.sourceCaptureReportSha256, 'source-capture report SHA-256'],
    ['expectedSourceDatabaseIdentitySha256', validation.bindings.sourceDatabaseIdentitySha256, 'source database identity SHA-256'],
    ['expectedSourceObjectStoreIdentitySha256', validation.bindings.sourceObjectStoreIdentitySha256, 'source object-store identity SHA-256'],
    ['expectedDatabaseDumpSha256', validation.bindings.databaseDumpSha256, 'database dump SHA-256'],
    ['expectedObjectBackupManifestSha256', validation.bindings.objectBackupManifestSha256, 'object-backup manifest SHA-256'],
    ['expectedMetadataInventorySha256', validation.bindings.expectedMetadataInventorySha256, 'metadata inventory SHA-256'],
    ['expectedObjectInventorySha256', validation.bindings.expectedObjectInventorySha256, 'object inventory SHA-256'],
    ['expectedRestoredMetadataInventorySha256', validation.bindings.restoredMetadataInventorySha256, 'restored metadata inventory SHA-256'],
    ['expectedRestoredObjectInventorySha256', validation.bindings.restoredObjectInventorySha256, 'restored object inventory SHA-256'],
    ['expectedStorageDeletionInventorySha256', validation.bindings.expectedStorageDeletionInventorySha256, 'storage-deletion inventory SHA-256'],
    ['expectedRestoredStorageDeletionInventorySha256', validation.bindings.restoredStorageDeletionInventorySha256, 'restored storage-deletion inventory SHA-256'],
    ['expectedRecoveryEventInventorySha256', validation.bindings.expectedRecoveryEventInventorySha256, 'recovery-event inventory SHA-256'],
    ['expectedRestoredRecoveryEventInventorySha256', validation.bindings.restoredRecoveryEventInventorySha256, 'restored recovery-event inventory SHA-256'],
    ['expectedProductionDocumentCount', validation.bindings.productionDocumentCount, 'production Document count'],
    ['expectedStorageDeletionCount', validation.bindings.storageDeletionCount, 'storage-deletion count'],
    ['expectedPendingStorageDeletionCount', validation.bindings.pendingStorageDeletionCount, 'pending storage-deletion count'],
    ['expectedDeadLetterStorageDeletionCount', validation.bindings.deadLetterStorageDeletionCount, 'dead-letter storage-deletion count'],
    ['expectedProcessedStorageDeletionCount', validation.bindings.processedStorageDeletionCount, 'processed storage-deletion count'],
    ['expectedRecoveryEventCount', validation.bindings.recoveryEventCount, 'recovery-event count'],
    ['expectedSourceMetadataCapturedAt', validation.captureTimes.sourceMetadataCapturedAt, 'source metadata capture timestamp'],
    ['expectedRestoredMetadataCapturedAt', validation.captureTimes.restoredMetadataCapturedAt, 'restored metadata capture timestamp'],
    ['expectedSourceObjectInventoryCapturedAt', validation.captureTimes.sourceObjectInventoryCapturedAt, 'source object-inventory capture timestamp'],
    ['expectedRestoredObjectInventoryCapturedAt', validation.captureTimes.restoredObjectInventoryCapturedAt, 'restored object-inventory capture timestamp'],
    ['expectedSourceMetadataCaptureTransactionId', validation.captureTimes.sourceMetadataCaptureTransactionId, 'source metadata capture transaction'],
    ['expectedRestoredMetadataCaptureTransactionId', validation.captureTimes.restoredMetadataCaptureTransactionId, 'restored metadata capture transaction'],
    ['expectedMaximumDocumentProofAgeMinutes', validation.maximumDocumentProofAgeMinutes, 'maximum document-proof age'],
    ['expectedExerciseId', validation.bindings.exerciseId, 'exercise identity'],
    ['expectedRecoverySetId', validation.bindings.recoverySetId, 'recovery-set identity'],
  ];
  return expectedPairs
    .filter(([optionKey, actual]) => options[optionKey] !== actual)
    .map(([, , label]) => `independently supplied ${label} does not match the recovery manifest`);
}

function failurePayload(issues) {
  return { ok: false, issueCount: issues.length, issues, secretValuesPrinted: false };
}

function successPayload({ recoveryManifestSha256, validation }) {
  return {
    ok: true,
    manifestFormat: MANIFEST_FORMAT,
    checksumAlgorithm: DOCUMENT_RECOVERY_HASH_CONTRACT.algorithm,
    recoveryManifestSha256,
    sourceBindingSha256: validation.bindings.sourceBindingSha256,
    sourceCaptureReportSha256: validation.bindings.sourceCaptureReportSha256,
    sourceDatabaseIdentitySha256: validation.bindings.sourceDatabaseIdentitySha256,
    sourceObjectStoreIdentitySha256: validation.bindings.sourceObjectStoreIdentitySha256,
    databaseDumpSha256: validation.bindings.databaseDumpSha256,
    objectBackupManifestSha256: validation.bindings.objectBackupManifestSha256,
    sourceMetadataInventorySha256: validation.bindings.expectedMetadataInventorySha256,
    restoredMetadataInventorySha256: validation.bindings.restoredMetadataInventorySha256,
    sourceObjectInventorySha256: validation.bindings.expectedObjectInventorySha256,
    restoredObjectInventorySha256: validation.bindings.restoredObjectInventorySha256,
    sourceStorageDeletionInventorySha256: validation.bindings.expectedStorageDeletionInventorySha256,
    restoredStorageDeletionInventorySha256: validation.bindings.restoredStorageDeletionInventorySha256,
    sourceRecoveryEventInventorySha256: validation.bindings.expectedRecoveryEventInventorySha256,
    restoredRecoveryEventInventorySha256: validation.bindings.restoredRecoveryEventInventorySha256,
    reconciliationReportSha256: validation.reconciliationReportSha256,
    exerciseId: validation.bindings.exerciseId,
    recoverySetId: validation.bindings.recoverySetId,
    metadataRowCount: validation.summary.expectedMetadataRows,
    expectedObjectCount: validation.summary.expectedObjectCount,
    restoredObjectCount: validation.summary.restoredObjectCount,
    matchedObjectCount: validation.summary.matchedObjectCount,
    missingObjectCount: validation.summary.missingObjectCount,
    unexpectedObjectCount: validation.summary.unexpectedObjectCount,
    orphanExpectedObjectCount: validation.summary.orphanExpectedObjectCount,
    orphanRestoredObjectCount: validation.summary.orphanRestoredObjectCount,
    checksumMismatchCount: validation.summary.checksumMismatchCount,
    expectedBytes: validation.summary.expectedBytes,
    restoredBytes: validation.summary.restoredBytes,
    storageDeletionCount: validation.summary.expectedStorageDeletionRows,
    pendingStorageDeletionCount: validation.summary.sourcePendingStorageDeletionCount,
    deadLetterStorageDeletionCount: validation.summary.sourceDeadLetterStorageDeletionCount,
    processedStorageDeletionCount: validation.summary.sourceProcessedStorageDeletionCount,
    restoredStorageDeletionCount: validation.summary.restoredStorageDeletionRows,
    restoredPendingStorageDeletionCount: validation.summary.restoredPendingStorageDeletionCount,
    restoredDeadLetterStorageDeletionCount: validation.summary.restoredDeadLetterStorageDeletionCount,
    restoredProcessedStorageDeletionCount: validation.summary.restoredProcessedStorageDeletionCount,
    recoveryEventCount: validation.summary.expectedRecoveryEventRows,
    restoredRecoveryEventCount: validation.summary.restoredRecoveryEventRows,
    processedDeletionObjectResidueCount: validation.summary.processedDeletionObjectResidueCount,
    sourceMetadataCapturedAt: validation.captureTimes.sourceMetadataCapturedAt,
    restoredMetadataCapturedAt: validation.captureTimes.restoredMetadataCapturedAt,
    sourceObjectInventoryCapturedAt: validation.captureTimes.sourceObjectInventoryCapturedAt,
    restoredObjectInventoryCapturedAt: validation.captureTimes.restoredObjectInventoryCapturedAt,
    sourceMetadataCaptureTransactionId: validation.captureTimes.sourceMetadataCaptureTransactionId,
    restoredMetadataCaptureTransactionId: validation.captureTimes.restoredMetadataCaptureTransactionId,
    documentProofOldestCapturedAt: validation.documentProof.oldestCapturedAt,
    documentProofAgeMinutes: validation.documentProof.ageMinutes,
    maximumDocumentProofAgeMinutes: validation.documentProof.maximumAgeMinutes,
    documentProofFreshThroughAt: validation.documentProof.freshThroughAt,
    documentProofFresh: validation.documentProof.fresh,
    restoreTargetType: TARGET_TYPE,
    isolationAttestationRecorded: true,
    productionDatabaseNotOverwrittenAttestationRecorded: true,
    productionObjectStoreNotOverwrittenAttestationRecorded: true,
    restoreCredentialsScopedToTargetAttestationRecorded: true,
    objectives: validation.objectiveResults,
    reconciledAt: validation.reconciledAt,
    ownerRecorded: validation.ownerRecorded,
    recoveryOperatorRecorded: validation.recoveryOperatorRecorded,
    notesRecorded: true,
    externalEvidenceReferencesRecorded: true,
    independentBindingArgumentsMatched: true,
    sourceProvenanceExternallyVerified: false,
    provenanceLimitation: 'Caller-supplied binding equality proves offline consistency only; it does not authenticate the source exports, source-capture report, provider, or operator provenance.',
    secretValuesPrinted: false,
  };
}

function renderFailure(issues) {
  return [
    `Document recovery verification failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
    ...issues.map((issue) => `- ${issue}`),
    'Sensitive manifest values were not printed.',
    '',
  ].join('\n');
}

function renderSuccess(payload) {
  return [
    'Document recovery reconciliation consistency passed against independently supplied bindings.',
    `Recovery manifest SHA-256: ${payload.recoveryManifestSha256}`,
    `Reconciliation report SHA-256: ${payload.reconciliationReportSha256}`,
    `Metadata rows reconciled: ${payload.metadataRowCount}`,
    `Document objects reconciled: ${payload.matchedObjectCount}/${payload.expectedObjectCount}`,
    `Document bytes reconciled: ${payload.restoredBytes}/${payload.expectedBytes}`,
    `Storage-deletion lifecycle rows reconciled: ${payload.storageDeletionCount}; pending: ${payload.pendingStorageDeletionCount}; dead-letter: ${payload.deadLetterStorageDeletionCount}.`,
    `Document proof fresh through: ${payload.documentProofFreshThroughAt}.`,
    'An isolated non-production restore-target attestation was recorded and was internally consistent.',
    'No-production-overwrite and target-scoped-credential attestations were recorded; this verifier does not authenticate those attestations.',
    'Database and document-byte RPO/RTO objectives: met.',
    'Independent caller binding arguments matched; argument equality does not authenticate source exports or establish external source provenance.',
    'Sensitive manifest values were not printed.',
    '',
  ].join('\n');
}

export function runVerifyDocumentRecoveryFromArgs(
  args = process.argv.slice(2),
  {
    cwd = process.cwd(),
    repoRoot = defaultRepoRoot,
    now = () => new Date(),
    gitPathStatus = defaultGitPathStatus,
    readManifest = readStableManifest,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    const message = redactDocumentRecoveryTranscript(error instanceof Error ? error.message : String(error));
    return result(2, '', `${usage()}${message}\n`);
  }
  if (options.help) return result(0, usage(), '');
  const requestedPath = resolve(cwd, options.manifestFile);
  let readResult;
  try {
    readResult = readManifest(requestedPath, { repoRoot, gitPathStatus });
  } catch {
    readResult = { issues: ['manifest file could not be opened and validated through one stable descriptor'] };
  }
  if (readResult.issues.length > 0) {
    const payload = failurePayload(readResult.issues);
    return options.json ? result(1, `${JSON.stringify(payload, null, 2)}\n`, '') : result(1, '', renderFailure(readResult.issues));
  }
  const structureIssues = jsonStructureIssues(readResult.rawText);
  if (structureIssues.length > 0) {
    const payload = failurePayload(structureIssues);
    return options.json ? result(1, `${JSON.stringify(payload, null, 2)}\n`, '') : result(1, '', renderFailure(structureIssues));
  }
  let manifest;
  try {
    manifest = JSON.parse(readResult.rawText);
  } catch {
    const issues = ['manifest must contain valid JSON object data'];
    const payload = failurePayload(issues);
    return options.json ? result(1, `${JSON.stringify(payload, null, 2)}\n`, '') : result(1, '', renderFailure(issues));
  }

  const recoveryManifestSha256 = sha256(readResult.buffer);
  const validation = validateDocumentRecoveryManifest(manifest, { now: now(), rawText: readResult.rawText });
  const issues = [...validation.issues];
  if (validation.bindings) issues.push(...independentBindingIssues(options, recoveryManifestSha256, validation));
  if (issues.length > 0) {
    const payload = failurePayload(issues);
    return options.json ? result(1, `${JSON.stringify(payload, null, 2)}\n`, '') : result(1, '', renderFailure(issues));
  }
  const payload = successPayload({ recoveryManifestSha256, validation });
  return options.json ? result(0, `${JSON.stringify(payload, null, 2)}\n`, '') : result(0, renderSuccess(payload), '');
}

function main() {
  const checkResult = runVerifyDocumentRecoveryFromArgs();
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  process.exitCode = checkResult.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
