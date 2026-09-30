import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const target = '20260930120000_complaint_resolution_evidence';
test('complaint resolution migration preserves legacy records and binds append-only evidence to revisions', { timeout: 240_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const started = docker(['run', '--detach', '--network', 'none', '--name', `charitypilot-complaint-proof-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-complaint-proof',
    'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c']);
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  function sql(statement, rejection) {
    const result = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
    if (rejection) { assert.notEqual(result.status, 0); assert.match(result.stderr, rejection); }
    else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    const names = readdirSync(migrations, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    assert.ok(names.includes(target));
    for (const name of names.filter(name => name < target)) {
      const migration = readFileSync(`${migrations}/${name}/migration.sql`, 'utf8');
      sql(/^\s*BEGIN;/m.test(migration) || /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(migration)
        ? migration : `BEGIN;\n${migration}\nCOMMIT;`);
    }
    sql(`BEGIN; INSERT INTO "Organisation" (id,name,"updatedAt") VALUES ('a','Synthetic A',now()),('b','Synthetic B',now());
      INSERT INTO "User" (id,email,name,"passwordHash",role,"organisationId","updatedAt") VALUES
      ('admin-a','complaint-a@example.invalid','Synthetic A','fixture','OWNER','a',now()),
      ('admin-b','complaint-b@example.invalid','Synthetic B','fixture','OWNER','b',now()),
      ('member-a','complaint-member@example.invalid','Synthetic Member','fixture','MEMBER','a',now());
      INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ('complaint','a','2026-01-01','Private original narrative','CLOSED',now()); COMMIT;`);
    const before = sql(`SELECT row_to_json(c)::jsonb::text FROM "ComplaintRecord" c;`);
    sql(readFileSync(`${migrations}/${target}/migration.sql`, 'utf8'));
    assert.equal(sql(`SELECT (row_to_json(c)::jsonb - 'revision')::text FROM "ComplaintRecord" c;`), before);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintResolutionEvidence";`), '0');
    const record = (id, revision = 1, recordRevision = 1, actor = 'admin-a', resolved = "'2026-01-02'", state = 'RECORDED') =>
      `INSERT INTO "ComplaintResolutionEvidence" (id,"organisationId","complaintId",revision,"recordRevision",state,"resolvedAt","evidenceRef",reason,"actorUserId")
       VALUES ('${id}','a','complaint',${revision},${recordRevision},'${state}',${resolved},'CASE-EVIDENCE-001','Reviewed controlled resolution evidence','${actor}');`;
    sql(record('foreign', 1, 1, 'admin-b'), /active charity administrator/);
    sql(record('member', 1, 1, 'member-a'), /active charity administrator/);
    sql(record('early', 1, 1, 'admin-a', "'2025-01-01'"), /date between receipt and now/);
    sql(record('future', 1, 1, 'admin-a', "'2999-01-01'"), /date between receipt and now/);
    sql(record('withdraw-empty', 1, 1, 'admin-a', 'NULL', 'WITHDRAWN'), /Only recorded/);
    sql(record('recorded'));
    sql(record('duplicate'), /revision conflict/);
    sql(record('corrected', 2, 1, 'admin-a', "'2026-01-03'"));
    sql(record('withdrawn', 3, 1, 'admin-a', 'NULL', 'WITHDRAWN'));
    sql(record('withdraw-again', 4, 1, 'admin-a', 'NULL', 'WITHDRAWN'), /Only recorded/);
    sql(`UPDATE "ComplaintResolutionEvidence" SET reason='Changed evidence reason' WHERE id='recorded';`, /append-only/);
    sql(`DELETE FROM "ComplaintResolutionEvidence" WHERE id='recorded';`, /append-only/);
    sql(`UPDATE "ComplaintRecord" SET status='OPEN',revision=1 WHERE id='complaint';`);
    assert.equal(sql(`SELECT revision FROM "ComplaintRecord";`), '2');
    sql(record('stale', 4), /current same-charity record revision/);
    sql(record('open', 4, 2), /closed complaint/);
    sql(`UPDATE "ComplaintRecord" SET status='CLOSED' WHERE id='complaint';`);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintResolutionEvidence" e JOIN "ComplaintRecord" c
      ON e."complaintId"=c.id AND e."organisationId"=c."organisationId" AND e."recordRevision"=c.revision;`), '0');
    sql(record('rereviewed', 4, 3));
    sql(`UPDATE "ComplaintRecord" SET "organisationId"='b' WHERE id='complaint';`, /identity and charity/);
    sql(`DELETE FROM "ComplaintRecord" WHERE id='complaint';`);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintResolutionEvidence";`), '4');
    sql(record('missing', 5, 3), /current same-charity record revision/);
    sql(`INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ('complaint','a','2026-01-01','Reused identity','CLOSED',now());`, /cannot be reused/);
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
    const remaining = docker(['ps', '--all', '--filter', `id=${container}`, '--format', '{{.ID}}']);
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.equal(remaining.stdout.trim(), '');
  }
});
