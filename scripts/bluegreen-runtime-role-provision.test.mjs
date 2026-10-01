import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { deploymentVolumeNames, parseEnvFile } from './bluegreen-deploy.mjs';
import { writeState } from './bluegreen/lib.mjs';
import { assertProvisionDockerEndpoint, parseProvisionArgs, protectedDirectories, protectedRegularFile, provisionRuntimeRole } from './bluegreen-runtime-role-provision.mjs';

const oldCommit = 'a'.repeat(40);
const sourceCommit = 'b'.repeat(40);

function removeExactFixture(root, parent) {
  const resolvedRoot = realpathSync(root);
  const resolvedParent = realpathSync(parent);
  if (!resolvedRoot.startsWith(`${resolvedParent}${sep}`)) throw new Error('Fixture escaped its intended parent');
  rmSync(resolvedRoot, { recursive: true, force: true });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cp-provision-'));
  const stateDir = join(root, 'state');
  const receiptDir = join(root, 'receipts');
  mkdirSync(stateDir);
  mkdirSync(receiptDir);
  const ownerEnvFile = join(root, 'owner.env');
  const appEnvFile = join(root, 'app.env');
  writeFileSync(appEnvFile, 'DATABASE_URL=postgresql://runtime:synthetic-app-secret@db:5432/charitypilot\n');
  writeFileSync(ownerEnvFile, [
    'NODE_ENV=development',
    'DATABASE_URL=postgresql://charitypilot:synthetic-owner-secret@db:5432/charitypilot',
    `BLUEGREEN_ENV_FILE=${ownerEnvFile}`,
    `BLUEGREEN_APP_ENV_FILE=${appEnvFile}`,
    'BLUEGREEN_ORIGIN=http://127.0.0.1:8080',
    'BLUEGREEN_FRONT_PORT=8080',
    'READINESS_API_KEY=synthetic-readiness',
    'FRONTEND_URL=http://127.0.0.1:8080',
    'CHARITYPILOT_CANONICAL_WEB_ORIGIN=https://vm.tailnet.example',
    'CHARITYPILOT_CANONICAL_API_ORIGIN=https://vm.tailnet.example',
  ].join('\n') + '\n');
  writeState(stateDir, {
    activeColor: 'blue', commit: oldCommit,
    previousColor: null, previousCommit: null,
    deployedAt: new Date().toISOString(), rollbackable: true,
  });
  const args = ['provision', '--env-file', ownerEnvFile, '--state-dir', stateDir,
    '--receipt-dir', receiptDir];
  return { root, stateDir, receiptDir, ownerEnvFile, args };
}

test('role provision parser refuses ambiguous or relative target paths', () => {
  assert.throws(() => parseProvisionArgs(['provision', '--env-file', 'owner.env', '--receipt-dir', '/tmp/x']), /absolute/);
  assert.throws(() => parseProvisionArgs(['provision', '--env-file', '/tmp/x', '--receipt-dir', '/tmp/y', '--unknown']), /Unknown argument/);
});

test('Linux role provisioner only accepts the exact local Docker socket',
  { skip: process.platform !== 'linux' }, () => {
    assert.doesNotThrow(() => assertProvisionDockerEndpoint('unix:///var/run/docker.sock'));
    assert.throws(() => assertProvisionDockerEndpoint('tcp://127.0.0.1:2375'), /remote engines|local unix/);
    assert.throws(() => assertProvisionDockerEndpoint('unix:///tmp/alternate.sock'), /requires the Linux local/);
  });

test('role provision refuses ambient Docker authority before any child process', async () => {
  const f = fixture();
  try {
    let commands = 0;
    await assert.rejects(() => provisionRuntimeRole(f.args, {
      platform: 'linux', processEnv: { DOCKER_HOST: 'tcp://example.invalid:2375' },
      runCommand: async () => { commands++; return { stdout: '' }; },
      checkFile: () => {}, checkDirectories: () => {},
    }), /ambient overrides/);
    assert.equal(commands, 0);
  } finally { removeExactFixture(f.root, tmpdir()); }
});

