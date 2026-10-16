import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createManagedApiBuildPin } from '../packages/shared/runtime/managed-api-build-pin.mjs';

test('legacy images carry a disabled managed pin; opt-in requires full source and binding hashes', () => {
  assert.deepEqual(
    createManagedApiBuildPin({ CHARITYPILOT_BUILD_COMMIT: 'legacy-label' }),
    { format: 1, sourceSha: null, bindingSha256: null },
  );
  const env = {
    CHARITYPILOT_BUILD_COMMIT: '1'.repeat(40),
    CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256: '2'.repeat(64),
  };
  assert.deepEqual(createManagedApiBuildPin(env), {
    format: 1,
    sourceSha: env.CHARITYPILOT_BUILD_COMMIT,
    bindingSha256: env.CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256,
  });
  for (const patch of [
    { CHARITYPILOT_BUILD_COMMIT: 'main' },
    { CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256: 'wrong' },
    { CHARITYPILOT_BUILD_COMMIT: '' },
  ])
    assert.throws(() => createManagedApiBuildPin({ ...env, ...patch }));
});
test('API image generates the fixed root-owned pin before switching to node; source context cannot supply it', () => {
  const docker = readFileSync(
    new URL('../apps/api/Dockerfile', import.meta.url),
    'utf8',
  );
  assert.match(docker, /ARG CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256/);
  assert.ok(
    docker.indexOf(
      'RUN node packages/shared/runtime/managed-api-build-pin.mjs /opt/charitypilot/managed-api-build.json',
    ) < docker.lastIndexOf('USER node'),
  );
  assert.match(
    readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8'),
    /^\*\*\/managed-api-build\.json$/m,
  );
  for (const extension of ['pem', 'key']) {
    assert.ok(readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').includes('**/*.' + extension));
  }
  const server = readFileSync(
    new URL('../apps/api/src/server.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    server,
    /loadManagedApiRuntime\(process\.env, apiLoggerOptionsForEnvironment\(environment\)\)/,
  );
  assert.match(server, /validateRuntimeEnv\(managedApp\)/);
  assert.match(server, /managedApp \?\? Fastify\(/);
});
