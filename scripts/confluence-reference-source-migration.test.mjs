import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const target = '20261019210000_confluence_reference_only_source';
const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

test('reference-only source upgrade preserves file citations, tenant guards, recovery freeze and restored history', { timeout: 240_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(docker(['info', '--format', '{{.OSType}}']).stdout.trim(), 'linux');
  const name = `charitypilot-source-proof-${randomUUID()}`;
  const started = docker(['run', '--detach', '--network', 'none', '--name', name,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-source-proof', image]);
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  const sql = (statement, reject, database = 'postgres') => {
    const result = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', database,
      '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
    if (reject) { assert.notEqual(result.status, 0, 'unsafe mutation accepted'); assert.match(result.stderr, reject); }
    else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'disposable PostgreSQL did not start');
    for (const entry of readdirSync(migrations).sort().filter(entry => entry < target)) {
      const migration = readFileSync(`${migrations}/${entry}/migration.sql`, 'utf8');
      sql(/^\s*BEGIN;/m.test(migration) || /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(migration)
        ? migration : `BEGIN;\n${migration}\nCOMMIT;`);
    }
    sql(`BEGIN; INSERT INTO "Organisation"(id,name,"updatedAt") VALUES ('source-a','Synthetic file tenant',now()),('source-b','Synthetic no-file tenant',now());
      INSERT INTO "User"(id,email,name,"passwordHash",role,"organisationId","updatedAt") VALUES
        ('source-owner','source-owner@example.invalid','Synthetic Owner','synthetic-hash','OWNER','source-b',now()),
        ('file-owner','file-owner@example.invalid','Synthetic File Owner','synthetic-hash','OWNER','source-a',now());
      INSERT INTO "Document"(id,"organisationId",name,category,"fileUrl","fileSize","mimeType","updatedAt")
        VALUES ('file-a','source-a','Synthetic evidence','OTHER','source-a/file.txt',3,'text/plain',now());
      INSERT INTO "ConfluenceReference"(id,"organisationId","documentId","cloudId","pageId","pageTitle","pageVersion","citedAt","citedById","updatedAt")
        VALUES ('file-reference','source-a','file-a','site-a','page-a','Synthetic page',7,now(),'file-owner',now()); COMMIT;`);
    const legacy = sql(`SELECT json_build_array(id,"documentId","cloudId","pageId","pageVersion","citedAt","updatedAt") FROM "ConfluenceReference" WHERE id='file-reference';`);
    sql(readFileSync(`${migrations}/${target}/migration.sql`, 'utf8'));
    assert.equal(sql(`SELECT json_build_array(id,"documentId","cloudId","pageId","pageVersion","citedAt","updatedAt") FROM "ConfluenceReference" WHERE id='file-reference';`), legacy);
    const insert = (id, kind, doc = 'NULL', org = 'source-b') => `INSERT INTO "ConfluenceReference"
      (id,"organisationId","documentId","referenceKind","cloudId","pageId","pageTitle","pageVersion","citedAt","citedById","updatedAt")
      VALUES ('${id}','${org}',${doc},'${kind}','synthetic-site','synthetic-page','Synthetic external source',2,now(),'source-owner',now());`;
    sql(insert('external-source', 'CONFLUENCE_SOURCE'));
    assert.equal(sql(`SELECT count(*) FROM "Document" WHERE "organisationId"='source-b';`), '0');
    assert.equal(sql(`SELECT count(*) FROM "DocumentUploadIntent";`), '0');
    sql(insert('bad-file', 'VAULT_EVIDENCE'), /anchor_shape/);
    sql(insert('bad-source', 'CONFLUENCE_SOURCE', "'file-a'"), /anchor_shape/);
    sql(insert('bad-tenant', 'VAULT_EVIDENCE', "'file-a'"), /foreign key/);
    sql(insert('bad-kind', 'OTHER'), /anchor_shape/);
    sql(`UPDATE "ConfluenceReference" SET "pageVersion"=3 WHERE id='external-source';`, /identity cannot be rewritten/);
    sql(`UPDATE "ConfluenceReference" SET "organisationId"='source-a' WHERE id='external-source';`, /identity cannot be rewritten/);
    sql(`INSERT INTO "SecurityAuditEvent"(id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context)
      VALUES ('source-audit','source-b','CONFLUENCE_SOURCE_REGISTERED','USER','source-owner','Synthetic Owner','Synthetic external source','Synthetic reference-only proof',
        '{"referenceId":"external-source","documentId":null,"providerMutationIssued":false}');`);
    sql(`UPDATE "SecurityAuditEvent" SET reason='rewritten' WHERE id='source-audit';`, /append.only|immutable|cannot be/i);
    sql(`INSERT INTO "SecurityAuditEvent"(id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context)
      SELECT 'duplicate-source-audit',"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context
      FROM "SecurityAuditEvent" WHERE id='source-audit';`, /registration_request_key/);
    sql(`INSERT INTO "SecurityAuditEvent"(id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason)
      VALUES ('bad-user-event','source-b','MEMBER_ROLE_CHANGED','USER','source-owner','Synthetic Owner','Missing subject','Synthetic refusal proof');`, /subject_check/);
    sql(`INSERT INTO "DocumentRecoveryEnforcement"(id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('source-bound','source-b','synthetic-installation','synthetic-writer',1);`);
    sql(insert('bound-source', 'CONFLUENCE_SOURCE'), /independent recovery authority/);
    sql(`DELETE FROM "ConfluenceReference" WHERE id='external-source';`, /independent recovery authority/);
    sql(`UPDATE "ConfluenceReference" SET "pageVersion"=4 WHERE id='external-source';`, /independent recovery authority/);
    const dump = docker(['exec', container, 'pg_dump', '-U', 'postgres', '--no-owner', '--no-privileges', 'postgres']);
    assert.equal(dump.status, 0, dump.stderr);
    sql('CREATE DATABASE restored_sources;');
    sql(dump.stdout, undefined, 'restored_sources');
    assert.equal(sql(`SELECT "referenceKind"||':'||"pageVersion" FROM "ConfluenceReference" WHERE id='external-source';`, undefined, 'restored_sources'), 'CONFLUENCE_SOURCE:2');
    assert.equal(sql(`SELECT count(*) FROM "SecurityAuditEvent" WHERE id='source-audit';`, undefined, 'restored_sources'), '1');
    sql(`DELETE FROM "ConfluenceReference" WHERE id='external-source';`, /independent recovery authority/, 'restored_sources');
  } finally {
    const removed = docker(['rm', '--force', container]);
    assert.equal(removed.status, 0, removed.stderr);
  }
});
