#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DOCUMENT_RECOVERY_HASH_CONTRACT,
  DOCUMENT_RECOVERY_LIMITS,
  canonicalDatabaseIdentitySha256,
  canonicalDocumentIdentitySha256,
  canonicalMetadataBindingSha256,
  canonicalMetadataInventorySha256,
  canonicalObjectKeySha256,
  canonicalObjectInventorySha256,
  canonicalObjectStoreIdentitySha256,
  canonicalStorageDeletionBindingSha256,
  canonicalStorageDeletionIdentitySha256,
  canonicalStorageDeletionInventorySha256,
  canonicalStorageDeletionRecoveryBindingSha256,
  canonicalStorageDeletionRecoveryIdentitySha256,
  canonicalStorageDeletionRecoveryInventorySha256,
  canonicalStorageDeletionRecoveryNonceSha256,
  canonicalSourceBindingSha256,
  documentRecoverySecretIssues,
  jsonStructureIssues,
  manifestStorageIssues,
  redactDocumentRecoveryTranscript,
  validateDocumentRecoveryManifest,
} from './verify-document-recovery.mjs';

const scriptsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultRepoRoot = resolve(scriptsDir, '..');
const BUILD_INPUT_KIND = 'charitypilot-document-recovery-build-input';
const METADATA_EXPORT_KIND = 'charitypilot-document-metadata-inventory-export';
const OBJECT_EXPORT_KIND = 'charitypilot-document-object-inventory-export';
const MANIFEST_KIND = 'charitypilot-document-recovery-manifest';
const ACKNOWLEDGEMENT = 'This recovery exercise used isolated non-production database and object-storage targets; production was not overwritten.';
const PROVENANCE_LIMITATION = 'Caller-supplied binding equality proves offline consistency only; it does not authenticate the source exports, source-capture report, provider, or operator provenance.';
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = DOCUMENT_RECOVERY_LIMITS.maxManifestBytes;
const MAX_RAW_IDENTIFIER_LENGTH = 512;
const MAX_FILE_URL_LENGTH = 2048;
const MAX_MIME_TYPE_LENGTH = 255;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECOVERY_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_OPERATOR_IDENTITIES = new Set(['admin', 'administrator', 'operator', 'system', 'unknown']);

const BUILD_ROOT_KEYS = new Set([
  'kind',
  'schemaVersion',
  'exercise',
  'source',
  'target',
  'backupControls',
  'objectives',
  'restore',
  'reconciliation',
  'attestations',
]);
const BUILD_SOURCE_KEYS = new Set([
  'environment',
  'recoverySetId',
  'databaseIdentity',
  'objectStoreIdentity',
  'databaseDumpSha256',
  'objectBackupManifestSha256',
  'sourceCaptureReportSha256',
  'sourceCaptureReference',
  'recoverySetReference',
]);
const BUILD_TARGET_KEYS = new Set([
  'environment',
  'restoreTargetType',
  'isolated',
  'databaseIdentity',
  'objectStoreIdentity',
  'isolationEvidenceReference',
]);
const DATABASE_IDENTITY_KEYS = new Set(['provider', 'projectRef', 'databaseName', 'schemaName']);
const OBJECT_STORE_IDENTITY_KEYS = new Set(['provider', 'projectRef', 'bucketName']);
const RECONCILIATION_INPUT_KEYS = new Set(['reportReferenceTemplate']);
const EXPORT_BASE_KEYS = ['kind', 'schemaVersion', 'captureRole', 'exerciseId', 'recoverySetId', 'capturedAt', 'inventoryScope'];
const METADATA_EXPORT_KEYS = new Set([
  ...EXPORT_BASE_KEYS,
  'documentRowCount',
  'storageDeletionRowCount',
  'recoveryEventRowCount',
  'captureTransactionId',
  'rows',
  'documentStorageDeletions',
  'documentStorageDeletionRecoveries',
]);
const OBJECT_EXPORT_KEYS = new Set([
  ...EXPORT_BASE_KEYS,
  'bucketObjectCount',
  'bucketTotalBytes',
  'rows',
]);
const METADATA_ROW_KEYS = new Set(['id', 'organisationId', 'fileUrl', 'fileSize', 'mimeType']);
const OBJECT_ROW_KEYS = new Set(['fileUrl', 'bytes', 'sha256']);
const STORAGE_DELETION_ROW_KEYS = new Set([
  'id',
  'organisationId',
  'storagePath',
  'state',
  'attempts',
  'lastError',
  'lastAttemptAt',
  'nextAttemptAt',
  'claimedAt',
  'deadLetteredAt',
  'terminalReason',
  'alertClaimToken',
  'alertClaimedAt',
  'alertedAt',
  'processedAt',
  'lastRecoveryId',
  'lastRecoveryNonce',
  'lastRecoveryDisposition',
  'lastRecoveredAt',
  'createdAt',
  'updatedAt',
]);
const STORAGE_DELETION_STATES = new Set(['PENDING', 'DEAD_LETTER', 'PROCESSED']);
const STORAGE_DELETION_TERMINAL_REASONS = new Set([
  'MAX_ATTEMPTS_EXHAUSTED',
  'PERMANENT_STORAGE_PATH_REJECTED',
]);
const STORAGE_DELETION_RECOVERY_ROW_KEYS = new Set([
  'id',
  'recoveryNonce',
  'transactionId',
  'deletionId',
  'organisationId',
  'actorType',
  'actorUserId',
  'operatorIdentity',
  'reason',
  'disposition',
  'previousAttempts',
  'previousTerminalReason',
  'previousStoragePath',
  'correctedStoragePath',
  'createdAt',
]);
const STORAGE_DELETION_RECOVERY_ACTOR_TYPES = new Set(['TENANT_USER', 'PLATFORM_OPERATOR']);
const STORAGE_DELETION_RECOVERY_DISPOSITIONS = new Set([
  'REQUEUE_UNCHANGED',
  'REQUEUE_CORRECTED_PATH',
  'COMPLETE_EXTERNALLY_REMEDIATED',
]);

function usage() {
  return [
    'Usage:',
    '  node scripts/generate-document-recovery-manifest.mjs template --output-file <ignored-or-external-build-input.json> [--json]',
    '  node scripts/generate-document-recovery-manifest.mjs build',
    '    --config-file <completed-build-input.json>',
    '    --source-metadata-file <provider-export.json>',
    '    --restored-metadata-file <isolated-restore-export.json>',
    '    --source-object-inventory-file <provider-object-inventory.json>',
    '    --restored-object-inventory-file <isolated-object-inventory.json>',
    '    --output-file <ignored-or-external-manifest.json> [--json]',
    '',
    'This command reads operator/provider exports only. It never connects to or mutates production.',
    'It refuses overwrites. Output must be external to the repository or ignored and untracked.',
    'Metadata exports must cover the complete Document and DocumentStorageDeletion tables.',
    'Object exports must declare and contain the complete whole-bucket inventory; live-key filters are forbidden.',
    `Certification is fail-closed above ${DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries} documents or ${DOCUMENT_RECOVERY_LIMITS.maxManifestBytes} serialized manifest bytes.`,
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameFile(left, right) {
  if (!left || !right) return false;
  if (left.dev !== undefined && right.dev !== undefined && left.ino !== undefined && right.ino !== undefined) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return false;
}

function stableFileFacts(stats) {
  const nanoseconds = (field, fallback) => {
    if (typeof stats?.[field] === 'bigint') return stats[field];
    const value = Number(stats?.[fallback]);
    return Number.isFinite(value) ? BigInt(Math.trunc(value * 1_000_000)) : null;
  };
  return {
    dev: stats?.dev,
    ino: stats?.ino,
    size: stats?.size,
    mtimeNs: nanoseconds('mtimeNs', 'mtimeMs'),
    ctimeNs: nanoseconds('ctimeNs', 'ctimeMs'),
  };
}

function sameStableFile(leftStats, rightStats) {
  const left = stableFileFacts(leftStats);
  const right = stableFileFacts(rightStats);
  return (
    sameFile(leftStats, rightStats) &&
    left.size === right.size &&
    left.mtimeNs !== null &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs !== null &&
    left.ctimeNs === right.ctimeNs
  );
}

function safeError(value) {
  return redactDocumentRecoveryTranscript(value instanceof Error ? value.message : String(value));
}

function fail(message) {
  throw new Error(message);
}

function exactObject(value, label, allowedKeys) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  const unsupported = keys.filter((key) => !allowedKeys.has(key));
  const missing = [...allowedKeys].filter((key) => !Object.hasOwn(value, key));
  if (unsupported.length > 0 || missing.length > 0) fail(`${label} must contain exactly the documented fields`);
  return value;
}

function boundedText(value, label, { min = 1, max = MAX_RAW_IDENTIFIER_LENGTH } = {}) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max) {
    fail(`${label} must be a trimmed bounded string`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value) || new Date(value).toISOString() !== value) {
    fail(`${label} must be an ISO-8601 UTC timestamp with milliseconds`);
  }
  return value;
}

