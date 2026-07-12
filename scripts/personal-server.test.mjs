import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  archiveUpdateReceipt,
  executePersonalServerCutoverRecovery,
  executePersonalServerCleanup,
  executePersonalServerDecommissionFinalization,
  executePersonalServerRestoreCutover,
  generateStrongOneTimePassword,
  environmentFilePath,
  parsePersonalServerArgs,
  parsePersonalServerEnv,
  personalServerDecommissionConfirmation,
  personalServerRestoreConfirmation,
  personalServerRollbackConfirmation,
  removePersonalVolumeIfPresent,
  renderPersonalServerEnv,
  runCommandFromFile,
  runPersonalServer,
  validateRecoveryApplicationBinding,
  validateCleanGitReleaseAdoption,
  validateReplacementRestoreSourceBinding,
  validateTailscaleServeClosed,
  validatePersonalServerFreshRecovery,
  validatePersonalServerContainerAbsence,
  validatePersonalServerNetworkAbsence,
  validatePersonalServerNetworkIdentity,
  validatePersonalServerVolumeIdentity,
  validateLocalDockerDesktopRuntime,
} from './personal-server.mjs';
import {
  cleanupPersonalServerRecoveryStaging,
  cleanupPersonalServerRecoveryStagingForSet,
  decryptPersonalServerArtifact,
  encryptPersonalServerArtifact,
  hmacPersonalServerRecoveryManifest,
  inspectPersonalServerDocumentArchive,
  loadPersonalServerEncryptionKey,
  personalServerRecoveryFormats,
  sha256RecoveryFile,
  verifyPersonalServerRecoverySet,
} from './personal-server-recovery.mjs';
import {
  authRecoveryRotationIdentitySha256,
  createAuthRecoveryRotationIdentityHashes,
  createAuthRecoveryRotationReviewReceipt,
  recordAuthRecoveryRotationAuthorityStart,
  recordAuthRecoveryRotationBackup,
} from './personal-server-auth-recovery-rotation.mjs';
import { runPostgresBackupFromArgs } from './postgres-backup.mjs';

const NOW = new Date('2026-07-11T12:00:00.000Z');

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, 0xab);
}

