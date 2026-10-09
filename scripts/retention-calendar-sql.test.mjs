import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migration = fileURLToPath(new URL('../apps/api/prisma/migrations/20261008020000_retention_calendar_cutoff_helper/migration.sql', import.meta.url));
const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

test('SQL calendar-year cutoff matches the UTC anniversary boundary without enabling disposal', { timeout: 120_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const info = docker(['info', '--format', '{{.OSType}}']);
  assert.equal(info.status, 0, info.stderr);
  assert.equal(info.stdout.trim(), 'linux');
  const name = `charitypilot-calendar-proof-${randomUUID()}`;
  const started = docker(['run', '--detach', '--network', 'none', '--name', name,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-calendar-proof', image]);
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  function sql(statement, rejectPattern) {
    const result = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
    if (rejectPattern) {
      assert.notEqual(result.status, 0, 'invalid calendar input was accepted');
      assert.match(result.stderr, rejectPattern);
    } else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) {
        ready = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'disposable PostgreSQL server did not start');
    sql(readFileSync(migration, 'utf8'));
    const cutoff = `"Retention_calendar_year_cutoff_utc"('2024-02-29 12:34:56.789'::timestamp(3),6)`;
    assert.equal(sql(`SELECT ${cutoff};`), '2030-02-28 12:34:56.789');
    assert.equal(sql(`SELECT "Retention_calendar_year_cutoff_utc"('2024-02-29 12:34:56.789'::timestamp(3),4);`),
      '2028-02-29 12:34:56.789');
    assert.equal(sql(`SELECT "Retention_calendar_year_cutoff_utc"('2025-12-31 23:59:59.999'::timestamp(3),1);`),
      '2026-12-31 23:59:59.999');
    assert.equal(sql(`SELECT '2030-02-28 12:34:56.788'::timestamp(3)<${cutoff},
      '2030-02-28 12:34:56.789'::timestamp(3)>=${cutoff};`), 't|t');
    assert.notEqual(sql(`SELECT '2024-02-29 12:34:56.789'::timestamp(3)+INTERVAL '2190 days';`),
      '2030-02-28 12:34:56.789');
    for (const years of [0, -1, 101]) {
      sql(`SELECT "Retention_calendar_year_cutoff_utc"('2024-02-29'::timestamp(3),${years});`, /1 to 100 whole years/);
    }
    sql(`SELECT "Retention_calendar_year_cutoff_utc"(NULL,6);`, /UTC anchor/);
    sql(`SELECT "Retention_calendar_year_cutoff_utc"('9999-01-01'::timestamp(3),1);`, /supported date range/);
  } finally {
    const removed = docker(['rm', '--force', container]);
    assert.equal(removed.status, 0, removed.stderr);
  }
});