function transactionId(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,18}$/.test(value) ||
    BigInt(value) > MAX_POSTGRES_BIGINT
  ) {
    fail(`${label} must be a canonical bounded decimal transaction identifier`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} must be a safe integer from ${min} to ${max}`);
  }
  return value;
}

function identity(value, label, keys) {
  const input = exactObject(value, label, keys);
  return Object.fromEntries([...keys].map((key) => [key, boundedText(input[key], `${label}.${key}`)]));
}

function readJsonFile(requestedPath, label, maximumBytes) {
  const path = resolve(requestedPath);
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) fail(`${label} must be a regular non-symbolic-link file`);
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameStableFile(before, opened)) fail(`${label} changed while it was being opened`);
    if (opened.size <= 0n || opened.size > BigInt(maximumBytes)) fail(`${label} exceeds its safe byte bound or is empty`);
    const resolvedPath = realpathSync(path);
    const pathStat = statSync(resolvedPath, { bigint: true });
    if (!sameStableFile(opened, pathStat)) fail(`${label} descriptor does not match its resolved path`);

    const capacity = Number(opened.size) + 1;
    const buffer = Buffer.alloc(capacity);
    let offset = 0;
    while (offset < capacity) {
      const read = readSync(descriptor, buffer, offset, capacity - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameStableFile(opened, after) || offset !== Number(opened.size)) {
      fail(`${label} changed while it was being read`);
    }
    const finalResolvedPath = realpathSync(path);
    if (finalResolvedPath !== resolvedPath || !sameStableFile(after, statSync(finalResolvedPath, { bigint: true }))) {
      fail(`${label} path changed while it was being read`);
    }
    let rawText;
    try {
      rawText = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      fail(`${label} must use valid UTF-8 encoding`);
    }
    const structureIssues = jsonStructureIssues(rawText);
    if (structureIssues.length > 0) fail(`${label} has unsafe JSON structure: ${structureIssues.join('; ')}`);
    if (redactDocumentRecoveryTranscript(rawText) !== rawText) fail(`${label} contains secret-looking material`);
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      fail(`${label} must contain valid JSON`);
    }
    if (documentRecoverySecretIssues(rawText, data).length > 0) {
      fail(`${label} contains secret-looking material`);
    }
    return {
      data,
      rawText,
      buffer: buffer.subarray(0, offset),
      sha256: sha256(buffer.subarray(0, offset)),
      path: resolvedPath,
      stableFacts: stableFileFacts(after),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
    fail(`${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateConfig(config) {
  const input = exactObject(config, 'build input', BUILD_ROOT_KEYS);
  if (input.kind !== BUILD_INPUT_KIND || input.schemaVersion !== 1) {
    fail(`build input must use ${BUILD_INPUT_KIND} schemaVersion 1`);
  }
  const source = exactObject(input.source, 'build input source', BUILD_SOURCE_KEYS);
  const target = exactObject(input.target, 'build input target', BUILD_TARGET_KEYS);
  exactObject(input.reconciliation, 'build input reconciliation', RECONCILIATION_INPUT_KEYS);
  if (source.environment !== 'production') fail('build input source environment must be production');
  if (target.environment !== 'non-production' || target.restoreTargetType !== 'isolated-non-production' || target.isolated !== true) {
    fail('build input target must be an explicitly isolated non-production target');
  }
  const databaseIdentity = identity(source.databaseIdentity, 'source database identity', DATABASE_IDENTITY_KEYS);
  const objectStoreIdentity = identity(source.objectStoreIdentity, 'source object-store identity', OBJECT_STORE_IDENTITY_KEYS);
  const targetDatabaseIdentity = identity(target.databaseIdentity, 'target database identity', DATABASE_IDENTITY_KEYS);
  const targetObjectStoreIdentity = identity(target.objectStoreIdentity, 'target object-store identity', OBJECT_STORE_IDENTITY_KEYS);
  digest(source.databaseDumpSha256, 'source.databaseDumpSha256');
  digest(source.objectBackupManifestSha256, 'source.objectBackupManifestSha256');
  digest(source.sourceCaptureReportSha256, 'source.sourceCaptureReportSha256');
  const reportReferenceTemplate = boundedText(
    input.reconciliation.reportReferenceTemplate,
    'reconciliation.reportReferenceTemplate',
    { max: 2048 },
  );
  if (
    reportReferenceTemplate.split('{reconciliationReportSha256}').length !== 2 ||
    !reportReferenceTemplate.startsWith('https://')
  ) {
    fail('reconciliation.reportReferenceTemplate must be an HTTPS reference containing {reconciliationReportSha256} exactly once');
  }
  return {
    input,
    source,
    target,
    databaseIdentity,
    objectStoreIdentity,
    targetDatabaseIdentity,
    targetObjectStoreIdentity,
  };
}

function validateExportEnvelope(value, { kind, role, exerciseId, recoverySetId, label, keys, scope }) {
  const envelope = exactObject(value, label, keys);
  if (envelope.kind !== kind || envelope.schemaVersion !== 1 || envelope.captureRole !== role) {
    fail(`${label} must be a version 1 ${role} ${kind}`);
  }
  if (envelope.exerciseId !== exerciseId) fail(`${label} exerciseId must match the completed build input`);
  if (envelope.recoverySetId !== recoverySetId) fail(`${label} recoverySetId must match the completed build input`);
  if (envelope.inventoryScope !== scope) fail(`${label}.inventoryScope must be ${scope}`);
  const capturedAt = timestamp(envelope.capturedAt, `${label}.capturedAt`);
  if (!Array.isArray(envelope.rows) || envelope.rows.length < 1 || envelope.rows.length > DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries) {
    fail(`${label}.rows must contain 1 to ${DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries} entries`);
  }
  return { envelope, capturedAt };
}

function isSafeOrganisationStoragePath(organisationId, storagePath) {
  if (!storagePath.startsWith(`${organisationId}/`) || storagePath.endsWith('/')) return false;
  if (storagePath.includes('//') || storagePath.includes('\\') || /[\u0000-\u001f\u007f]/.test(storagePath)) return false;
  return !storagePath.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0);
}

function convertMetadataExport(value, options) {
  const { envelope, capturedAt } = validateExportEnvelope(value, {
    ...options,
    kind: METADATA_EXPORT_KIND,
    keys: METADATA_EXPORT_KEYS,
    scope: 'complete-document-and-storage-deletion-tables',
  });
  const captureTransactionId = transactionId(
    envelope.captureTransactionId,
    `${options.label}.captureTransactionId`,
  );
  safeInteger(envelope.documentRowCount, `${options.label}.documentRowCount`, {
    min: 1,
    max: DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries,
  });
  safeInteger(envelope.storageDeletionRowCount, `${options.label}.storageDeletionRowCount`, {
    min: 0,
    max: DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries,
  });
  safeInteger(envelope.recoveryEventRowCount, `${options.label}.recoveryEventRowCount`, {
    min: 0,
    max: DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries,
  });
  if (envelope.documentRowCount !== envelope.rows.length) {
    fail(`${options.label}.documentRowCount must match the complete Document row inventory`);
  }
  if (
    !Array.isArray(envelope.documentStorageDeletions) ||
    envelope.documentStorageDeletions.length > DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries ||
    envelope.storageDeletionRowCount !== envelope.documentStorageDeletions.length
  ) {
    fail(`${options.label}.storageDeletionRowCount must match the complete DocumentStorageDeletion inventory`);
  }
  if (
    !Array.isArray(envelope.documentStorageDeletionRecoveries) ||
    envelope.documentStorageDeletionRecoveries.length > DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries ||
    envelope.recoveryEventRowCount !== envelope.documentStorageDeletionRecoveries.length
  ) {
    fail(`${options.label}.recoveryEventRowCount must match the complete DocumentStorageDeletionRecovery inventory`);
  }
  const documentIds = new Set();
  const fileUrls = new Set();
  const documents = envelope.rows.map((row, index) => {
    const path = `${options.label}.rows[${index}]`;
    const entry = exactObject(row, path, METADATA_ROW_KEYS);
    const id = boundedText(entry.id, `${path}.id`);
    const organisationId = boundedText(entry.organisationId, `${path}.organisationId`);
    const fileUrl = boundedText(entry.fileUrl, `${path}.fileUrl`, { max: MAX_FILE_URL_LENGTH });
    const fileSize = safeInteger(entry.fileSize, `${path}.fileSize`, { max: DOCUMENT_RECOVERY_LIMITS.maxDocumentBytes });
    const mimeType = boundedText(entry.mimeType, `${path}.mimeType`, { max: MAX_MIME_TYPE_LENGTH });
    if (documentIds.has(id)) fail(`${options.label} contains duplicate document IDs`);
    if (fileUrls.has(fileUrl)) fail(`${options.label} contains duplicate document object keys`);
    documentIds.add(id);
    fileUrls.add(fileUrl);
    return {
      rawFileUrl: fileUrl,
      verifierEntry: {
        documentIdentitySha256: canonicalDocumentIdentitySha256(id),
        metadataBindingSha256: canonicalMetadataBindingSha256({ id, organisationId, fileUrl, fileSize, mimeType }),
        objectKeySha256: canonicalObjectKeySha256(fileUrl),
        fileSize,
      },
    };
  });
  const deletionIds = new Set();
  const deletionPaths = new Set();
  const documentStorageDeletions = envelope.documentStorageDeletions.map((row, index) => {
    const path = `${options.label}.documentStorageDeletions[${index}]`;
    const entry = exactObject(row, path, STORAGE_DELETION_ROW_KEYS);
    const id = boundedText(entry.id, `${path}.id`);
    const organisationId = boundedText(entry.organisationId, `${path}.organisationId`);
    const storagePath = boundedText(entry.storagePath, `${path}.storagePath`, { max: MAX_FILE_URL_LENGTH });
    if (!STORAGE_DELETION_STATES.has(entry.state)) fail(`${path}.state must be PENDING, DEAD_LETTER, or PROCESSED`);
    const attempts = safeInteger(entry.attempts, `${path}.attempts`, { min: 0, max: 1_000_000 });
    const nullableText = (field, max) => {
      const valueAtField = entry[field];
      if (valueAtField === null) return null;
      if (typeof valueAtField !== 'string' || valueAtField.length > max) {
        fail(`${path}.${field} must be null or a bounded string`);
      }
      return valueAtField;
    };
    const nullableTimestamp = (field) => entry[field] === null
      ? null
      : timestamp(entry[field], `${path}.${field}`);
    const lastError = nullableText('lastError', 500);
    const terminalReason = nullableText('terminalReason', 80);
    if (terminalReason !== null && !STORAGE_DELETION_TERMINAL_REASONS.has(terminalReason)) {
      fail(`${path}.terminalReason is not a supported terminal reason`);
    }
    const alertClaimToken = nullableText('alertClaimToken', 128);
    const lastRecoveryId = nullableText('lastRecoveryId', MAX_RAW_IDENTIFIER_LENGTH);
    const lastRecoveryNonce = nullableText('lastRecoveryNonce', MAX_RAW_IDENTIFIER_LENGTH);
    const lastRecoveryDisposition = nullableText('lastRecoveryDisposition', 80);
    if (
      lastRecoveryDisposition !== null &&
      !STORAGE_DELETION_RECOVERY_DISPOSITIONS.has(lastRecoveryDisposition)
    ) {
      fail(`${path}.lastRecoveryDisposition is not a supported recovery disposition`);
    }
    const lifecycle = {
      id,
      organisationId,
      storagePath,
      state: entry.state,
      attempts,
      lastError,
      lastAttemptAt: nullableTimestamp('lastAttemptAt'),
      nextAttemptAt: nullableTimestamp('nextAttemptAt'),
      claimedAt: nullableTimestamp('claimedAt'),
      deadLetteredAt: nullableTimestamp('deadLetteredAt'),
      terminalReason,
      alertClaimToken,
      alertClaimedAt: nullableTimestamp('alertClaimedAt'),
      alertedAt: nullableTimestamp('alertedAt'),
      processedAt: nullableTimestamp('processedAt'),
      lastRecoveryId,
      lastRecoveryNonce,
      lastRecoveryDisposition,
      lastRecoveredAt: nullableTimestamp('lastRecoveredAt'),
      createdAt: timestamp(entry.createdAt, `${path}.createdAt`),
      updatedAt: timestamp(entry.updatedAt, `${path}.updatedAt`),
    };
    if (deletionIds.has(id)) fail(`${options.label} contains duplicate storage-deletion IDs`);
    if (deletionPaths.has(storagePath)) fail(`${options.label} contains duplicate storage-deletion object keys`);
    deletionIds.add(id);
    deletionPaths.add(storagePath);
    const recoveryBindingFields = [
      lifecycle.lastRecoveryId,
      lifecycle.lastRecoveryNonce,
      lifecycle.lastRecoveryDisposition,
      lifecycle.lastRecoveredAt,
    ];
    if (
      recoveryBindingFields.some((valueAtField) => valueAtField === null) &&
      recoveryBindingFields.some((valueAtField) => valueAtField !== null)
    ) {
      fail(`${path} must use an all-or-none last-recovery binding`);
    }
    if (lifecycle.lastRecoveredAt !== null && Date.parse(lifecycle.lastRecoveredAt) > Date.parse(capturedAt)) {
      fail(`${path}.lastRecoveredAt must not be after the metadata capture`);
    }
    if (entry.state === 'PROCESSED' && (
      lifecycle.processedAt === null ||
      lifecycle.nextAttemptAt !== null ||
      lifecycle.claimedAt !== null ||
      lifecycle.deadLetteredAt !== null ||
      lifecycle.terminalReason !== null ||
      lifecycle.lastError !== null ||
      lifecycle.alertClaimToken !== null ||
      lifecycle.alertClaimedAt !== null ||
      lifecycle.alertedAt !== null
    )) {
      fail(`${path} has an inconsistent PROCESSED lifecycle state`);
    }
    return {
      rawStoragePath: storagePath,
      rawLifecycle: lifecycle,
      verifierEntry: {
        deletionIdentitySha256: canonicalStorageDeletionIdentitySha256(id),
        lifecycleBindingSha256: canonicalStorageDeletionBindingSha256(lifecycle),
        objectKeySha256: canonicalObjectKeySha256(storagePath),
        state: entry.state,
        lastRecoveryIdentitySha256: lastRecoveryId === null
          ? null
          : canonicalStorageDeletionRecoveryIdentitySha256(lastRecoveryId),
        lastRecoveryNonceSha256: lastRecoveryNonce === null
          ? null
          : canonicalStorageDeletionRecoveryNonceSha256(lastRecoveryNonce),
        lastRecoveryDisposition,
        lastRecoveredAt: lifecycle.lastRecoveredAt,
      },
    };
  });
  const deletionById = new Map(documentStorageDeletions.map((entry) => [entry.rawLifecycle.id, entry]));
  const recoveryIds = new Set();
  const recoveryNonces = new Set();
  const rawRecoveryById = new Map();
  const documentStorageDeletionRecoveries = envelope.documentStorageDeletionRecoveries.map((row, index) => {
    const path = `${options.label}.documentStorageDeletionRecoveries[${index}]`;
    const entry = exactObject(row, path, STORAGE_DELETION_RECOVERY_ROW_KEYS);
    const id = boundedText(entry.id, `${path}.id`);
    const recoveryNonce = boundedText(entry.recoveryNonce, `${path}.recoveryNonce`);
    if (!RECOVERY_NONCE_PATTERN.test(recoveryNonce)) {
      fail(`${path}.recoveryNonce must be a canonical lowercase UUID v4`);
    }
    const eventTransactionId = transactionId(entry.transactionId, `${path}.transactionId`);
    const deletionId = boundedText(entry.deletionId, `${path}.deletionId`);
    const organisationId = boundedText(entry.organisationId, `${path}.organisationId`);
    if (!STORAGE_DELETION_RECOVERY_ACTOR_TYPES.has(entry.actorType)) {
      fail(`${path}.actorType must be TENANT_USER or PLATFORM_OPERATOR`);
    }
    if (!STORAGE_DELETION_RECOVERY_DISPOSITIONS.has(entry.disposition)) {
      fail(`${path}.disposition is not supported`);
    }
    const nullableRecoveryText = (field, max) => {
      const valueAtField = entry[field];
      if (valueAtField === null) return null;
      if (
        typeof valueAtField !== 'string' ||
        valueAtField.trim() !== valueAtField ||
        valueAtField.length < 1 ||
        valueAtField.length > max
      ) {
        fail(`${path}.${field} must be null or a trimmed bounded string`);
      }
      return valueAtField;
    };
    const actorUserId = nullableRecoveryText('actorUserId', MAX_RAW_IDENTIFIER_LENGTH);
    const operatorIdentity = nullableRecoveryText('operatorIdentity', 160);
    const reason = boundedText(entry.reason, `${path}.reason`, { min: 10, max: 500 });
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(reason)) {
      fail(`${path}.reason contains a forbidden control character`);
    }
    const previousAttempts = safeInteger(entry.previousAttempts, `${path}.previousAttempts`, {
      min: 1,
      max: 1_000_000,
    });
    if (!STORAGE_DELETION_TERMINAL_REASONS.has(entry.previousTerminalReason)) {
      fail(`${path}.previousTerminalReason is not supported`);
    }
    const previousStoragePath = boundedText(
      entry.previousStoragePath,
      `${path}.previousStoragePath`,
      { max: MAX_FILE_URL_LENGTH },
    );
    const correctedStoragePath = nullableRecoveryText('correctedStoragePath', MAX_FILE_URL_LENGTH);
    const createdAt = timestamp(entry.createdAt, `${path}.createdAt`);
    if (Date.parse(createdAt) > Date.parse(capturedAt)) {
      fail(`${path}.createdAt must not be after the metadata capture`);
    }
    if (options.role === 'source' && BigInt(eventTransactionId) >= BigInt(captureTransactionId)) {
      fail(`${path}.transactionId must predate the source metadata capture transaction`);
    }
    if (recoveryIds.has(id)) fail(`${options.label} contains duplicate recovery-event IDs`);
    if (recoveryNonces.has(recoveryNonce)) fail(`${options.label} contains duplicate recovery-event nonces`);
    recoveryIds.add(id);
    recoveryNonces.add(recoveryNonce);
    const deletion = deletionById.get(deletionId);
    if (!deletion || deletion.rawLifecycle.organisationId !== organisationId) {
      fail(`${path} must reference a deletion in the same complete tenant inventory`);
    }
    if (entry.actorType === 'TENANT_USER') {
      if (actorUserId === null || operatorIdentity !== null || entry.disposition !== 'REQUEUE_UNCHANGED') {
        fail(`${path} has an invalid tenant-user actor or disposition binding`);
      }
    } else if (
      actorUserId !== null ||
      operatorIdentity === null ||
      operatorIdentity.length < 3 ||
      /[@:/\\\u0000-\u001f\u007f]/.test(operatorIdentity) ||
      FORBIDDEN_OPERATOR_IDENTITIES.has(operatorIdentity.toLowerCase())
    ) {
      fail(`${path} has an invalid named platform-operator actor binding`);
    }
    const correctedDisposition = entry.disposition === 'REQUEUE_CORRECTED_PATH';
    if (correctedDisposition) {
      if (
        correctedStoragePath === null ||
        correctedStoragePath === previousStoragePath ||
        !isSafeOrganisationStoragePath(organisationId, correctedStoragePath) ||
        fileUrls.has(correctedStoragePath) ||
        deletionPaths.has(correctedStoragePath)
      ) {
        fail(`${path} has an invalid corrected-path disposition`);
      }
    } else if (correctedStoragePath !== null) {
      fail(`${path}.correctedStoragePath must be null outside corrected-path recovery`);
    }
    if (
      entry.previousTerminalReason === 'PERMANENT_STORAGE_PATH_REJECTED' &&
      entry.disposition === 'REQUEUE_UNCHANGED'
    ) {
      fail(`${path} cannot requeue a permanently rejected storage path unchanged`);
    }
    const rawRecovery = {
      id,
      recoveryNonce,
      transactionId: eventTransactionId,
      deletionId,
      organisationId,
      actorType: entry.actorType,
      actorUserId,
      operatorIdentity,
      reason,
      disposition: entry.disposition,
      previousAttempts,
      previousTerminalReason: entry.previousTerminalReason,
      previousStoragePath,
      correctedStoragePath,
      createdAt,
    };
    rawRecoveryById.set(id, rawRecovery);
    return {
      rawRecovery,
      verifierEntry: {
        recoveryIdentitySha256: canonicalStorageDeletionRecoveryIdentitySha256(id),
        recoveryNonceSha256: canonicalStorageDeletionRecoveryNonceSha256(recoveryNonce),
        recoveryBindingSha256: canonicalStorageDeletionRecoveryBindingSha256(rawRecovery),
        transactionId: eventTransactionId,
        deletionIdentitySha256: canonicalStorageDeletionIdentitySha256(deletionId),
        actorType: entry.actorType,
        disposition: entry.disposition,
        previousTerminalReason: entry.previousTerminalReason,
        previousObjectKeySha256: canonicalObjectKeySha256(previousStoragePath),
        correctedObjectKeySha256: correctedStoragePath === null
          ? null
          : canonicalObjectKeySha256(correctedStoragePath),
        createdAt,
      },
    };
  });
  const recoveriesByDeletionId = new Map();
  for (const recovery of rawRecoveryById.values()) {
    const recoveries = recoveriesByDeletionId.get(recovery.deletionId) ?? [];
    recoveries.push(recovery);
    recoveriesByDeletionId.set(recovery.deletionId, recoveries);
  }
  for (const deletion of documentStorageDeletions) {
    const lifecycle = deletion.rawLifecycle;
    const deletionRecoveries = recoveriesByDeletionId.get(lifecycle.id) ?? [];
    if (lifecycle.lastRecoveryId === null) {
      if (deletionRecoveries.length > 0) {
        fail(`${options.label} contains recovery events without the deletion's exact last-recovery binding`);
      }
      continue;
    }
    const linked = rawRecoveryById.get(lifecycle.lastRecoveryId);
    if (
      !linked ||
      linked.deletionId !== lifecycle.id ||
      linked.organisationId !== lifecycle.organisationId ||
      linked.recoveryNonce !== lifecycle.lastRecoveryNonce ||
      linked.disposition !== lifecycle.lastRecoveryDisposition
    ) {
      fail(`${options.label} contains a deletion whose last-recovery binding does not match its exact recovery event`);
    }
    const latestTransactionId = deletionRecoveries.reduce(
      (latest, event) => BigInt(event.transactionId) > latest ? BigInt(event.transactionId) : latest,
      0n,
    );
    const latestTransactionEvents = deletionRecoveries.filter(
      (event) => BigInt(event.transactionId) === latestTransactionId,
    );
    if (
      BigInt(linked.transactionId) !== latestTransactionId ||
      latestTransactionEvents.length !== 1 ||
      latestTransactionEvents[0].id !== linked.id
    ) {
      fail(`${options.label} contains a deletion whose last-recovery binding is not its latest recovery transaction`);
    }
    if (Date.parse(lifecycle.lastRecoveredAt) < Date.parse(linked.createdAt)) {
      fail(`${options.label} contains a deletion recovered before its linked recovery event`);
    }
    if (linked.disposition === 'REQUEUE_CORRECTED_PATH') {
      if (lifecycle.storagePath !== linked.correctedStoragePath) {
        fail(`${options.label} corrected-path recovery does not match the deletion storage path`);
      }
    } else if (lifecycle.storagePath !== linked.previousStoragePath) {
      fail(`${options.label} unchanged or externally completed recovery must preserve its previous storage path`);
    }
    if (linked.disposition === 'COMPLETE_EXTERNALLY_REMEDIATED' && lifecycle.state !== 'PROCESSED') {
      fail(`${options.label} external completion must leave the deletion terminally PROCESSED`);
    }
    if (
      linked.disposition === 'COMPLETE_EXTERNALLY_REMEDIATED' &&
      lifecycle.attempts !== linked.previousAttempts
    ) {
      fail(`${options.label} external completion must preserve the dead letter's attempt count`);
    }
  }
  return {
    capturedAt,
    captureTransactionId,
    documents,
    documentStorageDeletions,
    documentStorageDeletionRecoveries,
  };
}

