import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const original = fileURLToPath(new URL('../apps/api/prisma/migrations/20261007080000_document_purge_cleanup_alias_fence/migration.sql', import.meta.url));
const hardening = fileURLToPath(new URL('../apps/api/prisma/migrations/20261009020000_document_storage_deletion_org_immutable/migration.sql', import.meta.url));

test('cleanup job cannot move into a charity with a protected provider target', { timeout: 120_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const started = docker(['run', '--detach', '--network', 'none',
    '--name', `charitypilot-cleanup-org-fence-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-org-fence',
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
    sql(`CREATE TABLE "Organisation" (id TEXT PRIMARY KEY);
      CREATE TABLE "DocumentStorageDeletion" (id TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id),
        provider TEXT NOT NULL, "storagePath" TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE (id,"organisationId"));
      CREATE TABLE "DocumentPurgeAuthorization" (id TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL, provider TEXT NOT NULL, "storagePath" TEXT NOT NULL);
      CREATE TABLE "DocumentPurgeClaim" (id TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL, "authorizationId" TEXT NOT NULL,
        "deletionId" TEXT NOT NULL,
        FOREIGN KEY ("deletionId","organisationId")
          REFERENCES "DocumentStorageDeletion"(id,"organisationId") ON DELETE RESTRICT);
      INSERT INTO "Organisation" VALUES ('charity-a'),('charity-b');
      INSERT INTO "DocumentStorageDeletion" (id,"organisationId",provider,"storagePath") VALUES
        ('primary','charity-b','local','charity-b/policy.pdf'),
        ('alias','charity-a','local','charity-b/policy.pdf'),
        ('ordinary','charity-a','local','charity-a/other.pdf');
      INSERT INTO "DocumentPurgeAuthorization" VALUES
        ('auth-b','charity-b','local','charity-b/policy.pdf');
      INSERT INTO "DocumentPurgeClaim" VALUES
        ('claim-b','charity-b','auth-b','primary');`);
    sql(readFileSync(original, 'utf8'));
    sql(readFileSync(hardening, 'utf8'));
    sql(`UPDATE "DocumentStorageDeletion" SET "organisationId"='charity-b' WHERE id='alias';`,
      /organisation identity is immutable/i);
    assert.equal(sql(`SELECT "organisationId" FROM "DocumentStorageDeletion" WHERE id='alias';`), 'charity-a');
    sql(`UPDATE "DocumentStorageDeletion" SET "organisationId"='charity-b' WHERE id='ordinary';`,
      /organisation identity is immutable/i);
    sql(`UPDATE "DocumentStorageDeletion" SET "organisationId"='charity-a' WHERE id='ordinary';`);
    sql(`UPDATE "DocumentStorageDeletion" SET attempts=1 WHERE id='ordinary';`);
    assert.equal(sql(`SELECT attempts FROM "DocumentStorageDeletion" WHERE id='ordinary';`), '1');
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
    const remaining = docker(['ps', '--all', '--filter', `id=${container}`, '--format', '{{.ID}}']);
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.equal(remaining.stdout.trim(), '');
  }
});
