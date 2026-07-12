import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  AUTH_RECOVERY_ROTATION_ARCHIVE_FORMAT,
  AUTH_RECOVERY_ROTATION_RECEIPT_FORMAT,
  AUTH_RECOVERY_ROTATION_REVIEW_TTL_MS,
  authRecoveryRotationComprehensiveConfirmation,
  authRecoveryRotationControlStatusFromJobEvidence,
  authRecoveryRotationEnvironmentSha256,
  authRecoveryRotationIdentitySha256,
  completeAuthRecoveryRotation,
  createAuthRecoveryRotationIdentityHashes,
  createAuthRecoveryRotationReviewReceipt,
  createRedactedAuthRecoveryRotationArchive,
  markAuthRecoveryRotationActivating,
  markAuthRecoveryRotationExecuting,
  parseAuthRecoveryRotationJobEvidence,
  planAuthRecoveryRotationResume,
  reconcileAuthRecoveryRotationReceipt,
  reconcileAuthRecoveryRotationStatus,
  recordAuthRecoveryRotationActivated,
  recordAuthRecoveryRotationAuthorityStart,
  recordAuthRecoveryRotationBackup,
  recordAuthRecoveryRotationBlocked,
  recordAuthRecoveryRotationFailure,
  recordAuthRecoveryRotationSecretReplacement,
  validateAuthRecoveryRotationReceipt,
  validateAuthRecoverySecretEnvironmentReplacement,
} from './personal-server-auth-recovery-rotation.mjs';

const operator = 'Named Charity Director';
const caseReference = 'INC-2026-0042';
const reason = 'SUSPECTED_KEY_COMPROMISE';
const receiptId = '1234567890abcdef12345678';
const createdAt = new Date('2026-07-12T10:00:00.000Z');
const hashes = {
  database: 'a'.repeat(64),
  backupReference: 'b'.repeat(64),
  backupManifest: 'c'.repeat(64),
};
const oldSecret = '3'.repeat(96);
const newSecret = '5'.repeat(96);
const baseEnvironment = [
  `POSTGRES_PASSWORD=${'1'.repeat(96)}`,
  `JWT_SECRET=${'2'.repeat(96)}`,
  `AUTH_RECOVERY_SECRET=${oldSecret}`,
  `READINESS_API_KEY=${'4'.repeat(96)}`,
  'ORIGIN=http://localhost:18080',
  '',
].join('\r\n');
const replacementEnvironment = baseEnvironment.replace(oldSecret, newSecret);
const counts = {
  generation: 7,
  capabilities: 3,
  requestEvidenceRows: 4,
  legacySlots: 1,
  rateBuckets: 2,
  securityNotices: 5,
};

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jobExecutionConfirmation() {
  return [
    'ROTATE AUTH RECOVERY SECRET',
    `REASON ${reason}`,
    `GENERATION ${counts.generation}`,
    `TERMINATE ${counts.capabilities} CAPABILITIES`,
    `REDACT ${counts.requestEvidenceRows} REQUEST EVIDENCE ROWS`,
    `CLEAR ${counts.legacySlots} LEGACY SLOTS`,
    `DELETE ${counts.rateBuckets} RATE BUCKETS`,
    `PRESERVE ${counts.securityNotices} SECURITY NOTICES`,
    `DATABASE SHA256 ${hashes.database}`,
    'PROFILE personal-server',
  ].join(' ');
}

function jobActivationConfirmation() {
  return [
    'ACTIVATE REPLACEMENT AUTH RECOVERY SECRET',
    `REASON ${reason}`,
    `GENERATION ${counts.generation + 1}`,
    `DATABASE SHA256 ${hashes.database}`,
    'PROFILE personal-server',
  ].join(' ');
}

function dryRunEvidence(overrides = {}) {
  return {
    mode: 'DRY_RUN',
    mutationApplied: false,
    ...counts,
    reason,
    terminationReason: 'KEY_ROTATED',
    securityNoticesPreserved: counts.securityNotices,
    caseReferenceSha256: digest(caseReference),
    databaseIdentitySha256: hashes.database,
    deploymentProfile: 'personal-server',
    executionConfirmation: jobExecutionConfirmation(),
    credentialsIssued: false,
    ...overrides,
  };
}

