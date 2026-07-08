#!/usr/bin/env node

// "Where am I, and what do I do next?" for the launch process. It inspects local
// state only (no secrets, no network) and prints the current phase plus the
// single next action. It deliberately does not claim the platform is launch-ready
// - the external gates (hosting, legal, pentest, sign-off) live in
// docs/LAUNCH-GUIDE.md and docs/production-launch-checklist.md.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OPERATOR_SUPPLIED_KEYS } from './generate-production-env.mjs';
import {
  decodeJsonFile,
  isEvidenceStatusComplete,
  releaseBindingStatus,
  summarizeEvidence,
} from './production-launch-evidence-status.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DEFAULT_EVIDENCE_FILE = '.charitypilot-launch-evidence/production-launch-evidence.json';
const EVIDENCE_STATUS_COMMAND = `npm run check:production:evidence:status -- --evidence-file=${DEFAULT_EVIDENCE_FILE}`;
const EVIDENCE_STATUS_JSON_COMMAND = `npm run check:production:evidence:status -- --json --evidence-file=${DEFAULT_EVIDENCE_FILE}`;

const EXTERNAL_LAUNCH_EVIDENCE_GATES = Object.freeze([
  'Complete .charitypilot-launch-evidence/production-launch-evidence.json with all 85 machine-readable checks, including release, deploy, rollback, smoke, provider, backup/restore, and final signoff references.',
  'Run deployed browser QA and accessibility with E2E_DEPLOYED_QA=true against https://app.charitypilot.ie and https://api.charitypilot.ie; responsive QA can be one full npm run test:e2e:responsive run or all four focused route chunks, the Launch-Critical Route Inventory must prove every route in desktop, mobile, light-mode, and dark-mode evidence and bind that critical-flow evidence to release.commitSha, accessibility output must be recorded in browserQa.checks.accessibility-coverage, cross-browser output in browserQa.checks.cross-browser-coverage, and real iOS Safari evidence in browserQa.checks.ios-safari-device-coverage.',
  'Record production provider, hosting/DNS/TLS, PostgreSQL, Supabase, scheduler, observability, Stripe, and Resend evidence outside git.',
  'Complete solicitor/governance/privacy review and external penetration test before real charity data.',
]);

const MISSING_VALUE_GROUPS = Object.freeze([
  {
    label: 'Hosting, DNS, TLS, and proxy',
    keys: ['TRUSTED_PROXY_ADDRESSES', 'FRONTEND_URL', 'NEXT_PUBLIC_API_URL', 'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL'],
  },
  {
    label: 'PostgreSQL',
    keys: ['DATABASE_URL'],
  },
  {
    label: 'Stripe billing',
    keys: [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
      'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
      'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
      'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
      'STRIPE_COMPLETE_YEARLY_PRICE_ID',
    ],
  },
  {
    label: 'Resend email',
    keys: ['RESEND_API_KEY'],
  },
  {
    label: 'Supabase storage',
    keys: [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
      'CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL',
    ],
  },
  {
    label: 'Observability',
    keys: ['ERROR_ALERT_WEBHOOK_URL'],
  },
  {
    label: 'Release image promotion',
    keys: [
      'CHARITYPILOT_API_IMAGE',
      'CHARITYPILOT_WEB_IMAGE',
      'CHARITYPILOT_MIGRATION_IMAGE',
      'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL',
      'CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL',
    ],
  },
]);
const OPERATOR_SUPPLIED_HINTS = new Map(OPERATOR_SUPPLIED_KEYS);
const EXPECTED_PRODUCTION_VALUE_KEYS = Object.freeze(OPERATOR_SUPPLIED_KEYS.map(([key]) => key));
const TOTAL_EXPECTED_PRODUCTION_VALUES = EXPECTED_PRODUCTION_VALUE_KEYS.length;

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
  };
}

function placeholderKeys(envContent) {
  const keys = [];
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(\r?)$/);
    if (m && /REPLACE_ME/.test(m[2])) keys.push(m[1]);
  }
  return keys;
}

