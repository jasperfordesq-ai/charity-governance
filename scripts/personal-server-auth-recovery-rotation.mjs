import { createHash } from 'node:crypto';

export const AUTH_RECOVERY_ROTATION_RECEIPT_FORMAT =
  'charitypilot-personal-server-auth-recovery-rotation-receipt/v1';
export const AUTH_RECOVERY_ROTATION_ARCHIVE_FORMAT =
  'charitypilot-personal-server-auth-recovery-rotation-archive/v1';
export const AUTH_RECOVERY_ROTATION_REVIEW_TTL_MS = 30 * 60 * 1000;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const RECEIPT_ID_PATTERN = /^[a-f0-9]{24}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const ROTATION_REASONS = new Set([
  'PLANNED_KEY_ROTATION',
  'SUSPECTED_KEY_COMPROMISE',
]);
const RECEIPT_PHASES = new Set([
  'review-ready',
  'backup-complete',
  'executing',
  'blocked',
  'secret-replaced',
  'activating',
  'activated',
  'completed',
]);
const TRANSITIONS = new Map([
  ['review-ready', 'backup-complete'],
  ['backup-complete', 'executing'],
  ['executing', 'blocked'],
  ['blocked', 'secret-replaced'],
  ['secret-replaced', 'activating'],
  ['activating', 'activated'],
  ['activated', 'completed'],
]);
const MUTABLE_COUNT_NAMES = [
  'capabilities',
  'requestEvidenceRows',
  'legacySlots',
  'rateBuckets',
];
const REVIEW_COUNT_NAMES = [
  'generation',
  ...MUTABLE_COUNT_NAMES,
  'securityNotices',
];
const IDENTITY_HASH_NAMES = [
  'sourceSha256',
  'installationSha256',
  'imagesSha256',
  'environmentSha256',
];
const JOB_OUTPUT_LIMIT_BYTES = 32 * 1024;
const ENVIRONMENT_LIMIT_BYTES = 1024 * 1024;
const MAX_HISTORY_ENTRIES = 16;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertPlainObject(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, required, optional, label) {
  const actual = Object.keys(assertPlainObject(value, label));
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) {
    throw new Error(
      `${label} has an invalid field set` +
      `${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
      `${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`,
    );
  }
}

function safeInteger(value, label, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0)
  ) {
    throw new Error(`${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
  return value;
}

function lowercaseSha256(value, label) {
  if (!HASH_PATTERN.test(String(value ?? ''))) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalInstant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  return milliseconds;
}

function nowInstant(now) {
  const candidate = typeof now === 'function' ? now() : (now ?? new Date());
  if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) {
    throw new Error('Rotation clock returned an invalid instant');
  }
  return candidate.toISOString();
}

function rotationReason(value) {
  if (!ROTATION_REASONS.has(value)) {
    throw new Error(
      'Rotation reason must be exactly PLANNED_KEY_ROTATION or SUSPECTED_KEY_COMPROMISE',
    );
  }
  return value;
}

function canonicalOperator(value) {
  const operator = String(value ?? '').trim();
  if (
    operator.length < 3 ||
    operator.length > 160 ||
    CONTROL_CHARACTERS.test(operator) ||
    /[@:\\/]/u.test(operator) ||
    /^(?:admin|administrator|operator|system|unknown)$/iu.test(operator)
  ) {
    throw new Error('Operator must be a safe named human identity');
  }
  return operator;
}

function canonicalCaseReference(value) {
  const reference = String(value ?? '').trim();
  if (
    reference.length < 3 ||
    reference.length > 128 ||
    CONTROL_CHARACTERS.test(reference)
  ) {
    throw new Error('Case reference must contain 3 to 128 non-control characters');
  }
  return reference;
}

function canonicalJsonValue(value, path = 'identity') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${path} contains a non-canonical number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`));
  }
  assertPlainObject(value, path);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!key || CONTROL_CHARACTERS.test(key) || value[key] === undefined) {
      throw new Error(`${path} contains a non-canonical field`);
    }
    result[key] = canonicalJsonValue(value[key], `${path}.${key}`);
  }
  return result;
}

function canonicalCounts(value, label = 'Rotation counts') {
  assertExactKeys(value, REVIEW_COUNT_NAMES, [], label);
  const counts = {};
  for (const name of REVIEW_COUNT_NAMES) {
    counts[name] = safeInteger(value[name], `${label}.${name}`, {
      positive: name === 'generation',
    });
  }
  return counts;
}

function canonicalIdentityHashes(value, label = 'Rotation identity hashes') {
  assertExactKeys(value, IDENTITY_HASH_NAMES, [], label);
  return Object.fromEntries(
    IDENTITY_HASH_NAMES.map((name) => [name, lowercaseSha256(value[name], `${label}.${name}`)]),
  );
}

function appendBounded(history, entry) {
  return [...(history ?? []), entry].slice(-MAX_HISTORY_ENTRIES);
}

function failureDigest(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown failure');
  return sha256(`charitypilot-auth-recovery-rotation/failure/v1\0${message}`);
}

export function authRecoveryRotationIdentitySha256(kind, identity) {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(String(kind ?? ''))) {
    throw new Error('Rotation identity kind is invalid');
  }
  const canonical = JSON.stringify(canonicalJsonValue(identity));
  return sha256(
    `charitypilot-personal-server-auth-recovery-rotation/${kind}/v1\0${canonical}`,
  );
}

export function authRecoveryRotationEnvironmentSha256(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > ENVIRONMENT_LIMIT_BYTES) {
    throw new Error('Protected environment content is invalid or too large');
  }
  return sha256(
    Buffer.concat([
      Buffer.from('charitypilot-personal-server-auth-recovery-rotation/environment/v1\0'),
      Buffer.from(content, 'utf8'),
    ]),
  );
}

export function createAuthRecoveryRotationIdentityHashes({
  source,
  installation,
  images,
  environmentContent,
}) {
  return {
    sourceSha256: authRecoveryRotationIdentitySha256('source', source),
    installationSha256: authRecoveryRotationIdentitySha256('installation', installation),
    imagesSha256: authRecoveryRotationIdentitySha256('images', images),
    environmentSha256: authRecoveryRotationEnvironmentSha256(environmentContent),
  };
}

function parseJsonObject(text, label) {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') < 2 ||
    Buffer.byteLength(text, 'utf8') > JOB_OUTPUT_LIMIT_BYTES
  ) {
    throw new Error(`${label} is empty or exceeds the count-only evidence limit`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be one JSON object with no log prefix or suffix`);
  }
  return assertPlainObject(value, label);
}

