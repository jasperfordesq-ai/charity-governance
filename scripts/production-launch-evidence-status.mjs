#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FINAL_SIGNOFF_ROLES,
  REQUIRED_LAUNCH_AREAS,
  redactLaunchEvidenceTranscript,
} from './production-launch-evidence.mjs';

const defaultEvidenceFile = '.charitypilot-launch-evidence/production-launch-evidence.json';

function usage() {
  return 'Usage: node scripts/production-launch-evidence-status.mjs [--json] [--evidence-file <path>]\n';
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

export function decodeJsonFile(path) {
  const bytes = readFileSync(path);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return swapped.toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }

  return bytes.toString('utf8');
}

function countChecks() {
  return REQUIRED_LAUNCH_AREAS.reduce((total, area) => total + area.checks.length, 0);
}

function statusOf(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : 'missing';
}

export function summarizeEvidence(evidence) {
  const areaSummaries = [];
  const incompleteChecks = [];
  let completedChecks = 0;
  let approvedFinalSignoffRoles = 0;

  for (const area of REQUIRED_LAUNCH_AREAS) {
    const actualArea = evidence?.areas?.[area.id];
    let areaCompleted = 0;

    for (const check of area.checks) {
      const actualCheck = actualArea?.checks?.[check.id];
      const isComplete = actualCheck?.status === 'complete';
      if (isComplete) {
        completedChecks += 1;
        areaCompleted += 1;
      } else {
        incompleteChecks.push(`${area.id}.${check.id} (${statusOf(actualCheck?.status)})`);
      }
    }

    areaSummaries.push({
      id: area.id,
      label: area.label,
      completed: areaCompleted,
      total: area.checks.length,
      status: statusOf(actualArea?.status),
    });
  }

  const finalSignoffApprovals = FINAL_SIGNOFF_ROLES.map((role) => {
    const approval = evidence?.finalSignoff?.approvals?.[role.id];
    const status = statusOf(approval?.status);
    const approved = status === 'approved';
    if (approved) approvedFinalSignoffRoles += 1;
    return {
      id: role.id,
      label: role.label,
      status,
      approved,
    };
  });

  return {
    areaSummaries,
    approvedFinalSignoffRoles,
    completedChecks,
    finalSignoffApprovals,
    incompleteChecks,
    totalFinalSignoffRoles: FINAL_SIGNOFF_ROLES.length,
    totalChecks: countChecks(),
  };
}

function renderStatus(evidence) {
  const summary = summarizeEvidence(evidence);
  const evidenceStatusesComplete = isEvidenceStatusComplete(evidence, summary);
  const lines = [
    'CharityPilot production launch evidence status',
    '==============================================',
    '',
    `Evidence statuses complete: ${evidenceStatusesComplete ? 'yes' : 'no'}`,
    `approvedForLaunch: ${evidence?.approvedForLaunch === true ? 'true' : 'false'}`,
    `finalSignoff: ${statusOf(evidence?.finalSignoff?.status)}`,
    `Final approval roles approved: ${summary.approvedFinalSignoffRoles} / ${summary.totalFinalSignoffRoles}`,
    `Checklist checks complete: ${summary.completedChecks} / ${summary.totalChecks}`,
    '',
    'Areas:',
  ];

  for (const area of summary.areaSummaries) {
    lines.push(`  - ${area.id}: ${area.completed} / ${area.total} complete (${area.status})`);
  }

  const pendingApprovals = summary.finalSignoffApprovals.filter((approval) => !approval.approved);
  if (pendingApprovals.length > 0) {
    lines.push('', 'Final approval roles still pending:');
    for (const approval of pendingApprovals) {
      lines.push(`  - ${approval.id}: ${approval.status}`);
    }
  }

  if (summary.incompleteChecks.length > 0) {
    lines.push('', 'Next incomplete checks:');
    for (const check of summary.incompleteChecks.slice(0, 10)) {
      lines.push(`  - ${check}`);
    }
    if (summary.incompleteChecks.length > 10) {
      lines.push(`  ... ${summary.incompleteChecks.length - 10} more`);
    }
  }

  lines.push('', `Final validator: npm run check:production:evidence -- --evidence-file=${defaultEvidenceFile}`, '');
  return lines.join('\n');
}

export function isEvidenceStatusComplete(evidence, summary = summarizeEvidence(evidence)) {
  return (
    evidence?.approvedForLaunch === true &&
    evidence?.finalSignoff?.status === 'approved' &&
    summary.completedChecks === summary.totalChecks &&
    summary.areaSummaries.every((area) => area.status === 'complete') &&
    summary.approvedFinalSignoffRoles === summary.totalFinalSignoffRoles
  );
}

function renderJsonStatus(evidence) {
  const summary = summarizeEvidence(evidence);
  return `${JSON.stringify(
    {
      approvedForLaunch: evidence?.approvedForLaunch === true,
      completedChecks: summary.completedChecks,
      evidenceStatusesComplete: isEvidenceStatusComplete(evidence, summary),
      finalSignoffStatus: statusOf(evidence?.finalSignoff?.status),
      approvedFinalSignoffRoles: summary.approvedFinalSignoffRoles,
      totalChecks: summary.totalChecks,
      totalFinalSignoffRoles: summary.totalFinalSignoffRoles,
      areas: summary.areaSummaries,
      pendingFinalSignoffRoles: summary.finalSignoffApprovals
        .filter((approval) => !approval.approved)
        .map((approval) => ({
          id: approval.id,
          label: approval.label,
          status: approval.status,
        })),
      nextIncompleteChecks: summary.incompleteChecks.slice(0, 10),
      incompleteCheckCount: summary.incompleteChecks.length,
    },
    null,
    2,
  )}\n`;
}

export function runProductionLaunchEvidenceStatusFromArgs(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  const evidencePath = resolve(process.cwd(), options.evidenceFile);
  if (!existsSync(evidencePath)) {
    return result(1, '', `Production launch evidence status failed: evidence file not found: ${redactLaunchEvidenceTranscript(options.evidenceFile)}\n`);
  }

  let evidence;
  try {
    evidence = JSON.parse(decodeJsonFile(evidencePath));
  } catch (error) {
    return result(
      1,
      '',
      `Production launch evidence status failed: evidence file is not valid JSON. ${redactLaunchEvidenceTranscript(error instanceof Error ? error.message : String(error))}\n`,
    );
  }

  return result(0, options.json ? renderJsonStatus(evidence) : renderStatus(evidence));
}

function main() {
  const statusResult = runProductionLaunchEvidenceStatusFromArgs();
  if (statusResult.stdout) process.stdout.write(statusResult.stdout);
  if (statusResult.stderr) process.stderr.write(statusResult.stderr);
  process.exit(statusResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
