import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migration = fileURLToPath(new URL('../apps/api/prisma/migrations/20261007020000_document_recovery_preparation/migration.sql', import.meta.url));
test('document preparation migration binds Owner, authorization and exact immutable digest without dispatch', { timeout: 120_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const started = docker(['run', '--detach', '--network', 'none', '--name', `charitypilot-document-prep-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-document-proof',
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
      CREATE TABLE "User" (id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL,
        role TEXT NOT NULL, "lifecycleStatus" TEXT NOT NULL);
      CREATE TABLE "DocumentPurgeAuthorization" (id TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
        UNIQUE (id,"organisationId"));
      CREATE TABLE "DocumentPurgeAuthorizationWithdrawal" ("authorizationId" TEXT PRIMARY KEY);
      CREATE TABLE "DocumentPurgeClaim" ("authorizationId" TEXT PRIMARY KEY);
      INSERT INTO "Organisation" VALUES ('charity'),('foreign');
      INSERT INTO "User" VALUES ('owner','charity','OWNER','ACTIVE'),
        ('member','charity','MEMBER','ACTIVE'),('other','foreign','OWNER','ACTIVE');
      INSERT INTO "DocumentPurgeAuthorization" VALUES
        ('auth','charity','owner'),('claimed','charity','owner'),
        ('withdrawn','charity','owner'),('other-auth','foreign','other');
      INSERT INTO "DocumentPurgeClaim" VALUES ('claimed');
      INSERT INTO "DocumentPurgeAuthorizationWithdrawal" VALUES ('withdrawn');`);
    sql(readFileSync(migration, 'utf8'));
    const facts = JSON.stringify({ format: 1, action: 'DOCUMENT_PURGE_PREPARATION',
      organisationId: 'charity', installationId: 'installation', operationId: 'operation',
      writerEpoch: 1, actorUserId: 'owner', authorization: { id: 'auth' } });
    const hex = Buffer.from(facts, 'utf8').toString('hex');
    const digest = createHash('sha256').update(facts, 'utf8').digest('hex');
    const insert = (rowId, auth = 'auth', actor = 'owner', hash = digest, payload = hex) =>
      `INSERT INTO "DocumentRecoveryPreparation"
        (id,"organisationId","installationId","operationId","writerEpoch","authorizationId","actorUserId",facts,"factsDigest")
        VALUES ('${rowId}','charity','installation','operation',1,'${auth}','${actor}',
          convert_from(decode('${payload}','hex'),'UTF8'),'${hash}');`;
    sql(insert('member', 'auth', 'member'), /active charity Owner/);
    sql(insert('claim', 'claimed'), /unclaimed unwithdrawn Owner review/);
    sql(insert('withdrawal', 'withdrawn'), /unclaimed unwithdrawn Owner review/);
    sql(insert('foreign', 'other-auth'), /unclaimed unwithdrawn Owner review/);
    sql(insert('digest', 'auth', 'owner', '0'.repeat(64)), /identity or digest mismatch/);
    const wrongFacts = facts.replace('"id":"auth"', '"id":"other"');
    sql(insert('wrong-auth', 'auth', 'owner',
      createHash('sha256').update(wrongFacts, 'utf8').digest('hex'),
      Buffer.from(wrongFacts, 'utf8').toString('hex')),
    /identity or digest mismatch/);
    sql(insert('prepared'));
    sql(insert('duplicate'), /duplicate key/);
    sql(`UPDATE "DocumentRecoveryPreparation" SET "factsDigest"=repeat('0',64);`, /append-only/);
    sql(`DELETE FROM "DocumentRecoveryPreparation";`, /append-only/);
    assert.equal(sql(`SELECT "factsDigest" FROM "DocumentRecoveryPreparation" WHERE id='prepared';`), digest);
    assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeClaim";`), '1');
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
    const remaining = docker(['ps', '--all', '--filter', `id=${container}`, '--format', '{{.ID}}']);
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.equal(remaining.stdout.trim(), '');
  }
});