function convertObjectExport(value, options) {
  const { envelope, capturedAt } = validateExportEnvelope(value, {
    ...options,
    kind: OBJECT_EXPORT_KIND,
    keys: OBJECT_EXPORT_KEYS,
    scope: 'complete-whole-bucket',
  });
  safeInteger(envelope.bucketObjectCount, `${options.label}.bucketObjectCount`, {
    min: 1,
    max: DOCUMENT_RECOVERY_LIMITS.maxInventoryEntries,
  });
  safeInteger(envelope.bucketTotalBytes, `${options.label}.bucketTotalBytes`, {
    min: 0,
    max: DOCUMENT_RECOVERY_LIMITS.maxAggregateBytes,
  });
  if (envelope.bucketObjectCount !== envelope.rows.length) {
    fail(`${options.label}.bucketObjectCount must match the complete whole-bucket inventory`);
  }
  const fileUrls = new Set();
  let aggregateBytes = 0;
  const objects = envelope.rows.map((row, index) => {
    const path = `${options.label}.rows[${index}]`;
    const entry = exactObject(row, path, OBJECT_ROW_KEYS);
    const fileUrl = boundedText(entry.fileUrl, `${path}.fileUrl`, { max: MAX_FILE_URL_LENGTH });
    const bytes = safeInteger(entry.bytes, `${path}.bytes`, { max: DOCUMENT_RECOVERY_LIMITS.maxDocumentBytes });
    const objectSha256 = digest(entry.sha256, `${path}.sha256`);
    if (fileUrls.has(fileUrl)) fail(`${options.label} contains duplicate object keys`);
    fileUrls.add(fileUrl);
    aggregateBytes += bytes;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > DOCUMENT_RECOVERY_LIMITS.maxAggregateBytes) {
      fail(`${options.label} exceeds the aggregate object-byte safety bound`);
    }
    if (bytes === 0 && objectSha256 !== sha256(Buffer.alloc(0))) {
      fail(`${path}.sha256 must be the empty-byte digest when bytes is zero`);
    }
    return {
      rawFileUrl: fileUrl,
      verifierEntry: { objectKeySha256: canonicalObjectKeySha256(fileUrl), bytes, sha256: objectSha256 },
    };
  });
  if (envelope.bucketTotalBytes !== aggregateBytes) {
    fail(`${options.label}.bucketTotalBytes must match the complete whole-bucket inventory`);
  }
  return { capturedAt, objects };
}