function executedEvidence(overrides = {}) {
  return {
    mode: 'EXECUTED',
    mutationApplied: true,
    recoveryBlocked: true,
    rotatedGeneration: counts.generation,
    blockedGeneration: counts.generation + 1,
    activationConfirmation: jobActivationConfirmation(),
    invalidatedCapabilities: counts.capabilities,
    redactedRequestEvidenceRows: counts.requestEvidenceRows,
    clearedLegacySlots: counts.legacySlots,
    deletedRateBuckets: counts.rateBuckets,
    securityNotices: counts.securityNotices,
    remainingCapabilities: 0,
    remainingRequestEvidenceRows: 0,
    remainingLegacySlots: 0,
    remainingRateBuckets: 0,
    reason,
    terminationReason: 'KEY_ROTATED',
    securityNoticesPreserved: counts.securityNotices,
    caseReferenceSha256: digest(caseReference),
    databaseIdentitySha256: hashes.database,
    deploymentProfile: 'personal-server',
    executionConfirmation: jobExecutionConfirmation(),
    credentialsIssued: false,
    ...overrides,
  };
}

function activatedEvidence(overrides = {}) {
  return {
    mode: 'ACTIVATED',
    mutationApplied: true,
    generation: counts.generation + 1,
    recoveryBlocked: false,
    remainingCapabilities: 0,
    remainingRequestEvidenceRows: 0,
    remainingLegacySlots: 0,
    remainingRateBuckets: 0,
    securityNoticesPreserved: counts.securityNotices,
    reason,
    caseReferenceSha256: digest(caseReference),
    databaseIdentitySha256: hashes.database,
    deploymentProfile: 'personal-server',
    activationConfirmation: jobActivationConfirmation(),
    credentialsIssued: false,
    ...overrides,
  };
}

function controlStatusEvidence(overrides = {}) {
  return {
    mode: 'CONTROL_STATUS',
    mutationApplied: false,
    blocked: false,
    generation: counts.generation,
    currentSecretActive: true,
    capabilities: counts.capabilities,
    requestEvidenceRows: counts.requestEvidenceRows,
    legacySlots: counts.legacySlots,
    rateBuckets: counts.rateBuckets,
    securityNotices: counts.securityNotices,
    reason,
    caseReferenceSha256: digest(caseReference),
    databaseIdentitySha256: hashes.database,
    deploymentProfile: 'personal-server',
    credentialsIssued: false,
    ...overrides,
  };
}

function identities(environmentContent = baseEnvironment) {
  return createAuthRecoveryRotationIdentityHashes({
    source: { commitSha: 'd'.repeat(40), remote: 'canonical', clean: true },
    installation: { stateRootId: 'installation-01', origin: 'http://localhost:18080' },
    images: {
      api: `sha256:${'e'.repeat(64)}`,
      web: `sha256:${'f'.repeat(64)}`,
    },
    environmentContent,
  });
}

function reviewReceipt() {
  return createAuthRecoveryRotationReviewReceipt({
    receiptId,
    reason,
    operator,
    caseReference,
    identities: identities(),
    dryRunEvidence: JSON.stringify(dryRunEvidence()),
    now: createdAt,
  });
}

function backedUpReceipt() {
  const review = reviewReceipt();
  const started = recordAuthRecoveryRotationAuthorityStart(review, {
    operator,
    caseReference,
    identities: identities(),
    confirmation: review.confirmation,
    now: new Date('2026-07-12T10:01:00.000Z'),
  });
  return recordAuthRecoveryRotationBackup(started, {
    referenceSha256: hashes.backupReference,
    manifestSha256: hashes.backupManifest,
    now: new Date('2026-07-12T10:02:00.000Z'),
  });
}

function executingReceipt() {
  const receipt = backedUpReceipt();
  return markAuthRecoveryRotationExecuting(receipt, {
    operator,
    caseReference,
    identities: identities(),
    confirmation: receipt.confirmation,
    now: new Date('2026-07-12T10:03:00.000Z'),
  });
}