function validConfig() {
  return {
    port: '8080',
    origin: 'http://localhost:8080',
    imageTag: 'local',
    postgresDatabase: 'charitypilot_personal_server',
    postgresUser: 'charitypilot_personal_server',
    postgresPassword: 'a'.repeat(64),
    jwtSecret: 'J'.repeat(64),
    authRecoverySecret: 'A'.repeat(64),
    readinessApiKey: 'R'.repeat(64),
    ownerEmail: 'owner@example.org',
    ownerName: 'Example Owner',
    organisationName: 'Example Charity',
  };
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function authRecoveryDryRunEvidence({
  reason = 'SUSPECTED_KEY_COMPROMISE',
  caseReference = 'INC-2026-0042',
  databaseIdentitySha256 = 'd'.repeat(64),
} = {}) {
  return {
    mode: 'DRY_RUN',
    mutationApplied: false,
    generation: 3,
    capabilities: 2,
    requestEvidenceRows: 2,
    legacySlots: 1,
    rateBuckets: 1,
    securityNotices: 4,
    reason,
    terminationReason: 'KEY_ROTATED',
    securityNoticesPreserved: 4,
    caseReferenceSha256: sha256Text(caseReference),
    databaseIdentitySha256,
    deploymentProfile: 'personal-server',
    executionConfirmation: `ROTATE AUTH RECOVERY SECRET ${'x'.repeat(64)}`,
    credentialsIssued: false,
  };
}

function authRecoveryActivationConfirmation() {
  return `ACTIVATE REPLACEMENT AUTH RECOVERY SECRET ${'y'.repeat(64)}`;
}

function authRecoveryExecutedEvidence() {
  const reviewed = authRecoveryDryRunEvidence();
  return {
    mode: 'EXECUTED',
    mutationApplied: true,
    recoveryBlocked: true,
    rotatedGeneration: reviewed.generation,
    blockedGeneration: reviewed.generation + 1,
    activationConfirmation: authRecoveryActivationConfirmation(),
    invalidatedCapabilities: reviewed.capabilities,
    redactedRequestEvidenceRows: reviewed.requestEvidenceRows,
    clearedLegacySlots: reviewed.legacySlots,
    deletedRateBuckets: reviewed.rateBuckets,
    securityNotices: reviewed.securityNotices,
    remainingCapabilities: 0,
    remainingRequestEvidenceRows: 0,
    remainingLegacySlots: 0,
    remainingRateBuckets: 0,
    reason: reviewed.reason,
    terminationReason: reviewed.terminationReason,
    securityNoticesPreserved: reviewed.securityNotices,
    caseReferenceSha256: reviewed.caseReferenceSha256,
    databaseIdentitySha256: reviewed.databaseIdentitySha256,
    deploymentProfile: reviewed.deploymentProfile,
    executionConfirmation: reviewed.executionConfirmation,
    credentialsIssued: false,
  };
}

function authRecoveryActivatedEvidence() {
  const reviewed = authRecoveryDryRunEvidence();
  return {
    mode: 'ACTIVATED',
    mutationApplied: true,
    generation: reviewed.generation + 1,
    recoveryBlocked: false,
    remainingCapabilities: 0,
    remainingRequestEvidenceRows: 0,
    remainingLegacySlots: 0,
    remainingRateBuckets: 0,
    securityNoticesPreserved: reviewed.securityNotices,
    reason: reviewed.reason,
    caseReferenceSha256: reviewed.caseReferenceSha256,
    databaseIdentitySha256: reviewed.databaseIdentitySha256,
    deploymentProfile: reviewed.deploymentProfile,
    activationConfirmation: authRecoveryActivationConfirmation(),
    credentialsIssued: false,
  };
}

function authRecoveryNewActiveControlStatus() {
  const reviewed = authRecoveryDryRunEvidence();
  return {
    mode: 'CONTROL_STATUS',
    mutationApplied: false,
    blocked: false,
    generation: reviewed.generation + 1,
    currentSecretActive: true,
    capabilities: 0,
    requestEvidenceRows: 0,
    legacySlots: 0,
    rateBuckets: 0,
    securityNotices: reviewed.securityNotices,
    reason: reviewed.reason,
    caseReferenceSha256: reviewed.caseReferenceSha256,
    databaseIdentitySha256: reviewed.databaseIdentitySha256,
    deploymentProfile: reviewed.deploymentProfile,
    credentialsIssued: false,
  };
}

function authRecoveryIdentityHashes(installation, environmentContent) {
  const imageTag = validConfig().imageTag;
  return createAuthRecoveryRotationIdentityHashes({
    source: {
      sourceRoot: installation.sourceRoot,
      source: installation.source,
      applicationSource: { kind: 'clean-git', commitSha: installation.source.revision },
    },
    installation: {
      format: installation.format,
      installationMode: installation.installationMode ?? 'fresh-install',
      origin: installation.origin ?? validConfig().origin,
      port: installation.port ?? validConfig().port,
      activeImageTag: installation.activeImageTag,
    },
    images: {
      api: {
        name: `charitypilot-personal-server-api:${imageTag}`,
        id: `sha256:${'a'.repeat(64)}`,
      },
      migrations: {
        name: `charitypilot-personal-server-migrations:${imageTag}`,
        id: `sha256:${'b'.repeat(64)}`,
      },
      web: {
        name: `charitypilot-personal-server-web:${imageTag}`,
        id: `sha256:${'c'.repeat(64)}`,
      },
    },
    environmentContent,
  });
}

function withWorkspace(callback, { withEnv = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-personal-server-'));
  writeFileSync(join(root, 'compose.personal-server.yml'), 'name: charitypilot-personal-server\nservices: {}\n');
  if (withEnv) writeFileSync(join(root, '.env.personal-server'), renderPersonalServerEnv(validConfig()));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeReadyInstallationState(root, overrides = {}) {
  const state = {
    format: 'charitypilot-personal-server-install-state/v1',
    phase: 'ready',
    sourceRoot: root,
    source: {
      kind: 'clean-git',
      revision: 'a'.repeat(40),
      branch: 'master',
      canonicalRemote: true,
      canonicalTrackingRef: true,
      originMasterRevision: 'a'.repeat(40),
    },
    activeImageTag: 'local',
    ...overrides,
  };
  writeFileSync(join(root, 'install-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(root, 'recovery-key.hex'), `${'1'.repeat(64)}\n`);
  return state;
}

function fakeExecutor(handler = () => null, { recordDockerBoundary = false } = {}) {
  const calls = [];
  const spawn = (executable, args, options) => {
    const call = { command: [executable, ...args], options };
    const boundaryOutput = executable === 'docker' && args[0] === 'context'
      ? 'npipe:////./pipe/dockerDesktopLinuxEngine|false\n'
      : executable === 'docker' && args[0] === 'info'
        ? 'Docker Desktop|linux\n'
        : executable === 'docker' && args[0] === 'version'
          ? '1.54\n'
          : null;
    const localPostgresContainerOutput = executable === 'docker' &&
      args[0] === 'run' &&
      args.includes('-d') &&
      args.some((value) => /^postgres(?::[^@]+)?@sha256:[a-f0-9]{64}$/u.test(value))
      ? `${'d'.repeat(64)}\n`
      : null;
    const localDatabaseInspectionOutput = executable === 'docker' &&
      args.includes('inspect') &&
      args.includes('d'.repeat(64))
      ? `${JSON.stringify([{
        Id: 'd'.repeat(64),
        Name: '/charitypilot-personal-server-db-1',
        Config: {
          Labels: {
            'com.docker.compose.project': 'charitypilot-personal-server',
            'com.docker.compose.service': 'db',
          },
        },
        Mounts: [{
          Type: 'volume',
          Name: 'charitypilot-personal-server-db',
          Destination: '/var/lib/postgresql/data',
        }],
      }])}\n`
      : null;
    if (boundaryOutput !== null && !recordDockerBoundary) {
      return { status: 0, stdout: boundaryOutput, stderr: '' };
    }
    calls.push(call);
    const handled = handler(call, calls);
    return handled ?? (boundaryOutput !== null
      ? { status: 0, stdout: boundaryOutput, stderr: '' }
      : localPostgresContainerOutput !== null
        ? { status: 0, stdout: localPostgresContainerOutput, stderr: '' }
        : localDatabaseInspectionOutput !== null
          ? { status: 0, stdout: localDatabaseInspectionOutput, stderr: '' }
          : { status: 0, stdout: '', stderr: '' });
  };
  return { calls, spawn };
}

function runAt(root, args, executor, output, processEnv = {}, runtimeOptions = {}) {
  return runPersonalServer({
    args,
    repoRoot: root,
    processEnv,
    spawnSyncImpl: executor.spawn,
    randomBytesImpl: runtimeOptions.randomBytesImpl ?? deterministicRandomBytes,
    now: runtimeOptions.now ?? (() => new Date(NOW)),
    // This suite models the supported Windows + Docker Desktop profile.
    // Keep the host platform deterministic when the tests run on Linux CI;
    // Linux-host behaviour has its own personal-server-linux.test.mjs suite.
    hostPlatform: runtimeOptions.hostPlatform ?? 'win32',
    writeOutput: (value) => output.push(value),
  });
}

function commandText(calls) {
  return calls.map((call) => call.command.join(' ')).join('\n');
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  assert.equal(Buffer.byteLength(encoded), length);
  header.write(encoded, offset, length, 'ascii');
}

function tarArchive(entries) {
  const records = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    writeTarOctal(header, 100, 8, 0o600);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    records.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) records.push(Buffer.alloc(padding));
  }
  records.push(Buffer.alloc(1024));
  return Buffer.concat(records);
}

function createRecoveryFixture(root, {
  encrypted = false,
  origin = validConfig().origin,
  imageTag = 'local',
  applicationSource = { kind: 'unmanaged-local' },
  imageIds = {
    api: `sha256:${'a'.repeat(64)}`,
    migrations: `sha256:${'b'.repeat(64)}`,
    web: `sha256:${'c'.repeat(64)}`,
  },
} = {}) {
  const recoverySetId = 'personal-server-2026-07-11T12-00-00-000Z-abababab';
  const setPath = join(root, recoverySetId);
  mkdirSync(setPath);
  const databasePlaintext = Buffer.from('verified-personal-database-dump', 'utf8');
  const databasePath = join(setPath, 'database.dump');
  const documentsPath = join(setPath, 'documents.tar');
  writeFileSync(databasePath, databasePlaintext);
  writeFileSync(documentsPath, tarArchive([{
    name: 'organisation-1/board-minutes.txt',
    content: 'approved minutes',
  }]));
  const documentInventory = inspectPersonalServerDocumentArchive(documentsPath);
  const databaseSha256 = sha256RecoveryFile(databasePath);
  const databaseFingerprint = 'f'.repeat(64);
  const proof = {
    format: 'charitypilot-postgres-restore-proof/v2',
    ok: true,
    recoverySetId,
    sourceIdentityBindingMatched: true,
    sourceReadOnlyVerified: true,
    restoreTarget: { cleanupVerified: true, productionOverwritten: false },
    comparison: {
      mismatchCount: 0,
      rowFingerprintsMatched: true,
      databaseFingerprintMatched: true,
    },
    dump: { sha256: databaseSha256, bytes: String(databasePlaintext.length) },
    source: { databaseFingerprintSha256: databaseFingerprint },
  };
  const proofPath = join(setPath, 'database.restore-proof.json');
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);

  let databaseDescriptor = {
    file: 'database.dump',
    bytes: databasePlaintext.length,
    sha256: databaseSha256,
    plaintextBytes: databasePlaintext.length,
    plaintextSha256: databaseSha256,
    encryption: { format: personalServerRecoveryFormats.plaintextArtifact },
  };
  let documentsDescriptor = {
    file: 'documents.tar',
    bytes: readFileSync(documentsPath).length,
    sha256: sha256RecoveryFile(documentsPath),
    plaintextBytes: readFileSync(documentsPath).length,
    plaintextSha256: sha256RecoveryFile(documentsPath),
    encryption: { format: personalServerRecoveryFormats.plaintextArtifact },
  };
  let encryptionKeyFile;
  if (encrypted) {
    encryptionKeyFile = join(root, 'recovery-encryption.key');
    writeFileSync(encryptionKeyFile, `${'1'.repeat(64)}\n`);
    const keyRecord = loadPersonalServerEncryptionKey(encryptionKeyFile);
    const encryptedDatabasePath = `${databasePath}.enc`;
    const encryptedDocumentsPath = `${documentsPath}.enc`;
    const encryptedDatabase = encryptPersonalServerArtifact({
      inputPath: databasePath,
      outputPath: encryptedDatabasePath,
      key: keyRecord.key,
      aadContext: `${recoverySetId}:database`,
      randomBytesImpl: (size) => Buffer.alloc(size, 0x11),
    });
    const encryptedDocuments = encryptPersonalServerArtifact({
      inputPath: documentsPath,
      outputPath: encryptedDocumentsPath,
      key: keyRecord.key,
      aadContext: `${recoverySetId}:documents`,
      randomBytesImpl: (size) => Buffer.alloc(size, 0x22),
    });
    rmSync(databasePath);
    rmSync(documentsPath);
    databaseDescriptor = {
      file: 'database.dump.enc',
      ...encryptedDatabase,
      encryption: {
        format: personalServerRecoveryFormats.encryptedArtifact,
        keySha256: keyRecord.keySha256,
      },
    };
    documentsDescriptor = {
      file: 'documents.tar.enc',
      ...encryptedDocuments,
      encryption: {
        format: personalServerRecoveryFormats.encryptedArtifact,
        keySha256: keyRecord.keySha256,
      },
    };
  }

  const manifest = {
    format: 'charitypilot-personal-server-backup/v2',
    recoverySetId,
    createdAt: NOW.toISOString(),
    project: 'charitypilot-personal-server',
    origin,
    application: {
      format: 'charitypilot-personal-server-application-identity/v1',
      imageTag,
      images: {
        api: { name: `charitypilot-personal-server-api:${imageTag}`, id: imageIds.api },
        migrations: { name: `charitypilot-personal-server-migrations:${imageTag}`, id: imageIds.migrations },
        web: { name: `charitypilot-personal-server-web:${imageTag}`, id: imageIds.web },
      },
      source: applicationSource,
    },
    writersQuiesced: true,
    database: {
      ...databaseDescriptor,
      restoreVerified: true,
      contentFingerprintSha256: databaseFingerprint,
      restoreProof: {
        file: 'database.restore-proof.json',
        bytes: readFileSync(proofPath).length,
        sha256: sha256RecoveryFile(proofPath),
      },
    },
    documents: {
      ...documentsDescriptor,
      volume: 'charitypilot-personal-server-documents',
      fileCount: documentInventory.fileCount,
      totalFileBytes: documentInventory.totalFileBytes,
      inventorySha256: documentInventory.inventorySha256,
    },
  };
  if (encrypted) {
    const keyRecord = loadPersonalServerEncryptionKey(encryptionKeyFile);
    manifest.authentication = {
      format: personalServerRecoveryFormats.manifestAuthentication,
      file: 'manifest.hmac-sha256',
      keySha256: keyRecord.keySha256,
    };
  }
  const manifestPath = join(setPath, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(setPath, 'manifest.sha256'), `${sha256RecoveryFile(manifestPath)}  manifest.json\n`);
  if (encrypted) {
    const keyRecord = loadPersonalServerEncryptionKey(encryptionKeyFile);
    writeFileSync(
      join(setPath, 'manifest.hmac-sha256'),
      `${hmacPersonalServerRecoveryManifest(manifestPath, keyRecord.key)}  manifest.json\n`,
    );
  }
  return { setPath, recoverySetId, encryptionKeyFile, documentInventory };
}

function createInterruptedAuthRecoveryRotationFixture(root, {
  createdAt = new Date(NOW.getTime() - (5 * 60 * 1000)),
  receiptPhase = 'review-ready',
} = {}) {
  const installation = writeReadyInstallationState(root, {
    installationMode: 'fresh-install',
    origin: validConfig().origin,
    port: Number(validConfig().port),
  });
  const environmentContent = readFileSync(join(root, '.env.personal-server'), 'utf8');
  let receipt = createAuthRecoveryRotationReviewReceipt({
    receiptId: '1234567890abcdef12345678',
    reason: 'SUSPECTED_KEY_COMPROMISE',
    operator: 'Named Charity Director',
    caseReference: 'INC-2026-0042',
    identities: authRecoveryIdentityHashes(installation, environmentContent),
    dryRunEvidence: authRecoveryDryRunEvidence(),
    now: createdAt,
  });
  receipt = recordAuthRecoveryRotationAuthorityStart(receipt, {
    operator: 'Named Charity Director',
    caseReference: 'INC-2026-0042',
    identities: authRecoveryIdentityHashes(installation, environmentContent),
    confirmation: receipt.confirmation,
    now: new Date(createdAt.getTime() + 30_000),
  });
  const backupRoot = join(root, '.charitypilot-backups', 'personal-server');
  mkdirSync(backupRoot, { recursive: true });
  const recovery = createRecoveryFixture(backupRoot, { encrypted: true });
  const manifestPath = join(recovery.setPath, 'manifest.json');
  const backupReferenceSha256 = authRecoveryRotationIdentitySha256('backup-reference', {
    recoverySetId: recovery.recoverySetId,
    path: recovery.setPath,
  });
  const backupManifestSha256 = sha256RecoveryFile(manifestPath);
  if (receiptPhase === 'backup-complete') {
    receipt = recordAuthRecoveryRotationBackup(receipt, {
      referenceSha256: backupReferenceSha256,
      manifestSha256: backupManifestSha256,
      now: new Date(createdAt.getTime() + 60_000),
    });
  }
  writeFileSync(
    join(root, 'pending-auth-recovery-rotation.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const operation = {
    receiptId: receipt.receiptId,
    receiptPath: join(root, 'pending-auth-recovery-rotation.json'),
    stage: 'backup-complete',
    backupPath: recovery.setPath,
    backupRecoverySetId: recovery.recoverySetId,
    backupReferenceSha256,
    backupManifestSha256,
    encryptionKeySha256: loadPersonalServerEncryptionKey(recovery.encryptionKeyFile).keySha256,
    writersBefore: ['caddy', 'web', 'api'],
    databaseWasRunning: true,
    startedAt: new Date(createdAt.getTime() + 60_000).toISOString(),
  };
  writeFileSync(join(root, 'install-state.json'), `${JSON.stringify({
    ...installation,
    phase: 'auth-recovery-rotating',
    authRecoveryRotation: operation,
  }, null, 2)}\n`);
  return { receipt, operation, recovery };
}

function authRecoveryRotationExecutor({
  failDryRun = false,
  dryRunEvidenceOutput,
  failRunningServicesCall,
  runningServicesOutput = 'db\napi\nweb\ncaddy\n',
} = {}) {
  let runningServicesCalls = 0;
  return fakeExecutor((call) => {
    const text = call.command.join(' ');
    if (text.includes('docker image inspect') && text.includes('personal-server-api:')) {
      return { status: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' };
    }
    if (text.includes('docker image inspect') && text.includes('personal-server-migrations:')) {
      return { status: 0, stdout: `sha256:${'b'.repeat(64)}\n`, stderr: '' };
    }
    if (text.includes('docker image inspect') && text.includes('personal-server-web:')) {
      return { status: 0, stdout: `sha256:${'c'.repeat(64)}\n`, stderr: '' };
    }
    if (text.includes('ps --status running --services')) {
      runningServicesCalls += 1;
      if (runningServicesCalls === failRunningServicesCall) {
        return { status: 1, stdout: '', stderr: 'simulated backup-start interruption' };
      }
      return { status: 0, stdout: runningServicesOutput, stderr: '' };
    }
    if (
      text.includes('auth-recovery-secret-rotation') &&
      text.includes('--dry-run')
    ) {
      if (failDryRun) {
        return { status: 1, stdout: '', stderr: 'simulated post-resume review failure' };
      }
      if (dryRunEvidenceOutput) {
        return { status: 0, stdout: `${JSON.stringify(dryRunEvidenceOutput)}\n`, stderr: '' };
      }
    }
    return null;
  });
}

function fullAuthRecoveryRotationExecutor() {
  let activationAttempts = 0;
  let runningServicesCalls = 0;
  let postActivationBackupFailures = 0;
  const executor = fakeExecutor((call) => {
    const text = call.command.join(' ');
    if (text.includes('docker image inspect') && text.includes('personal-server-api:')) {
      return { status: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' };
    }
    if (text.includes('docker image inspect') && text.includes('personal-server-migrations:')) {
      return { status: 0, stdout: `sha256:${'b'.repeat(64)}\n`, stderr: '' };
    }
    if (text.includes('docker image inspect') && text.includes('personal-server-web:')) {
      return { status: 0, stdout: `sha256:${'c'.repeat(64)}\n`, stderr: '' };
    }
    if (text.includes('ps --status running --services')) {
      runningServicesCalls += 1;
      if (runningServicesCalls === 3) {
        postActivationBackupFailures += 1;
        return { status: 1, stdout: '', stderr: 'simulated post-activation backup power-loss boundary' };
      }
      return { status: 0, stdout: 'db\napi\nweb\ncaddy\n', stderr: '' };
    }
    if (text.includes('ps --all -q db')) {
      return { status: 0, stdout: `${'d'.repeat(64)}\n`, stderr: '' };
    }
    if (text.includes('postgres-backup.mjs source-identity')) {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          format: 'charitypilot-postgres-source-identity/v2',
          ok: true,
          sourceReadOnlyVerified: true,
          sourceDatabaseIdentitySha256: 'e'.repeat(64),
        })}\n`,
        stderr: '',
      };
    }
    if (text.includes('postgres-backup.mjs prove-restore')) {
      const outputDirectory = call.command.find((value) => value.startsWith('--output-dir='))?.slice('--output-dir='.length);
      const outputFile = call.command.find((value) => value.startsWith('--output-file='))?.slice('--output-file='.length);
      const reportFile = call.command.find((value) => value.startsWith('--report-file='))?.slice('--report-file='.length);
      const recoverySetId = call.command.find((value) => value.startsWith('--recovery-set-id='))?.slice('--recovery-set-id='.length);
      assert.ok(outputDirectory && outputFile && reportFile && recoverySetId);
      const dumpPath = join(outputDirectory, outputFile);
      writeFileSync(dumpPath, `verified dump for ${recoverySetId}`);
      const dumpBytes = readFileSync(dumpPath).length;
      const dumpSha256 = sha256RecoveryFile(dumpPath);
      writeFileSync(join(outputDirectory, reportFile), `${JSON.stringify({
        format: 'charitypilot-postgres-restore-proof/v2',
        ok: true,
        recoverySetId,
        sourceIdentityBindingMatched: true,
        sourceReadOnlyVerified: true,
        restoreTarget: { cleanupVerified: true, productionOverwritten: false },
        comparison: {
          mismatchCount: 0,
          rowFingerprintsMatched: true,
          databaseFingerprintMatched: true,
        },
        dump: { sha256: dumpSha256, bytes: String(dumpBytes) },
        source: { databaseFingerprintSha256: 'f'.repeat(64) },
      }, null, 2)}\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      Array.isArray(call.options.stdio) &&
      typeof call.options.stdio[1] === 'number' &&
      text.includes('tar -cf - -C /documents .')
    ) {
      writeSync(call.options.stdio[1], tarArchive([]));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (text.includes('auth-recovery-secret-rotation') && text.includes('--dry-run')) {
      return { status: 0, stdout: `${JSON.stringify(authRecoveryDryRunEvidence())}\n`, stderr: '' };
    }
    if (text.includes('auth-recovery-secret-rotation') && text.includes('--execute')) {
      return { status: 0, stdout: `${JSON.stringify(authRecoveryExecutedEvidence())}\n`, stderr: '' };
    }
    if (text.includes('auth-recovery-secret-rotation') && text.includes('--activate-after-replacement')) {
      activationAttempts += 1;
      if (activationAttempts === 1) {
        return { status: 1, stdout: '', stderr: 'simulated ambiguous activation transport failure' };
      }
      return { status: 0, stdout: `${JSON.stringify(authRecoveryActivatedEvidence())}\n`, stderr: '' };
    }
    if (text.includes('auth-recovery-secret-rotation') && text.includes('--control-status')) {
      return { status: 0, stdout: `${JSON.stringify(authRecoveryNewActiveControlStatus())}\n`, stderr: '' };
    }
    if (text.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}")) {
      return { status: 0, stdout: '172.31.255.10\n', stderr: '' };
    }
    if (text.includes('charitypilot-personal-disposable-identity/v1')) {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          format: 'charitypilot-personal-disposable-identity/v1',
          organisationId: '00000000-0000-4000-8000-000000000001',
        })}\n`,
        stderr: '',
      };
    }
    if (text.includes('charitypilot-personal-document-inventory/v1')) {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          format: 'charitypilot-personal-document-inventory/v1',
          documents: [],
        })}\n`,
        stderr: '',
      };
    }
    if (text.includes('charitypilot-personal-full-application-proof/v1')) {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          format: 'charitypilot-personal-full-application-proof/v1',
          ownerLogin: true,
          webThroughCaddy: true,
          sampledDocument: false,
        })}\n`,
        stderr: '',
      };
    }
    return null;
  });
  return {
    executor,
    get activationAttempts() { return activationAttempts; },
    get postActivationBackupFailures() { return postActivationBackupFailures; },
  };
}

function sequentialRandomBytes() {
  let call = 0;
  return (size) => {
    call += 1;
    return Buffer.alloc(size, call % 256);
  };
}

test('argument parser exposes the safe command surface and rejects invented options', () => {
  assert.deepEqual(parsePersonalServerArgs(['help']), { command: 'help', options: {} });
  assert.deepEqual(parsePersonalServerArgs(['resume-init', '--dry-run']), {
    command: 'resume-init',
    options: { dryRun: true },
  });
  assert.deepEqual(
    parsePersonalServerArgs(['reset-link', '--email=director@example.org', '--dry-run']),
    { command: 'reset-link', options: { email: 'director@example.org', dryRun: true } },
  );
  assert.deepEqual(
    parsePersonalServerArgs(['rehearse-restore', '--recovery-set=C:\\recovery']),
    { command: 'rehearse-restore', options: { 'recovery-set': 'C:\\recovery', dryRun: false } },
  );
  assert.deepEqual(
    parsePersonalServerArgs([
      'rehearse-restore',
      '--recovery-set=C:\\recovery',
      '--source-origin=https://old-host.example.ts.net',
    ]),
    {
      command: 'rehearse-restore',
      options: {
        'recovery-set': 'C:\\recovery',
        'source-origin': 'https://old-host.example.ts.net',
        dryRun: false,
      },
    },
  );
  assert.deepEqual(
    parsePersonalServerArgs([
      'rotate-auth-recovery-secret',
      '--reason=SUSPECTED_KEY_COMPROMISE',
      '--operator=Named Charity Director',
      '--case-reference=INC-2026-0042',
    ]),
    {
      command: 'rotate-auth-recovery-secret',
      options: {
        reason: 'SUSPECTED_KEY_COMPROMISE',
        operator: 'Named Charity Director',
        'case-reference': 'INC-2026-0042',
        dryRun: false,
      },
    },
  );
  assert.deepEqual(
    parsePersonalServerArgs(['restore', '--recovery-set=C:\\recovery', '--confirm=exact']),
    { command: 'restore', options: { 'recovery-set': 'C:\\recovery', confirm: 'exact', dryRun: false } },
  );
  assert.deepEqual(
    parsePersonalServerArgs(['decommission', '--recovery-set=C:\\recovery', '--confirm=exact']),
    { command: 'decommission', options: { 'recovery-set': 'C:\\recovery', confirm: 'exact', dryRun: false } },
  );
  assert.deepEqual(
    parsePersonalServerArgs([
      'update',
      '--update-receipt=C:\\state\\pending-update.json',
      '--resume-pending',
    ]),
    {
      command: 'update',
      options: {
        'update-receipt': 'C:\\state\\pending-update.json',
        resumePending: true,
        dryRun: false,
      },
    },
  );
  assert.throws(() => parsePersonalServerArgs(['stop', '--volumes']), /Unknown option/);
  assert.throws(() => parsePersonalServerArgs(['reset-link', '--email']), /requires a value/);
  assert.throws(
    () => parsePersonalServerArgs(['backup', '--dry-run', '--dry-run']),
    /--dry-run may be provided only once/,
  );
  assert.throws(
    () => parsePersonalServerArgs(['start', '--help', '--help']),
    /--help may be provided only once/,
  );
  assert.throws(
    () => parsePersonalServerArgs(['update', '--resume-pending', '--resume-pending']),
    /--resume-pending may be provided only once/,
  );
  assert.throws(
    () => parsePersonalServerArgs(['update', '--resume-pending=true']),
    /--resume-pending does not accept a value/,
  );
});

test('replacement-host parser exposes a separate plan and guarded bootstrap surface', () => {
  assert.deepEqual(
    parsePersonalServerArgs([
      'bootstrap-restore-plan', '--recovery-set=C:\\recovery',
      '--source-origin=https://old.example.ts.net', '--origin=https://new.example.ts.net',
      '--port=8080', '--encryption-key-file=C:\\key.hex',
    ]),
    {
      command: 'bootstrap-restore-plan',
      options: {
        'recovery-set': 'C:\\recovery',
        'source-origin': 'https://old.example.ts.net',
        origin: 'https://new.example.ts.net',
        port: '8080',
        'encryption-key-file': 'C:\\key.hex',
        dryRun: false,
      },
    },
  );
  assert.deepEqual(
    parsePersonalServerArgs([
      'bootstrap-restore', '--recovery-set=C:\\recovery',
      '--source-origin=https://old.example.ts.net', '--origin=https://new.example.ts.net',
      '--port=8080', '--confirm=exact', '--owner-email=owner@example.org',
      '--owner-password-file=C:\\owner-password.txt', '--encryption-key-file=C:\\key.hex',
    ]).command,
    'bootstrap-restore',
  );
  assert.throws(
    () => parsePersonalServerArgs(['restore', '--owner-password-file=C:\\owner-password.txt']),
    /Unknown option/u,
  );
});

test('replacement-host source binding requires the exact authenticated tag and commit without retained image IDs', () => {
  const application = {
    format: 'charitypilot-personal-server-application-identity/v1',
    imageTag: 'personal-v1.2.3',
    source: { kind: 'release-bundle', tag: 'personal-v1.2.3', commitSha: 'a'.repeat(40) },
  };
  const source = {
    releaseIdentity: { tag: 'personal-v1.2.3', commitSha: 'a'.repeat(40) },
  };
  assert.equal(validateReplacementRestoreSourceBinding(application, 'personal-v1.2.3', source), true);
  assert.throws(
    () => validateReplacementRestoreSourceBinding(application, 'personal-v1.2.4', source),
    /exact authenticated backup source/u,
  );
  assert.throws(
    () => validateReplacementRestoreSourceBinding(application, 'personal-v1.2.3', {
      releaseIdentity: { tag: 'personal-v1.2.3', commitSha: 'b'.repeat(40) },
    }),
    /exact authenticated backup source/u,
  );
});

test('generated environment contains strong distinct secrets but never an owner password', () => {
  const content = renderPersonalServerEnv(validConfig());
  const parsed = parsePersonalServerEnv(content);
  assert.equal(parsed.CHARITYPILOT_PERSONAL_SERVER_ORIGIN, 'http://localhost:8080');
  assert.equal(parsed.PERSONAL_SERVER_OWNER_EMAIL, 'owner@example.org');
  assert.equal(Object.hasOwn(parsed, 'PERSONAL_SERVER_OWNER_PASSWORD'), false);
  assert.doesNotMatch(content, /PASSWORD=.*owner/iu);

  const password = generateStrongOneTimePassword(deterministicRandomBytes);
  assert.match(password, /[A-Z]/u);
  assert.match(password, /[a-z]/u);
  assert.match(password, /[0-9]/u);
  assert.match(password, /[^A-Za-z0-9]/u);
});

test('existing personal-server upgrade guidance adds a canonical independent recovery secret without disclosing it', () => {
  const deploymentGuide = readFileSync(join(process.cwd(), 'docs', 'personal-server-deployment.md'), 'utf8');
  const envExample = readFileSync(join(process.cwd(), '.env.personal-server.example'), 'utf8');

  assert.match(envExample, /canonical even-length hex or unpadded base64url encoding of 32-64 random bytes/u);
  assert.match(envExample, /Do not reuse JWT_SECRET or READINESS_API_KEY/u);
  assert.match(deploymentGuide, /created before the password-recovery integrity upgrade/u);
  assert.match(deploymentGuide, /leave it\s+unchanged: do not rotate it as an ordinary update step/u);
  assert.match(deploymentGuide, /RandomNumberGenerator/u);
  assert.match(deploymentGuide, /New-Object byte\[\] 48/u);
  assert.match(deploymentGuide, /Do not print the generated value/u);
  assert.match(deploymentGuide, /Record only that the prerequisite was\s+completed/u);
  assert.match(deploymentGuide, /never edit the protected environment/u);
  const rotationSection = deploymentGuide.slice(
    deploymentGuide.indexOf('### Security-incident rotation of `AUTH_RECOVERY_SECRET`'),
    deploymentGuide.indexOf('From the new release directory:'),
  );
  assert.match(rotationSection, /personal:server:rotate-auth-recovery-secret/u);
  assert.match(rotationSection, /count-only/u);
  assert.match(rotationSection, /protected 30-minute review receipt/u);
  assert.match(rotationSection, /terminates every non-suppressed\s+recovery capability as `KEY_ROTATED`/u);
  assert.match(rotationSection, /clears both halves of every legacy `User`\s+reset slot/u);
  assert.match(rotationSection, /auth-recovery-rotating/u);
  assert.match(rotationSection, /read-only control-status reconciliation/u);
  assert.doesNotMatch(rotationSection, /^(?:\s*)docker compose|--expected-generation|--confirm-execute|--activate-after-replacement/imu);
  assert.doesNotMatch(deploymentGuide, /Write-Host\s+['"]?\$secret/u);
});

test('supported auth recovery rotation dry-run is count-only, quiesced, locked, and non-mutating', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root, {
      installationMode: 'fresh-install',
      origin: validConfig().origin,
      port: 8080,
    });
    const beforeEnvironment = readFileSync(join(root, '.env.personal-server'), 'utf8');
    const beforeState = readFileSync(join(root, 'install-state.json'), 'utf8');
    const output = [];
    const executor = fakeExecutor();
    runAt(root, [
      'rotate-auth-recovery-secret',
      '--reason=SUSPECTED_KEY_COMPROMISE',
      '--operator=Named Charity Director',
      '--case-reference=INC-2026-0042',
      '--dry-run',
    ], executor, output);
    const text = output.join('');
    const stop = text.indexOf('stop caddy web api');
    const review = text.indexOf('auth-recovery-secret-rotation node dist/jobs/rotate-auth-recovery-secret.js --dry-run');
    const restart = text.lastIndexOf('up -d --no-build --no-deps --wait');
    assert.ok(stop >= 0 && stop < review && review < restart);
    assert.match(text, /--project-name charitypilot-personal-server/u);
    assert.match(text, /--no-deps -T auth-recovery-secret-rotation/u);
    assert.match(text, /count-only auth recovery review would create no receipt, backup, secret, or database mutation/u);
    assert.doesNotMatch(text, /--execute|--activate-after-replacement/u);
    assert.doesNotMatch(text, /AUTH_RECOVERY_SECRET=[^\s]+/u);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), beforeEnvironment);
    assert.equal(readFileSync(join(root, 'install-state.json'), 'utf8'), beforeState);
    assert.equal(existsSync(join(root, 'pending-auth-recovery-rotation.json')), false);
    assert.equal(executor.calls.length, 0);
  });
});

test('auth recovery rotation rejects partial runtime availability before review or backup', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root, {
      installationMode: 'fresh-install',
      origin: validConfig().origin,
      port: Number(validConfig().port),
    });
    assert.throws(
      () => runAt(root, [
        'rotate-auth-recovery-secret',
        '--reason=SUSPECTED_KEY_COMPROMISE',
        '--operator=Named Charity Director',
        '--case-reference=INC-2026-0042',
      ], authRecoveryRotationExecutor({ runningServicesOutput: 'db\napi\n' }), []),
      /fully running or fully stopped/u,
    );
    assert.equal(existsSync(join(root, 'pending-auth-recovery-rotation.json')), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8')).phase, 'ready');
  });
});

test('confirmed auth recovery rotation cannot be disguised as a dry-run', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root);
    assert.throws(
      () => runAt(root, [
        'rotate-auth-recovery-secret',
        '--reason=SUSPECTED_KEY_COMPROMISE',
        '--operator=Named Charity Director',
        '--case-reference=INC-2026-0042',
        '--confirm=not-authorised',
        '--dry-run',
      ], fakeExecutor(), []),
      /review-only.*must not be combined/u,
    );
  });
});

test('pre-backup intent durably preserves original availability before quiescence', () => {
  withWorkspace((root) => {
    const readyInstallation = writeReadyInstallationState(root, {
      installationMode: 'fresh-install',
      origin: validConfig().origin,
      port: Number(validConfig().port),
    });
    const receipt = createAuthRecoveryRotationReviewReceipt({
      receiptId: '1234567890abcdef12345678',
      reason: 'SUSPECTED_KEY_COMPROMISE',
      operator: 'Named Charity Director',
      caseReference: 'INC-2026-0042',
      identities: authRecoveryIdentityHashes(
        readyInstallation,
        readFileSync(join(root, '.env.personal-server'), 'utf8'),
      ),
      dryRunEvidence: authRecoveryDryRunEvidence(),
      now: new Date(NOW.getTime() - (5 * 60 * 1000)),
    });
    writeFileSync(
      join(root, 'pending-auth-recovery-rotation.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    assert.throws(
      () => runAt(root, [
        'rotate-auth-recovery-secret',
        '--reason=SUSPECTED_KEY_COMPROMISE',
        '--operator=Named Charity Director',
        '--case-reference=INC-2026-0042',
        `--confirm=${receipt.confirmation}`,
      ], authRecoveryRotationExecutor({ failRunningServicesCall: 2 }), []),
      /simulated backup-start interruption/u,
    );
    const interrupted = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    assert.equal(interrupted.phase, 'auth-recovery-rotating');
    assert.equal(interrupted.authRecoveryRotation.stage, 'backup-pending');
    assert.deepEqual(interrupted.authRecoveryRotation.writersBefore, ['caddy', 'web', 'api']);
    assert.equal(interrupted.authRecoveryRotation.databaseWasRunning, true);
    assert.equal(interrupted.authRecoveryRotation.backupReferenceSha256, null);
    assert.equal(interrupted.authRecoveryRotation.backupManifestSha256, null);
  });
});

test('interrupted state-first backup checkpoint reconstructs its receipt and remains resumable', () => {
  withWorkspace((root) => {
    const fixture = createInterruptedAuthRecoveryRotationFixture(root);
    const executor = authRecoveryRotationExecutor({ failDryRun: true });
    assert.throws(
      () => runAt(root, [
        'rotate-auth-recovery-secret',
        '--reason=SUSPECTED_KEY_COMPROMISE',
        '--operator=Named Charity Director',
        '--case-reference=INC-2026-0042',
        `--confirm=${fixture.receipt.confirmation}`,
      ], executor, []),
      /simulated post-resume review failure/u,
    );
    const installation = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    const receipt = JSON.parse(readFileSync(join(root, 'pending-auth-recovery-rotation.json'), 'utf8'));
    assert.equal(installation.phase, 'auth-recovery-rotating');
    assert.equal(receipt.phase, 'backup-complete');
    assert.equal(receipt.backup.referenceSha256, fixture.operation.backupReferenceSha256);
    assert.equal(receipt.backup.manifestSha256, fixture.operation.backupManifestSha256);
    assert.match(commandText(executor.calls), /stop caddy web api.*up -d --no-build --wait.*db/su);
    assert.equal(existsSync(join(root, 'pending-auth-recovery-secret.hex')), false);
  });
});

test('expired unstarted rotation remains ready and permits a fresh review', () => {
  withWorkspace((root) => {
    const installation = writeReadyInstallationState(root, {
      installationMode: 'fresh-install',
      origin: validConfig().origin,
      port: Number(validConfig().port),
    });
    const expired = createAuthRecoveryRotationReviewReceipt({
      receiptId: '1234567890abcdef12345678',
      reason: 'SUSPECTED_KEY_COMPROMISE',
      operator: 'Named Charity Director',
      caseReference: 'INC-2026-0042',
      identities: authRecoveryIdentityHashes(
        installation,
        readFileSync(join(root, '.env.personal-server'), 'utf8'),
      ),
      dryRunEvidence: authRecoveryDryRunEvidence(),
      now: new Date(NOW.getTime() - (31 * 60 * 1000)),
    });
    writeFileSync(
      join(root, 'pending-auth-recovery-rotation.json'),
      `${JSON.stringify(expired, null, 2)}\n`,
    );
    assert.throws(
      () => runAt(root, [
        'rotate-auth-recovery-secret',
        '--reason=SUSPECTED_KEY_COMPROMISE',
        '--operator=Named Charity Director',
        '--case-reference=INC-2026-0042',
        `--confirm=${expired.confirmation}`,
      ], authRecoveryRotationExecutor(), []),
      /review expired before backup/u,
    );
    let currentInstallation = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    assert.equal(currentInstallation.phase, 'ready');
    assert.equal(currentInstallation.authRecoveryRotation ?? null, null);
    assert.equal(existsSync(join(root, 'pending-auth-recovery-secret.hex')), false);

    runAt(root, [
      'rotate-auth-recovery-secret',
      '--reason=SUSPECTED_KEY_COMPROMISE',
      '--operator=Named Charity Director',
      '--case-reference=INC-2026-0042',
    ], authRecoveryRotationExecutor({ dryRunEvidenceOutput: authRecoveryDryRunEvidence() }), []);
    currentInstallation = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    const freshReceipt = JSON.parse(readFileSync(join(root, 'pending-auth-recovery-rotation.json'), 'utf8'));
    assert.equal(currentInstallation.phase, 'ready');
    assert.equal(freshReceipt.phase, 'review-ready');
    assert.notEqual(freshReceipt.receiptId, expired.receiptId);
  });
});

test('ready-state availability checkpoint is disclosed and globally reconciled before lifecycle work', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root, {
      lastAuthRecoveryRotation: {
        receiptId: '1234567890abcdef12345678',
        outcome: 'completed',
        writersBefore: ['caddy', 'web', 'api'],
        databaseWasRunning: true,
        availabilityRestoredAt: null,
      },
    });
    const records = ['db', 'api', 'web', 'caddy']
      .map((Service) => JSON.stringify({ Service, State: 'running', Health: 'healthy' }))
      .join('\n');
    const statusOutput = [];
    runAt(root, ['status'], fakeExecutor((call) => (
      call.command.includes('--format')
        ? { status: 0, stdout: `${records}\n`, stderr: '' }
        : null
    )), statusOutput);
    assert.match(statusOutput.join(''), /rotation availability checkpoint: pending/u);

    const executor = fakeExecutor();
    runAt(root, ['stop'], executor, []);
    const state = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    assert.equal(state.phase, 'ready');
    assert.equal(state.lastAuthRecoveryRotation.availabilityRestoredAt, NOW.toISOString());
    const commands = commandText(executor.calls);
    const restore = commands.indexOf('up -d --no-build --no-deps --wait');
    const finalStop = commands.lastIndexOf('stop caddy web api db');
    assert.ok(restore >= 0 && restore < finalStop);
  });
});

test('supported auth recovery lifecycle resumes ambiguous activation through rehearsed safe completion', () => {
  withWorkspace((root) => {
    const installation = writeReadyInstallationState(root, {
      installationMode: 'fresh-install',
      origin: validConfig().origin,
      port: Number(validConfig().port),
    });
    const receipt = createAuthRecoveryRotationReviewReceipt({
      receiptId: '1234567890abcdef12345678',
      reason: 'SUSPECTED_KEY_COMPROMISE',
      operator: 'Named Charity Director',
      caseReference: 'INC-2026-0042',
      identities: authRecoveryIdentityHashes(
        installation,
        readFileSync(join(root, '.env.personal-server'), 'utf8'),
      ),
      dryRunEvidence: authRecoveryDryRunEvidence(),
      now: new Date(NOW.getTime() - (5 * 60 * 1000)),
    });
    writeFileSync(
      join(root, 'pending-auth-recovery-rotation.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    const orchestration = fullAuthRecoveryRotationExecutor();
    const randomBytesImpl = sequentialRandomBytes();
    const args = [
      'rotate-auth-recovery-secret',
      '--reason=SUSPECTED_KEY_COMPROMISE',
      '--operator=Named Charity Director',
      '--case-reference=INC-2026-0042',
      `--confirm=${receipt.confirmation}`,
    ];
    assert.throws(
      () => runAt(root, args, orchestration.executor, [], {}, { randomBytesImpl }),
      /simulated ambiguous activation transport failure/u,
    );
    let interruptedState = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    let interruptedReceipt = JSON.parse(readFileSync(join(root, 'pending-auth-recovery-rotation.json'), 'utf8'));
    assert.equal(interruptedState.phase, 'auth-recovery-rotating');
    assert.equal(interruptedState.authRecoveryRotation.stage, 'backup-complete');
    assert.equal(interruptedReceipt.phase, 'activating');
    assert.equal(existsSync(join(root, 'pending-auth-recovery-secret.hex')), true);

    const output = [];
    assert.throws(
      () => runAt(root, args, orchestration.executor, output, {}, { randomBytesImpl }),
      /simulated post-activation backup power-loss boundary/u,
    );
    interruptedState = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    interruptedReceipt = JSON.parse(readFileSync(join(root, 'pending-auth-recovery-rotation.json'), 'utf8'));
    assert.equal(interruptedState.phase, 'auth-recovery-rotating');
    assert.equal(interruptedReceipt.phase, 'activated');
    assert.equal(interruptedState.authRecoveryRotation.postActivationRecovery.stage, 'backup-pending');
    assert.equal(orchestration.postActivationBackupFailures, 1);
    const rehearsalToken = interruptedState.authRecoveryRotation.postActivationRecovery.rehearsalToken;
    assert.match(rehearsalToken, /^[a-f0-9]{12}$/u);

    runAt(root, args, orchestration.executor, output, {}, { randomBytesImpl });
    const completedState = JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8'));
    const completedReceipt = JSON.parse(readFileSync(join(root, 'pending-auth-recovery-rotation.json'), 'utf8'));
    assert.equal(completedState.phase, 'ready');
    assert.equal(completedState.authRecoveryRotation, null);
    assert.equal(completedState.lastAuthRecoveryRotation.outcome, 'completed');
    assert.equal(completedState.lastAuthRecoveryRotation.availabilityRestoredAt, NOW.toISOString());
    assert.match(completedState.lastAuthRecoveryRotation.postActivationRecovery.recoverySetId, /^personal-server-/u);
    assert.equal(completedReceipt.phase, 'completed');
    assert.equal(existsSync(join(root, 'pending-auth-recovery-secret.hex')), false);
    assert.equal(orchestration.activationAttempts, 1);
    assert.match(output.join(''), /passed an isolated rehearsal/u);
    const commands = commandText(orchestration.executor.calls);
    const staleCleanup = commands.indexOf(`name=charitypilot-personal-rehearsal-${rehearsalToken}-caddy`);
    const rehearsalCreate = commands.indexOf(
      `network create --internal --label charitypilot.personal-rehearsal=${rehearsalToken} charitypilot-personal-rehearsal-${rehearsalToken}`,
    );
    assert.ok(staleCleanup >= 0 && staleCleanup < rehearsalCreate);

    const archive = JSON.parse(readFileSync(completedState.lastAuthRecoveryRotation.archivePath, 'utf8'));
    assert.equal(
      archive.postActivationRecovery.recoverySetId,
      completedState.lastAuthRecoveryRotation.postActivationRecovery.recoverySetId,
    );
    assert.equal(
      archive.postActivationRecovery.manifestSha256,
      completedState.lastAuthRecoveryRotation.postActivationRecovery.manifestSha256,
    );
    const replacementSecret = parsePersonalServerEnv(
      readFileSync(join(root, '.env.personal-server'), 'utf8'),
    ).AUTH_RECOVERY_SECRET;
    assert.doesNotMatch(commands, new RegExp(replacementSecret, 'u'));
    assert.doesNotMatch(output.join(''), new RegExp(replacementSecret, 'u'));
  });
});

test('cutover recovery stops every writer before restoring a tag or destructive data', () => {
  const originalState = {
    format: 'charitypilot-personal-server-install-state/v1',
    phase: 'ready',
    activeImageTag: 'personal-v1.0.0',
    previousRelease: { imageTag: 'personal-v0.9.0' },
  };
  const restoredStates = [];
  const calls = [];
  executePersonalServerCutoverRecovery({
    stopWriters: () => calls.push('stop-writers'),
    restoreImageTag: () => calls.push('restore-image-tag'),
    restoreData: () => calls.push('restore-data'),
    startRuntime: () => calls.push('start-runtime'),
    restoreInstallationState: () => {
      calls.push('restore-install-state');
      restoredStates.push(structuredClone(originalState));
    },
  });
  assert.deepEqual(calls, [
    'stop-writers',
    'restore-image-tag',
    'restore-data',
    'start-runtime',
    'restore-install-state',
  ]);
  assert.deepEqual(restoredStates, [originalState]);
});

test('disposable rehearsal cleanup attempts every exact operation and aggregates all failures', () => {
  const calls = [];
  assert.throws(
    () => executePersonalServerCleanup([
      () => {
        calls.push('caddy');
        throw new Error('caddy removal failed');
      },
      () => calls.push('web'),
      () => {
        calls.push('network');
        throw new Error('network removal failed');
      },
    ]),
    (error) => {
      assert.match(error.message, /caddy removal failed/u);
      assert.match(error.message, /network removal failed/u);
      return true;
    },
  );
  assert.deepEqual(calls, ['caddy', 'web', 'network']);
});

test('first official release adoption requires unchanged canonical origin/master and target ancestry', () => {
  const base = {
    installationSource: {
      kind: 'git',
      revision: 'a'.repeat(40),
      branch: 'master',
      canonicalRemote: true,
    },
    activeImageTag: 'local',
    currentImageTag: 'local',
    workingTree: '',
    revision: 'a'.repeat(40),
    branch: 'master',
    remote: 'https://github.com/jasperfordesq-ai/charity-governance.git',
    originMasterRevision: 'a'.repeat(40),
    targetCommitSha: 'b'.repeat(40),
    targetCommitPresent: true,
    targetDescendsFromCurrent: true,
  };
  assert.equal(validateCleanGitReleaseAdoption(base), true);
  assert.equal(validateCleanGitReleaseAdoption({ ...base, targetCommitSha: base.revision }), true);
  for (const mutation of [
    { workingTree: ' M changed.txt' },
    { revision: 'c'.repeat(40) },
    { branch: 'feature' },
    { remote: 'https://github.com/example/fork.git' },
    { originMasterRevision: 'c'.repeat(40) },
    { targetCommitPresent: false },
    { targetDescendsFromCurrent: false },
    { activeImageTag: 'personal-v0.9.0' },
  ]) {
    assert.throws(() => validateCleanGitReleaseAdoption({ ...base, ...mutation }));
  }
  assert.throws(() => validateCleanGitReleaseAdoption({
    ...base,
    installationSource: { ...base.installationSource, branch: 'feature' },
  }));
});

test('cutover recovery fails closed before destructive recovery when writers cannot stop', () => {
  const calls = [];
  assert.throws(
    () => executePersonalServerCutoverRecovery({
      stopWriters: () => {
        calls.push('stop-writers');
        throw new Error('writer stop failed');
      },
      restoreImageTag: () => calls.push('restore-image-tag'),
      restoreData: () => calls.push('restore-data'),
      startRuntime: () => calls.push('start-runtime'),
      restoreInstallationState: () => calls.push('restore-install-state'),
    }),
    /writer stop failed/u,
  );
  assert.deepEqual(calls, ['stop-writers']);
});

test('cutover recovery does not claim the exact install state before runtime recovery succeeds', () => {
  const calls = [];
  assert.throws(
    () => executePersonalServerCutoverRecovery({
      stopWriters: () => calls.push('stop-writers'),
      restoreImageTag: () => calls.push('restore-image-tag'),
      restoreData: () => calls.push('restore-data'),
      startRuntime: () => {
        calls.push('start-runtime');
        throw new Error('runtime start failed');
      },
      restoreInstallationState: () => calls.push('restore-install-state'),
    }),
    /runtime start failed/u,
  );
  assert.deepEqual(calls, ['stop-writers', 'restore-image-tag', 'restore-data', 'start-runtime']);
});

test('restore cutover persists restoring before mutation and migrates only after raw fingerprint proof', () => {
  const calls = [];
  executePersonalServerRestoreCutover({
    persistRestoring: () => calls.push('persist-restoring'),
    stopWriters: () => calls.push('stop-writers'),
    restoreSelectedDatabase: () => calls.push('restore-database'),
    proveSelectedDatabaseFingerprint: () => calls.push('prove-raw-fingerprint'),
    migrateCurrentSchema: () => calls.push('migrate-current-schema'),
    restoreSelectedDocuments: () => calls.push('restore-documents'),
    startSelectedRuntime: () => calls.push('start-runtime'),
    verifySelectedApplication: () => calls.push('verify-application'),
    persistReady: () => calls.push('persist-ready'),
  });
  assert.deepEqual(calls, [
    'persist-restoring',
    'stop-writers',
    'restore-database',
    'prove-raw-fingerprint',
    'migrate-current-schema',
    'restore-documents',
    'start-runtime',
    'verify-application',
    'persist-ready',
  ]);
});

test('restore cutover failure never advances to ready or later destructive stages', () => {
  const calls = [];
  assert.throws(
    () => executePersonalServerRestoreCutover({
      persistRestoring: () => calls.push('persist-restoring'),
      stopWriters: () => calls.push('stop-writers'),
      restoreSelectedDatabase: () => calls.push('restore-database'),
      proveSelectedDatabaseFingerprint: () => {
        calls.push('prove-raw-fingerprint');
        throw new Error('fingerprint mismatch');
      },
      migrateCurrentSchema: () => calls.push('migrate-current-schema'),
      restoreSelectedDocuments: () => calls.push('restore-documents'),
      startSelectedRuntime: () => calls.push('start-runtime'),
      verifySelectedApplication: () => calls.push('verify-application'),
      persistReady: () => calls.push('persist-ready'),
    }),
    /fingerprint mismatch/u,
  );
  assert.deepEqual(calls, [
    'persist-restoring',
    'stop-writers',
    'restore-database',
    'prove-raw-fingerprint',
  ]);
});

test('decommission finalization rehearses the exact final set before closing access or deleting resources', () => {
  const calls = [];
  const verified = { recoverySetId: 'final' };
  assert.equal(executePersonalServerDecommissionFinalization({
    stopWriters: () => calls.push('stop-writers'),
    verifyFinalRecovery: () => {
      calls.push('verify-final-recovery');
      return verified;
    },
    rehearseFinalRecovery: (value) => {
      assert.equal(value, verified);
      calls.push('rehearse-final-recovery');
    },
    closePrivateAccess: () => calls.push('close-private-access'),
    removeRuntime: () => calls.push('remove-runtime'),
    removeDatabaseVolume: () => calls.push('remove-database-volume'),
    removeDocumentVolume: () => calls.push('remove-document-volume'),
    assertResourcesAbsent: () => calls.push('prove-resources-absent'),
    persistDecommissioned: () => calls.push('persist-decommissioned'),
  }), verified);
  assert.deepEqual(calls, [
    'stop-writers',
    'verify-final-recovery',
    'rehearse-final-recovery',
    'close-private-access',
    'remove-runtime',
    'remove-database-volume',
    'remove-document-volume',
    'prove-resources-absent',
    'persist-decommissioned',
  ]);
});

test('decommission verification failure leaves private access and every resource untouched', () => {
  const calls = [];
  assert.throws(
    () => executePersonalServerDecommissionFinalization({
      stopWriters: () => calls.push('stop-writers'),
      verifyFinalRecovery: () => {
        calls.push('verify-final-recovery');
        throw new Error('final verification failed');
      },
      rehearseFinalRecovery: () => calls.push('rehearse-final-recovery'),
      closePrivateAccess: () => calls.push('close-private-access'),
      removeRuntime: () => calls.push('remove-runtime'),
      removeDatabaseVolume: () => calls.push('remove-database-volume'),
      removeDocumentVolume: () => calls.push('remove-document-volume'),
      assertResourcesAbsent: () => calls.push('prove-resources-absent'),
      persistDecommissioned: () => calls.push('persist-decommissioned'),
    }),
    /final verification failed/u,
  );
  assert.deepEqual(calls, ['stop-writers', 'verify-final-recovery']);
});

test('decommission deletion failure never records a completed decommission', () => {
  const calls = [];
  assert.throws(
    () => executePersonalServerDecommissionFinalization({
      stopWriters: () => calls.push('stop-writers'),
      verifyFinalRecovery: () => {
        calls.push('verify-final-recovery');
        return {};
      },
      rehearseFinalRecovery: () => calls.push('rehearse-final-recovery'),
      closePrivateAccess: () => calls.push('close-private-access'),
      removeRuntime: () => calls.push('remove-runtime'),
      removeDatabaseVolume: () => {
        calls.push('remove-database-volume');
        throw new Error('volume removal failed');
      },
      removeDocumentVolume: () => calls.push('remove-document-volume'),
      assertResourcesAbsent: () => calls.push('prove-resources-absent'),
      persistDecommissioned: () => calls.push('persist-decommissioned'),
    }),
    /volume removal failed/u,
  );
  assert.deepEqual(calls, [
    'stop-writers',
    'verify-final-recovery',
    'rehearse-final-recovery',
    'close-private-access',
    'remove-runtime',
    'remove-database-volume',
  ]);
});

test('guarded decommission deletion tolerates an already-absent exact volume', () => {
  const executor = fakeExecutor(() => ({ status: 0, stdout: '', stderr: '' }));
  removePersonalVolumeIfPresent(
    'charitypilot-personal-server-db',
    'personal-server-db',
    {
      dryRun: false,
      repoRoot: 'C:\\protected-source',
      hostPlatform: 'win32',
      processEnv: {},
      spawnSyncImpl: executor.spawn,
      writeOutput: () => {},
      commandTimeoutMs: 30_000,
    },
  );
  assert.deepEqual(executor.calls.map((call) => call.command), [[
    'docker',
    'volume',
    'ls',
    '--filter',
    'name=charitypilot-personal-server-db',
    '--format',
    '{{.Name}}',
  ]]);
});

test('Tailscale closure accepts only an exact empty Serve configuration', () => {
  assert.equal(validateTailscaleServeClosed({}), true);
  assert.equal(validateTailscaleServeClosed({
    TCP: {},
    Web: {},
    AllowFunnel: {},
    Foreground: {},
    Services: {},
  }), true);
  assert.throws(
    () => validateTailscaleServeClosed({ TCP: { 443: { HTTPS: true } } }),
    /not closed/u,
  );
  assert.throws(
    () => validateTailscaleServeClosed({ Unexpected: {} }),
    /unexpected configuration/u,
  );
});

test('rollback application binding requires the authenticated source and exact retained image IDs', () => {
  const tag = 'personal-v1.2.3';
  const commitSha = '1'.repeat(40);
  const source = { kind: 'release-bundle', releaseIdentity: { tag, commitSha } };
  const images = {
    api: { name: `charitypilot-personal-server-api:${tag}`, id: `sha256:${'a'.repeat(64)}` },
    migrations: { name: `charitypilot-personal-server-migrations:${tag}`, id: `sha256:${'b'.repeat(64)}` },
    web: { name: `charitypilot-personal-server-web:${tag}`, id: `sha256:${'c'.repeat(64)}` },
  };
  const application = {
    format: 'charitypilot-personal-server-application-identity/v1',
    imageTag: tag,
    source: { kind: 'release-bundle', tag, commitSha },
    images,
  };
  assert.equal(validateRecoveryApplicationBinding(application, tag, source, structuredClone(images)), true);
  assert.throws(
    () => validateRecoveryApplicationBinding(
      { ...application, source: { ...application.source, commitSha: '2'.repeat(40) } },
      tag,
      source,
      images,
    ),
    /source identity/u,
  );
  assert.throws(
    () => validateRecoveryApplicationBinding(application, tag, source, {
      ...images,
      web: { ...images.web, id: `sha256:${'d'.repeat(64)}` },
    }),
    /Retained web image/u,
  );
});

test('completed update receipt archival is collision-safe and preserves prior evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-update-receipt-'));
  try {
    const pendingPath = join(root, 'pending-update.json');
    const attemptId = 'ab'.repeat(12);
    const tag = 'personal-v1.2.3';
    const existingPath = join(root, `completed-update-${tag}-${attemptId}.json`);
    writeFileSync(pendingPath, '{"pending":true}\n');
    writeFileSync(existingPath, '{"prior":true}\n');
    const receipt = {
      path: pendingPath,
      identity: { tag },
      value: { attemptId },
    };
    const archivedPath = archiveUpdateReceipt(receipt, 'completed', {
      dryRun: false,
      randomBytesImpl: deterministicRandomBytes,
      writeOutput: () => {},
    });
    assert.notEqual(archivedPath, existingPath);
    assert.match(archivedPath, /-abababab\.json$/u);
    assert.equal(existsSync(pendingPath), false);
    assert.equal(readFileSync(existingPath, 'utf8'), '{"prior":true}\n');
    assert.equal(readFileSync(archivedPath, 'utf8'), '{"pending":true}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init dry-run plans build, migration, initializer, and start without writing or revealing a password', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor();
    const output = [];
    runAt(root, [
      'init',
      '--owner-email=owner@example.org',
      '--owner-name=Example Owner',
      '--organisation-name=Example Charity',
      '--dry-run',
    ], executor, output);

    const text = output.join('');
    assert.equal(executor.calls.length, 0);
    assert.equal(existsSync(join(root, '.env.personal-server')), false);
    assert.match(text, /pull db document-storage-init caddy/);
    assert.match(text, /caddy caddy validate --config \/etc\/caddy\/Caddyfile/);
    assert.match(text, /--profile personal-init build --builder default migrate/);
    assert.match(text, /--profile personal-init build --builder default api/);
    assert.match(text, /--profile personal-init build --builder default web/);
    assert.match(text, /--profile maintenance run --rm migrate/);
    assert.match(text, /PERSONAL_SERVER_OWNER_PASSWORD personal-init/);
    assert.match(text, /up -d --no-build --wait/);
    assert.doesNotMatch(text, /Cp!7|q6urq6ur/);
  }, { withEnv: false });
});

test('successful init stores no owner password and prints it only after every child succeeds', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor();
    const output = [];
    runAt(root, [
      'init',
      '--owner-email=owner@example.org',
      '--owner-name=Example Owner',
      '--organisation-name=Example Charity',
    ], executor, output);

    const envText = readFileSync(join(root, '.env.personal-server'), 'utf8');
    const text = output.join('');
    const match = /Generated Owner password \(shown once\): (\S+)/u.exec(text);
    assert.ok(match);
    assert.equal(text.split(match[1]).length - 1, 1);
    assert.equal(envText.includes(match[1]), false);
    assert.doesNotMatch(envText, /^PERSONAL_SERVER_OWNER_PASSWORD=/m);

    const initializer = executor.calls.find((call) => call.command.at(-1) === 'personal-init');
    assert.ok(initializer);
    assert.equal(initializer.command.includes(match[1]), false);
    assert.equal(initializer.options.env.PERSONAL_SERVER_OWNER_PASSWORD, match[1]);

    const loginVerification = executor.calls.find((call) => call.command.includes('--input-type=module'));
    assert.ok(loginVerification);
    assert.equal(loginVerification.command.includes(match[1]), false);
    assert.equal(loginVerification.options.env.PERSONAL_SERVER_OWNER_PASSWORD, match[1]);
    assert.equal(loginVerification.options.env.PERSONAL_SERVER_OWNER_EMAIL, 'owner@example.org');
    const verificationSource = loginVerification.command.at(-1);
    assert.ok(verificationSource.indexOf("base + '/login'") < verificationSource.indexOf("base + '/api/v1/auth/login'"));
    assert.match(verificationSource, /deadline = Date\.now\(\) \+ 30000/u);
    assert.match(verificationSource, /\[502, 503, 504\]\.includes\(readiness\.status\)/u);
    assert.equal((verificationSource.match(/\/api\/v1\/auth\/login/gu) ?? []).length, 1);

    const commands = commandText(executor.calls);
    assert.ok(commands.indexOf('--profile personal-init build --builder default migrate') < commands.indexOf('--profile personal-init build --builder default api'));
    assert.ok(commands.indexOf('--profile personal-init build --builder default api') < commands.indexOf('--profile personal-init build --builder default web'));
    assert.ok(commands.indexOf('--profile personal-init build --builder default web') < commands.indexOf('--profile maintenance run --rm migrate'));
    assert.ok(commands.indexOf('--profile maintenance run --rm migrate') < commands.indexOf('PERSONAL_SERVER_OWNER_PASSWORD personal-init'));
    assert.ok(commands.indexOf('PERSONAL_SERVER_OWNER_PASSWORD personal-init') < commands.lastIndexOf('up -d --no-build'));
  }, { withEnv: false });
});

test('post-initializer runtime failure still reveals the only usable Owner credential', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => (
      call.command.includes('up') ? { status: 1, stdout: '', stderr: 'failed' } : null
    ));
    const output = [];
    assert.throws(() => runAt(root, [
      'init',
      '--owner-email=owner@example.org',
      '--owner-name=Example Owner',
      '--organisation-name=Example Charity',
    ], executor, output), /failed/);
    assert.match(output.join(''), /Owner workspace was created/);
    assert.match(output.join(''), /Generated Owner password \(shown once\):/);
    assert.doesNotMatch(readFileSync(join(root, '.env.personal-server'), 'utf8'), /^PERSONAL_SERVER_OWNER_PASSWORD=/m);
  }, { withEnv: false });
});

test('failure before the initializer commits never reveals an unused Owner credential', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => (
      call.command.includes('build') ? { status: 1, stdout: '', stderr: 'failed' } : null
    ));
    const output = [];
    assert.throws(() => runAt(root, [
      'init',
      '--owner-email=owner@example.org',
      '--owner-name=Example Owner',
      '--organisation-name=Example Charity',
    ], executor, output), /failed/);
    assert.doesNotMatch(output.join(''), /Generated Owner password|Cp!7/);
  }, { withEnv: false });
});

test('failed installation resume initializes an empty transactional database and marks backup pending', () => {
  withWorkspace((root) => {
    const releaseIdentity = {
      format: 'charitypilot-personal-server-bundle/v1',
      profile: 'personal-server',
      tag: 'personal-v1.0.0',
      commitSha: 'a'.repeat(40),
    };
    writeFileSync(join(root, 'personal-server-release.json'), JSON.stringify(releaseIdentity));
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'failed',
      sourceRoot: root,
      source: { releaseIdentity },
    }));
    writeFileSync(join(root, 'recovery-key.hex'), `${'1'.repeat(64)}\n`);
    const executor = fakeExecutor((call) => {
      if (call.command.join(' ').includes('charitypilot-personal-server-initialization-state/v1')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            format: 'charitypilot-personal-server-initialization-state/v1',
            organisationCount: 0,
            userCount: 0,
            subscriptionCount: 0,
            owner: null,
          }),
          stderr: '',
        };
      }
      return null;
    });
    const output = [];
    runAt(root, ['resume-init'], executor, output);
    assert.equal(JSON.parse(readFileSync(join(root, 'install-state.json'), 'utf8')).phase, 'initialized-backup-pending');
    assert.match(output.join(''), /previously absent Owner workspace/u);
    assert.equal((output.join('').match(/replacement Owner password \(shown once\)/gu) ?? []).length, 1);
  });
});

test('failed installation resume resets exactly one committed Owner and refuses to rerun initializer', () => {
  withWorkspace((root) => {
    const releaseIdentity = {
      format: 'charitypilot-personal-server-bundle/v1',
      profile: 'personal-server',
      tag: 'personal-v1.0.0',
      commitSha: 'a'.repeat(40),
    };
    writeFileSync(join(root, 'personal-server-release.json'), JSON.stringify(releaseIdentity));
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'failed',
      sourceRoot: root,
      source: { releaseIdentity },
    }));
    const executor = fakeExecutor((call) => {
      const command = call.command.join(' ');
      if (command.includes('charitypilot-personal-server-initialization-state/v1')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            format: 'charitypilot-personal-server-initialization-state/v1',
            organisationCount: 1,
            userCount: 1,
            subscriptionCount: 1,
            owner: { email: 'owner@example.org', role: 'OWNER', emailVerified: true },
          }),
          stderr: '',
        };
      }
      if (call.command.at(-1) === 'reset-password') {
        return { status: 0, stdout: JSON.stringify({ passwordReset: true, sessionsRevoked: 2 }), stderr: '' };
      }
      return null;
    });
    const output = [];
    runAt(root, ['resume-init'], executor, output);
    assert.equal(executor.calls.some(({ command }) => command.at(-1) === 'personal-init'), false);
    assert.match(output.join(''), /one exact existing Owner workspace/u);
    assert.match(output.join(''), /replacement Owner password \(shown once\)/u);
  });
});

test('failed installation resume is bound to the exact protected source root', () => {
  withWorkspace((root) => {
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'failed',
      sourceRoot: join(root, 'different-source'),
      source: {
        canonicalRemote: true,
        revision: 'a'.repeat(40),
      },
    }));
    assert.throws(
      () => runAt(root, ['resume-init'], fakeExecutor(), []),
      /source root does not match/u,
    );
  });
});

test('init reuses but never overwrites an existing environment file', () => {
  withWorkspace((root) => {
    const before = readFileSync(join(root, '.env.personal-server'), 'utf8');
    const executor = fakeExecutor();
    runAt(root, ['init'], executor, []);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), before);
  });
});

test('an explicit protected state environment stays outside the source checkout', () => {
  withWorkspace((root) => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'charitypilot-personal-state-'));
    const envPath = join(stateRoot, '.env.personal-server');
    try {
      const executor = fakeExecutor();
      runAt(root, [
        'init',
        '--owner-email=owner@example.org',
        '--owner-name=Example Owner',
        '--organisation-name=Example Charity',
      ], executor, [], { CHARITYPILOT_PERSONAL_SERVER_ENV_FILE: envPath });
      assert.equal(existsSync(envPath), true);
      assert.equal(existsSync(join(root, '.env.personal-server')), false);
      assert.match(commandText(executor.calls), new RegExp(envPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, { withEnv: false });
});

test('protected location pointer makes a custom state root discoverable from stale parent shells', () => {
  withWorkspace((root) => {
    const localAppData = mkdtempSync(join(tmpdir(), 'charitypilot-local-appdata-'));
    const stateRoot = mkdtempSync(join(tmpdir(), 'charitypilot-custom-state-'));
    const pointerDirectory = join(localAppData, 'CharityPilot');
    const environmentPath = join(stateRoot, '.env.personal-server');
    try {
      mkdirSync(pointerDirectory, { recursive: true });
      writeFileSync(join(pointerDirectory, 'personal-server-location.json'), JSON.stringify({
        format: 'charitypilot-personal-server-location/v1',
        stateRoot,
        environmentPath,
      }));
      assert.equal(environmentFilePath({ repoRoot: root, processEnv: { LOCALAPPDATA: localAppData } }), environmentPath);
      const explicit = join(stateRoot, 'explicit.env');
      assert.equal(environmentFilePath({
        repoRoot: root,
        processEnv: { LOCALAPPDATA: localAppData, CHARITYPILOT_PERSONAL_SERVER_ENV_FILE: explicit },
      }), explicit);
      writeFileSync(join(pointerDirectory, 'personal-server-location.json'), '{bad json');
      assert.throws(
        () => environmentFilePath({ repoRoot: root, processEnv: { LOCALAPPDATA: localAppData } }),
        /not valid JSON/u,
      );
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

test('routine start cannot build, migrate, or seed and stop cannot delete volumes', () => {
  withWorkspace((root) => {
    const startExecutor = fakeExecutor();
    runAt(root, ['start'], startExecutor, [], {
      COMPOSE_PROFILES: 'maintenance,personal-init',
      COMPOSE_PROJECT_NAME: 'hostile-project',
      compose_file: 'hostile-compose.yml',
    });
    const startCalls = startExecutor.calls.map((call) => call.command);
    assert.equal(startCalls.length, 4);
    assert.deepEqual(startCalls[0].slice(-2), ['config', '--quiet']);
    assert.deepEqual(startCalls[1].slice(-1), ['db']);
    assert.ok(startCalls[1].includes('--no-build'));
    assert.deepEqual(
      startCalls[2].slice(-6),
      ['-T', 'migrate', 'migrate', 'status', '--schema', 'prisma/schema.prisma'],
    );
    assert.ok(startCalls[2].includes('--no-deps'));
    assert.ok(startCalls[3].includes('--no-build'));
    assert.equal(startCalls.some((call) => call.includes('deploy')), false);
    assert.equal(startCalls.some((call) => call.includes('personal-init')), false);
    assert.equal(startCalls.some((call) => call.includes('seed')), false);
    for (const call of startExecutor.calls) {
      if (call.command[0] !== 'docker' || call.command[1] !== 'compose') continue;
      assert.deepEqual(call.command.slice(0, 5), [
        'docker', 'compose', '--project-name', 'charitypilot-personal-server', '--env-file',
      ]);
      assert.equal(Object.keys(call.options.env).some((name) => name.toUpperCase().startsWith('COMPOSE_')), false);
      assert.equal(call.options.env.DOCKER_HOST, 'npipe:////./pipe/dockerDesktopLinuxEngine');
      assert.equal(Object.hasOwn(call.options.env, 'DOCKER_CONTEXT'), false);
      assert.equal(Object.keys(call.options.env).some((name) => /^(?:BUILDKIT_|BUILDX_)/iu.test(name)), false);
    }

    const stopExecutor = fakeExecutor();
    runAt(root, ['stop'], stopExecutor, []);
    const stopCommand = stopExecutor.calls[0].command;
    assert.ok(stopCommand.includes('stop'));
    assert.equal(stopCommand.includes('down'), false);
    assert.equal(stopCommand.includes('-v'), false);
    assert.equal(stopCommand.includes('--volumes'), false);
  });
});

test('routine start fails closed on incompatible migration history before application runtime starts', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => (
      call.command.includes('status')
        ? { status: 1, stdout: '', stderr: 'Database schema is not up to date' }
        : null
    ));
    assert.throws(
      () => runAt(root, ['start'], executor, []),
      /migrate status.*failed/u,
    );
    const commands = commandText(executor.calls);
    assert.match(commands, /up -d --no-build --wait --wait-timeout 180 db/u);
    assert.match(commands, /migrate migrate status --schema prisma\/schema\.prisma/u);
    assert.equal(executor.calls.some((call) => (
      call.command.includes('up') && !call.command.includes('db')
    )), false);
    assert.equal(executor.calls.some((call) => call.command.includes('deploy')), false);
  });
});

test('exclusive operation lock blocks concurrent work and safely preserves stale-lock evidence', () => {
  withWorkspace((root) => {
    const lockPath = join(root, 'personal-server-operation.lock');
    const active = {
      format: 'charitypilot-personal-server-operation-lock/v1',
      operationId: 'a'.repeat(24),
      pid: process.pid,
      hostname: hostname(),
      command: 'backup',
      startedAt: NOW.toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(active));
    const blockedExecutor = fakeExecutor();
    assert.throws(
      () => runAt(root, ['stop'], blockedExecutor, []),
      /operation backup is already locked/u,
    );
    assert.equal(blockedExecutor.calls.length, 0);

    const stale = {
      ...active,
      operationId: 'b'.repeat(24),
      pid: 2_000_000_000,
      command: 'update',
      startedAt: new Date(NOW.getTime() - (60 * 60 * 1000)).toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(stale));
    const executor = fakeExecutor();
    runAt(root, ['stop'], executor, []);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(join(root, `operation-lock-stale-${stale.operationId}.json`)), true);
    assert.equal(executor.calls.length, 1);
  });
});

test('status reports only allowlisted service health and the configured nonsecret origin', () => {
  withWorkspace((root) => {
    const records = ['db', 'api', 'web', 'caddy']
      .map((Service) => JSON.stringify({ Service, State: 'running', Health: 'healthy' }))
      .join('\n');
    const executor = fakeExecutor((call) => (
      call.command.includes('--format') ? { status: 0, stdout: `${records}\n`, stderr: '' } : null
    ));
    const output = [];
    runAt(root, ['status'], executor, output);
    const text = output.join('');
    for (const service of ['db', 'api', 'web', 'caddy']) {
      assert.match(text, new RegExp(`${service}: state=running health=healthy`, 'u'));
    }
    assert.match(text, /origin: http:\/\/localhost:8080/u);
    assert.match(text, /latest completed recovery set in default root: none found/u);
    assert.doesNotMatch(text, /J{32}|R{32}|a{64}/u);
  });
});

test('backup dry-run shows quiesce, database verification, document copy, and verified restart order', () => {
  withWorkspace((root) => {
    const output = [];
    const executor = fakeExecutor();
    runAt(root, ['backup', '--dry-run'], executor, output);
    const text = output.join('');
    assert.equal(executor.calls.length, 0);
    assert.ok(text.indexOf('stop caddy web api') < text.indexOf('postgres-backup.mjs source-identity'));
    assert.ok(text.indexOf('postgres-backup.mjs source-identity') < text.indexOf('postgres-backup.mjs prove-restore'));
    assert.equal((text.match(/--source-container-id=<db-container-id>/gu) ?? []).length, 2);
    assert.doesNotMatch(text, /postgres-backup\.mjs (?:source-identity|prove-restore).*--docker-network=/u);
    assert.ok(text.indexOf('prove-restore') < text.indexOf(`volume inspect charitypilot-personal-server-documents`));
    assert.ok(text.indexOf('volume inspect') < text.indexOf('documents.tar'));
    assert.ok(text.indexOf('documents.tar') < text.lastIndexOf('up -d --no-build --wait'));
    assert.doesNotMatch(text, /J{32}|R{32}|a{64}/u);
    assert.equal(existsSync(join(root, '.charitypilot-backups')), false);
  });
});

test('rendered personal database proof URL passes the real helper only with one exact source container ID', async () => {
  const config = validConfig();
  const databaseUrl = `postgresql://${config.postgresUser}:${config.postgresPassword}` +
    `@127.0.0.1:5432/${config.postgresDatabase}`;
  const helperEnvironment = Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  }).filter(([, value]) => typeof value === 'string' && value.length > 0));
  const accepted = await runPostgresBackupFromArgs([
    'source-identity',
    `--database-url=${databaseUrl}`,
    `--source-container-id=${'d'.repeat(64)}`,
    '--json',
    '--dry-run',
  ], helperEnvironment);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, new RegExp(`--network container:${'d'.repeat(64)}`, 'u'));
  assert.doesNotMatch(accepted.stdout + accepted.stderr, new RegExp(config.postgresPassword, 'u'));

  const rejected = await runPostgresBackupFromArgs([
    'source-identity',
    `--database-url=${databaseUrl}`,
    '--json',
    '--dry-run',
  ], helperEnvironment);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Loopback proof\/source URLs must use the exact disposable database contract/u);
});

