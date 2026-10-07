import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';

const migration = fileURLToPath(new URL('../apps/api/prisma/migrations/20261007040000_document_recovery_byte_fence/migration.sql', import.meta.url));

test('document byte fence refuses unfinished activation and direct guarded job updates', { timeout: 120_000 }, async () => {
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(context.status, 0, context.stderr);
  const endpoint = JSON.parse(context.stdout);
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify }, process.env);
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint.Host, ...args],
    { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const started = docker(['run', '--detach', '--network', 'none',
    '--name', `charitypilot-byte-fence-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD=synthetic-byte-proof',
    'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c']);
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  const sql = (statement, rejection) => {
    const result = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-Atq'], statement);
    if (rejection) { assert.notEqual(result.status, 0); assert.match(result.stderr, rejection); }
    else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) {
        ready = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    sql(`CREATE TABLE "Organisation" (id TEXT PRIMARY KEY);
      CREATE TABLE "DocumentStorageDeletion" (id TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL, state TEXT NOT NULL,
        "processedAt" TIMESTAMP, "claimedAt" TIMESTAMP);
      CREATE TABLE "DocumentPurgeClaim" (id TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL, "deletionId" TEXT NOT NULL UNIQUE
          REFERENCES "DocumentStorageDeletion"(id) ON DELETE RESTRICT);
      CREATE TABLE "DocumentRecoveryEnforcement" (id TEXT PRIMARY KEY,
        "organisationId" TEXT NOT NULL UNIQUE, "installationId" TEXT NOT NULL,
        "writerId" TEXT NOT NULL, "writerEpoch" INT NOT NULL,
        "recordedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE FUNCTION "DocumentRecoveryEnforcement_guard_fn"() RETURNS trigger AS $$
        BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER "DocumentRecoveryEnforcement_guard"
        BEFORE INSERT OR UPDATE OR DELETE ON "DocumentRecoveryEnforcement"
        FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryEnforcement_guard_fn"();
      INSERT INTO "Organisation" VALUES ('charity'),('foreign'),('race');
      INSERT INTO "DocumentStorageDeletion" VALUES
        ('old','charity','PENDING',NULL,NULL),
        ('ordinary','charity','PENDING',NULL,NULL),
        ('foreign-job','foreign','PENDING',NULL,NULL);
      INSERT INTO "DocumentPurgeClaim" VALUES
        ('old-claim','charity','old'),('foreign-claim','foreign','foreign-job');`);
    sql(readFileSync(migration, 'utf8'));
    const bind = `INSERT INTO "DocumentRecoveryEnforcement"
      (id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('binding','charity','installation','writer',1);`;
    sql(bind, /no unfinished legacy purge jobs/);
    assert.equal(sql(`SELECT count(*) FROM "DocumentRecoveryEnforcement";`), '0');
    sql(`UPDATE "DocumentStorageDeletion" SET "claimedAt"=CURRENT_TIMESTAMP WHERE id='old';`);
    sql(`UPDATE "DocumentStorageDeletion" SET state='PROCESSED',
      "processedAt"=CURRENT_TIMESTAMP WHERE id='old';`);
    sql(bind);
    sql(`INSERT INTO "DocumentStorageDeletion" VALUES ('guarded','charity','PENDING',NULL,NULL);
      INSERT INTO "DocumentPurgeClaim" VALUES ('guarded-claim','charity','guarded');`);
    sql(`UPDATE "DocumentStorageDeletion" SET "claimedAt"=CURRENT_TIMESTAMP WHERE id='guarded';`,
      /independent permit/);
    sql(`UPDATE "DocumentStorageDeletion" SET state='PROCESSED',
      "processedAt"=CURRENT_TIMESTAMP WHERE id='guarded';`, /independent permit/);
    sql(`UPDATE "DocumentStorageDeletion" SET "claimedAt"="claimedAt" WHERE id='guarded';`,
      /independent permit/);
    assert.equal(sql(`SELECT state,coalesce("claimedAt"::text,'none')
      FROM "DocumentStorageDeletion" WHERE id='guarded';`), 'PENDING|none');
    sql(`UPDATE "DocumentStorageDeletion" SET "claimedAt"=CURRENT_TIMESTAMP WHERE id='ordinary';`);
    sql(`UPDATE "DocumentStorageDeletion" SET "claimedAt"=CURRENT_TIMESTAMP WHERE id='foreign-job';`);

    // The worker takes the organisation lock during its job update. A
    // concurrent activation must wait until that in-flight attempt reaches
    // a terminal row, then inspect the committed state.
    sql(`INSERT INTO "DocumentStorageDeletion" VALUES ('racing','race','PENDING',NULL,NULL);
      INSERT INTO "DocumentPurgeClaim" VALUES ('racing-claim','race','racing');`);
    const worker = spawn('docker', ['--host', endpoint.Host, 'exec', '-i', container,
      'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const workerDone = new Promise((resolve, reject) => {
      let stderr = '';
      worker.stderr.on('data', chunk => { stderr += chunk; });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    const claimed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker did not claim the racing job')), 10_000);
      worker.stdout.on('data', chunk => {
        if (chunk.toString().includes('worker_claimed')) { clearTimeout(timeout); resolve(); }
      });
    });
    worker.stdin.end(`BEGIN;
      UPDATE "DocumentStorageDeletion" SET "claimedAt"=CURRENT_TIMESTAMP WHERE id='racing';
      \\echo worker_claimed
      SELECT pg_sleep(1.5);
      UPDATE "DocumentStorageDeletion" SET state='PROCESSED',
        "processedAt"=CURRENT_TIMESTAMP WHERE id='racing';
      COMMIT;`);
    await claimed;
    sql(`INSERT INTO "DocumentRecoveryEnforcement"
      (id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('binding-race','race','installation','writer',1);`);
    await workerDone;
    assert.equal(sql(`SELECT state FROM "DocumentStorageDeletion" WHERE id='racing';`), 'PROCESSED');
    sql(`UPDATE "DocumentRecoveryEnforcement" SET "writerEpoch"=2;`, /cannot be changed/);
    sql(`DELETE FROM "DocumentRecoveryEnforcement";`, /cannot be changed/);
    assert.equal(sql(`SELECT count(*) FROM "DocumentRecoveryEnforcement";`), '2');
  } finally {
    const removed = docker(['rm', '--force', '--volumes', container]);
    assert.equal(removed.status, 0, removed.stderr);
    const remaining = docker(['ps', '--all', '--filter', `id=${container}`, '--format', '{{.ID}}']);
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.equal(remaining.stdout.trim(), '');
  }
});