function blockedReceipt() {
  return recordAuthRecoveryRotationBlocked(executingReceipt(), JSON.stringify(executedEvidence()), {
    now: new Date('2026-07-12T10:04:00.000Z'),
  });
}

function replacedReceipt() {
  return recordAuthRecoveryRotationSecretReplacement(blockedReceipt(), {
    before: baseEnvironment,
    after: replacementEnvironment,
    now: new Date('2026-07-12T10:05:00.000Z'),
  });
}

function activatingReceipt() {
  return markAuthRecoveryRotationActivating(replacedReceipt(), {
    identities: identities(replacementEnvironment),
    now: new Date('2026-07-12T10:06:00.000Z'),
  });
}

function oldActiveStatus(overrides = {}) {
  return {
    controlState: 'old-active',
    ...counts,
    databaseIdentitySha256: hashes.database,
    deploymentProfile: 'personal-server',
    ...overrides,
  };
}

function blockedStatus(overrides = {}) {
  return {
    controlState: 'blocked',
    generation: counts.generation + 1,
    capabilities: 0,
    requestEvidenceRows: 0,
    legacySlots: 0,
    rateBuckets: 0,
    securityNotices: counts.securityNotices,
    databaseIdentitySha256: hashes.database,
    deploymentProfile: 'personal-server',
    ...overrides,
  };
}

function newActiveStatus(overrides = {}) {
  return { ...blockedStatus(), controlState: 'new-active', ...overrides };
}

test('identity hashing is canonical, domain-separated and binds exact environment bytes', () => {
  assert.equal(
    authRecoveryRotationIdentitySha256('source', { b: 2, a: 1 }),
    authRecoveryRotationIdentitySha256('source', { a: 1, b: 2 }),
  );
  assert.notEqual(
    authRecoveryRotationIdentitySha256('source', { a: 1 }),
    authRecoveryRotationIdentitySha256('images', { a: 1 }),
  );
  assert.notEqual(
    authRecoveryRotationEnvironmentSha256(baseEnvironment),
    authRecoveryRotationEnvironmentSha256(baseEnvironment.replace('\r\n', '\n')),
  );
  assert.throws(() => authRecoveryRotationIdentitySha256('source', { bad: undefined }), /non-canonical/u);
  assert.throws(() => authRecoveryRotationIdentitySha256('../source', {}), /kind is invalid/u);
});

test('count-only job parser accepts all four exact modes', () => {
  assert.deepEqual(
    parseAuthRecoveryRotationJobEvidence(JSON.stringify(dryRunEvidence()), 'DRY_RUN'),
    dryRunEvidence(),
  );
  assert.deepEqual(
    parseAuthRecoveryRotationJobEvidence(JSON.stringify(executedEvidence()), 'EXECUTED'),
    executedEvidence(),
  );
  assert.deepEqual(
    parseAuthRecoveryRotationJobEvidence(JSON.stringify(activatedEvidence()), 'ACTIVATED'),
    activatedEvidence(),
  );
  assert.deepEqual(
    parseAuthRecoveryRotationJobEvidence(
      JSON.stringify(controlStatusEvidence()),
      'CONTROL_STATUS',
    ),
    controlStatusEvidence(),
  );
});

test('count-only parser rejects logs, unknown/sensitive fields and unsafe postconditions', () => {
  assert.throws(
    () => parseAuthRecoveryRotationJobEvidence(`job log\n${JSON.stringify(dryRunEvidence())}`),
    /one JSON object/u,
  );
  assert.throws(
    () => parseAuthRecoveryRotationJobEvidence(JSON.stringify({
      ...dryRunEvidence(),
      authRecoverySecret: oldSecret,
    })),
    /unknown authRecoverySecret/u,
  );
  assert.throws(
    () => parseAuthRecoveryRotationJobEvidence(JSON.stringify(executedEvidence({
      remainingCapabilities: 1,
    }))),
    /remainingCapabilities must be zero/u,
  );
  assert.throws(
    () => parseAuthRecoveryRotationJobEvidence(JSON.stringify(activatedEvidence({
      deploymentProfile: 'production',
    }))),
    /personal-server/u,
  );
  assert.throws(
    () => parseAuthRecoveryRotationJobEvidence(JSON.stringify(dryRunEvidence()), 'EXECUTED'),
    /Expected EXECUTED/u,
  );
  assert.throws(
    () => parseAuthRecoveryRotationJobEvidence(JSON.stringify(controlStatusEvidence({
      currentSecretActive: false,
    }))),
    /exactly one/u,
  );
});

