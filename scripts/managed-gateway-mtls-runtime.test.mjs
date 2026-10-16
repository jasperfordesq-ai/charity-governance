import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  validateLocalDockerEndpoint,
  validateLocalDockerRuntime,
  pinnedLocalDockerEnvironment,
} from './personal-server-docker-boundary.mjs';
import {
  gatewayTlsFixture,
  provisionMaterial,
  provisionPin,
  gatewayWait,
  backendSource,
  rogueSource,
} from './managed-gateway-tls-fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
function execute(args, env = process.env, input) {
  const r = spawnSync('docker', args, {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      'Synthetic gateway Docker failure (' +
        args[0] +
        '): ' +
        (r.error?.message ?? r.stderr),
    );
  return (r.stdout + (args[2] === 'logs' ? r.stderr : '')).trim();
}
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const q = httpRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        timeout: 10000,
      },
      (s) => {
        const parts = [];
        s.on('data', (p) => parts.push(p));
        s.on('error', reject);
        s.on('end', () =>
          resolve(
            new Response(Buffer.concat(parts), {
              status: s.statusCode,
              headers: s.headers,
            }),
          ),
        );
      },
    );
    q.on('error', reject);
    q.on('timeout', () => q.destroy(new Error('Synthetic deadline')));
    q.end(options.body);
  });
}
test(
  'actual gateway mTLS reaches the bound API loader and rejects untrusted upstreams',
  { timeout: 240000 },
  async () => {
    const c = JSON.parse(
      execute(['context', 'inspect', '--format', '{{json .Endpoints.docker}}']),
    );
    validateLocalDockerEndpoint(
      { endpoint: c.Host, skipTlsVerify: c.SkipTLSVerify },
      process.env,
    );
    const env = pinnedLocalDockerEnvironment(process.env, c.Host),
      docker = (args, input) =>
        execute(['--host', c.Host, ...args], env, input),
      v = JSON.parse(docker(['version', '--format', '{{json .Server}}']));
    validateLocalDockerRuntime(
      {
        endpoint: c.Host,
        skipTlsVerify: c.SkipTLSVerify,
        operatingSystem: docker(['info', '--format', '{{.OperatingSystem}}']),
        serverOs: v.Os,
        apiVersion: v.ApiVersion,
      },
      process.env,
    );
    const f = gatewayTlsFixture(),
      b = f.binding,
      r = b.record,
      id = 'cp-managed-tls-' + process.pid + '-' + Date.now(),
      image = id + ':synthetic',
      internal = id + '-internal',
      edge = id + '-edge',
      containers = [],
      networks = [];
    const environment = (values) =>
      Object.entries(values).flatMap(([k, v]) => ['--env', k + '=' + v]);
    const hardened = [
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=32m,mode=1777',
      '--tmpfs',
      '/run/charitypilot:rw,noexec,nosuid,size=32m,mode=1777',
    ];
    const provision = (name, directories) =>
      docker(
        [
          'exec',
          '--user',
          'node',
          '--interactive',
          name,
          'node',
          '-e',
          provisionMaterial,
        ],
        JSON.stringify({ directories }),
      );
    const material = (leaf) => ({
      'issuer.pem': f.issuer,
      'server.pem': leaf.cert,
      'server.key': leaf.key,
    });
    const mount = [
      ['node_modules', '/app/node_modules'],
      ['apps/api/dist', '/app/apps/api/dist'],
      ['apps/api/package.json', '/app/apps/api/package.json'],
    ].flatMap(([s, t]) => [
      '--mount',
      'type=bind,source=' + join(root, s) + ',target=' + t + ',readonly',
    ]);
    try {
      docker([
        'build',
        '--file',
        'caddy/managed/Dockerfile',
        '--build-arg',
        'CHARITYPILOT_BUILD_COMMIT=' + r.sourceSha,
        '--build-arg',
        'CHARITYPILOT_MANAGED_GATEWAY_BINDING_SHA256=' + b.sha256,
        '--tag',
        image,
        '.',
      ]);
      docker(['network', 'create', '--internal', internal]);
      networks.push(internal);
      docker(['network', 'create', edge]);
      networks.push(edge);
      const backend = id + '-backend';
      docker([
        'run',
        '--detach',
        '--name',
        backend,
        '--network',
        internal,
        '--network-alias',
        new URL(r.apiOrigin).hostname,
        '--network-alias',
        new URL(r.webOrigin).hostname,
        ...hardened,
        '--tmpfs',
        '/opt/charitypilot:rw,noexec,nosuid,size=1m,mode=0755',
        ...mount,
        ...environment({
          NODE_ENV: 'production',
          PORT: '3002',
          CHARITYPILOT_MANAGED_PROVIDER: 'render',
          CHARITYPILOT_MANAGED_API_PEER_BINDING: b.json,
          CHARITYPILOT_MANAGED_API_TLS_DIRECTORY: '/run/charitypilot/api',
          CHARITYPILOT_BUILD_COMMIT: r.sourceSha,
          RENDER_SERVICE_TYPE: 'pserv',
          RENDER_SERVICE_ID: r.apiServiceId,
          FRONTEND_URL: r.publicOrigin,
          NEXT_PUBLIC_API_URL: r.publicOrigin,
          CHARITYPILOT_CANONICAL_WEB_ORIGIN: r.publicOrigin,
          CHARITYPILOT_CANONICAL_API_ORIGIN: r.publicOrigin,
        }),
        '--entrypoint',
        'node',
        image,
        '--input-type=module',
        '-e',
        backendSource,
      ]);
      containers.push(backend);
      docker(
        [
          'exec',
          '--user',
          '0',
          '--interactive',
          backend,
          'node',
          '-e',
          provisionPin,
        ],
        JSON.stringify({
          format: 1,
          sourceSha: r.sourceSha,
          bindingSha256: b.sha256,
        }),
      );
      provision(backend, {
        '/run/charitypilot/api': material(f.api),
        '/run/charitypilot/web': material(f.web),
      });
      for (let i = 0; i < 80; i++) {
        const logs = docker(['logs', backend]);
        if (logs.includes('BACKEND_TLS_READY')) break;
        if (i === 79) throw new Error('Backend readiness failed: ' + logs);
        await new Promise((r) => setTimeout(r, 100));
      }
      const gateway = id + '-gateway',
        runtime = {
          CHARITYPILOT_MANAGED_PROVIDER: 'render',
          CHARITYPILOT_MANAGED_GATEWAY_BINDING: b.json,
          CHARITYPILOT_MANAGED_GATEWAY_TLS_DIRECTORY:
            '/run/charitypilot/gateway',
          CHARITYPILOT_BUILD_COMMIT: r.sourceSha,
          RENDER_SERVICE_ID: r.gatewayServiceId,
          RENDER_SERVICE_TYPE: 'web',
          PORT: '10000',
        };
      docker([
        'run',
        '--detach',
        '--name',
        gateway,
        '--network',
        edge,
        '--publish',
        '127.0.0.1::10000',
        ...hardened,
        ...environment(runtime),
        '--entrypoint',
        'node',
        image,
        '-e',
        gatewayWait,
      ]);
      containers.push(gateway);
      docker(['network', 'connect', internal, gateway]);
      provision(gateway, {
        '/run/charitypilot/gateway': {
          'issuer.pem': f.issuer,
          'client.pem': f.gateway.cert,
          'client.key': f.gateway.key,
        },
      });
      const inspected = JSON.parse(docker(['inspect', gateway]))[0],
        ports = inspected.NetworkSettings.Ports['10000/tcp'];
      assert.equal(ports.length, 1);
      assert.equal(ports[0].HostIp, '127.0.0.1');
      assert.equal(inspected.Config.User, 'node');
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
      assert.equal(
        inspected.Config.Labels['org.opencontainers.image.revision'],
        r.sourceSha,
      );
      const base = 'http://127.0.0.1:' + ports[0].HostPort;
      for (let i = 0; i < 80; i++) {
        try {
          if ((await request(base + '/healthz')).status === 200) break;
        } catch {}
        if (i === 79)
          throw new Error(
            'Gateway readiness failed: ' + docker(['logs', gateway]),
          );
        await new Promise((r) => setTimeout(r, 100));
      }
      const headers = {
        host: new URL(r.publicOrigin).host,
        forwarded: 'for=203.0.113.44',
        'x-forwarded-for': '203.0.113.44',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
        'x-forwarded-extra': 'forged',
        'x-real-ip': '203.0.113.44',
        'cf-connecting-ip': '203.0.113.44',
        'true-client-ip': '203.0.113.44',
        'x-charitypilot-peer-role': 'forged',
        cookie: 'synthetic=preserved',
      };
      for (const [path, port] of [
        ['/api/v1/auth/me?check=1', 3002],
        ['/api/v1', 3002],
        ['/documents?check=1', 3003],
      ]) {
        const response = await request(base + path, { headers });
        assert.equal(
          response.status,
          200,
          'backend: ' + docker(['logs', backend]),
        );
        const data = await response.json();
        assert.equal(data.port, port);
        assert.equal(data.url, path);
        assert.equal(data.role, 'gateway');
        assert.equal(data.protocol, 'TLSv1.3');
        assert.equal(data.ingressHeaders.host, headers.host);
        assert.equal(data.ingressHeaders['x-forwarded-proto'], 'https');
        assert.equal(data.ingressHeaders['x-forwarded-host'], headers.host);
        assert.notEqual(data.ingressHeaders['x-forwarded-for'], '203.0.113.44');
        assert.ok(data.ingressHeaders['x-forwarded-for']);
        for (const k of [
          'forwarded',
          'x-forwarded-extra',
          'x-real-ip',
          'cf-connecting-ip',
          'true-client-ip',
          'x-charitypilot-peer-role',
        ])
          assert.equal(data.ingressHeaders[k], undefined, k);
        assert.equal(data.headers.cookie, headers.cookie);
        if (port === 3002)
          assert.equal(data.headers['x-forwarded-for'], undefined);
      }
      const posted = await request(base + '/api/v1/synthetic', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: 'synthetic-body',
      });
      assert.equal((await posted.json()).body, 'synthetic-body');
      assert.equal(
        (
          await request(base + '/documents', {
            headers: { host: 'evil.example' },
          })
        ).status,
        404,
      );
      const health = await request(base + '/healthz');
      assert.equal(await health.text(), 'gateway-process-only');
      assert.equal(health.headers.get('cache-control'), 'no-store');
      docker(['stop', '--time', '5', backend]);
      docker(['network', 'disconnect', internal, backend]);
      for (const [label, leaf] of [
        ['foreign-root', f.foreign],
        ['wrong-host', f.web],
      ]) {
        const rogue = id + '-' + label;
        docker([
          'run',
          '--detach',
          '--name',
          rogue,
          '--network',
          internal,
          '--network-alias',
          new URL(r.apiOrigin).hostname,
          ...hardened,
          '--entrypoint',
          'node',
          image,
          '--input-type=module',
          '-e',
          rogueSource,
        ]);
        containers.push(rogue);
        provision(rogue, {
          '/run/charitypilot/rogue': {
            'server.pem': leaf.cert,
            'server.key': leaf.key,
          },
        });
        for (let i = 0; i < 50; i++) {
          if (docker(['logs', rogue]).includes('ROGUE_TLS_READY')) break;
          if (i === 49) throw new Error('Rogue fixture not ready');
          await new Promise((r) => setTimeout(r, 100));
        }
        const before = docker(['logs', gateway]),
          secret = 'SYNTHETIC_CALLBACK_CANARY',
          response = await request(
            base + '/api/v1/synthetic?code=' + secret + '&state=' + secret,
            { headers: { ...headers, authorization: 'Bearer ' + secret } },
          );
        assert.equal(response.status, 502, label);
        assert.doesNotMatch(
          docker(['logs', rogue]),
          /UNTRUSTED_HANDLER_REACHED/,
        );
        const logs = docker(['logs', gateway]);
        assert.doesNotMatch(logs, new RegExp(secret));
        assert.match(
          logs.slice(before.length),
          /certificate|x509/,
          label + ' must fail certificate verification',
        );
        docker(['stop', '--time', '2', rogue]);
        docker(['network', 'disconnect', internal, rogue]);
      }
      assert.match(
        docker(['logs', gateway]),
        /certificate|x509/,
        'actual failed upstream certificate verification',
      );
      docker(['stop', '--time', '5', gateway]);
      assert.equal(
        JSON.parse(docker(['inspect', gateway]))[0].State.ExitCode,
        0,
      );
      const bad = id + '-mismatch';
      docker([
        'run',
        '--detach',
        '--name',
        bad,
        '--network',
        internal,
        ...environment(runtime),
        '--env',
        'CHARITYPILOT_MANAGED_GATEWAY_BINDING=' + b.json + ' ',
        image,
      ]);
      containers.push(bad);
      assert.equal(docker(['wait', bad]), '1');
      assert.match(docker(['logs', bad]), /Managed gateway startup refused/);
    } finally {
      for (const name of containers.reverse()) docker(['rm', '--force', name]);
      for (const name of networks.reverse()) docker(['network', 'rm', name]);
      if (docker(['image', 'ls', '--quiet', image]))
        docker(['image', 'rm', image]);
      f.cleanup();
    }
  },
);
