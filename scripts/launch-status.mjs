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
const EVIDENCE_VALIDATION_COMMAND = `npm run check:production:evidence -- --evidence-file=${DEFAULT_EVIDENCE_FILE}`;
const EVIDENCE_VALIDATION_JSON_COMMAND = `npm run check:production:evidence -- --json --evidence-file=${DEFAULT_EVIDENCE_FILE}`;

const DEPLOYED_BROWSER_QA = Object.freeze({
  requiredEnvironment: Object.freeze([
    'E2E_DEPLOYED_QA=true',
    'E2E_WEB_URL=https://app.charitypilot.ie',
    'E2E_API_URL=https://api.charitypilot.ie',
    'E2E_OWNER_EMAIL from the approved non-sensitive test workspace',
    'E2E_OWNER_PASSWORD from the approved non-sensitive test workspace',
  ]),
  responsiveCommand: 'npm run test:e2e:responsive',
  focusedResponsiveCommands: Object.freeze([
    'npm run test:e2e:responsive:public:desktop',
    'npm run test:e2e:responsive:public:mobile',
    'npm run test:e2e:responsive:dashboard:desktop',
    'npm run test:e2e:responsive:dashboard:mobile',
  ]),
  accessibilityCommand: 'npm run test:e2e -- tests/accessibility.spec.ts',
  crossBrowserResponsiveCommand: 'npm run test:e2e:deployed:responsive:cross-browser',
  crossBrowserAccessibilityCommand: 'npm run test:e2e:deployed:accessibility:cross-browser',
  iosSafariEvidence: 'Record real iOS Safari manual or cloud-device evidence for the promoted release.',
  evidenceTarget: 'Record outputs under browserQa.checks.* in the production launch evidence ledger.',
});

const PRODUCTION_LAUNCH_COMMANDS = Object.freeze({
  corePreflight: 'npm run check:production -- --production-env-file=.env.production',
  hosting: 'npm run check:production:hosting -- --production-env-file=.env.production',
  database: 'npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel',
  supabase: 'npm run check:production:supabase -- --production-env-file=.env.production',
  providers: 'npm run check:production:providers -- --production-env-file=.env.production',
  observability: 'npm run check:production:observability -- --production-env-file=.env.production',
  deployPreflight: 'npm run deploy:preflight -- --production-env-file=.env.production',
  deployProduction: 'npm run deploy:production -- --production-env-file=.env.production',
  rollbackRehearsal:
    'npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env',
  releaseRunEvidence:
    'npm run check:production:release-run -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
  finalEvidenceValidation:
    'npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json',
});

const RELEASE_IMAGE_PROMOTION = Object.freeze({
  githubEnvironment: 'production',
  requiredGitHubEnvironmentVariables: Object.freeze([
    'NEXT_PUBLIC_API_URL=https://api.charitypilot.ie',
    'NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co',
  ]),
  configureCommands: Object.freeze([
    'gh variable set NEXT_PUBLIC_API_URL --env production --body https://api.charitypilot.ie',
    'gh variable set NEXT_PUBLIC_SUPABASE_URL --env production --body https://<project-ref>.supabase.co',
  ]),
  workflowCommand: 'gh workflow run release-images.yml --ref master',
  watchCommand: 'gh run watch <release-run-id> --exit-status',
  evidenceArtifact: 'release-image-digests.env',
  evidenceTarget:
    'Copy digest-pinned CHARITYPILOT_*_IMAGE and CHARITYPILOT_WEB_BUILD_* values into the production secret source and release evidence ledger.',
});

const FINAL_SIGNOFF_REQUIREMENTS = Object.freeze({
  requiredRoles: Object.freeze(['engineering', 'operations', 'security', 'legalCompliance', 'business']),
  externalReviews: Object.freeze([
    'solicitor review',
    'governance review',
    'privacy review',
    'external penetration test',
    'critical/high findings remediated or formally accepted',
  ]),
  releaseBinding: 'Every final signoff evidence entry must bind to release.commitSha for the promoted release.',
  evidenceTarget: 'Record approvals under finalSignoff and finalSignoff.approvals.* in the production launch evidence ledger.',
  legalPosture: 'Review-ready, source-cited, and not legal advice; no legal-certainty or guarantee claims.',
});