test('backup failure restores previously running services and removes incomplete recovery data', () => {
  withWorkspace((root) => {
    const backupRoot = join(root, '.charitypilot-backups', 'personal-server');
    const executor = fakeExecutor((call) => {
      const text = call.command.join(' ');
      if (text.includes('ps --status running --services')) {
        return { status: 0, stdout: 'db\napi\nweb\ncaddy\n', stderr: '' };
      }
      if (text.includes('ps --all -q db')) return { status: 0, stdout: `${'d'.repeat(64)}\n`, stderr: '' };
      if (text.includes('postgres-backup.mjs source-identity')) return { status: 1, stdout: '', stderr: 'identity failed' };
      return null;
    });
    assert.throws(
      () => runAt(root, ['backup', `--output-dir=${backupRoot}`], executor, [], {
        DOCKER_CONTEXT: 'desktop-linux',
        COMPOSE_PROFILES: 'maintenance',
      }),
      /postgres-backup\.mjs source-identity.*identity failed/s,
    );
    const nestedProof = executor.calls.find((call) => call.command.includes('scripts/postgres-backup.mjs'));
    assert.equal(nestedProof.options.env.DOCKER_HOST, 'npipe:////./pipe/dockerDesktopLinuxEngine');
    assert.match(nestedProof.command.join(' '), new RegExp(`--source-container-id=${'d'.repeat(64)}`, 'u'));
    assert.match(nestedProof.options.env.DATABASE_URL, /@127\.0\.0\.1:5432\/charitypilot_personal_server$/u);
    assert.doesNotMatch(nestedProof.options.env.DATABASE_URL, /@db:/u);
    assert.equal(Object.keys(nestedProof.options.env).some((name) => /^(?:DOCKER_CONTEXT|DOCKER_API_VERSION|DOCKER_TLS|DOCKER_CERT_PATH|DOCKER_BUILDKIT|BUILDKIT_|BUILDX_)/iu.test(name)), false);
    const commands = commandText(executor.calls);
    assert.ok(commands.indexOf('stop caddy web api') < commands.lastIndexOf('up -d --no-build --no-deps --wait'));
    assert.deepEqual(readdirSync(backupRoot), []);
  });
});

