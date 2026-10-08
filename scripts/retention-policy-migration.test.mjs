import { proveDocumentPolicyConflict } from './document-policy-conflict-proof.mjs';
import { proveCopyBinding } from './copy-binding-proof.mjs';
import { proveCopyAuthority } from './copy-authority-proof.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { PURGE_RESTORE_SNAPSHOT_SQL, PURGE_RESTORE_LOCAL_OBJECTS_SQL, assertNoClaimedLocalObjects, assertPurgeRestoreLedger } from './purge-restore-reconciliation.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const target = '20260930010000_retention_policy_revisions';
const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

test('retention policy and recovery-state upgrade preserve documents and enforce scoped transitions', { timeout: 240_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  function docker(args, input) {
    return spawnSync('docker', ['--host', endpoint.Host, ...args], { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  }
  const info = docker(['info', '--format', '{{.OSType}}']);
  assert.equal(info.status, 0, info.stderr);
  assert.equal(info.stdout.trim(), 'linux');
  const name = `charitypilot-retention-proof-${randomUUID()}`;
  const started = docker(['run', '--detach', '--network', 'none', '--name', name,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-policy-proof', image]);
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  function sql(statement, rejectPattern) {
    const result = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
    if (rejectPattern) {
      assert.notEqual(result.status, 0, 'invalid policy fact was accepted');
      assert.match(result.stderr, rejectPattern);
    } else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const sessions = [];
  function session(label, statement, keepOpen = false) {
    const child = spawn('docker', ['--host', endpoint.Host, 'exec', '--env', `PGAPPNAME=${label}`, '-i', container,
      'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), 20000);
    const done = new Promise(resolve => {
      child.on('error', error => { stderr += String(error); });
      child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    child.stdin.on('error', () => {});
    if (keepOpen) child.stdin.write(`${statement}\n`); else child.stdin.end(statement);
    const item = { child, done, output: () => stdout };
    sessions.push(item);
    return item;
  }
  async function until(check, message) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(message);
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'disposable PostgreSQL final TCP server did not start');
    const names = readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert.ok(names.includes(target));
    for (const name of names.filter(name => name < target)) {
      const migration = readFileSync(`${migrations}/${name}/migration.sql`, 'utf8');
      // Prisma submits a migration as one batch. Preserve temporary tables
      // declared ON COMMIT DROP instead of psql committing each statement.
      sql(/^\s*BEGIN;/m.test(migration) || /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(migration)
        ? migration : `BEGIN;\n${migration}\nCOMMIT;`);
    }
    sql(`BEGIN;
      INSERT INTO "Organisation" ("id","name","updatedAt") VALUES ('retention-a','Synthetic A',CURRENT_TIMESTAMP),('retention-b','Synthetic B',CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id","email","name","passwordHash","role","organisationId","updatedAt") VALUES
        ('owner-a','retention-a@example.invalid','Synthetic Owner A','fixture-password-hash','OWNER','retention-a',CURRENT_TIMESTAMP),
        ('owner-b','retention-b@example.invalid','Synthetic Owner B','fixture-password-hash','OWNER','retention-b',CURRENT_TIMESTAMP);
      INSERT INTO "Document" ("id","organisationId","name","category","fileUrl","fileSize","mimeType","updatedAt") VALUES ('retained-doc','retention-a','Keep unchanged','OTHER','retention-a/file.pdf',12,'application/pdf',CURRENT_TIMESTAMP);
      INSERT INTO "DocumentUploadIntent" ("id","organisationId","storagePath","provider","updatedAt") VALUES ('retained-intent','retention-a','retention-a/reserved.pdf','local',CURRENT_TIMESTAMP);
      COMMIT;`);
    const before = sql(`SELECT row_to_json(d)::text FROM "Document" d WHERE id='retained-doc'; SELECT row_to_json(i)::text FROM "DocumentUploadIntent" i WHERE id='retained-intent';`);
    sql(readFileSync(`${migrations}/${target}/migration.sql`, 'utf8'));
    assert.equal(sql(`SELECT row_to_json(d)::text FROM "Document" d WHERE id='retained-doc'; SELECT row_to_json(i)::text FROM "DocumentUploadIntent" i WHERE id='retained-intent';`), before);
    assert.equal(sql('SELECT count(*) FROM "DataRetentionPolicyRevision"; SELECT count(*) FROM "DataRetentionPolicyWithdrawal";'), '0\n0');
    const insert = (_id, extra = '') => `INSERT INTO "DataRetentionPolicyRevision" ("id","organisationId","recordClass","revision","retentionMode","recoveryDays","createdById"${extra})`;
    sql(`${insert('draft')} VALUES ('draft','retention-a','VAULT_DRAFT',1,'REVIEW_REQUIRED',30,'owner-a');`);
    sql(`UPDATE "DataRetentionPolicyRevision" SET "recoveryDays"=1 WHERE id='draft';`, /append-only/);
    sql(`DELETE FROM "DataRetentionPolicyRevision" WHERE id='draft';`, /append-only/);
    sql(`${insert('bad')} VALUES ('bad','retention-a','VAULT_DRAFT',2,'AFTER_ANCHOR',30,'owner-a');`, /period_valid/);
    sql(`${insert('bad')} VALUES ('bad','retention-a','VAULT_DRAFT',2,'PERMANENT',0,'owner-a');`, /period_valid/);
    sql(`${insert('bad', ',"state","approvedById","approvedAt"')} VALUES ('bad','retention-a','VAULT_DRAFT',2,'REVIEW_REQUIRED',30,'owner-a','APPROVED','owner-a',CURRENT_TIMESTAMP);`, /approval_valid/);
    sql(`${insert('foreign-actor')} VALUES ('foreign-actor','retention-a','VAULT_DRAFT',2,'REVIEW_REQUIRED',30,'owner-b');`, /active administrator/);
    sql(`${insert('bad')} VALUES ('bad','missing-org','VAULT_DRAFT',1,'REVIEW_REQUIRED',30,'owner-a');`, /active administrator/);
    sql(`${insert('duplicate')} VALUES ('duplicate','retention-a','VAULT_DRAFT',1,'REVIEW_REQUIRED',30,'owner-a');`, /org_class_revision_key/);
    sql(`${insert('approved', ',"state","approvedById","approvedAt","approvalEvidenceRef"')} VALUES ('approved','retention-a','VAULT_DRAFT',2,'REVIEW_REQUIRED',30,'owner-a','APPROVED','owner-a',CURRENT_TIMESTAMP,'POLICY-APPROVAL-001');`);
    sql(`${insert('timed', ',"retentionAnchor","retentionDays"')} VALUES ('timed','retention-a','COMPLAINT',1,'AFTER_ANCHOR',30,'owner-a','RESOLVED_AT',2190);`);
    sql(`${insert('permanent')} VALUES ('permanent','retention-a','MINUTE_BOOK',1,'PERMANENT',30,'owner-a');`);
    const withdrawal = (id, org, policy) => `INSERT INTO "DataRetentionPolicyWithdrawal" ("id","organisationId","policyId","actorUserId","reason","evidenceRef") VALUES ('${id}','${org}','${policy}','owner-a','Withdraw pending revised authority','POLICY-WITHDRAWAL-001');`;
    sql(withdrawal('foreign', 'retention-b', 'approved'), /active charity owner/);
    sql(withdrawal('not-approved', 'retention-a', 'draft'), /Only an approved policy/);
    sql(withdrawal('withdrawn', 'retention-a', 'approved'));
    sql(withdrawal('duplicate-withdrawal', 'retention-a', 'approved'), /unique constraint/);
    sql(`UPDATE "DataRetentionPolicyWithdrawal" SET reason='Changed after the event' WHERE id='withdrawn';`, /append-only/);
    sql(`DELETE FROM "DataRetentionPolicyWithdrawal" WHERE id='withdrawn';`, /append-only/);
    assert.equal(sql(`SELECT count(*) FROM "DataRetentionPolicyRevision" p WHERE state='APPROVED' AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id AND w."organisationId"=p."organisationId");`), '0');
    sql(readFileSync(`${migrations}/20260930020000_document_recoverable_state/migration.sql`, 'utf8'));
    assert.equal(sql(`SELECT count(*) FROM "Document" WHERE "deletedAt" IS NOT NULL;`), '0');
    sql(`${insert('recovery', ',"state","approvedById","approvedAt","approvalEvidenceRef"')} VALUES ('recovery','retention-a','VAULT_DRAFT',3,'REVIEW_REQUIRED',30,'owner-a','APPROVED','owner-a',CURRENT_TIMESTAMP,'POLICY-APPROVAL-003');`);
    sql(`UPDATE "Document" SET "lifecycleStatus"='DRAFT', "storageProvider"='local' WHERE id='retained-doc';`);
    const active = sql(`SELECT (to_jsonb(d) - 'updatedAt')::text FROM "Document" d WHERE id='retained-doc';`);
    const remove = (policy = 'recovery', days = 30) => `UPDATE "Document" SET "deletedAt"=timezone('UTC',statement_timestamp()), "deletedById"='owner-a', "removedFromRevision"="updatedAt", "removalEvidenceRef"='REMOVAL-001', "recoveryPolicyId"='${policy}', "recoveryUntil"=timezone('UTC',statement_timestamp()) + INTERVAL '${days} days', "updatedAt"=timezone('UTC',statement_timestamp()) WHERE id='retained-doc';`;
    sql(remove('draft'), /approved current draft recovery policy/);
    sql(remove('approved'), /approved current draft recovery policy/);
    sql(remove('recovery', 1), /revision or recovery deadline/);
    sql(remove());
    sql(`INSERT INTO "ConfluenceReference" (id,"organisationId","documentId","cloudId","pageId","pageTitle","pageVersion","citedAt","citedById","updatedAt") VALUES ('blocked-reference','retention-a','retained-doc','synthetic-site','synthetic-page','Synthetic citation',1,CURRENT_TIMESTAMP,'owner-a',CURRENT_TIMESTAMP);`, /cannot receive new evidence references/);
    sql(`INSERT INTO "Document" (id,"organisationId",name,category,"fileUrl","fileSize","mimeType","updatedAt","supersededByDocumentId") VALUES ('blocked-predecessor','retention-a','Synthetic predecessor','OTHER','retention-a/predecessor.pdf',12,'application/pdf',CURRENT_TIMESTAMP,'retained-doc');`, /cannot receive new evidence references/);
    assert.equal(sql(`SELECT "fileUrl" || ':' || "fileSize" FROM "Document" WHERE id='retained-doc'; SELECT count(*) FROM "DocumentStorageDeletion";`), 'retention-a/file.pdf:12\n0');
    sql(`UPDATE "Document" SET name='Unexpected overwrite' WHERE id='retained-doc';`, /cannot be rewritten/);
    sql(`DELETE FROM "Document" WHERE id='retained-doc';`, /authorized purge transition/);
    sql(`UPDATE "Document" SET "deletionHold"=true WHERE id='retained-doc';`);
    sql(`UPDATE "Document" SET "deletedAt"=NULL,"deletedById"=NULL,"removedFromRevision"=NULL,"removalEvidenceRef"=NULL,"recoveryPolicyId"=NULL,"recoveryUntil"=NULL WHERE id='retained-doc';`);
    assert.equal(sql(`SELECT "deletionHold" FROM "Document" WHERE id='retained-doc';`), 't');
    sql(remove(), /hold or linked evidence review/);
    sql(`UPDATE "Document" SET "deletionHold"=false WHERE id='retained-doc';`);
    assert.equal(sql(`SELECT (to_jsonb(d) - 'updatedAt')::text FROM "Document" d WHERE id='retained-doc';`), active);
    sql(withdrawal('recovery-withdrawn', 'retention-a', 'recovery'));
    sql(remove(), /approved current draft recovery policy/);
    sql(readFileSync(`${migrations}/20260930030000_document_recovery_fingerprint/migration.sql`, 'utf8'));
    sql(`${insert('fingerprint', ',"state","approvedById","approvedAt","approvalEvidenceRef"')} VALUES ('fingerprint','retention-a','VAULT_DRAFT',4,'REVIEW_REQUIRED',30,'owner-a','APPROVED','owner-a',CURRENT_TIMESTAMP,'POLICY-APPROVAL-004');`);
    sql(remove('fingerprint'), /Document_recovery_digest_valid/);
    sql(remove('fingerprint').replace('SET "deletedAt"', `SET "recoverySha256"='${'a'.repeat(64)}', "deletedAt"`));
    sql(`UPDATE "Document" SET "recoverySha256"='${'b'.repeat(64)}' WHERE id='retained-doc';`, /cannot be rewritten/);
    sql(`UPDATE "Document" SET "deletedAt"=NULL,"deletedById"=NULL,"removedFromRevision"=NULL,"removalEvidenceRef"=NULL,"recoveryPolicyId"=NULL,"recoveryUntil"=NULL,"recoverySha256"=NULL WHERE id='retained-doc';`);
    assert.equal(sql(`SELECT count(*) FROM "Document" WHERE id='retained-doc' AND "recoverySha256" IS NULL AND "deletedAt" IS NULL;`), '1');
    const fingerprintRemoval = remove('fingerprint').replace('SET "deletedAt"', `SET "recoverySha256"='${'a'.repeat(64)}', "deletedAt"`);
    sql(readFileSync(`${migrations}/20260930040000_document_purge_authorization/migration.sql`, 'utf8'));
    const plan = Object.fromEntries(['PRIMARY','VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS'].map(area =>
      [area, { disposition: area === 'PRIMARY' ? 'DISPOSE' : 'RETAIN_APPROVED', evidenceRef: `PLAN-${area}-001` }]));
    const authorize = (id, actor = 'owner-a', dispositionPlan = plan, pathExpression = '"fileUrl"') => `INSERT INTO "DocumentPurgeAuthorization"
      (id,"organisationId","documentId","documentRevision","policyId","actorUserId","evidenceRef",reason,"storagePath",provider,sha256,"fileSize","recoveryUntil","dispositionPlan")
      SELECT '${id}',"organisationId",id,"updatedAt",'fingerprint','${actor}','PURGE-AUTH-001','Synthetic disposal plan for test evidence',${pathExpression},"storageProvider","recoverySha256","fileSize","recoveryUntil",'${JSON.stringify(dispositionPlan)}'::jsonb FROM "Document" WHERE id='retained-doc';`;
    sql(authorize('active'), /unheld removed draft/);
    sql(fingerprintRemoval);
    sql(authorize('foreign', 'owner-b'), /active charity owner/);
    sql(authorize('wrong-object', 'owner-a', plan, "'retention-a/other.pdf'"), /exact retained revision and object/);
    sql(authorize('missing-stores', 'owner-a', { PRIMARY: plan.PRIMARY }), /all six stores/);
    sql(authorize('invented-absence', 'owner-a', { ...plan, VERSIONS: { disposition: 'VERIFIED_ABSENT', evidenceRef: 'PLAN-001' } }), /disposition and controlled evidence/);
    sql(`UPDATE "Document" SET "deletionHold"=true WHERE id='retained-doc';`);
    sql(authorize('held'), /unheld removed draft/);
    sql(`UPDATE "Document" SET "deletionHold"=false WHERE id='retained-doc';`);
    sql(authorize('authorized'));
    sql(`UPDATE "DocumentPurgeAuthorization" SET reason='Rewrite approval after authorization' WHERE id='authorized';`, /append-only/);
    sql(`DELETE FROM "DocumentPurgeAuthorization" WHERE id='authorized';`, /append-only/);
    sql(`DELETE FROM "Document" WHERE id='retained-doc';`, /authorized purge transition/);
    assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeAuthorization"; SELECT count(*) FROM "DocumentStorageDeletion";`), '1\n0');
    sql(readFileSync(`${migrations}/20260930050000_document_purge_withdrawal/migration.sql`, 'utf8'));
    assert.equal(sql(`SELECT count(*) FROM pg_constraint WHERE conrelid IN ('"DocumentPurgeAuthorization"'::regclass,'"DocumentPurgeAuthorizationWithdrawal"'::regclass) AND contype='f' AND confupdtype='c';`), '3');
    assert.equal(sql(`SELECT count(*) FROM pg_indexes WHERE indexname IN ('DocumentPurgeAuthorization_organisationId_documentId_author_idx','DocumentPurgeAuthorizationWithdrawal_organisationId_occurre_idx','DocumentPurgeAuthorizationWithdrawal_authorizationId_organi_key');`), '3');
    const withdrawPurge = (id, org = 'retention-a', actor = 'owner-a') => `INSERT INTO "DocumentPurgeAuthorizationWithdrawal"
      (id,"organisationId","authorizationId","actorUserId",reason,"evidenceRef") VALUES
      ('${id}','${org}','authorized','${actor}','Cancel the synthetic disposal decision','PURGE-WITHDRAW-001');`;
    sql(withdrawPurge('foreign-owner', 'retention-a', 'owner-b'), /active charity owner/);
    sql(withdrawPurge('foreign-auth', 'retention-b', 'owner-b'), /not found in this charity/);
    sql(`INSERT INTO "User" (id,email,name,"passwordHash",role,"organisationId","updatedAt") VALUES
      ('admin-a','retention-admin@example.invalid','Synthetic Admin','fixture-password-hash','ADMIN','retention-a',CURRENT_TIMESTAMP);`);
    sql(withdrawPurge('admin', 'retention-a', 'admin-a'), /active charity owner/);
    const withdrawing = session('purge-withdraw-holder', `BEGIN; ${withdrawPurge('withdrawn-purge')} SELECT 'BARRIER';`, true);
    await until(() => withdrawing.output().includes('BARRIER'), 'purge withdrawal did not reach its barrier');
    const duplicateWithdrawal = session('purge-withdraw-duplicate', withdrawPurge('duplicate-purge'));
    await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='purge-withdraw-duplicate' AND wait_event_type='Lock';`) === '1',
      'duplicate purge withdrawal did not serialize');
    withdrawing.child.stdin.end('COMMIT;\n');
    assert.equal((await withdrawing.done).code, 0);
    const duplicateResult = await duplicateWithdrawal.done;
    assert.notEqual(duplicateResult.code, 0);
    assert.match(duplicateResult.stderr, /unique constraint/);
    sql(`UPDATE "DocumentPurgeAuthorizationWithdrawal" SET reason='Rewrite cancellation after the event';`, /append-only/);
    sql(`DELETE FROM "DocumentPurgeAuthorizationWithdrawal";`, /append-only/);
    assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeAuthorizationWithdrawal"; SELECT count(*) FROM "DocumentStorageDeletion"; SELECT count(*) FROM "Document" WHERE id='retained-doc' AND "deletedAt" IS NOT NULL;`), '1\n0\n1');
    sql(`UPDATE "Document" SET "deletedAt"=NULL,"deletedById"=NULL,"removedFromRevision"=NULL,"removalEvidenceRef"=NULL,"recoveryPolicyId"=NULL,"recoveryUntil"=NULL,"recoverySha256"=NULL WHERE id='retained-doc';`);
    for (const race of ['hold', 'withdrawal']) {
      const mutation = race === 'hold'
        ? `UPDATE "Document" SET "deletionHold"=true WHERE id='retained-doc';`
        : withdrawal('concurrent-withdrawal', 'retention-a', 'fingerprint');
      const holder = session(`recovery-holder-${race}`, `BEGIN; ${mutation} SELECT 'BARRIER';`, true);
      await until(() => holder.output().includes('BARRIER'), 'guard transaction did not reach its barrier');
      const blocked = session(`recovery-blocked-${race}`, fingerprintRemoval);
      await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='recovery-blocked-${race}' AND wait_event_type='Lock';`) === '1',
        'removal did not wait on the competing row lock');
      holder.child.stdin.end('COMMIT;\n');
      assert.equal((await holder.done).code, 0);
      const result = await blocked.done;
      assert.notEqual(result.code, 0, `${race} race accepted removal`);
      assert.match(result.stderr, race === 'hold' ? /hold or linked evidence review/ : /approved current draft recovery policy/);
      assert.equal(sql(`SELECT count(*) FROM "Document" WHERE id='retained-doc' AND "deletedAt" IS NULL; SELECT count(*) FROM "DocumentStorageDeletion";`), '1\n0');
      if (race === 'hold') sql(`UPDATE "Document" SET "deletionHold"=false WHERE id='retained-doc';`);
    }
    sql(readFileSync(`${migrations}/20260930060000_document_purge_claim/migration.sql`, 'utf8'));
    sql(`${insert('purge-current', ',"state","approvedById","approvedAt","approvalEvidenceRef"')} VALUES ('purge-current','retention-a','VAULT_DRAFT',5,'REVIEW_REQUIRED',30,'owner-a','APPROVED','owner-a',CURRENT_TIMESTAMP,'POLICY-APPROVAL-005');`);
    sql(fingerprintRemoval.replace("'fingerprint'", "'purge-current'"));
    const authorizePurge = id => authorize(id).replace("'fingerprint'", "'purge-current'");
    const claim = (id, auth = 'expired-authorization', actor = 'owner-a') => `INSERT INTO "DocumentPurgeClaim"
      (id,"organisationId","authorizationId","documentId","deletionId","actorUserId") VALUES
      ('${id}','retention-a','${auth}','retained-doc','job-${id}','${actor}');`;
    sql(authorizePurge('unexpired-authorization'));
    sql(claim('too-early', 'unexpired-authorization'), /retention and recovery expiry/);
    sql(claim('withdrawn', 'authorized'), /unwithdrawn Owner authority/);
    const restoring = session('purge-restore-holder', `BEGIN;
      UPDATE "Document" SET "deletedAt"=NULL,"deletedById"=NULL,"removedFromRevision"=NULL,"removalEvidenceRef"=NULL,"recoveryPolicyId"=NULL,"recoveryUntil"=NULL,"recoverySha256"=NULL,"updatedAt"=timezone('UTC',statement_timestamp()) WHERE id='retained-doc';
      SELECT 'BARRIER';`, true);
    await until(() => restoring.output().includes('BARRIER'), 'restore did not reach its barrier');
    const afterRestore = session('purge-after-restore', claim('restore-loser', 'unexpired-authorization'));
    await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='purge-after-restore' AND wait_event_type='Lock';`) === '1',
      'purge did not wait for restoration');
    restoring.child.stdin.end('COMMIT;\n');
    assert.equal((await restoring.done).code, 0);
    const restoreRace = await afterRestore.done;
    assert.notEqual(restoreRace.code, 0);
    assert.match(restoreRace.stderr, /unheld removed draft/);
    assert.equal(sql(`SELECT count(*) FROM "Document" WHERE id='retained-doc' AND "deletedAt" IS NULL; SELECT count(*) FROM "DocumentStorageDeletion";`), '1\n0');
    sql(fingerprintRemoval.replace("'fingerprint'", "'purge-current'"));
    // Advance only this disposable fixture's removal dates; production has no
    // clock override. Constraints stay enabled; normal mutations cannot age it.
    sql(`BEGIN; ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard";
      UPDATE "Document" SET "deletedAt"="deletedAt"-INTERVAL '31 days',"recoveryUntil"="recoveryUntil"-INTERVAL '31 days' WHERE id='retained-doc';
      ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard"; COMMIT;`);
    sql(claim('changed-deadline', 'unexpired-authorization'), /authorized revision and object/);
    sql(authorize('expired-authorization', 'owner-a', { ...plan, VERSIONS: { disposition: 'DISPOSE', evidenceRef: 'PLAN-VERSIONS-002' }, EXPORTS: { disposition: 'NOT_APPLICABLE', evidenceRef: 'PLAN-EXPORTS-002' } }).replace("'fingerprint'", "'purge-current'"));
    sql(`${insert('future-retention', ',"state","approvedById","approvedAt","approvalEvidenceRef","retentionAnchor","retentionDays"')} VALUES ('future-retention','retention-a','VAULT_DRAFT',6,'AFTER_ANCHOR',30,'owner-a','APPROVED','owner-a',CURRENT_TIMESTAMP,'POLICY-APPROVAL-006','CREATED_AT',365);`);
    sql(authorize('retention-not-due').replace("'fingerprint'", "'future-retention'"));
    sql(claim('retention-loser', 'retention-not-due'), /retention and recovery expiry/);
    sql(claim('foreign-actor', 'expired-authorization', 'owner-b'), /active charity owner/);
    sql(`UPDATE "Document" SET "deletionHold"=true WHERE id='retained-doc';`);
    sql(claim('held-claim'), /unheld removed draft/);
    sql(`UPDATE "Document" SET "deletionHold"=false WHERE id='retained-doc';`);
    sql(`BEGIN; ${claim('rollback-claim')} ROLLBACK;`);
    assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeClaim"; SELECT count(*) FROM "DocumentStorageDeletion"; SELECT count(*) FROM "Document" WHERE id='retained-doc';`), '0\n0\n1');
    for (const guard of ['hold', 'cancellation']) {
      const authId = `race-${guard}-authorization`;
      sql(authorizePurge(authId));
      const mutation = guard === 'hold' ? `UPDATE "Document" SET "deletionHold"=true WHERE id='retained-doc';`
        : withdrawPurge('race-cancellation').replace("'authorized'", `'${authId}'`);
      const holder = session(`purge-guard-${guard}`, `BEGIN; ${mutation} SELECT 'BARRIER';`, true);
      await until(() => holder.output().includes('BARRIER'), 'purge guard did not reach its barrier');
      const waiting = session(`purge-waiting-${guard}`, claim(`blocked-${guard}`, authId));
      await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='purge-waiting-${guard}' AND wait_event_type='Lock';`) === '1',
        'purge did not wait for its competing guard');
      holder.child.stdin.end('COMMIT;\n');
      assert.equal((await holder.done).code, 0);
      const result = await waiting.done;
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, guard === 'hold' ? /unheld removed draft/ : /unwithdrawn Owner authority/);
      assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeClaim"; SELECT count(*) FROM "DocumentStorageDeletion"; SELECT count(*) FROM "Document" WHERE id='retained-doc';`), '0\n0\n1');
      if (guard === 'hold') sql(`UPDATE "Document" SET "deletionHold"=false WHERE id='retained-doc';`);
    }
    // Keep an actual pre-claim backup to prove that faithful restoration can
    // still resurrect a document whose purge was authorized after the backup.
    const oldBackup = docker(['exec', container, 'pg_dump', '-U', 'postgres', '--no-owner', '--no-privileges', 'postgres']);
    assert.equal(oldBackup.status, 0, oldBackup.stderr);
    const claiming = session('purge-claim-holder', `BEGIN; ${claim('final-claim')} SELECT 'BARRIER';`, true);
    await until(() => claiming.output().includes('BARRIER'), 'purge claim did not reach its barrier');
    const duplicateClaim = session('purge-claim-duplicate', claim('duplicate-claim'));
    await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='purge-claim-duplicate' AND wait_event_type='Lock';`) === '1',
      'duplicate purge claim did not serialize');
    claiming.child.stdin.end('COMMIT;\n');
    assert.equal((await claiming.done).code, 0);
    const duplicateClaimResult = await duplicateClaim.done;
    assert.notEqual(duplicateClaimResult.code, 0);
    assert.match(duplicateClaimResult.stderr, /unheld removed draft|unique constraint/);
    assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeClaim"; SELECT count(*) FROM "DocumentStorageDeletion"; SELECT count(*) FROM "Document" WHERE id='retained-doc';`), '1\n1\n0');
    assert.equal(sql(`SELECT provider || ':' || "storagePath" || ':' || "sourceDocumentId" || ':' || state FROM "DocumentStorageDeletion" WHERE id='job-final-claim';`), 'local:retention-a/file.pdf:retained-doc:PENDING');
    assert.equal(sql(`SELECT next FROM "DocumentControlAudit" WHERE id='final-claim';`), 'PRIMARY_PURGE_PENDING');
    sql(withdrawPurge('too-late').replace("'authorized'", "'expired-authorization'"), /cannot recall storage dispatch/);
    sql(`UPDATE "DocumentPurgeClaim" SET "actorUserId"='owner-b';`, /append-only/);
    sql(`DELETE FROM "DocumentPurgeClaim";`, /append-only/);
    sql(`UPDATE "DocumentStorageDeletion" SET "storagePath"='retention-a/other.pdf' WHERE id='job-final-claim';`, /cannot redirect|identity is immutable/);
    // Upgrade after an irreversible primary claim: downstream evidence must
    // survive the already-absent Document without changing the queued job.
    const jobBefore = sql(`SELECT row_to_json(j)::text FROM "DocumentStorageDeletion" j WHERE id='job-final-claim';`);
    sql(readFileSync(`${migrations}/20260930070000_document_purge_disposition/migration.sql`, 'utf8'));
    const evidence = (id, { org = 'retention-a', actor = 'owner-a', auth = 'expired-authorization', area = 'VERSIONS', scope = 'VERSION-SET-001', revision = 1,
      status = 'VERIFIED_ABSENT', observed = 'CURRENT_TIMESTAMP', nextReview = 'NULL', ref = 'PROVIDER-RECEIPT-001' } = {}) => `INSERT INTO "DocumentPurgeDispositionEvent"
      (id,"organisationId","authorizationId",area,"scopeRef",revision,status,"actorUserId","evidenceRef",reason,"observedAt","nextReviewAt","occurredAt")
      VALUES ('${id}','${org}','${auth}','${area}','${scope}',${revision},'${status}','${actor}','${ref}',
      'Reviewed synthetic scoped provider evidence',${observed},${nextReview},'2000-01-01');`;
    sql(evidence('foreign-owner', { actor: 'owner-b' }), /active charity owner/);
    sql(evidence('foreign-auth', { org: 'retention-b', actor: 'owner-b' }), /authorization not found/);
    sql(evidence('unclaimed', { auth: 'unexpired-authorization' }), /requires a committed purge claim/);
    sql(evidence('manual-primary', { area: 'PRIMARY' }), /check constraint/);
    sql(evidence('retained-not-absent', { area: 'BACKUPS' }), /cannot contradict/);
    sql(evidence('wrong-retain', { status: 'RETAINED_APPROVED', nextReview: "CURRENT_TIMESTAMP + INTERVAL '1 day'" }), /cannot contradict/);
    sql(evidence('future', { observed: "CURRENT_TIMESTAMP + INTERVAL '1 day'" }), /observation must be/);
    sql(evidence('old', { observed: "CURRENT_TIMESTAMP - INTERVAL '1 day'" }), /observation must be/);
    sql(evidence('no-followup', { status: 'FAILED' }), /future follow-up/);
    sql(evidence('past-followup', { status: 'FAILED', nextReview: "CURRENT_TIMESTAMP - INTERVAL '1 day'" }), /future follow-up/);
    sql(evidence('url-evidence', { ref: 'https://private.example/receipt' }), /check constraint/);
    sql(evidence('jump', { revision: 2 }), /revision changed/);
    sql(evidence('verified'));
    assert.equal(sql(`SELECT status || ':' || revision || ':' || ("occurredAt">'2026-01-01') FROM "DocumentPurgeDispositionEvent" WHERE id='verified';`), 'VERIFIED_ABSENT:1:true');
    sql(evidence('retained-backup', { area: 'BACKUPS', scope: 'BACKUP-SET-001', status: 'RETAINED_APPROVED', nextReview: "CURRENT_TIMESTAMP + INTERVAL '1 day'" }));
    sql(evidence('no-exports', { area: 'EXPORTS', scope: 'RECIPIENT-INVENTORY-001', status: 'NOT_APPLICABLE' }));
    // A reviewed absence may later be corrected; history is never overwritten.
    const correcting = session('disposition-holder', `BEGIN; ${evidence('correction', { revision: 2, status: 'NEEDS_REVIEW', nextReview: "CURRENT_TIMESTAMP + INTERVAL '1 day'" })} SELECT 'BARRIER';`, true);
    await until(() => correcting.output().includes('BARRIER'), 'disposition correction did not reach its barrier');
    const stale = session('disposition-stale', evidence('stale', { revision: 2 }));
    await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='disposition-stale' AND wait_event_type='Lock';`) === '1', 'disposition writes did not serialize');
    correcting.child.stdin.end('COMMIT;');
    assert.equal((await correcting.done).code, 0);
    const staleResult = await stale.done;
    assert.notEqual(staleResult.code, 0); assert.match(staleResult.stderr, /revision changed/);
    sql(`UPDATE "DocumentPurgeDispositionEvent" SET status='VERIFIED_ABSENT' WHERE id='correction';`, /append-only/);
    sql(`DELETE FROM "DocumentPurgeDispositionEvent" WHERE id='verified';`, /append-only/);
    assert.equal(sql(`SELECT string_agg(status,',' ORDER BY revision) FROM "DocumentPurgeDispositionEvent" WHERE area='VERSIONS';`), 'VERIFIED_ABSENT,NEEDS_REVIEW');
    assert.equal(sql(`SELECT row_to_json(j)::text FROM "DocumentStorageDeletion" j WHERE id='job-final-claim';`), jobBefore,
      'review evidence must not dispatch, complete, redirect or alter primary cleanup');
    for (const name of names.filter(name => name > '20260930070000_document_purge_disposition')) {
      sql(readFileSync(`${migrations}/${name}/migration.sql`, 'utf8'));
    }
    // Exercise the explicit activation fence independently of the existing
    // period constraint. A later schema expansion alone must not let a new
    // mode through to day-only disposal guards.
    sql(`BEGIN; ALTER TABLE "DataRetentionPolicyRevision" DROP CONSTRAINT "DataRetentionPolicyRevision_period_valid";
      INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,"retentionMode","recoveryDays","createdById")
      VALUES ('unknown-calendar-mode','retention-a','VAULT_DRAFT',200,'AFTER_CALENDAR_YEARS',30,'owner-a');
      ROLLBACK;`, /Unsupported retention policy mode/);
    assert.equal(sql(`SELECT count(*) FROM "DataRetentionPolicyRevision" WHERE id='unknown-calendar-mode';`), '0');
    sql(`BEGIN; INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,"retentionMode","recoveryDays","createdById")
      VALUES ('known-review-mode','retention-a','VAULT_DRAFT',200,'REVIEW_REQUIRED',30,'owner-a'); ROLLBACK;`);
    assert.equal(sql(`SELECT count(*) FROM "DataRetentionPolicyRevision" WHERE "retentionYears" IS NOT NULL;`), '0',
      'existing day-based policies must not acquire invented year terms');
    const calendarInsert = (years, days = 'NULL', anchor = "'CREATED_AT'") => `BEGIN;
      ALTER TABLE "DataRetentionPolicyRevision" DISABLE TRIGGER "DataRetentionPolicyRevision_01_mode_fence";
      INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,"retentionMode",
        "retentionAnchor","retentionDays","retentionYears","recoveryDays","createdById")
      VALUES ('calendar-shape','retention-a','VAULT_DRAFT',200,'AFTER_CALENDAR_YEARS',${anchor},${days},${years},30,'owner-a');
      ROLLBACK;`;
    sql(calendarInsert('6'));
    for (const invalid of [calendarInsert('NULL'), calendarInsert('0'), calendarInsert('101'),
      calendarInsert('6', '2190'), calendarInsert('6', 'NULL', 'NULL')]) {
      sql(invalid, /DataRetentionPolicyRevision_period_valid/);
    }
    assert.equal(sql(`SELECT count(*) FROM "DataRetentionPolicyRevision" WHERE id='calendar-shape';`), '0');
    const calendarRemoval = createdAt => `BEGIN;
      INSERT INTO "Organisation" (id,name,"updatedAt") VALUES ('retention-calendar','Synthetic calendar charity',CURRENT_TIMESTAMP);
      INSERT INTO "User" (id,email,name,"passwordHash",role,"organisationId","updatedAt")
        VALUES ('calendar-owner','calendar-owner@example.invalid','Synthetic calendar owner','fixture-password-hash',
          'OWNER','retention-calendar',CURRENT_TIMESTAMP);
      ALTER TABLE "DataRetentionPolicyRevision" DISABLE TRIGGER "DataRetentionPolicyRevision_01_mode_fence";
      INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode",
        "retentionAnchor","retentionYears","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
        VALUES ('calendar-approved','retention-calendar','VAULT_DRAFT',1,'APPROVED','AFTER_CALENDAR_YEARS',
          'CREATED_AT',6,30,'calendar-owner','calendar-owner',CURRENT_TIMESTAMP,'CALENDAR-TEST-001');
      ALTER TABLE "DataRetentionPolicyRevision" ENABLE TRIGGER "DataRetentionPolicyRevision_01_mode_fence";
      INSERT INTO "Document" (id,"organisationId",name,category,"fileUrl","fileSize","mimeType",
        "createdAt","updatedAt","lifecycleStatus","storageProvider")
        VALUES ('calendar-doc','retention-calendar','Synthetic calendar draft','OTHER','retention-calendar/doc.pdf',
          4,'application/pdf','${createdAt}'::timestamp(3),CURRENT_TIMESTAMP,'DRAFT','local');
      UPDATE "Document" SET "deletedAt"=timezone('UTC',statement_timestamp()),"deletedById"='calendar-owner',
        "removedFromRevision"="updatedAt","removalEvidenceRef"='CALENDAR-REMOVE-001',
        "recoveryPolicyId"='calendar-approved',"recoveryUntil"=timezone('UTC',statement_timestamp())+INTERVAL '30 days',
        "recoverySha256"=repeat('a',64),"updatedAt"=timezone('UTC',statement_timestamp())
        WHERE id='calendar-doc';
      SELECT "deletedAt" IS NOT NULL FROM "Document" WHERE id='calendar-doc';
      ROLLBACK;`;
    sql(calendarRemoval('2024-02-29 12:34:56.789'), /calendar-year retention period has not been satisfied/);
    assert.equal(sql(calendarRemoval('2020-02-29 12:34:56.789')), 't');
    assert.equal(sql(`SELECT count(*) FROM "Document" WHERE id='calendar-doc';`), '0');
    // Isolate the new claim trigger from the existing claim dispatch and
    // custody guards. Both cases roll back; this tests its cutoff decision,
    // not permission to run a real purge.
    const calendarClaim = createdAt => `BEGIN;
      INSERT INTO "Organisation" (id,name,"updatedAt") VALUES ('retention-calendar','Synthetic calendar charity',CURRENT_TIMESTAMP);
      INSERT INTO "User" (id,email,name,"passwordHash",role,"organisationId","updatedAt")
        VALUES ('calendar-owner','calendar-owner@example.invalid','Synthetic calendar owner','fixture-password-hash',
          'OWNER','retention-calendar',CURRENT_TIMESTAMP);
      ALTER TABLE "DataRetentionPolicyRevision" DISABLE TRIGGER "DataRetentionPolicyRevision_01_mode_fence";
      INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode",
        "retentionAnchor","retentionYears","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
        VALUES ('calendar-approved','retention-calendar','VAULT_DRAFT',1,'APPROVED','AFTER_CALENDAR_YEARS',
          'CREATED_AT',6,30,'calendar-owner','calendar-owner',CURRENT_TIMESTAMP,'CALENDAR-TEST-001');
      ALTER TABLE "DataRetentionPolicyRevision" ENABLE TRIGGER "DataRetentionPolicyRevision_01_mode_fence";
      INSERT INTO "Document" (id,"organisationId",name,category,"fileUrl","fileSize","mimeType",
        "createdAt","updatedAt","lifecycleStatus","storageProvider")
        VALUES ('calendar-doc','retention-calendar','Synthetic calendar draft','OTHER','retention-calendar/doc.pdf',
          4,'application/pdf','${createdAt}'::timestamp(3),CURRENT_TIMESTAMP,'DRAFT','local');
      ALTER TABLE "DocumentPurgeAuthorization" DISABLE TRIGGER USER;
      INSERT INTO "DocumentPurgeAuthorization" (id,"organisationId","documentId","documentRevision","policyId",
        "actorUserId","evidenceRef",reason,"storagePath",provider,sha256,"fileSize","recoveryUntil","dispositionPlan")
        VALUES ('calendar-auth','retention-calendar','calendar-doc',CURRENT_TIMESTAMP,'calendar-approved',
          'calendar-owner','CALENDAR-AUTH-001','Synthetic claim cutoff isolation',
          'retention-calendar/doc.pdf','local',repeat('a',64),4,CURRENT_TIMESTAMP,'{}'::jsonb);
      ALTER TABLE "DocumentPurgeAuthorization" ENABLE TRIGGER USER;
      ALTER TABLE "DocumentPurgeClaim" DISABLE TRIGGER USER;
      ALTER TABLE "DocumentPurgeClaim" ENABLE TRIGGER "DocumentPurgeClaim_calendar_guard";
      INSERT INTO "DocumentPurgeClaim" (id,"organisationId","authorizationId","documentId","deletionId","actorUserId")
        VALUES ('calendar-claim','retention-calendar','calendar-auth','calendar-doc','calendar-job','calendar-owner');
      SELECT count(*) FROM "DocumentPurgeClaim" WHERE id='calendar-claim';
      ROLLBACK;`;
    sql(calendarClaim('2024-02-29 12:34:56.789'), /must wait for calendar-year retention expiry/);
    assert.equal(sql(calendarClaim('2020-02-29 12:34:56.789')), '1');
    assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeClaim" WHERE id='calendar-claim';`), '0');
    proveCopyAuthority(sql, {kind:'Document',organisation:'retention-a',actor:'owner-a',foreignActor:'owner-b',authorization:'expired-authorization',scope:'BACKUP-SET-001',observationRevision:1});
    // The earlier primary-retention scenario deliberately left two approvals.
    // New original-plan copy evidence must reject that ambiguity until reviewed.
    sql(evidence('ambiguous-original-plan',{area:'BACKUPS',scope:'AMBIGUOUS-POLICY',status:'RETAINED_APPROVED',nextReview:"CURRENT_TIMESTAMP+INTERVAL '1 day'"}),/current original-plan policy/);
    sql(withdrawal('future-retention-withdrawn','retention-a','future-retention'));
    await proveCopyBinding(sql,{kind:'Document',organisation:'retention-a',actor:'owner-a',authorization:'expired-authorization'});
    await proveDocumentPolicyConflict(sql,plan,async(first,second,rejection)=>{
      const holder=session('policy-ambiguity-writer',`BEGIN; ${first} SELECT 'BARRIER';`,true);
      await until(()=>holder.output().includes('BARRIER'),'policy approval did not acquire its lock');
      const follower=session('policy-ambiguity-claim',second);
      await until(()=>sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='policy-ambiguity-claim' AND wait_event_type='Lock';`)==='1','claim did not wait for policy approval');
      holder.child.stdin.end('COMMIT;\n');assert.equal((await holder.done).code,0);
      const result=await follower.done;assert.notEqual(result.code,0);assert.match(result.stderr,rejection);
    });
    const authority = JSON.parse(sql(PURGE_RESTORE_SNAPSHOT_SQL));
    const localKeys = JSON.parse(sql(PURGE_RESTORE_LOCAL_OBJECTS_SQL));
    assert.equal(localKeys.length, 1);
    assert.throws(() => assertNoClaimedLocalObjects(localKeys, [{ path: 'retention-a/file.pdf' }]),
      { code: 'PURGE_RESTORE_LOCAL_OBJECTS_PRESENT' });
    assert.equal(assertNoClaimedLocalObjects(localKeys, [{ path: 'retention-b/file.pdf' }]).claimedLocalObjectsPresent, 0);
    function restoredSql(database, statement) {
      const result = docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    for (const database of ['old_restore', 'current_restore']) {
      assert.equal(docker(['exec', container, 'createdb', '-U', 'postgres', database]).status, 0);
    }
    restoredSql('old_restore', oldBackup.stdout);
    for (const name of names.filter(name => name >= '20260930070000_document_purge_disposition')) {
      restoredSql('old_restore', readFileSync(`${migrations}/${name}/migration.sql`, 'utf8'));
    }
    const oldRestored = JSON.parse(restoredSql('old_restore', PURGE_RESTORE_SNAPSHOT_SQL));
    assert.throws(() => assertPurgeRestoreLedger(authority, oldRestored), error => {
      assert.equal(error.code, 'PURGE_RESTORE_RECONCILIATION_REQUIRED');
      assert.equal(error.report.resurrectedDocuments, 1);
      assert.ok(error.report.differences.some(item => item.table === 'DocumentCopyHoldEvent' && item.missing === 7));
      assert.ok(error.report.differences.some(item => item.table === 'DocumentCopyDispositionAuthority' && item.missing === 11));
      assert.ok(error.report.differences.some(item => item.table === 'DocumentPurgeClaim' && item.missing === 1));
      return true;
    });
    // Exercise the inactive document recovery transaction on an isolated copy
    // of the pre-claim database. These plausible receipt fields prove SQL
    // ordering only; they do not stand in for authenticated remote publication.
    const rejectRestored = (statement, pattern) => {
      const result = docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'old_restore',
        '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
    };
    assert.equal(restoredSql('old_restore', `SELECT count(*) FROM "Document" WHERE id='retained-doc';`), '1');
    restoredSql('old_restore', withdrawal('fixture-future-policy-withdrawn','retention-a','future-retention'));
    restoredSql('old_restore', `INSERT INTO "DocumentRecoveryEnforcement"
      (id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('binding','retention-a','installation','writer',1);`);
    rejectRestored(claim('no-recovery-execution'), /same-transaction recovery execution/);
    assert.equal(restoredSql('old_restore', `SELECT count(*) FROM "DocumentPurgeClaim";
      SELECT count(*) FROM "DocumentStorageDeletion" WHERE "sourceDocumentId"='retained-doc';`), '0\n0');
    restoredSql('old_restore', `WITH candidate AS (
      SELECT jsonb_build_object('format',1,'action','DOCUMENT_PURGE_PREPARATION',
        'organisationId','retention-a','installationId','installation',
        'operationId','operation','writerEpoch',1,'actorUserId','owner-a',
        'authorization',jsonb_build_object('id',a.id,'storagePath',a."storagePath",'provider',a.provider),
        'document',jsonb_build_object('id',d.id,'updatedAt',
          to_char(d."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'fileUrl',d."fileUrl",'storageProvider',d."storageProvider",
          'recoverySha256',d."recoverySha256",'fileSize',d."fileSize"),
        'policy',jsonb_build_object('id',a."policyId"))::text AS body
      FROM "Document" d JOIN "DocumentPurgeAuthorization" a ON a."documentId"=d.id
      WHERE d.id='retained-doc' AND a.id='expired-authorization')
      INSERT INTO "DocumentRecoveryPreparation"
        (id,"organisationId","installationId","operationId","writerEpoch",
          "authorizationId","actorUserId",facts,"factsDigest")
      SELECT 'prepared','retention-a','installation','operation',1,
        'expired-authorization','owner-a',body,
        encode(sha256(convert_to(body,'UTF8')),'hex') FROM candidate;`);
    const execution = `INSERT INTO "DocumentRecoveryExecution"
      (id,"preparationId","writerId",generation,"entryDigest","envelopeDigest","controlRevision")
      VALUES ('execution','prepared','writer',1,repeat('a',64),repeat('b',64),'synthetic-control');`;
    rejectRestored(`BEGIN; ${execution} COMMIT;`, /requires atomic claim, job and outcome/);
    assert.equal(restoredSql('old_restore', `SELECT count(*) FROM "DocumentRecoveryExecution";`), '0');
    restoredSql('old_restore', `BEGIN;
      ${execution}
      ${claim('with-recovery-execution')}
      INSERT INTO "DocumentRecoveryOutcome" (id,"preparationId","claimId")
        VALUES ('outcome','prepared','with-recovery-execution');
      COMMIT;`);
    assert.equal(restoredSql('old_restore', `SELECT count(*) FROM "DocumentRecoveryExecution";
      SELECT count(*) FROM "DocumentRecoveryOutcome";
      SELECT count(*) FROM "DocumentPurgeClaim" WHERE id='with-recovery-execution';
      SELECT count(*) FROM "DocumentStorageDeletion" WHERE id='job-with-recovery-execution';
      SELECT count(*) FROM "Document" WHERE id='retained-doc';`), '1\n1\n1\n1\n0');
    const currentBackup = docker(['exec', container, 'pg_dump', '-U', 'postgres', '--no-owner', '--no-privileges', 'postgres']);
    assert.equal(currentBackup.status, 0, currentBackup.stderr);
    restoredSql('current_restore', currentBackup.stdout);
    const currentRestored = JSON.parse(restoredSql('current_restore', PURGE_RESTORE_SNAPSHOT_SQL));
    const reconciled = assertPurgeRestoreLedger(authority, currentRestored);
    assert.equal(reconciled.databaseLedgerMatches, true);
    assert.equal(reconciled.objectAndExternalCopyReconciliationRequired, true);
    // A faithful ledger can coexist with stale mutable document controls.
    // Rewind only the isolated restored database, never the authority source.
    for (const change of [
      `"deletionHold"=NOT "deletionHold"`,
      `"deletedAt"=NULL,"recoverySha256"=NULL,"deletedById"=NULL,"removedFromRevision"=NULL,
        "removalEvidenceRef"=NULL,"recoveryUntil"=NULL,"recoveryPolicyId"=NULL`,
      `"recoveryUntil"="recoveryUntil"+INTERVAL '1 day'`,
      `"visibility"='MEMBER_VISIBLE',"lifecycleStatus"='CURRENT',
        "contentAccessClass"='MEMBER_SUITABLE',"memberReviewedSha256"=repeat('a',64),
        "deletedAt"=NULL,"recoverySha256"=NULL,"deletedById"=NULL,"removedFromRevision"=NULL,
        "removalEvidenceRef"=NULL,"recoveryUntil"=NULL,"recoveryPolicyId"=NULL`,
    ]) {
      const staleControls = JSON.parse(restoredSql('current_restore', `BEGIN;
        ALTER TABLE "Document" DISABLE TRIGGER USER;
        UPDATE "Document" SET ${change} WHERE id='policy-conflict-doc';
        ${PURGE_RESTORE_SNAPSHOT_SQL}
        ROLLBACK;`));
      assert.throws(() => assertPurgeRestoreLedger(authority, staleControls), error => {
        assert.equal(error.code, 'PURGE_RESTORE_RECONCILIATION_REQUIRED');
        assert.ok(error.report.differences.some(item => item.table === 'DocumentRecoveryState' && item.changed === 1));
        return true;
      }, `restored document control drift was accepted: ${change}`);
    }
  } finally {
    for (const item of sessions) if (item.child.exitCode === null) item.child.stdin.end('ROLLBACK;\n');
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
    const residue = docker(['ps', '--all', '--filter', `id=${container}`, '--format', '{{.ID}}']);
    assert.equal(residue.status, 0, residue.stderr);
    assert.equal(residue.stdout.trim(), '', 'disposable database remains');
    await Promise.all(sessions.map(item => item.done));
  }
});