test('receipt-bound CONTROL_STATUS adapter classifies old, blocked and new active states', () => {
  const receipt = reviewReceipt();
  assert.deepEqual(
    authRecoveryRotationControlStatusFromJobEvidence(receipt, controlStatusEvidence()),
    oldActiveStatus(),
  );
  const blockedOutput = controlStatusEvidence({
    blocked: true,
    currentSecretActive: false,
    generation: counts.generation + 1,
    capabilities: 0,
    requestEvidenceRows: 0,
    legacySlots: 0,
    rateBuckets: 0,
  });
  assert.deepEqual(
    authRecoveryRotationControlStatusFromJobEvidence(receipt, JSON.stringify(blockedOutput)),
    blockedStatus(),
  );
  assert.deepEqual(
    authRecoveryRotationControlStatusFromJobEvidence(receipt, {
      ...blockedOutput,
      blocked: false,
      currentSecretActive: true,
    }),
    newActiveStatus(),
  );
  assert.throws(
    () => authRecoveryRotationControlStatusFromJobEvidence(receipt, controlStatusEvidence({
      databaseIdentitySha256: '9'.repeat(64),
    })),
    /changed a protected rotation binding/u,
  );
  assert.throws(
    () => authRecoveryRotationControlStatusFromJobEvidence(receipt, controlStatusEvidence({
      generation: counts.generation + 5,
    })),
    /outside the protected rotation window/u,
  );
});

test('review receipt binds every authority field and stores no raw operator, case or secret', () => {
  const receipt = reviewReceipt();
  assert.equal(receipt.format, AUTH_RECOVERY_ROTATION_RECEIPT_FORMAT);
  assert.equal(receipt.phase, 'review-ready');
  assert.equal(
    Date.parse(receipt.reviewExpiresAt) - Date.parse(receipt.createdAt),
    AUTH_RECOVERY_ROTATION_REVIEW_TTL_MS,
  );
  for (const fragment of [
    receiptId,
    receipt.reviewExpiresAt,
    reason,
    receipt.operatorSha256,
    receipt.caseReferenceSha256,
    String(counts.generation),
    String(counts.capabilities),
    String(counts.requestEvidenceRows),
    String(counts.legacySlots),
    String(counts.rateBuckets),
    String(counts.securityNotices),
    hashes.database,
    ...Object.values(receipt.identities),
  ]) assert.match(receipt.confirmation, new RegExp(fragment));
  assert.equal(receipt.confirmation, authRecoveryRotationComprehensiveConfirmation(receipt));
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, new RegExp(operator));
  assert.doesNotMatch(serialized, new RegExp(caseReference));
  assert.doesNotMatch(serialized, new RegExp(oldSecret));
  assert.doesNotMatch(serialized, /POSTGRES_PASSWORD/u);

  const tampered = structuredClone(receipt);
  tampered.review.counts.rateBuckets += 1;
  assert.throws(() => validateAuthRecoveryRotationReceipt(tampered), /confirmation is invalid/u);
});

test('review authority requires exact live identities, operator, case and comprehensive confirmation', () => {
  const receipt = backedUpReceipt();
  const authority = {
    now: new Date('2026-07-12T10:29:59.999Z'),
    operator,
    caseReference,
    identities: identities(),
    confirmation: receipt.confirmation,
    requireReviewAuthority: true,
  };
  assert.equal(validateAuthRecoveryRotationReceipt(receipt, authority).reviewExpired, false);
  assert.throws(
    () => validateAuthRecoveryRotationReceipt(receipt, { ...authority, operator: 'Different Director' }),
    /operator does not match/u,
  );
  assert.throws(
    () => validateAuthRecoveryRotationReceipt(receipt, {
      ...authority,
      identities: { ...identities(), imagesSha256: '9'.repeat(64) },
    }),
    /identity changed/u,
  );
  assert.throws(
    () => validateAuthRecoveryRotationReceipt(receipt, {
      ...authority,
      confirmation: `${receipt.confirmation} `,
    }),
    /does not exactly match/u,
  );
  assert.equal(
    validateAuthRecoveryRotationReceipt(receipt, {
      ...authority,
      now: new Date('2026-07-12T12:00:00.000Z'),
    }).reviewExpired,
    true,
  );
  assert.equal(
    validateAuthRecoveryRotationReceipt(receipt, {
      now: new Date('2026-07-12T12:00:00.000Z'),
    }).reviewExpired,
    true,
  );
});