test('installed backup fails closed instead of downgrading when the recovery key is missing', () => {
  withWorkspace((root) => {
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'ready',
    }));
    assert.throws(
      () => runAt(root, ['backup', '--dry-run'], fakeExecutor(), []),
      /recovery key is missing.*plaintext backup/u,
    );
  });
});

test('update dry-run completes backup verification before build and migration', () => {
  withWorkspace((root) => {
    const targetTag = 'personal-v1.0.0';
    const commitSha = 'c'.repeat(40);
    writeFileSync(join(root, 'personal-server-release.json'), JSON.stringify({
      format: 'charitypilot-personal-server-bundle/v1',
      profile: 'personal-server',
      tag: targetTag,
      commitSha,
      commitTime: NOW.toISOString(),
    }));
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'ready',
      sourceRoot: root,
      source: {
        kind: 'clean-git', revision: 'a'.repeat(40), branch: 'master', canonicalRemote: true,
      },
      activeImageTag: 'local',
    }));
    writeFileSync(join(root, 'recovery-key.hex'), `${'1'.repeat(64)}\n`);
    const receiptPath = join(root, 'pending-update.json');
    writeFileSync(receiptPath, JSON.stringify({
      format: 'charitypilot-personal-server-update-receipt/v1',
      phase: 'prepared',
      createdAt: NOW.toISOString(),
      current: { imageTag: 'local', sourceRoot: root },
      target: {
        sourceRoot: root,
        tag: targetTag,
        commitSha,
        archiveFile: `CharityPilot-${targetTag}.zip`,
        archiveSha256: 'd'.repeat(64),
      },
    }));
    const output = [];
    runAt(root, ['update', `--update-receipt=${receiptPath}`, '--dry-run'], fakeExecutor(), output);
    const text = output.join('');
    const verification = text.indexOf('postgres-backup.mjs prove-restore');
    const build = text.indexOf('--profile personal-init build --builder default migrate');
    const webBuild = text.indexOf('--profile personal-init build --builder default web');
    const migration = text.lastIndexOf('--profile maintenance run --rm migrate');
    assert.ok(verification >= 0 && verification < build && build < webBuild && webBuild < migration);
    assert.match(text, /git rev-parse --verify "?refs\/remotes\/origin\/master\^\{commit\}"?/u);
    assert.match(text, /git cat-file -e "c{40}\^\{commit\}"/u);
    assert.match(text, /git merge-base --is-ancestor a{40} c{40}/u);
    const snapshotStop = text.indexOf('stop caddy web api');
    const tagSwitch = text.indexOf('atomically switch protected image tag local -> personal-v1.0.0');
    assert.ok(snapshotStop >= 0 && snapshotStop < tagSwitch);
    assert.doesNotMatch(text.slice(snapshotStop, tagSwitch), /up -d --no-build --wait/u);
    assert.ok(text.lastIndexOf('up -d --no-build --wait') > migration);
    assert.match(text, /version-bound update local -> personal-v1\.0\.0/u);
  });
});

