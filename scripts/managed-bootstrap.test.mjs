import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { bootstrapBinding, bootstrapContext, roles } from '../deploy/managed-bootstrap/binding.mjs';
import { startBootstrap } from '../deploy/managed-bootstrap/start.mjs';
import { compileBootstrapPlan } from './managed-bootstrap-plan.mjs';

export function bootstrapFixture(now = Date.now()) {
  const binding = { format: 1, provider: 'render', region: 'frankfurt', purpose: 'SYNTHETIC_IDENTITY_ONLY',
    bootstrapId: '11111111-1111-4111-8111-111111111111', installationId: 'synthetic',
    ownerId: 'tea-synthetic', environmentId: 'env-synthetic', sourceSha: '1'.repeat(40),
    expiresAt: new Date(now + 300000).toISOString(),
    names: Object.fromEntries(roles.map(role => [role, 'charitypilot-synthetic-' + role])) };
  return { format: 1, binding, image: { url: 'ghcr.io/jasperfordesq-ai/charitypilot-bootstrap@sha256:' + '7'.repeat(64),
    sourceSha: binding.sourceSha, bindingSha256: bootstrapBinding(binding, now).sha256, platform: 'linux/amd64' } };
}
function environment(raw, role) {
  const plan = compileBootstrapPlan(raw), body = plan.requests.find(item => item.role === role).body;
  return { ...Object.fromEntries(body.envVars.map(({ key, value }) => [key, value])),
    RENDER_SERVICE_ID: 'srv-' + 'a'.repeat(20),
    RENDER_SERVICE_TYPE: ({ gateway: 'web', web: 'pserv', api: 'pserv', scheduler: 'worker' })[role] };
}
const pin = raw => ({ sourceSha: raw.image.sourceSha, bindingSha256: raw.image.bindingSha256 });

