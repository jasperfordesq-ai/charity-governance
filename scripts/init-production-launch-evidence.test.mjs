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