test('pending update recovery requires an explicit resume and rejects ambiguous cutover phases', () => {
  withWorkspace((root) => {
    const targetTag = 'personal-v1.0.0';
    const commitSha = 'c'.repeat(40);
    const receiptPath = join(root, 'pending-update.json');
    writeFileSync(join(root, 'personal-server-release.json'), JSON.stringify({
      format: 'charitypilot-personal-server-bundle/v1',
      profile: 'personal-server',
      tag: targetTag,
      commitSha,
      commitTime: NOW.toISOString(),
    }));
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'ready',
      sourceRoot: root,
      source: {
        kind: 'clean-git', revision: 'a'.repeat(40), branch: 'master', canonicalRemote: true,
      },
      activeImageTag: 'local',
    }));
    writeFileSync(join(root, 'recovery-key.hex'), `${'1'.repeat(64)}\n`);
    const receipt = {
      format: 'charitypilot-personal-server-update-receipt/v1',
      phase: 'pre-cutover',
      attemptId: 'ab'.repeat(12),
      createdAt: NOW.toISOString(),
      current: { imageTag: 'local', sourceRoot: root },
      target: {
        sourceRoot: root,
        tag: targetTag,
        commitSha,
        archiveFile: `CharityPilot-${targetTag}.zip`,
        archiveSha256: 'd'.repeat(64),
      },
    };
    writeFileSync(receiptPath, JSON.stringify(receipt));

    assert.throws(
      () => runAt(root, ['update', `--update-receipt=${receiptPath}`, '--dry-run'], fakeExecutor(), []),
      /explicit --resume-pending/u,
    );
    const output = [];
    runAt(
      root,
      ['update', `--update-receipt=${receiptPath}`, '--resume-pending', '--dry-run'],
      fakeExecutor(),
      output,
    );
    assert.match(output.join(''), /pre-cutover -> cutover-started/u);

    writeFileSync(receiptPath, JSON.stringify({ ...receipt, phase: 'cutover-started' }));
    assert.throws(
      () => runAt(
        root,
        ['update', `--update-receipt=${receiptPath}`, '--resume-pending', '--dry-run'],
        fakeExecutor(),
        [],
      ),
      /ambiguous update receipt phase cutover-started/u,
    );
  });
});

