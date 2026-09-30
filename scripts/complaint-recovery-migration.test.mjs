import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const target = '20260930130000_complaint_recoverable_state';
test('complaint recovery migration preserves records and enforces reviewed removal and exact restoration', { timeout: 240_000 }, async () => {
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
    assert.equal(sql(`SELECT (row_to_json(c)::jsonb - ARRAY['removedAt','removalId'])::text FROM "ComplaintRecord" c;`), before);
    sql(`INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","retentionAnchor","retentionDays","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
      VALUES ('policy','a','COMPLAINT',1,'APPROVED','AFTER_ANCHOR','RESOLVED_AT',1,30,'admin-a','admin-a',now(),'POLICY-001'),
      ('vault','a','VAULT_DRAFT',1,'APPROVED','REVIEW_REQUIRED',NULL,NULL,30,'admin-a','admin-a',now(),'POLICY-002');
      INSERT INTO "ComplaintResolutionEvidence" (id,"organisationId","complaintId",revision,"recordRevision",state,"resolvedAt","evidenceRef",reason,"actorUserId")
      VALUES ('resolution','a','complaint',1,1,'RECORDED','2026-01-02','RESOLUTION-001','Reviewed synthetic resolution evidence','admin-a');`);
    const decision = (id, actor='admin-a', policy='policy', revision=1, evidence="'resolution'") =>
      `INSERT INTO "ComplaintRemoval" (id,"organisationId","complaintId","recordRevision","actorUserId","policyId","resolutionEvidenceId","evidenceRef",reason)
       VALUES ('${id}','a','complaint',${revision},'${actor}','${policy}',${evidence},'REMOVAL-001','Reviewed synthetic removal authority');`;
    sql(`DELETE FROM "ComplaintRecord" WHERE id='complaint';`, /separate verified workflow/);
    sql(decision('member','member-a'), /active charity administrator/);
    sql(decision('foreign','admin-b'), /active charity administrator/);
    sql(decision('wrong-class','admin-a','vault'), /approved complaint policy/);
    sql(decision('stale','admin-a','policy',2), /current closed complaint/);
    sql(decision('no-anchor','admin-a','policy',1,'NULL'), /current resolution evidence/);
    sql(`UPDATE "ComplaintRecord" SET "removedAt"=now(),"removalId"='unreviewed' WHERE id='complaint';`, /matching current authority/);
    sql(decision('removal'));
    assert.equal(sql(`SELECT "recoveryUntil"="occurredAt"+INTERVAL '30 days' FROM "ComplaintRemoval" WHERE id='removal';`), 't');
    sql(`UPDATE "ComplaintRecord" SET "removalId"='removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='removal'), summary='Changed during removal' WHERE id='complaint';`, /preserve its contents/);
    sql(`UPDATE "ComplaintRecord" SET "removalId"='removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='removal') WHERE id='complaint';`);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE "organisationId"='a' AND "removedAt" IS NULL;`), '0');
    sql(`UPDATE "ComplaintRecord" SET summary='Edited after removal' WHERE id='complaint';`, /cannot be edited/);
    sql(`INSERT INTO "ComplaintResolutionEvidence" (id,"organisationId","complaintId",revision,"recordRevision",state,"resolvedAt","evidenceRef",reason,"actorUserId")
      VALUES ('removed-resolution','a','complaint',2,2,'RECORDED','2026-01-02','RESOLUTION-002','Attempted review while removed','admin-a');`, /cannot receive new resolution/);
    sql(`UPDATE "ComplaintRemoval" SET "recoveryUntil"=now() WHERE id='removal';`, /append-only/);
    sql(`DELETE FROM "ComplaintRemoval" WHERE id='removal';`, /append-only/);
    sql(`UPDATE "ComplaintRecord" SET "removedAt"=NULL,"removalId"=NULL, summary='Changed during restore' WHERE id='complaint';`, /preserve its contents/);
    sql(`UPDATE "ComplaintRecord" SET "removedAt"=NULL,"removalId"=NULL WHERE id='complaint';`);
    assert.equal(sql(`SELECT (row_to_json(c)::jsonb - ARRAY['removedAt','removalId','revision'])::text FROM "ComplaintRecord" c;`),
      sql(`SELECT '${before.replaceAll("'", "''")}'::jsonb - 'revision';`));
    assert.equal(sql(`SELECT revision FROM "ComplaintRecord" WHERE id='complaint';`), '3');
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRemoval";`), '1');
    sql(`UPDATE "ComplaintRecord" SET "removalId"='removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='removal') WHERE id='complaint';`, /matching current authority/);
    sql(decision('restored-stale','admin-a','policy',3), /current resolution evidence/);
    sql(`UPDATE "ComplaintRecord" SET "reviewedByBoard"=true WHERE id='complaint';`);
    sql(decision('board','admin-a','policy',4), /without retained board evidence/);
    sql(`INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ('second','a','2026-01-01','Second synthetic complaint','CLOSED',now());
      INSERT INTO "ComplaintResolutionEvidence" (id,"organisationId","complaintId",revision,"recordRevision",state,"resolvedAt","evidenceRef",reason,"actorUserId")
      VALUES ('second-resolution','a','second',1,1,'RECORDED','2026-01-02','RESOLUTION-003','Second reviewed resolution evidence','admin-a');
      INSERT INTO "ComplaintRemoval" (id,"organisationId","complaintId","recordRevision","actorUserId","policyId","resolutionEvidenceId","evidenceRef",reason)
      VALUES ('second-removal','a','second',1,'admin-a','policy','second-resolution','REMOVAL-002','Second reviewed removal authority');
      INSERT INTO "ComplaintResolutionEvidence" (id,"organisationId","complaintId",revision,"recordRevision",state,"resolvedAt","evidenceRef",reason,"actorUserId")
      VALUES ('second-withdrawal','a','second',2,1,'WITHDRAWN',NULL,'RESOLUTION-004','Withdrawn after removal review','admin-a');`);
    sql(`UPDATE "ComplaintRecord" SET "removalId"='second-removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='second-removal') WHERE id='second';`, /authority changed/);
    sql(`INSERT INTO "DataRetentionPolicyWithdrawal" (id,"organisationId","policyId","actorUserId",reason,"evidenceRef")
      VALUES ('withdrawn','a','policy','admin-a','Authority withdrawn before removal','WITHDRAW-001');`);
    sql(`UPDATE "ComplaintRecord" SET "removalId"='second-removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='second-removal') WHERE id='second';`, /matching current authority/);
    assert.equal(sql(`SELECT "removedAt" IS NULL FROM "ComplaintRecord" WHERE id='second';`), 't');
    sql(`INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
      VALUES ('review-policy','a','COMPLAINT',2,'APPROVED','REVIEW_REQUIRED',30,'admin-a','admin-a',now(),'POLICY-003');
      INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ('expired','a','2026-01-01','Expired synthetic complaint','CLOSED',now());
      INSERT INTO "ComplaintRemoval" (id,"organisationId","complaintId","recordRevision","actorUserId","policyId","evidenceRef",reason)
      VALUES ('expired-removal','a','expired',1,'admin-a','review-policy','REMOVAL-003','Individual synthetic removal review');
      UPDATE "ComplaintRecord" SET "removalId"='expired-removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='expired-removal') WHERE id='expired';`);
    // Fixture-only time travel in the disposable database. Re-enable history
    // protection before exercising the real restore guard against an old deadline.
    sql(`ALTER TABLE "ComplaintRemoval" DISABLE TRIGGER "ComplaintRemoval_append_only";
      UPDATE "ComplaintRemoval" SET "recoveryUntil"=timezone('UTC',now())-INTERVAL '1 second' WHERE id='expired-removal';
      ALTER TABLE "ComplaintRemoval" ENABLE TRIGGER "ComplaintRemoval_append_only";`);
    sql(`UPDATE "ComplaintRecord" SET "removalId"=NULL,"removedAt"=NULL WHERE id='expired';`, /recovery window expired/);
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
    const remaining = docker(['ps', '--all', '--filter', `id=${container}`, '--format', '{{.ID}}']);
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.equal(remaining.stdout.trim(), '');
  }
});

