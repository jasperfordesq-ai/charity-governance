import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const evidenceScriptPath = join(scriptsDir, 'production-launch-evidence.mjs');
const capturedAt = '2026-06-08T12:00:00.000Z';
const digest = 'a'.repeat(64);

async function loadEvidenceRunner() {
  assert.ok(existsSync(evidenceScriptPath), 'production launch evidence script must exist');
  const module = await import(pathToFileURL(evidenceScriptPath).href);
  assert.equal(typeof module.runProductionLaunchEvidenceFromArgs, 'function');
  assert.ok(Array.isArray(module.REQUIRED_LAUNCH_AREAS));
  return module;
}

function evidenceEntry(areaId, checkId) {
  const entry = {
    type: 'artifact',
    reference: `https://evidence.charitypilot.ie/launch/${areaId}/${checkId}`,
    description: `${areaId} ${checkId} evidence`,
    capturedAt,
  };

  if (areaId === 'database' && checkId === 'database-check') {
    entry.type = 'command-output';
    entry.description = 'npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel completed with operational sentinel checks';
  }

  if (areaId === 'jobs' && checkId === 'scheduler-command') {
    entry.type = 'command-output';
    entry.description = [
      'Production Compose job commands verified:',
      'node dist/jobs/production-scheduler.js',
      'node dist/jobs/send-deadline-reminders.js',
      'node dist/jobs/cleanup-document-storage.js',
    ].join(' ');
  }

  return entry;
}

function completeEvidence(requiredAreas) {
  return {
    version: 1,
    preparedBy: 'Release owner',
    preparedAt: capturedAt,
    approvedForLaunch: true,
    release: {
      commitSha: 'b'.repeat(40),
      workflowRunUrl: 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/123456789',
      imageDigestManifest: {
        apiImage: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`,
        webImage: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`,
        migrationImage: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`,
        webBuildNextPublicApiUrl: 'https://api.charitypilot.ie',
        webBuildNextPublicSupabaseUrl: 'https://configured-project.supabase.co',
      },
    },
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

test('production launch evidence validator requires a bound release artifact identity', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.release.commitSha = 'not-a-sha';
  evidence.release.workflowRunUrl = 'https://github.com/jasperfordesq-ai/charity-governance/actions';
  evidence.release.imageDigestManifest.webImage = 'ghcr.io/jasperfordesq-ai/charity-governance-web:latest';
  evidence.release.imageDigestManifest.webBuildNextPublicApiUrl = 'https://api.attacker.example';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release\.commitSha must be a 40 character lowercase git SHA/);
    assert.match(result.stderr, /release\.workflowRunUrl must be a GitHub Actions release workflow run URL/);
    assert.match(result.stderr, /release\.imageDigestManifest\.webImage must use ghcr\.io\/jasperfordesq-ai\/charity-governance-web@sha256/);
    assert.match(result.stderr, /release\.imageDigestManifest\.webBuildNextPublicApiUrl must use an approved charitypilot\.ie hostname/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator fails when release binding is missing', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  delete evidence.release;
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release is required/);
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

test('production launch evidence validator requires operational sentinel database check evidence', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.database.checks['database-check'].evidence = [
    {
      type: 'artifact',
      reference: 'https://evidence.charitypilot.ie/launch/database/database-check',
      description: 'npm run check:production:database -- --production-env-file=.env.production completed',
      capturedAt,
    },
  ];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.database\.checks\.database-check\.evidence must include command-output evidence/);
    assert.match(result.stderr, /areas\.database\.checks\.database-check\.evidence must show check:production:database was run with --expect-operational-sentinel/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence validator requires every production job command surface', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.jobs.checks['scheduler-command'].evidence[0].description =
    'Production scheduler evidence only mentioned node dist/jobs/send-deadline-reminders.js';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-command\.evidence must include dist\/jobs\/production-scheduler\.js/);
    assert.match(result.stderr, /areas\.jobs\.checks\.scheduler-command\.evidence must include dist\/jobs\/cleanup-document-storage\.js/);
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

test('production launch evidence validator rejects chronologically impossible evidence dates', async () => {
  const { runProductionLaunchEvidenceFromArgs, REQUIRED_LAUNCH_AREAS } = await loadEvidenceRunner();
  const evidence = completeEvidence(REQUIRED_LAUNCH_AREAS);
  evidence.areas.releaseGate.checks.test.evidence[0].capturedAt = '2026-06-09T12:00:00.000Z';
  evidence.finalSignoff.approvedAt = '2026-06-07T12:00:00.000Z';
  evidence.finalSignoff.evidence[0].capturedAt = '2026-06-08T12:00:00.000Z';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /releaseGate\.checks\.test\.evidence\[0\]\.capturedAt must not be after preparedAt/);
    assert.match(result.stderr, /finalSignoff\.approvedAt must not be before preparedAt/);
    assert.match(result.stderr, /finalSignoff\.evidence\[0\]\.capturedAt must not be after finalSignoff\.approvedAt/);
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