const EXTERNAL_LAUNCH_EVIDENCE_GATES = Object.freeze([
  'Complete .charitypilot-launch-evidence/production-launch-evidence.json with all 85 machine-readable checks, including release, deploy, rollback, smoke, provider, backup/restore, and final signoff references.',
  'Run deployed browser QA and accessibility with E2E_DEPLOYED_QA=true against https://app.charitypilot.ie and https://api.charitypilot.ie; responsive QA can be one full npm run test:e2e:responsive run or all four focused route chunks, the Launch-Critical Route Inventory must prove every route in desktop, mobile, light-mode, and dark-mode evidence, and every browser QA evidence slot must bind to the exact promoted release.commitSha: browserQa.checks.browser-qa-completed, browserQa.checks.desktop-coverage, browserQa.checks.mobile-coverage, browserQa.checks.accessibility-coverage, browserQa.checks.cross-browser-coverage, browserQa.checks.ios-safari-device-coverage, and browserQa.checks.critical-flows.',
  'Record production provider, hosting/DNS/TLS, PostgreSQL, Supabase, scheduler, observability, Stripe, and Resend evidence outside git.',
  'Complete solicitor/governance/privacy review and external penetration test before real charity data.',
]);

const MISSING_VALUE_GROUPS = Object.freeze([
  {
    label: 'Hosting, DNS, TLS, and proxy',
    keys: [
      'TRUSTED_PROXY_ADDRESSES',
      'FRONTEND_URL',
      'NEXT_PUBLIC_API_URL',
      'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL',
      'AUTH_COOKIE_DOMAIN',
      'CADDY_ACME_EMAIL',
      'CHARITYPILOT_WEB_DOMAIN',
      'CHARITYPILOT_API_DOMAIN',
    ],
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
const TOTAL_LAUNCH_EVIDENCE_CHECKS = 85;
const TOTAL_FINAL_SIGNOFF_ROLES = 5;

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

function productionEnvAssignments(envContent) {
  const assignments = new Map();
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(\r?)$/);
    if (!m) continue;
    assignments.set(m[1], m[2].trim());
  }
  return assignments;
}

function productionValueIssueDetails(envContent) {
  const issues = new Map();
  for (const key of placeholderKeys(envContent)) {
    issues.set(key, {
      key,
      reason: 'placeholder',
      detail: 'Value still contains a REPLACE_ME placeholder.',
    });
  }

  const assignments = productionEnvAssignments(envContent);
  const expectedExactValues = [
    ['AUTH_COOKIE_DOMAIN', '.charitypilot.ie'],
    ['CHARITYPILOT_WEB_DOMAIN', 'app.charitypilot.ie'],
    ['CHARITYPILOT_API_DOMAIN', 'api.charitypilot.ie'],
  ];

  for (const [key, expectedValue] of expectedExactValues) {
    if (!assignments.has(key)) continue;
    const actualValue = assignments.get(key);
    if (actualValue !== expectedValue) {
      if (!issues.has(key)) {
        issues.set(key, {
          key,
          reason: 'canonical-drift',
          expected: expectedValue,
          detail: `Value must match the canonical production setting: ${expectedValue}.`,
        });
      }
    }
  }

  if (assignments.has('CADDY_ACME_EMAIL')) {
    const caddyEmail = assignments.get('CADDY_ACME_EMAIL') ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(caddyEmail) && !issues.has('CADDY_ACME_EMAIL')) {
      issues.set('CADDY_ACME_EMAIL', {
        key: 'CADDY_ACME_EMAIL',
        reason: 'invalid-email',
        detail: 'Value must be a real operations email address for certificate registration.',
      });
    }
  }

  return [...issues.values()];
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

function completionPercent(completed, total) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((Math.max(0, completed) / total) * 1000) / 10;
}

function evidenceLedgerCommands() {
  return {
    statusCommand: EVIDENCE_STATUS_COMMAND,
    jsonStatusCommand: EVIDENCE_STATUS_JSON_COMMAND,
    validationCommand: EVIDENCE_VALIDATION_COMMAND,
    jsonValidationCommand: EVIDENCE_VALIDATION_JSON_COMMAND,
  };
}

