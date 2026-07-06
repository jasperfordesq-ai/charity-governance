#!/usr/bin/env node

// "Where am I, and what do I do next?" for the launch process. It inspects local
// state only (no secrets, no network) and prints the current phase plus the
// single next action. It deliberately does not claim the platform is launch-ready
// - the external gates (hosting, legal, pentest, sign-off) live in
// docs/LAUNCH-GUIDE.md and docs/production-launch-checklist.md.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeJsonFile, summarizeEvidence } from './production-launch-evidence-status.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DEFAULT_EVIDENCE_FILE = '.charitypilot-launch-evidence/production-launch-evidence.json';

const EXTERNAL_LAUNCH_EVIDENCE_GATES = Object.freeze([
  'Complete .charitypilot-launch-evidence/production-launch-evidence.json with all 85 machine-readable checks, including release, deploy, rollback, smoke, provider, backup/restore, and final signoff references.',
  'Run deployed browser QA and accessibility with E2E_DEPLOYED_QA=true against https://app.charitypilot.ie and https://api.charitypilot.ie; responsive QA can be one full npm run test:e2e:responsive run or all four focused route chunks, the Launch-Critical Route Inventory must prove every route in desktop, mobile, light-mode, and dark-mode evidence, accessibility output must be recorded in browserQa.checks.accessibility-coverage, cross-browser output in browserQa.checks.cross-browser-coverage, and real iOS Safari evidence in browserQa.checks.ios-safari-device-coverage.',
  'Record production provider, hosting/DNS/TLS, PostgreSQL, Supabase, scheduler, observability, Stripe, and Resend evidence outside git.',
  'Complete solicitor/governance/privacy review and external penetration test before real charity data.',
]);

function placeholderKeys(envContent) {
  const keys = [];
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(\r?)$/);
    if (m && /REPLACE_ME/.test(m[2])) keys.push(m[1]);
  }
  return keys;
}

function evidenceLedgerStatus(evidenceFileExists, evidenceContent) {
  if (!evidenceFileExists) {
    return {
      exists: false,
      headline: `${DEFAULT_EVIDENCE_FILE} has not been created yet.`,
      nextAction: 'Create it with:  npm run check:production:evidence:init',
    };
  }

  try {
    const evidence = JSON.parse(evidenceContent ?? '{}');
    const summary = summarizeEvidence(evidence);
    return {
      exists: true,
      completedChecks: summary.completedChecks,
      approvedForLaunch: evidence?.approvedForLaunch === true,
      finalSignoffStatus:
        typeof evidence?.finalSignoff?.status === 'string' && evidence.finalSignoff.status.trim().length > 0
          ? evidence.finalSignoff.status
          : 'missing',
      nextIncompleteChecks: summary.incompleteChecks.slice(0, 5),
      totalChecks: summary.totalChecks,
      headline: `${DEFAULT_EVIDENCE_FILE} exists. Checklist checks complete: ${summary.completedChecks} / ${summary.totalChecks}.`,
      nextAction: `Track progress with:  npm run check:production:evidence:status -- --evidence-file=${DEFAULT_EVIDENCE_FILE}`,
    };
  } catch {
    return {
      exists: true,
      headline: `${DEFAULT_EVIDENCE_FILE} exists but is not valid launch evidence JSON yet.`,
      nextAction: `Fix the file or recreate it with:  npm run check:production:evidence:init -- --force`,
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
      evidenceLedger,
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
      evidenceLedger,
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
    evidenceLedger,
    externalEvidenceGates: EXTERNAL_LAUNCH_EVIDENCE_GATES,
    nextActions: [
      'Run:  npm run check:production -- --production-env-file=.env.production',
      'If it passes, follow docs/production-runbook.md to deploy.',
      'Track launch evidence progress with:  npm run check:production:evidence:status -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
      'Remember the non-code gates in docs/production-launch-checklist.md:',
      '  legal policy approval, external penetration test, and the five sign-offs.',
    ],
  };
}

function main() {
  const envPath = join(repoRoot, '.env.production');
  const evidencePath = join(repoRoot, DEFAULT_EVIDENCE_FILE);
  const envExists = existsSync(envPath);
  const state = assessLaunchState({
    envExists,
    envContent: envExists ? readFileSync(envPath, 'utf8') : '',
    evidenceContent: existsSync(evidencePath) ? decodeJsonFile(evidencePath) : '',
    evidenceFileExists: existsSync(evidencePath),
  });

  console.log('CharityPilot launch status');
  console.log('==========================');
  console.log('');
  console.log(state.headline);
  console.log('');
  if (state.remainingKeys.length > 0) {
    console.log('Values still needed:');
    for (const key of state.remainingKeys) console.log(`  - ${key}`);
    console.log('');
  }
  console.log('Next:');
  for (const action of state.nextActions) console.log(`  ${action}`);
  console.log('');
  console.log('Evidence ledger:');
  console.log(`  ${state.evidenceLedger.headline}`);
  if (state.evidenceLedger.exists && typeof state.evidenceLedger.approvedForLaunch === 'boolean') {
    console.log(`  approvedForLaunch: ${state.evidenceLedger.approvedForLaunch ? 'true' : 'false'}`);
    console.log(`  finalSignoff: ${state.evidenceLedger.finalSignoffStatus}`);
  }
  if (state.evidenceLedger.nextIncompleteChecks?.length > 0) {
    console.log('  Next incomplete checks:');
    for (const check of state.evidenceLedger.nextIncompleteChecks) console.log(`    - ${check}`);
  }
  console.log(`  ${state.evidenceLedger.nextAction}`);
  console.log('');
  console.log('External launch evidence still required:');
  for (const gate of state.externalEvidenceGates) console.log(`  - ${gate}`);
  console.log('');
  console.log('Full map: docs/LAUNCH-GUIDE.md');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
