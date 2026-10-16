import assert from 'node:assert/strict';
import { after, before, test, mock } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import {
  createConfiguredManagedApiServer,
  managedApiRuntimePolicy,
} from '../services/managed-api-runtime.js';
import { validateProductionEnv } from '../utils/env.js';
import { AppError } from '../utils/app-error.js';
import { request, Agent } from 'node:https';
import { request as plainRequest } from 'node:http';
import {
  createManagedApiPeerBinding,
  createManagedApiPeerServer,
  managedApiPeerRole,
} from '../services/managed-api-peer-transport.js';

let directory: string;
let fixture: ReturnType<typeof makeFixture>;
const openssl =
  process.platform === 'win32'
    ? 'C:/Program Files/Git/usr/bin/openssl.exe'
    : 'openssl';
function run(args: string[]) {
  const result = spawnSync(openssl, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, 'synthetic OpenSSL fixture generation failed');
}
function certificate(
  name: string,
  issuer: string,
  serial: number,
  purpose: string,
  dns = name,
) {
  const key = join(directory, name + '.key'),
    csr = join(directory, name + '.csr'),
    cert = join(directory, name + '.pem');
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csr,
    '-subj',
    '/CN=' + name,
  ]);
  const ext = join(directory, name + '.ext');
  writeFileSync(
    ext,
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=' +
      purpose +
      '\nsubjectAltName=DNS:' +
      dns +
      '\n',
  );
  run([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    join(directory, issuer + '.pem'),
    '-CAkey',
    join(directory, issuer + '.key'),
    '-set_serial',
    String(serial),
    '-days',
    '1',
    '-extfile',
    ext,
    '-out',
    cert,
  ]);
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}
function makeFixture() {
  for (const name of ['ca', 'foreign'])
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, name + '.key'),
      '-out',
      join(directory, name + '.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=' + name,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
  const api = certificate(
    'charitypilot-review-api-ab12',
    'ca',
    1,
    'serverAuth',
  );
  const gateway = certificate('gateway', 'ca', 2, 'clientAuth'),
    web = certificate('web', 'ca', 3, 'clientAuth');
  const rogue = certificate('rogue', 'ca', 4, 'clientAuth'),
    foreign = certificate('outsider', 'foreign', 5, 'clientAuth');
  const wrongHost = certificate(
    'charitypilot-other-api-zz99',
    'ca',
    6,
    'serverAuth',
  );
  const wrongPurpose = certificate(
    'wrong-purpose',
    'ca',
    7,
    'clientAuth',
    'charitypilot-review-api-ab12',
  );
  const wrongClientPurpose = certificate(
    'wrong-client-purpose',
    'ca',
    8,
    'serverAuth',
  );
  const ca = readFileSync(join(directory, 'ca.pem'), 'utf8');
  const fingerprint = (pem: string) =>
    createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
  const record = {
    format: 1,
    provider: 'render',
    region: 'frankfurt',
    installationId: 'synthetic',
    ownerId: 'tea-synthetic',
    environmentId: 'env-synthetic',
    sourceSha: '1'.repeat(40),
    publicOrigin: 'https://managed.charitypilot.test',
    gatewayServiceId: 'srv-' + 'a'.repeat(20),
    webServiceId: 'srv-' + 'b'.repeat(20),
    apiServiceId: 'srv-' + 'c'.repeat(20),
    schedulerServiceId: 'srv-' + 'd'.repeat(20),
    apiHostname: 'charitypilot-review-api-ab12',
    issuerCertSha256: fingerprint(ca),
    apiCertSha256: fingerprint(api.cert),
    gatewayClientCertSha256: fingerprint(gateway.cert),
    webClientCertSha256: fingerprint(web.cert),
  };
  const binding = createManagedApiPeerBinding(record);
  const input = {
    recordJson: binding.json,
    build: { sourceSha: record.sourceSha, bindingSha256: binding.sha256 },
    runtime: {
      nodeEnv: 'production',
      provider: 'render',
      deploymentMode: 'production',
      serviceType: 'pserv',
      serviceId: record.apiServiceId,
      sourceSha: record.sourceSha,
      port: '3002',
    },
    issuerCertPem: ca,
    serverCertPem: api.cert,
    serverKeyPem: api.key,
  };
  return {
    api,
    gateway,
    web,
    rogue,
    foreign,
    wrongHost,
    wrongPurpose,
    wrongClientPurpose,
    ca,
    record,
    binding,
    input,
    fingerprint,
  };
}
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'charitypilot-managed-tls-'));
  fixture = makeFixture();
});
after(() => {
  if (directory) {
    const target = resolve(directory);
    assert.ok(
      target.startsWith(resolve(tmpdir()) + sep) &&
        basename(target).startsWith('charitypilot-managed-tls-'),
    );
    rmSync(target, { recursive: true, force: true });
  }
});