export function groupRemainingKeys(keys) {
  const remaining = new Set(keys);
  const groups = [];

  for (const group of MISSING_VALUE_GROUPS) {
    const groupKeys = group.keys.filter((key) => remaining.has(key));
    if (groupKeys.length === 0) continue;
    for (const key of groupKeys) remaining.delete(key);
    groups.push({
      label: group.label,
      keys: groupKeys,
      items: groupKeys.map((key) => ({ key, hint: OPERATOR_SUPPLIED_HINTS.get(key) ?? 'Operator-supplied production value' })),
    });
  }

  if (remaining.size > 0) {
    const keys = [...remaining].sort();
    groups.push({
      label: 'Other',
      keys,
      items: keys.map((key) => ({ key, hint: OPERATOR_SUPPLIED_HINTS.get(key) ?? 'Operator-supplied production value' })),
    });
  }

  return groups;
}

function expectedProductionValueGroups() {
  return groupRemainingKeys(EXPECTED_PRODUCTION_VALUE_KEYS);
}

function buildLaunchProgress({ remainingKeys, evidenceLedger }) {
  const remainingProductionValues = Math.max(0, remainingKeys.length);
  const completedProductionValues = Math.max(0, TOTAL_EXPECTED_PRODUCTION_VALUES - remainingProductionValues);
  const evidenceCompleted =
    typeof evidenceLedger.completedChecks === 'number' && typeof evidenceLedger.totalChecks === 'number'
      ? {
          completed: evidenceLedger.completedChecks,
          total: evidenceLedger.totalChecks,
          remaining: Math.max(0, evidenceLedger.totalChecks - evidenceLedger.completedChecks),
        }
      : null;
  const finalSignoffs =
    typeof evidenceLedger.approvedFinalSignoffRoles === 'number' && typeof evidenceLedger.totalFinalSignoffRoles === 'number'
      ? {
          approved: evidenceLedger.approvedFinalSignoffRoles,
          total: evidenceLedger.totalFinalSignoffRoles,
          remaining: Math.max(0, evidenceLedger.totalFinalSignoffRoles - evidenceLedger.approvedFinalSignoffRoles),
        }
      : null;

  return {
    productionValues: {
      completed: completedProductionValues,
      total: TOTAL_EXPECTED_PRODUCTION_VALUES,
      remaining: remainingProductionValues,
    },
    evidenceChecks: evidenceCompleted,
    finalSignoffs,
    approvedForLaunch: evidenceLedger.approvedForLaunch === true,
  };
}

function evidenceLedgerStatus(evidenceFileExists, evidenceContent) {
  if (!evidenceFileExists) {
    return {
      exists: false,
      headline: `${DEFAULT_EVIDENCE_FILE} has not been created yet.`,
      nextAction: 'Create it with:  npm run check:production:evidence:init',
      statusCommand: EVIDENCE_STATUS_COMMAND,
      jsonStatusCommand: EVIDENCE_STATUS_JSON_COMMAND,
    };
  }

  try {
    const evidence = JSON.parse(evidenceContent ?? '{}');
    const summary = summarizeEvidence(evidence);
    return {
      exists: true,
      completedChecks: summary.completedChecks,
      approvedForLaunch: evidence?.approvedForLaunch === true,
      approvedFinalSignoffRoles: summary.approvedFinalSignoffRoles,
      evidenceStatusesComplete: isEvidenceStatusComplete(evidence, summary),
      finalSignoffStatus:
        typeof evidence?.finalSignoff?.status === 'string' && evidence.finalSignoff.status.trim().length > 0
          ? evidence.finalSignoff.status
          : 'missing',
      nextIncompleteChecks: summary.incompleteChecks.slice(0, 5),
      nextIncompleteCheckDetails: summary.incompleteCheckDetails.slice(0, 5),
      totalFinalSignoffRoles: summary.totalFinalSignoffRoles,
      totalChecks: summary.totalChecks,
      releaseBinding: releaseBindingStatus(evidence),
      headline: `${DEFAULT_EVIDENCE_FILE} exists. Checklist checks complete: ${summary.completedChecks} / ${summary.totalChecks}.`,
      nextAction: `Track progress with:  ${EVIDENCE_STATUS_COMMAND}`,
      statusCommand: EVIDENCE_STATUS_COMMAND,
      jsonStatusCommand: EVIDENCE_STATUS_JSON_COMMAND,
    };
  } catch {
    return {
      exists: true,
      headline: `${DEFAULT_EVIDENCE_FILE} exists but is not valid launch evidence JSON yet.`,
      nextAction: `Fix the file or recreate it with:  npm run check:production:evidence:init -- --force`,
      statusCommand: EVIDENCE_STATUS_COMMAND,
      jsonStatusCommand: EVIDENCE_STATUS_JSON_COMMAND,
    };
  }
}

