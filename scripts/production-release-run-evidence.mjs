#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'jasperfordesq-ai/charity-governance';
const releaseWorkflowFile = '.github/workflows/release-images.yml';

function usage() {
  return 'Usage: node scripts/production-release-run-evidence.mjs --evidence-file <path>\n';
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function parseArgs(argv) {
  const options = {
    evidenceFile: 'production-launch-evidence.json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--evidence-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence-file requires a value');
      options.evidenceFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--evidence-file=')) {
      options.evidenceFile = arg.slice('--evidence-file='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function runIdFromWorkflowUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/jasperfordesq-ai\/charity-governance\/actions\/runs\/(\d+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function releaseRefName(gitRef) {
  if (typeof gitRef !== 'string') return null;
  const match = gitRef.match(/^refs\/(?:heads|tags)\/(.+)$/);
  return match?.[1] ?? null;
}

function githubHeaders(processEnv) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'charitypilot-production-release-run-check',
  };
  if (processEnv.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${processEnv.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchJson(fetchImpl, url, headers, label) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function validateReleaseShape(release, issues) {
  if (!isPlainObject(release)) {
    issues.push('release is required');
    return null;
  }

  const runId = runIdFromWorkflowUrl(release.workflowRunUrl);
  if (runId === null) {
    issues.push('release.workflowRunUrl must be a GitHub Actions run URL for charity-governance');
  }
  if (release.workflowFile !== releaseWorkflowFile) {
    issues.push(`release.workflowFile must be ${releaseWorkflowFile}`);
  }
  if (typeof release.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(release.commitSha)) {
    issues.push('release.commitSha must be a 40 character lowercase git SHA');
  }
  if (typeof release.gitRef !== 'string' || !/^refs\/(?:heads\/master|tags\/v.+)$/.test(release.gitRef)) {
    issues.push('release.gitRef must be refs/heads/master or refs/tags/v*');
  }

  return runId;
}

function validateWorkflowRun(run, release, issues) {
  if (run.html_url !== release.workflowRunUrl) {
    issues.push('workflow run html_url must match release.workflowRunUrl');
  }
  if (run.path !== release.workflowFile) {
    issues.push('workflow run path must match release.workflowFile');
  }
  if (run.head_sha !== release.commitSha) {
    issues.push('workflow run head_sha must match release.commitSha');
  }
  if (run.status !== 'completed') {
    issues.push('workflow run status must be completed');
  }
  if (run.conclusion !== 'success') {
    issues.push('workflow run conclusion must be success');
  }
  const expectedRef = releaseRefName(release.gitRef);
  if (expectedRef !== null && run.head_branch !== expectedRef) {
    issues.push('workflow run ref must match release.gitRef');
  }
}

function validateArtifacts(artifacts, issues) {
  const releaseDigestArtifact = Array.isArray(artifacts.artifacts)
    ? artifacts.artifacts.find((artifact) => artifact?.name === 'release-image-digests' && artifact.expired !== true)
    : null;
  if (!releaseDigestArtifact) {
    issues.push('workflow run artifacts must include non-expired release-image-digests');
  }
}

export async function runProductionReleaseRunEvidenceFromArgs(
  args = process.argv.slice(2),
  { fetchImpl = globalThis.fetch, processEnv = process.env } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  if (typeof fetchImpl !== 'function') {
    return result(1, '', 'Production release run evidence failed: fetch is unavailable in this Node runtime.\n');
  }

  const evidencePath = resolve(process.cwd(), options.evidenceFile);
  if (!existsSync(evidencePath)) {
    return result(1, '', `Production release run evidence failed: evidence file not found: ${options.evidenceFile}\n`);
  }

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    return result(1, '', `Production release run evidence failed: evidence file is not valid JSON. ${error.message}\n`);
  }

  const issues = [];
  const runId = validateReleaseShape(evidence.release, issues);
  if (runId === null || issues.length > 0) {
    return result(
      1,
      '',
      [`Production release run evidence failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`, ...issues.map((issue) => `- ${issue}`), ''].join('\n'),
    );
  }

  const headers = githubHeaders(processEnv);
  const apiBase = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  try {
    const workflowRun = await fetchJson(fetchImpl, apiBase, headers, 'workflow run');
    const artifacts = await fetchJson(fetchImpl, `${apiBase}/artifacts`, headers, 'workflow artifacts');
    validateWorkflowRun(workflowRun, evidence.release, issues);
    validateArtifacts(artifacts, issues);
  } catch (error) {
    return result(1, '', `Production release run evidence failed: ${error.message}\n`);
  }

  if (issues.length > 0) {
    return result(
      1,
      '',
      [`Production release run evidence failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`, ...issues.map((issue) => `- ${issue}`), ''].join('\n'),
    );
  }

  return result(
    0,
    `Production release run evidence passed: GitHub Actions run ${runId} matches release workflow metadata and has release-image-digests artifact.\n`,
  );
}

async function main() {
  const releaseRunResult = await runProductionReleaseRunEvidenceFromArgs();
  if (releaseRunResult.stdout) process.stdout.write(releaseRunResult.stdout);
  if (releaseRunResult.stderr) process.stderr.write(releaseRunResult.stderr);
  process.exit(releaseRunResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
