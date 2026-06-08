import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const evidenceScriptPath = join(scriptsDir, 'production-launch-evidence.mjs');
const capturedAt = '2026-06-08T12:00:00.000Z';

async function loadEvidenceRunner() {
  assert.ok(existsSync(evidenceScriptPath), 'production launch evidence script must exist');
  const module = await import(pathToFileURL(evidenceScriptPath).href);
  assert.equal(typeof module.runProductionLaunchEvidenceFromArgs, 'function');
  assert.ok(Array.isArray(module.REQUIRED_LAUNCH_AREAS));
  return module;
}

function evidenceEntry(areaId, checkId) {
  return {
    type: 'artifact',
    reference: `https://evidence.charitypilot.ie/launch/${areaId}/${checkId}`,
    description: `${areaId} ${checkId} evidence`,
    capturedAt,
  };
}

function completeEvidence(requiredAreas) {
  return {
    version: 1,
    preparedBy: 'Release owner',
    preparedAt: capturedAt,
    approvedForLaunch: true,
    areas: Object.fromEntries(requiredAreas.map((area) => [
      area.id,
      {
        owner: `${area.label} owner`,
        status: 'complete',
        checks: Object.fromEntries(area.checks.map((check) => [
          check.id,
          {
            status: 'complete',
            evidence: [evidenceEntry(area.id, check.id)],
          },
        ])),
      },
    ])),
    finalSignoff: {
      status: 'approved',
      owner: 'Accountable owner',
      approvedAt: capturedAt,
      evidence: [
        {
          type: 'approval',
          reference: 'https://evidence.charitypilot.ie/launch/final-signoff/approval',
          description: 'Accountable owner launch approval',
          capturedAt,
        },
      ],
    },
  };
}

function writeEvidenceFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-launch-evidence-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(content, null, 2));
  return { tempDir, evidencePath };
}

test('production launch evidence validator accepts complete dated external evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const { tempDir, evidencePath } = writeEvidenceFile(completeEvidence(REQUIRED_LAUNCH_AREAS));

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production launch evidence passed/);
    assert.match(result.stdout, /11 area\(s\)/);
    assert.match(result.stdout, /77 check\(s\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires all executable production checker evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  const requiredCommandChecks = {
    hostingDnsTls: 'hosting-check',
    database: 'database-check',
    supabaseStorage: 'supabase-check',
    billingAndEmail: 'providers-check',
    observability: 'observability-check',
  };

  for (const [areaId, checkId] of Object.entries(requiredCommandChecks)) {
    assert.ok(
      REQUIRED_LAUNCH_AREAS.find((area) => area.id === areaId)?.checks.some((check) => check.id === checkId),
      `${areaId}.${checkId} must be part of REQUIRED_LAUNCH_AREAS`,
    );
    delete evidence.areas[areaId].checks[checkId];
  }

  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /hostingDnsTls\.checks\.hosting-check is required/);
    assert.match(result.stderr, /database\.checks\.database-check is required/);
    assert.match(result.stderr, /supabaseStorage\.checks\.supabase-check is required/);
    assert.match(result.stderr, /billingAndEmail\.checks\.providers-check is required/);
    assert.match(result.stderr, /observability\.checks\.observability-check is required/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator fails closed when evidence file is missing', async () => {
  const { runProductionLaunchEvidenceFromArgs } = await loadEvidenceRunner();

  const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', join(tmpdir(), 'missing-launch-evidence.json')]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production launch evidence failed/);
  assert.match(result.stderr, /evidence file not found/);
});

test('production launch evidence validator requires every checklist check to be complete', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.areas.releaseGate.checks['deploy-production'];
  evidence.finalSignoff.status = 'pending';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /releaseGate\.checks\.deploy-production is required/);
    assert.match(result.stderr, /finalSignoff\.status must be approved/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator rejects placeholders, local URLs, and raw secrets', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.hostingDnsTls.checks['web-origin'].evidence[0].reference = 'http://localhost:3000/todo';
  evidence.areas.billingAndEmail.checks['stripe-webhook-secret'].evidence[0].description = 'whsec_rawWebhookSecretMustNotAppear';
  evidence.areas.observability.checks['incident-owner'].evidence[0].reference = 'TBD';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /hostingDnsTls\.checks\.web-origin\.evidence\[0\]\.reference must be an https URL when a URL is provided/);
    assert.match(result.stderr, /observability\.checks\.incident-owner\.evidence\[0\]\.reference must not be a placeholder or local reference/);
    assert.match(result.stderr, /billingAndEmail\.checks\.stripe-webhook-secret\.evidence\[0\]\.description must not contain raw secret-looking values/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
