import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runLinuxPreflight } from './personal-server-linux-preflight.mjs';
import { validateLocalDockerEndpoint, validateLocalDockerRuntime } from './personal-server-docker-boundary.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');

function successfulExecute(command, args) {
  const key = `${command} ${args.join(' ')}`;
  if (key === 'node --version') return { status: 0, stdout: 'v24.0.0', stderr: '' };
  if (key === 'npm --version') return { status: 0, stdout: '11.11.0', stderr: '' };
  if (key.startsWith('git status ')) return { status: 0, stdout: '', stderr: '' };
  if (key === 'git branch --show-current') return { status: 0, stdout: 'master', stderr: '' };
  if (key === 'git rev-parse HEAD' || key.includes('refs/remotes/origin/master')) return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
  if (key === 'git remote get-url origin') return { status: 0, stdout: 'https://github.com/jasperfordesq-ai/charity-governance.git', stderr: '' };
  if (key.startsWith('docker context inspect ')) return { status: 0, stdout: 'unix:///var/run/docker.sock|false', stderr: '' };
  if (key.startsWith('docker info ')) return { status: 0, stdout: 'Ubuntu 24.04|linux', stderr: '' };
  if (key.startsWith('docker version ')) return { status: 0, stdout: '1.54', stderr: '' };
  if (key === 'docker compose version --short') return { status: 0, stdout: '2.33.1', stderr: '' };
  if (key === 'docker compose up --help') return { status: 0, stdout: '--wait --wait-timeout', stderr: '' };
  if (key.startsWith('docker ps -a --filter ')) return { status: 0, stdout: '', stderr: '' };
  if (key === 'docker network ls -q') return { status: 0, stdout: '', stderr: '' };
  if (/^docker (?:network|volume) inspect charitypilot-personal-server-/u.test(key)) return { status: 1, stdout: '', stderr: 'not found' };
  throw new Error(`Unexpected command: ${key}`);
}

test('Linux Docker boundary accepts only the local Unix socket and rejects overrides', () => {
  assert.equal(validateLocalDockerEndpoint({ endpoint: 'unix:///var/run/docker.sock', skipTlsVerify: 'false', platform: 'linux' }), true);
  assert.equal(validateLocalDockerRuntime({
    endpoint: 'unix:///var/run/docker.sock', skipTlsVerify: 'false', platform: 'linux',
    operatingSystem: 'Ubuntu 24.04', serverOs: 'linux', apiVersion: '1.54',
  }), true);
  assert.throws(
    () => validateLocalDockerEndpoint({ endpoint: 'tcp://example.test:2376', skipTlsVerify: 'false', platform: 'linux' }),
    /local Linux Docker Engine Unix socket/u,
  );
  assert.throws(
    () => validateLocalDockerEndpoint({ endpoint: 'unix:///var/run/docker.sock', skipTlsVerify: 'false', platform: 'linux' }, { DOCKER_HOST: 'unix:///var/run/docker.sock' }),
    /no remote-daemon overrides/u,
  );
});