test('bootstrap uses a separate expiring domain and snapshots caller metadata', () => {
  const raw = bootstrapFixture(), binding = bootstrapBinding(raw.binding), plan = compileBootstrapPlan(raw);
  raw.binding.names.web = 'changed';
  assert.equal(binding.record.names.web, 'charitypilot-synthetic-web');
  assert.equal(plan.requests[1].body.name, 'charitypilot-synthetic-web');
  assert.equal(binding.json.includes('srv-'), false);
  for (const flag of ['applyAuthorized', 'executionAuthorized', 'providerCompatibilityVerified',
    'imageProvenanceVerified', 'serviceIdentitiesVerified', 'applicationReady', 'billingStopGuaranteed']) assert.equal(plan[flag], false);
});
test('compiler emits four inert image requests and no secrets, overrides or fake identities', () => {
  const raw = bootstrapFixture(), plan = compileBootstrapPlan(raw);
  assert.deepEqual(plan.requests.map(v => v.body.type), ['web_service', 'private_service', 'private_service', 'background_worker']);
  for (const request of plan.requests) {
    const body = request.body;
    assert.equal(request.url, 'https://api.render.com/v1/services');
    assert.equal(body.autoDeployTrigger, 'off'); assert.equal(body.autoDeploy, undefined);
    assert.equal(body.serviceDetails.numInstances, 1); assert.equal(body.serviceDetails.preDeployCommand, undefined);
    assert.equal(body.secretFiles, undefined); assert.equal(body.serviceDetails.envSpecificDetails, undefined);
    assert.ok(body.envVars.every(v => !v.key.startsWith('RENDER_') && Object.hasOwn(v, 'value')));
    assert.equal(bootstrapContext(environment(raw, request.role), pin(raw)).role, request.role);
  }
});
test('expired, distant, malformed, extra-field and non-bootstrap bindings refuse', () => {
  const now = Date.now();
  for (const mutate of [v => { v.expiresAt = new Date(now).toISOString(); },
    v => { v.expiresAt = new Date(now + 3600001).toISOString(); }, v => { v.expiresAt = 'bad'; },
    v => { v.purpose = 'SYNTHETIC_MANAGED_REVIEW'; }, v => { v.format = 2; },
    v => { v.bootstrapId = ['11111111-1111-4111-8111-111111111111']; },
    v => { v.sourceSha = ['1'.repeat(40)]; }, v => { v.names.api = 'foreign-api'; },
    v => { v.serviceId = 'srv-' + 'a'.repeat(20); }, v => { v.names.extra = 'extra'; }]) {
    const raw = bootstrapFixture(now); mutate(raw.binding); assert.throws(() => bootstrapBinding(raw.binding, now), /refused/);
  }
});
test('mutable image tags, foreign namespaces, platform and immutable-pin substitution refuse', () => {
  for (const mutate of [v => { v.image.url = 'ghcr.io/jasperfordesq-ai/bootstrap:latest'; },
    v => { v.image.url = v.image.url.replace('jasperfordesq-ai', 'foreign'); },
    v => { v.image.sourceSha = '2'.repeat(40); }, v => { v.image.bindingSha256 = '2'.repeat(64); },
    v => { v.image.platform = 'linux/arm64'; }, v => { v.image.token = 'secret'; }]) {
    const raw = bootstrapFixture(); mutate(raw); assert.throws(() => compileBootstrapPlan(raw), /refused/);
  }
});
test('runtime refuses credentials, preloads, wrong role, port, provider identity or baked pin', () => {
  const raw = bootstrapFixture(), env = environment(raw, 'api');
  for (const key of ['DATABASE_URL', 'JWT_SECRET', 'SUPABASE_URL', 'AUTH_RECOVERY_SECRET',
    'AWS_REGION', 'READINESS_API_KEY', 'CONFLUENCE_CLIENT_ID', 'OTHER_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']) {
    assert.throws(() => bootstrapContext({ ...env, [key]: 'DO_NOT_ECHO' }, pin(raw)), /refused/);
  }
  for (const changed of [{ PORT: '80' }, { RENDER_SERVICE_TYPE: 'web' }, { RENDER_SERVICE_ID: 'fake' },
    { CHARITYPILOT_BUILD_COMMIT: '2'.repeat(40) }, { CHARITYPILOT_MANAGED_BOOTSTRAP_ROLE: 'worker' },
    { CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING: ' ' + env.CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING }]) {
    assert.throws(() => bootstrapContext({ ...env, ...changed }, pin(raw)), /refused/);
  }
  assert.throws(() => bootstrapContext(env, { ...pin(raw), bindingSha256: '9'.repeat(64) }), /refused/);
  assert.throws(() => bootstrapContext(env, null), /refused/);
});
test('real HTTP runtime serves only inert health; business, alternate path and method refuse', async () => {
  const raw = bootstrapFixture(), runtime = await startBootstrap(environment(raw, 'api'), pin(raw));
  try {
    for (const [path, method, expected] of [['/bootstrap-health', 'GET', 200], ['/api/v1/health', 'GET', 503],
      ['/login', 'GET', 503], ['/documents', 'GET', 503], ['/bootstrap-health?token=DO_NOT_ECHO', 'GET', 503],
      ['/bootstrap-health', 'POST', 503]]) {
      const response = await fetch('http://127.0.0.1:3002' + path, { method });
      assert.equal(response.status, expected); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { kind: 'CHARITYPILOT_INERT_BOOTSTRAP', applicationReady: false });
    }
  } finally { await runtime.stop(); }
});
test('expiry terminates the listener and inert worker without extending provider billing claims', async () => {
  for (const role of ['api', 'scheduler']) {
    const raw = bootstrapFixture(); raw.binding.expiresAt = new Date(Date.now() + 120).toISOString();
    raw.image.bindingSha256 = bootstrapBinding(raw.binding).sha256;
    const runtime = await startBootstrap(environment(raw, role), pin(raw));
    try {
      await new Promise(resolve => setTimeout(resolve, 180));
      if (role === 'api') await assert.rejects(fetch('http://127.0.0.1:3002/bootstrap-health'));
    } finally { await runtime.stop(); }
  }
});
test('CLI is bounded, stdin-only, redacted and does not accept an apply mode', () => {
  const raw = bootstrapFixture(), run = (input, args = ['--stdin']) => spawnSync(process.execPath,
    ['scripts/managed-bootstrap-plan.mjs', ...args], { input, encoding: 'utf8' });
  assert.equal(run(JSON.stringify(raw)).status, 0);
  for (const [input, args] of [['DO_NOT_ECHO', ['--stdin']], ['x'.repeat(8193), ['--stdin']],
    [Buffer.from([0xff]), ['--stdin']], [JSON.stringify(raw), ['--apply']]]) {
    const result = run(input, args); assert.equal(result.status, 1);
    assert.equal(result.stdout, ''); assert.equal(result.stderr.includes('DO_NOT_ECHO'), false);
  }
});
test('bootstrap Dockerfile copies only inert runtime helpers and has no app/package install', () => {
  const dockerfile = readFileSync(new URL('../deploy/managed-bootstrap/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /USER node/); assert.match(dockerfile, /mode:0o444/);
  assert.equal(/npm|apps\/|COPY \. |VOLUME|EXPOSE/.test(dockerfile), false);
});