function sortedJson(entries, key) {
  return JSON.stringify([...entries].sort((left, right) => left[key].localeCompare(right[key])));
}

function requireCompleteMatchingLayer(metadata, objects, label) {
  if (metadata.length !== objects.length) fail(`${label} metadata and object inventories must have equal complete counts`);
  const objectByUrl = new Map(objects.map((entry) => [entry.rawFileUrl, entry.verifierEntry]));
  for (const entry of metadata) {
    const object = objectByUrl.get(entry.rawFileUrl);
    if (!object) fail(`${label} is missing a document object referenced by metadata`);
    if (entry.verifierEntry.fileSize !== object.bytes) fail(`${label} metadata and object byte sizes must match`);
  }
}

function exactSummary(metadata, objects, storageDeletions, recoveryEvents) {
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
    sourcePendingStorageDeletionCount: 0,
    sourceDeadLetterStorageDeletionCount: 0,
    sourceProcessedStorageDeletionCount: storageDeletions.length,
    restoredPendingStorageDeletionCount: 0,
    restoredDeadLetterStorageDeletionCount: 0,
    restoredProcessedStorageDeletionCount: storageDeletions.length,
    processedDeletionObjectResidueCount: 0,
    expectedRecoveryEventRows: recoveryEvents.length,
    restoredRecoveryEventRows: recoveryEvents.length,
    matchedRecoveryEventRows: recoveryEvents.length,
    missingRecoveryEventRows: 0,
    unexpectedRecoveryEventRows: 0,
    recoveryEventMismatchCount: 0,
  };
}

