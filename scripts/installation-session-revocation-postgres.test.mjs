import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const password = 'synthetic-session-revocation-proof';
const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options });
const requireSuccess = (result, label) => {
  assert.equal(result.status, 0,
    `${label}: ${(result.stderr || result.stdout || result.error?.message || 'unknown').slice(-1600)}`);
  return result.stdout.trim();
};

test('installation-wide revocation waits for a refresh in flight and ends old families, on real PostgreSQL',
  { timeout: 240_000 }, async () => {
    const context = run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}']);
    const endpoint = JSON.parse(requireSuccess(context, 'Docker context'));
    validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
    const docker = (args, options) => run('docker', ['--host', endpoint.Host, ...args], options);
    const name = `charitypilot-session-revocation-${randomUUID()}`;
    const database = `charitypilot_session_revocation_${randomUUID().replaceAll('-', '')}`;
    const id = requireSuccess(docker(['run', '--detach', '--network', 'bridge', '--name', name,
      '--tmpfs', '/var/lib/postgresql/data', '--publish', '127.0.0.1::5432',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', `POSTGRES_DB=${database}`, image]),
    'start disposable PostgreSQL');
    try {
      assert.match(id, /^[a-f0-9]{64}$/);
      let ready = false;
      for (let i = 0; i < 80; i += 1) {
        if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { timeout: 5_000 }).status === 0) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(ready, 'disposable PostgreSQL did not become ready');
      const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(requireSuccess(docker(['port', name, '5432/tcp']), 'port'));
      assert.ok(match, 'disposable PostgreSQL must publish on IPv4 loopback only');
      const env = { ...process.env,
        DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${match[1]}/${database}`,
        CHARITYPILOT_SYNTHETIC_SESSION_PROOF: '1' };
      requireSuccess(run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy',
        '--schema', 'apps/api/prisma/schema.prisma'], { env }), 'apply all Prisma migrations');
      requireSuccess(run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json'], { env }),
        'build API for the real PostgreSQL proof');
      const output = requireSuccess(run(process.execPath, ['scripts/installation-session-revocation-postgres-proof.mjs'],
        { env }), 'session revocation proof');
      assert.match(output, /installation-session-revocation-race=verified; old-family-insert=refused; new-sign-in=allowed; operator-family=refused; cutoff=forward-only/u);
    } finally {
      assert.equal(requireSuccess(docker(['inspect', '--format', '{{.Id}}', name]), 'identify disposable PostgreSQL'), id);
      requireSuccess(docker(['rm', '--force', '--volumes', name]), 'remove disposable PostgreSQL');
    }
  });
