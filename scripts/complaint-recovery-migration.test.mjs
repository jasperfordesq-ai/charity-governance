import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { PURGE_RESTORE_SNAPSHOT_SQL, assertPurgeRestoreLedger } from './purge-restore-reconciliation.mjs';

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
    for (const name of names.filter(name => name >= target)) {
      sql(readFileSync(`${migrations}/${name}/migration.sql`, 'utf8'));
    }
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
    const oldBackup = docker(['exec',container,'pg_dump','-U','postgres','--no-owner','--no-privileges','postgres']);
    assert.equal(oldBackup.status,0,oldBackup.stderr);
    const hold = (id, revision, held, actor='admin-a', recordRevision=1, organisation='a') =>
      `INSERT INTO "ComplaintHoldEvent" (id,"organisationId","complaintId",revision,"recordRevision",held,"actorUserId","evidenceRef",reason)
       VALUES ('${id}','${organisation}','complaint',${revision},${recordRevision},${held},'${actor}','HOLD-001','Reviewed synthetic administrative hold');`;
    sql(hold('no-initial-release',1,false), /must change the current hold state/);
    sql(hold('member-hold',1,true,'member-a'), /active charity administrator/);
    sql(hold('foreign-actor-hold',1,true,'admin-b'), /active charity administrator/);
    sql(hold('foreign-record-hold',1,true,'admin-b',1,'b'), /current same-charity record revision/);
    sql(hold('stale-record-hold',1,true,'admin-a',2), /current same-charity record revision/);
    sql(hold('hold-active',1,true));
    sql(hold('duplicate-hold',2,true), /must change the current hold state/);
    sql(hold('stale-hold',1,false), /hold revision conflict/);
    sql(decision('held-removal'), /administrative hold blocks removal/);
    sql(`DELETE FROM "ComplaintRecord" WHERE id='complaint';`, /administrative hold blocks/);
    sql(`UPDATE "ComplaintHoldEvent" SET held=false WHERE id='hold-active';`, /append-only/);
    sql(`DELETE FROM "ComplaintHoldEvent" WHERE id='hold-active';`, /append-only/);
    assert.equal(sql(`SELECT revision FROM "ComplaintRecord" WHERE id='complaint';`),'1');
    sql(hold('release-active',2,false));
    sql(`UPDATE "ComplaintRecord" SET "removedAt"=now(),"removalId"='unreviewed' WHERE id='complaint';`, /matching current authority/);
    sql(decision('removal'));
    // A hold arriving after a reviewed decision still blocks its application.
    sql(hold('hold-reviewed',3,true));
    sql(`UPDATE "ComplaintRecord" SET "removalId"='removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='removal') WHERE id='complaint';`, /administrative hold blocks/);
    sql(hold('release-reviewed',4,false));
    assert.equal(sql(`SELECT "recoveryUntil"="occurredAt"+INTERVAL '30 days' FROM "ComplaintRemoval" WHERE id='removal';`), 't');
    sql(`UPDATE "ComplaintRecord" SET "removalId"='removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='removal'), summary='Changed during removal' WHERE id='complaint';`, /preserve its contents/);
    sql(`UPDATE "ComplaintRecord" SET "removalId"='removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='removal') WHERE id='complaint';`);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE "organisationId"='a' AND "removedAt" IS NULL;`), '0');
    sql(hold('hold-removed',5,true,'admin-a',2));
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
    assert.equal(sql(`SELECT held FROM "ComplaintHoldEvent" WHERE "complaintId"='complaint' ORDER BY revision DESC LIMIT 1;`),'t');
    // Restoring held evidence is permitted and does not silently clear its hold.
    sql(hold('release-restored',6,false,'admin-a',3));
    // Separate database connections race the same reviewed hold revision.
    const concurrent = statement => new Promise((resolve, reject) => {
      const child = spawn('docker', ['--host', endpoint.Host, 'exec', '-i', container,
        'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
      { stdio: ['pipe','pipe','pipe'], timeout: 30_000 });
      let stderr='';
      child.stdout.resume(); child.stderr.on('data', value => { stderr+=value; });
      child.on('error',reject); child.on('close',code => resolve({ code, stderr }));
      child.stdin.end(statement);
    });
    const competing = await Promise.all([
      concurrent(hold('concurrent-a',7,true,'admin-a',3)),
      concurrent(hold('concurrent-b',7,true,'admin-a',3)),
    ]);
    assert.equal(competing.filter(result => result.code===0).length,1);
    assert.match(competing.find(result => result.code!==0).stderr,/hold revision conflict/);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintHoldEvent" WHERE revision=7;`),'1');
    sql(hold('release-concurrent',8,false,'admin-a',3));
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
    const plan=Object.fromEntries(['PRIMARY','SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES'].map(area=>
      [area,{disposition:area==='PRIMARY'?'DISPOSE':'RETAIN_APPROVED',evidenceRef:'COPY-REVIEW-001'}]));
    const authorize=(id,overrides={})=>{
      const value={actor:'admin-a',recordRevision:2,holdRevision:0,policy:'review-policy',deadline:'"recoveryUntil"',plan,...overrides};
      return `INSERT INTO "ComplaintPurgeAuthorization" (id,"organisationId","complaintId","recordRevision","holdRevision","removalId","policyId","actorUserId","recoveryUntil","dispositionPlan","evidenceRef",reason)
        SELECT '${id}','a','expired',${value.recordRevision},${value.holdRevision},id,'${value.policy}','${value.actor}',${value.deadline},'${JSON.stringify(value.plan)}'::jsonb,'PURGE-REVIEW-001','Reviewed synthetic disposal authority' FROM "ComplaintRemoval" WHERE id='expired-removal';`;
    };
    sql(`INSERT INTO "User" (id,email,name,"passwordHash",role,"organisationId","updatedAt")
      VALUES ('ordinary-admin','complaint-admin@example.invalid','Synthetic Admin','fixture','ADMIN','a',now());`);
    sql(authorize('admin-purge',{actor:'ordinary-admin'}),/active charity Owner/);
    sql(authorize('member-purge',{actor:'member-a'}),/active charity Owner/);
    sql(authorize('foreign-purge',{actor:'admin-b'}),/active charity Owner/);
    sql(authorize('stale-purge',{recordRevision:1}),/exact record and recovery decision/);
    sql(authorize('changed-deadline-purge',{deadline:'now()'}),/exact record and recovery decision/);
    sql(authorize('wrong-policy-purge',{policy:'vault'}),/current approved complaint policy/);
    sql(authorize('withdrawn-policy-purge',{policy:'policy'}),/current approved complaint policy/);
    sql(authorize('missing-plan-purge',{plan:{PRIMARY:plan.PRIMARY}}),/six areas/);
    sql(authorize('null-plan-purge',{plan:null}),/six areas/);
    sql(authorize('null-area-purge',{plan:{...plan,BACKUPS:null}}),/area missing/);
    sql(authorize('bad-evidence-purge',{plan:{...plan,BACKUPS:{disposition:'RETAIN_APPROVED',evidenceRef:'private@example.invalid'}}}),/reviewed dispositions and references/);
    sql(authorize('bad-primary-purge',{plan:{...plan,PRIMARY:{disposition:'RETAIN_APPROVED',evidenceRef:'COPY-001'}}}),/primary disposition must be disposal/);
    sql(`INSERT INTO "ComplaintHoldEvent" (id,"organisationId","complaintId",revision,"recordRevision",held,"actorUserId","evidenceRef",reason)
      VALUES ('expired-hold','a','expired',1,2,true,'admin-a','HOLD-EXPIRED-001','Preserve this synthetic removed record');`);
    sql(authorize('held-purge',{holdRevision:1}),/current unheld revision/);
    sql(`INSERT INTO "ComplaintHoldEvent" (id,"organisationId","complaintId",revision,"recordRevision",held,"actorUserId","evidenceRef",reason)
      VALUES ('expired-hold-release','a','expired',2,2,false,'admin-a','HOLD-EXPIRED-002','Release reviewed synthetic preservation');`);
    sql(authorize('stale-hold-purge'),/current unheld revision/);
    sql(authorize('reviewed-purge',{holdRevision:2}));
    sql(`DELETE FROM "ComplaintRecord" WHERE id='expired';`,/separate verified workflow/);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='expired';`),'1');
    sql(`UPDATE "ComplaintPurgeAuthorization" SET reason='Altered disposal authority' WHERE id='reviewed-purge';`,/append-only/);
    const withdraw=(actor,organisation='a')=>`INSERT INTO "ComplaintPurgeAuthorizationWithdrawal" (id,"organisationId","authorizationId","actorUserId","evidenceRef",reason)
      VALUES ('purge-withdrawn','${organisation}','reviewed-purge','${actor}','PURGE-WITHDRAW-001','Withdrawal of reviewed disposal authority');`;
    sql(withdraw('ordinary-admin'),/active charity Owner/);
    sql(withdraw('admin-b','b'),/same-charity authorization/);
    sql(withdraw('admin-a'));
    sql(`DELETE FROM "ComplaintPurgeAuthorizationWithdrawal";`,/append-only/);
    sql(`INSERT INTO "DataRetentionPolicyWithdrawal" (id,"organisationId","policyId","actorUserId",reason,"evidenceRef")
      VALUES ('review-policy-withdrawn','a','review-policy','admin-a','Replace synthetic review-only policy','WITHDRAW-003');
      INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","retentionAnchor","retentionDays","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
      VALUES ('timed-review-policy','a','COMPLAINT',3,'APPROVED','AFTER_ANCHOR','RESOLVED_AT',1,30,'admin-a','admin-a',now(),'POLICY-004');`);
    sql(authorize('missing-original-anchor',{policy:'timed-review-policy',holdRevision:2}),/matching original resolution evidence/);
    sql(`INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ('timed-review','a','2026-01-01','Synthetic timed review complaint','CLOSED',now());
      INSERT INTO "ComplaintResolutionEvidence" (id,"organisationId","complaintId",revision,"recordRevision",state,"resolvedAt","evidenceRef",reason,"actorUserId")
      VALUES ('timed-resolution','a','timed-review',1,1,'RECORDED','2026-01-02','RESOLUTION-005','Reviewed timed resolution before removal','admin-a');
      INSERT INTO "ComplaintRemoval" (id,"organisationId","complaintId","recordRevision","actorUserId","policyId","resolutionEvidenceId","evidenceRef",reason)
      VALUES ('timed-removal','a','timed-review',1,'admin-a','timed-review-policy','timed-resolution','REMOVAL-004','Reviewed timed complaint removal');
      UPDATE "ComplaintRecord" SET "removalId"='timed-removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='timed-removal') WHERE id='timed-review';
      INSERT INTO "ComplaintPurgeAuthorization" (id,"organisationId","complaintId","recordRevision","holdRevision","removalId","policyId","actorUserId","recoveryUntil","dispositionPlan","evidenceRef",reason)
      SELECT 'timed-authorization','a','timed-review',2,0,id,'timed-review-policy','admin-a',"recoveryUntil",'${JSON.stringify(plan)}'::jsonb,'PURGE-REVIEW-002','Reviewed timed complaint disposal plan' FROM "ComplaintRemoval" WHERE id='timed-removal';`);
    assert.equal(sql(`SELECT a."recoveryUntil"=r."recoveryUntil" AND a."recoveryUntil">now()
      FROM "ComplaintPurgeAuthorization" a JOIN "ComplaintRemoval" r ON r.id=a."removalId" WHERE a.id='timed-authorization';`),'t');
    sql(`DELETE FROM "ComplaintRecord" WHERE id='timed-review';`,/separate verified workflow/);
    const authority = JSON.parse(sql(PURGE_RESTORE_SNAPSHOT_SQL));
    assert.doesNotMatch(JSON.stringify(authority), /Private original narrative|Reviewed synthetic administrative hold|HOLD-001/);
    const currentBackup = docker(['exec',container,'pg_dump','-U','postgres','--no-owner','--no-privileges','postgres']);
    assert.equal(currentBackup.status,0,currentBackup.stderr);
    for (const [database,backup] of [['old_complaint_restore',oldBackup],['current_complaint_restore',currentBackup]]) {
      const created = docker(['exec',container,'createdb','-U','postgres',database]);
      assert.equal(created.status,0,created.stderr);
      const restored = docker(['exec','-i',container,'psql','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-q'],backup.stdout);
      assert.equal(restored.status,0,restored.stderr);
      const captured = docker(['exec','-i',container,'psql','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-Atq'],PURGE_RESTORE_SNAPSHOT_SQL);
      assert.equal(captured.status,0,captured.stderr);
      const snapshot = JSON.parse(captured.stdout);
      if(database==='old_complaint_restore') {
        assert.throws(()=>assertPurgeRestoreLedger(authority,snapshot),error=>{
          assert.equal(error.code,'PURGE_RESTORE_RECONCILIATION_REQUIRED');
          for(const table of ['ComplaintHoldEvent','ComplaintRemoval','ComplaintResolutionEvidence','ComplaintRecoveryState','ComplaintPurgeAuthorization','ComplaintPurgeAuthorizationWithdrawal']) {
            assert.ok(error.report.differences.some(item=>item.table===table && (item.missing || item.changed)),table);
          }
          return true;
        });
      } else assert.equal(assertPurgeRestoreLedger(authority,snapshot).databaseLedgerMatches,true);
    }
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
    const remaining = docker(['ps', '--all', '--filter', `id=${container}`, '--format', '{{.ID}}']);
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.equal(remaining.stdout.trim(), '');
  }
});

