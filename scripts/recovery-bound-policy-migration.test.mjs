import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migrations = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));
const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';

test('bound recovery freezes all four policy classes at the database boundary', { timeout: 240_000 }, async () => {
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
  const name = `charitypilot-policy-fence-${randomUUID()}`;
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
    assert.ok(names.includes('20261009030000_recovery_bound_policy_classes'));
    for (const migration of names) {
      const body = readFileSync(`${migrations}/${migration}/migration.sql`, 'utf8');
      query(/^\s*BEGIN;/m.test(body) || /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(body)
        ? body : `BEGIN;\n${body}\nCOMMIT;`);
    }
    for (const [org, owner] of [['doc-org', 'doc-owner'], ['complaint-org', 'complaint-owner'],
      ['free-org', 'free-owner']]) {
      query(`BEGIN;
        INSERT INTO "Organisation" (id,name,"updatedAt") VALUES ('${org}','Synthetic ${org}',CURRENT_TIMESTAMP);
        INSERT INTO "User" (id,email,name,"passwordHash",role,"organisationId","updatedAt")
          VALUES ('${owner}','${owner}@example.invalid','Synthetic Owner','fixture-password-hash','OWNER','${org}',CURRENT_TIMESTAMP);
        COMMIT;`);
    }
    const initial = (org, owner, recordClass) => `INSERT INTO "DataRetentionPolicyRevision"
      (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays",
        "createdById","approvedById","approvedAt","approvalEvidenceRef")
      VALUES ('${org}-${recordClass}','${org}','${recordClass}',1,'APPROVED','REVIEW_REQUIRED',30,
        '${owner}','${owner}',CURRENT_TIMESTAMP,'SYNTHETIC-APPROVAL-001');`;
    for (const [org, owner] of [['doc-org', 'doc-owner'], ['complaint-org', 'complaint-owner'],
      ['free-org', 'free-owner']]) {
      for (const recordClass of ['VAULT_DRAFT', 'DOCUMENT_COPY', 'COMPLAINT', 'COMPLAINT_COPY']) {
        query(initial(org, owner, recordClass));
      }
    }
    query(`INSERT INTO "DocumentRecoveryEnforcement"
      (id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('doc-binding','doc-org','synthetic-installation','synthetic-writer',1);`);
    query(`INSERT INTO "ComplaintRecoveryEnforcement"
      (id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('complaint-binding','complaint-org','synthetic-installation','synthetic-writer',1);`);
    const proposed = (org, owner, recordClass) => `INSERT INTO "DataRetentionPolicyRevision"
      (id,"organisationId","recordClass",revision,"retentionMode","recoveryDays","createdById")
      VALUES ('${org}-${recordClass}-next','${org}','${recordClass}',2,'REVIEW_REQUIRED',30,'${owner}');`;
    const withdrawal = (org, owner, recordClass) => `INSERT INTO "DataRetentionPolicyWithdrawal"
      (id,"organisationId","policyId","actorUserId",reason,"evidenceRef")
      VALUES ('${org}-${recordClass}-withdraw','${org}','${org}-${recordClass}','${owner}',
        'Review changed retention authority','SYNTHETIC-WITHDRAWAL-001');`;
    for (const [org, owner, classes] of [
      ['doc-org', 'doc-owner', ['VAULT_DRAFT', 'DOCUMENT_COPY']],
      ['complaint-org', 'complaint-owner', ['COMPLAINT', 'COMPLAINT_COPY']],
    ]) {
      for (const recordClass of classes) {
        query(proposed(org, owner, recordClass), /Policy revision requires independent recovery authority/);
        query(withdrawal(org, owner, recordClass), /Policy withdrawal requires independent recovery authority/);
      }
    }
    // Other families and an unbound charity remain writable under their
    // existing actor/policy guards; the binding is charity and family scoped.
    query(proposed('doc-org', 'doc-owner', 'COMPLAINT_COPY'));
    query(proposed('complaint-org', 'complaint-owner', 'DOCUMENT_COPY'));
    query(proposed('free-org', 'free-owner', 'VAULT_DRAFT'));
    assert.equal(query(`SELECT count(*) FROM "DataRetentionPolicyWithdrawal";`), '0');
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
  }
});