function buildManifest({ config, sourceMetadata, restoredMetadata, sourceObjects, restoredObjects, now }) {
  const validated = validateConfig(config);
  const exerciseId = boundedText(validated.input.exercise.id, 'exercise.id', { min: 3, max: 128 });
  const recoverySetId = boundedText(validated.source.recoverySetId, 'source.recoverySetId', { min: 3, max: 128 });
  const sourceMetadataCapture = convertMetadataExport(sourceMetadata, { role: 'source', exerciseId, recoverySetId, label: 'source metadata export' });
  const restoredMetadataCapture = convertMetadataExport(restoredMetadata, { role: 'restored', exerciseId, recoverySetId, label: 'restored metadata export' });
  const sourceObjectCapture = convertObjectExport(sourceObjects, { role: 'source', exerciseId, recoverySetId, label: 'source object inventory export' });
  const restoredObjectCapture = convertObjectExport(restoredObjects, { role: 'restored', exerciseId, recoverySetId, label: 'restored object inventory export' });
  const expectedMetadataRaw = sourceMetadataCapture.documents;
  const restoredMetadataRaw = restoredMetadataCapture.documents;
  const expectedObjectsRaw = sourceObjectCapture.objects;
  const restoredObjectsRaw = restoredObjectCapture.objects;

  requireCompleteMatchingLayer(expectedMetadataRaw, expectedObjectsRaw, 'source recovery set');
  requireCompleteMatchingLayer(restoredMetadataRaw, restoredObjectsRaw, 'restored recovery set');

  const expectedMetadata = expectedMetadataRaw.map((entry) => entry.verifierEntry);
  const restoredMetadataEntries = restoredMetadataRaw.map((entry) => entry.verifierEntry);
  const expectedObjects = expectedObjectsRaw.map((entry) => entry.verifierEntry);
  const restoredObjectEntries = restoredObjectsRaw.map((entry) => entry.verifierEntry);
  const expectedStorageDeletions = sourceMetadataCapture.documentStorageDeletions.map((entry) => entry.verifierEntry);
  const restoredStorageDeletions = restoredMetadataCapture.documentStorageDeletions.map((entry) => entry.verifierEntry);
  const expectedRecoveryEvents = sourceMetadataCapture.documentStorageDeletionRecoveries.map((entry) => entry.verifierEntry);
  const restoredRecoveryEvents = restoredMetadataCapture.documentStorageDeletionRecoveries.map((entry) => entry.verifierEntry);
  const sourcePendingStorageDeletionCount = expectedStorageDeletions.filter((entry) => entry.state === 'PENDING').length;
  const sourceDeadLetterStorageDeletionCount = expectedStorageDeletions.filter((entry) => entry.state === 'DEAD_LETTER').length;
  const restoredPendingStorageDeletionCount = restoredStorageDeletions.filter((entry) => entry.state === 'PENDING').length;
  const restoredDeadLetterStorageDeletionCount = restoredStorageDeletions.filter((entry) => entry.state === 'DEAD_LETTER').length;
  if (
    sourcePendingStorageDeletionCount > 0 ||
    sourceDeadLetterStorageDeletionCount > 0 ||
    restoredPendingStorageDeletionCount > 0 ||
    restoredDeadLetterStorageDeletionCount > 0
  ) {
    fail('v1 recovery certification requires zero outstanding PENDING or DEAD_LETTER DocumentStorageDeletion rows');
  }
  const mismatchedLayers = [];
  if (sortedJson(expectedMetadata, 'documentIdentitySha256') !== sortedJson(restoredMetadataEntries, 'documentIdentitySha256')) {
    mismatchedLayers.push('Document metadata');
  }
  if (sortedJson(expectedObjects, 'objectKeySha256') !== sortedJson(restoredObjectEntries, 'objectKeySha256')) {
    mismatchedLayers.push('whole-bucket object');
  }
  if (sortedJson(expectedStorageDeletions, 'deletionIdentitySha256') !== sortedJson(restoredStorageDeletions, 'deletionIdentitySha256')) {
    mismatchedLayers.push('DocumentStorageDeletion');
  }
  if (sortedJson(expectedRecoveryEvents, 'recoveryIdentitySha256') !== sortedJson(restoredRecoveryEvents, 'recoveryIdentitySha256')) {
    mismatchedLayers.push('DocumentStorageDeletionRecovery');
  }
  if (mismatchedLayers.length > 0) {
    fail(`source and isolated-restored ${mismatchedLayers.join(', ')} inventories do not reconcile exactly; no manifest was written`);
  }

  const metadataInventorySha256 = canonicalMetadataInventorySha256(
    expectedMetadata,
    sourceMetadataCapture.capturedAt,
    sourceMetadataCapture.captureTransactionId,
  );
  const restoredMetadataInventorySha256 = canonicalMetadataInventorySha256(
    restoredMetadataEntries,
    restoredMetadataCapture.capturedAt,
    restoredMetadataCapture.captureTransactionId,
  );
  const objectInventorySha256 = canonicalObjectInventorySha256(expectedObjects, sourceObjectCapture.capturedAt);
  const restoredObjectInventorySha256 = canonicalObjectInventorySha256(
    restoredObjectEntries,
    restoredObjectCapture.capturedAt,
  );
  const storageDeletionInventorySha256 = canonicalStorageDeletionInventorySha256(
    expectedStorageDeletions,
    sourceMetadataCapture.capturedAt,
    sourceMetadataCapture.captureTransactionId,
  );
  const restoredStorageDeletionInventorySha256 = canonicalStorageDeletionInventorySha256(
    restoredStorageDeletions,
    restoredMetadataCapture.capturedAt,
    restoredMetadataCapture.captureTransactionId,
  );
  const recoveryEventInventorySha256 = canonicalStorageDeletionRecoveryInventorySha256(
    expectedRecoveryEvents,
    sourceMetadataCapture.capturedAt,
    sourceMetadataCapture.captureTransactionId,
  );
  const restoredRecoveryEventInventorySha256 = canonicalStorageDeletionRecoveryInventorySha256(
    restoredRecoveryEvents,
    restoredMetadataCapture.capturedAt,
    restoredMetadataCapture.captureTransactionId,
  );

  const databaseIdentitySha256 = canonicalDatabaseIdentitySha256(validated.databaseIdentity);
  const objectStoreIdentitySha256 = canonicalObjectStoreIdentitySha256(validated.objectStoreIdentity);
  const targetDatabaseIdentitySha256 = canonicalDatabaseIdentitySha256(validated.targetDatabaseIdentity);
  const targetObjectStoreIdentitySha256 = canonicalObjectStoreIdentitySha256(validated.targetObjectStoreIdentity);
  const sourceBindingSha256 = canonicalSourceBindingSha256({
    exerciseId,
    recoverySetId,
    sourceCaptureReportSha256: validated.source.sourceCaptureReportSha256,
    databaseIdentitySha256,
    objectStoreIdentitySha256,
    databaseDumpSha256: validated.source.databaseDumpSha256,
    objectBackupManifestSha256: validated.source.objectBackupManifestSha256,
    productionDocumentCount: expectedMetadata.length,
    storageDeletionCount: expectedStorageDeletions.length,
    pendingStorageDeletionCount: sourcePendingStorageDeletionCount,
    deadLetterStorageDeletionCount: sourceDeadLetterStorageDeletionCount,
    processedStorageDeletionCount: expectedStorageDeletions.length,
    recoveryEventCount: expectedRecoveryEvents.length,
    maximumDocumentProofAgeMinutes: validated.input.exercise.maximumDocumentProofAgeMinutes,
    sourceMetadataCapturedAt: sourceMetadataCapture.capturedAt,
    restoredMetadataCapturedAt: restoredMetadataCapture.capturedAt,
    sourceObjectInventoryCapturedAt: sourceObjectCapture.capturedAt,
    restoredObjectInventoryCapturedAt: restoredObjectCapture.capturedAt,
    sourceMetadataCaptureTransactionId: sourceMetadataCapture.captureTransactionId,
    restoredMetadataCaptureTransactionId: restoredMetadataCapture.captureTransactionId,
    metadataInventorySha256,
    restoredMetadataInventorySha256,
    objectInventorySha256,
    restoredObjectInventorySha256,
    storageDeletionInventorySha256,
    restoredStorageDeletionInventorySha256,
    recoveryEventInventorySha256,
    restoredRecoveryEventInventorySha256,
  });

  const manifest = {
    kind: MANIFEST_KIND,
    schemaVersion: 1,
    hashContract: { ...DOCUMENT_RECOVERY_HASH_CONTRACT },
    exercise: structuredClone(validated.input.exercise),
    source: {
      environment: 'production',
      recoverySetId,
      databaseIdentitySha256,
      objectStoreIdentitySha256,
      databaseDumpSha256: validated.source.databaseDumpSha256,
      objectBackupManifestSha256: validated.source.objectBackupManifestSha256,
      sourceCaptureReportSha256: validated.source.sourceCaptureReportSha256,
      sourceCaptureReference: validated.source.sourceCaptureReference,
      productionDocumentCount: expectedMetadata.length,
      metadataInventorySha256,
      objectInventorySha256,
      storageDeletionCount: expectedStorageDeletions.length,
      pendingStorageDeletionCount: sourcePendingStorageDeletionCount,
      deadLetterStorageDeletionCount: sourceDeadLetterStorageDeletionCount,
      processedStorageDeletionCount: expectedStorageDeletions.length,
      storageDeletionInventorySha256,
      recoveryEventCount: expectedRecoveryEvents.length,
      recoveryEventInventorySha256,
      sourceBindingSha256,
      recoverySetReference: validated.source.recoverySetReference,
    },
    target: {
      environment: 'non-production',
      restoreTargetType: 'isolated-non-production',
      isolated: true,
      databaseIdentitySha256: targetDatabaseIdentitySha256,
      objectStoreIdentitySha256: targetObjectStoreIdentitySha256,
      isolationEvidenceReference: validated.target.isolationEvidenceReference,
    },
    backupControls: structuredClone(validated.input.backupControls),
    objectives: structuredClone(validated.input.objectives),
    restore: structuredClone(validated.input.restore),
    reconciliation: {
      checksumAlgorithm: 'sha256',
      reportedSummary: exactSummary(expectedMetadata, expectedObjects, expectedStorageDeletions, expectedRecoveryEvents),
      metadataInventory: {
        inventoryScope: 'complete-document-table',
        sourceCapturedAt: sourceMetadataCapture.capturedAt,
        restoredCapturedAt: restoredMetadataCapture.capturedAt,
        sourceCaptureTransactionId: sourceMetadataCapture.captureTransactionId,
        restoredCaptureTransactionId: restoredMetadataCapture.captureTransactionId,
        sourceInventorySha256: metadataInventorySha256,
        restoredInventorySha256: restoredMetadataInventorySha256,
        expected: expectedMetadata,
        restored: restoredMetadataEntries,
      },
      objectInventory: {
        inventoryScope: 'complete-whole-bucket',
        sourceCapturedAt: sourceObjectCapture.capturedAt,
        restoredCapturedAt: restoredObjectCapture.capturedAt,
        sourceInventorySha256: objectInventorySha256,
        restoredInventorySha256: restoredObjectInventorySha256,
        expected: expectedObjects,
        restored: restoredObjectEntries,
      },
      storageDeletionInventory: {
        inventoryScope: 'complete-storage-deletion-table',
        sourceCapturedAt: sourceMetadataCapture.capturedAt,
        restoredCapturedAt: restoredMetadataCapture.capturedAt,
        sourceCaptureTransactionId: sourceMetadataCapture.captureTransactionId,
        restoredCaptureTransactionId: restoredMetadataCapture.captureTransactionId,
        sourceInventorySha256: storageDeletionInventorySha256,
        restoredInventorySha256: restoredStorageDeletionInventorySha256,
        expected: expectedStorageDeletions,
        restored: restoredStorageDeletions,
      },
      storageDeletionRecoveryInventory: {
        inventoryScope: 'complete-storage-deletion-recovery-table',
        sourceCapturedAt: sourceMetadataCapture.capturedAt,
        restoredCapturedAt: restoredMetadataCapture.capturedAt,
        sourceCaptureTransactionId: sourceMetadataCapture.captureTransactionId,
        restoredCaptureTransactionId: restoredMetadataCapture.captureTransactionId,
        sourceInventorySha256: recoveryEventInventorySha256,
        restoredInventorySha256: restoredRecoveryEventInventorySha256,
        expected: expectedRecoveryEvents,
        restored: restoredRecoveryEvents,
      },
      reportReference: validated.input.reconciliation.reportReferenceTemplate.replace(
        '{reconciliationReportSha256}',
        '0'.repeat(64),
      ),
    },
    attestations: structuredClone(validated.input.attestations),
  };
  const preliminaryRawText = `${JSON.stringify(manifest, null, 2)}\n`;
  const preliminaryValidation = validateDocumentRecoveryManifest(manifest, { now, rawText: preliminaryRawText });
  if (!SHA256_PATTERN.test(preliminaryValidation.reconciliationReportSha256)) {
    fail(`generated manifest could not compute the authoritative reconciliation digest: ${preliminaryValidation.issues.join('; ')}`);
  }
  manifest.reconciliation.reportReference = validated.input.reconciliation.reportReferenceTemplate.replace(
    '{reconciliationReportSha256}',
    preliminaryValidation.reconciliationReportSha256,
  );
  const rawText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(rawText) > DOCUMENT_RECOVERY_LIMITS.maxManifestBytes) {
    fail(`generated manifest exceeds the ${DOCUMENT_RECOVERY_LIMITS.maxManifestBytes}-byte fail-closed certification bound`);
  }
  const validation = validateDocumentRecoveryManifest(manifest, { now, rawText });
  if (!validation.ok) fail(`generated manifest failed the authoritative verifier: ${validation.issues.join('; ')}`);
  return { manifest, rawText, validation };
}

