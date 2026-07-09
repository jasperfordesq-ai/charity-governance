#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderProductionLaunchEvidenceTemplate } from './generate-production-launch-evidence-template.mjs';

export const DEFAULT_LAUNCH_EVIDENCE_PATH = '.charitypilot-launch-evidence/production-launch-evidence.json';

function usage() {
  return [
    'Usage: node scripts/init-production-launch-evidence.mjs [--json] [--evidence-file <path>] [--force]',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    evidenceFile: DEFAULT_LAUNCH_EVIDENCE_PATH,
    force: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
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
      options.evidenceFile = arg.slice('--evidence-file='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function commandSet(evidenceFile) {
  return {
    status: `npm run check:production:evidence:status -- --evidence-file=${evidenceFile}`,
    statusJson: `npm run check:production:evidence:status -- --json --evidence-file=${evidenceFile}`,
    validate: `npm run check:production:evidence -- --evidence-file=${evidenceFile}`,
    validateJson: `npm run check:production:evidence -- --json --evidence-file=${evidenceFile}`,
  };
}

function renderJson(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function runInitProductionLaunchEvidenceFromArgs(args = process.argv.slice(2), runtime = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const cwd = runtime.cwd ?? process.cwd();
  const evidencePath = resolve(cwd, options.evidenceFile);
  if (existsSync(evidencePath) && !options.force) {
    if (options.json) {
      return result(1, renderJson({
        status: 'exists',
        evidenceFile: options.evidenceFile,
        error: `${options.evidenceFile} already exists`,
        nextAction: `Re-run with --force only when you intentionally want to replace ${options.evidenceFile}.`,
      }));
    }

    return result(
      1,
      '',
      `Production launch evidence init failed: ${options.evidenceFile} already exists. Use --force to replace it.\n`,
    );
  }

  mkdirSync(resolve(evidencePath, '..'), { recursive: true });
  writeFileSync(evidencePath, renderProductionLaunchEvidenceTemplate(), { encoding: 'utf8' });

  if (options.json) {
    return result(0, renderJson({
      status: options.force ? 'replaced' : 'created',
      evidenceFile: options.evidenceFile,
      gitPolicy: 'Keep this file out of git. Store only non-secret external evidence references.',
      commands: commandSet(options.evidenceFile),
    }));
  }

  return result(
    0,
    [
      `Wrote ${options.evidenceFile}`,
      'Keep this file out of git. Fill it with non-secret external evidence references, then run:',
      `  ${commandSet(options.evidenceFile).status}`,
      `  ${commandSet(options.evidenceFile).validate}`,
      '',
    ].join('\n'),
  );
}

function main() {
  const initResult = runInitProductionLaunchEvidenceFromArgs();
  if (initResult.stdout) process.stdout.write(initResult.stdout);
  if (initResult.stderr) process.stderr.write(initResult.stderr);
  process.exit(initResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