/**
 * Decide the current launch phase from local state.
 * @param {{ envExists: boolean, envContent?: string, evidenceFileExists?: boolean, evidenceContent?: string }} state
 */
export function assessLaunchState(state) {
  const evidenceLedger = evidenceLedgerStatus(state.evidenceFileExists === true, state.evidenceContent);

  if (!state.envExists) {
    return {
      phase: 'NO_ENV',
      headline: 'You have not created a production environment file yet.',
      remainingKeys: [],
      remainingKeyGroups: [],
      expectedProductionValueGroups: expectedProductionValueGroups(),
      evidenceLedger,
      launchProgress: buildLaunchProgress({ remainingKeys: EXPECTED_PRODUCTION_VALUE_KEYS, evidenceLedger }),
      externalEvidenceGates: EXTERNAL_LAUNCH_EVIDENCE_GATES,
      nextActions: [
        'Run:  npm run setup:production-env',
        'It creates .env.production and auto-generates the secret values for you.',
        'Read docs/LAUNCH-GUIDE.md for the provider accounts you will need.',
      ],
    };
  }

  const remainingKeys = placeholderKeys(state.envContent ?? '');
  if (remainingKeys.length > 0) {
    return {
      phase: 'ENV_INCOMPLETE',
      headline: `.env.production exists but ${remainingKeys.length} value(s) still need real data.`,
      remainingKeys,
      remainingKeyGroups: groupRemainingKeys(remainingKeys),
      expectedProductionValueGroups: [],
      evidenceLedger,
      launchProgress: buildLaunchProgress({ remainingKeys, evidenceLedger }),
      externalEvidenceGates: EXTERNAL_LAUNCH_EVIDENCE_GATES,
      nextActions: [
        'Open .env.production and replace each REPLACE_ME value listed below.',
        'docs/LAUNCH-GUIDE.md says where each value comes from (Stripe, Supabase, domain, hosting).',
        'Then run:  npm run check:production -- --production-env-file=.env.production',
      ],
    };
  }

  return {
    phase: 'ENV_COMPLETE',
    headline: '.env.production has no remaining placeholders. Validate it next.',
    remainingKeys: [],
    remainingKeyGroups: [],
    expectedProductionValueGroups: [],
    evidenceLedger,
    launchProgress: buildLaunchProgress({ remainingKeys: [], evidenceLedger }),
    externalEvidenceGates: EXTERNAL_LAUNCH_EVIDENCE_GATES,
    nextActions: [
      'Run:  npm run check:production -- --production-env-file=.env.production',
      'If it passes, follow docs/production-runbook.md to deploy.',
      `Track launch evidence progress with:  ${EVIDENCE_STATUS_COMMAND}`,
      `For dashboards or operator handoff automation:  ${EVIDENCE_STATUS_JSON_COMMAND}`,
      'Remember the non-code gates in docs/production-launch-checklist.md:',
      '  legal policy approval, external penetration test, and the five sign-offs.',
    ],
  };
}

export function renderLaunchStatusJson(state) {
  return `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      phase: state.phase,
      headline: state.headline,
      remainingKeys: state.remainingKeys,
      remainingKeyGroups: state.remainingKeyGroups,
      expectedProductionValueGroups: state.expectedProductionValueGroups ?? [],
      launchProgress: state.launchProgress,
      nextActions: state.nextActions,
      evidenceLedger: state.evidenceLedger,
      externalEvidenceGates: state.externalEvidenceGates,
    },
    null,
    2,
  )}\n`;
}

