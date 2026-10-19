import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const target = '20261019230100_confluence_source_instruction_guards';
const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

test('source instructions preserve target identity, original withdrawals, recovery freeze and restored history', { timeout: 240_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(docker(['info', '--format', '{{.OSType}}']).stdout.trim(), 'linux');
  const name = `charitypilot-instruction-proof-${randomUUID()}`;
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
    sql(`BEGIN; INSERT INTO "Organisation"(id,name,"updatedAt") VALUES ('instruction-a','Synthetic source tenant',now()),('instruction-b','Synthetic foreign tenant',now());
      INSERT INTO "User"(id,email,name,"passwordHash",role,"organisationId","updatedAt") VALUES
      ('owner-a','owner-a@example.invalid','Synthetic Owner','synthetic-hash','OWNER','instruction-a',now()),
      ('owner-b','owner-b@example.invalid','Synthetic Foreign Owner','synthetic-hash','OWNER','instruction-b',now());
      INSERT INTO "ConfluenceReference"(id,"organisationId","referenceKind","cloudId","pageId","pageTitle","pageVersion","citedAt","citedById","updatedAt")
      VALUES ('instruction-source','instruction-a','CONFLUENCE_SOURCE','site-a','page-a','Synthetic page',2,now(),'owner-a',now());
      INSERT INTO "SecurityAuditEvent"(id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason)
      VALUES ('old-audit','instruction-a','INTEGRATION_CONNECTED','USER','owner-a','Synthetic Owner','Connection','Synthetic legacy audit'); COMMIT;`);
    sql(readFileSync(`${migrations}/${target}/migration.sql`, 'utf8'));
    assert.equal(sql(`SELECT reason FROM "SecurityAuditEvent" WHERE id='old-audit';`), 'Synthetic legacy audit');
    const request = '00000000-0000-4000-8000-000000000111', hash = 'a'.repeat(64);
    const issued = { format: 1, kind: 'CONFLUENCE_SOURCE_INSTRUCTION_V1', clientRequestId: request, inputDigest: hash,
      referenceId: 'instruction-source', authorityAssessment: 'OWNER_RECORDED',
      input: { clientRequestId: request, reason: 'Synthetic source instruction', assessmentConfirmed: true, expectedTargetDigest: hash },
      citation: { id: 'instruction-source', documentId: null, cloudId: 'site-a', pageId: 'page-a', pageVersion: 2 },
      providerMutationIssued: false, jobCreated: false, actionAuthorized: false };
    const insert = (id, type, context, organisation = 'instruction-a', actor = 'owner-a') => `INSERT INTO "SecurityAuditEvent"
      (id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context)
      VALUES ('${id}','${organisation}','${type}','USER','${actor}','Synthetic Owner','Synthetic instruction',
        '${context.input.reason}', '${JSON.stringify(context).replaceAll("'", "''")}');`;
    sql(insert('issued', 'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED', issued));
    sql(insert('duplicate', 'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED', issued), /request_key/);
    sql(insert('foreign', 'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED', { ...issued, clientRequestId: request.replace('111', '112'),
      input: { ...issued.input, clientRequestId: request.replace('111', '112') } }, 'instruction-b', 'owner-b'), /same.charity citation/);
    sql(insert('forged', 'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED', { ...issued, actionAuthorized: true }), /envelope/);
    sql(`UPDATE "SecurityAuditEvent" SET reason='Rewritten instruction' WHERE id='issued';`, /append.only/i);
    sql(`DELETE FROM "SecurityAuditEvent" WHERE id='issued';`, /append.only/i);
    const withdrawalRequest = request.replace('111', '222');
    const withdrawn = { format: 1, kind: 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWAL_V1', clientRequestId: withdrawalRequest,
      inputDigest: 'b'.repeat(64), instructionId: 'issued', instructionDigest: hash,
      input: { clientRequestId: withdrawalRequest, expectedInstructionDigest: hash, reason: 'Synthetic instruction withdrawal' },
      providerMutationIssued: false, jobCreated: false, actionAuthorized: false };
    sql(insert('wrong-original', 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN', { ...withdrawn, instructionDigest: 'c'.repeat(64) }), /original identity/);
    sql(insert('foreign-withdrawal', 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN', withdrawn, 'instruction-b', 'owner-b'), /original identity/);
    sql(insert('withdrawn', 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN', withdrawn));
    sql(insert('second-withdrawal', 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN', { ...withdrawn,
      clientRequestId: request.replace('111', '333'), input: { ...withdrawn.input, clientRequestId: request.replace('111', '333') } }), /withdrawal_key/);
    sql(`INSERT INTO "SecurityAuditEvent"(id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason)
      VALUES ('bad-user','instruction-a','MEMBER_ROLE_CHANGED','USER','owner-a','Synthetic Owner','Missing subject','Synthetic subject refusal');`, /subject_check/);
    sql(`INSERT INTO "DocumentRecoveryEnforcement"(id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('instruction-freeze','instruction-a','synthetic-installation','synthetic-writer',1);`);
    sql(insert('frozen', 'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED', issued), /independent recovery authority/);
    sql(insert('frozen-withdrawal', 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN', withdrawn), /independent recovery authority/);
    const dump = docker(['exec', container, 'pg_dump', '-U', 'postgres', '--no-owner', '--no-privileges', 'postgres']);
    assert.equal(dump.status, 0, dump.stderr);
    sql('CREATE DATABASE restored_instructions;'); sql(dump.stdout, undefined, 'restored_instructions');
    assert.equal(sql(`SELECT count(*) FROM "SecurityAuditEvent" WHERE id IN ('issued','withdrawn');`, undefined, 'restored_instructions'), '2');
    sql(insert('restored-frozen', 'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED', issued), /independent recovery authority/, 'restored_instructions');
    sql(`DELETE FROM "SecurityAuditEvent" WHERE id='withdrawn';`, /append.only/i, 'restored_instructions');
    for (const table of ['Document','DocumentPublication','DocumentStorageDeletion','DocumentUploadIntent']) {
      assert.equal(sql(`SELECT count(*) FROM "${table}";`), '0');
    }
  } finally {
    const removed = docker(['rm', '--force', container]); assert.equal(removed.status, 0, removed.stderr);
  }
});