function assertBoolean(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be exactly ${expected}`);
}

function commonJobEvidence(value, label) {
  rotationReason(value.reason);
  if (value.terminationReason !== undefined && value.terminationReason !== 'KEY_ROTATED') {
    throw new Error(`${label}.terminationReason must be exactly KEY_ROTATED`);
  }
  lowercaseSha256(value.caseReferenceSha256, `${label}.caseReferenceSha256`);
  lowercaseSha256(value.databaseIdentitySha256, `${label}.databaseIdentitySha256`);
  if (value.deploymentProfile !== 'personal-server') {
    throw new Error(`${label}.deploymentProfile must be exactly personal-server`);
  }
  assertBoolean(value.credentialsIssued, false, `${label}.credentialsIssued`);
}

const DRY_RUN_KEYS = [
  'mode', 'mutationApplied', ...REVIEW_COUNT_NAMES, 'reason', 'terminationReason',
  'securityNoticesPreserved', 'caseReferenceSha256', 'databaseIdentitySha256',
  'deploymentProfile', 'executionConfirmation', 'credentialsIssued',
];
const EXECUTED_KEYS = [
  'mode', 'mutationApplied', 'recoveryBlocked', 'rotatedGeneration',
  'blockedGeneration', 'activationConfirmation', 'invalidatedCapabilities',
  'redactedRequestEvidenceRows', 'clearedLegacySlots', 'deletedRateBuckets',
  'securityNotices', 'remainingCapabilities', 'remainingRequestEvidenceRows',
  'remainingLegacySlots', 'remainingRateBuckets', 'reason', 'terminationReason',
  'securityNoticesPreserved', 'caseReferenceSha256', 'databaseIdentitySha256',
  'deploymentProfile', 'executionConfirmation', 'credentialsIssued',
];
const ACTIVATED_KEYS = [
  'mode', 'mutationApplied', 'generation', 'recoveryBlocked',
  'remainingCapabilities', 'remainingRequestEvidenceRows', 'remainingLegacySlots',
  'remainingRateBuckets', 'securityNoticesPreserved', 'reason',
  'caseReferenceSha256', 'databaseIdentitySha256', 'deploymentProfile',
  'activationConfirmation', 'credentialsIssued',
];
const CONTROL_STATUS_KEYS = [
  'mode', 'mutationApplied', 'blocked', 'generation', 'currentSecretActive',
  'capabilities', 'requestEvidenceRows', 'legacySlots', 'rateBuckets',
  'securityNotices', 'reason', 'caseReferenceSha256', 'databaseIdentitySha256',
  'deploymentProfile', 'credentialsIssued',
];

function nonEmptyConfirmation(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 4096 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function parseAuthRecoveryRotationJobEvidence(text, expectedMode) {
  const value = parseJsonObject(text, 'Auth recovery rotation job evidence');
  if (!['DRY_RUN', 'EXECUTED', 'ACTIVATED', 'CONTROL_STATUS'].includes(value.mode)) {
    throw new Error('Auth recovery rotation job evidence has an invalid mode');
  }
  if (expectedMode !== undefined && value.mode !== expectedMode) {
    throw new Error(`Expected ${expectedMode} auth recovery evidence, received ${value.mode}`);
  }
  commonJobEvidence(value, 'Auth recovery rotation job evidence');

  if (value.mode === 'CONTROL_STATUS') {
    assertExactKeys(
      value,
      CONTROL_STATUS_KEYS,
      [],
      'Auth recovery rotation CONTROL_STATUS evidence',
    );
    assertBoolean(value.mutationApplied, false, 'CONTROL_STATUS.mutationApplied');
    if (typeof value.blocked !== 'boolean' || typeof value.currentSecretActive !== 'boolean') {
      throw new Error('CONTROL_STATUS blocked/currentSecretActive fields must be booleans');
    }
    canonicalCounts(
      Object.fromEntries(REVIEW_COUNT_NAMES.map((name) => [name, value[name]])),
      'CONTROL_STATUS counts',
    );
    if (value.blocked === value.currentSecretActive) {
      throw new Error(
        'CONTROL_STATUS must report exactly one of blocked or currentSecretActive',
      );
    }
    return Object.freeze({ ...value });
  }

  if (value.mode === 'DRY_RUN') {
    assertExactKeys(value, DRY_RUN_KEYS, [], 'Auth recovery rotation DRY_RUN evidence');
    assertBoolean(value.mutationApplied, false, 'DRY_RUN.mutationApplied');
    const counts = canonicalCounts(
      Object.fromEntries(REVIEW_COUNT_NAMES.map((name) => [name, value[name]])),
      'DRY_RUN counts',
    );
    safeInteger(value.securityNoticesPreserved, 'DRY_RUN.securityNoticesPreserved');
    if (value.securityNoticesPreserved !== counts.securityNotices) {
      throw new Error('DRY_RUN security notice count is internally inconsistent');
    }
    nonEmptyConfirmation(value.executionConfirmation, 'DRY_RUN.executionConfirmation');
    return Object.freeze({ ...value });
  }

  if (value.mode === 'EXECUTED') {
    assertExactKeys(value, EXECUTED_KEYS, [], 'Auth recovery rotation EXECUTED evidence');
    assertBoolean(value.mutationApplied, true, 'EXECUTED.mutationApplied');
    assertBoolean(value.recoveryBlocked, true, 'EXECUTED.recoveryBlocked');
    for (const name of [
      'rotatedGeneration', 'blockedGeneration', 'invalidatedCapabilities',
      'redactedRequestEvidenceRows', 'clearedLegacySlots', 'deletedRateBuckets',
      'securityNotices', 'remainingCapabilities', 'remainingRequestEvidenceRows',
      'remainingLegacySlots', 'remainingRateBuckets', 'securityNoticesPreserved',
    ]) safeInteger(value[name], `EXECUTED.${name}`, { positive: name === 'rotatedGeneration' });
    if (value.blockedGeneration !== value.rotatedGeneration + 1) {
      throw new Error('EXECUTED blocked generation is not the reviewed generation plus one');
    }
    for (const name of [
      'remainingCapabilities', 'remainingRequestEvidenceRows',
      'remainingLegacySlots', 'remainingRateBuckets',
    ]) {
      if (value[name] !== 0) throw new Error(`EXECUTED.${name} must be zero`);
    }
    if (value.securityNotices !== value.securityNoticesPreserved) {
      throw new Error('EXECUTED security notice preservation is internally inconsistent');
    }
    nonEmptyConfirmation(value.executionConfirmation, 'EXECUTED.executionConfirmation');
    nonEmptyConfirmation(value.activationConfirmation, 'EXECUTED.activationConfirmation');
    return Object.freeze({ ...value });
  }

  assertExactKeys(value, ACTIVATED_KEYS, [], 'Auth recovery rotation ACTIVATED evidence');
  assertBoolean(value.mutationApplied, true, 'ACTIVATED.mutationApplied');
  assertBoolean(value.recoveryBlocked, false, 'ACTIVATED.recoveryBlocked');
  for (const name of [
    'generation', 'remainingCapabilities', 'remainingRequestEvidenceRows',
    'remainingLegacySlots', 'remainingRateBuckets', 'securityNoticesPreserved',
  ]) safeInteger(value[name], `ACTIVATED.${name}`, { positive: name === 'generation' });
  for (const name of [
    'remainingCapabilities', 'remainingRequestEvidenceRows',
    'remainingLegacySlots', 'remainingRateBuckets',
  ]) {
    if (value[name] !== 0) throw new Error(`ACTIVATED.${name} must be zero`);
  }
  nonEmptyConfirmation(value.activationConfirmation, 'ACTIVATED.activationConfirmation');
  return Object.freeze({ ...value });
}

export function authRecoveryRotationComprehensiveConfirmation(receipt) {
  if (!RECEIPT_ID_PATTERN.test(String(receipt?.receiptId ?? ''))) {
    throw new Error('Rotation receipt identity is invalid');
  }
  canonicalInstant(receipt.reviewExpiresAt, 'Receipt review expiry');
  const counts = canonicalCounts(receipt?.review?.counts, 'Receipt review counts');
  const identities = canonicalIdentityHashes(receipt?.identities, 'Receipt identities');
  if (receipt?.review?.deploymentProfile !== 'personal-server') {
    throw new Error('Receipt deployment profile must be exactly personal-server');
  }
  return [
    'ROTATE CHARITYPILOT PERSONAL AUTH RECOVERY SECRET',
    `RECEIPT ${receipt.receiptId}`,
    `EXPIRES ${receipt.reviewExpiresAt}`,
    `REASON ${rotationReason(receipt.reason)}`,
    `OPERATOR SHA256 ${lowercaseSha256(receipt.operatorSha256, 'Receipt operator hash')}`,
    `CASE SHA256 ${lowercaseSha256(receipt.caseReferenceSha256, 'Receipt case hash')}`,
    `GENERATION ${counts.generation}`,
    `TERMINATE ${counts.capabilities} CAPABILITIES`,
    `REDACT ${counts.requestEvidenceRows} REQUEST EVIDENCE ROWS`,
    `CLEAR ${counts.legacySlots} LEGACY SLOTS`,
    `DELETE ${counts.rateBuckets} RATE BUCKETS`,
    `PRESERVE ${counts.securityNotices} SECURITY NOTICES`,
    `DATABASE SHA256 ${lowercaseSha256(receipt.review.databaseIdentitySha256, 'Receipt database hash')}`,
    `PROFILE ${receipt.review.deploymentProfile}`,
    `SOURCE SHA256 ${identities.sourceSha256}`,
    `INSTALLATION SHA256 ${identities.installationSha256}`,
    `IMAGES SHA256 ${identities.imagesSha256}`,
    `ENVIRONMENT SHA256 ${identities.environmentSha256}`,
  ].join(' ');
}

export function createAuthRecoveryRotationReviewReceipt({
  receiptId,
  reason,
  operator,
  caseReference,
  identities,
  dryRunEvidence,
  now = new Date(),
}) {
  if (!RECEIPT_ID_PATTERN.test(String(receiptId ?? ''))) {
    throw new Error('Rotation receipt identity must be 24 lowercase hexadecimal characters');
  }
  const evidence = typeof dryRunEvidence === 'string'
    ? parseAuthRecoveryRotationJobEvidence(dryRunEvidence, 'DRY_RUN')
    : parseAuthRecoveryRotationJobEvidence(JSON.stringify(dryRunEvidence), 'DRY_RUN');
  const canonicalReason = rotationReason(reason);
  const canonicalOperatorValue = canonicalOperator(operator);
  const canonicalCase = canonicalCaseReference(caseReference);
  if (evidence.reason !== canonicalReason) throw new Error('Reviewed rotation reason changed');
  const caseReferenceSha256 = sha256(canonicalCase);
  if (evidence.caseReferenceSha256 !== caseReferenceSha256) {
    throw new Error('Reviewed rotation case-reference digest does not match the named case');
  }
  const createdAt = nowInstant(now);
  const reviewExpiresAt = new Date(
    canonicalInstant(createdAt, 'Receipt creation time') + AUTH_RECOVERY_ROTATION_REVIEW_TTL_MS,
  ).toISOString();
  const receipt = {
    format: AUTH_RECOVERY_ROTATION_RECEIPT_FORMAT,
    receiptId,
    phase: 'review-ready',
    createdAt,
    updatedAt: createdAt,
    reviewExpiresAt,
    reason: canonicalReason,
    operatorSha256: sha256(canonicalOperatorValue),
    caseReferenceSha256,
    identities: canonicalIdentityHashes(identities),
    review: {
      counts: Object.fromEntries(REVIEW_COUNT_NAMES.map((name) => [name, evidence[name]])),
      databaseIdentitySha256: evidence.databaseIdentitySha256,
      deploymentProfile: evidence.deploymentProfile,
      jobExecutionConfirmation: evidence.executionConfirmation,
    },
  };
  receipt.confirmation = authRecoveryRotationComprehensiveConfirmation(receipt);
  validateAuthRecoveryRotationReceipt(receipt);
  return receipt;
}

function validateBackup(value) {
  assertExactKeys(value, ['completedAt', 'referenceSha256', 'manifestSha256'], [], 'Rotation backup binding');
  canonicalInstant(value.completedAt, 'Rotation backup completion');
  lowercaseSha256(value.referenceSha256, 'Rotation backup reference hash');
  lowercaseSha256(value.manifestSha256, 'Rotation backup manifest hash');
}

function validateExecution(value) {
  assertExactKeys(value, [
    'completedAt', 'rotatedGeneration', 'blockedGeneration', 'activationConfirmation',
    'evidenceSha256', 'source',
  ], [], 'Rotation execution checkpoint');
  canonicalInstant(value.completedAt, 'Rotation execution completion');
  safeInteger(value.rotatedGeneration, 'Rotation execution generation', { positive: true });
  safeInteger(value.blockedGeneration, 'Rotation blocked generation', { positive: true });
  if (value.blockedGeneration !== value.rotatedGeneration + 1) {
    throw new Error('Rotation execution generations are inconsistent');
  }
  nonEmptyConfirmation(value.activationConfirmation, 'Rotation activation confirmation');
  lowercaseSha256(value.evidenceSha256, 'Rotation execution evidence hash');
  if (!['job-output', 'live-reconciliation'].includes(value.source)) {
    throw new Error('Rotation execution checkpoint source is invalid');
  }
}

function validateReplacement(value) {
  assertExactKeys(value, [
    'completedAt', 'beforeEnvironmentSha256', 'afterEnvironmentSha256',
    'oldSecretSha256', 'newSecretSha256', 'changedLineCount',
  ], [], 'Rotation replacement checkpoint');
  canonicalInstant(value.completedAt, 'Rotation replacement completion');
  for (const name of [
    'beforeEnvironmentSha256', 'afterEnvironmentSha256',
    'oldSecretSha256', 'newSecretSha256',
  ]) lowercaseSha256(value[name], `Rotation replacement ${name}`);
  if (
    value.beforeEnvironmentSha256 === value.afterEnvironmentSha256 ||
    value.oldSecretSha256 === value.newSecretSha256 ||
    value.changedLineCount !== 1
  ) {
    throw new Error('Rotation replacement checkpoint is internally inconsistent');
  }
}

function validateActivation(value) {
  assertExactKeys(value, [
    'completedAt', 'generation', 'securityNoticesPreserved', 'evidenceSha256', 'source',
  ], [], 'Rotation activation checkpoint');
  canonicalInstant(value.completedAt, 'Rotation activation completion');
  safeInteger(value.generation, 'Rotation activation generation', { positive: true });
  safeInteger(value.securityNoticesPreserved, 'Rotation activation security notices');
  lowercaseSha256(value.evidenceSha256, 'Rotation activation evidence hash');
  if (!['job-output', 'live-reconciliation'].includes(value.source)) {
    throw new Error('Rotation activation checkpoint source is invalid');
  }
}

function validateHistory(value, kind) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HISTORY_ENTRIES) {
    throw new Error(`Rotation ${kind} history is invalid`);
  }
  for (const entry of value) {
    if (kind === 'failure') {
      assertExactKeys(entry, ['at', 'phase', 'checkpoint', 'errorSha256'], [], 'Rotation failure record');
      canonicalInstant(entry.at, 'Rotation failure time');
      if (!RECEIPT_PHASES.has(entry.phase)) throw new Error('Rotation failure phase is invalid');
      if (!/^[a-z][a-z0-9-]{1,63}$/u.test(entry.checkpoint)) {
        throw new Error('Rotation failure checkpoint is invalid');
      }
      lowercaseSha256(entry.errorSha256, 'Rotation failure digest');
    } else {
      assertExactKeys(entry, ['at', 'fromPhase', 'toPhase', 'controlState', 'statusSha256'], [], 'Rotation reconciliation record');
      canonicalInstant(entry.at, 'Rotation reconciliation time');
      if (!RECEIPT_PHASES.has(entry.fromPhase) || !RECEIPT_PHASES.has(entry.toPhase)) {
        throw new Error('Rotation reconciliation phase is invalid');
      }
      if (!['old-active', 'blocked', 'new-active'].includes(entry.controlState)) {
        throw new Error('Rotation reconciliation control state is invalid');
      }
      const allowedTransition = {
        'old-active': 'executing->backup-complete',
        blocked: 'executing->blocked|activating->secret-replaced',
        'new-active': 'activating->activated',
      }[entry.controlState];
      if (!allowedTransition.split('|').includes(`${entry.fromPhase}->${entry.toPhase}`)) {
        throw new Error('Rotation reconciliation transition is invalid for its control state');
      }
      lowercaseSha256(entry.statusSha256, 'Rotation reconciliation status digest');
    }
  }
}

export function validateAuthRecoveryRotationReceipt(receipt, {
  now = new Date(),
  operator,
  caseReference,
  identities,
  confirmation,
  requireReviewAuthority = false,
} = {}) {
  assertExactKeys(receipt, [
    'format', 'receiptId', 'phase', 'createdAt', 'updatedAt', 'reviewExpiresAt',
    'reason', 'operatorSha256', 'caseReferenceSha256', 'identities', 'review',
    'confirmation',
  ], [
    'backup', 'execution', 'replacement', 'activation', 'failures',
    'reconciliations', 'completedAt', 'authorityStartedAt',
  ], 'Auth recovery rotation receipt');
  if (receipt.format !== AUTH_RECOVERY_ROTATION_RECEIPT_FORMAT) {
    throw new Error('Auth recovery rotation receipt format is invalid');
  }
  if (!RECEIPT_ID_PATTERN.test(receipt.receiptId)) throw new Error('Rotation receipt identity is invalid');
  if (!RECEIPT_PHASES.has(receipt.phase)) throw new Error('Rotation receipt phase is invalid');
  rotationReason(receipt.reason);
  const createdAtMs = canonicalInstant(receipt.createdAt, 'Rotation receipt createdAt');
  const updatedAtMs = canonicalInstant(receipt.updatedAt, 'Rotation receipt updatedAt');
  const reviewExpiresAtMs = canonicalInstant(receipt.reviewExpiresAt, 'Rotation receipt reviewExpiresAt');
  if (
    updatedAtMs < createdAtMs ||
    reviewExpiresAtMs !== createdAtMs + AUTH_RECOVERY_ROTATION_REVIEW_TTL_MS
  ) {
    throw new Error('Rotation receipt timestamps are inconsistent');
  }
  const authorityStartedAtMs = receipt.authorityStartedAt === undefined
    ? null
    : canonicalInstant(receipt.authorityStartedAt, 'Rotation authority start time');
  if (
    authorityStartedAtMs !== null &&
    (
      authorityStartedAtMs < createdAtMs ||
      authorityStartedAtMs >= reviewExpiresAtMs ||
      authorityStartedAtMs > updatedAtMs
    )
  ) {
    throw new Error('Rotation authority start time is outside the reviewed window');
  }
  lowercaseSha256(receipt.operatorSha256, 'Rotation operator hash');
  lowercaseSha256(receipt.caseReferenceSha256, 'Rotation case hash');
  const receiptIdentities = canonicalIdentityHashes(receipt.identities, 'Rotation receipt identities');
  assertExactKeys(receipt.review, [
    'counts', 'databaseIdentitySha256', 'deploymentProfile', 'jobExecutionConfirmation',
  ], [], 'Rotation review evidence');
  const counts = canonicalCounts(receipt.review.counts, 'Rotation review counts');
  lowercaseSha256(receipt.review.databaseIdentitySha256, 'Rotation review database hash');
  if (receipt.review.deploymentProfile !== 'personal-server') {
    throw new Error('Rotation receipt is not bound to the personal-server profile');
  }
  nonEmptyConfirmation(receipt.review.jobExecutionConfirmation, 'Rotation job execution confirmation');
  if (receipt.confirmation !== authRecoveryRotationComprehensiveConfirmation(receipt)) {
    throw new Error('Rotation receipt comprehensive confirmation is invalid');
  }

  if (receipt.backup !== undefined) validateBackup(receipt.backup);
  if (receipt.execution !== undefined) validateExecution(receipt.execution);
  if (receipt.replacement !== undefined) validateReplacement(receipt.replacement);
  if (receipt.activation !== undefined) validateActivation(receipt.activation);
  if (receipt.failures !== undefined) validateHistory(receipt.failures, 'failure');
  if (receipt.reconciliations !== undefined) validateHistory(receipt.reconciliations, 'reconciliation');
  if (receipt.completedAt !== undefined) canonicalInstant(receipt.completedAt, 'Rotation completion time');

  const phaseIndex = [...RECEIPT_PHASES].indexOf(receipt.phase);
  if (
    phaseIndex >= [...RECEIPT_PHASES].indexOf('backup-complete') &&
    authorityStartedAtMs === null
  ) {
    throw new Error(`Rotation receipt phase ${receipt.phase} requires confirmed authority-at-start evidence`);
  }
  const minimums = [
    ['backup', 'backup-complete'],
    ['execution', 'blocked'],
    ['replacement', 'secret-replaced'],
    ['activation', 'activated'],
    ['completedAt', 'completed'],
  ];
  for (const [field, minimumPhase] of minimums) {
    const minimumIndex = [...RECEIPT_PHASES].indexOf(minimumPhase);
    if (phaseIndex >= minimumIndex && receipt[field] === undefined) {
      throw new Error(`Rotation receipt phase ${receipt.phase} requires ${field} evidence`);
    }
    if (phaseIndex < minimumIndex && receipt[field] !== undefined) {
      throw new Error(`Rotation receipt phase ${receipt.phase} cannot contain ${field} evidence`);
    }
  }
  if (receipt.execution) {
    if (
      receipt.execution.rotatedGeneration !== counts.generation ||
      receipt.execution.blockedGeneration !== counts.generation + 1
    ) throw new Error('Rotation receipt execution does not bind the reviewed generation');
  }
  if (receipt.replacement) {
    if (
      receipt.replacement.beforeEnvironmentSha256 !== receiptIdentities.environmentSha256
    ) throw new Error('Rotation replacement is not bound to the reviewed environment');
  }
  if (receipt.activation) {
    if (
      receipt.activation.generation !== counts.generation + 1 ||
      receipt.activation.securityNoticesPreserved !== counts.securityNotices
    ) throw new Error('Rotation activation does not bind the reviewed blocked state');
  }

  if (operator !== undefined && sha256(canonicalOperator(operator)) !== receipt.operatorSha256) {
    throw new Error('Named operator does not match the protected rotation receipt');
  }
  if (
    caseReference !== undefined &&
    sha256(canonicalCaseReference(caseReference)) !== receipt.caseReferenceSha256
  ) throw new Error('Case reference does not match the protected rotation receipt');
  if (identities !== undefined) {
    const current = canonicalIdentityHashes(identities, 'Current rotation identities');
    const expectedEnvironmentSha256 = phaseIndex >= [...RECEIPT_PHASES].indexOf('secret-replaced')
      ? receipt.replacement.afterEnvironmentSha256
      : receiptIdentities.environmentSha256;
    if (
      !IDENTITY_HASH_NAMES.filter((name) => name !== 'environmentSha256')
        .every((name) => current[name] === receiptIdentities[name]) ||
      current.environmentSha256 !== expectedEnvironmentSha256
    ) throw new Error('Current source, installation, image or environment identity changed');
  }
  if (confirmation !== undefined && confirmation !== receipt.confirmation) {
    throw new Error('Rotation confirmation does not exactly match the comprehensive receipt confirmation');
  }

  const currentMs = canonicalInstant(nowInstant(now), 'Rotation validation time');
  const reviewExpired = currentMs >= reviewExpiresAtMs;
  if (requireReviewAuthority) {
    if (!['backup-complete', 'executing'].includes(receipt.phase)) {
      throw new Error('Rotation review authority is not at the executable checkpoint');
    }
    if (authorityStartedAtMs === null) {
      throw new Error('Rotation review authority was not captured before backup');
    }
    if (operator === undefined || caseReference === undefined || confirmation === undefined || identities === undefined) {
      throw new Error('Executable rotation review requires operator, case, identities and exact confirmation');
    }
  }
  return { receipt, reviewExpired };
}

export function recordAuthRecoveryRotationAuthorityStart(receipt, {
  operator,
  caseReference,
  identities,
  confirmation,
  now = new Date(),
}) {
  const validation = validateAuthRecoveryRotationReceipt(receipt, {
    now,
    operator,
    caseReference,
    identities,
    confirmation,
  });
  if (receipt.phase !== 'review-ready') {
    throw new Error('Rotation authority can start only from review-ready');
  }
  if (receipt.authorityStartedAt !== undefined) return receipt;
  if (validation.reviewExpired) {
    throw new Error('Rotation review authority expired before confirmed execution started');
  }
  const authorityStartedAt = nowInstant(now);
  const next = {
    ...receipt,
    authorityStartedAt,
    updatedAt: authorityStartedAt,
  };
  validateAuthRecoveryRotationReceipt(next, {
    now,
    operator,
    caseReference,
    identities,
    confirmation,
  });
  return next;
}

function transitionReceipt(receipt, expectedPhase, nextPhase, patch, now) {
  validateAuthRecoveryRotationReceipt(receipt);
  if (receipt.phase !== expectedPhase || TRANSITIONS.get(expectedPhase) !== nextPhase) {
    throw new Error(`Rotation receipt cannot transition ${receipt.phase} -> ${nextPhase}`);
  }
  const updatedAt = nowInstant(now);
  if (canonicalInstant(updatedAt, 'Rotation transition time') < Date.parse(receipt.updatedAt)) {
    throw new Error('Rotation transition time moved backwards');
  }
  const next = { ...receipt, ...patch, phase: nextPhase, updatedAt };
  validateAuthRecoveryRotationReceipt(next);
  return next;
}

export function recordAuthRecoveryRotationBackup(receipt, {
  referenceSha256,
  manifestSha256,
  now = new Date(),
}) {
  if (!receipt.authorityStartedAt) {
    throw new Error('Rotation backup requires confirmed authority-at-start evidence');
  }
  const completedAt = nowInstant(now);
  return transitionReceipt(receipt, 'review-ready', 'backup-complete', {
    backup: {
      completedAt,
      referenceSha256: lowercaseSha256(referenceSha256, 'Backup reference hash'),
      manifestSha256: lowercaseSha256(manifestSha256, 'Backup manifest hash'),
    },
  }, now);
}

export function markAuthRecoveryRotationExecuting(receipt, {
  operator,
  caseReference,
  identities,
  confirmation,
  now = new Date(),
}) {
  validateAuthRecoveryRotationReceipt(receipt, {
    now,
    operator,
    caseReference,
    identities,
    confirmation,
    requireReviewAuthority: true,
  });
  return transitionReceipt(receipt, 'backup-complete', 'executing', {}, now);
}

function assertExecutionMatchesReview(receipt, evidence) {
  const counts = receipt.review.counts;
  const pairs = [
    ['rotatedGeneration', 'generation'],
    ['invalidatedCapabilities', 'capabilities'],
    ['redactedRequestEvidenceRows', 'requestEvidenceRows'],
    ['clearedLegacySlots', 'legacySlots'],
    ['deletedRateBuckets', 'rateBuckets'],
    ['securityNotices', 'securityNotices'],
  ];
  for (const [evidenceName, countName] of pairs) {
    if (evidence[evidenceName] !== counts[countName]) {
      throw new Error(`EXECUTED evidence ${evidenceName} does not match the reviewed count`);
    }
  }
  if (
    evidence.blockedGeneration !== counts.generation + 1 ||
    evidence.securityNoticesPreserved !== counts.securityNotices ||
    evidence.reason !== receipt.reason ||
    evidence.caseReferenceSha256 !== receipt.caseReferenceSha256 ||
    evidence.databaseIdentitySha256 !== receipt.review.databaseIdentitySha256 ||
    evidence.deploymentProfile !== receipt.review.deploymentProfile ||
    evidence.executionConfirmation !== receipt.review.jobExecutionConfirmation
  ) throw new Error('EXECUTED evidence changed a reviewed rotation binding');
}

export function recordAuthRecoveryRotationBlocked(receipt, jobOutput, {
  now = new Date(),
} = {}) {
  validateAuthRecoveryRotationReceipt(receipt);
  if (receipt.phase !== 'executing') throw new Error('Rotation execution is not in progress');
  const evidence = typeof jobOutput === 'string'
    ? parseAuthRecoveryRotationJobEvidence(jobOutput, 'EXECUTED')
    : parseAuthRecoveryRotationJobEvidence(JSON.stringify(jobOutput), 'EXECUTED');
  assertExecutionMatchesReview(receipt, evidence);
  const completedAt = nowInstant(now);
  return transitionReceipt(receipt, 'executing', 'blocked', {
    execution: {
      completedAt,
      rotatedGeneration: evidence.rotatedGeneration,
      blockedGeneration: evidence.blockedGeneration,
      activationConfirmation: evidence.activationConfirmation,
      evidenceSha256: sha256(JSON.stringify(evidence)),
      source: 'job-output',
    },
  }, now);
}

function environmentSecretLine(content, label) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > ENVIRONMENT_LIMIT_BYTES) {
    throw new Error(`${label} is invalid or too large`);
  }
  const matches = [...content.matchAll(/^AUTH_RECOVERY_SECRET=([^\r\n]*)(?=\r?$)/gmu)];
  if (matches.length !== 1) throw new Error(`${label} must contain exactly one AUTH_RECOVERY_SECRET line`);
  const match = matches[0];
  const secret = match[1];
  let decoded;
  try {
    if (/^(?:[a-f0-9]{2})+$/u.test(secret)) {
      decoded = Buffer.from(secret, 'hex');
      if (decoded.toString('hex') !== secret) throw new Error();
    } else if (/^[A-Za-z0-9_-]+$/u.test(secret)) {
      decoded = Buffer.from(secret, 'base64url');
      if (decoded.toString('base64url') !== secret) throw new Error();
    } else {
      throw new Error();
    }
  } catch {
    throw new Error(`${label} AUTH_RECOVERY_SECRET must be canonical lowercase hex or unpadded base64url`);
  }
  if (decoded.length < 32 || decoded.length > 64) {
    throw new Error(`${label} AUTH_RECOVERY_SECRET must canonically encode 32 to 64 bytes`);
  }
  return {
    secret,
    start: match.index,
    end: match.index + match[0].length,
  };
}

export function validateAuthRecoverySecretEnvironmentReplacement({
  before,
  after,
  expectedBeforeEnvironmentSha256,
}) {
  const beforeLine = environmentSecretLine(before, 'Original protected environment');
  const afterLine = environmentSecretLine(after, 'Replacement protected environment');
  const beforeEnvironmentSha256 = authRecoveryRotationEnvironmentSha256(before);
  if (
    expectedBeforeEnvironmentSha256 !== undefined &&
    beforeEnvironmentSha256 !== lowercaseSha256(
      expectedBeforeEnvironmentSha256,
      'Expected original environment hash',
    )
  ) throw new Error('Original protected environment does not match the reviewed receipt');
  if (beforeLine.secret === afterLine.secret) throw new Error('Replacement auth recovery secret did not change');
  const expectedAfter = `${before.slice(0, beforeLine.start)}AUTH_RECOVERY_SECRET=${afterLine.secret}${before.slice(beforeLine.end)}`;
  if (after !== expectedAfter) {
    throw new Error('Protected environment replacement must change exactly the AUTH_RECOVERY_SECRET value');
  }
  const otherSecretValues = [...before.matchAll(/^(?:JWT_SECRET|READINESS_API_KEY|POSTGRES_PASSWORD)=([^\r\n]+)$/gmu)]
    .map((match) => match[1]);
  if (otherSecretValues.includes(afterLine.secret)) {
    throw new Error('Replacement auth recovery secret is not independent of another protected secret');
  }
  return {
    beforeEnvironmentSha256,
    afterEnvironmentSha256: authRecoveryRotationEnvironmentSha256(after),
    oldSecretSha256: sha256(beforeLine.secret),
    newSecretSha256: sha256(afterLine.secret),
    changedLineCount: 1,
  };
}

export function recordAuthRecoveryRotationSecretReplacement(receipt, {
  before,
  after,
  now = new Date(),
}) {
  validateAuthRecoveryRotationReceipt(receipt);
  const replacement = validateAuthRecoverySecretEnvironmentReplacement({
    before,
    after,
    expectedBeforeEnvironmentSha256: receipt.identities.environmentSha256,
  });
  return transitionReceipt(receipt, 'blocked', 'secret-replaced', {
    replacement: { completedAt: nowInstant(now), ...replacement },
  }, now);
}

export function markAuthRecoveryRotationActivating(receipt, {
  identities,
  now = new Date(),
}) {
  validateAuthRecoveryRotationReceipt(receipt, { identities, now });
  return transitionReceipt(receipt, 'secret-replaced', 'activating', {}, now);
}

function assertActivationMatchesReview(receipt, evidence) {
  if (
    evidence.generation !== receipt.review.counts.generation + 1 ||
    evidence.securityNoticesPreserved !== receipt.review.counts.securityNotices ||
    evidence.reason !== receipt.reason ||
    evidence.caseReferenceSha256 !== receipt.caseReferenceSha256 ||
    evidence.databaseIdentitySha256 !== receipt.review.databaseIdentitySha256 ||
    evidence.deploymentProfile !== receipt.review.deploymentProfile ||
    evidence.activationConfirmation !== receipt.execution.activationConfirmation
  ) throw new Error('ACTIVATED evidence changed a reviewed rotation binding');
}

export function recordAuthRecoveryRotationActivated(receipt, jobOutput, {
  now = new Date(),
} = {}) {
  validateAuthRecoveryRotationReceipt(receipt);
  if (receipt.phase !== 'activating') throw new Error('Rotation activation is not in progress');
  const evidence = typeof jobOutput === 'string'
    ? parseAuthRecoveryRotationJobEvidence(jobOutput, 'ACTIVATED')
    : parseAuthRecoveryRotationJobEvidence(JSON.stringify(jobOutput), 'ACTIVATED');
  assertActivationMatchesReview(receipt, evidence);
  const completedAt = nowInstant(now);
  return transitionReceipt(receipt, 'activating', 'activated', {
    activation: {
      completedAt,
      generation: evidence.generation,
      securityNoticesPreserved: evidence.securityNoticesPreserved,
      evidenceSha256: sha256(JSON.stringify(evidence)),
      source: 'job-output',
    },
  }, now);
}

export function completeAuthRecoveryRotation(receipt, {
  now = new Date(),
} = {}) {
  validateAuthRecoveryRotationReceipt(receipt);
  const completedAt = nowInstant(now);
  return transitionReceipt(receipt, 'activated', 'completed', { completedAt }, now);
}

export function recordAuthRecoveryRotationFailure(receipt, {
  checkpoint,
  error,
  now = new Date(),
}) {
  validateAuthRecoveryRotationReceipt(receipt);
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(String(checkpoint ?? ''))) {
    throw new Error('Rotation failure checkpoint is invalid');
  }
  const at = nowInstant(now);
  if (Date.parse(at) < Date.parse(receipt.updatedAt)) {
    throw new Error('Rotation failure time moved backwards');
  }
  const next = {
    ...receipt,
    updatedAt: at,
    failures: appendBounded(receipt.failures, {
      at,
      phase: receipt.phase,
      checkpoint,
      errorSha256: failureDigest(error),
    }),
  };
  validateAuthRecoveryRotationReceipt(next);
  return next;
}

function canonicalControlStatus(status) {
  assertExactKeys(status, [
    'controlState', ...REVIEW_COUNT_NAMES, 'databaseIdentitySha256', 'deploymentProfile',
  ], [], 'Auth recovery live control status');
  if (!['old-active', 'blocked', 'new-active'].includes(status.controlState)) {
    throw new Error('Auth recovery live control state is invalid');
  }
  const counts = canonicalCounts(
    Object.fromEntries(REVIEW_COUNT_NAMES.map((name) => [name, status[name]])),
    'Auth recovery live control counts',
  );
  lowercaseSha256(status.databaseIdentitySha256, 'Auth recovery live database hash');
  if (status.deploymentProfile !== 'personal-server') {
    throw new Error('Auth recovery live deployment profile is not personal-server');
  }
  return { ...status, ...counts };
}

export function authRecoveryRotationControlStatusFromJobEvidence(receipt, jobOutput) {
  validateAuthRecoveryRotationReceipt(receipt);
  const evidence = typeof jobOutput === 'string'
    ? parseAuthRecoveryRotationJobEvidence(jobOutput, 'CONTROL_STATUS')
    : parseAuthRecoveryRotationJobEvidence(JSON.stringify(jobOutput), 'CONTROL_STATUS');
  if (
    evidence.reason !== receipt.reason ||
    evidence.caseReferenceSha256 !== receipt.caseReferenceSha256 ||
    evidence.databaseIdentitySha256 !== receipt.review.databaseIdentitySha256 ||
    evidence.deploymentProfile !== receipt.review.deploymentProfile
  ) throw new Error('CONTROL_STATUS evidence changed a protected rotation binding');
  let controlState;
  if (evidence.blocked) {
    controlState = 'blocked';
  } else if (evidence.generation === receipt.review.counts.generation) {
    controlState = 'old-active';
  } else if (evidence.generation === receipt.review.counts.generation + 1) {
    controlState = 'new-active';
  } else {
    throw new Error('CONTROL_STATUS active generation is outside the protected rotation window');
  }
  return {
    controlState,
    ...Object.fromEntries(REVIEW_COUNT_NAMES.map((name) => [name, evidence[name]])),
    databaseIdentitySha256: evidence.databaseIdentitySha256,
    deploymentProfile: evidence.deploymentProfile,
  };
}

export function reconcileAuthRecoveryRotationStatus(receipt, status) {
  validateAuthRecoveryRotationReceipt(receipt);
  const live = canonicalControlStatus(status);
  const reviewed = receipt.review.counts;
  if (
    live.databaseIdentitySha256 !== receipt.review.databaseIdentitySha256 ||
    live.deploymentProfile !== receipt.review.deploymentProfile ||
    live.securityNotices !== reviewed.securityNotices
  ) throw new Error('Live auth recovery control does not match the reviewed database/profile/notices');

  if (live.controlState === 'old-active') {
    if (
      live.generation !== reviewed.generation ||
      REVIEW_COUNT_NAMES.some((name) => live[name] !== reviewed[name])
    ) throw new Error('Old-active recovery state changed after review');
    if (!['review-ready', 'backup-complete', 'executing'].includes(receipt.phase)) {
      throw new Error('Old-active recovery state would reverse a protected rotation checkpoint');
    }
    return {
      controlState: 'old-active',
      reconciledPhase: receipt.backup ? 'backup-complete' : 'review-ready',
      nextAction: receipt.backup ? 'execute-invalidation' : 'create-and-verify-backup',
      runtimeMayStart: false,
    };
  }

  const zeroPostconditions = MUTABLE_COUNT_NAMES.every((name) => live[name] === 0);
  if (live.generation !== reviewed.generation + 1 || !zeroPostconditions) {
    throw new Error('Blocked/new-active recovery state does not preserve the exact zero postconditions');
  }
  if (live.controlState === 'blocked') {
    if (!['executing', 'blocked', 'secret-replaced', 'activating'].includes(receipt.phase)) {
      throw new Error('Blocked recovery state conflicts with the protected rotation checkpoint');
    }
    return {
      controlState: 'blocked',
      reconciledPhase: receipt.replacement ? 'secret-replaced' : 'blocked',
      nextAction: receipt.replacement ? 'activate-replacement' : 'replace-secret',
      runtimeMayStart: false,
    };
  }
  if (!receipt.replacement || !['activating', 'activated', 'completed'].includes(receipt.phase)) {
    throw new Error('New-active recovery state lacks the protected replacement checkpoint');
  }
  return {
    controlState: 'new-active',
    reconciledPhase: receipt.phase === 'completed' ? 'completed' : 'activated',
    nextAction: receipt.phase === 'completed' ? 'none' : 'start-and-verify-runtime',
    runtimeMayStart: true,
  };
}

function activationJobConfirmation(receipt) {
  return [
    'ACTIVATE REPLACEMENT AUTH RECOVERY SECRET',
    `REASON ${receipt.reason}`,
    `GENERATION ${receipt.review.counts.generation + 1}`,
    `DATABASE SHA256 ${receipt.review.databaseIdentitySha256}`,
    `PROFILE ${receipt.review.deploymentProfile}`,
  ].join(' ');
}

export function reconcileAuthRecoveryRotationReceipt(receipt, status, {
  now = new Date(),
} = {}) {
  const reconciliation = reconcileAuthRecoveryRotationStatus(receipt, status);
  if (reconciliation.reconciledPhase === receipt.phase) return receipt;
  const at = nowInstant(now);
  if (Date.parse(at) < Date.parse(receipt.updatedAt)) {
    throw new Error('Rotation reconciliation time moved backwards');
  }
  const live = canonicalControlStatus(status);
  const next = {
    ...receipt,
    phase: reconciliation.reconciledPhase,
    updatedAt: at,
    reconciliations: appendBounded(receipt.reconciliations, {
      at,
      fromPhase: receipt.phase,
      toPhase: reconciliation.reconciledPhase,
      controlState: reconciliation.controlState,
      statusSha256: sha256(JSON.stringify(live)),
    }),
  };
  if (reconciliation.controlState === 'blocked' && !next.execution) {
    next.execution = {
      completedAt: at,
      rotatedGeneration: receipt.review.counts.generation,
      blockedGeneration: receipt.review.counts.generation + 1,
      activationConfirmation: activationJobConfirmation(receipt),
      evidenceSha256: sha256(JSON.stringify(live)),
      source: 'live-reconciliation',
    };
  }
  if (reconciliation.controlState === 'new-active' && !next.activation) {
    next.activation = {
      completedAt: at,
      generation: receipt.review.counts.generation + 1,
      securityNoticesPreserved: receipt.review.counts.securityNotices,
      evidenceSha256: sha256(JSON.stringify(live)),
      source: 'live-reconciliation',
    };
  }
  validateAuthRecoveryRotationReceipt(next);
  return next;
}

export function planAuthRecoveryRotationResume(receipt, {
  status,
  identities,
  now = new Date(),
}) {
  const { reviewExpired } = validateAuthRecoveryRotationReceipt(receipt, { now });
  const reconciliation = reconcileAuthRecoveryRotationStatus(receipt, status);
  const current = canonicalIdentityHashes(identities, 'Current rotation identities');
  const stableIdentityNames = IDENTITY_HASH_NAMES.filter((name) => name !== 'environmentSha256');
  if (!stableIdentityNames.every((name) => current[name] === receipt.identities[name])) {
    throw new Error('Rotation resume source, installation or image identity changed');
  }
  if (reconciliation.controlState === 'old-active') {
    if (current.environmentSha256 !== receipt.identities.environmentSha256) {
      throw new Error('Old-active recovery state is not using the reviewed secret environment');
    }
    return {
      ...reconciliation,
      nextAction: reviewExpired ? 'repeat-count-only-review' : reconciliation.nextAction,
      reviewExpired,
    };
  }
  if (reconciliation.controlState === 'blocked') {
    const environmentIsOld = current.environmentSha256 === receipt.identities.environmentSha256;
    const environmentIsNew = receipt.replacement &&
      current.environmentSha256 === receipt.replacement.afterEnvironmentSha256;
    if (!environmentIsOld && !environmentIsNew) {
      throw new Error('Blocked recovery state has an unrecorded protected environment identity');
    }
    return {
      ...reconciliation,
      nextAction: environmentIsNew ? 'activate-replacement' : 'replace-secret',
      reviewExpired,
    };
  }
  if (current.environmentSha256 !== receipt.replacement.afterEnvironmentSha256) {
    throw new Error('New-active recovery state is not using the recorded replacement environment');
  }
  return { ...reconciliation, reviewExpired };
}

export function createRedactedAuthRecoveryRotationArchive(receipt, {
  archivedAt = new Date(),
  outcome = receipt?.phase === 'completed' ? 'completed' : 'incomplete',
  postActivationRecovery = null,
} = {}) {
  validateAuthRecoveryRotationReceipt(receipt);
  if (!['completed', 'incomplete', 'superseded'].includes(outcome)) {
    throw new Error('Rotation archive outcome is invalid');
  }
  let archivedPostActivationRecovery = null;
  if (postActivationRecovery !== null) {
    assertExactKeys(
      postActivationRecovery,
      ['recoverySetId', 'manifestSha256', 'rehearsedAt'],
      [],
      'Post-activation recovery archive evidence',
    );
    if (!/^personal-server-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/u.test(postActivationRecovery.recoverySetId)) {
      throw new Error('Post-activation recovery-set identity is invalid');
    }
    archivedPostActivationRecovery = {
      recoverySetId: postActivationRecovery.recoverySetId,
      manifestSha256: lowercaseSha256(
        postActivationRecovery.manifestSha256,
        'Post-activation recovery manifest hash',
      ),
      rehearsedAt: new Date(
        canonicalInstant(postActivationRecovery.rehearsedAt, 'Post-activation recovery rehearsal time'),
      ).toISOString(),
    };
  }
  return {
    format: AUTH_RECOVERY_ROTATION_ARCHIVE_FORMAT,
    receiptId: receipt.receiptId,
    outcome,
    phase: receipt.phase,
    archivedAt: nowInstant(archivedAt),
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    completedAt: receipt.completedAt ?? null,
    authorityStartedAt: receipt.authorityStartedAt ?? null,
    reviewExpiresAt: receipt.reviewExpiresAt,
    reason: receipt.reason,
    operatorSha256: receipt.operatorSha256,
    caseReferenceSha256: receipt.caseReferenceSha256,
    identities: { ...receipt.identities },
    reviewedCounts: { ...receipt.review.counts },
    databaseIdentitySha256: receipt.review.databaseIdentitySha256,
    deploymentProfile: receipt.review.deploymentProfile,
    confirmationSha256: sha256(receipt.confirmation),
    backup: receipt.backup ? { ...receipt.backup } : null,
    execution: receipt.execution ? { ...receipt.execution } : null,
    replacement: receipt.replacement ? { ...receipt.replacement } : null,
    activation: receipt.activation ? { ...receipt.activation } : null,
    postActivationRecovery: archivedPostActivationRecovery,
    failures: receipt.failures ? receipt.failures.map((entry) => ({ ...entry })) : [],
    reconciliations: receipt.reconciliations
      ? receipt.reconciliations.map((entry) => ({ ...entry }))
      : [],
  };
}
