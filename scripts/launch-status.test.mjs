import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assessLaunchState, groupRemainingKeys } from './launch-status.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertExternalLaunchEvidenceGates(state) {
  assert.ok(
    Array.isArray(state.externalEvidenceGates),
    'launch status must expose the external evidence gates separately from env placeholders',
  );
  const gates = state.externalEvidenceGates.join('\n');
  assert.match(gates, /production-launch-evidence\.json/);
  assert.match(gates, /85 machine-readable checks/);
  assert.match(gates, /browserQa\.checks\.accessibility-coverage/);
  assert.match(gates, /browserQa\.checks\.cross-browser-coverage/);
  assert.match(gates, /browserQa\.checks\.ios-safari-device-coverage/);
  assert.match(gates, /E2E_DEPLOYED_QA=true/);
  assert.match(gates, /all four focused route chunks/);
  assert.match(gates, /npm run test:e2e:responsive/);
  assert.match(gates, /Launch-Critical Route Inventory/);
  assert.match(gates, /every route in desktop, mobile, light-mode, and dark-mode evidence/);
  assert.match(gates, /solicitor\/governance\/privacy review/);
  assert.match(gates, /external penetration test/);
}

test('launch status script text is ASCII-safe for operator transcripts', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'launch-status.mjs'), 'utf8');

  assert.doesNotMatch(source, /[^\x00-\x7F]/);
  assert.match(source, /external gates/);
});

test('reports NO_ENV and points at the generator when .env.production is absent', () => {
  const s = assessLaunchState({ envExists: false, evidenceFileExists: false });
  assert.equal(s.phase, 'NO_ENV');
  assert.ok(s.nextActions.some((a) => a.includes('setup:production-env')));
  assert.equal(s.evidenceLedger.exists, false);
  assert.match(s.evidenceLedger.nextAction, /check:production:evidence:init/);
  assertExternalLaunchEvidenceGates(s);
});

test('reports ENV_INCOMPLETE and lists the unfilled keys', () => {
  const env = [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
    'STRIPE_SECRET_KEY=REPLACE_ME_STRIPE_LIVE_SECRET_KEY',
    'EMAIL_FROM=noreply@charitypilot.ie',
  ].join('\n');
  const s = assessLaunchState({ envExists: true, envContent: env, evidenceFileExists: true });
  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys.sort(), ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
  assert.deepEqual(s.remainingKeyGroups, [
    { label: 'PostgreSQL', keys: ['DATABASE_URL'] },
    { label: 'Stripe billing', keys: ['STRIPE_SECRET_KEY'] },
  ]);
  assert.equal(s.evidenceLedger.exists, true);
  assert.match(s.evidenceLedger.nextAction, /check:production:evidence:status/);
  assert.ok(s.nextActions.some((a) => a.includes('check:production')));
  assertExternalLaunchEvidenceGates(s);
});

test('groups missing production values by operator source', () => {
  assert.deepEqual(
    groupRemainingKeys([
      'CHARITYPILOT_WEB_IMAGE',
      'SUPABASE_SERVICE_ROLE_KEY',
      'UNKNOWN_VALUE',
      'STRIPE_WEBHOOK_SECRET',
      'TRUSTED_PROXY_ADDRESSES',
    ]),
    [
      { label: 'Hosting, DNS, TLS, and proxy', keys: ['TRUSTED_PROXY_ADDRESSES'] },
      { label: 'Stripe billing', keys: ['STRIPE_WEBHOOK_SECRET'] },
      { label: 'Supabase storage', keys: ['SUPABASE_SERVICE_ROLE_KEY'] },
      { label: 'Release image promotion', keys: ['CHARITYPILOT_WEB_IMAGE'] },
      { label: 'Other', keys: ['UNKNOWN_VALUE'] },
    ],
  );
});

test('reports launch evidence completion counts when the evidence ledger exists', () => {
  const env = [
    'NODE_ENV=production',
    'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
  ].join('\n');
  const s = assessLaunchState({
    envExists: true,
    envContent: env,
    evidenceFileExists: true,
    evidenceContent: JSON.stringify({ approvedForLaunch: false, finalSignoff: { status: 'pending' }, areas: {} }),
  });

  assert.equal(s.evidenceLedger.exists, true);
  assert.equal(s.evidenceLedger.completedChecks, 0);
  assert.equal(s.evidenceLedger.totalChecks, 85);
  assert.equal(s.evidenceLedger.approvedForLaunch, false);
  assert.equal(s.evidenceLedger.approvedFinalSignoffRoles, 0);
  assert.equal(s.evidenceLedger.finalSignoffStatus, 'pending');
  assert.equal(s.evidenceLedger.totalFinalSignoffRoles, 5);
  assert.deepEqual(s.evidenceLedger.nextIncompleteChecks.slice(0, 3), [
    'releaseGate.npm-ci (missing)',
    'releaseGate.db-generate (missing)',
    'releaseGate.prisma-validate (missing)',
  ]);
  assert.match(s.evidenceLedger.headline, /Checklist checks complete: 0 \/ 85/);
});

test('reports ENV_INCOMPLETE for CRLF production env files', () => {
  const env = [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'DATABASE_URL=REPLACE_ME_PRODUCTION_POSTGRES_URL_WITH_SSLMODE_REQUIRE',
    'READINESS_API_KEY=already-generated-readiness-key-1234567890',
  ].join('\r\n');
  const s = assessLaunchState({ envExists: true, envContent: env });
  assert.equal(s.phase, 'ENV_INCOMPLETE');
  assert.deepEqual(s.remainingKeys, ['DATABASE_URL']);
});

test('reports ENV_COMPLETE and surfaces the remaining non-code gates', () => {
  const env = [
    'NODE_ENV=production',
    'JWT_SECRET=already-generated-secret-value-1234567890',
    'DATABASE_URL=postgresql://u:p@db.example.com:5432/cp?sslmode=require',
  ].join('\n');
  const s = assessLaunchState({ envExists: true, envContent: env });
  assert.equal(s.phase, 'ENV_COMPLETE');
  assert.equal(s.remainingKeys.length, 0);
  assert.ok(s.nextActions.some((a) => a.includes('check:production')));
  assert.ok(s.nextActions.some((a) => a.includes('check:production:evidence:status')));
  assertExternalLaunchEvidenceGates(s);
  assert.ok(
    s.nextActions.some((a) => /penetration test|sign-off|checklist/i.test(a)),
    'must remind the operator that external gates remain',
  );
});
