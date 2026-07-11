import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const initScriptUrl = pathToFileURL(join(process.cwd(), 'scripts', 'init-production-launch-evidence.mjs')).href;

async function loadInitRunner() {
  const module = await import(initScriptUrl);
  assert.equal(typeof module.runInitProductionLaunchEvidenceFromArgs, 'function');
  return module;
}

test('production launch evidence init writes the template outside the repo root by default', async () => {
  const { runInitProductionLaunchEvidenceFromArgs } = await loadInitRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-evidence-init-'));

  try {
    const result = runInitProductionLaunchEvidenceFromArgs([], { cwd: tempDir });
    const evidencePath = join(tempDir, '.charitypilot-launch-evidence', 'production-launch-evidence.json');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /\.charitypilot-launch-evidence[\\/]production-launch-evidence\.json/);
    assert.ok(existsSync(evidencePath));
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.approvedForLaunch, false);
    assert.equal(evidence.finalSignoff.status, 'pending');
    const databaseProof = evidence.areas.database.checks['database-check'].databaseRestoreProof;
    assert.equal(databaseProof.checksumAlgorithm, 'sha256');
    assert.equal(databaseProof.recoverySetId, 'REPLACE_WITH_DATABASE_RECOVERY_SET_ID');
    assert.equal(databaseProof.expectedSourceDatabaseIdentitySha256, 'REPLACE_WITH_EXPECTED_SOURCE_DATABASE_IDENTITY_SHA256');
    assert.equal(databaseProof.databaseDumpBytes, null);
    assert.equal(databaseProof.tablesCompared, null);
    assert.equal(databaseProof.backupArtifactsRetained, null);
    assert.equal(databaseProof.productionWritten, null);
    const jointRecovery =
      evidence.areas.supabaseStorage.checks['supabase-restore-tested'].jointRecoveryReconciliation;
    assert.equal(jointRecovery.manifestFormat, 'charitypilot-document-recovery-manifest-v1');
    assert.equal(jointRecovery.checksumAlgorithm, 'sha256');
    assert.equal(jointRecovery.recoveryManifestSha256, 'REPLACE_WITH_RECOVERY_MANIFEST_SHA256');
    assert.equal(jointRecovery.sourceBindingSha256, 'REPLACE_WITH_SOURCE_BINDING_SHA256');
    assert.equal(jointRecovery.sourceCaptureReportSha256, 'REPLACE_WITH_SOURCE_CAPTURE_REPORT_SHA256');
    assert.equal(jointRecovery.sourceDatabaseIdentitySha256, 'REPLACE_WITH_SOURCE_DATABASE_IDENTITY_SHA256');
    assert.equal(jointRecovery.sourceObjectStoreIdentitySha256, 'REPLACE_WITH_SOURCE_OBJECT_STORE_IDENTITY_SHA256');
    assert.equal(jointRecovery.databaseDumpSha256, 'REPLACE_WITH_DATABASE_DUMP_SHA256');
    assert.equal(jointRecovery.objectBackupManifestSha256, 'REPLACE_WITH_OBJECT_BACKUP_MANIFEST_SHA256');
    assert.equal(jointRecovery.exerciseId, 'REPLACE_WITH_EXERCISE_ID');
    assert.equal(jointRecovery.recoverySetId, 'REPLACE_WITH_RECOVERY_SET_ID');
    assert.equal(jointRecovery.metadataRowCount, null);
    assert.equal(jointRecovery.orphanExpectedObjectCount, null);
    assert.equal(jointRecovery.orphanRestoredObjectCount, null);
    assert.equal(jointRecovery.sourceRecoveryEventInventorySha256, 'REPLACE_WITH_SOURCE_RECOVERY_EVENT_INVENTORY_SHA256');
    assert.equal(jointRecovery.restoredRecoveryEventInventorySha256, 'REPLACE_WITH_RESTORED_RECOVERY_EVENT_INVENTORY_SHA256');
    assert.equal(jointRecovery.recoveryEventCount, null);
    assert.equal(jointRecovery.restoredRecoveryEventCount, null);
    assert.equal(jointRecovery.sourceMetadataCaptureTransactionId, 'REPLACE_WITH_SOURCE_METADATA_CAPTURE_TRANSACTION_ID');
    assert.equal(jointRecovery.restoredMetadataCaptureTransactionId, 'REPLACE_WITH_RESTORED_METADATA_CAPTURE_TRANSACTION_ID');
    assert.equal(jointRecovery.isolationAttestationRecorded, null);
    assert.equal(jointRecovery.productionDatabaseNotOverwrittenAttestationRecorded, null);
    assert.equal(jointRecovery.productionObjectStoreNotOverwrittenAttestationRecorded, null);
    assert.equal(jointRecovery.restoreCredentialsScopedToTargetAttestationRecorded, null);
    assert.equal(jointRecovery.objectives.database.rpoObjectiveMinutes, null);
    assert.equal(jointRecovery.objectives.documentBytes.rtoObjectiveMinutes, null);
    assert.equal(jointRecovery.recoveryOperatorRecorded, null);
    assert.equal(jointRecovery.independentBindingArgumentsMatched, null);
    assert.equal(jointRecovery.sourceProvenanceExternallyVerified, false);
    assert.equal(Object.hasOwn(jointRecovery, 'isolationVerified'), false);
    assert.equal(Object.hasOwn(jointRecovery, 'sourceProvenanceExternallyBound'), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence init refuses to overwrite without --force', async () => {
  const { runInitProductionLaunchEvidenceFromArgs } = await loadInitRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-evidence-init-'));

  try {
    assert.equal(runInitProductionLaunchEvidenceFromArgs([], { cwd: tempDir }).status, 0);
    const second = runInitProductionLaunchEvidenceFromArgs([], { cwd: tempDir });

    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
    assert.match(second.stderr, /--force/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence init renders machine-readable handoff output', async () => {
  const { runInitProductionLaunchEvidenceFromArgs } = await loadInitRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-evidence-init-json-'));

  try {
    const result = runInitProductionLaunchEvidenceFromArgs(['--json'], { cwd: tempDir });
    const evidencePath = join(tempDir, '.charitypilot-launch-evidence', 'production-launch-evidence.json');

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.ok(existsSync(evidencePath));

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'created');
    assert.equal(payload.evidenceFile, '.charitypilot-launch-evidence/production-launch-evidence.json');
    assert.match(payload.gitPolicy, /Keep this file out of git/);
    assert.equal(
      payload.commands.status,
      'npm run check:production:evidence:status -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
    );
    assert.equal(
      payload.commands.statusJson,
      'npm run check:production:evidence:status -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
    );
    assert.equal(
      payload.commands.validate,
      'npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
    );
    assert.equal(
      payload.commands.validateJson,
      'npm run check:production:evidence -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
    );

    const second = runInitProductionLaunchEvidenceFromArgs(['--json'], { cwd: tempDir });
    assert.equal(second.status, 1);
    const existingPayload = JSON.parse(second.stdout);
    assert.equal(existingPayload.status, 'exists');
    assert.match(existingPayload.nextAction, /--force/);

    const forced = runInitProductionLaunchEvidenceFromArgs(['--json', '--force'], { cwd: tempDir });
    assert.equal(forced.status, 0);
    assert.equal(JSON.parse(forced.stdout).status, 'replaced');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence init rejects empty evidence file option before writing', async () => {
  const { runInitProductionLaunchEvidenceFromArgs } = await loadInitRunner();
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-evidence-init-empty-'));

  try {
    const result = runInitProductionLaunchEvidenceFromArgs(['--evidence-file='], { cwd: tempDir });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /--evidence-file requires a value/);
    assert.equal(existsSync(join(tempDir, '.charitypilot-launch-evidence')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
