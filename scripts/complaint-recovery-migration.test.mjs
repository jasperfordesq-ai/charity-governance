import { proveCopyAuthority } from './copy-authority-proof.mjs';
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
    const claim=(id,authorization='fresh-purge',complaint='expired',actor='admin-a')=>
      `INSERT INTO "ComplaintPurgeClaim" (id,"organisationId","authorizationId","complaintId","actorUserId")
       VALUES ('${id}','a','${authorization}','${complaint}','${actor}');`;
    sql(claim('early','timed-authorization','timed-review'),/wait for recovery expiry/);
    sql(claim('withdrawn','reviewed-purge'),/unwithdrawn Owner authority/);
    sql(`INSERT INTO "DataRetentionPolicyWithdrawal" (id,"organisationId","policyId","actorUserId",reason,"evidenceRef")
      VALUES ('timed-policy-withdrawn','a','timed-review-policy','admin-a','Replace synthetic timed policy','WITHDRAW-004');
      INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
      VALUES ('final-review-policy','a','COMPLAINT',4,'APPROVED','REVIEW_REQUIRED',30,'admin-a','admin-a',now(),'POLICY-005');`);
    sql(claim('stale-policy','timed-authorization','timed-review'),/current approved complaint policy/);
    sql(authorize('before-new-hold',{holdRevision:2,policy:'final-review-policy'}));
    sql(`INSERT INTO "ComplaintHoldEvent" (id,"organisationId","complaintId",revision,"recordRevision",held,"actorUserId","evidenceRef",reason)
      VALUES ('claim-hold','a','expired',3,2,true,'admin-a','CLAIM-HOLD-001','Preserve after disposal authorization');`);
    sql(claim('held-claim','before-new-hold'),/unchanged unheld revision/);
    sql(`INSERT INTO "ComplaintHoldEvent" (id,"organisationId","complaintId",revision,"recordRevision",held,"actorUserId","evidenceRef",reason)
      VALUES ('claim-hold-release','a','expired',4,2,false,'admin-a','CLAIM-HOLD-002','Release hold after separate review');`);
    sql(claim('stale-hold-claim','before-new-hold'),/unchanged unheld revision/);
    sql(authorize('fresh-purge',{holdRevision:4,policy:'final-review-policy'}));
    sql(claim('wrong-owner','fresh-purge','expired','ordinary-admin'),/matching unwithdrawn Owner authority/);
    // A later transaction failure must roll back the claim, delete and audit.
    sql(`BEGIN; ${claim('rolled-back')} SELECT 1/0; COMMIT;`,/division by zero/);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeClaim";`),'0');
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='expired';`),'1');
    assert.equal(sql(`SELECT count(*) FROM "GovernanceRegisterChangeAudit" WHERE "recordId"='expired';`),'0');
    const claims=await Promise.all([concurrent(claim('claim-a')),concurrent(claim('claim-b'))]);
    assert.equal(claims.filter(result=>result.code===0).length,1);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeClaim";`),'1');
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='expired';`),'0');
    assert.equal(sql(`SELECT "actorUserId"||':'||action||':'||"previousStatus" FROM "GovernanceRegisterChangeAudit" WHERE "recordId"='expired';`),'admin-a:DELETE:RECOVERABLE');
    sql(`INSERT INTO "ComplaintPurgeAuthorizationWithdrawal" (id,"organisationId","authorizationId","actorUserId","evidenceRef",reason)
      VALUES ('too-late','a','fresh-purge','admin-a','WITHDRAW-LATE-001','Cannot withdraw completed primary disposal');`,/cannot be withdrawn/);
    sql(`UPDATE "ComplaintPurgeClaim" SET "actorUserId"='ordinary-admin';`,/append-only/);
    sql(`INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ('expired','a','2026-01-01','Reused identity','CLOSED',now());`,/cannot be reused/);
    // Hold the first transaction open until PostgreSQL proves the competing
    // connection is waiting on its lock. This tests ordering without timing luck.
    async function orderedRace(first, second, rejection) {
      const name = `complaint-race-${randomUUID()}`;
      const leader = spawn('docker', ['--host', endpoint.Host, 'exec', '-i', container,
        'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
      { stdio: ['pipe','pipe','pipe'], timeout: 30_000 });
      let output='', errors='';
      leader.stdout.on('data', data => { output+=data; });
      leader.stderr.on('data', data => { errors+=data; });
      const finished = new Promise((resolve,reject) => {
        leader.on('error',reject); leader.on('close',code=>resolve(code));
      });
      let follower;
      try {
        leader.stdin.write(`BEGIN; ${first} SELECT 'FIRST_READY';\n`);
        for(let attempt=0; attempt<100 && !output.includes('FIRST_READY'); attempt++) {
          assert.equal(errors,'',errors);
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        assert.ok(output.includes('FIRST_READY'),'first transaction acquired its locks');
        follower=concurrent(`SET application_name='${name}'; ${second}`);
        let waiting=false;
        for(let attempt=0; attempt<50 && !waiting; attempt++) {
          waiting=sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock';`)==='1';
          if(!waiting) await new Promise(resolve=>setTimeout(resolve,25));
        }
        assert.ok(waiting,'competing transaction actually waited on a database lock');
        leader.stdin.end('COMMIT;\n');
        assert.equal(await finished,0,errors);
        const result=await follower;
        if(rejection) {
          assert.notEqual(result.code,0,'superseded competing action must be refused');
          assert.match(result.stderr,rejection);
        } else assert.equal(result.code,0,result.stderr);
      } finally {
        if(!leader.stdin.writableEnded) leader.stdin.end('ROLLBACK;\n');
        await finished;
        if(follower) await follower;
      }
    }
    function raceFixture(id, expired=true) {
      sql(`INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
        VALUES ('${id}','a','2026-01-01','Synthetic concurrent complaint','CLOSED',now());
        INSERT INTO "ComplaintRemoval" (id,"organisationId","complaintId","recordRevision","actorUserId","policyId","evidenceRef",reason)
        VALUES ('${id}-removal','a','${id}',1,'admin-a','final-review-policy','RACE-REMOVAL-001','Reviewed synthetic concurrent removal');
        UPDATE "ComplaintRecord" SET "removalId"='${id}-removal',"removedAt"=(SELECT "occurredAt" FROM "ComplaintRemoval" WHERE id='${id}-removal') WHERE id='${id}';`);
      if(expired) sql(`ALTER TABLE "ComplaintRemoval" DISABLE TRIGGER "ComplaintRemoval_append_only";
        UPDATE "ComplaintRemoval" SET "recoveryUntil"=timezone('UTC',now())-INTERVAL '1 second' WHERE id='${id}-removal';
        ALTER TABLE "ComplaintRemoval" ENABLE TRIGGER "ComplaintRemoval_append_only";`);
      sql(`INSERT INTO "ComplaintPurgeAuthorization" (id,"organisationId","complaintId","recordRevision","holdRevision","removalId","policyId","actorUserId","recoveryUntil","dispositionPlan","evidenceRef",reason)
        SELECT '${id}-authority','a','${id}',2,0,id,'final-review-policy','admin-a',"recoveryUntil",'${JSON.stringify(plan)}'::jsonb,'RACE-REVIEW-001','Reviewed synthetic concurrent disposal' FROM "ComplaintRemoval" WHERE id='${id}-removal';`);
      return {
        claim:claim(`${id}-claim`,`${id}-authority`,id),
        hold:`INSERT INTO "ComplaintHoldEvent" (id,"organisationId","complaintId",revision,"recordRevision",held,"actorUserId","evidenceRef",reason)
          VALUES ('${id}-hold','a','${id}',1,2,true,'admin-a','RACE-HOLD-001','Preserve synthetic concurrent record');`,
        withdraw:`INSERT INTO "ComplaintPurgeAuthorizationWithdrawal" (id,"organisationId","authorizationId","actorUserId","evidenceRef",reason)
          VALUES ('${id}-withdrawal','a','${id}-authority','admin-a','RACE-WITHDRAW-001','Withdraw synthetic concurrent authority');`,
        restore:`UPDATE "ComplaintRecord" SET "removedAt"=NULL,"removalId"=NULL WHERE id='${id}';`,
      };
    }
    for(const protection of ['hold','withdraw']) {
      const protectedId=`${protection}-first`;
      const protectedCase=raceFixture(protectedId);
      await orderedRace(protectedCase[protection],protectedCase.claim,
        protection==='hold'?/unchanged unheld revision/:/unwithdrawn Owner authority/);
      assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='${protectedId}';`),'1');
      assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeClaim" WHERE "complaintId"='${protectedId}';`),'0');
      const purgedId=`claim-before-${protection}`;
      const purgedCase=raceFixture(purgedId);
      await orderedRace(purgedCase.claim,purgedCase[protection],
        protection==='hold'?/current same-charity record revision/:/cannot be withdrawn/);
      assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='${purgedId}';`),'0');
      assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeClaim" WHERE "complaintId"='${purgedId}';`),'1');
    }
    // Restoration is only eligible before expiry, when purge is forbidden.
    // Committing a valid restoration while claim waits invalidates the review.
    const restoredCase=raceFixture('restore-first',false);
    await orderedRace(restoredCase.restore,restoredCase.claim,/exact removed record/);
    assert.equal(sql(`SELECT "removedAt" IS NULL FROM "ComplaintRecord" WHERE id='restore-first';`),'t');
    assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeClaim" WHERE "complaintId"='restore-first';`),'0');
    const deletedCase=raceFixture('claim-before-restore');
    // A raw UPDATE waiting behind a committed DELETE affects zero rows. The
    // recovery service separately reports not-found; SQL must not resurrect it.
    await orderedRace(deletedCase.claim,deletedCase.restore);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='claim-before-restore';`),'0');
    assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeClaim" WHERE "complaintId"='claim-before-restore';`),'1');
    const transferred=raceFixture('owner-changed');
    sql(`BEGIN; UPDATE "User" SET role='ADMIN' WHERE id='admin-a';
      UPDATE "User" SET role='OWNER' WHERE id='ordinary-admin'; COMMIT;`);
    sql(transferred.claim,/active charity Owner/);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='owner-changed';`),'1');
    sql(`BEGIN; UPDATE "User" SET role='ADMIN' WHERE id='ordinary-admin';
      UPDATE "User" SET role='OWNER' WHERE id='admin-a'; COMMIT;`);
    const disposition=(id,overrides={})=>{
      const value={organisation:'a',authorization:'fresh-purge',actor:'admin-a',area:'BACKUPS',revision:1,
        status:'RETAINED_APPROVED',observed:"timezone('UTC',clock_timestamp())",next:"timezone('UTC',now())+INTERVAL '30 days'",...overrides};
      return `INSERT INTO "ComplaintPurgeDispositionEvent" (id,"organisationId","authorizationId",area,"scopeRef",revision,status,"actorUserId","evidenceRef",reason,"observedAt","nextReviewAt")
        VALUES ('${id}','${value.organisation}','${value.authorization}','${value.area}','SYNTHETIC-BACKUP-SET',${value.revision},'${value.status}','${value.actor}','COPY-EVIDENCE-001','Reviewed synthetic retained backup scope',${value.observed},${value.next});`;
    };
    sql(disposition('member-copy',{actor:'member-a'}),/active charity owner/);
    sql(disposition('foreign-copy',{organisation:'b',actor:'admin-b'}),/authorization not found/);
    sql(disposition('unclaimed-copy',{authorization:'timed-authorization'}),/committed purge claim/);
    sql(disposition('plan-conflict-copy',{status:'VERIFIED_ABSENT'}),/cannot contradict/);
    sql(disposition('missing-followup-copy',{next:'NULL'}),/future follow-up/);
    sql(disposition('future-copy',{observed:"timezone('UTC',now())+INTERVAL '1 day'"}),/between claim and recording/);
    sql(disposition('before-claim-copy',{observed:"'2000-01-01'::timestamp"}),/between claim and recording/);
    sql(disposition('primary-copy',{area:'PRIMARY',status:'NEEDS_REVIEW'}),/check constraint/);
    sql(disposition('retained-backup'));
    sql(disposition('stale-copy'),/revision changed/);
    sql(`UPDATE "ComplaintPurgeDispositionEvent" SET status='VERIFIED_ABSENT';`,/append-only/);
    sql(`DELETE FROM "ComplaintPurgeDispositionEvent";`,/append-only/);
    const corrections=await Promise.all([
      concurrent(disposition('copy-correction-a',{revision:2,status:'NEEDS_REVIEW'})),
      concurrent(disposition('copy-correction-b',{revision:2,status:'NEEDS_REVIEW'})),
    ]);
    assert.equal(corrections.filter(result=>result.code===0).length,1);
    assert.match(corrections.find(result=>result.code!==0).stderr,/revision changed/);
    assert.equal(sql(`SELECT count(*) FROM "ComplaintPurgeDispositionEvent";`),'2');
    assert.equal(sql(`SELECT count(*) FROM "ComplaintRecord" WHERE id='expired';`),'0');
    const scopedAuthority = proveCopyAuthority(sql, {kind:'Complaint',organisation:'a',actor:'admin-a',foreignActor:'admin-b',authorization:'fresh-purge',scope:'SYNTHETIC-BACKUP-SET',observationRevision:2});
    const competingAuthority = await Promise.all(['a','b'].map(suffix=>concurrent(scopedAuthority.review(`competing-authority-${suffix}`,{revision:4,previous:"'replacement-copy'"}))));
    assert.equal(competingAuthority.filter(result=>result.code===0).length,1);
    assert.match(competingAuthority.find(result=>result.code!==0).stderr,/authority revision/);
    const lastScopeAuthority=sql(`SELECT id FROM "ComplaintCopyDispositionAuthority" WHERE revision=4;`);
    await orderedRace(scopedAuthority.hold('racing-hold',{revision:5}),
      scopedAuthority.review('blocked-copy-review',{revision:5,previous:`'${lastScopeAuthority}'`,holdRevision:4}),/current unheld scope/);
    sql(scopedAuthority.hold('racing-release',{revision:6,held:false}));
    await orderedRace(scopedAuthority.review('review-before-hold',{revision:5,previous:`'${lastScopeAuthority}'`,holdRevision:6}),
      scopedAuthority.hold('hold-after-review',{revision:7}));
    assert.equal(sql(`SELECT "holdRevision" FROM "ComplaintCopyDispositionAuthority" WHERE id='review-before-hold';`),'6');
    assert.equal(sql(`SELECT held FROM "ComplaintCopyHoldEvent" WHERE id='hold-after-review';`),'t');
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
          for(const table of ['ComplaintHoldEvent','ComplaintRemoval','ComplaintResolutionEvidence','ComplaintRecoveryState','ComplaintPurgeAuthorization','ComplaintPurgeAuthorizationWithdrawal','ComplaintPurgeClaim','ComplaintPurgeDispositionEvent','ComplaintCopyDispositionAuthority','ComplaintCopyHoldEvent']) {
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

