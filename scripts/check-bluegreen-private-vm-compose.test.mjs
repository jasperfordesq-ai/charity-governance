import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readFixture = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8').replace(/\r\n?/g, '\n');
const override = readFixture('compose.bluegreen.private-vm.yml');
const personalServerCompose = readFixture('compose.personal-server.yml');
const DOCKER_COMPOSE_CONFIG_TIMEOUT_MS = 120_000;

test('the override redefines only volumes and the network — never a service', () => {
  assert.doesNotMatch(override, /^services:/m);
  assert.match(override, /^volumes:\n  bluegreen-db:\n    external: true\n    name: charitypilot-personal-server-db\n/m);
  assert.match(
    override,
    /^  bluegreen-documents:\n    external: true\n    name: charitypilot-personal-server-documents\n/m,
  );
  assert.match(override, /^networks:\n  bluegreen-internal:\n    ipam:\n      config:\n        - subnet: 172\.31\.250\.0\/24\n/m);
});

test('the external volume names are byte-identical to the appliance compose file’s own volume names', () => {
  for (const name of ['charitypilot-personal-server-db', 'charitypilot-personal-server-documents']) {
    assert.match(personalServerCompose, new RegExp(`^    name: ${name}$`, 'm'), `${name} must be the appliance's volume`);
  }
});

test('the pinned subnet does not overlap the appliance networks (both exist during the cutover)', () => {
  const applianceSubnets = [...personalServerCompose.matchAll(/subnet: (\d+\.\d+\.\d+\.\d+\/\d+)/g)].map((m) => m[1]);
  assert.ok(applianceSubnets.length >= 1);
  assert.equal(applianceSubnets.includes('172.31.250.0/24'), false);
});

test('docker compose config with both files renders the external appliance volumes and drops the scratch names', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'charitypilot-bluegreen-vm-compose-'));
  const envFile = join(scratchDir, 'bluegreen.env');
  writeFileSync(
    envFile,
    [
      'POSTGRES_DB=charitypilot_personal_server',
      'POSTGRES_USER=charitypilot_personal_server',
      'POSTGRES_PASSWORD=scratch-password',
      'DATABASE_URL=postgresql://charitypilot_personal_server:scratch-password@db:5432/charitypilot_personal_server',
      'JWT_SECRET=scratch-jwt-secret-at-least-32-characters-long',
      'AUTH_RECOVERY_SECRET=scratch-recovery-secret-at-least-32-characters',
      'READINESS_API_KEY=scratch-readiness-key',
      'FRONTEND_URL=https://vm.tailnet.example',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    BLUEGREEN_ENV_FILE: envFile,
    BLUEGREEN_BLUE_TAG: 'scratch-blue-commit',
    BLUEGREEN_GREEN_TAG: 'scratch-green-commit',
    BLUEGREEN_ACTIVE_TAG: 'scratch-blue-commit',
    BLUEGREEN_ORIGIN: 'https://vm.tailnet.example',
    BLUEGREEN_FRONT_PORT: '8080',
  };
  // A profile must be active for this assertion to mean anything: with no
  // profile selected, `docker compose config` on the Compose version
  // installed here (v5.3.1) prunes bluegreen-documents from the rendered
  // volumes section entirely, because only the profile-gated api-blue/
  // api-green services reference it (bluegreen-db survives unprofiled
  // because the always-on `db` service uses it). `--profile blue` mirrors
  // the pattern scripts/check-bluegreen-compose.test.mjs already uses to
  // exercise colour-scoped services.
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f', 'compose.bluegreen.yml',
      '-f', 'compose.bluegreen.private-vm.yml',
      '-p', 'charitypilot-bluegreen',
      '--profile', 'blue',
      'config',
    ],
    { cwd: repoRoot, encoding: 'utf8', env, timeout: DOCKER_COMPOSE_CONFIG_TIMEOUT_MS },
  );
  if (result.error?.code === 'EPERM' || result.error?.code === 'ENOENT') return; // no docker here; shape pinned above
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'docker compose config failed');
  assert.match(result.stdout, /name: charitypilot-personal-server-db\n\s+external: true|external: true\n\s+name: charitypilot-personal-server-db/);
  assert.match(result.stdout, /charitypilot-personal-server-documents/);
  assert.doesNotMatch(result.stdout, /charitypilot-bluegreen-db\b/);
  assert.doesNotMatch(result.stdout, /charitypilot-bluegreen-documents\b/);
  assert.match(result.stdout, /subnet: 172\.31\.250\.0\/24/);
  // Every api/web/scheduler documents mount still resolves to the (now external) bluegreen-documents key.
  assert.match(result.stdout, /source: bluegreen-documents\n\s+target: \/data\/documents/);
});
