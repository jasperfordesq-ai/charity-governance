import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

test('retained Confluence review and permission history is scoped, immutable and cannot execute erasure', { timeout: 240_000 }, async () => {
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
  const name = `charitypilot-copy-review-${randomUUID()}`;
  const started = docker(['run', '--detach', '--network', 'none', '--name', name,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-policy-fence', image]);
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  const query = (statement, rejectPattern) => {
    const result = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
    if (rejectPattern) {
      assert.notEqual(result.status, 0, 'a prohibited Confluence evidence or permission write was accepted');
      assert.match(result.stderr, rejectPattern);
    } else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) {
        ready = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'disposable PostgreSQL server did not start');
    const names = readdirSync(migrations, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert.ok(names.includes('20261015190000_confluence_retained_copy_review'));
    for (const migration of names) {
      const body = readFileSync(`${migrations}/${migration}/migration.sql`, 'utf8');
      query(/^\s*BEGIN;/m.test(body) || /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(body)
        ? body : `BEGIN;\n${body}\nCOMMIT;`);
    }
    query(`BEGIN; CREATE ROLE synthetic_copy_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT USAGE ON SCHEMA public TO synthetic_copy_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO synthetic_copy_runtime;
      INSERT INTO "Organisation"(id,name,"updatedAt") VALUES ('org-a','Synthetic A',CURRENT_TIMESTAMP),('org-b','Synthetic B',CURRENT_TIMESTAMP);
      INSERT INTO "User"(id,email,name,"passwordHash",role,"organisationId","updatedAt") VALUES
      ('owner-a','a@example.invalid','Synthetic A','not-a-login','OWNER','org-a',CURRENT_TIMESTAMP),
      ('owner-b','b@example.invalid','Synthetic B','not-a-login','OWNER','org-b',CURRENT_TIMESTAMP),
      ('member-a','m@example.invalid','Synthetic Member','not-a-login','MEMBER','org-a',CURRENT_TIMESTAMP);
      INSERT INTO "Document"(id,"organisationId",name,category,"fileUrl","fileSize","mimeType","lifecycleStatus","updatedAt")
      VALUES ('doc-a','org-a','Synthetic retained','OTHER','org-a/source.txt',243,'text/plain','RETIRED',CURRENT_TIMESTAMP - INTERVAL '2 minutes');
      INSERT INTO "DocumentPublication"(id,"organisationId","documentId",state,"cloudId","spaceId","pageId","retiredAt","nextAttemptAt","updatedAt")
      VALUES ('pub-a','org-a','doc-a','RETIRED','00000000-0000-4000-8000-000000000001','123','456',CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP - INTERVAL '1 minute'); COMMIT;`);
    query(`INSERT INTO "OrganisationIntegration"(id,"organisationId",provider,status,config,"connectedAt","connectedById","grantedScopes","updatedAt")
      VALUES ('confluence-a','org-a','CONFLUENCE','CONNECTED',
        '{"siteId":"00000000-0000-4000-8000-000000000001","siteUrl":"https://synthetic-example.atlassian.net"}',
        CURRENT_TIMESTAMP,'owner-a',ARRAY['read:page:confluence','read:attachment:confluence'],CURRENT_TIMESTAMP);`);
    const reviewInsert = (id, transform = '') => `SET ROLE synthetic_copy_runtime;
      WITH data AS (SELECT d.*, p."updatedAt" AS "pubRevision" FROM "Document" d
        JOIN "DocumentPublication" p ON p."documentId"=d.id WHERE d.id='doc-a'),
      payload AS (SELECT jsonb_build_object(
        'scope','SYNTHETIC_ONLY','primaryDisposition','RETAIN','copyDisposition','PURGE','reviewerId','owner-a',
        'evidenceRef','C01-REVIEW','retentionDecisionRef','C01-RETAIN','holdReviewRef','C01-HOLD',
        'inventoryEvidenceRef','C01-INVENTORY','syntheticEvidenceRef','C01-SYNTHETIC',
        'reviewedAt',to_char(timezone('UTC',statement_timestamp()),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expiresAt',to_char(timezone('UTC',statement_timestamp()) + INTERVAL '1 hour','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'snapshot',jsonb_build_object('organisationId','org-a','documentId','doc-a','publicationId','pub-a',
          'sourceRevision',to_char("updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'publicationRevision',to_char("pubRevision",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'lifecycleStatus','RETIRED','deletionHold',false,'externalPublicationApproved',false,
          'publicationState','RETIRED','cloudId','00000000-0000-4000-8000-000000000001',
          'spaceId','123','pageId','456','siteOrigin','https://synthetic-example.atlassian.net',
          'sourceSha256',repeat('a',64),'inventory',jsonb_build_object('status','CURRENT','complete',true,
            'observedAt',to_char(timezone('UTC',statement_timestamp()) - INTERVAL '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'currentPageVersion',1,'pageVersions',jsonb_build_array(1),'attachments','[]'::jsonb))) AS j FROM data)
      INSERT INTO "ConfluenceRetainedCopyReview"(id,"organisationId","documentId","publicationId","reviewerId","snapshotSha256",review,"reviewedAt","expiresAt")
      SELECT '${id}','org-a','doc-a','pub-a','owner-a',repeat('b',64),j ${transform},
        date_trunc('milliseconds',timezone('UTC',statement_timestamp())),
        date_trunc('milliseconds',timezone('UTC',statement_timestamp()) + INTERVAL '1 hour') FROM payload;`;
    query(reviewInsert('review-a'));
    query(reviewInsert('review-member').replaceAll('owner-a','member-a'), /active charity owner/);
    query(reviewInsert('review-other-owner').replaceAll('owner-a','owner-b'), /active charity owner/);
    query(`SET ROLE synthetic_copy_runtime;
      INSERT INTO "ConfluenceRetainedCopyReview"(id,"organisationId","documentId","publicationId","reviewerId","snapshotSha256",review,"reviewedAt","expiresAt","authorisesProviderIO")
      SELECT 'fabricated-permission',"organisationId","documentId","publicationId","reviewerId","snapshotSha256",review,"reviewedAt","expiresAt",true
      FROM "ConfluenceRetainedCopyReview" WHERE id='review-a';`, /exact non-authorising/);
    assert.equal(query(`SELECT has_table_privilege('synthetic_copy_runtime','"ConfluenceRetainedCopyReview"','TRUNCATE');`), 'f');
    query(`SET ROLE synthetic_copy_runtime; ALTER TABLE "ConfluenceRetainedCopyReview" DISABLE TRIGGER ALL;`, /must be owner/);
    assert.equal(query(`SELECT "authorisesProviderIO" FROM "ConfluenceRetainedCopyReview" WHERE id='review-a';`), 'f');
    query(`SET ROLE synthetic_copy_runtime; UPDATE "ConfluenceRetainedCopyReview" SET "authorisesProviderIO"=true WHERE id='review-a';`, /append-only/);
    query(`SET ROLE synthetic_copy_runtime; DELETE FROM "ConfluenceRetainedCopyReview" WHERE id='review-a';`, /append-only/);
    query(`TRUNCATE "ConfluenceRetainedCopyReview", "ConfluenceRetainedCopyReviewWithdrawal" CASCADE;`, /append-only/);
    query(reviewInsert('review-b', `|| '{"reviewerId":"owner-b"}'::jsonb`), /exact non-authorising/);
    query(reviewInsert('review-c', `|| '{"scope":"PRODUCTION"}'::jsonb`), /exact non-authorising/);
    query(reviewInsert('review-no-evidence', `|| '{"holdReviewRef":""}'::jsonb`), /controlled evidence/);
    query(reviewInsert('review-incomplete', `|| jsonb_build_object('snapshot',jsonb_set(j->'snapshot','{inventory,complete}','false'::jsonb))`), /exact non-authorising/);
    query(reviewInsert('review-d', `|| jsonb_build_object('snapshot',(j->'snapshot') || '{"organisationId":"org-b"}'::jsonb)`), /exact non-authorising/);
    query(reviewInsert('review-e', `|| jsonb_build_object('snapshot',(j->'snapshot') || '{"pageId":"999"}'::jsonb)`), /exact retired publication/);
    query(reviewInsert('review-f', `|| jsonb_build_object('snapshot',(j->'snapshot') || '{"sourceRevision":"2020-01-01T00:00:00.000Z"}'::jsonb)`), /exact retained/);
    query(`UPDATE "Document" SET "deletionHold"=true WHERE id='doc-a';`);
    query(reviewInsert('review-held'), /exact retained/);
    query(`UPDATE "Document" SET "deletionHold"=false WHERE id='doc-a';`);
    query(`SET ROLE synthetic_copy_runtime;
      CREATE TEMP TABLE "User" (LIKE public."User" INCLUDING ALL);
      INSERT INTO pg_temp."User" SELECT * FROM public."User" WHERE id='member-a';
      UPDATE pg_temp."User" SET role='OWNER';
      ${reviewInsert('shadow-owner-review').replaceAll('owner-a','member-a')}`, /active charity owner/);
    const scopeInsert = (id = 'scope-a') => `INSERT INTO public."ConfluenceSyntheticCopyScope"
      (id,"organisationId","reviewId","snapshotSha256","evidenceRef","disposalPolicyEvidenceRef","approvedById","expiresAt","registeredByDbRole")
      SELECT '${id}',"organisationId",id,"snapshotSha256",'C01-SCOPE','C01-COPY-DISPOSAL','owner-a',"expiresAt"-INTERVAL '1 minute','spoofed-role'
      FROM public."ConfluenceRetainedCopyReview" WHERE id='review-a';`;
    query(`SET ROLE synthetic_copy_runtime; ${scopeInsert('runtime-scope')}`, /maintenance table owner/);
    query(`SET ROLE synthetic_copy_runtime;
      CREATE TEMP TABLE "ConfluenceSyntheticCopyScope"(id TEXT);
      ${scopeInsert('shadow-scope')}`, /maintenance table owner/);
    query(scopeInsert());
    assert.equal(query(`SELECT "registeredByDbRole"=current_user FROM "ConfluenceSyntheticCopyScope" WHERE id='scope-a';`), 't');
    const permissionInsert = (id = 'permission-a', scope = 'scope-a') => `SET ROLE synthetic_copy_runtime;
      INSERT INTO public."ConfluenceRetainedCopyPermission"
      (id,"organisationId","reviewId","scopeId","snapshotSha256","actorUserId","integrationId","connectionGeneration","evidenceRef",reason,"expiresAt",attestation,"scopeEvidenceRef","disposalPolicyEvidenceRef")
      SELECT '${id}',"organisationId","reviewId",'${scope}',"snapshotSha256",'owner-a','confluence-a',(SELECT "connectedAt" FROM public."OrganisationIntegration" WHERE id='confluence-a'),'C01-PERMISSION',
        'Purge exact synthetic copy and retain primary',"expiresAt"-INTERVAL '1 minute',
        'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY','C01-SCOPE','C01-COPY-DISPOSAL'
      FROM public."ConfluenceSyntheticCopyScope" WHERE id='scope-a';`;
    query(permissionInsert('missing-scope','other-scope'), /registered synthetic scope/);
    query(permissionInsert('wrong-policy').replace("'C01-SCOPE','C01-COPY-DISPOSAL'","'C01-SCOPE','OTHER-POLICY'"), /registered scope and disposal/);
    query(permissionInsert('permission-member').replaceAll("'owner-a'","'member-a'"), /active charity Owner/);
    query(permissionInsert('too-long').replace('"expiresAt"-INTERVAL \'1 minute\'', '"expiresAt"+INTERVAL \'1 minute\''), /registered synthetic scope/);
    query(`UPDATE "Document" SET "deletionHold"=true WHERE id='doc-a';`);
    query(`SET ROLE synthetic_copy_runtime;
      CREATE TEMP TABLE "Document" (LIKE public."Document" INCLUDING ALL);
      INSERT INTO pg_temp."Document" SELECT * FROM public."Document" WHERE id='doc-a';
      UPDATE pg_temp."Document" SET "deletionHold"=false;
      ${permissionInsert('shadow-held-source')}`, /source changed or is not retained and unheld/);
    query(`UPDATE "Document" SET "deletionHold"=false WHERE id='doc-a';`);
    query(permissionInsert('wrong-generation').replace(`(SELECT "connectedAt" FROM public."OrganisationIntegration" WHERE id='confluence-a')`, "'2000-01-01'::timestamp"), /exact connected grant generation/);
    query(permissionInsert());
    query(permissionInsert('duplicate-permission'), /unique constraint/);
    // Use real committed rows from the disposable database. Each capture must
    // include every linked record visible under the same charity lock.
    const captureFacts = (operationId, factsRevision, previousFactsDigest) => {
      const rows = JSON.parse(query(`SELECT jsonb_build_object(
        'review',public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(r),ARRAY['reviewedAt','expiresAt','recordedAt']),
        'reviewWithdrawal',(SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(w),ARRAY['occurredAt']) FROM "ConfluenceRetainedCopyReviewWithdrawal" w WHERE "reviewId"=r.id),
        'scope',(SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(s),ARRAY['registeredAt','expiresAt']) FROM "ConfluenceSyntheticCopyScope" s WHERE "reviewId"=r.id),
        'permission',(SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(p),ARRAY['connectionGeneration','issuedAt','expiresAt']) FROM "ConfluenceRetainedCopyPermission" p WHERE "reviewId"=r.id),
        'permissionWithdrawal',(SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(w),ARRAY['occurredAt']) FROM "ConfluenceRetainedCopyPermissionWithdrawal" w WHERE "permissionId"='permission-a'),
        'capturedAt',to_char(timezone('UTC',clock_timestamp()),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        FROM "ConfluenceRetainedCopyReview" r WHERE id='review-a';`));
      return { format: 1, kind: 'CONFLUENCE_COPY_DECISION_STATE_V1', installationId: 'synthetic-installation',
        organisationId: 'org-a', operationId, writerEpoch: 1, sourceRevision: 'a'.repeat(40), factsRevision,
        previousFactsDigest, ...rows };
    };
    const captureInsert = (id, facts, actor = 'owner-a') => {
      const body = JSON.stringify(facts);
      const digest = createHash('sha256').update(body).digest('hex');
      const quote = value => `'${String(value).replaceAll("'", "''")}'`;
      return `SET ROLE synthetic_copy_runtime; INSERT INTO public."ConfluenceCopyRecoveryCapture"
        (id,"organisationId","reviewId","installationId","operationId","writerEpoch","sourceRevision","actorUserId",
        "factsRevision","previousFactsDigest","capturedAt",facts,"factsDigest") VALUES
        (${quote(id)},'org-a','review-a',${quote(facts.installationId)},${quote(facts.operationId)},${facts.writerEpoch},${quote(facts.sourceRevision)},${quote(actor)},
        ${facts.factsRevision},${facts.previousFactsDigest ? quote(facts.previousFactsDigest) : 'NULL'},${quote(facts.capturedAt)},${quote(body)},${quote(digest)});`;
    };
    const firstCapture = captureFacts('capture-operation-1',1,null);
    const firstCaptureDigest = createHash('sha256').update(JSON.stringify(firstCapture)).digest('hex');
    query(captureInsert('capture-member',firstCapture,'member-a'), /active charity Owner/);
    query(`BEGIN; UPDATE public."Organisation" SET "lifecycleStatus"='SUSPENDED' WHERE id='org-a';
      ${captureInsert('capture-suspended',firstCapture)}`, /active charity Owner/);
    query(captureInsert('capture-other',firstCapture,'owner-b'), /active charity Owner/);
    query(captureInsert('capture-incomplete',{ ...firstCapture, permission: null }), /complete committed facts/);
    query(captureInsert('capture-extra',{ ...firstCapture, credential: 'never-store-credentials' }), /complete committed facts/);
    query(captureInsert('capture-tampered',firstCapture).replace(firstCaptureDigest,'0'.repeat(64)), /complete committed facts/);
    query(captureInsert('capture-wrong-tenant',firstCapture).replace("'org-a','review-a'","'org-b','review-a'"), /active charity Owner/);
    query(`SET ROLE synthetic_copy_runtime; CREATE TEMP TABLE "User" (LIKE public."User" INCLUDING ALL);
      INSERT INTO pg_temp."User" SELECT * FROM public."User" WHERE id='member-a'; UPDATE pg_temp."User" SET role='OWNER';
      ${captureInsert('capture-shadow-owner',firstCapture,'member-a')}`, /active charity Owner/);
    query(captureInsert('capture-1',firstCapture));
    query(captureInsert('capture-duplicate',firstCapture), /initial lineage|predecessor mismatch|unique constraint/);
    query(captureInsert('capture-skip',{ ...firstCapture, operationId: 'capture-operation-3', factsRevision: 3,
      previousFactsDigest: firstCaptureDigest }), /predecessor mismatch/);
    query(captureInsert('capture-epoch',{ ...firstCapture, operationId: 'capture-operation-2', factsRevision: 2,
      previousFactsDigest: firstCaptureDigest, writerEpoch: 2 }), /predecessor mismatch/);
    query(`SET ROLE synthetic_copy_runtime; UPDATE "ConfluenceCopyRecoveryCapture" SET "factsDigest"=repeat('0',64);`, /append-only/);
    query(`SET ROLE synthetic_copy_runtime; DELETE FROM "ConfluenceCopyRecoveryCapture";`, /append-only/);
    query(`TRUNCATE "ConfluenceCopyRecoveryCapture", "ConfluenceCopyPublicationPlan", "ConfluenceCopyPublicationReceipt";`, /append-only/);
    query(`SET ROLE synthetic_copy_runtime; UPDATE "ConfluenceRetainedCopyPermission" SET reason='Replace reviewed permission';`, /append-only/);
    query(`SET ROLE synthetic_copy_runtime; DELETE FROM "ConfluenceSyntheticCopyScope";`, /append-only/);
    query(`TRUNCATE "ConfluenceRetainedCopyPermissionWithdrawal", "ConfluenceRetainedCopyPermission", "ConfluenceSyntheticCopyScope";`, /append-only/);
    const permissionWithdraw = (id, actor = 'owner-a', org = 'org-a') => `SET ROLE synthetic_copy_runtime;
      INSERT INTO "ConfluenceRetainedCopyPermissionWithdrawal"(id,"organisationId","permissionId","actorUserId","evidenceRef",reason)
      VALUES ('${id}','${org}','permission-a','${actor}','C01-WITHDRAW','Withdraw this exact synthetic permission');`;
    query(permissionWithdraw('permission-withdraw-member','member-a'), /active charity Owner/);
    query(permissionWithdraw('permission-withdraw-other','owner-b','org-b'), /not found in charity/);
    query(permissionWithdraw('permission-withdraw'));
    query(permissionWithdraw('permission-withdraw-again'), /unique constraint/);
    query(`SET ROLE synthetic_copy_runtime; DELETE FROM "ConfluenceRetainedCopyPermissionWithdrawal";`, /append-only/);
    const withdrawal = (id, actor = 'owner-a', org = 'org-a') => `SET ROLE synthetic_copy_runtime;
      INSERT INTO "ConfluenceRetainedCopyReviewWithdrawal"(id,"organisationId","reviewId","actorUserId","evidenceRef",reason)
      VALUES ('${id}','${org}','review-a','${actor}','C01-WITHDRAW','Withdraw synthetic copy review');`;
    query(withdrawal('withdraw-member','member-a'), /active charity owner/);
    query(withdrawal('withdraw-other','owner-b','org-b'), /not found in charity/);
    query(withdrawal('withdraw-a'));
    // The original committed body stays unchanged after withdrawal. A new
    // operation/revision must capture BOTH withdrawal records, never resurrect
    // the earlier unwithdrawn state from a backup or a lost acknowledgement.
    assert.equal(query(`SELECT "factsDigest" FROM "ConfluenceCopyRecoveryCapture" WHERE id='capture-1';`), firstCaptureDigest);
    const secondCapture = captureFacts('capture-operation-2',2,firstCaptureDigest);
    query(captureInsert('capture-stale',{ ...secondCapture, reviewWithdrawal: null, permissionWithdrawal: null }), /complete committed facts/);
    query(captureInsert('capture-2',secondCapture));
    assert.equal(query(`SELECT count(*) FROM "ConfluenceCopyRecoveryCapture";`),'2');
    const planInsert = (id = 'plan-a', actor = 'owner-a', capture = 'capture-1', org = 'org-a') => `SET ROLE synthetic_copy_runtime;
      INSERT INTO public."ConfluenceCopyPublicationPlan"
      (id,"organisationId","captureId","actorUserId","writerId","keyId","keyEvidenceRef","expectedGeneration","expectedDigest")
      VALUES ('${id}','${org}','${capture}','${actor}','synthetic-writer',
        'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111','C01-KEY-CONTEXT',0,NULL);`;
    query(planInsert('plan-member','member-a'), /active charity Owner/);
    query(planInsert('plan-foreign','owner-b','capture-1','org-b'), /original charity capture/);
    query(planInsert('plan-bad-key').replace('eu-west-1','us-east-1'), /check constraint/);
    query(planInsert('plan-bad-head').replace("'C01-KEY-CONTEXT',0,NULL", "'C01-KEY-CONTEXT',1,NULL"), /check constraint/);
    query(`SET ROLE synthetic_copy_runtime;
      CREATE TEMP TABLE "User" (LIKE public."User" INCLUDING ALL);
      INSERT INTO pg_temp."User" SELECT * FROM public."User" WHERE id='member-a'; UPDATE pg_temp."User" SET role='OWNER';
      ${planInsert('plan-shadow','member-a')}`, /active charity Owner/);
    query(planInsert());
    query(planInsert('plan-duplicate'), /unique constraint/);
    query(`SET ROLE synthetic_copy_runtime; UPDATE "ConfluenceCopyPublicationPlan" SET "writerId"='replacement';`, /append-only/);
    query(`SET ROLE synthetic_copy_runtime; DELETE FROM "ConfluenceCopyPublicationPlan";`, /append-only/);
    query(`TRUNCATE "ConfluenceCopyPublicationPlan", "ConfluenceCopyPublicationReceipt";`, /append-only/);
    const receiptInsert = (id = 'receipt-a', actor = 'owner-a', org = 'org-a', generation = 1) => `SET ROLE synthetic_copy_runtime;
      INSERT INTO public."ConfluenceCopyPublicationReceipt"
      (id,"organisationId","planId","actorUserId","envelopeDigest","entryGeneration","entryDigest","verifiedHeadRevision")
      VALUES ('${id}','${org}','plan-a','${actor}',repeat('c',64),${generation},repeat('d',64),'synthetic-revision-1');`;
    query(receiptInsert('receipt-member','member-a'), /active charity Owner/);
    query(receiptInsert('receipt-foreign','owner-b','org-b'), /exact plan generation/);
    query(receiptInsert('receipt-wrong-generation','owner-a','org-a',2), /exact plan generation/);
    query(receiptInsert('receipt-long-revision').replace("'synthetic-revision-1'","repeat('x',1025)"), /check constraint/);
    query(receiptInsert('receipt-space-revision').replace("'synthetic-revision-1'","'has space'"), /check constraint/);
    query(receiptInsert());
    query(receiptInsert('receipt-duplicate'), /unique constraint/);
    query(`SET ROLE synthetic_copy_runtime; UPDATE "ConfluenceCopyPublicationReceipt" SET "entryDigest"=repeat('0',64);`, /append-only/);
    query(`SET ROLE synthetic_copy_runtime; DELETE FROM "ConfluenceCopyPublicationReceipt";`, /append-only/);
    query(`TRUNCATE "ConfluenceCopyPublicationReceipt";`, /append-only/);
    query(permissionInsert('withdrawn-parent-permission'), /current unwithdrawn synthetic review/);
    query(withdrawal('withdraw-again'), /unique constraint/);
    query(`SET ROLE synthetic_copy_runtime; DELETE FROM "ConfluenceRetainedCopyReviewWithdrawal";`, /append-only/);
    query(`SET ROLE synthetic_copy_runtime; UPDATE "ConfluenceRetainedCopyReviewWithdrawal" SET reason='Replace withdrawn evidence';`, /append-only/);
    query(`TRUNCATE "ConfluenceRetainedCopyReviewWithdrawal";`, /append-only/);
    query(`INSERT INTO "DocumentRecoveryEnforcement"(id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('unsafe-binding','org-a','synthetic-installation','synthetic-writer',1);`, /independent Confluence copy review history/);
    query(`INSERT INTO "DocumentRecoveryEnforcement"(id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('bound','org-b','synthetic-installation','synthetic-writer',1);`);
    // Publication quiescence correctly prevents binding org-a. Bind the empty
    // other charity and prove its recovery fence runs before source lookup.
    query(reviewInsert('review-bound').replaceAll('org-a','org-b').replaceAll('owner-a','owner-b'), /independent recovery recording/);
    query(withdrawal('withdraw-bound','owner-b','org-b'), /independent recovery recording/);
    assert.equal(query(`SELECT count(*) FROM "DocumentStorageDeletion";`), '0');
    assert.equal(query(`SELECT count(*) FROM "Document" WHERE id='doc-a' AND "deletedAt" IS NULL AND "lifecycleStatus"='RETIRED';`), '1');
    assert.equal(query(`SELECT count(*) FROM "ConfluenceRetainedCopyReview";`), '1');
    assert.equal(query(`SELECT count(*) FROM "ConfluenceRetainedCopyReviewWithdrawal";`), '1');
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
  }
});
