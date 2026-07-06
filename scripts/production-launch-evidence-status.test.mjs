import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statusScriptPath = join(scriptsDir, 'production-launch-evidence-status.mjs');
const templateScriptPath = join(scriptsDir, 'generate-production-launch-evidence-template.mjs');

async function loadStatusRunner() {
  assert.ok(existsSync(statusScriptPath), 'production launch evidence status script must exist');
  const module = await import(pathToFileURL(statusScriptPath).href);
  assert.equal(typeof module.runProductionLaunchEvidenceStatusFromArgs, 'function');
  return module;
}

async function launchEvidenceTemplate() {
  const module = await import(pathToFileURL(templateScriptPath).href);
  return JSON.parse(module.renderProductionLaunchEvidenceTemplate());
}

function writeEvidenceFile(evidence) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-launch-status-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return { tempDir, evidencePath };
}

test('production launch evidence status reports pending template progress without approving launch', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /CharityPilot production launch evidence status/);
    assert.match(result.stdout, /Evidence statuses complete: no/);
    assert.match(result.stdout, /Checklist checks complete: 0 \/ 83/);
    assert.match(result.stdout, /releaseGate: 0 \/ 18 complete/);
    assert.match(result.stdout, /approvedForLaunch: false/);
    assert.match(result.stdout, /finalSignoff: pending/);
    assert.match(result.stdout, /Next incomplete checks:/);
    assert.match(result.stdout, /releaseGate\.npm-ci/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status counts completed checks and keeps final approval separate', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  evidence.areas.releaseGate.checks['npm-ci'].status = 'complete';
  evidence.areas.releaseGate.checks['npm-ci'].evidence = [
    {
      type: 'command-output',
      reference: 'https://evidence.charitypilot.ie/launch/release/npm-ci',
      description: 'npm ci completed on the release build machine with exit 0.',
      capturedAt: '2026-07-06T12:00:00.000Z',
    },
  ];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Checklist checks complete: 1 \/ 83/);
    assert.match(result.stdout, /releaseGate: 1 \/ 18 complete/);
    assert.match(result.stdout, /finalSignoff: pending/);
    assert.match(result.stdout, /releaseGate\.db-generate/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status fails closed when evidence file is missing', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();

  const result = runProductionLaunchEvidenceStatusFromArgs([
    '--evidence-file',
    join(tmpdir(), 'missing-production-launch-evidence.json'),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /evidence file not found/);
});