test('authority captured before expiry remains executable after a long verified backup', () => {
  const review = reviewReceipt();
  const started = recordAuthRecoveryRotationAuthorityStart(review, {
    operator,
    caseReference,
    identities: identities(),
    confirmation: review.confirmation,
    now: new Date('2026-07-12T10:29:59.000Z'),
  });
  const backedUp = recordAuthRecoveryRotationBackup(started, {
    referenceSha256: hashes.backupReference,
    manifestSha256: hashes.backupManifest,
    now: new Date('2026-07-12T11:15:00.000Z'),
  });
  const executing = markAuthRecoveryRotationExecuting(backedUp, {
    operator,
    caseReference,
    identities: identities(),
    confirmation: review.confirmation,
    now: new Date('2026-07-12T11:16:00.000Z'),
  });
  assert.equal(executing.phase, 'executing');
  assert.equal(executing.authorityStartedAt, '2026-07-12T10:29:59.000Z');
});

test('exact environment replacement changes one canonical line and returns hashes only', () => {
  const proof = validateAuthRecoverySecretEnvironmentReplacement({
    before: baseEnvironment,
    after: replacementEnvironment,
    expectedBeforeEnvironmentSha256: identities().environmentSha256,
  });
  assert.equal(proof.changedLineCount, 1);
  assert.equal(proof.beforeEnvironmentSha256, identities().environmentSha256);
  assert.equal(proof.afterEnvironmentSha256, identities(replacementEnvironment).environmentSha256);
  assert.equal(proof.oldSecretSha256, digest(oldSecret));
  assert.equal(proof.newSecretSha256, digest(newSecret));
  assert.doesNotMatch(JSON.stringify(proof), new RegExp(oldSecret));
  assert.doesNotMatch(JSON.stringify(proof), new RegExp(newSecret));

  const oldBase64url = Buffer.alloc(48, 0x31).toString('base64url');
  const newBase64url = Buffer.alloc(48, 0x32).toString('base64url');
  const base64Environment = baseEnvironment.replace(oldSecret, oldBase64url);
  assert.equal(
    validateAuthRecoverySecretEnvironmentReplacement({
      before: base64Environment,
      after: base64Environment.replace(oldBase64url, newBase64url),
    }).changedLineCount,
    1,
  );
});

test('environment replacement rejects every non-exact or non-independent edit', () => {
  assert.throws(
    () => validateAuthRecoverySecretEnvironmentReplacement({
      before: baseEnvironment,
      after: replacementEnvironment.replace('localhost', '127.0.0.1'),
    }),
    /change exactly/u,
  );
  assert.throws(
    () => validateAuthRecoverySecretEnvironmentReplacement({
      before: baseEnvironment,
      after: baseEnvironment,
    }),
    /did not change/u,
  );
  assert.throws(
    () => validateAuthRecoverySecretEnvironmentReplacement({
      before: baseEnvironment,
      after: replacementEnvironment.replace(newSecret, newSecret.toUpperCase().replace(/5/g, 'A')),
    }),
    /canonical lowercase hex or unpadded base64url|canonically encode 32 to 64 bytes/u,
  );
  assert.throws(
    () => validateAuthRecoverySecretEnvironmentReplacement({
      before: `${baseEnvironment}AUTH_RECOVERY_SECRET=${'6'.repeat(96)}\r\n`,
      after: replacementEnvironment,
    }),
    /exactly one/u,
  );
  assert.throws(
    () => validateAuthRecoverySecretEnvironmentReplacement({
      before: baseEnvironment,
      after: baseEnvironment.replace(oldSecret, '2'.repeat(96)),
    }),
    /not independent/u,
  );
});

