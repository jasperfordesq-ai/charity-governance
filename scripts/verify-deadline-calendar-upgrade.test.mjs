import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  discoverUpgradeMigrations,
  verifyDeadlineCalendarUpgrade,
} from './verify-deadline-calendar-upgrade.mjs';

test('P0-06 upgrade fixture discovers the complete historical boundary', () => {
  const plan = discoverUpgradeMigrations();

  assert.equal(plan.target, '20260710190000_add_deadline_calendar_lifecycle');
  assert.equal(plan.previous.at(-1), '20260710123000_add_compliance_revision_snapshots');
  assert.ok(plan.previous.includes('20260402114212_init'));
  assert.ok(plan.previous.includes('20260507190000_add_team_invites_and_reminder_logs'));
  assert.ok(!plan.previous.includes(plan.target));
});

test('P0-06 upgrade fixture dry-run is explicit and does not invoke Docker', async () => {
  let commandCalls = 0;
  let output = '';

  await verifyDeadlineCalendarUpgrade({
    args: ['--dry-run'],
    commandRunner() {
      commandCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
    stdout: {
      write(value) {
        output += value;
      },
    },
  });

  assert.equal(commandCalls, 0);
  assert.match(output, /Pre-P0-06 migrations: \d+/);
  assert.match(output, /Previous migration: 20260710123000_add_compliance_revision_snapshots/);
  assert.match(output, /Target migration: 20260710190000_add_deadline_calendar_lifecycle/);
  assert.match(output, /charitypilot_p006_upgrade_success/);
  assert.match(output, /charitypilot_p006_upgrade_invalid_date/);
});

test('P0-06 upgrade fixture rejects unknown CLI options before Docker', async () => {
  let commandCalls = 0;

  await assert.rejects(
    verifyDeadlineCalendarUpgrade({
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

test('CI runs the real P0-06 upgrade fixture before fresh-schema migration deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const startIndex = workflow.indexOf('name: Start PostgreSQL');
  const upgradeIndex = workflow.indexOf('name: Verify P0-06 upgrade from legacy PostgreSQL data');
  const deployIndex = workflow.indexOf('name: Deploy Prisma migrations');

  assert.notEqual(startIndex, -1);
  assert.notEqual(upgradeIndex, -1);
  assert.notEqual(deployIndex, -1);
  assert.ok(startIndex < upgradeIndex);
  assert.ok(upgradeIndex < deployIndex);
  assert.match(workflow.slice(upgradeIndex, deployIndex), /npm run db:verify:p006-upgrade/);
  assert.equal(
    packageJson.scripts['db:verify:p006-upgrade'],
    'node scripts/verify-deadline-calendar-upgrade.mjs',
  );
  assert.match(
    packageJson.scripts['test:production-check'],
    /scripts\/verify-deadline-calendar-upgrade\.test\.mjs/,
  );
});

test('release image publishing runs the historical P0-06 upgrade proof before migration images', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release-images.yml', import.meta.url),
    'utf8',
  );
  const startIndex = workflow.indexOf('name: Start PostgreSQL');
  const upgradeIndex = workflow.indexOf('name: Verify P0-06 upgrade from legacy PostgreSQL data');
  const migrationRunnerIndex = workflow.indexOf('name: Run migration runner against CI PostgreSQL');

  assert.notEqual(startIndex, -1);
  assert.notEqual(upgradeIndex, -1);
  assert.notEqual(migrationRunnerIndex, -1);
  assert.ok(startIndex < upgradeIndex);
  assert.ok(upgradeIndex < migrationRunnerIndex);
  assert.match(workflow.slice(upgradeIndex, migrationRunnerIndex), /npm run db:verify:p006-upgrade/);
});
