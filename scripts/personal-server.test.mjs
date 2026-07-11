import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  generateStrongOneTimePassword,
  parsePersonalServerArgs,
  parsePersonalServerEnv,
  renderPersonalServerEnv,
  runPersonalServer,
} from './personal-server.mjs';

const NOW = new Date('2026-07-11T12:00:00.000Z');

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, 0xab);
}

function validConfig() {
  return {
    port: '8080',
    origin: 'http://localhost:8080',
    postgresDatabase: 'charitypilot_personal_server',
    postgresUser: 'charitypilot_personal_server',
    postgresPassword: 'a'.repeat(64),
    jwtSecret: 'J'.repeat(64),
    readinessApiKey: 'R'.repeat(64),
    ownerEmail: 'owner@example.org',
    ownerName: 'Example Owner',
    organisationName: 'Example Charity',
  };
}

function withWorkspace(callback, { withEnv = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-personal-server-'));
  writeFileSync(join(root, 'compose.personal-server.yml'), 'name: charitypilot-personal-server\nservices: {}\n');
  if (withEnv) writeFileSync(join(root, '.env.personal-server'), renderPersonalServerEnv(validConfig()));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeExecutor(handler = () => null) {
  const calls = [];
  const spawn = (executable, args, options) => {
    const call = { command: [executable, ...args], options };
    calls.push(call);
    return handler(call, calls) ?? { status: 0, stdout: '', stderr: '' };
  };
  return { calls, spawn };
}

function runAt(root, args, executor, output) {
  return runPersonalServer({
    args,
    repoRoot: root,
    spawnSyncImpl: executor.spawn,
    randomBytesImpl: deterministicRandomBytes,
    now: () => new Date(NOW),
    writeOutput: (value) => output.push(value),
  });
}

function commandText(calls) {
  return calls.map((call) => call.command.join(' ')).join('\n');
}

test('argument parser exposes the safe command surface and rejects invented options', () => {
  assert.deepEqual(parsePersonalServerArgs(['help']), { command: 'help', options: {} });
  assert.deepEqual(
    parsePersonalServerArgs(['reset-link', '--email=director@example.org', '--dry-run']),
    { command: 'reset-link', options: { email: 'director@example.org', dryRun: true } },
  );
  assert.throws(() => parsePersonalServerArgs(['stop', '--volumes']), /Unknown option/);
  assert.throws(() => parsePersonalServerArgs(['reset-link', '--email']), /requires a value/);
  assert.throws(
    () => parsePersonalServerArgs(['backup', '--dry-run', '--dry-run']),
    /--dry-run may be provided only once/,
  );
  assert.throws(
    () => parsePersonalServerArgs(['start', '--help', '--help']),
    /--help may be provided only once/,
  );
});

test('generated environment contains strong distinct secrets but never an owner password', () => {
  const content = renderPersonalServerEnv(validConfig());
  const parsed = parsePersonalServerEnv(content);
  assert.equal(parsed.CHARITYPILOT_PERSONAL_SERVER_ORIGIN, 'http://localhost:8080');
  assert.equal(parsed.PERSONAL_SERVER_OWNER_EMAIL, 'owner@example.org');
  assert.equal(Object.hasOwn(parsed, 'PERSONAL_SERVER_OWNER_PASSWORD'), false);
  assert.doesNotMatch(content, /PASSWORD=.*owner/iu);

  const password = generateStrongOneTimePassword(deterministicRandomBytes);
  assert.match(password, /[A-Z]/u);
  assert.match(password, /[a-z]/u);
  assert.match(password, /[0-9]/u);
  assert.match(password, /[^A-Za-z0-9]/u);
});

test('init dry-run plans build, migration, initializer, and start without writing or revealing a password', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor();
    const output = [];
    runAt(root, [
      'init',
      '--owner-email=owner@example.org',
      '--owner-name=Example Owner',
      '--organisation-name=Example Charity',
      '--dry-run',
    ], executor, output);

    const text = output.join('');
    assert.equal(executor.calls.length, 0);
    assert.equal(existsSync(join(root, '.env.personal-server')), false);
    assert.match(text, /--profile personal-init build migrate/);
    assert.match(text, /--profile personal-init build api/);
    assert.match(text, /--profile personal-init build web/);
    assert.match(text, /--profile maintenance run --rm migrate/);
    assert.match(text, /PERSONAL_SERVER_OWNER_PASSWORD personal-init/);
    assert.match(text, /up -d --no-build --wait/);
    assert.doesNotMatch(text, /Cp!7|q6urq6ur/);
  }, { withEnv: false });
});

