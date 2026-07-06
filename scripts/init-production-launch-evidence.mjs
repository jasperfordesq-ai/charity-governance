#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderProductionLaunchEvidenceTemplate } from './generate-production-launch-evidence-template.mjs';

export const DEFAULT_LAUNCH_EVIDENCE_PATH = join('.charitypilot-launch-evidence', 'production-launch-evidence.json');

function usage() {
  return [
    'Usage: node scripts/init-production-launch-evidence.mjs [--evidence-file <path>] [--force]',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    evidenceFile: DEFAULT_LAUNCH_EVIDENCE_PATH,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
    return result(
      1,
      '',
      `Production launch evidence init failed: ${options.evidenceFile} already exists. Use --force to replace it.\n`,
    );
  }

  mkdirSync(resolve(evidencePath, '..'), { recursive: true });
  writeFileSync(evidencePath, renderProductionLaunchEvidenceTemplate(), { encoding: 'utf8' });

  return result(
    0,
    [
      `Wrote ${options.evidenceFile}`,
      'Keep this file out of git. Fill it with non-secret external evidence references, then run:',
      `  npm run check:production:evidence:status -- --evidence-file=${options.evidenceFile}`,
      `  npm run check:production:evidence -- --evidence-file=${options.evidenceFile}`,
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
