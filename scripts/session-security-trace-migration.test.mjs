import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migration = fileURLToPath(new URL('../apps/api/prisma/migrations/20261011020000_session_security_trace/migration.sql', import.meta.url));

test('session security trace rows are bounded, never rewritten, and removed only by retention', { timeout: 120_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const started = docker(['run', '--detach', '--network', 'none',
    '--name', `charitypilot-session-trace-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-session-trace',
    'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c']);
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  const sql = (statement, rejection) => {
    const result = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
    if (rejection) { assert.notEqual(result.status, 0); assert.match(result.stderr, rejection); }
    else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) {
        ready = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    sql(readFileSync(migration, 'utf8'));
    const insert = (columns) => `INSERT INTO "SessionSecurityTrace" (${Object.keys(columns).map(c => `"${c}"`).join(',')})
      VALUES (${Object.values(columns).join(',')});`;
    const fresh = { routePattern: `'/api/v1/auth/refresh'`, statusCode: 200, requestId: `'req-1'`,
      presentedTokenFingerprint: `'0123456789abcdef'`, networkPrefix: `'203.0.113.0/24'`,
      userAgentDigest: `'fedcba9876543210'` };
    sql(insert(fresh));
    sql(insert({ ...fresh, requestId: `'req-old'`, occurredAt: `CURRENT_TIMESTAMP - INTERVAL '40 days'` }));
    // Only the bounded shapes are accepted: no full token, address or agent string.
    sql(insert({ ...fresh, presentedTokenFingerprint: `'not-a-fingerprint'` }), /check constraint/);
    sql(insert({ ...fresh, userAgentDigest: `'Mozilla/5.0 (Windows NT 10.0)'` }), /check constraint/);
    sql(insert({ ...fresh, statusCode: 42 }), /check constraint/);
    sql(insert({ ...fresh, routePattern: `''` }), /check constraint/);
    sql(insert({ ...fresh, networkPrefix: `'${'x'.repeat(65)}'` }), /check constraint/);
    sql(`UPDATE "SessionSecurityTrace" SET "statusCode"=500 WHERE "requestId"='req-1';`, /never rewritten/);
    sql(`UPDATE "SessionSecurityTrace" SET "statusCode"=500 WHERE "requestId"='req-old';`, /never rewritten/);
    sql(`DELETE FROM "SessionSecurityTrace" WHERE "requestId"='req-1';`, /removed only by retention/);
    sql(`DELETE FROM "SessionSecurityTrace" WHERE "occurredAt" < CURRENT_TIMESTAMP - INTERVAL '30 days';`);
    assert.equal(sql(`SELECT string_agg("requestId", ',') FROM "SessionSecurityTrace";`), 'req-1');
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
  }
});