test('full pure checkpoint sequence reaches a redacted completed archive', () => {
  const activated = recordAuthRecoveryRotationActivated(
    activatingReceipt(),
    JSON.stringify(activatedEvidence()),
    { now: new Date('2026-07-12T10:07:00.000Z') },
  );
  const completed = completeAuthRecoveryRotation(activated, {
    now: new Date('2026-07-12T10:09:00.000Z'),
  });
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.execution.blockedGeneration, 8);
  assert.equal(completed.activation.generation, 8);
  assert.equal(completed.replacement.changedLineCount, 1);
  const archive = createRedactedAuthRecoveryRotationArchive(completed, {
    archivedAt: new Date('2026-07-12T10:10:00.000Z'),
    postActivationRecovery: {
      recoverySetId: 'personal-server-2026-07-12T10-08-00-000Z-1234abcd',
      manifestSha256: 'd'.repeat(64),
      rehearsedAt: '2026-07-12T10:08:30.000Z',
    },
  });
  assert.equal(archive.format, AUTH_RECOVERY_ROTATION_ARCHIVE_FORMAT);
  assert.equal(archive.outcome, 'completed');
  assert.deepEqual(archive.postActivationRecovery, {
    recoverySetId: 'personal-server-2026-07-12T10-08-00-000Z-1234abcd',
    manifestSha256: 'd'.repeat(64),
    rehearsedAt: '2026-07-12T10:08:30.000Z',
  });
  const serialized = JSON.stringify(archive);
  for (const sensitive of [operator, caseReference, oldSecret, newSecret, 'POSTGRES_PASSWORD']) {
    assert.doesNotMatch(serialized, new RegExp(sensitive));
  }
});

test('execution and activation checkpoints reject changed reviewed evidence', () => {
  assert.throws(
    () => recordAuthRecoveryRotationBlocked(
      executingReceipt(),
      JSON.stringify(executedEvidence({ invalidatedCapabilities: counts.capabilities + 1 })),
    ),
    /does not match the reviewed count/u,
  );
  assert.throws(
    () => recordAuthRecoveryRotationActivated(
      activatingReceipt(),
      JSON.stringify(activatedEvidence({ generation: counts.generation + 2 })),
    ),
    /changed a reviewed rotation binding/u,
  );
});

test('failure metadata preserves the checkpoint and stores only a digest', () => {
  const errorText = 'database URL postgresql://secret@private.example failed with token 123';
  const failed = recordAuthRecoveryRotationFailure(executingReceipt(), {
    checkpoint: 'execute-invalidation',
    error: new Error(errorText),
    now: new Date('2026-07-12T10:04:00.000Z'),
  });
  assert.equal(failed.phase, 'executing');
  assert.equal(failed.failures[0].checkpoint, 'execute-invalidation');
  assert.match(failed.failures[0].errorSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(failed), /private\.example|token 123/u);

  let bounded = failed;
  for (let index = 0; index < 20; index += 1) {
    bounded = recordAuthRecoveryRotationFailure(bounded, {
      checkpoint: 'execute-invalidation',
      error: `failure ${index}`,
      now: new Date(`2026-07-12T10:${String(5 + index).padStart(2, '0')}:00.000Z`),
    });
  }
  assert.equal(bounded.failures.length, 16);
});

test('old-active reconciliation safely rolls an ambiguous execute checkpoint back to the backup', () => {
  const receipt = executingReceipt();
  const status = oldActiveStatus();
  assert.deepEqual(reconcileAuthRecoveryRotationStatus(receipt, status), {
    controlState: 'old-active',
    reconciledPhase: 'backup-complete',
    nextAction: 'execute-invalidation',
    runtimeMayStart: false,
  });
  const reconciled = reconcileAuthRecoveryRotationReceipt(receipt, status, {
    now: new Date('2026-07-12T10:04:00.000Z'),
  });
  assert.equal(reconciled.phase, 'backup-complete');
  assert.equal(reconciled.reconciliations[0].controlState, 'old-active');
  assert.equal(planAuthRecoveryRotationResume(reconciled, {
    status,
    identities: identities(),
    now: new Date('2026-07-12T10:05:00.000Z'),
  }).nextAction, 'execute-invalidation');
  assert.equal(planAuthRecoveryRotationResume(reconciled, {
    status,
    identities: identities(),
    now: new Date('2026-07-12T11:00:00.000Z'),
  }).nextAction, 'repeat-count-only-review');
});