test('role provision preserves a pending receipt on grant failure and resumes after backup rehearsal', async () => {
  const f = fixture();
  try {
    const volume = deploymentVolumeNames(parseEnvFile(f.ownerEnvFile)).db;
    const endpoint = 'unix:///var/run/docker.sock';
    const calls = [];
    let failGrant = true;
    let rolePresent = false;
    let roleSafe = true;
    let canonicalRemote = true;
    let backupCount = 0;
    let drillCount = 0;
    let mutateAfterDrill = false;
    const appFile = join(f.root, 'app.env');
    const originalAppEnv = readFileSync(appFile, 'utf8');
    const runCommand = async (command, options = {}) => {
      calls.push({ command, options });
      const joined = command.join(' ');
      if (joined.includes('context inspect')) return { stdout: `${JSON.stringify(endpoint)}\n` };
      if (command[0] === 'git' && command[1] === 'remote') {
        return { stdout: canonicalRemote
          ? 'https://github.com/jasperfordesq-ai/charity-governance.git\n'
          : 'https://example.invalid/other.git\n' };
      }
      if (command[0] === 'git' && command[1] === 'status') return { stdout: '' };
      if (command[0] === 'git' && command[1] === 'fetch') return { stdout: '' };
      if (command[0] === 'git' && command[1] === 'rev-parse') return { stdout: `${sourceCommit}\n` };
      if (joined.includes('ps --filter') && joined.includes('volume=')) return { stdout: '' };
      if (joined.includes('ps --status running -q db')) return { stdout: `${'c'.repeat(64)}\n` };
      if (joined.includes('inspect') && command.includes('c'.repeat(64))) {
        return { stdout: JSON.stringify([{
          Config: { Labels: { 'com.docker.compose.project': 'charitypilot-bluegreen',
            'com.docker.compose.service': 'db' } },
          Mounts: [{ Type: 'volume', Name: volume, Destination: '/var/lib/postgresql/data' }],
        }]) };
      }
      if (joined.includes("THEN 'present' ELSE 'absent'")) {
        return { stdout: rolePresent ? 'present\n' : 'absent\n' };
      }
      if (joined.includes("THEN 'safe' ELSE 'unsafe'")) {
        return { stdout: roleSafe ? 'safe\n' : 'unsafe\n' };
      }
      if (joined.includes('SELECT current_user')) return { stdout: 'runtime\n' };
      if (joined.includes('CHARITYPILOT_RUNTIME_ROLE=runtime')) {
        assert.ok(options.input?.startsWith('synthetic-app-secret\n'));
        assert.doesNotMatch(joined, /synthetic-app-secret/);
        if (failGrant) throw new Error('synthetic grant failure');
        return { stdout: '' };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };
    const runBackup = async () => {
      backupCount++;
      const dir = join(f.stateDir, 'backups', 'synthetic');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), '{"synthetic":true}');
      writeFileSync(join(dir, 'database.dump'), 'synthetic dump');
      writeFileSync(join(dir, 'documents.tar'), 'synthetic archive');
      return { plan: { dir, manifestFile: join(dir, 'manifest.json'),
        dumpFile: join(dir, 'database.dump'), documentsTar: join(dir, 'documents.tar') } };
    };
    const runRestoreDrill = async () => {
      drillCount++;
      if (mutateAfterDrill) {
        writeFileSync(appFile, 'DATABASE_URL=postgresql://runtime:changed-secret@db:5432/charitypilot\n');
        mutateAfterDrill = false;
      }
    };
    const deps = { platform: 'linux', processEnv: {}, runCommand, runBackup,
      runRestoreDrill, checkFile: () => {}, checkDirectories: () => {},
      checkDockerEndpoint: (value) => assert.equal(value, endpoint) };
    const preflight = await provisionRuntimeRole([...f.args, '--preflight'], deps);
    assert.equal(preflight.status, 'preflight');
    assert.equal(preflight.existingRole, 'absent');
    assert.equal(backupCount, 0);
    assert.equal(existsSync(join(f.receiptDir, 'runtime-role-provision-pending.json')), false);
    await assert.rejects(() => provisionRuntimeRole(f.args, deps), /synthetic grant failure/);
    const pendingPath = join(f.receiptDir, 'runtime-role-provision-pending.json');
    assert.ok(existsSync(pendingPath));
    assert.equal(backupCount, 1);
    assert.equal(drillCount, 1);
    writeState(f.stateDir, { activeColor: 'green', commit: 'd'.repeat(40),
      previousColor: 'blue', previousCommit: oldCommit,
      deployedAt: new Date().toISOString(), rollbackable: true });
    await assert.rejects(() => provisionRuntimeRole([...f.args, '--resume'], deps), /does not match/);
    writeState(f.stateDir, { activeColor: 'blue', commit: oldCommit,
      previousColor: null, previousCommit: null,
      deployedAt: new Date().toISOString(), rollbackable: true });
    mutateAfterDrill = true;
    await assert.rejects(() => provisionRuntimeRole([...f.args, '--resume'], deps), /env file changed after preflight/);
    writeFileSync(appFile, originalAppEnv);
    failGrant = false;
    const result = await provisionRuntimeRole([...f.args, '--resume'], deps);
    assert.equal(result.role, 'runtime');
    assert.equal(backupCount, 1);
    assert.equal(drillCount, 3);
    assert.equal(existsSync(pendingPath), false);
    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.sourceCommit, sourceCommit);
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic-app-secret|synthetic-owner-secret/);
    assert.ok(calls.every(({ command }) => !command.some((part) => part.includes('synthetic-app-secret'))));
    canonicalRemote = false;
    await assert.rejects(() => provisionRuntimeRole([...f.args, '--preflight'], deps), /canonical CharityPilot repository/);
    canonicalRemote = true;
    rolePresent = true;
    const existingPreflight = await provisionRuntimeRole([...f.args, '--preflight'], deps);
    assert.equal(existingPreflight.existingRole, 'present');
    assert.equal(backupCount, 1);
    roleSafe = false;
    await assert.rejects(() => provisionRuntimeRole(f.args, deps), /Existing application role is unsafe/);
    assert.equal(backupCount, 1, 'unsafe existing role must be refused before any new backup or write');
  } finally { removeExactFixture(f.root, tmpdir()); }
});

test('Linux provisioning paths require private real files and receipt ancestry',
  { skip: process.platform !== 'linux' }, () => {
    const root = mkdtempSync(join(homedir(), '.cp-provision-path-'));
    try {
      const stateDir = join(root, 'state');
      const receiptDir = join(root, 'receipts');
      const ownerFile = join(root, 'owner.env');
      mkdirSync(stateDir, { mode: 0o700 });
      mkdirSync(receiptDir, { mode: 0o700 });
      writeFileSync(ownerFile, 'synthetic', { mode: 0o600 });
      protectedRegularFile(ownerFile, 'Owner env file', 'linux');
      protectedDirectories({ stateDir, receiptDir });
      chmodSync(ownerFile, 0o644);
      assert.throws(() => protectedRegularFile(ownerFile, 'Owner env file', 'linux'), /owner-only/);
      chmodSync(receiptDir, 0o750);
      assert.throws(() => protectedDirectories({ stateDir, receiptDir }), /owner-only/);
    } finally {
      removeExactFixture(root, homedir());
    }
  });
