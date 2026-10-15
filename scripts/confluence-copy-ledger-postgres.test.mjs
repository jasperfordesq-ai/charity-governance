import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { captureConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_TABLES } from '../apps/api/dist/services/confluence-copy-ledger-snapshot.js';

const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
function run(command,args,options = {}) {
  const result = spawnSync(command,args,{ encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options });
  assert.equal(result.status,0,(result.stderr || result.error?.message || 'synthetic command failed').slice(-1200));
  return result.stdout.trim();
}

test('local Confluence ledger capture uses all eight migrated tables and a real repeatable-read transaction', { timeout: 240000 }, async () => {
  const endpoint = JSON.parse(run('docker',['context','inspect','--format','{{json .Endpoints.docker}}']));
  validateLocalDockerEndpoint({ endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify },process.env);
  const docker = args => run('docker',['--host',endpoint.Host,...args]);
  assert.equal(docker(['info','--format','{{.OSType}}']),'linux');
  const name = `charitypilot-copy-ledger-${randomUUID()}`;
  const database = `copy_ledger_${randomUUID().replaceAll('-','')}`;
  const password = 'synthetic-ledger-capture-only';
  const id = docker(['run','--detach','--network','bridge','--name',name,'--tmpfs','/var/lib/postgresql/data',
    '--publish','127.0.0.1::5432','--env',`POSTGRES_PASSWORD=${password}`,'--env',`POSTGRES_DB=${database}`,image]);
  let prisma;
  try {
    assert.match(id,/^[a-f0-9]{64}$/);
    let ready = false;
    for (let i = 0; i < 80; i++) {
      const result = spawnSync('docker',['--host',endpoint.Host,'exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],
        { encoding: 'utf8', timeout: 5000 });
      if (result.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve,250));
    }
    assert.ok(ready,'disposable PostgreSQL did not start');
    const published = /^127\.0\.0\.1:(\d{1,5})$/.exec(docker(['port',name,'5432/tcp']));
    assert.ok(published,'synthetic database must publish only on loopback');
    const port = Number(published[1]); assert.ok(port > 0 && port < 65536);
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
    run(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','apps/api/prisma/schema.prisma'],
      { env: { ...process.env, DATABASE_URL: url } });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$transaction(async tx => {
      await tx.organisation.createMany({ data: [{ id: 'org-a', name: 'Synthetic A' },{ id: 'org-b', name: 'Synthetic B' }] });
      await tx.user.createMany({ data: [
        { id: 'owner-a', organisationId: 'org-a', role: 'OWNER', name: 'Synthetic Owner', email: 'owner@example.invalid', passwordHash: 'not-a-login' },
        { id: 'owner-b', organisationId: 'org-b', role: 'OWNER', name: 'Synthetic B', email: 'owner-b@example.invalid', passwordHash: 'not-a-login' },
        { id: 'member-a', organisationId: 'org-a', role: 'MEMBER', name: 'Synthetic Member', email: 'member@example.invalid', passwordHash: 'not-a-login' },
      ] });
    });
    await prisma.document.create({ data: { id: 'private-primary', organisationId: 'org-a', name: 'PRIVATE-PRIMARY-SENTINEL',
      category: 'OTHER', fileUrl: 'org-a/private.txt', fileSize: 42, mimeType: 'text/plain' } });
    let observedIsolation;
    const inspected = { $transaction: (fn,options) => prisma.$transaction(async tx => {
      const [row] = await tx.$queryRawUnsafe('SHOW transaction_isolation');
      observedIsolation = row.transaction_isolation;
      return fn(tx);
    },options) };
    const input = { installationId: 'synthetic-install', declaredSourceRevision: 'a'.repeat(40) };
    const result = await captureConfluenceCopyLocalLedger(inspected,'org-a','owner-a',input);
    assert.equal(observedIsolation,'repeatable read');
    assert.deepEqual(result.tableCounts,Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map(name => [name,0])));
    const body = JSON.parse(result.body);
    assert.deepEqual(Object.keys(body.tables).sort(),[...CONFLUENCE_COPY_LEDGER_TABLES].sort());
    assert.ok(!result.body.includes('PRIVATE-PRIMARY-SENTINEL'));
    assert.equal(result.independentlyPreserved,false); assert.equal(result.reopeningAuthorised,false);
    await assert.rejects(captureConfluenceCopyLocalLedger(prisma,'org-a','member-a',input),/capture is unresolved/);
    await assert.rejects(captureConfluenceCopyLocalLedger(prisma,'org-b','owner-a',input),/capture is unresolved/);
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: 'owner-a' }, data: { role: 'MEMBER' } });
      await tx.user.update({ where: { id: 'member-a' }, data: { role: 'OWNER' } });
    });
    await assert.rejects(captureConfluenceCopyLocalLedger(prisma,'org-a','owner-a',input),/capture is unresolved/);
  } finally {
    if (prisma) await prisma.$disconnect();
    assert.equal(docker(['inspect','--format','{{.Id}}',name]),id);
    docker(['rm','--force','--volumes',name]);
    assert.equal(docker(['ps','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}']),'');
  }
});