function template() {
  return {
    kind: BUILD_INPUT_KIND,
    schemaVersion: 1,
    exercise: {
      id: 'REPLACE_WITH_EXERCISE_ID',
      owner: 'REPLACE_WITH_RECOVERY_OWNER',
      startedAt: 'REPLACE_WITH_UTC_TIMESTAMP',
      simulatedFailureAt: 'REPLACE_WITH_UTC_TIMESTAMP',
      completedAt: 'REPLACE_WITH_UTC_TIMESTAMP',
      maximumRecoveryPointSkewMinutes: 0,
      maximumDocumentProofAgeMinutes: 0,
      notes: 'REPLACE_WITH_NON_SECRET_EXERCISE_NOTES',
      evidenceReference: 'https://evidence.charitypilot.ie/recovery/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
    },
    source: {
      environment: 'production',
      recoverySetId: 'REPLACE_WITH_RECOVERY_SET_ID',
      databaseIdentity: {
        provider: 'REPLACE_WITH_PROVIDER',
        projectRef: 'REPLACE_WITH_PROJECT_REF',
        databaseName: 'REPLACE_WITH_DATABASE_NAME',
        schemaName: 'REPLACE_WITH_SCHEMA_NAME',
      },
      objectStoreIdentity: {
        provider: 'REPLACE_WITH_PROVIDER',
        projectRef: 'REPLACE_WITH_PROJECT_REF',
        bucketName: 'REPLACE_WITH_BUCKET_NAME',
      },
      databaseDumpSha256: 'REPLACE_WITH_SHA256',
      objectBackupManifestSha256: 'REPLACE_WITH_SHA256',
      sourceCaptureReportSha256: 'REPLACE_WITH_SHA256',
      sourceCaptureReference: 'https://evidence.charitypilot.ie/recovery/REPLACE_WITH_SOURCE_CAPTURE_SHA256',
      recoverySetReference: 'https://evidence.charitypilot.ie/recovery/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
    },
    target: {
      environment: 'non-production',
      restoreTargetType: 'isolated-non-production',
      isolated: false,
      databaseIdentity: {
        provider: 'REPLACE_WITH_PROVIDER',
        projectRef: 'REPLACE_WITH_ISOLATED_PROJECT_REF',
        databaseName: 'REPLACE_WITH_ISOLATED_DATABASE_NAME',
        schemaName: 'REPLACE_WITH_SCHEMA_NAME',
      },
      objectStoreIdentity: {
        provider: 'REPLACE_WITH_PROVIDER',
        projectRef: 'REPLACE_WITH_ISOLATED_PROJECT_REF',
        bucketName: 'REPLACE_WITH_ISOLATED_BUCKET_NAME',
      },
      isolationEvidenceReference: 'https://evidence.charitypilot.ie/recovery/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
    },
    backupControls: {
      database: {
        encrypted: false,
        versioned: false,
        owner: 'REPLACE_WITH_DATABASE_BACKUP_OWNER',
        retentionDays: 0,
        backupPolicyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        retentionPolicyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        monitoringReference: 'https://evidence.charitypilot.ie/monitoring/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        deletionPolicyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
      },
      documentBytes: {
        encrypted: false,
        versioned: false,
        owner: 'REPLACE_WITH_DOCUMENT_BACKUP_OWNER',
        retentionDays: 0,
        backupPolicyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        retentionPolicyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        monitoringReference: 'https://evidence.charitypilot.ie/monitoring/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        deletionPolicyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
      },
    },
    objectives: {
      database: { rpoMinutes: 0, rtoMinutes: 0, policyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH' },
      documentBytes: { rpoMinutes: 0, rtoMinutes: 0, policyReference: 'https://evidence.charitypilot.ie/policies/REPLACE_WITH_IMMUTABLE_DIGEST_PATH' },
    },
    restore: {
      database: {
        completed: false,
        recoverySetId: 'REPLACE_WITH_RECOVERY_SET_ID',
        backupReference: 'https://evidence.charitypilot.ie/recovery/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        recoveredThroughAt: 'REPLACE_WITH_UTC_TIMESTAMP',
        verifiedAt: 'REPLACE_WITH_UTC_TIMESTAMP',
      },
      documentBytes: {
        completed: false,
        recoverySetId: 'REPLACE_WITH_RECOVERY_SET_ID',
        backupReference: 'https://evidence.charitypilot.ie/recovery/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
        recoveredThroughAt: 'REPLACE_WITH_UTC_TIMESTAMP',
        verifiedAt: 'REPLACE_WITH_UTC_TIMESTAMP',
      },
    },
    reconciliation: {
      reportReferenceTemplate: 'https://evidence.charitypilot.ie/recovery/reconciliation/{reconciliationReportSha256}',
    },
    attestations: {
      productionDatabaseOverwritten: false,
      productionObjectStoreOverwritten: false,
      restoreCredentialsScopedToTarget: false,
      attestedBy: 'REPLACE_WITH_RECOVERY_OPERATOR',
      attestedAt: 'REPLACE_WITH_UTC_TIMESTAMP',
      productionProtectionEvidenceReference: 'https://evidence.charitypilot.ie/recovery/REPLACE_WITH_IMMUTABLE_DIGEST_PATH',
      acknowledgement: 'REPLACE_ONLY_AFTER_CONFIRMING_ISOLATION_AND_NO_PRODUCTION_OVERWRITE',
    },
  };
}

export function posixOwnerOnlyStatMatches(
  stats,
  {
    directory = false,
    currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
  } = {},
) {
  const expectedMode = directory ? 0o700 : 0o600;
  return (
    (Number(stats.mode) & 0o777) === expectedMode &&
    (currentUid === null || currentUid === undefined || Number(stats.uid) === currentUid)
  );
}

function defaultSecureOwnerOnly(path, { directory = false } = {}) {
  if (process.platform !== 'win32') {
    chmodSync(path, directory ? 0o700 : 0o600);
    if (!posixOwnerOnlyStatMatches(statSync(path), { directory })) {
      fail('output permissions or POSIX ownership could not be restricted to the current owner');
    }
    return;
  }
  const command = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference = 'Stop'",
    '$path = $env:CHARITYPILOT_OWNER_ONLY_PATH',
    "$isDirectory = $env:CHARITYPILOT_OWNER_ONLY_DIRECTORY -eq '1'",
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = if ($isDirectory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }',
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true, $false)',
    "$inheritance = if ($isDirectory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }",
    '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)',
    '[void]$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $path -AclObject $acl',
  ].join('; ')], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CHARITYPILOT_OWNER_ONLY_PATH: path,
      CHARITYPILOT_OWNER_ONLY_DIRECTORY: directory ? '1' : '0',
    },
  });
  if (command.status !== 0 || command.signal || command.error) {
    fail('output ACLs could not be restricted to the current Windows operator');
  }
}

function defaultOwnerOnlyCheck(path, { directory = false } = {}) {
  if (process.platform !== 'win32') {
    return posixOwnerOnlyStatMatches(statSync(path), { directory });
  }
  const command = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference = 'Stop'",
    '$path = $env:CHARITYPILOT_OWNER_ONLY_PATH',
    '$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = Get-Acl -LiteralPath $path',
    '$ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier])',
    '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
    '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
    '$ok = $acl.AreAccessRulesProtected -and $ownerSid -eq $currentSid -and $rules.Count -eq 1 -and $rules[0].IdentityReference -eq $currentSid -and $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and (($rules[0].FileSystemRights -band $full) -eq $full)',
    'if (-not $ok) { exit 1 }',
    "Write-Output 'OK'",
  ].join('; ')], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CHARITYPILOT_OWNER_ONLY_PATH: path },
  });
  return command.status === 0 && command.signal === null && !command.error && command.stdout.trim() === 'OK';
}

function fileIdentity(stats) {
  if (!stats || stats.dev === undefined || stats.ino === undefined) return null;
  const dev = typeof stats.dev === 'bigint' ? stats.dev : BigInt(stats.dev);
  const ino = typeof stats.ino === 'bigint' ? stats.ino : BigInt(stats.ino);
  return dev >= 0n && ino > 0n ? `${dev}:${ino}` : null;
}