test('successful init stores no owner password and prints it only after every child succeeds', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor();
    const output = [];
    runAt(root, [
      'init',
      '--owner-email=owner@example.org',
      '--owner-name=Example Owner',
      '--organisation-name=Example Charity',
    ], executor, output);

    const envText = readFileSync(join(root, '.env.personal-server'), 'utf8');
    const text = output.join('');
    const match = /Generated Owner password \(shown once\): (\S+)/u.exec(text);
    assert.ok(match);
    assert.equal(text.split(match[1]).length - 1, 1);
    assert.equal(envText.includes(match[1]), false);
    assert.doesNotMatch(envText, /^PERSONAL_SERVER_OWNER_PASSWORD=/m);

    const initializer = executor.calls.find((call) => call.command.at(-1) === 'personal-init');
    assert.ok(initializer);
    assert.equal(initializer.command.includes(match[1]), false);
    assert.equal(initializer.options.env.PERSONAL_SERVER_OWNER_PASSWORD, match[1]);

    const commands = commandText(executor.calls);
    assert.ok(commands.indexOf('--profile personal-init build migrate') < commands.indexOf('--profile personal-init build api'));
    assert.ok(commands.indexOf('--profile personal-init build api') < commands.indexOf('--profile personal-init build web'));
    assert.ok(commands.indexOf('--profile personal-init build web') < commands.indexOf('--profile maintenance run --rm migrate'));
    assert.ok(commands.indexOf('--profile maintenance run --rm migrate') < commands.indexOf('PERSONAL_SERVER_OWNER_PASSWORD personal-init'));
    assert.ok(commands.indexOf('PERSONAL_SERVER_OWNER_PASSWORD personal-init') < commands.lastIndexOf('up -d --no-build'));
  }, { withEnv: false });
});

test('init failure never prints the generated owner password', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => (
      call.command.includes('up') ? { status: 1, stdout: '', stderr: 'failed' } : null
    ));
    const output = [];
    assert.throws(() => runAt(root, [
      'init',
      '--owner-email=owner@example.org',
      '--owner-name=Example Owner',
      '--organisation-name=Example Charity',
    ], executor, output), /failed/);
    assert.doesNotMatch(output.join(''), /Generated Owner password|Cp!7/);
    assert.doesNotMatch(readFileSync(join(root, '.env.personal-server'), 'utf8'), /^PERSONAL_SERVER_OWNER_PASSWORD=/m);
  }, { withEnv: false });
});

test('init reuses but never overwrites an existing environment file', () => {
  withWorkspace((root) => {
    const before = readFileSync(join(root, '.env.personal-server'), 'utf8');
    const executor = fakeExecutor();
    runAt(root, ['init'], executor, []);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), before);
  });
});

test('routine start cannot build, migrate, or seed and stop cannot delete volumes', () => {
  withWorkspace((root) => {
    const startExecutor = fakeExecutor();
    runAt(root, ['start'], startExecutor, []);
    const startCalls = startExecutor.calls.map((call) => call.command);
    assert.equal(startCalls.length, 2);
    assert.deepEqual(startCalls[0].slice(-2), ['config', '--quiet']);
    assert.ok(startCalls[1].includes('--no-build'));
    assert.equal(startCalls[1].includes('migrate'), false);
    assert.equal(startCalls[1].includes('personal-init'), false);

    const stopExecutor = fakeExecutor();
    runAt(root, ['stop'], stopExecutor, []);
    const stopCommand = stopExecutor.calls[0].command;
    assert.ok(stopCommand.includes('stop'));
    assert.equal(stopCommand.includes('down'), false);
    assert.equal(stopCommand.includes('-v'), false);
    assert.equal(stopCommand.includes('--volumes'), false);
  });
});

test('status reports only allowlisted service health and the configured nonsecret origin', () => {
  withWorkspace((root) => {
    const records = ['db', 'api', 'web', 'caddy']
      .map((Service) => JSON.stringify({ Service, State: 'running', Health: 'healthy' }))
      .join('\n');
    const executor = fakeExecutor((call) => (
      call.command.includes('--format') ? { status: 0, stdout: `${records}\n`, stderr: '' } : null
    ));
    const output = [];
    runAt(root, ['status'], executor, output);
    const text = output.join('');
    for (const service of ['db', 'api', 'web', 'caddy']) {
      assert.match(text, new RegExp(`${service}: state=running health=healthy`, 'u'));
    }
    assert.match(text, /origin: http:\/\/localhost:8080/u);
    assert.match(text, /latest completed recovery set in default root: none found/u);
    assert.doesNotMatch(text, /J{32}|R{32}|a{64}/u);
  });
});

test('backup dry-run shows quiesce, database verification, document copy, and verified restart order', () => {
  withWorkspace((root) => {
    const output = [];
    const executor = fakeExecutor();
    runAt(root, ['backup', '--dry-run'], executor, output);
    const text = output.join('');
    assert.equal(executor.calls.length, 0);
    assert.ok(text.indexOf('stop caddy web api') < text.indexOf('postgres-backup.mjs backup'));
    assert.ok(text.indexOf('postgres-backup.mjs backup') < text.indexOf('postgres-backup.mjs verify-restore'));
    assert.ok(text.indexOf('verify-restore') < text.indexOf(`volume inspect charitypilot-personal-server-documents`));
    assert.ok(text.indexOf('volume inspect') < text.indexOf('documents.tar'));
    assert.ok(text.indexOf('documents.tar') < text.lastIndexOf('up -d --no-build --wait'));
    assert.doesNotMatch(text, /J{32}|R{32}|a{64}/u);
    assert.equal(existsSync(join(root, '.charitypilot-backups')), false);
  });
});

