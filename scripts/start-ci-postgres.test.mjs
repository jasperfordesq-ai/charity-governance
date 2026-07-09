import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCiPostgresFromArgs } from './start-ci-postgres.mjs';

test('CI PostgreSQL starter dry-run renders retried pull and health commands', async () => {
  const result = await runCiPostgresFromArgs(['--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docker pull postgres:16\.4-alpine/);
  assert.match(result.stdout, /docker rm -f charitypilot-ci-postgres/);
  assert.match(result.stdout, /docker run -d --name charitypilot-ci-postgres/);
  assert.match(result.stdout, /-p 127\.0\.0\.1:5432:5432/);
  assert.match(result.stdout, /docker exec charitypilot-ci-postgres pg_isready -U charitypilot -d charitypilot_ci/);
  assert.match(result.stdout, /Retries: 6/);
});

test('CI PostgreSQL starter rejects unknown options before Docker commands run', async () => {
  let commandCalls = 0;

  const result = await runCiPostgresFromArgs(['--dry-run', '--surprise'], {
    commandRunner() {
      commandCalls += 1;
      return { status: 0 };
    },
  });

  assert.equal(result.status, 2);
  assert.equal(commandCalls, 0);
  assert.match(result.stderr, /Unknown option: --surprise/);
  assert.match(result.stderr, /Usage: node scripts\/start-ci-postgres\.mjs \[--dry-run\]/);
});

test('CI PostgreSQL starter retries image pulls before starting the container', async () => {
  const commands = [];
  let pulls = 0;

  const result = await runCiPostgresFromArgs([], {
    env: {
      ...process.env,
      CHARITYPILOT_CI_POSTGRES_DOCKER_BIN: 'fake-docker',
      CHARITYPILOT_CI_POSTGRES_PULL_RETRIES: '2',
    },
    commandRunner(_command, args) {
      commands.push(args);
      if (args[0] === 'pull') {
        pulls += 1;
        return { status: pulls < 2 ? 1 : 0 };
      }
      return { status: 0 };
    },
    sleep: async () => {},
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(commands.map((command) => command[0]), ['pull', 'pull', 'rm', 'run', 'exec']);
  assert.equal(commands[0][1], 'postgres:16.4-alpine');
  assert.equal(commands[1][1], 'postgres:16.4-alpine');
});

test('CI PostgreSQL starter fails when readiness never succeeds', async () => {
  const commands = [];

  const result = await runCiPostgresFromArgs([], {
    env: {
      ...process.env,
      CHARITYPILOT_CI_POSTGRES_DOCKER_BIN: 'fake-docker',
      CHARITYPILOT_CI_POSTGRES_READY_TIMEOUT_MS: '20',
    },
    commandRunner(_command, args) {
      commands.push(args);
      return { status: args[0] === 'exec' ? 1 : 0 };
    },
    sleep: () => new Promise((resolve) => setTimeout(resolve, 25)),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not become ready/);
  assert.deepEqual(commands.map((command) => command[0]), ['pull', 'rm', 'run', 'exec']);
});