test('rollback dry-run binds the prior source, retained images, and exact recovery set', () => {
  withWorkspace((root) => {
    const currentTag = 'personal-v2.0.0';
    const previousTag = 'personal-v1.0.0';
    const currentCommitSha = '2'.repeat(40);
    const previousCommitSha = '1'.repeat(40);
    const previousSourceRoot = join(root, 'previous-release');
    mkdirSync(previousSourceRoot);
    writeFileSync(join(previousSourceRoot, 'compose.personal-server.yml'), 'name: charitypilot-personal-server\nservices: {}\n');
    writeFileSync(join(root, 'personal-server-release.json'), JSON.stringify({
      format: 'charitypilot-personal-server-bundle/v1',
      profile: 'personal-server',
      tag: currentTag,
      commitSha: currentCommitSha,
    }));
    writeFileSync(join(previousSourceRoot, 'personal-server-release.json'), JSON.stringify({
      format: 'charitypilot-personal-server-bundle/v1',
      profile: 'personal-server',
      tag: previousTag,
      commitSha: previousCommitSha,
    }));
    const previousRecovery = createRecoveryFixture(root, {
      encrypted: true,
      imageTag: previousTag,
      applicationSource: {
        kind: 'release-bundle',
        tag: previousTag,
        commitSha: previousCommitSha,
      },
    });
    writeFileSync(join(root, 'recovery-key.hex'), `${'1'.repeat(64)}\n`);
    writeFileSync(join(root, '.env.personal-server'), renderPersonalServerEnv({
      ...validConfig(),
      imageTag: currentTag,
    }));
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'ready',
      sourceRoot: root,
      source: {
        kind: 'release-bundle',
        releaseIdentity: { tag: currentTag, commitSha: currentCommitSha },
      },
      previousRelease: {
        sourceRoot: previousSourceRoot,
        source: {
          kind: 'release-bundle',
          releaseIdentity: { tag: previousTag, commitSha: previousCommitSha },
        },
        imageTag: previousTag,
        recoverySetPath: previousRecovery.setPath,
      },
    }));
    const confirmation = personalServerRollbackConfirmation(currentTag, previousTag, previousRecovery.setPath);
    const stateBefore = readFileSync(join(root, 'install-state.json'), 'utf8');
    const environmentBefore = readFileSync(join(root, '.env.personal-server'), 'utf8');
    const discoveryExecutor = fakeExecutor();
    const discoveryOutput = [];
    runAt(root, ['rollback', '--dry-run'], discoveryExecutor, discoveryOutput);
    assert.match(discoveryOutput.join(''), new RegExp(confirmation.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.equal(discoveryExecutor.calls.length, 0);
    assert.doesNotMatch(discoveryOutput.join(''), /network create|postgres-backup|atomically switch/u);
    assert.equal(readFileSync(join(root, 'install-state.json'), 'utf8'), stateBefore);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), environmentBefore);
    const output = [];
    runAt(root, ['rollback', `--confirm=${confirmation}`, '--dry-run'], fakeExecutor(), output);
    const text = output.join('');
    assert.match(text, /image inspect charitypilot-personal-server-api:personal-v1\.0\.0/u);
    assert.match(text, /atomically switch protected image tag personal-v2\.0\.0 -> personal-v1\.0\.0/u);
    assert.match(text, /rollback personal-v2\.0\.0 -> personal-v1\.0\.0/u);
    const rehearsal = text.indexOf('network create --internal');
    const preservationPlan = text.lastIndexOf('ps --status running --services');
    const preservation = text.indexOf('postgres-backup.mjs source-identity', preservationPlan);
    const tagSwitch = text.indexOf('atomically switch protected image tag');
    const restoredRuntime = text.lastIndexOf('up -d --no-build --wait');
    assert.ok(
      rehearsal >= 0 && rehearsal < preservationPlan && preservationPlan < preservation &&
      preservation < tagSwitch && tagSwitch < restoredRuntime,
    );
    assert.doesNotMatch(text.slice(preservation, tagSwitch), /up -d --no-build --wait/u);
    assert.equal(parsePersonalServerEnv(readFileSync(join(root, '.env.personal-server'), 'utf8')).CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG, currentTag);
  });
});

test('first official release rollback retains the exact original clean-Git source and local images', () => {
  withWorkspace((root) => {
    const currentTag = 'personal-v1.0.0';
    const currentCommitSha = 'b'.repeat(40);
    const originalCommitSha = 'a'.repeat(40);
    const originalSourceRoot = join(root, 'original-clean-git');
    mkdirSync(originalSourceRoot);
    writeFileSync(
      join(originalSourceRoot, 'compose.personal-server.yml'),
      'name: charitypilot-personal-server\nservices: {}\n',
    );
    writeFileSync(join(root, 'personal-server-release.json'), JSON.stringify({
      format: 'charitypilot-personal-server-bundle/v1',
      profile: 'personal-server',
      tag: currentTag,
      commitSha: currentCommitSha,
    }));
    const previousRecovery = createRecoveryFixture(root, {
      encrypted: true,
      imageTag: 'local',
      applicationSource: { kind: 'clean-git', commitSha: originalCommitSha },
    });
    writeFileSync(join(root, 'recovery-key.hex'), `${'1'.repeat(64)}\n`);
    writeFileSync(join(root, '.env.personal-server'), renderPersonalServerEnv({
      ...validConfig(),
      imageTag: currentTag,
    }));
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'ready',
      sourceRoot: root,
      source: {
        kind: 'release-bundle',
        releaseIdentity: { tag: currentTag, commitSha: currentCommitSha },
      },
      activeImageTag: currentTag,
      previousRelease: {
        sourceRoot: originalSourceRoot,
        source: {
          kind: 'git',
          revision: originalCommitSha,
          branch: 'master',
          canonicalRemote: true,
        },
        imageTag: 'local',
        recoverySetPath: previousRecovery.setPath,
      },
    }));
    const confirmation = personalServerRollbackConfirmation(currentTag, 'local', previousRecovery.setPath);
    const output = [];
    runAt(root, ['rollback', `--confirm=${confirmation}`, '--dry-run'], fakeExecutor(), output);
    const text = output.join('');
    assert.match(text, /git status --porcelain=v1 --untracked-files=all/u);
    assert.match(text, /git rev-parse HEAD/u);
    for (const role of ['api', 'migrations', 'web']) {
      assert.match(text, new RegExp(`image inspect charitypilot-personal-server-${role}:local`, 'u'));
    }
    assert.match(text, /atomically switch protected image tag personal-v1\.0\.0 -> local/u);
  });
});