function buildLaunchProgress({ remainingKeys, evidenceLedger }) {
  const remainingProductionValues = Math.max(0, remainingKeys.length);
  const completedProductionValues = Math.max(0, TOTAL_EXPECTED_PRODUCTION_VALUES - remainingProductionValues);
  const completedEvidenceChecks =
    typeof evidenceLedger.completedChecks === 'number' ? Math.max(0, evidenceLedger.completedChecks) : 0;
  const totalEvidenceChecks =
    typeof evidenceLedger.totalChecks === 'number' ? Math.max(0, evidenceLedger.totalChecks) : TOTAL_LAUNCH_EVIDENCE_CHECKS;
  const approvedFinalSignoffs =
    typeof evidenceLedger.approvedFinalSignoffRoles === 'number' ? Math.max(0, evidenceLedger.approvedFinalSignoffRoles) : 0;
  const totalFinalSignoffRoles =
    typeof evidenceLedger.totalFinalSignoffRoles === 'number' ? Math.max(0, evidenceLedger.totalFinalSignoffRoles) : TOTAL_FINAL_SIGNOFF_ROLES;
  const evidenceCompleted =
    typeof evidenceLedger.completedChecks === 'number' && typeof evidenceLedger.totalChecks === 'number'
      ? {
          completed: completedEvidenceChecks,
          total: totalEvidenceChecks,
          remaining: Math.max(0, totalEvidenceChecks - completedEvidenceChecks),
        }
      : null;
  const finalSignoffs =
    typeof evidenceLedger.approvedFinalSignoffRoles === 'number' && typeof evidenceLedger.totalFinalSignoffRoles === 'number'
      ? {
          approved: approvedFinalSignoffs,
          total: totalFinalSignoffRoles,
          remaining: Math.max(0, totalFinalSignoffRoles - approvedFinalSignoffs),
        }
      : null;
  const strictLaunchGateCompleted = completedProductionValues + completedEvidenceChecks + approvedFinalSignoffs;
  const strictLaunchGateTotal = TOTAL_EXPECTED_PRODUCTION_VALUES + totalEvidenceChecks + totalFinalSignoffRoles;

  return {
    productionValues: {
      completed: completedProductionValues,
      total: TOTAL_EXPECTED_PRODUCTION_VALUES,
      remaining: remainingProductionValues,
    },
    evidenceChecks: evidenceCompleted,
    finalSignoffs,
    strictLaunchGates: {
      completed: strictLaunchGateCompleted,
      total: strictLaunchGateTotal,
      remaining: Math.max(0, strictLaunchGateTotal - strictLaunchGateCompleted),
    },
    percentages: {
      productionValues: completionPercent(completedProductionValues, TOTAL_EXPECTED_PRODUCTION_VALUES),
      evidenceChecks: completionPercent(completedEvidenceChecks, totalEvidenceChecks),
      finalSignoffs: completionPercent(approvedFinalSignoffs, totalFinalSignoffRoles),
      strictLaunchGates: completionPercent(strictLaunchGateCompleted, strictLaunchGateTotal),
    },
    approvedForLaunch: evidenceLedger.approvedForLaunch === true,
  };
}