function renderLaunchStatusText(state) {
  const lines = [];

  lines.push('CharityPilot launch status', '==========================', '', state.headline, '');
  if (state.remainingKeys.length > 0) {
    lines.push('Values still needed:');
    for (const key of state.remainingKeys) lines.push(`  - ${key}`);
    lines.push('', 'Values still needed by source:');
    for (const group of state.remainingKeyGroups ?? []) {
      lines.push(`  ${group.label}:`);
      for (const item of group.items ?? group.keys.map((key) => ({ key, hint: 'Operator-supplied production value' }))) {
        lines.push(`    - ${item.key}: ${item.hint}`);
      }
    }
    lines.push('');
  }
  if ((state.expectedProductionValueGroups?.length ?? 0) > 0) {
    lines.push('Production values you will need by source:');
    for (const group of state.expectedProductionValueGroups) {
      lines.push(`  ${group.label}:`);
      for (const item of group.items ?? group.keys.map((key) => ({ key, hint: 'Operator-supplied production value' }))) {
        lines.push(`    - ${item.key}: ${item.hint}`);
      }
    }
    lines.push('');
  }
  if (state.launchProgress) {
    lines.push('Progress summary:');
    lines.push(
      `  Production values: ${state.launchProgress.productionValues.completed} / ${state.launchProgress.productionValues.total} complete (${state.launchProgress.productionValues.remaining} remaining)`,
    );
    if (state.launchProgress.evidenceChecks) {
      lines.push(
        `  Launch evidence checks: ${state.launchProgress.evidenceChecks.completed} / ${state.launchProgress.evidenceChecks.total} complete (${state.launchProgress.evidenceChecks.remaining} remaining)`,
      );
    }
    if (state.launchProgress.finalSignoffs) {
      lines.push(
        `  Final signoffs: ${state.launchProgress.finalSignoffs.approved} / ${state.launchProgress.finalSignoffs.total} approved (${state.launchProgress.finalSignoffs.remaining} remaining)`,
      );
    }
    lines.push(`  approvedForLaunch: ${state.launchProgress.approvedForLaunch ? 'true' : 'false'}`, '');
  }
  lines.push('Next:');
  for (const action of state.nextActions) lines.push(`  ${action}`);
  lines.push('', 'Evidence ledger:', `  ${state.evidenceLedger.headline}`);
  if (state.evidenceLedger.exists && typeof state.evidenceLedger.approvedForLaunch === 'boolean') {
    lines.push(`  approvedForLaunch: ${state.evidenceLedger.approvedForLaunch ? 'true' : 'false'}`);
    lines.push(`  finalSignoff: ${state.evidenceLedger.finalSignoffStatus}`);
    lines.push(
      `  Final approval roles approved: ${state.evidenceLedger.approvedFinalSignoffRoles} / ${state.evidenceLedger.totalFinalSignoffRoles}`,
    );
    if (state.evidenceLedger.releaseBinding) {
      lines.push(`  Release binding: ${state.evidenceLedger.releaseBinding.headline}`);
    }
  }
  if (state.evidenceLedger.nextIncompleteChecks?.length > 0) {
    lines.push('  Next incomplete checks:');
    const nextDetails = state.evidenceLedger.nextIncompleteCheckDetails ?? [];
    for (const [index, check] of state.evidenceLedger.nextIncompleteChecks.entries()) {
      lines.push(`    - ${check}`);
      const hints = nextDetails[index]?.requiredEvidenceHints ?? [];
      if (hints.length > 0) {
        lines.push(`      evidence hints: ${hints.slice(0, 6).join('; ')}`);
      }
    }
  }
  lines.push(`  ${state.evidenceLedger.nextAction}`, '', 'External launch evidence still required:');
  for (const gate of state.externalEvidenceGates) lines.push(`  - ${gate}`);
  lines.push('', 'Full map: docs/LAUNCH-GUIDE.md', '');

  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const envPath = join(repoRoot, '.env.production');
  const evidencePath = join(repoRoot, DEFAULT_EVIDENCE_FILE);
  const envExists = existsSync(envPath);
  const state = assessLaunchState({
    envExists,
    envContent: envExists ? readFileSync(envPath, 'utf8') : '',
    evidenceContent: existsSync(evidencePath) ? decodeJsonFile(evidencePath) : '',
    evidenceFileExists: existsSync(evidencePath),
  });

  process.stdout.write(options.json ? renderLaunchStatusJson(state) : renderLaunchStatusText(state));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