test('authenticated recovery artifact encryption round-trips and rejects tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-recovery-crypto-'));
  try {
    const plaintextPath = join(root, 'database.dump');
    const encryptedPath = join(root, 'database.dump.enc');
    const decryptedPath = join(root, 'database.restored.dump');
    const keyFile = join(root, 'recovery.key');
    writeFileSync(plaintextPath, 'database bytes that must authenticate');
    writeFileSync(keyFile, `${'2'.repeat(64)}\n`);
    const key = loadPersonalServerEncryptionKey(keyFile).key;
    const encrypted = encryptPersonalServerArtifact({
      inputPath: plaintextPath,
      outputPath: encryptedPath,
      key,
      aadContext: 'personal-server-test:database',
      randomBytesImpl: (size) => Buffer.alloc(size, 0x5a),
    });
    const decrypted = decryptPersonalServerArtifact({
      inputPath: encryptedPath,
      outputPath: decryptedPath,
      key,
      aadContext: 'personal-server-test:database',
    });
    assert.equal(decrypted.sha256, encrypted.plaintextSha256);
    assert.deepEqual(readFileSync(decryptedPath), readFileSync(plaintextPath));
    assert.throws(
      () => decryptPersonalServerArtifact({
        inputPath: encryptedPath,
        outputPath: join(root, 'wrong-context.dump'),
        key,
        aadContext: 'different-set:database',
      }),
      /authentication failed/u,
    );

    const tampered = readFileSync(encryptedPath);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(encryptedPath, tampered);
    const rejectedOutput = join(root, 'tampered.dump');
    assert.throws(
      () => decryptPersonalServerArtifact({
        inputPath: encryptedPath,
        outputPath: rejectedOutput,
        key,
        aadContext: 'personal-server-test:database',
      }),
      /authentication failed/,
    );
    assert.equal(existsSync(rejectedOutput), false);
    assert.equal(existsSync(`${rejectedOutput}.partial`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('state-bound recovery staging cleanup removes only the exact interrupted set', () => {
  const suffix = process.pid.toString(16).padStart(8, '0').slice(-8);
  const recoverySetId = `personal-server-2026-07-12T12-00-00-000Z-${suffix}`;
  const staging = join(tmpdir(), `charitypilot-personal-recovery-${recoverySetId}-orphan`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  writeFileSync(join(staging, 'database.plaintext'), 'disposable plaintext');
  cleanupPersonalServerRecoveryStagingForSet(recoverySetId);
  assert.equal(existsSync(staging), false);
});

test('document recovery extraction rejects traversal and link entries without writing outside staging', () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-recovery-tar-'));
  try {
    const traversalArchive = join(root, 'traversal.tar');
    const traversalRoot = join(root, 'traversal-output');
    const outsidePath = join(root, 'escaped.txt');
    writeFileSync(traversalArchive, tarArchive([{ name: '../escaped.txt', content: 'escape' }]));
    assert.throws(
      () => inspectPersonalServerDocumentArchive(traversalArchive, { extractTo: traversalRoot }),
      /unsafe path segment/,
    );
    assert.equal(existsSync(outsidePath), false);
    assert.equal(existsSync(traversalRoot), false);

    const linkArchive = join(root, 'link.tar');
    const linkRoot = join(root, 'link-output');
    writeFileSync(linkArchive, tarArchive([{ name: 'organisation-1/link', type: '2' }]));
    assert.throws(
      () => inspectPersonalServerDocumentArchive(linkArchive, { extractTo: linkRoot }),
      /entry type "2" is forbidden/,
    );
    assert.equal(existsSync(linkRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('document recovery accepts a safe GNU long filename and preserves its content identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-recovery-long-name-'));
  try {
    const archivePath = join(root, 'long-name.tar');
    const extractionRoot = join(root, 'documents');
    const longPath = `organisation-1/${'board-governance-record-'.repeat(6)}.pdf`;
    writeFileSync(archivePath, tarArchive([
      { name: '././@LongLink', type: 'L', content: `${longPath}\0` },
      { name: 'truncated-name', content: 'long-name document bytes' },
    ]));
    const inventory = inspectPersonalServerDocumentArchive(archivePath, { extractTo: extractionRoot });
    assert.equal(inventory.fileCount, 1);
    assert.equal(inventory.files[0].path, longPath);
    assert.equal(readFileSync(join(extractionRoot, ...longPath.split('/')), 'utf8'), 'long-name document bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery-set verifier binds manifest, proof, encrypted artifacts, and document inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-recovery-set-'));
  try {
    const fixture = createRecoveryFixture(root, { encrypted: true });
    const verified = verifyPersonalServerRecoverySet({
      recoverySetPath: fixture.setPath,
      expectedProject: 'charitypilot-personal-server',
      expectedOrigin: validConfig().origin,
      encryptionKeyFile: fixture.encryptionKeyFile,
    });
    try {
      assert.equal(verified.databaseProof.comparison.databaseFingerprintMatched, true);
      assert.deepEqual(verified.documentInventory.files, fixture.documentInventory.files);
      assert.equal(readFileSync(join(verified.documentsPath, 'organisation-1', 'board-minutes.txt'), 'utf8'), 'approved minutes');
    } finally {
      cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
    }

    const documentArtifact = join(fixture.setPath, 'documents.tar.enc');
    const tampered = readFileSync(documentArtifact);
    tampered[20] ^= 0xff;
    writeFileSync(documentArtifact, tampered);
    assert.throws(
      () => verifyPersonalServerRecoverySet({
        recoverySetPath: fixture.setPath,
        expectedProject: 'charitypilot-personal-server',
        expectedOrigin: validConfig().origin,
        encryptionKeyFile: fixture.encryptionKeyFile,
      }),
      /Document artifact SHA-256 does not match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('encrypted recovery manifest rejects metadata substitution even when SHA-256 is recomputed', () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-recovery-manifest-auth-'));
  try {
    const fixture = createRecoveryFixture(root, { encrypted: true });
    const manifestPath = join(fixture.setPath, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.createdAt = new Date(NOW.getTime() + 60_000).toISOString();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(fixture.setPath, 'manifest.sha256'), `${sha256RecoveryFile(manifestPath)}  manifest.json\n`);
    assert.throws(
      () => verifyPersonalServerRecoverySet({
        recoverySetPath: fixture.setPath,
        expectedProject: 'charitypilot-personal-server',
        expectedOrigin: validConfig().origin,
        encryptionKeyFile: fixture.encryptionKeyFile,
        materialize: false,
      }),
      /manifest authentication failed/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rehearse-restore dry-run plans isolated application-level recovery and changes no state', () => {
  withWorkspace((root) => {
    const fixture = createRecoveryFixture(root);
    const before = readdirSync(root).sort();
    const executor = fakeExecutor();
    const output = [];
    runAt(root, ['rehearse-restore', `--recovery-set=${fixture.setPath}`, '--dry-run'], executor, output);
    const text = output.join('');
    assert.equal(executor.calls.length, 0);
    assert.match(text, /network create --internal/);
    assert.match(text, /postgres-backup\.mjs prove-restore/);
    assert.match(text, /charitypilot-personal-server-api:local/);
    assert.match(text, /application-document-reconciliation/);
    assert.match(text, /charitypilot-personal-server-web:local/);
    assert.match(text, /Caddyfile\.personal-server/);
    assert.match(text, /full-application-login-and-document-proof/);
    const rehearsalName = 'charitypilot-personal-rehearsal-abababababab';
    for (const container of ['caddy', 'web', 'api', 'postgres']) {
      assert.match(text, new RegExp(`docker rm -f ${rehearsalName}-${container}`, 'u'));
    }
    assert.match(text, new RegExp(`docker volume rm ${rehearsalName}-documents`, 'u'));
    assert.match(text, new RegExp(`docker volume rm ${rehearsalName}-db`, 'u'));
    assert.match(text, new RegExp(`docker network rm ${rehearsalName}`, 'u'));
    assert.match(text, /no recovery containers, networks, volumes, or restored files were created/);
    assert.deepEqual(readdirSync(root).sort(), before);
  });
});

test('full-application rehearsal proves Caddy privacy headers and private compiled login content', () => {
  const source = readFileSync(new URL('./personal-server.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /'--read-only', '--cap-drop', 'ALL',[\s\S]*'--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',[\s\S]*'--security-opt', 'no-new-privileges=true',[\s\S]*DOCUMENT_ARCHIVE_IMAGE, 'sleep', '300'/u,
  );
  assert.match(source, /role: 'ADMIN',[\s\S]*organisationId: organisation\.id/u);
  assert.doesNotMatch(source, /role: 'OWNER',[\s\S]*organisationId: organisation\.id/u);
  assert.match(source, /AUTH_RECOVERY_SECRET: values\.AUTH_RECOVERY_SECRET/u);
  assert.match(source, /RECOVERY_API_ENV_NAMES[\s\S]*'AUTH_RECOVERY_SECRET'/u);
  assert.match(source, /secrets: \[[\s\S]*values\.AUTH_RECOVERY_SECRET/u);
  assert.match(source, /page\.headers\.get\('x-charitypilot-deployment'\) !== 'personal-server'/u);
  assert.match(source, /x-robots-tag/u);
  assert.match(source, /robots\.includes\('noindex'\).*robots\.includes\('nofollow'\)/su);
  assert.match(source, /pageBody\.includes\('Welcome back'\).*pageBody\.includes\('private CharityPilot server'\)/su);
});

test('replacement-host bootstrap dry-run rehearses before exact blank target creation and never initializes an Owner', () => {
  withWorkspace((root) => {
    const fixture = createRecoveryFixture(root, {
      encrypted: true,
      applicationSource: { kind: 'clean-git', commitSha: 'a'.repeat(40) },
    });
    const state = {
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'restore-prepared',
      installationMode: 'replacement-restore',
      sourceRoot: root,
      source: { revision: 'a'.repeat(40), canonicalRemote: true },
      activeImageTag: 'local',
      origin: validConfig().origin,
      port: 8080,
      restoreOperation: {
        recoverySetPath: fixture.setPath,
        sourceOrigin: validConfig().origin,
        startedAt: NOW.toISOString(),
      },
    };
    writeFileSync(join(root, 'install-state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const before = readdirSync(root).sort();
    const executor = fakeExecutor();
    const output = [];
    runAt(root, [
      'bootstrap-restore',
      `--recovery-set=${fixture.setPath}`,
      `--source-origin=${validConfig().origin}`,
      `--origin=${validConfig().origin}`,
      '--port=8080',
      `--confirm=${personalServerRestoreConfirmation(fixture.recoverySetId)}`,
      `--encryption-key-file=${fixture.encryptionKeyFile}`,
      '--dry-run',
    ], executor, output);
    const text = output.join('');
    const rehearsal = text.indexOf('network create --internal');
    const absence = text.indexOf('container ls -a --filter label=com.docker.compose.project=charitypilot-personal-server');
    const projectNetworkAbsence = text.indexOf('network ls --filter label=com.docker.compose.project=charitypilot-personal-server');
    const internalNetworkAbsence = text.indexOf('network ls --filter name=charitypilot-personal-server-internal');
    const edgeNetworkAbsence = text.indexOf('network ls --filter name=charitypilot-personal-server-edge');
    const targetCreate = text.indexOf('create --no-build db document-storage-init');
    const restore = text.indexOf('pg_restore --username', targetCreate);
    assert.match(text, /docker exec -i <db-container-id> pg_restore --username/u);
    assert.doesNotMatch(text, /docker cp .*charitypilot-personal-restore/u);
    const rebindMatches = [...text.matchAll(/rebind-personal-server-auth-recovery-secret\.js/gu)];
    const rehearsalRebindDryRun = rebindMatches[0]?.index ?? -1;
    const rehearsalRebindExecute = rebindMatches[1]?.index ?? -1;
    const targetRebindDryRun = rebindMatches[2]?.index ?? -1;
    const targetRebindExecute = rebindMatches[3]?.index ?? -1;
    const revoke = text.indexOf('revoke-all-restored-sessions');
    assert.ok(
      rehearsal >= 0 && rehearsal < rehearsalRebindDryRun &&
        rehearsalRebindDryRun < rehearsalRebindExecute && rehearsalRebindExecute < absence &&
        absence < projectNetworkAbsence &&
        projectNetworkAbsence < internalNetworkAbsence &&
        internalNetworkAbsence < edgeNetworkAbsence && edgeNetworkAbsence < targetCreate &&
        targetCreate < restore && restore < targetRebindDryRun &&
        targetRebindDryRun < targetRebindExecute && targetRebindExecute < revoke,
      JSON.stringify({
        rehearsal,
        rehearsalRebindDryRun,
        rehearsalRebindExecute,
        absence,
        projectNetworkAbsence,
        internalNetworkAbsence,
        edgeNetworkAbsence,
        targetCreate,
        restore,
        targetRebindDryRun,
        targetRebindExecute,
        revoke,
      }),
    );
    assert.equal(rebindMatches.length, 4);
    assert.match(text, /-e AUTH_RECOVERY_SECRET/u);
    assert.doesNotMatch(text, /AUTH_RECOVERY_SECRET=[^\s]+/u);
    assert.match(text, /replacement-restoring/);
    assert.match(text, /initialized-backup-pending/);
    assert.doesNotMatch(text, /initialize-personal-server|--no-deps(?:\s+-e\s+\S+)*\s+personal-init/u);
    assert.equal(existsSync(join(root, '.env.personal-server')), false);
    assert.deepEqual(readdirSync(root).sort(), before);
  }, { withEnv: false });
});

test('restore dry-run requires the exact phrase and plans identity gates, rehearsal, preservation, then replacement', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root);
    const fixture = createRecoveryFixture(root, { encrypted: true });
    const executor = fakeExecutor();
    const rejectedOutput = [];
    assert.throws(
      () => runAt(root, [
        'restore',
        `--recovery-set=${fixture.setPath}`,
        '--confirm=wrong',
        '--dry-run',
      ], executor, rejectedOutput),
      new RegExp(personalServerRestoreConfirmation(fixture.recoverySetId), 'u'),
    );
    assert.equal(executor.calls.length, 0);
    assert.doesNotMatch(rejectedOutput.join(''), /dropdb|volume inspect/);

    const output = [];
    runAt(root, [
      'restore',
      `--recovery-set=${fixture.setPath}`,
      `--confirm=${personalServerRestoreConfirmation(fixture.recoverySetId)}`,
      '--dry-run',
    ], executor, output);
    const text = output.join('');
    const identity = text.indexOf('volume inspect charitypilot-personal-server-db');
    const networkIdentity = text.indexOf('network inspect charitypilot-personal-server-internal');
    const edgeNetworkIdentity = text.indexOf('network inspect charitypilot-personal-server-edge');
    const rehearsal = text.indexOf('network create --internal');
    const preservation = text.indexOf('postgres-backup.mjs source-identity', rehearsal);
    const restoring = text.indexOf('transition protected installation state ready -> restoring', preservation);
    const recoveryDatabaseStart = text.indexOf('up -d --no-build --wait --wait-timeout 180 db', restoring);
    const destructive = text.indexOf('dropdb --username');
    const rawFingerprintProof = text.indexOf('postgres-backup.mjs prove-restore', destructive);
    const currentMigration = text.indexOf('--profile maintenance run --rm migrate', rawFingerprintProof);
    const documentClear = text.indexOf('find /documents -mindepth 1');
    assert.ok(identity >= 0 && identity < networkIdentity && networkIdentity < edgeNetworkIdentity && edgeNetworkIdentity < rehearsal);
    assert.ok(rehearsal >= 0 && rehearsal < preservation);
    assert.ok(
      preservation >= 0 && preservation < restoring &&
      restoring < recoveryDatabaseStart && recoveryDatabaseStart < destructive,
    );
    assert.match(text, /ps --all -q db/u);
    assert.ok(destructive < rawFingerprintProof && rawFingerprintProof < currentMigration);
    assert.ok(currentMigration < documentClear);
    assert.doesNotMatch(
      text.slice(preservation, destructive),
      /^docker compose .* up -d --no-build --wait --wait-timeout 180\s*$/mu,
    );
    assert.match(text, /up -d --no-build --wait/);
    assert.match(text, /application-document-reconciliation/);
    assert.match(text, /no personal database, document volume, container, networks, or recovery-set file was changed/);
    assert.equal(executor.calls.length, 0);
  });
});

test('ready-install restore supports an explicit source-origin rebind with a separately bound confirmation', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root);
    const sourceOrigin = 'https://old-charity-host.example.ts.net';
    const targetOrigin = validConfig().origin;
    const fixture = createRecoveryFixture(root, { encrypted: true, origin: sourceOrigin });
    const confirmation = personalServerRestoreConfirmation(fixture.recoverySetId, sourceOrigin, targetOrigin);
    assert.match(confirmation, /:REBIND-ORIGIN:[a-f0-9]{16}$/u);
    const before = readdirSync(root).sort();
    const stateBefore = readFileSync(join(root, 'install-state.json'), 'utf8');
    const environmentBefore = readFileSync(join(root, '.env.personal-server'), 'utf8');
    const discoveryExecutor = fakeExecutor();
    const discoveryOutput = [];
    runAt(root, [
      'restore',
      `--recovery-set=${fixture.setPath}`,
      `--source-origin=${sourceOrigin}`,
      '--dry-run',
    ], discoveryExecutor, discoveryOutput);
    assert.match(
      discoveryOutput.join(''),
      new RegExp(confirmation.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
    assert.equal(discoveryExecutor.calls.length, 0);
    assert.doesNotMatch(discoveryOutput.join(''), /network create|postgres-backup|dropdb/u);
    assert.deepEqual(readdirSync(root).sort(), before);
    assert.equal(readFileSync(join(root, 'install-state.json'), 'utf8'), stateBefore);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), environmentBefore);
    const output = [];
    runAt(root, [
      'restore',
      `--recovery-set=${fixture.setPath}`,
      `--source-origin=${sourceOrigin}`,
      `--confirm=${confirmation}`,
      '--dry-run',
    ], fakeExecutor(), output);
    assert.match(output.join(''), new RegExp(`${sourceOrigin} -> ${targetOrigin}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  });
});

test('restore target volume validation fails closed on project, driver, name, or logical volume mismatch', () => {
  const valid = {
    Name: 'charitypilot-personal-server-db',
    Driver: 'local',
    Labels: {
      'com.docker.compose.project': 'charitypilot-personal-server',
      'com.docker.compose.volume': 'personal-server-db',
    },
  };
  assert.equal(
    validatePersonalServerVolumeIdentity(valid, 'charitypilot-personal-server-db', 'personal-server-db'),
    true,
  );
  for (const invalid of [
    { ...valid, Name: 'another-db' },
    { ...valid, Driver: 'custom' },
    { ...valid, Labels: { ...valid.Labels, 'com.docker.compose.project': 'another-project' } },
    { ...valid, Labels: { ...valid.Labels, 'com.docker.compose.volume': 'another-volume' } },
  ]) {
    assert.throws(
      () => validatePersonalServerVolumeIdentity(invalid, 'charitypilot-personal-server-db', 'personal-server-db'),
      /not the exact personal-server Compose volume/,
    );
  }
});

test('decommission requires a fresh recovery set, exact project identities, and exact confirmation', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root);
    const fixture = createRecoveryFixture(root, { encrypted: true });
    const executor = fakeExecutor();
    assert.equal(validatePersonalServerFreshRecovery({
      recoverySetId: fixture.recoverySetId,
      createdAt: NOW.toISOString(),
    }, NOW), true);
    assert.throws(() => validatePersonalServerFreshRecovery({
      recoverySetId: fixture.recoverySetId,
      createdAt: NOW.toISOString(),
    }, new Date(NOW.getTime() + (25 * 60 * 60 * 1000))), /within the last 24 hours/);

    assert.throws(() => runAt(root, [
      'decommission',
      `--recovery-set=${fixture.setPath}`,
      '--confirm=wrong',
      '--dry-run',
    ], executor, []), new RegExp(personalServerDecommissionConfirmation(fixture.recoverySetId), 'u'));

    const output = [];
    runAt(root, [
      'decommission',
      `--recovery-set=${fixture.setPath}`,
      `--confirm=${personalServerDecommissionConfirmation(fixture.recoverySetId)}`,
      '--dry-run',
    ], executor, output);
    const text = output.join('');
    assert.equal(executor.calls.length, 0);
    assert.match(text, /volume inspect charitypilot-personal-server-db/);
    assert.match(text, /network inspect charitypilot-personal-server-internal/);
    assert.match(text, /network inspect charitypilot-personal-server-edge/);
    const finalBackup = text.indexOf('postgres-backup.mjs source-identity');
    const decommissioning = text.indexOf('transition protected installation state ready -> decommissioning');
    const finalRehearsal = text.indexOf('network create --internal', decommissioning);
    const deletion = text.lastIndexOf(' down');
    const projectNetworkAbsence = text.lastIndexOf('network ls --filter label=com.docker.compose.project=charitypilot-personal-server');
    const edgeNetworkAbsence = text.lastIndexOf('network ls --filter name=charitypilot-personal-server-edge');
    const absenceProof = text.lastIndexOf('volume ls --filter name=charitypilot-personal-server-documents');
    const decommissioned = text.indexOf('transition protected installation state decommissioning -> decommissioned');
    assert.ok(finalBackup >= 0 && finalBackup < decommissioning);
    assert.ok(decommissioning < finalRehearsal && finalRehearsal < deletion);
    assert.ok(deletion < projectNetworkAbsence && projectNetworkAbsence < edgeNetworkAbsence && edgeNetworkAbsence < absenceProof && absenceProof < decommissioned);
    assert.doesNotMatch(text.slice(finalBackup, deletion), /compose .* up -d --no-build --wait/u);
    assert.match(text, /compose .* down/);
    assert.match(text, /volume rm charitypilot-personal-server-db/);
    assert.match(text, /volume rm charitypilot-personal-server-documents/);
    assert.match(text, /container ls -a --filter label=com\.docker\.compose\.project=charitypilot-personal-server/u);
    assert.match(text, /source files, configuration, or recovery sets were removed/);
    assert.match(text, /no containers, networks, volumes/u);
    assert.doesNotMatch(text, /(?:^|\s)--volumes(?:\s|$)|(?:^|\s)-v(?:\s|$)/u);
  });
});

test('decommission resumes only from the exact protected final set without creating another backup', () => {
  withWorkspace((root) => {
    const source = {
      kind: 'clean-git',
      revision: 'a'.repeat(40),
      canonicalRemote: true,
    };
    const fixture = createRecoveryFixture(root, {
      encrypted: true,
      applicationSource: { kind: 'clean-git', commitSha: source.revision },
    });
    writeReadyInstallationState(root, {
      phase: 'decommissioning',
      source,
      decommissionOperation: {
        finalRecoverySet: {
          recoverySetId: fixture.recoverySetId,
          path: fixture.setPath,
          manifestSha256: sha256RecoveryFile(join(fixture.setPath, 'manifest.json')),
          createdAt: NOW.toISOString(),
        },
        startedAt: NOW.toISOString(),
      },
    });
    const confirmation = personalServerDecommissionConfirmation(fixture.recoverySetId);
    assert.throws(
      () => runAt(root, [
        'decommission',
        `--recovery-set=${fixture.setPath}`,
        '--confirm=wrong',
        '--dry-run',
      ], fakeExecutor(), []),
      new RegExp(confirmation, 'u'),
    );
    const blockedExecutor = fakeExecutor();
    assert.throws(
      () => runAt(root, ['start'], blockedExecutor, []),
      /decommissioning.*ordinary lifecycle commands are blocked/u,
    );
    assert.equal(blockedExecutor.calls.length, 0);

    const output = [];
    runAt(root, [
      'decommission',
      `--recovery-set=${fixture.setPath}`,
      `--confirm=${confirmation}`,
      '--dry-run',
    ], fakeExecutor(), output);
    const text = output.join('');
    assert.match(text, /Resuming guarded decommission from exact final recovery set/u);
    assert.match(text, /network create --internal/u);
    assert.match(text, /compose .* down/u);
    assert.doesNotMatch(text, /postgres-backup\.mjs source-identity --json/u);
  });
});

test('interrupted restoring state blocks ordinary lifecycle commands while status stays non-mutating', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root, {
      phase: 'restoring',
      restoreOperation: {
        preservationRecoverySet: { recoverySetId: 'personal-server-preservation-test' },
      },
    });
    const executor = fakeExecutor();
    assert.throws(
      () => runAt(root, ['start'], executor, []),
      /interrupted restoring state/u,
    );
    const output = [];
    runAt(root, ['status'], executor, output);
    assert.equal(executor.calls.length, 0);
    assert.match(output.join(''), /installation phase: restoring/u);
    assert.match(output.join(''), /writers must remain stopped/u);
  });
});

test('unknown protected installation phases fail closed before any Docker command', () => {
  withWorkspace((root) => {
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'ready-typo',
    }));
    const executor = fakeExecutor();
    assert.throws(
      () => runAt(root, ['start'], executor, []),
      /invalid identity or phase/u,
    );
    assert.equal(executor.calls.length, 0);
  });
});

test('decommissioned installation state blocks empty-volume recreation while status remains safe', () => {
  withWorkspace((root) => {
    writeFileSync(join(root, 'install-state.json'), JSON.stringify({
      format: 'charitypilot-personal-server-install-state/v1',
      phase: 'decommissioned',
      finalRecoverySet: { recoverySetId: 'personal-server-final-test' },
    }));
    const executor = fakeExecutor();
    assert.throws(
      () => runAt(root, ['start'], executor, []),
      /decommissioned.*cannot recreate empty data volumes/u,
    );
    assert.throws(
      () => runAt(root, ['init'], executor, []),
      /init is not permitted.*decommissioned/u,
    );
    const output = [];
    runAt(root, ['status'], executor, output);
    assert.equal(executor.calls.length, 0);
    assert.match(output.join(''), /installation phase: decommissioned/u);
    assert.match(output.join(''), /personal-server-final-test/u);
  });
});

test('decommission network identity validation fails closed', () => {
  const valid = {
    Name: 'charitypilot-personal-server-internal',
    Driver: 'bridge',
    Internal: true,
    Labels: {
      'com.docker.compose.project': 'charitypilot-personal-server',
      'com.docker.compose.network': 'personal-server-internal',
    },
    IPAM: { Config: [{ Subnet: '172.30.250.0/24', Gateway: '172.30.250.1' }] },
    Containers: Object.fromEntries(
      ['api', 'caddy', 'db', 'web'].map((service) => [service, { Name: `charitypilot-personal-server-${service}-1` }]),
    ),
  };
  assert.equal(validatePersonalServerNetworkIdentity(valid), true);
  for (const invalid of [
    { ...valid, Name: 'another-network' },
    { ...valid, Driver: 'overlay' },
    { ...valid, Internal: false },
    { ...valid, IPAM: { Config: [{ Subnet: '172.30.251.0/24', Gateway: '172.30.251.1' }] } },
    { ...valid, Labels: { ...valid.Labels, 'com.docker.compose.project': 'another-project' } },
  ]) {
    assert.throws(() => validatePersonalServerNetworkIdentity(invalid), /not the exact internal personal-server Compose network/);
  }
  assert.throws(
    () => validatePersonalServerNetworkIdentity({
      ...valid,
      Containers: { ...valid.Containers, foreign: { Name: 'foreign-container' } },
    }),
    /exact reviewed service attachments/u,
  );
  const stoppedInternal = { ...valid, Containers: { db: { Name: 'charitypilot-personal-server-db-1' } } };
  assert.throws(
    () => validatePersonalServerNetworkIdentity(stoppedInternal),
    /exact reviewed service attachments/u,
  );
  assert.equal(validatePersonalServerNetworkIdentity(stoppedInternal, 'internal', { allowDetached: true }), true);
  assert.equal(validatePersonalServerNetworkIdentity({ ...valid, Containers: {} }, 'internal', { allowDetached: true }), true);
  const edge = {
    Name: 'charitypilot-personal-server-edge',
    Driver: 'bridge',
    Internal: false,
    Labels: {
      'com.docker.compose.project': 'charitypilot-personal-server',
      'com.docker.compose.network': 'personal-server-edge',
    },
    IPAM: { Config: [{ Subnet: '172.30.251.0/24', Gateway: '172.30.251.1' }] },
    Containers: { caddy: { Name: 'charitypilot-personal-server-caddy-1' } },
  };
  assert.equal(validatePersonalServerNetworkIdentity(edge, 'edge'), true);
  assert.throws(
    () => validatePersonalServerNetworkIdentity({ ...edge, Containers: {} }, 'edge'),
    /exact reviewed service attachments/u,
  );
  assert.equal(validatePersonalServerNetworkIdentity({ ...edge, Containers: {} }, 'edge', { allowDetached: true }), true);
  assert.throws(
    () => validatePersonalServerNetworkIdentity({
      ...edge,
      Containers: { ...edge.Containers, foreign: { Name: 'foreign-container' } },
    }, 'edge'),
    /exact reviewed service attachments/u,
  );
  assert.throws(
    () => validatePersonalServerNetworkIdentity({
      ...edge,
      Containers: { malformed: {} },
    }, 'edge', { allowDetached: true }),
    /malformed attachment/u,
  );
  assert.throws(
    () => validatePersonalServerNetworkIdentity({
      ...edge,
      Containers: {
        first: { Name: 'charitypilot-personal-server-caddy-1' },
        duplicate: { Name: 'charitypilot-personal-server-caddy-1' },
      },
    }, 'edge', { allowDetached: true }),
    /exact reviewed service attachments/u,
  );
});

test('database restore input streams through pinned Docker stdin and closes its file descriptor', () => {
  withWorkspace((root) => {
    const dumpPath = join(root, 'verified-database.dump');
    const dump = Buffer.from('verified custom-format dump fixture');
    writeFileSync(dumpPath, dump);
    const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
    let inputFd;
    let callCount = 0;
    const context = {
      dryRun: false,
      repoRoot: root,
      processEnv: {
        DOCKER_HOST: 'tcp://untrusted.example:2375',
        DOCKER_TLS_VERIFY: '1',
        PRESERVED_ENVIRONMENT_VALUE: 'yes',
      },
      dockerEndpoint: endpoint,
      dockerBoundaryVerified: true,
      commandTimeoutMs: 30_000,
      spawnSyncImpl: (executable, args, options) => {
        callCount += 1;
        assert.equal(executable, 'docker');
        assert.deepEqual(args, ['exec', '-i', 'database-container', 'pg_restore']);
        assert.equal(options.cwd, root);
        assert.equal(options.env.DOCKER_HOST, endpoint);
        assert.equal(options.env.DOCKER_TLS_VERIFY, undefined);
        assert.equal(options.env.PRESERVED_ENVIRONMENT_VALUE, 'yes');
        assert.equal(options.stdio[1], 'inherit');
        assert.equal(options.stdio[2], 'inherit');
        inputFd = options.stdio[0];
        assert.equal(Number.isInteger(inputFd), true);
        assert.deepEqual(readFileSync(inputFd), dump);
        return { status: 0, stdout: '', stderr: '' };
      },
    };

    runCommandFromFile(
      ['docker', 'exec', '-i', 'database-container', 'pg_restore'],
      dumpPath,
      context,
    );
    assert.equal(callCount, 1);
    assert.throws(() => fstatSync(inputFd), /EBADF|file descriptor/iu);

    writeFileSync(dumpPath, dump);
    let failedInputFd;
    assert.throws(
      () => runCommandFromFile(
        ['docker', 'exec', '-i', 'database-container', 'pg_restore'],
        dumpPath,
        {
          ...context,
          spawnSyncImpl: (executable, args, options) => {
            assert.equal(executable, 'docker');
            assert.deepEqual(args, ['exec', '-i', 'database-container', 'pg_restore']);
            failedInputFd = options.stdio[0];
            return { status: 7, stdout: '', stderr: 'restore failed' };
          },
        },
      ),
      /docker exec -i database-container pg_restore failed/u,
    );
    assert.throws(() => fstatSync(failedInputFd), /EBADF|file descriptor/iu);

    writeFileSync(dumpPath, '');
    assert.throws(
      () => runCommandFromFile(['docker', 'exec', '-i', 'database-container', 'pg_restore'], dumpPath, context),
      /one non-empty regular file/u,
    );
    assert.equal(callCount, 1);
  });
});

test('interrupted auth recovery rotation blocks runtime start while status remains non-mutating', () => {
  withWorkspace((root) => {
    writeReadyInstallationState(root, {
      phase: 'auth-recovery-rotating',
      authRecoveryRotation: {
        receiptId: 'a'.repeat(24),
        receiptPath: join(root, 'pending-auth-recovery-rotation.json'),
        backupPath: join(root, 'recovery', 'personal-server-example'),
        backupRecoverySetId: 'personal-server-example',
        writersBefore: ['caddy', 'web', 'api'],
        databaseWasRunning: true,
        startedAt: NOW.toISOString(),
      },
    });
    const blockedExecutor = fakeExecutor();
    assert.throws(
      () => runAt(root, ['start'], blockedExecutor, []),
      /interrupted auth recovery rotation/u,
    );
    assert.equal(blockedExecutor.calls.length, 0);

    const statusOutput = [];
    const statusExecutor = fakeExecutor();
    runAt(root, ['status'], statusExecutor, statusOutput);
    assert.match(statusOutput.join(''), /auth-recovery-rotating/u);
    assert.match(statusOutput.join(''), /rotation checkpoint: unknown/u);
    assert.equal(statusExecutor.calls.length, 0);
  });
});

test('successful backup binds identity and restore proof to the same exact database container', () => {
  withWorkspace((root) => {
    const backupRoot = join(root, '.charitypilot-backups', 'personal-server');
    const { executor } = fullAuthRecoveryRotationExecutor();
    runAt(root, ['backup', `--output-dir=${backupRoot}`], executor, [], {
      DOCKER_CONTEXT: 'desktop-linux',
      COMPOSE_PROFILES: 'maintenance',
    });
    const proofCalls = executor.calls.filter((call) => call.command.includes('scripts/postgres-backup.mjs'));
    assert.equal(proofCalls.length, 2);
    for (const call of proofCalls) {
      assert.match(call.command.join(' '), new RegExp(`--source-container-id=${'d'.repeat(64)}`, 'u'));
      assert.doesNotMatch(call.command.join(' '), /--docker-network=/u);
      assert.match(call.options.env.DATABASE_URL, /@127\.0\.0\.1:5432\/charitypilot_personal_server$/u);
      assert.doesNotMatch(call.options.env.DATABASE_URL, /@db:/u);
    }
    assert.match(proofCalls[0].command.join(' '), /source-identity/u);
    assert.match(proofCalls[1].command.join(' '), /prove-restore/u);
    assert.equal(readdirSync(backupRoot).filter((name) => !name.startsWith('.')).length, 1);
  });
});

test('lifecycle Docker boundary accepts only local Desktop Linux API 1.48 or later', () => {
  const valid = {
    endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
    skipTlsVerify: 'false',
    operatingSystem: 'Docker Desktop',
    serverOs: 'linux',
    apiVersion: '1.54',
  };
  assert.equal(validateLocalDockerDesktopRuntime(valid), true);
  for (const [runtime, environment] of [
    [{ ...valid, endpoint: 'ssh://remote.example' }, {}],
    [{ ...valid, endpoint: 'tcp://127.0.0.1:2375' }, {}],
    [{ ...valid, apiVersion: '1.47' }, {}],
    [{ ...valid, serverOs: 'windows' }, {}],
    [valid, { DOCKER_HOST: 'tcp://remote.example:2376' }],
    [valid, { DOCKER_TLS: '1' }],
    [valid, { docker_host: 'tcp://remote.example:2376' }],
    [valid, { buildkit_host: 'tcp://remote-builder.example:1234' }],
    [valid, { BUILDX_BUILDER: 'remote-builder' }],
    [valid, { DOCKER_API_VERSION: '1.47' }],
    [valid, { docker_default_platform: 'linux/arm64' }],
    [valid, { DOCKER_CONFIG: 'C:\\remote-docker-config' }],
  ]) {
    assert.throws(
      () => validateLocalDockerDesktopRuntime(runtime, environment),
      /local Windows Docker Desktop Linux named pipe/u,
    );
  }
});

test('live lifecycle verifies the local Docker boundary once before Compose', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => {
      if (call.command[1] === 'context') {
        return { status: 0, stdout: 'npipe:////./pipe/dockerDesktopLinuxEngine|false\n', stderr: '' };
      }
      if (call.command[1] === 'info') {
        return { status: 0, stdout: 'Docker Desktop|linux\n', stderr: '' };
      }
      if (call.command[1] === 'version') {
        return { status: 0, stdout: '1.54\n', stderr: '' };
      }
      return null;
    }, { recordDockerBoundary: true });
    runPersonalServer({
      args: ['stop'],
      repoRoot: root,
      processEnv: { COMPOSE_PROFILES: 'maintenance' },
      hostPlatform: 'win32',
      spawnSyncImpl: executor.spawn,
      randomBytesImpl: deterministicRandomBytes,
      now: () => new Date(NOW),
      writeOutput: () => {},
    });
    assert.deepEqual(executor.calls.slice(0, 4).map((call) => call.command.slice(0, 2)), [
      ['docker', 'context'],
      ['docker', 'info'],
      ['docker', 'version'],
      ['docker', 'compose'],
    ]);
    assert.equal(Object.hasOwn(executor.calls[3].options.env, 'COMPOSE_PROFILES'), false);
    assert.equal(executor.calls[3].options.env.DOCKER_HOST, 'npipe:////./pipe/dockerDesktopLinuxEngine');
  });
});

test('live lifecycle never contacts a remote Docker endpoint discovered from context metadata', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => {
      if (call.command[1] === 'context') {
        return { status: 0, stdout: 'ssh://remote.example|false\n', stderr: '' };
      }
      throw new Error(`Unexpected post-boundary command: ${call.command.join(' ')}`);
    }, { recordDockerBoundary: true });
    assert.throws(
      () => runPersonalServer({
        args: ['stop'],
        repoRoot: root,
        processEnv: {},
        hostPlatform: 'win32',
        spawnSyncImpl: executor.spawn,
        randomBytesImpl: deterministicRandomBytes,
        now: () => new Date(NOW),
        writeOutput: () => {},
      }),
      /local Windows Docker Desktop Linux named pipe/u,
    );
    assert.deepEqual(executor.calls.map((call) => call.command.slice(0, 2)), [
      ['docker', 'context'],
    ]);
  });
});

test('decommission surviving project network never records completion', () => {
  const calls = [];
  assert.throws(
    () => executePersonalServerDecommissionFinalization({
      stopWriters: () => calls.push('stop-writers'),
      verifyFinalRecovery: () => ({}),
      rehearseFinalRecovery: () => calls.push('rehearse-final-recovery'),
      closePrivateAccess: () => calls.push('close-private-access'),
      removeRuntime: () => calls.push('remove-runtime'),
      removeDatabaseVolume: () => calls.push('remove-database-volume'),
      removeDocumentVolume: () => calls.push('remove-document-volume'),
      assertResourcesAbsent: () => {
        calls.push('prove-resources-absent');
        validatePersonalServerNetworkAbsence('charitypilot-personal-server-extra\n');
      },
      persistDecommissioned: () => calls.push('persist-decommissioned'),
    }),
    /project network/u,
  );
  assert.equal(calls.includes('prove-resources-absent'), true);
  assert.equal(calls.includes('persist-decommissioned'), false);
});

test('decommission container absence proof rejects any surviving project container', () => {
  assert.equal(validatePersonalServerContainerAbsence(''), true);
  assert.throws(
    () => validatePersonalServerContainerAbsence('abc123 charitypilot-personal-server-api-1\n'),
    /did not remove every personal-server Compose project container/u,
  );
});

test('decommission network absence proof rejects any surviving project network', () => {
  assert.equal(validatePersonalServerNetworkAbsence(''), true);
  assert.throws(
    () => validatePersonalServerNetworkAbsence('charitypilot-personal-server-extra\n'),
    /did not remove every personal-server Compose project network/u,
  );
});

test('reset-link prints a validated bearer URL only after successful child completion', () => {
  withWorkspace((root) => {
    const resetUrl = 'http://localhost:8080/reset-password#token=abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890';
    const expiresAt = '2026-07-11T13:00:00.000Z';
    const executor = fakeExecutor((call) => (
      call.command.at(-1) === 'reset-link'
        ? { status: 0, stdout: `${JSON.stringify({ resetLinkCreated: true, resetUrl, expiresAt })}\n`, stderr: '' }
        : null
    ));
    const output = [];
    const before = readFileSync(join(root, '.env.personal-server'), 'utf8');
    runAt(root, ['reset-link', '--email=director@example.org'], executor, output);
    const text = output.join('');
    assert.equal(text.split(resetUrl).length - 1, 1);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), before);
    const accountCall = executor.calls.find((call) => call.command.at(-1) === 'reset-link');
    assert.equal(accountCall.command.some((arg) => arg.includes('token=')), false);
    assert.equal(accountCall.options.env.PERSONAL_SERVER_ACCOUNT_EMAIL, 'director@example.org');
  });
});

test('reset-link failure with captured stdout never leaks a bearer URL', () => {
  withWorkspace((root) => {
    const secretUrl = 'http://localhost:8080/reset-password#token=secret_bearer_value';
    const executor = fakeExecutor((call) => (
      call.command.at(-1) === 'reset-link'
        ? { status: 1, stdout: secretUrl, stderr: 'account command failed' }
        : null
    ));
    const output = [];
    assert.throws(
      () => runAt(root, ['reset-link', '--email=director@example.org'], executor, output),
      /account command failed/,
    );
    assert.equal(output.join('').includes(secretUrl), false);
  });
});

test('emergency reset-password injects and prints its password only after success', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => (
      call.command.at(-1) === 'reset-password'
        ? { status: 0, stdout: '{"passwordReset":true,"sessionsRevoked":2}\n', stderr: '' }
        : null
    ));
    const output = [];
    const before = readFileSync(join(root, '.env.personal-server'), 'utf8');
    runAt(root, ['reset-password', '--email=owner@example.org'], executor, output);
    const text = output.join('');
    const password = /Generated replacement password \(shown once\): (\S+)/u.exec(text)?.[1];
    assert.ok(password);
    assert.equal(text.split(password).length - 1, 1);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), before);
    const accountCall = executor.calls.find((call) => call.command.at(-1) === 'reset-password');
    assert.equal(accountCall.command.includes(password), false);
    assert.equal(accountCall.options.env.PERSONAL_SERVER_ACCOUNT_PASSWORD, password);
  });
});