async function start(input = fixture.input) {
  const app = createManagedApiPeerServer(input);
  let reached = 0;
  app.all('/*', async (req) => {
    reached++;
    return { role: managedApiPeerRole(req), ip: req.ip, headers: req.headers };
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = (
    peer: typeof fixture.gateway | undefined,
    path = '/api/v1/records',
    options: Record<string, unknown> = {},
  ) =>
    new Promise<{
      status: number;
      body: Record<string, unknown>;
      protocol: string | null;
      sessionReused: boolean;
    }>((resolveCall, reject) => {
      const req = request(
        url + path,
        {
          ca: fixture.ca,
          servername: fixture.record.apiHostname,
          cert: peer?.cert,
          key: peer?.key,
          agent: false,
          minVersion: 'TLSv1.3',
          timeout: 3000,
          headers: {
            'x-forwarded-for': '203.0.113.44',
            'x-forwarded-host': 'evil.example',
            forwarded: 'for=evil',
            'x-charitypilot-peer-role': 'gateway',
            cookie: 'charitypilot_access=synthetic',
            authorization: 'Bearer synthetic',
            origin: fixture.record.publicOrigin,
          },
          ...options,
        },
        (res) => {
          const chunks: Buffer[] = [];
          const protocol = (
            res.socket as import('node:tls').TLSSocket
          ).getProtocol();
          const sessionReused = (
            res.socket as import('node:tls').TLSSocket
          ).isSessionReused();
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolveCall({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
              protocol,
              sessionReused,
            }),
          );
        },
      );
      req.on('error', reject);
      req.on('timeout', () =>
        req.destroy(new Error('Synthetic TLS request deadline')),
      );
      req.end();
    });
  return { app, call, url, reached: () => reached };
}

test('actual Fastify mutual TLS pins the gateway leaf and discards forwarded claims', async () => {
  const s = await start();
  try {
    const r = await s.call(fixture.gateway);
    assert.equal(r.status, 200);
    assert.equal(r.protocol, 'TLSv1.3');
    assert.equal(r.body.role, 'gateway');
    assert.equal(r.body.ip, '127.0.0.1');
    const headers = r.body.headers as Record<string, unknown>;
    for (const key of [
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-charitypilot-peer-role',
    ])
      assert.equal(headers[key], undefined);
    assert.equal(headers.cookie, 'charitypilot_access=synthetic');
    assert.equal(headers.authorization, 'Bearer synthetic');
    assert.equal(headers.origin, fixture.record.publicOrigin);
  } finally {
    await s.app.close();
  }
});
test('the private web leaf permits only the exact read-only auth-me request', async () => {
  const s = await start();
  try {
    assert.equal((await s.call(fixture.web, '/api/v1/auth/me')).status, 200);
    for (const path of [
      '/api/v1/records',
      '/api/v1/auth/me?extra=1',
      '/api/v1/auth/me/',
    ])
      assert.equal((await s.call(fixture.web, path)).status, 403);
    assert.equal(
      (await s.call(fixture.web, '/api/v1/auth/me', { method: 'POST' })).status,
      403,
    );
    assert.equal(s.reached(), 1);
  } finally {
    await s.app.close();
  }
});
test('missing, foreign and unpinned same-issuer clients cannot reach an application handler', async () => {
  const s = await start();
  try {
    await assert.rejects(s.call(undefined));
    await assert.rejects(s.call(fixture.foreign));
    const rogue = await s.call(fixture.rogue);
    assert.equal(rogue.status, 403);
    assert.equal(rogue.body.code, 'MANAGED_PEER_REFUSED');
    await assert.rejects(
      s.call(fixture.gateway, '/api/v1/records', {
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      }),
    );
    assert.equal(s.reached(), 0);
  } finally {
    await s.app.close();
  }
});
test('plaintext, resumed TLS and a leaf expired after startup cannot pass the peer hook', async () => {
  const s = await start(),
    agent = new Agent({ keepAlive: false, maxCachedSessions: 1 });
  try {
    const plain = await new Promise<number>((resolvePlain) => {
      const req = plainRequest(
        s.url.replace('https:', 'http:') + '/api/v1/records',
        { timeout: 2000 },
        (res) => {
          res.resume();
          resolvePlain(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolvePlain(0));
      req.on('timeout', () => req.destroy());
      req.end();
    });
    assert.notEqual(plain, 200);
    assert.equal(s.reached(), 0);
    assert.equal(
      (await s.call(fixture.gateway, '/api/v1/records', { agent })).status,
      200,
    );
    const resumed = await s.call(fixture.gateway, '/api/v1/records', { agent });
    assert.equal(resumed.sessionReused, true);
    assert.equal(resumed.status, 403);
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 86400000 });
    assert.equal((await s.call(fixture.gateway)).status, 403);
    assert.equal(s.reached(), 1);
  } finally {
    mock.timers.reset();
    agent.destroy();
    await s.app.close();
  }
});
test('binding, source, service, issuer, leaf and key mismatches refuse server construction', () => {
  const f = fixture;
  for (const patch of [
    { recordJson: f.binding.json + ' ' },
    { serverKeyPem: f.gateway.key },
    { issuerCertPem: f.foreign.cert },
    { serverCertPem: f.gateway.cert },
    { build: { ...f.input.build, bindingSha256: '0'.repeat(64) } },
    { runtime: { ...f.input.runtime, serviceId: f.record.webServiceId } },
    { runtime: { ...f.input.runtime, sourceSha: '2'.repeat(40) } },
    { runtime: { ...f.input.runtime, deploymentMode: 'personal-server' } },
  ]) {
    assert.throws(
      () => createManagedApiPeerServer({ ...f.input, ...patch }),
      (error) =>
        error instanceof Error &&
        error.message === 'Managed API peer transport refused' &&
        error.cause === undefined,
    );
  }
  assert.throws(() =>
    createManagedApiPeerBinding({
      ...f.record,
      webClientCertSha256: f.record.gatewayClientCertSha256,
    }),
  );
});
test('a matching fingerprint cannot replace SAN or certificate-purpose verification', async () => {
  const f = fixture;
  for (const leaf of [f.wrongHost, f.wrongPurpose]) {
    const b = createManagedApiPeerBinding({
      ...f.record,
      apiCertSha256: f.fingerprint(leaf.cert),
    });
    assert.throws(() =>
      createManagedApiPeerServer({
        ...f.input,
        recordJson: b.json,
        build: { ...f.input.build, bindingSha256: b.sha256 },
        serverCertPem: leaf.cert,
        serverKeyPem: leaf.key,
      }),
    );
  }
  const b = createManagedApiPeerBinding({
    ...f.record,
    gatewayClientCertSha256: f.fingerprint(f.wrongClientPurpose.cert),
  });
  const s = await start({
    ...f.input,
    recordJson: b.json,
    build: { ...f.input.build, bindingSha256: b.sha256 },
  });
  try {
    await assert.rejects(s.call(f.wrongClientPurpose));
    assert.equal(s.reached(), 0);
  } finally {
    await s.app.close();
  }
});

test('only a minted managed server for the exact environment replaces the proxy-IP requirement', async () => {
  const f = fixture,
    original = { ...process.env };
  const env = {
    NODE_ENV: 'production',
    PORT: '3002',
    CHARITYPILOT_MANAGED_PROVIDER: 'render',
    CHARITYPILOT_MANAGED_API_PEER_BINDING: f.binding.json,
    CHARITYPILOT_MANAGED_API_TLS_DIRECTORY: '/protected/synthetic',
    CHARITYPILOT_BUILD_COMMIT: f.record.sourceSha,
    RENDER_SERVICE_TYPE: 'pserv',
    RENDER_SERVICE_ID: f.record.apiServiceId,
    FRONTEND_URL: f.record.publicOrigin,
    NEXT_PUBLIC_API_URL: f.record.publicOrigin,
    CHARITYPILOT_CANONICAL_WEB_ORIGIN: f.record.publicOrigin,
    CHARITYPILOT_CANONICAL_API_ORIGIN: f.record.publicOrigin,
  };
  const pin = { format: 1 as const, ...f.input.build };
  const material = {
    issuerCertPem: f.ca,
    serverCertPem: f.api.cert,
    serverKeyPem: f.api.key,
  };
  const app = createConfiguredManagedApiServer(env, pin, material);
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    assert.ok(managedApiRuntimePolicy(app));
    assert.equal(managedApiRuntimePolicy({}), undefined);
    assert.throws(
      () => validateProductionEnv(app),
      (error) =>
        error instanceof AppError &&
        JSON.stringify(error.details).includes('JWT_SECRET') &&
        !JSON.stringify(error.details).includes('TRUSTED_PROXY_ADDRESSES'),
    );
    assert.throws(
      () => validateProductionEnv({}),
      (error) =>
        error instanceof AppError &&
        JSON.stringify(error.details).includes('TRUSTED_PROXY_ADDRESSES'),
    );
    process.env.RENDER_SERVICE_ID = f.record.webServiceId;
    assert.equal(managedApiRuntimePolicy(app), undefined);
    assert.throws(
      () => validateProductionEnv(app),
      (error) =>
        error instanceof AppError &&
        JSON.stringify(error.details).includes('validated TLS server'),
    );
    assert.throws(() =>
      createConfiguredManagedApiServer(
        { ...env, TRUSTED_PROXY_ADDRESSES: '10.0.0.0/8' },
        pin,
        material,
      ),
    );
    assert.throws(() =>
      createConfiguredManagedApiServer(
        { ...env, FRONTEND_URL: 'https://other.example' },
        pin,
        material,
      ),
    );
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    await app.close();
  }
});
