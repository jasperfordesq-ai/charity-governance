import assert from 'node:assert/strict';
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
