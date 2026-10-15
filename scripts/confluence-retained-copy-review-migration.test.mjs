import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

test('retained Confluence copy reviews are tenant-scoped immutable non-authorising evidence', { timeout: 240_000 }, async () => {
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
      assert.notEqual(result.status, 0, 'bound policy mutation was accepted');
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
    query(`TRUNCATE "ConfluenceRetainedCopyReview", "ConfluenceRetainedCopyReviewWithdrawal";`, /append-only/);
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
    const withdrawal = (id, actor = 'owner-a', org = 'org-a') => `SET ROLE synthetic_copy_runtime;
      INSERT INTO "ConfluenceRetainedCopyReviewWithdrawal"(id,"organisationId","reviewId","actorUserId","evidenceRef",reason)
      VALUES ('${id}','${org}','review-a','${actor}','C01-WITHDRAW','Withdraw synthetic copy review');`;
    query(withdrawal('withdraw-member','member-a'), /active charity owner/);
    query(withdrawal('withdraw-other','owner-b','org-b'), /not found in charity/);
    query(withdrawal('withdraw-a'));
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
    assert.equal(query(`SELECT count(*) FROM "ConfluenceRetainedCopyReview";`), '1');
    assert.equal(query(`SELECT count(*) FROM "ConfluenceRetainedCopyReviewWithdrawal";`), '1');
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
  }
});