export function atomicOwnerOnlyWrite(requestedPath, rawText, {
  repoRoot = defaultRepoRoot,
  gitPathStatus,
  secureOwnerOnly = defaultSecureOwnerOnly,
  ownerOnlyCheck = defaultOwnerOnlyCheck,
  random = randomBytes,
  publicationHooks = {},
} = {}) {
  const outputPath = resolve(requestedPath);
  if (basename(outputPath).length === 0 || !outputPath.toLowerCase().endsWith('.json')) {
    fail('output-file must name a JSON file');
  }
  let existing = false;
  try {
    lstatSync(outputPath);
    existing = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('output-file state could not be checked safely');
  }
  if (existing) fail('output-file already exists; overwrites are forbidden');
  const storageIssues = manifestStorageIssues(outputPath, { repoRoot, ...(gitPathStatus ? { gitPathStatus } : {}) });
  if (storageIssues.length > 0) fail(`output-file is not approved ignored/external storage: ${storageIssues.join('; ')}`);

  const outputDirectory = dirname(outputPath);
  let directoryCreated = false;
  try {
    lstatSync(outputDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('output directory state could not be checked safely');
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    directoryCreated = true;
  }
  const directoryStat = lstatSync(outputDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('output directory must be a real directory, not a symbolic link');
  if (realpathSync(outputDirectory) !== resolve(outputDirectory)) fail('output directory must use its canonical path');
  if (directoryCreated) secureOwnerOnly(outputDirectory, { directory: true });
  if (!ownerOnlyCheck(outputDirectory, { directory: true })) {
    fail('output directory must already be restricted to the current owner');
  }
  const directoryBefore = lstatSync(outputDirectory, { bigint: true });
  const directoryIdentity = fileIdentity(directoryBefore);
  if (!directoryIdentity) fail('output directory identity could not be proven');
  let directoryDescriptor;
  try {
    directoryDescriptor = openSync(
      outputDirectory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    fail('output directory could not be opened without following links');
  }
  const openedDirectory = fstatSync(directoryDescriptor, { bigint: true });
  if (!openedDirectory.isDirectory() || fileIdentity(openedDirectory) !== directoryIdentity) {
    closeSync(directoryDescriptor);
    fail('output directory changed while it was being opened');
  }
  const assertStableDirectory = () => {
    const pathState = lstatSync(outputDirectory, { bigint: true });
    const descriptorState = fstatSync(directoryDescriptor, { bigint: true });
    if (
      pathState.isSymbolicLink() ||
      !pathState.isDirectory() ||
      fileIdentity(pathState) !== directoryIdentity ||
      fileIdentity(descriptorState) !== directoryIdentity ||
      realpathSync(outputDirectory) !== resolve(outputDirectory) ||
      !ownerOnlyCheck(outputDirectory, { directory: true })
    ) {
      fail('output directory identity or owner-only permissions changed during publication');
    }
  };

  const suffix = random(12).toString('hex');
  const temporaryPath = resolve(outputDirectory, `.${basename(outputPath)}.${process.pid}.${suffix}.tmp`);
  let descriptor;
  let temporaryExists = false;
  let temporaryIdentity = null;
  let canonicalLinkPublished = false;
  try {
    assertStableDirectory();
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    const buffer = Buffer.from(rawText, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset, offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    secureOwnerOnly(temporaryPath, { directory: false });
    if (!ownerOnlyCheck(temporaryPath, { directory: false })) {
      fail('temporary output permissions are not owner-only');
    }
    const temporaryState = lstatSync(temporaryPath, { bigint: true });
    temporaryIdentity = fileIdentity(temporaryState);
    if (temporaryState.isSymbolicLink() || !temporaryState.isFile() || !temporaryIdentity) {
      fail('temporary output identity could not be proven before publication');
    }
    assertStableDirectory();
    publicationHooks.beforePublish?.({ outputPath, outputDirectory, temporaryPath });
    assertStableDirectory();
    linkSync(temporaryPath, outputPath);
    canonicalLinkPublished = true;
    publicationHooks.afterCanonicalLink?.({ outputPath, outputDirectory, temporaryPath });
    unlinkSync(temporaryPath);
    temporaryExists = false;
    if (process.platform !== 'win32') fsyncSync(directoryDescriptor);
  } catch (error) {
    let canonicalPathCleared = !canonicalLinkPublished;
    let quarantineDirectory = null;
    if (canonicalLinkPublished && temporaryIdentity) {
      try {
        assertStableDirectory();
        const publishedState = lstatSync(outputPath, { bigint: true });
        if (
          publishedState.isSymbolicLink() ||
          !publishedState.isFile() ||
          fileIdentity(publishedState) !== temporaryIdentity
        ) {
          throw new Error('canonical publication identity changed before cleanup');
        }
        const quarantineSuffix = random(12).toString('hex');
        quarantineDirectory = resolve(
          outputDirectory,
          `.${basename(outputPath)}.unusable.${process.pid}.${quarantineSuffix}`,
        );
        mkdirSync(quarantineDirectory, { recursive: false, mode: 0o700 });
        secureOwnerOnly(quarantineDirectory, { directory: true });
        if (!ownerOnlyCheck(quarantineDirectory, { directory: true })) {
          throw new Error('failed-publication quarantine is not owner-only');
        }
        const quarantineArtifact = resolve(quarantineDirectory, 'UNUSABLE-ARTIFACT.json');
        renameSync(outputPath, quarantineArtifact);
        const quarantinedState = lstatSync(quarantineArtifact, { bigint: true });
        canonicalPathCleared = (
          !quarantinedState.isSymbolicLink() &&
          quarantinedState.isFile() &&
          fileIdentity(quarantinedState) === temporaryIdentity
        );
        if (!canonicalPathCleared) throw new Error('quarantined publication identity could not be proven');
      } catch {
        try {
          const publishedState = lstatSync(outputPath, { bigint: true });
          if (
            !publishedState.isSymbolicLink() &&
            publishedState.isFile() &&
            fileIdentity(publishedState) === temporaryIdentity
          ) {
            unlinkSync(outputPath);
            canonicalPathCleared = true;
          }
        } catch { /* exact-identity cleanup was not possible */ }
      }
    }
    if (temporaryExists && temporaryIdentity) {
      try {
        const temporaryState = lstatSync(temporaryPath, { bigint: true });
        if (
          temporaryState.isSymbolicLink() ||
          !temporaryState.isFile() ||
          fileIdentity(temporaryState) !== temporaryIdentity
        ) {
          throw new Error('temporary publication identity changed before cleanup');
        }
        try {
          unlinkSync(temporaryPath);
        } catch (unlinkError) {
          if (!quarantineDirectory) throw unlinkError;
          renameSync(temporaryPath, resolve(quarantineDirectory, 'UNUSABLE-TEMP-LINK.json'));
        }
        temporaryExists = false;
      } catch { /* best-effort exact-identity cleanup only */ }
    }
    if (process.platform !== 'win32' && canonicalPathCleared && !temporaryExists) {
      try { fsyncSync(directoryDescriptor); } catch { /* cleanup already made retry safe */ }
    }
    if (directoryDescriptor !== undefined) {
      closeSync(directoryDescriptor);
      directoryDescriptor = undefined;
    }
    if (canonicalLinkPublished) {
      const original = error instanceof Error ? error.message : 'post-link publication failed';
      throw new Error(
        canonicalPathCleared && !temporaryExists
          ? `${original}; failed canonical publication was quarantined or removed and retry is safe`
          : `${original}; failed canonical publication could not be cleared safely and retry remains blocked`,
      );
    }
    if (error instanceof Error && /output|ACL|permission/i.test(error.message)) throw error;
    fail('output-file could not be written atomically without overwrite');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryExists) {
      try { unlinkSync(temporaryPath); } catch { /* best-effort cleanup only */ }
    }
  }
  let publishedIdentity = null;
  try {
    const published = lstatSync(outputPath, { bigint: true });
    publishedIdentity = fileIdentity(published);
    if (!published.isFile() || published.isSymbolicLink() || !publishedIdentity) {
      fail('output-file failed its atomic publication identity check');
    }
    publicationHooks.afterPublish?.({ outputPath, outputDirectory, temporaryPath });
    assertStableDirectory();
    const expectedBytes = Buffer.from(rawText, 'utf8');
    const expectedSha256 = sha256(expectedBytes);
    const pathBeforeOpen = lstatSync(outputPath, { bigint: true });
    if (
      pathBeforeOpen.isSymbolicLink() ||
      !pathBeforeOpen.isFile() ||
      fileIdentity(pathBeforeOpen) !== publishedIdentity
    ) {
      fail('output-file was substituted after publication');
    }
    let finalDescriptor;
    try {
      finalDescriptor = openSync(outputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(finalDescriptor, { bigint: true });
      if (
        !opened.isFile() ||
        fileIdentity(opened) !== publishedIdentity ||
        opened.size !== BigInt(expectedBytes.length)
      ) {
        fail('output-file descriptor does not match the atomically published file');
      }
      if (!ownerOnlyCheck(outputPath, { directory: false })) {
        fail('output-file permissions are not owner-only');
      }
      const readBuffer = Buffer.alloc(expectedBytes.length + 1);
      let offset = 0;
      while (offset < readBuffer.length) {
        const read = readSync(finalDescriptor, readBuffer, offset, readBuffer.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      const afterRead = fstatSync(finalDescriptor, { bigint: true });
      const pathAfterRead = lstatSync(outputPath, { bigint: true });
      if (
        offset !== expectedBytes.length ||
        !readBuffer.subarray(0, offset).equals(expectedBytes) ||
        sha256(readBuffer.subarray(0, offset)) !== expectedSha256 ||
        fileIdentity(afterRead) !== publishedIdentity ||
        afterRead.size !== BigInt(expectedBytes.length) ||
        fileIdentity(pathAfterRead) !== publishedIdentity ||
        pathAfterRead.isSymbolicLink()
      ) {
        fail('output-file bytes, hash, size, mode, or path identity changed after publication');
      }
    } finally {
      if (finalDescriptor !== undefined) closeSync(finalDescriptor);
    }
    assertStableDirectory();
    const finalPathState = lstatSync(outputPath, { bigint: true });
    if (
      finalPathState.isSymbolicLink() ||
      !finalPathState.isFile() ||
      fileIdentity(finalPathState) !== publishedIdentity ||
      finalPathState.size !== BigInt(expectedBytes.length) ||
      !ownerOnlyCheck(outputPath, { directory: false })
    ) {
      fail('output-file failed its final closed-descriptor identity and owner-mode check');
    }
    return {
      outputPath,
      atomicNoOverwritePublished: true,
      stableDirectoryIdentityVerified: true,
      ownerOnlyDirectoryVerified: true,
      ownerOnlyFileVerified: true,
      noFollowReopenUsed: constants.O_NOFOLLOW !== undefined,
      platformPathIdentityChecksUsed: true,
      exactBytesAndSha256Verified: true,
      sha256: expectedSha256,
    };
  } catch (error) {
    let quarantined = false;
    try {
      assertStableDirectory();
      const quarantineSuffix = random(12).toString('hex');
      const quarantineDirectory = resolve(
        outputDirectory,
        `.${basename(outputPath)}.unusable.${process.pid}.${quarantineSuffix}`,
      );
      mkdirSync(quarantineDirectory, { recursive: false, mode: 0o700 });
      secureOwnerOnly(quarantineDirectory, { directory: true });
      if (!ownerOnlyCheck(quarantineDirectory, { directory: true })) {
        fail('unusable publication quarantine is not owner-only');
      }
      const quarantineArtifact = resolve(quarantineDirectory, 'UNUSABLE-ARTIFACT.json');
      renameSync(outputPath, quarantineArtifact);
      const quarantineState = lstatSync(quarantineArtifact, { bigint: true });
      if (!quarantineState.isSymbolicLink() && quarantineState.isFile()) {
        quarantined = true;
      }
      if (process.platform !== 'win32') fsyncSync(directoryDescriptor);
    } catch {
      quarantined = false;
    }
    const original = error instanceof Error ? error.message : 'output-file post-publication verification failed';
    throw new Error(
      quarantined
        ? `${original}; failed publication was quarantined as unusable without deleting any path`
        : `${original}; failed publication remains unusable and was not deleted`,
    );
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
}

function parseArgs(args) {
  const options = { action: null, json: false, help: false };
  const flags = new Map([
    ['--output-file', 'outputFile'],
    ['--config-file', 'configFile'],
    ['--source-metadata-file', 'sourceMetadataFile'],
    ['--restored-metadata-file', 'restoredMetadataFile'],
    ['--source-object-inventory-file', 'sourceObjectInventoryFile'],
    ['--restored-object-inventory-file', 'restoredObjectInventoryFile'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      if (options.help) fail('--help must be provided at most once');
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      if (options.json) fail('--json must be provided at most once');
      options.json = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      if (options.action) fail('exactly one action is required');
      options.action = arg;
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const key = flags.get(flag);
    if (!key) fail('unknown option');
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (!value || (equals === -1 && value.startsWith('--'))) fail(`${flag} requires a value`);
    if (options[key]) fail(`${flag} must be provided exactly once`);
    options[key] = value;
    if (equals === -1) index += 1;
  }
  if (options.help) return options;
  if (!['template', 'build'].includes(options.action)) fail('action must be template or build');
  if (!options.outputFile) fail('--output-file is required');
  const buildKeys = ['configFile', 'sourceMetadataFile', 'restoredMetadataFile', 'sourceObjectInventoryFile', 'restoredObjectInventoryFile'];
  if (options.action === 'template' && buildKeys.some((key) => options[key])) fail('template does not accept build input files');
  if (options.action === 'build' && buildKeys.some((key) => !options[key])) fail('build requires all four inventory files and --config-file');
  return options;
}

function renderBuildSuccess(payload) {
  return [
    'Document recovery manifest generated from operator-supplied offline exports.',
    `Recovery set: ${payload.recoverySetId}`,
    `Manifest SHA-256: ${payload.recoveryManifestSha256}`,
    `Source binding SHA-256: ${payload.sourceBindingSha256}`,
    `Reconciliation report SHA-256: ${payload.reconciliationReportSha256}`,
    `Documents: ${payload.productionDocumentCount}`,
    `Storage-deletion lifecycle rows: ${payload.storageDeletionCount}; pending: ${payload.pendingStorageDeletionCount}; dead-letter: ${payload.deadLetterStorageDeletionCount}.`,
    `Document proof fresh through: ${payload.documentProofFreshThroughAt}.`,
    'Source provenance externally verified: no.',
    'Retain this output with the immutable provider/operator source capture outside git.',
    PROVENANCE_LIMITATION,
    '',
  ].join('\n');
}

export function runGenerateDocumentRecoveryManifestFromArgs(args = process.argv.slice(2), {
  cwd = process.cwd(),
  repoRoot = defaultRepoRoot,
  now = () => new Date(),
  gitPathStatus,
  secureOwnerOnly,
  ownerOnlyCheck,
  publicationHooks,
} = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${safeError(error)}\n`);
  }
  if (options.help) return result(0, usage(), '');
  const outputFile = resolve(cwd, options.outputFile);
  try {
    if (options.action === 'template') {
      const rawText = `${JSON.stringify(template(), null, 2)}\n`;
      const publication = atomicOwnerOnlyWrite(outputFile, rawText, {
        repoRoot,
        gitPathStatus,
        ...(secureOwnerOnly ? { secureOwnerOnly } : {}),
        ...(ownerOnlyCheck ? { ownerOnlyCheck } : {}),
        ...(publicationHooks ? { publicationHooks } : {}),
      });
      const payload = {
        ok: true,
        action: 'template',
        format: BUILD_INPUT_KIND,
        safePlaceholder: true,
        productionConnected: false,
        productionMutated: false,
        overwriteAllowed: false,
        publication: {
          atomicNoOverwritePublished: publication.atomicNoOverwritePublished,
          stableDirectoryIdentityVerified: publication.stableDirectoryIdentityVerified,
          ownerOnlyDirectoryVerified: publication.ownerOnlyDirectoryVerified,
          ownerOnlyFileVerified: publication.ownerOnlyFileVerified,
          noFollowReopenUsed: publication.noFollowReopenUsed,
          platformPathIdentityChecksUsed: publication.platformPathIdentityChecksUsed,
          exactBytesAndSha256Verified: publication.exactBytesAndSha256Verified,
          outputSha256: publication.sha256,
        },
      };
      return options.json
        ? result(0, `${JSON.stringify(payload, null, 2)}\n`, '')
        : result(0, 'Safe document recovery build-input template created. Complete it only from provider/operator evidence; it is intentionally invalid until every placeholder is replaced.\n', '');
    }

    const config = readJsonFile(resolve(cwd, options.configFile), 'build input', MAX_CONFIG_BYTES).data;
    const sourceMetadata = readJsonFile(resolve(cwd, options.sourceMetadataFile), 'source metadata export', MAX_INPUT_BYTES).data;
    const restoredMetadata = readJsonFile(resolve(cwd, options.restoredMetadataFile), 'restored metadata export', MAX_INPUT_BYTES).data;
    const sourceObjects = readJsonFile(resolve(cwd, options.sourceObjectInventoryFile), 'source object inventory export', MAX_INPUT_BYTES).data;
    const restoredObjects = readJsonFile(resolve(cwd, options.restoredObjectInventoryFile), 'restored object inventory export', MAX_INPUT_BYTES).data;
    const built = buildManifest({ config, sourceMetadata, restoredMetadata, sourceObjects, restoredObjects, now: now() });
    const publication = atomicOwnerOnlyWrite(outputFile, built.rawText, {
      repoRoot,
      gitPathStatus,
      ...(secureOwnerOnly ? { secureOwnerOnly } : {}),
      ...(ownerOnlyCheck ? { ownerOnlyCheck } : {}),
      ...(publicationHooks ? { publicationHooks } : {}),
    });
    const payload = {
      ok: true,
      action: 'build',
      manifestFormat: 'charitypilot-document-recovery-manifest-v1',
      recoveryManifestSha256: sha256(Buffer.from(built.rawText, 'utf8')),
      sourceBindingSha256: built.manifest.source.sourceBindingSha256,
      sourceCaptureReportSha256: built.manifest.source.sourceCaptureReportSha256,
      sourceDatabaseIdentitySha256: built.manifest.source.databaseIdentitySha256,
      sourceObjectStoreIdentitySha256: built.manifest.source.objectStoreIdentitySha256,
      databaseDumpSha256: built.manifest.source.databaseDumpSha256,
      objectBackupManifestSha256: built.manifest.source.objectBackupManifestSha256,
      metadataInventorySha256: built.manifest.source.metadataInventorySha256,
      objectInventorySha256: built.manifest.source.objectInventorySha256,
      restoredMetadataInventorySha256: built.validation.bindings.restoredMetadataInventorySha256,
      restoredObjectInventorySha256: built.validation.bindings.restoredObjectInventorySha256,
      storageDeletionInventorySha256: built.manifest.source.storageDeletionInventorySha256,
      restoredStorageDeletionInventorySha256: built.validation.bindings.restoredStorageDeletionInventorySha256,
      recoveryEventInventorySha256: built.manifest.source.recoveryEventInventorySha256,
      restoredRecoveryEventInventorySha256: built.validation.bindings.restoredRecoveryEventInventorySha256,
      reconciliationReportSha256: built.validation.reconciliationReportSha256,
      productionDocumentCount: built.manifest.source.productionDocumentCount,
      storageDeletionCount: built.manifest.source.storageDeletionCount,
      pendingStorageDeletionCount: built.manifest.source.pendingStorageDeletionCount,
      deadLetterStorageDeletionCount: built.manifest.source.deadLetterStorageDeletionCount,
      processedStorageDeletionCount: built.manifest.source.processedStorageDeletionCount,
      restoredStorageDeletionCount: built.validation.summary.restoredStorageDeletionRows,
      restoredPendingStorageDeletionCount: built.validation.summary.restoredPendingStorageDeletionCount,
      restoredDeadLetterStorageDeletionCount: built.validation.summary.restoredDeadLetterStorageDeletionCount,
      restoredProcessedStorageDeletionCount: built.validation.summary.restoredProcessedStorageDeletionCount,
      recoveryEventCount: built.manifest.source.recoveryEventCount,
      restoredRecoveryEventCount: built.validation.summary.restoredRecoveryEventRows,
      sourceMetadataCapturedAt: built.validation.captureTimes.sourceMetadataCapturedAt,
      restoredMetadataCapturedAt: built.validation.captureTimes.restoredMetadataCapturedAt,
      sourceObjectInventoryCapturedAt: built.validation.captureTimes.sourceObjectInventoryCapturedAt,
      restoredObjectInventoryCapturedAt: built.validation.captureTimes.restoredObjectInventoryCapturedAt,
      sourceMetadataCaptureTransactionId: built.validation.captureTimes.sourceMetadataCaptureTransactionId,
      restoredMetadataCaptureTransactionId: built.validation.captureTimes.restoredMetadataCaptureTransactionId,
      documentProofOldestCapturedAt: built.validation.documentProof.oldestCapturedAt,
      documentProofAgeMinutes: built.validation.documentProof.ageMinutes,
      maximumDocumentProofAgeMinutes: built.validation.documentProof.maximumAgeMinutes,
      documentProofFreshThroughAt: built.validation.documentProof.freshThroughAt,
      documentProofFresh: built.validation.documentProof.fresh,
      exerciseId: built.validation.bindings.exerciseId,
      recoverySetId: built.manifest.source.recoverySetId,
      sourceCaptureRequired: true,
      independentBindingArgumentsMatched: false,
      sourceProvenanceExternallyVerified: false,
      providerOperatorProvenanceVerified: false,
      provenanceLimitation: PROVENANCE_LIMITATION,
      productionConnected: false,
      productionMutated: false,
      secretValuesPrinted: false,
      overwriteAllowed: false,
      publication: {
        atomicNoOverwritePublished: publication.atomicNoOverwritePublished,
        stableDirectoryIdentityVerified: publication.stableDirectoryIdentityVerified,
        ownerOnlyDirectoryVerified: publication.ownerOnlyDirectoryVerified,
        ownerOnlyFileVerified: publication.ownerOnlyFileVerified,
        noFollowReopenUsed: publication.noFollowReopenUsed,
        platformPathIdentityChecksUsed: publication.platformPathIdentityChecksUsed,
        exactBytesAndSha256Verified: publication.exactBytesAndSha256Verified,
        outputSha256: publication.sha256,
      },
    };
    return options.json ? result(0, `${JSON.stringify(payload, null, 2)}\n`, '') : result(0, renderBuildSuccess(payload), '');
  } catch (error) {
    const issue = safeError(error);
    const payload = { ok: false, issueCount: 1, issues: [issue], secretValuesPrinted: false };
    return options.json ? result(1, `${JSON.stringify(payload, null, 2)}\n`, '') : result(1, '', `Document recovery manifest generation failed: ${issue}\n`);
  }
}

function main() {
  const commandResult = runGenerateDocumentRecoveryManifestFromArgs();
  if (commandResult.stdout) process.stdout.write(commandResult.stdout);
  if (commandResult.stderr) process.stderr.write(commandResult.stderr);
  process.exitCode = commandResult.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