test('blocked reconciliation reconstructs lost count-only execution checkpoint and forbids runtime', () => {
  const reconciled = reconcileAuthRecoveryRotationReceipt(executingReceipt(), blockedStatus(), {
    now: new Date('2026-07-12T10:04:30.000Z'),
  });
  assert.equal(reconciled.phase, 'blocked');
  assert.equal(reconciled.execution.source, 'live-reconciliation');
  assert.equal(reconciled.execution.activationConfirmation, jobActivationConfirmation());
  const plan = planAuthRecoveryRotationResume(reconciled, {
    status: blockedStatus(),
    identities: identities(),
    now: new Date('2026-07-12T11:00:00.000Z'),
  });
  assert.equal(plan.nextAction, 'replace-secret');
  assert.equal(plan.runtimeMayStart, false);
  assert.equal(plan.reviewExpired, true);
});

test('blocked reconciliation after an ambiguous activation returns to secret-replaced', () => {
  const receipt = activatingReceipt();
  const reconciled = reconcileAuthRecoveryRotationReceipt(receipt, blockedStatus(), {
    now: new Date('2026-07-12T10:07:00.000Z'),
  });
  assert.equal(reconciled.phase, 'secret-replaced');
  assert.equal(planAuthRecoveryRotationResume(reconciled, {
    status: blockedStatus(),
    identities: identities(replacementEnvironment),
    now: new Date('2026-07-12T10:08:00.000Z'),
  }).nextAction, 'activate-replacement');
});

test('new-active reconciliation reconstructs lost activation checkpoint', () => {
  const receipt = activatingReceipt();
  const reconciled = reconcileAuthRecoveryRotationReceipt(receipt, newActiveStatus(), {
    now: new Date('2026-07-12T10:07:00.000Z'),
  });
  assert.equal(reconciled.phase, 'activated');
  assert.equal(reconciled.activation.source, 'live-reconciliation');
  const plan = planAuthRecoveryRotationResume(reconciled, {
    status: newActiveStatus(),
    identities: identities(replacementEnvironment),
    now: new Date('2026-07-12T10:08:00.000Z'),
  });
  assert.equal(plan.nextAction, 'start-and-verify-runtime');
  assert.equal(plan.runtimeMayStart, true);
});

test('status reconciliation rejects changed database, notices, counts and phase reversal', () => {
  assert.throws(
    () => reconcileAuthRecoveryRotationStatus(executingReceipt(), blockedStatus({
      databaseIdentitySha256: '9'.repeat(64),
    })),
    /database\/profile\/notices/u,
  );
  assert.throws(
    () => reconcileAuthRecoveryRotationStatus(executingReceipt(), blockedStatus({
      requestEvidenceRows: 1,
    })),
    /zero postconditions/u,
  );
  assert.throws(
    () => reconcileAuthRecoveryRotationStatus(blockedReceipt(), oldActiveStatus()),
    /reverse/u,
  );
  assert.throws(
    () => reconcileAuthRecoveryRotationStatus(activatingReceipt(), newActiveStatus({
      securityNotices: counts.securityNotices + 1,
    })),
    /database\/profile\/notices/u,
  );
});

test('phase transitions cannot be skipped or replayed', () => {
  assert.throws(
    () => markAuthRecoveryRotationExecuting(reviewReceipt(), {
      operator,
      caseReference,
      identities: identities(),
      confirmation: reviewReceipt().confirmation,
      now: new Date('2026-07-12T10:01:00.000Z'),
    }),
    /not at the executable checkpoint/u,
  );
  assert.throws(
    () => recordAuthRecoveryRotationSecretReplacement(executingReceipt(), {
      before: baseEnvironment,
      after: replacementEnvironment,
    }),
    /cannot transition/u,
  );
  assert.throws(
    () => completeAuthRecoveryRotation(activatingReceipt()),
    /cannot transition/u,
  );
});
