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