test('backup failure restores previously running services and removes incomplete recovery data', () => {
  withWorkspace((root) => {
    const backupRoot = join(root, '.charitypilot-backups', 'personal-server');
    const executor = fakeExecutor((call) => {
      const text = call.command.join(' ');
      if (text.includes('ps --status running --services')) {
        return { status: 0, stdout: 'db\napi\nweb\ncaddy\n', stderr: '' };
      }
      if (text.includes('ps -q db')) return { status: 0, stdout: 'abcdef1234567890\n', stderr: '' };
      if (text.includes('postgres-backup.mjs backup')) return { status: 1, stdout: '', stderr: 'backup failed' };
      return null;
    });
    assert.throws(
      () => runAt(root, ['backup', `--output-dir=${backupRoot}`], executor, []),
      /postgres-backup\.mjs backup.*failed/s,
    );
    const commands = commandText(executor.calls);
    assert.ok(commands.indexOf('stop caddy web api') < commands.lastIndexOf('up -d --no-build --wait'));
    assert.deepEqual(readdirSync(backupRoot), []);
  });
});

test('update dry-run completes backup verification before build and migration', () => {
  withWorkspace((root) => {
    const output = [];
    runAt(root, ['update', '--dry-run'], fakeExecutor(), output);
    const text = output.join('');
    const verification = text.indexOf('postgres-backup.mjs verify-restore');
    const build = text.indexOf('--profile personal-init build migrate');
    const webBuild = text.indexOf('--profile personal-init build web');
    const migration = text.lastIndexOf('--profile maintenance run --rm migrate');
    assert.ok(verification >= 0 && verification < build && build < webBuild && webBuild < migration);
  });
});

test('reset-link prints a validated bearer URL only after successful child completion', () => {
  withWorkspace((root) => {
    const resetUrl = 'http://localhost:8080/reset-password#token=abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890';
    const expiresAt = '2026-07-11T13:00:00.000Z';
    const executor = fakeExecutor((call) => (
      call.command.at(-1) === 'reset-link'
        ? { status: 0, stdout: `${JSON.stringify({ resetLinkCreated: true, resetUrl, expiresAt })}\n`, stderr: '' }
        : null
    ));
    const output = [];
    const before = readFileSync(join(root, '.env.personal-server'), 'utf8');
    runAt(root, ['reset-link', '--email=director@example.org'], executor, output);
    const text = output.join('');
    assert.equal(text.split(resetUrl).length - 1, 1);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), before);
    const accountCall = executor.calls.find((call) => call.command.at(-1) === 'reset-link');
    assert.equal(accountCall.command.some((arg) => arg.includes('token=')), false);
    assert.equal(accountCall.options.env.PERSONAL_SERVER_ACCOUNT_EMAIL, 'director@example.org');
  });
});

test('reset-link failure with captured stdout never leaks a bearer URL', () => {
  withWorkspace((root) => {
    const secretUrl = 'http://localhost:8080/reset-password#token=secret_bearer_value';
    const executor = fakeExecutor((call) => (
      call.command.at(-1) === 'reset-link'
        ? { status: 1, stdout: secretUrl, stderr: 'account command failed' }
        : null
    ));
    const output = [];
    assert.throws(
      () => runAt(root, ['reset-link', '--email=director@example.org'], executor, output),
      /account command failed/,
    );
    assert.equal(output.join('').includes(secretUrl), false);
  });
});

test('emergency reset-password injects and prints its password only after success', () => {
  withWorkspace((root) => {
    const executor = fakeExecutor((call) => (
      call.command.at(-1) === 'reset-password'
        ? { status: 0, stdout: '{"passwordReset":true,"sessionsRevoked":2}\n', stderr: '' }
        : null
    ));
    const output = [];
    const before = readFileSync(join(root, '.env.personal-server'), 'utf8');
    runAt(root, ['reset-password', '--email=owner@example.org'], executor, output);
    const text = output.join('');
    const password = /Generated replacement password \(shown once\): (\S+)/u.exec(text)?.[1];
    assert.ok(password);
    assert.equal(text.split(password).length - 1, 1);
    assert.equal(readFileSync(join(root, '.env.personal-server'), 'utf8'), before);
    const accountCall = executor.calls.find((call) => call.command.at(-1) === 'reset-password');
    assert.equal(accountCall.command.includes(password), false);
    assert.equal(accountCall.options.env.PERSONAL_SERVER_ACCOUNT_PASSWORD, password);
  });
});
