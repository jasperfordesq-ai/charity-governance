import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createGatewayBinding } from '../caddy/managed/config.mjs';
import {
  validateLocalDockerEndpoint,
  validateLocalDockerRuntime,
  pinnedLocalDockerEnvironment,
} from './personal-server-docker-boundary.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Native HTTP preserves the explicit Host header. Node's fetch implementation
// may replace it, which would exercise the unknown-host refusal instead.
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        timeout: options.timeout ?? 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers,
            }),
          ),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () =>
      req.destroy(new Error('Synthetic request deadline')),
    );
    req.end(options.body);
  });
}
function execute(args, env = process.env, timeout = 120_000) {
  const run = spawnSync('docker', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (run.error || run.status !== 0)
    throw new Error(
      `Local gateway Docker fixture failed (${args[0]}): ${run.error?.message ?? run.stderr}`,
    );
  return (run.stdout + (args[2] === 'logs' ? run.stderr : '')).trim();
}

test(
  'actual managed Caddy image routes, strips untrusted headers and redacts upstream-error requests',
  { timeout: 240_000 },
  async () => {
    const context = JSON.parse(
      execute(['context', 'inspect', '--format', '{{json .Endpoints.docker}}']),
    );
    validateLocalDockerEndpoint(
      { endpoint: context.Host, skipTlsVerify: context.SkipTLSVerify },
      process.env,
    );
    const env = pinnedLocalDockerEnvironment(process.env, context.Host);
    const info = JSON.parse(
      execute(
        ['--host', context.Host, 'version', '--format', '{{json .Server}}'],
        env,
      ),
    );
    const operatingSystem = execute(
      ['--host', context.Host, 'info', '--format', '{{.OperatingSystem}}'],
      env,
    );
    validateLocalDockerRuntime(
      {
        endpoint: context.Host,
        skipTlsVerify: context.SkipTLSVerify,
        operatingSystem,
        serverOs: info.Os,
        apiVersion: info.ApiVersion,
      },
      envWithoutPin(env),
    );
    const docker = (args) => execute(['--host', context.Host, ...args], env);
    const runId = `cp-managed-gateway-${process.pid}-${Date.now()}`;
    const image = runId + ':synthetic',
      internal = runId + '-internal',
      edge = runId + '-edge';
    const containers = [],
      networks = [];
    const b = createGatewayBinding({
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
      apiServiceName: 'charitypilot-review-api',
      apiOrigin: 'http://charitypilot-review-api-ab12:3002',
      webServiceName: 'charitypilot-review-web',
      webOrigin: 'http://charitypilot-review-web-cd34:3003',
    });
    const runtime = [
      'NODE_ENV=production',
      'CHARITYPILOT_MANAGED_PROVIDER=render',
      'CHARITYPILOT_MANAGED_GATEWAY_BINDING=' + b.json,
      'RENDER_SERVICE_TYPE=web',
      'RENDER_SERVICE_ID=' + b.record.gatewayServiceId,
      'CHARITYPILOT_BUILD_COMMIT=' + b.record.sourceSha,
      'PORT=10000',
    ];
    const backendSource = `const h=require('node:http');for(const port of [3002,3003])h.createServer(async(q,s)=>{let body='';for await(const c of q)body+=c;s.setHeader('Content-Type','application/json');s.end(JSON.stringify({port,url:q.url,headers:q.headers,body}));}).listen(port,'0.0.0.0')`;
    try {
      docker([
        'build',
        '--file',
        'caddy/managed/Dockerfile',
        '--build-arg',
        'CHARITYPILOT_BUILD_COMMIT=' + b.record.sourceSha,
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
      const backend = runId + '-backend';
      docker([
        'run',
        '--detach',
        '--name',
        backend,
        '--network',
        internal,
        '--network-alias',
        'charitypilot-review-api-ab12',
        '--network-alias',
        'charitypilot-review-web-cd34',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--entrypoint',
        'node',
        image,
        '-e',
        backendSource,
      ]);
      containers.push(backend);
      const gateway = runId + '-gateway';
      docker([
        'run',
        '--detach',
        '--name',
        gateway,
        '--network',
        edge,
        '--publish',
        '127.0.0.1::10000',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=32m,mode=1777',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        ...runtime.flatMap((value) => ['--env', value]),
        image,
      ]);
      containers.push(gateway);
      docker(['network', 'connect', internal, gateway]);
      const inspected = JSON.parse(docker(['inspect', gateway]))[0];
      assert.equal(
        inspected.Config.Labels['org.opencontainers.image.revision'],
        b.record.sourceSha,
      );
      for (const value of runtime)
        assert.ok(
          inspected.Config.Env.includes(value),
          'runtime argument mismatch: ' + value.split('=')[0],
        );
      assert.equal(
        inspected.State.Running,
        true,
        'gateway exited: ' + docker(['logs', gateway]),
      );
      const published = inspected.NetworkSettings.Ports['10000/tcp'];
      assert.ok(
        published,
        'gateway port missing: ' + docker(['logs', gateway]),
      );
      assert.equal(published.length, 1);
      assert.equal(published[0].HostIp, '127.0.0.1');
      assert.equal(inspected.Config.User, 'node');
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      const base = 'http://127.0.0.1:' + published[0].HostPort;
      for (let i = 0; i < 80; i++) {
        try {
          if (
            (
              await fetch(base + '/healthz', {
                timeout: 1000,
              })
            ).status === 200
          )
            break;
        } catch {}
        if (i === 79)
          throw new Error(
            'Synthetic gateway readiness failed: ' + docker(['logs', gateway]),
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const headers = {
        host: 'managed.charitypilot.test',
        forwarded: 'for=203.0.113.44',
        'x-forwarded-for': '203.0.113.44',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
        'x-forwarded-extra': 'malicious',
        'x-real-ip': '203.0.113.44',
        'cf-connecting-ip': '203.0.113.44',
        'true-client-ip': '203.0.113.44',
        'x-charitypilot-internal-claim': 'malicious',
        cookie: 'synthetic=preserved',
      };
      for (const [path, port] of [
        ['/api/v1/auth/me?check=1', 3002],
        ['/api/v1', 3002],
        ['/documents?check=1', 3003],
      ]) {
        const r = await fetch(base + path, { headers });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.port, port);
        assert.equal(data.url, path);
        assert.equal(data.headers.host, headers.host);
        assert.equal(data.headers['x-forwarded-proto'], 'https');
        assert.equal(data.headers['x-forwarded-host'], headers.host);
        assert.notEqual(data.headers['x-forwarded-for'], '203.0.113.44');
        assert.ok(data.headers['x-forwarded-for']);
        for (const name of [
          'forwarded',
          'x-forwarded-extra',
          'x-real-ip',
          'cf-connecting-ip',
          'true-client-ip',
          'x-charitypilot-internal-claim',
        ])
          assert.equal(data.headers[name], undefined, name);
        assert.equal(data.headers.cookie, 'synthetic=preserved');
      }
      const posted = await fetch(base + '/api/v1/synthetic', {
        method: 'POST',
        headers,
        body: 'synthetic-body',
      });
      assert.equal((await posted.json()).body, 'synthetic-body');
      assert.equal(
        (
          await fetch(base + '/documents', {
            headers: { host: 'evil.example' },
          })
        ).status,
        404,
      );
      const health = await fetch(base + '/healthz');
      assert.equal(await health.text(), 'gateway-process-only');
      assert.equal(health.headers.get('cache-control'), 'no-store');
      docker(['stop', backend]);
      const secret = 'SYNTHETIC_CALLBACK_CANARY';
      const unavailable = await fetch(
        base + '/api/v1/synthetic?code=' + secret + '&state=' + secret,
        {
          timeout: 10000,
          headers: { ...headers, authorization: 'Bearer ' + secret },
        },
      );
      assert.equal(unavailable.status, 502);
      const logs = docker(['logs', gateway]);
      assert.doesNotMatch(logs, new RegExp(secret));
      assert.ok(
        logs.includes('error'),
        'must actually inspect an upstream-error log',
      );
      docker(['stop', '--time', '5', gateway]);
      assert.equal(
        JSON.parse(docker(['inspect', gateway]))[0].State.ExitCode,
        0,
        'graceful gateway termination',
      );
      const bad = runId + '-mismatch';
      docker([
        'run',
        '--detach',
        '--name',
        bad,
        '--network',
        internal,
        ...runtime.flatMap((value) => ['--env', value]),
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
      // Synthetic image only; no production tag or user resource is removed.
      if (docker(['image', 'ls', '--quiet', image]))
        docker(['image', 'rm', image]);
    }
  },
);

function envWithoutPin(env) {
  const copy = { ...env };
  delete copy.DOCKER_HOST;
  return copy;
}
