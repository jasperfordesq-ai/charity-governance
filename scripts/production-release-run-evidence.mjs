#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { redactProductionDeployTranscript } from './production-deploy-preflight.mjs';

const repository = 'jasperfordesq-ai/charity-governance';
const releaseWorkflowFile = '.github/workflows/release-images.yml';
const defaultEvidenceFile = '.charitypilot-launch-evidence/production-launch-evidence.json';

function usage() {
  return 'Usage: node scripts/production-release-run-evidence.mjs [--json] --evidence-file <path>\n';
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function jsonResult(status, payload) {
  return result(status, `${JSON.stringify(payload, null, 2)}\n`, '');
}

function redactReleaseRunTranscript(value) {
  return redactProductionDeployTranscript(value)
    .replace(/\b(GITHUB_TOKEN=)[^\s'")]+/gi, '$1[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_=-]+/g, '[redacted-github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_=-]+/g, '[redacted-github-token]');
}

function parseArgs(argv) {
  const options = {
    evidenceFile: defaultEvidenceFile,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--evidence-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence-file requires a value');
      options.evidenceFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--evidence-file=')) {
      const value = arg.slice('--evidence-file='.length);
      if (!value) throw new Error('--evidence-file requires a value');
      options.evidenceFile = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function argsWantJson(argv) {
  return argv.includes('--json');
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

function expectedWorkflowEvent(gitRef) {
  if (gitRef === 'refs/heads/master') return 'workflow_dispatch';
  if (typeof gitRef === 'string' && gitRef.startsWith('refs/tags/v')) return 'push';
  return null;
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
    throw new Error(`${label} request failed with HTTP ${response.status} ${redactReleaseRunTranscript(response.statusText)}`);
  }
  return response.json();
}

async function fetchBytes(fetchImpl, url, headers, label) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status} ${redactReleaseRunTranscript(response.statusText)}`);
  }
  if (typeof response.arrayBuffer !== 'function') {
    throw new Error(`${label} response did not include binary artifact content`);
  }
  return Buffer.from(await response.arrayBuffer());
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
  const expectedEvent = expectedWorkflowEvent(release.gitRef);
  if (expectedEvent !== null && run.event !== expectedEvent) {
    issues.push(`workflow run event must be ${expectedEvent} for ${release.gitRef} releases`);
  }
}

function validateArtifacts(artifacts, issues) {
  const releaseDigestArtifact = Array.isArray(artifacts.artifacts)
    ? artifacts.artifacts.find((artifact) => artifact?.name === 'release-image-digests' && artifact.expired !== true)
    : null;
  if (!releaseDigestArtifact) {
    issues.push('workflow run artifacts must include non-expired release-image-digests');
  }
  if (releaseDigestArtifact && typeof releaseDigestArtifact.archive_download_url !== 'string') {
    issues.push('release-image-digests artifact must include archive_download_url');
  }
  return releaseDigestArtifact ?? null;
}

function releaseBindingSummary(release) {
  const manifest = release?.imageDigestManifest ?? {};
  return [
    ['apiImage', manifest.apiImage],
    ['webImage', manifest.webImage],
    ['migrationImage', manifest.migrationImage],
    ['webBuildNextPublicApiUrl', manifest.webBuildNextPublicApiUrl],
  ]
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `${key}=${value}`);
}

function releaseBindingObject(release) {
  const manifest = release?.imageDigestManifest ?? {};
  return Object.fromEntries(
    [
      ['apiImage', manifest.apiImage],
      ['webImage', manifest.webImage],
      ['migrationImage', manifest.migrationImage],
      ['webBuildNextPublicApiUrl', manifest.webBuildNextPublicApiUrl],
    ].filter(([, value]) => typeof value === 'string' && value.length > 0),
  );
}

function releaseRunPayload({ ok, evidenceFile, runId = null, release = null, issues = [] }) {
  return {
    ok,
    repository,
    evidenceFile,
    workflowRunId: runId,
    workflowRunUrl: release?.workflowRunUrl ?? null,
    workflowFile: release?.workflowFile ?? null,
    commitSha: release?.commitSha ?? null,
    gitRef: release?.gitRef ?? null,
    artifactName: 'release-image-digests',
    releaseBinding: releaseBindingObject(release),
    issues: issues.map((issue) => redactReleaseRunTranscript(issue)),
  };
}

function failedReleaseRunResult(options, status, issue, details = {}) {
  const issues = Array.isArray(issue) ? issue : [issue];
  if (options?.json) {
    return jsonResult(status, releaseRunPayload({ ok: false, evidenceFile: options.evidenceFile, issues, ...details }));
  }
  if (issues.length === 1 && !details.asList) {
    return result(status, '', `Production release run evidence failed: ${redactReleaseRunTranscript(issues[0])}\n`);
  }
  return result(
    status,
    '',
    [
      `Production release run evidence failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
      ...issues.map((entry) => `- ${redactReleaseRunTranscript(entry)}`),
      '',
    ].join('\n'),
  );
}

function findEndOfCentralDirectory(zipBytes) {
  for (let offset = zipBytes.length - 22; offset >= 0; offset -= 1) {
    if (zipBytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return null;
}

function centralDirectoryEntries(zipBytes) {
  const endOffset = findEndOfCentralDirectory(zipBytes);
  if (endOffset === null) return [];

  const entryCount = zipBytes.readUInt16LE(endOffset + 10);
  let offset = zipBytes.readUInt32LE(endOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount && offset + 46 <= zipBytes.length; index += 1) {
    if (zipBytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = zipBytes.readUInt16LE(offset + 10);
    const compressedSize = zipBytes.readUInt32LE(offset + 20);
    const fileNameLength = zipBytes.readUInt16LE(offset + 28);
    const extraLength = zipBytes.readUInt16LE(offset + 30);
    const commentLength = zipBytes.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBytes.readUInt32LE(offset + 42);
    const name = zipBytes.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function localHeaderEntries(zipBytes) {
  const entries = [];
  let offset = 0;

  while (offset + 30 <= zipBytes.length && zipBytes.readUInt32LE(offset) === 0x04034b50) {
    const method = zipBytes.readUInt16LE(offset + 8);
    const compressedSize = zipBytes.readUInt32LE(offset + 18);
    const fileNameLength = zipBytes.readUInt16LE(offset + 26);
    const extraLength = zipBytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zipBytes.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataOffset = nameStart + fileNameLength + extraLength;
    entries.push({ name, method, compressedSize, localHeaderOffset: offset, dataOffset });
    offset = dataOffset + compressedSize;
  }

  return entries;
}

function extractZipFile(zipBytes, filename) {
  const centralEntry = centralDirectoryEntries(zipBytes).find((entry) => entry.name === filename);
  const entry = centralEntry ?? localHeaderEntries(zipBytes).find((candidate) => candidate.name === filename);
  if (!entry) {
    throw new Error(`release-image-digests artifact archive must contain ${filename}`);
  }

  let dataOffset = entry.dataOffset;
  if (typeof dataOffset !== 'number') {
    const localHeaderOffset = entry.localHeaderOffset;
    if (zipBytes.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`${filename} archive entry has an invalid local header`);
    }
    const fileNameLength = zipBytes.readUInt16LE(localHeaderOffset + 26);
    const extraLength = zipBytes.readUInt16LE(localHeaderOffset + 28);
    dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
  }

  const compressed = zipBytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return compressed.toString('utf8');
  if (entry.method === 8) return inflateRawSync(compressed).toString('utf8');
  throw new Error(`${filename} archive entry uses unsupported ZIP compression method ${entry.method}`);
}

function parseEnvManifest(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function validateArtifactManifest(manifestText, release, issues) {
  const manifest = parseEnvManifest(manifestText);
  if (manifest.get('CHARITYPILOT_DATABASE_COMPATIBILITY') !== 'p006-deadline-calendar-v1') {
    issues.push(
      'release-image-digests artifact CHARITYPILOT_DATABASE_COMPATIBILITY must equal p006-deadline-calendar-v1',
    );
  }
  const expectedBindings = [
    ['CHARITYPILOT_API_IMAGE', 'apiImage'],
    ['CHARITYPILOT_WEB_IMAGE', 'webImage'],
    ['CHARITYPILOT_MIGRATION_IMAGE', 'migrationImage'],
    ['CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL', 'webBuildNextPublicApiUrl'],
  ];

  for (const [envName, manifestKey] of expectedBindings) {
    const actual = manifest.get(envName);
    const expected = release?.imageDigestManifest?.[manifestKey];
    if (actual !== expected) {
      issues.push(`release-image-digests artifact ${envName} must match release.imageDigestManifest.${manifestKey}`);
    }
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
    if (argsWantJson(args)) {
      return jsonResult(2, {
        ok: false,
        repository,
        usage: usage().trim(),
        issues: [redactReleaseRunTranscript(error.message)],
      });
    }
    return result(2, '', `${usage()}${error.message}\n`);
  }

  if (typeof fetchImpl !== 'function') {
    return failedReleaseRunResult(options, 1, 'fetch is unavailable in this Node runtime.');
  }

  const evidencePath = resolve(process.cwd(), options.evidenceFile);
  if (!existsSync(evidencePath)) {
    return failedReleaseRunResult(options, 1, `evidence file not found: ${options.evidenceFile}`);
  }

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    return failedReleaseRunResult(options, 1, `evidence file is not valid JSON. ${error.message}`);
  }

  const issues = [];
  const runId = validateReleaseShape(evidence.release, issues);
  if (runId === null || issues.length > 0) {
    return failedReleaseRunResult(options, 1, issues, { runId, release: evidence.release, asList: true });
  }

  const headers = githubHeaders(processEnv);
  const apiBase = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  let releaseDigestArtifact = null;
  try {
    const workflowRun = await fetchJson(fetchImpl, apiBase, headers, 'workflow run');
    const artifacts = await fetchJson(fetchImpl, `${apiBase}/artifacts`, headers, 'workflow artifacts');
    validateWorkflowRun(workflowRun, evidence.release, issues);
    releaseDigestArtifact = validateArtifacts(artifacts, issues);
  } catch (error) {
    return failedReleaseRunResult(options, 1, error.message, { runId, release: evidence.release });
  }

  if (issues.length === 0 && releaseDigestArtifact) {
    try {
      const artifactArchive = await fetchBytes(fetchImpl, releaseDigestArtifact.archive_download_url, headers, 'release-image-digests artifact');
      validateArtifactManifest(extractZipFile(artifactArchive, 'release-image-digests.env'), evidence.release, issues);
    } catch (error) {
      return failedReleaseRunResult(options, 1, error.message, { runId, release: evidence.release });
    }
  }

  if (issues.length > 0) {
    return failedReleaseRunResult(options, 1, issues, { runId, release: evidence.release, asList: true });
  }

  if (options.json) {
    return jsonResult(0, releaseRunPayload({
      ok: true,
      evidenceFile: options.evidenceFile,
      runId,
      release: evidence.release,
    }));
  }

  return result(
    0,
    [
      `Production release run evidence passed: GitHub Actions run ${runId} matches release workflow metadata and has release-image-digests artifact.`,
      ...releaseBindingSummary(evidence.release),
      '',
    ].join('\n'),
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
