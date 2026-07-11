import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  discoverTeamLifecycleUpgradeMigrations,
  verifyTeamLifecycleUpgrade,
} from './verify-team-lifecycle-upgrade.mjs';

test('P0-07 upgrade fixture discovers the exact historical boundary', () => {
  const plan = discoverTeamLifecycleUpgradeMigrations();

  assert.equal(plan.target, '20260711030000_add_team_lifecycle_security');
  assert.equal(plan.previous.at(-1), '20260710190000_add_deadline_calendar_lifecycle');
  assert.ok(plan.previous.includes('20260402114212_init'));
  assert.ok(plan.previous.includes('20260507203000_add_auth_sessions'));
  assert.ok(!plan.previous.includes(plan.target));
});

test('P0-07 upgrade fixture dry-run is explicit and never invokes Docker', async () => {
  let commandCalls = 0;
  let output = '';

  await verifyTeamLifecycleUpgrade({
    args: ['--dry-run'],
    commandRunner() {
      commandCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
    stdout: { write(value) { output += value; } },
  });

  assert.equal(commandCalls, 0);
  assert.match(output, /Pre-P0-07 migrations: \d+/);
  assert.match(output, /Previous migration: 20260710190000_add_deadline_calendar_lifecycle/);
  assert.match(output, /Target migration: 20260711030000_add_team_lifecycle_security/);
  assert.match(output, /charitypilot_p007_upgrade_zero_owner/);
  assert.match(output, /charitypilot_p007_upgrade_dual_invite/);
});

test('P0-07 upgrade fixture preserves migrations that own their transaction boundary', () => {
  const source = readFileSync(new URL('./verify-team-lifecycle-upgrade.mjs', import.meta.url), 'utf8');
  assert.match(source, /hasOwnTransaction/);
  assert.match(source, /hasOwnTransaction \? sql : `BEGIN;/);
});

test('P0-07 upgrade fixture rejects unknown options before Docker access', async () => {
  let commandCalls = 0;
  await assert.rejects(
    verifyTeamLifecycleUpgrade({
      args: ['--surprise'],
      commandRunner() {
        commandCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /Unknown option: --surprise/,
  );
  assert.equal(commandCalls, 0);
});

test('CI runs the real P0-07 historical upgrade before fresh migration deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const p006Index = workflow.indexOf('name: Verify P0-06 upgrade from legacy PostgreSQL data');
  const p007Index = workflow.indexOf('name: Verify P0-07 team lifecycle upgrade from legacy PostgreSQL data');
  const deployIndex = workflow.indexOf('name: Deploy Prisma migrations');

  assert.notEqual(p006Index, -1);
  assert.notEqual(p007Index, -1);
  assert.notEqual(deployIndex, -1);
  assert.ok(p006Index < p007Index);
  assert.ok(p007Index < deployIndex);
  assert.match(workflow.slice(p007Index, deployIndex), /npm run db:verify:p007-upgrade/);
  assert.equal(
    packageJson.scripts['db:verify:p007-upgrade'],
    'node scripts/verify-team-lifecycle-upgrade.mjs',
  );
  assert.match(
    packageJson.scripts['test:production-check'],
    /scripts\/verify-team-lifecycle-upgrade\.test\.mjs/,
  );
});

test('release image publishing proves P0-07 upgrade before running migration images', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release-images.yml', import.meta.url),
    'utf8',
  );
  const p006Index = workflow.indexOf('name: Verify P0-06 upgrade from legacy PostgreSQL data');
  const p007Index = workflow.indexOf('name: Verify P0-07 team lifecycle upgrade from legacy PostgreSQL data');
  const migrationRunnerIndex = workflow.indexOf('name: Run migration runner against CI PostgreSQL');

  assert.notEqual(p006Index, -1);
  assert.notEqual(p007Index, -1);
  assert.notEqual(migrationRunnerIndex, -1);
  assert.ok(p006Index < p007Index);
  assert.ok(p007Index < migrationRunnerIndex);
  assert.match(workflow.slice(p007Index, migrationRunnerIndex), /npm run db:verify:p007-upgrade/);
});
