#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FINAL_SIGNOFF_ROLES,
  REQUIRED_LAUNCH_AREAS,
  redactLaunchEvidenceTranscript,
} from './production-launch-evidence.mjs';
import { evidenceHints as defaultEvidenceHints } from './generate-production-launch-evidence-template.mjs';

const defaultEvidenceFile = '.charitypilot-launch-evidence/production-launch-evidence.json';
const releaseWorkflowFile = '.github/workflows/release-images.yml';
const releaseWorkflowRunPattern =
  /^https:\/\/github\.com\/jasperfordesq-ai\/charity-governance\/actions\/runs\/[0-9]+$/;
const releaseImagePatterns = Object.freeze({
  apiImage: /^ghcr\.io\/jasperfordesq-ai\/charity-governance-api@sha256:[a-f0-9]{64}$/,
  webImage: /^ghcr\.io\/jasperfordesq-ai\/charity-governance-web@sha256:[a-f0-9]{64}$/,
  migrationImage: /^ghcr\.io\/jasperfordesq-ai\/charity-governance-migrations@sha256:[a-f0-9]{64}$/,
});

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

function completionPercent(completed, total) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((Math.max(0, completed) / total) * 1000) / 10;
}

export function releaseBindingStatus(evidence) {
  const release = evidence?.release;
  const manifest = release?.imageDigestManifest;
  const missingFields = [];
  const commitSha = typeof release?.commitSha === 'string' && /^[a-f0-9]{40}$/.test(release.commitSha)
    ? release.commitSha
    : null;

  if (!commitSha) missingFields.push('release.commitSha');
  if (typeof release?.workflowRunUrl !== 'string' || !releaseWorkflowRunPattern.test(release.workflowRunUrl)) {
    missingFields.push('release.workflowRunUrl');
  }
  if (release?.workflowFile !== releaseWorkflowFile) missingFields.push('release.workflowFile');
  if (typeof release?.gitRef !== 'string' || !/^refs\/(?:heads\/master|tags\/v.+)$/.test(release.gitRef)) {
    missingFields.push('release.gitRef');
  }
  if (!manifest || typeof manifest !== 'object') {
    missingFields.push('release.imageDigestManifest');
  } else {
    for (const [key, pattern] of Object.entries(releaseImagePatterns)) {
      if (typeof manifest[key] !== 'string' || !pattern.test(manifest[key])) {
        missingFields.push(`release.imageDigestManifest.${key}`);
      }
    }
    if (typeof manifest.webBuildNextPublicApiUrl !== 'string' || manifest.webBuildNextPublicApiUrl !== 'https://api.charitypilot.ie') {
      missingFields.push('release.imageDigestManifest.webBuildNextPublicApiUrl');
    }
    if (typeof manifest.webBuildNextPublicSupabaseUrl !== 'string' || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(manifest.webBuildNextPublicSupabaseUrl)) {
      missingFields.push('release.imageDigestManifest.webBuildNextPublicSupabaseUrl');
    }
  }

  return {
    complete: missingFields.length === 0,
    commitSha,
    workflowRunUrl: typeof release?.workflowRunUrl === 'string' && releaseWorkflowRunPattern.test(release.workflowRunUrl)
      ? release.workflowRunUrl
      : null,
    missingFields,
    headline: missingFields.length === 0
      ? `Launch evidence is bound to release ${commitSha}.`
      : `Launch evidence is not bound to a concrete release artifact identity (${missingFields.length} field(s) missing or placeholder).`,
  };
}

export function summarizeEvidence(evidence) {
  const areaSummaries = [];
  const incompleteChecks = [];
  const incompleteCheckDetails = [];
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
        const path = `${area.id}.${check.id}`;
        const status = statusOf(actualCheck?.status);
        const storedHints = Array.isArray(actualCheck?.requiredEvidenceHints)
          ? actualCheck.requiredEvidenceHints.filter((hint) => typeof hint === 'string' && hint.trim().length > 0)
          : [];
        const hints = storedHints.length > 0 ? storedHints : defaultEvidenceHints(area.id, check.id);
        incompleteChecks.push(`${path} (${status})`);
        incompleteCheckDetails.push({
          path,
          label: check.label,
          status,
          requiredEvidenceHints: hints,
        });
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
    incompleteCheckDetails,
    incompleteChecks,
    percentages: {
      evidenceChecks: completionPercent(completedChecks, countChecks()),
      finalSignoffs: completionPercent(approvedFinalSignoffRoles, FINAL_SIGNOFF_ROLES.length),
    },
    totalFinalSignoffRoles: FINAL_SIGNOFF_ROLES.length,
    totalChecks: countChecks(),
  };
}

function renderStatus(evidence) {
  const summary = summarizeEvidence(evidence);
  const evidenceStatusesComplete = isEvidenceStatusComplete(evidence, summary);
  const releaseBinding = releaseBindingStatus(evidence);
  const lines = [
    'CharityPilot production launch evidence status',
    '==============================================',
    '',
    `Evidence statuses complete: ${evidenceStatusesComplete ? 'yes' : 'no'}`,
    `approvedForLaunch: ${evidence?.approvedForLaunch === true ? 'true' : 'false'}`,
    `finalSignoff: ${statusOf(evidence?.finalSignoff?.status)}`,
    `Final approval roles approved: ${summary.approvedFinalSignoffRoles} / ${summary.totalFinalSignoffRoles} (${summary.percentages.finalSignoffs}% complete)`,
    `Checklist checks complete: ${summary.completedChecks} / ${summary.totalChecks} (${summary.percentages.evidenceChecks}% complete)`,
    `Release binding: ${releaseBinding.headline}`,
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
    const nextDetails = summary.incompleteCheckDetails.slice(0, 10);
    for (const [index, check] of summary.incompleteChecks.slice(0, 10).entries()) {
      lines.push(`  - ${check}`);
      const hints = nextDetails[index]?.requiredEvidenceHints ?? [];
      if (hints.length > 0) {
        lines.push(`    evidence hints: ${hints.slice(0, 6).join('; ')}`);
      }
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
      releaseBinding: releaseBindingStatus(evidence),
      evidenceStatusesComplete: isEvidenceStatusComplete(evidence, summary),
      finalSignoffStatus: statusOf(evidence?.finalSignoff?.status),
      approvedFinalSignoffRoles: summary.approvedFinalSignoffRoles,
      totalChecks: summary.totalChecks,
      totalFinalSignoffRoles: summary.totalFinalSignoffRoles,
      percentages: summary.percentages,
      areas: summary.areaSummaries,
      pendingFinalSignoffRoles: summary.finalSignoffApprovals
        .filter((approval) => !approval.approved)
        .map((approval) => ({
          id: approval.id,
          label: approval.label,
          status: approval.status,
        })),
      nextIncompleteChecks: summary.incompleteChecks.slice(0, 10),
      nextIncompleteCheckDetails: summary.incompleteCheckDetails.slice(0, 10),
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
