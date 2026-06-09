import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const releaseRunScriptPath = join(scriptsDir, 'production-release-run-evidence.mjs');
const capturedAt = '2026-06-08T12:00:00.000Z';
const commitSha = 'b'.repeat(40);
const workflowRunUrl = 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/123456789';

async function loadReleaseRunChecker() {
  assert.ok(existsSync(releaseRunScriptPath), 'production release run checker must exist');
  const module = await import(pathToFileURL(releaseRunScriptPath).href);
  assert.equal(typeof module.runProductionReleaseRunEvidenceFromArgs, 'function');
  return module;
}

function launchEvidence(overrides = {}) {
  return {
    version: 1,
    preparedBy: 'Release owner',
    preparedAt: capturedAt,
    approvedForLaunch: true,
    release: {
      commitSha,
      workflowRunUrl,
      workflowFile: '.github/workflows/release-images.yml',
      gitRef: 'refs/heads/master',
      imageDigestManifest: {
        apiImage: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${'a'.repeat(64)}`,
        webImage: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${'a'.repeat(64)}`,
        migrationImage: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${'a'.repeat(64)}`,
        webBuildNextPublicApiUrl: 'https://api.charitypilot.ie',
        webBuildNextPublicSupabaseUrl: 'https://configured-project.supabase.co',
      },
      ...overrides,
    },
  };
}

function writeEvidenceFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-release-run-evidence-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(content, null, 2));
  return { tempDir, evidencePath };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    async json() {
      return body;
    },
  };
}

test('production release run checker verifies GitHub workflow metadata and digest artifact', async () => {
  const { runProductionReleaseRunEvidenceFromArgs } = await loadReleaseRunChecker();
  const { tempDir, evidencePath } = writeEvidenceFile(launchEvidence());
  const seenRequests = [];
  const fetchImpl = async (url, options = {}) => {
    seenRequests.push({ url, options });
    if (url.endsWith('/actions/runs/123456789')) {
      return response(200, {
        html_url: workflowRunUrl,
        path: '.github/workflows/release-images.yml',
        head_sha: commitSha,
        head_branch: 'master',
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch',
      });
    }
    if (url.endsWith('/actions/runs/123456789/artifacts')) {
      return response(200, {
        artifacts: [
          { name: 'release-image-digests', expired: false, archive_download_url: 'https://api.github.com/artifact.zip' },
        ],
      });
    }
    return response(404, {});
  };

  try {
    const result = await runProductionReleaseRunEvidenceFromArgs(['--evidence-file', evidencePath], {
      fetchImpl,
      processEnv: { GITHUB_TOKEN: 'ghp_not_printed_token' },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production release run evidence passed/);
    assert.match(result.stdout, /release-image-digests/);
    assert.equal(seenRequests.length, 2);
    assert.equal(seenRequests[0].options.headers.authorization, 'Bearer ghp_not_printed_token');
    assert.doesNotMatch(result.stdout + result.stderr, /ghp_not_printed_token/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production release run checker rejects mismatched GitHub workflow metadata', async () => {
  const { runProductionReleaseRunEvidenceFromArgs } = await loadReleaseRunChecker();
  const { tempDir, evidencePath } = writeEvidenceFile(launchEvidence({ gitRef: 'refs/tags/v1.2.3' }));
  const fetchImpl = async (url) => {
    if (url.endsWith('/actions/runs/123456789')) {
      return response(200, {
        html_url: 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/987654321',
        path: '.github/workflows/ci.yml',
        head_sha: 'c'.repeat(40),
        head_branch: 'preview',
        status: 'completed',
        conclusion: 'failure',
        event: 'push',
      });
    }
    if (url.endsWith('/actions/runs/123456789/artifacts')) {
      return response(200, { artifacts: [{ name: 'debug-logs', expired: false }] });
    }
    return response(404, {});
  };

  try {
    const result = await runProductionReleaseRunEvidenceFromArgs(['--evidence-file', evidencePath], { fetchImpl });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /workflow run html_url must match release.workflowRunUrl/);
    assert.match(result.stderr, /workflow run path must match release.workflowFile/);
    assert.match(result.stderr, /workflow run head_sha must match release.commitSha/);
    assert.match(result.stderr, /workflow run ref must match release.gitRef/);
    assert.match(result.stderr, /workflow run conclusion must be success/);
    assert.match(result.stderr, /workflow run artifacts must include non-expired release-image-digests/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production release run checker rejects a workflow trigger that does not match the release ref', async () => {
  const { runProductionReleaseRunEvidenceFromArgs } = await loadReleaseRunChecker();
  const { tempDir, evidencePath } = writeEvidenceFile(launchEvidence({ gitRef: 'refs/heads/master' }));
  const fetchImpl = async (url) => {
    if (url.endsWith('/actions/runs/123456789')) {
      return response(200, {
        html_url: workflowRunUrl,
        path: '.github/workflows/release-images.yml',
        head_sha: commitSha,
        head_branch: 'master',
        status: 'completed',
        conclusion: 'success',
        event: 'push',
      });
    }
    if (url.endsWith('/actions/runs/123456789/artifacts')) {
      return response(200, {
        artifacts: [
          { name: 'release-image-digests', expired: false, archive_download_url: 'https://api.github.com/artifact.zip' },
        ],
      });
    }
    return response(404, {});
  };

  try {
    const result = await runProductionReleaseRunEvidenceFromArgs(['--evidence-file', evidencePath], { fetchImpl });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /workflow run event must be workflow_dispatch for refs\/heads\/master releases/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production release run checker accepts tag release workflow pushes', async () => {
  const { runProductionReleaseRunEvidenceFromArgs } = await loadReleaseRunChecker();
  const { tempDir, evidencePath } = writeEvidenceFile(launchEvidence({ gitRef: 'refs/tags/v1.2.3' }));
  const fetchImpl = async (url) => {
    if (url.endsWith('/actions/runs/123456789')) {
      return response(200, {
        html_url: workflowRunUrl,
        path: '.github/workflows/release-images.yml',
        head_sha: commitSha,
        head_branch: 'v1.2.3',
        status: 'completed',
        conclusion: 'success',
        event: 'push',
      });
    }
    if (url.endsWith('/actions/runs/123456789/artifacts')) {
      return response(200, {
        artifacts: [
          { name: 'release-image-digests', expired: false, archive_download_url: 'https://api.github.com/artifact.zip' },
        ],
      });
    }
    return response(404, {});
  };

  try {
    const result = await runProductionReleaseRunEvidenceFromArgs(['--evidence-file', evidencePath], { fetchImpl });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production release run evidence passed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production release run checker rejects non-release workflow evidence before GitHub calls', async () => {
  const { runProductionReleaseRunEvidenceFromArgs } = await loadReleaseRunChecker();
  const { tempDir, evidencePath } = writeEvidenceFile(launchEvidence({
    workflowFile: '.github/workflows/ci.yml',
    gitRef: 'refs/heads/preview',
  }));

  try {
    const result = await runProductionReleaseRunEvidenceFromArgs(['--evidence-file', evidencePath], {
      fetchImpl: async () => {
        throw new Error('fetch should not be called for invalid release shape');
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /release\.workflowFile must be \.github\/workflows\/release-images\.yml/);
    assert.match(result.stderr, /release\.gitRef must be refs\/heads\/master or refs\/tags\/v/);
    assert.doesNotMatch(result.stderr, /fetch should not be called/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
