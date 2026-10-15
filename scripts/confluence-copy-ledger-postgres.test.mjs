import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { captureConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_TABLES } from '../apps/api/dist/services/confluence-copy-ledger-snapshot.js';
import { ConfluenceRetainedCopyReviewService } from '../apps/api/dist/services/confluence-retained-copy-review.service.js';
import { ConfluenceCopyRecoveryCaptureStore } from '../apps/api/dist/services/confluence-copy-recovery-capture.js';
import { ConfluenceCopyPublicationStore } from '../apps/api/dist/services/confluence-copy-publication-store.js';
import { preserveConfluenceCopyLedgerArchive, readVerifiedConfluenceCopyLedgerArchive } from '../apps/api/dist/services/confluence-copy-ledger-envelope.js';
import { recoveryFactsFixture, recoveryContextFixture } from '../apps/api/dist/tests/fixtures/confluence-copy-recovery-facts.js';

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

    // Real supported decision/capture services populate four of the eight
    // tables. No provider contact, synthetic scope or permission is needed.
    const now = Date.now(), date = offset => new Date(now + offset);
    const doc = await prisma.document.create({ data: { id: 'doc-a', organisationId: 'org-a', name: 'Synthetic retained source',
      category: 'OTHER', fileUrl: 'org-a/reviewed.txt', fileSize: 42, mimeType: 'text/plain',
      lifecycleStatus: 'RETIRED', updatedAt: date(-120000) } });
    const pub = await prisma.documentPublication.create({ data: { id: 'pub-a', organisationId: 'org-a', documentId: doc.id,
      state: 'RETIRED', cloudId: '00000000-0000-4000-8000-000000000001', spaceId: 'space-a', pageId: 'page-a',
      retiredAt: date(-60000), nextAttemptAt: null, updatedAt: date(-60000) } });
    const review = recoveryFactsFixture().review.review;
    review.reviewedAt = date(0).toISOString(); review.expiresAt = date(3600000).toISOString();
    review.snapshot.sourceRevision = doc.updatedAt.toISOString();
    review.snapshot.publicationRevision = pub.updatedAt.toISOString();
    review.snapshot.inventory.observedAt = date(-1000).toISOString();
    const reviews = new ConfluenceRetainedCopyReviewService(prisma);
    const recorded = await reviews.record('org-a','owner-a',review);
    const capture = await new ConfluenceCopyRecoveryCaptureStore(prisma).capture('org-a','owner-a',{
      installationId: input.installationId, operationId: 'decision-state-original', writerEpoch: 1,
      sourceRevision: input.declaredSourceRevision, reviewId: recorded.id });
    const plan = await new ConfluenceCopyPublicationStore(prisma).prepare('org-a','owner-a',{
      captureId: capture.id, writerId: 'writer-a', keyId: recoveryContextFixture.keyId,
      keyEvidenceRef: 'SYNTHETIC-KEY-ASSERTION', expectedGeneration: 0, expectedDigest: null });
    const withdrawal = await reviews.withdraw('org-a','owner-a',recorded.id,{
      evidenceRef: 'SYNTHETIC-WITHDRAWAL', reason: 'Preserve this unpublished synthetic review withdrawal' });
    const populated = await captureConfluenceCopyLocalLedger(prisma,'org-a','owner-a',input);
    const capturedTables = JSON.parse(populated.body).tables;
    const originalRows = {
      ConfluenceRetainedCopyReview: await prisma.confluenceRetainedCopyReview.findUniqueOrThrow({ where: { id: recorded.id } }),
      ConfluenceRetainedCopyReviewWithdrawal: await prisma.confluenceRetainedCopyReviewWithdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } }),
      ConfluenceCopyRecoveryCapture: await prisma.confluenceCopyRecoveryCapture.findUniqueOrThrow({ where: { id: capture.id } }),
      ConfluenceCopyPublicationPlan: await prisma.confluenceCopyPublicationPlan.findUniqueOrThrow({ where: { id: plan.id } }),
    };
    for (const [name,row] of Object.entries(originalRows)) assert.deepEqual(capturedTables[name],[JSON.parse(JSON.stringify(row))]);
    assert.equal(capturedTables.ConfluenceCopyRecoveryCapture[0].facts,capture.body);
    assert.equal(capturedTables.ConfluenceRetainedCopyReviewWithdrawal[0].id,withdrawal.id);
    const context = { ...recoveryContextFixture, installationId: input.installationId, operationId: 'ledger-archive-original' };
    const binding = { context, observedControl: { format: 2, installationId: input.installationId, organisationId: 'org-a',
      writerId: 'writer-a', writerEpoch: 1, generation: 0, digest: null, activeOperation: null, revision: 'synthetic-observed-head' } };
    const keys = { generate: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId, wrappedKey: 'dGVzdA==' }),
      unwrap: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId }) };
    let encrypted = null;
    const objects = { readConfluenceCopyLedger: async () => encrypted,
      createConfluenceCopyLedger: async (_operation,envelope) => { assert.equal(encrypted,null); encrypted = envelope; return true; } };
    const preserved = await preserveConfluenceCopyLedgerArchive(populated.body,binding,keys,objects);
    assert.equal((await readVerifiedConfluenceCopyLedgerArchive(preserved.digest,binding,keys,objects)).body,populated.body);
    assert.equal(preserved.currentHistoryVerified,false);

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
