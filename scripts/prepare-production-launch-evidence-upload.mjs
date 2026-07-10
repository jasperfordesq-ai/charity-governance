#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const defaultEvidenceFile = '.charitypilot-launch-evidence/production-launch-evidence.json';
const defaultArtifactName = 'production-launch-evidence';
const defaultEvidenceFileName = 'production-launch-evidence.json';
const workflowDispatchInputWarningThreshold = 60000;
const artifactNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const evidenceFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

function usage() {
  return 'Usage: node scripts/prepare-production-launch-evidence-upload.mjs [--json] [--evidence-file <path>] [--artifact-name <name>] [--evidence-file-name <name>]\n';
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function validateWorkflowInputNames(options) {
  if (!artifactNamePattern.test(options.artifactName)) {
    throw new Error('--artifact-name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/');
  }
  if (!evidenceFileNamePattern.test(options.evidenceFileName)) {
    throw new Error('--evidence-file-name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json$/');
  }
}

function parseArgs(argv) {
  const options = {
    evidenceFile: defaultEvidenceFile,
    artifactName: defaultArtifactName,
    evidenceFileName: defaultEvidenceFileName,
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
    if (arg === '--artifact-name') {
      const value = argv[index + 1];
      if (!value) throw new Error('--artifact-name requires a value');
      options.artifactName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--artifact-name=')) {
      const value = arg.slice('--artifact-name='.length);
      if (!value) throw new Error('--artifact-name requires a value');
      options.artifactName = value;
      continue;
    }
    if (arg === '--evidence-file-name') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence-file-name requires a value');
      options.evidenceFileName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--evidence-file-name=')) {
      const value = arg.slice('--evidence-file-name='.length);
      if (!value) throw new Error('--evidence-file-name requires a value');
      options.evidenceFileName = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  validateWorkflowInputNames(options);

  return options;
}

function workflowInputsForEvidence(evidenceBuffer, options) {
  JSON.parse(evidenceBuffer.toString('utf8'));
  const evidenceJsonGzipBase64 = gzipSync(evidenceBuffer).toString('base64');
  return {
    evidence_json_gzip_base64: evidenceJsonGzipBase64,
    evidence_sha256: createHash('sha256').update(evidenceBuffer).digest('hex'),
    artifact_name: options.artifactName,
    evidence_file_name: options.evidenceFileName,
  };
}

export function prepareProductionLaunchEvidenceUploadFromArgs(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const evidencePath = resolve(process.cwd(), options.evidenceFile);
  if (!existsSync(evidencePath)) {
    return result(1, '', `Production launch evidence upload preparation failed: evidence file not found: ${options.evidenceFile}\n`);
  }

  let inputs;
  try {
    inputs = workflowInputsForEvidence(readFileSync(evidencePath), options);
  } catch (error) {
    return result(1, '', `Production launch evidence upload preparation failed: evidence file is not valid JSON. ${error.message}\n`);
  }

  if (options.json) {
    return result(0, `${JSON.stringify(inputs, null, 2)}\n`);
  }

  const warning =
    inputs.evidence_json_gzip_base64.length > workflowDispatchInputWarningThreshold
      ? [
          '',
          `Warning: compressed evidence input is ${inputs.evidence_json_gzip_base64.length} characters.`,
          'GitHub workflow_dispatch inputs may reject very large evidence ledgers; reduce transcript size or use a controlled operator artifact path if dispatch fails.',
        ]
      : [];

  return result(
    0,
    [
      'Prepared production launch evidence upload inputs.',
      `Evidence file: ${options.evidenceFile}`,
      `Artifact name: ${inputs.artifact_name}`,
      `Evidence file name: ${inputs.evidence_file_name}`,
      `SHA-256: ${inputs.evidence_sha256}`,
      `Compressed base64 characters: ${inputs.evidence_json_gzip_base64.length}`,
      '',
      'Run:',
      '  npm run prepare:production:evidence-upload -- --json | gh workflow run upload-production-launch-evidence.yml --ref master --json',
      '',
      'After the upload workflow succeeds, pass its run id to:',
      '  gh workflow run production-launch-evidence.yml --ref master -f evidence_artifact_run_id=UPLOAD_RUN_ID -f evidence_artifact_name=production-launch-evidence -f evidence_file_name=production-launch-evidence.json',
      ...warning,
      '',
    ].join('\n'),
  );
}

async function main() {
  const uploadResult = prepareProductionLaunchEvidenceUploadFromArgs();
  if (uploadResult.stdout) process.stdout.write(uploadResult.stdout);
  if (uploadResult.stderr) process.stderr.write(uploadResult.stderr);
  process.exit(uploadResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