test('complete Linux host preflight passes with a clean canonical source and local Docker', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-linux-preflight-${process.pid}`);
  rmSync(stateRoot, { recursive: true, force: true });
  const report = await runLinuxPreflight({
    repositoryRoot,
    stateRoot,
    platform: 'linux',
    architecture: 'x64',
    uid: 1000,
    executeImpl: successfulExecute,
    portAvailableImpl: async () => true,
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.every((check) => check.passed), true);
});

test('Linux host preflight rejects root and an occupied state directory', async () => {
  const report = await runLinuxPreflight({
    repositoryRoot,
    stateRoot: repositoryRoot,
    platform: 'linux',
    architecture: 'x64',
    uid: 0,
    executeImpl: successfulExecute,
    portAvailableImpl: async () => true,
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find((check) => check.name === 'system.operator')?.passed, false);
  assert.equal(report.checks.find((check) => check.name === 'state.external')?.passed, false);
});

test('Linux installer preserves the private appliance and recovery gates', () => {
  const installer = readFileSync(resolve(repositoryRoot, 'scripts/Install-CharityPilot.sh'), 'utf8');
  assert.match(installer, /^set -Eeuo pipefail$/m);
  assert.match(installer, /^umask 077$/m);
  assert.match(installer, /personal-server-linux-preflight\.mjs/u);
  assert.match(installer, /personal:server:init/u);
  assert.match(installer, /personal:server:backup/u);
  assert.match(installer, /personal:server:rehearse-restore/u);
  assert.match(installer, /personal:server:certify/u);
  assert.match(installer, /write_state ready/u);
  assert.doesNotMatch(installer, /docker compose|docker volume rm|docker system prune/u);
});

// ── replacement-host restore ────────────────────────────────────────────────
// Ported from Install-CharityPilot.ps1, which had this mode while the Linux
// installer did not - so a Linux host had no data-preserving deploy at all.

function runInstaller(args) {
  return spawnSync('bash', [resolve(repositoryRoot, 'scripts/Install-CharityPilot.sh'), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

test('Linux installer exposes the replacement-host restore contract', () => {
  const installer = readFileSync(resolve(repositoryRoot, 'scripts/Install-CharityPilot.sh'), 'utf8');
  for (const flag of ['--restore-recovery-set', '--recovery-key-file', '--source-origin', '--confirm', '--owner-password-file']) {
    assert.match(installer, new RegExp(flag.replace(/-/gu, '\-'), 'u'), `${flag} must be accepted`);
  }
  // The plan authenticates the set before any state is created, and the
  // installer must refuse a confirmation that does not match it.
  assert.match(installer, /bootstrap-restore-plan/u);
  assert.match(installer, /charitypilot-personal-replacement-restore-plan\/v1/u);
  assert.match(installer, /personal:server:bootstrap-restore/u);
  // bootstrap-restore refuses unless protected state already says so.
  assert.match(installer, /write_state restore-prepared/u);
  assert.match(installer, /replacement-restore/u);
  // A ready installation must not keep claiming a restore is under way.
  assert.match(installer, /write_state ready '' clear/u);
});

test('Linux installer adopts the supplied recovery key instead of minting one', () => {
  const installer = readFileSync(resolve(repositoryRoot, 'scripts/Install-CharityPilot.sh'), 'utf8');
  // A recovery set cannot be opened without the key that sealed it, so the
  // replacement branch must copy the supplied key, never generate a fresh one.
  const replacementBranch = installer.slice(
    installer.indexOf('if $replacement_restore; then\n  # Adopt the supplied key'),
    installer.indexOf('else\n  RECOVERY_KEY='),
  );
  assert.ok(replacementBranch.length > 0, 'the key-adoption branch must exist');
  assert.doesNotMatch(replacementBranch, /randomBytes/u, 'must not mint a key for a replacement host');
  assert.match(replacementBranch, /SUPPLIED_KEY/u);
  assert.match(installer, /\^\[0-9a-f\]\{64\}\$/u, 'the supplied key must be format-checked');
});

test('Linux installer rejects unsafe replacement-restore argument combinations', () => {
  const cases = [
    [['--source-origin', 'https://x', '--preflight-only'], /valid only with --restore-recovery-set/u],
    [['--recovery-key-file', '/etc/hostname', '--preflight-only'], /valid only with --restore-recovery-set/u],
    [['--restore-recovery-set', tmpdir(), '--preflight-only'], /requires --recovery-key-file and --source-origin/u],
    [
      ['--restore-recovery-set', tmpdir(), '--recovery-key-file', '/etc/hostname', '--source-origin', 'https://x'],
      /requires the exact --confirm value/u,
    ],
  ];
  for (const [args, expected] of cases) {
    const result = runInstaller(args);
    assert.equal(result.status, 2, `${args.join(' ')} must exit 2`);
    assert.match(result.stderr, expected);
  }
});

test('replacement-host restore proves the host is blank before Compose creates anything', () => {
  // preparePinnedRuntimeImages runs `docker compose run`, which materialises the
  // project's networks and volumes. Asserting their absence AFTER that could
  // never pass, so bootstrap-restore failed on every platform and
  // replacement-host recovery was impossible. Verified against a live host on
  // 2026-08-30: 0 networks before `compose run`, 2 after.
  const source = readFileSync(resolve(repositoryRoot, 'scripts/personal-server.mjs'), 'utf8');
  const assertAt = source.lastIndexOf('assertPersonalBootstrapResourcesAbsent(context);');
  const prepareAt = source.lastIndexOf('preparePinnedRuntimeImages(context);');
  const flagAt = source.lastIndexOf('resourceCreationAttempted = true;');
  assert.ok(assertAt > 0 && prepareAt > 0 && flagAt > 0, 'all three call sites must exist');
  assert.ok(
    assertAt < prepareAt,
    'the blank-host assertion must run before image preparation creates project resources',
  );
  // Image preparation creates resources, so anything failing after it must reach
  // the fail-closed cleanup rather than leaving networks and volumes behind.
  assert.ok(
    flagAt < prepareAt,
    'resourceCreationAttempted must be set before the first resource-creating step',
  );
});