function evidenceLedgerStatus(evidenceFileExists, evidenceContent) {
  if (!evidenceFileExists) {
    return {
      exists: false,
      headline: `${DEFAULT_EVIDENCE_FILE} has not been created yet.`,
      nextAction: 'Create it with:  npm run check:production:evidence:init',
      ...evidenceLedgerCommands(),
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
      ...evidenceLedgerCommands(),
    };
  } catch {
    return {
      exists: true,
      headline: `${DEFAULT_EVIDENCE_FILE} exists but is not valid launch evidence JSON yet.`,
      nextAction: `Fix the file or recreate it with:  npm run check:production:evidence:init -- --force`,
      ...evidenceLedgerCommands(),
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
      remainingKeyDetails: [],
      remainingKeyGroups: [],
      expectedProductionValueGroups: expectedProductionValueGroups(),
      evidenceLedger,
      deployedBrowserQa: DEPLOYED_BROWSER_QA,
      productionLaunchCommands: PRODUCTION_LAUNCH_COMMANDS,
      releaseImagePromotion: RELEASE_IMAGE_PROMOTION,
      finalSignoffRequirements: FINAL_SIGNOFF_REQUIREMENTS,
      launchProgress: buildLaunchProgress({ remainingKeys: EXPECTED_PRODUCTION_VALUE_KEYS, evidenceLedger }),
      externalEvidenceGates: EXTERNAL_LAUNCH_EVIDENCE_GATES,
      nextActions: [
        'Run:  npm run setup:production-env',
        'It creates .env.production and auto-generates the secret values for you.',
        'Read docs/LAUNCH-GUIDE.md for the provider accounts you will need.',
      ],
    };
  }

  const remainingKeyDetails = productionValueIssueDetails(state.envContent ?? '');
  const remainingKeys = remainingKeyDetails.map((issue) => issue.key);
  if (remainingKeys.length > 0) {
    return {
      phase: 'ENV_INCOMPLETE',
      headline: `.env.production exists but ${remainingKeys.length} value(s) still need real data.`,
      remainingKeys,
      remainingKeyDetails,
      remainingKeyGroups: groupRemainingKeys(remainingKeys),
      expectedProductionValueGroups: expectedProductionValueGroups(),
      evidenceLedger,
      deployedBrowserQa: DEPLOYED_BROWSER_QA,
      productionLaunchCommands: PRODUCTION_LAUNCH_COMMANDS,
      releaseImagePromotion: RELEASE_IMAGE_PROMOTION,
      finalSignoffRequirements: FINAL_SIGNOFF_REQUIREMENTS,
      launchProgress: buildLaunchProgress({ remainingKeys, evidenceLedger }),
      externalEvidenceGates: EXTERNAL_LAUNCH_EVIDENCE_GATES,
      nextActions: [
        'Open .env.production and resolve each listed value: replace placeholders, fill real provider values, or correct drifted TLS/cookie settings.',
        'docs/LAUNCH-GUIDE.md says where each value comes from (Stripe, Supabase, domain, hosting, TLS, and cookies).',
        'Then run:  npm run check:production -- --production-env-file=.env.production',
      ],
    };
  }

  return {
    phase: 'ENV_COMPLETE',
    headline: '.env.production has no remaining placeholders. Validate it next.',
    remainingKeys: [],
    remainingKeyDetails: [],
    remainingKeyGroups: [],
    expectedProductionValueGroups: [],
    evidenceLedger,
    deployedBrowserQa: DEPLOYED_BROWSER_QA,
    productionLaunchCommands: PRODUCTION_LAUNCH_COMMANDS,
    releaseImagePromotion: RELEASE_IMAGE_PROMOTION,
    finalSignoffRequirements: FINAL_SIGNOFF_REQUIREMENTS,
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
      remainingKeyDetails: state.remainingKeyDetails ?? [],
      remainingKeyGroups: state.remainingKeyGroups,
      expectedProductionValueGroups: state.expectedProductionValueGroups ?? [],
      launchProgress: state.launchProgress,
      nextActions: state.nextActions,
      evidenceLedger: state.evidenceLedger,
      deployedBrowserQa: state.deployedBrowserQa,
      productionLaunchCommands: state.productionLaunchCommands,
      releaseImagePromotion: state.releaseImagePromotion,
      finalSignoffRequirements: state.finalSignoffRequirements,
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
    const issueByKey = new Map((state.remainingKeyDetails ?? []).map((issue) => [issue.key, issue]));
    for (const key of state.remainingKeys) {
      const detail = issueByKey.get(key)?.detail;
      lines.push(`  - ${key}${detail ? `: ${detail}` : ''}`);
    }
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
      `  Production values: ${state.launchProgress.productionValues.completed} / ${state.launchProgress.productionValues.total} complete (${state.launchProgress.productionValues.remaining} remaining, ${state.launchProgress.percentages.productionValues}% complete)`,
    );
    if (state.launchProgress.evidenceChecks) {
      lines.push(
        `  Launch evidence checks: ${state.launchProgress.evidenceChecks.completed} / ${state.launchProgress.evidenceChecks.total} complete (${state.launchProgress.evidenceChecks.remaining} remaining, ${state.launchProgress.percentages.evidenceChecks}% complete)`,
      );
    }
    if (state.launchProgress.finalSignoffs) {
      lines.push(
        `  Final signoffs: ${state.launchProgress.finalSignoffs.approved} / ${state.launchProgress.finalSignoffs.total} approved (${state.launchProgress.finalSignoffs.remaining} remaining, ${state.launchProgress.percentages.finalSignoffs}% complete)`,
      );
    }
    lines.push(
      `  Strict launch gates: ${state.launchProgress.strictLaunchGates.completed} / ${state.launchProgress.strictLaunchGates.total} complete (${state.launchProgress.strictLaunchGates.remaining} remaining, ${state.launchProgress.percentages.strictLaunchGates}% complete)`,
    );
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
  lines.push(`  ${state.evidenceLedger.nextAction}`);
  lines.push(`  Strict validation:  ${state.evidenceLedger.validationCommand}`);
  lines.push(`  Strict validation JSON:  ${state.evidenceLedger.jsonValidationCommand}`);
  if (state.deployedBrowserQa) {
    lines.push('', 'Deployed browser QA:');
    lines.push('  Required environment:');
    for (const item of state.deployedBrowserQa.requiredEnvironment) lines.push(`    - ${item}`);
    lines.push(`  Responsive:  ${state.deployedBrowserQa.responsiveCommand}`);
    lines.push('  Focused responsive chunks:');
    for (const command of state.deployedBrowserQa.focusedResponsiveCommands) lines.push(`    - ${command}`);
    lines.push(`  Accessibility:  ${state.deployedBrowserQa.accessibilityCommand}`);
    lines.push(`  Cross-browser responsive:  ${state.deployedBrowserQa.crossBrowserResponsiveCommand}`);
    lines.push(`  Cross-browser accessibility:  ${state.deployedBrowserQa.crossBrowserAccessibilityCommand}`);
    lines.push(`  iOS Safari:  ${state.deployedBrowserQa.iosSafariEvidence}`);
    lines.push(`  Evidence target:  ${state.deployedBrowserQa.evidenceTarget}`);
  }
  if (state.productionLaunchCommands) {
    lines.push('', 'Production launch command sequence:');
    lines.push(`  Core preflight:  ${state.productionLaunchCommands.corePreflight}`);
    lines.push(`  Hosting/DNS/TLS:  ${state.productionLaunchCommands.hosting}`);
    lines.push(`  Database backup/restore:  ${state.productionLaunchCommands.database}`);
    lines.push(`  Supabase storage:  ${state.productionLaunchCommands.supabase}`);
    lines.push(`  Stripe/Resend providers:  ${state.productionLaunchCommands.providers}`);
    lines.push(`  Observability alerting:  ${state.productionLaunchCommands.observability}`);
    lines.push(`  Deploy preflight:  ${state.productionLaunchCommands.deployPreflight}`);
    lines.push(`  Deploy production:  ${state.productionLaunchCommands.deployProduction}`);
    lines.push(`  Rollback rehearsal:  ${state.productionLaunchCommands.rollbackRehearsal}`);
    lines.push(`  Release-run evidence:  ${state.productionLaunchCommands.releaseRunEvidence}`);
    lines.push(`  Final evidence validation:  ${state.productionLaunchCommands.finalEvidenceValidation}`);
  }
  if (state.releaseImagePromotion) {
    lines.push('', 'Release image promotion:');
    lines.push(`  GitHub environment:  ${state.releaseImagePromotion.githubEnvironment}`);
    lines.push('  Required GitHub environment variables:');
    for (const item of state.releaseImagePromotion.requiredGitHubEnvironmentVariables) lines.push(`    - ${item}`);
    lines.push('  Configure with:');
    for (const command of state.releaseImagePromotion.configureCommands) lines.push(`    - ${command}`);
    lines.push(`  Workflow:  ${state.releaseImagePromotion.workflowCommand}`);
    lines.push(`  Watch:  ${state.releaseImagePromotion.watchCommand}`);
    lines.push(`  Digest artifact:  ${state.releaseImagePromotion.evidenceArtifact}`);
    lines.push(`  Evidence target:  ${state.releaseImagePromotion.evidenceTarget}`);
  }
  if (state.finalSignoffRequirements) {
    lines.push('', 'Final signoff requirements:');
    lines.push(`  Required roles:  ${state.finalSignoffRequirements.requiredRoles.join(', ')}`);
    lines.push('  External reviews:');
    for (const review of state.finalSignoffRequirements.externalReviews) lines.push(`    - ${review}`);
    lines.push(`  Release binding:  ${state.finalSignoffRequirements.releaseBinding}`);
    lines.push(`  Evidence target:  ${state.finalSignoffRequirements.evidenceTarget}`);
    lines.push(`  Legal posture:  ${state.finalSignoffRequirements.legalPosture}`);
  }
  lines.push('', 'External launch evidence still required:');
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
