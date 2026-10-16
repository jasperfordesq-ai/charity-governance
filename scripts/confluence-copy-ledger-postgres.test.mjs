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
import { preservePreparedConfluenceCopyLedgerArchive, readVerifiedConfluenceCopyLedgerArchive,
  sealConfluenceCopyLedgerArchive } from '../apps/api/dist/services/confluence-copy-ledger-envelope.js';
import { publishVerifiedConfluenceCopyLedger, readPublishedConfluenceCopyLedger } from '../apps/api/dist/services/published-confluence-copy-ledger.js';
import { RecoveryAuthorityJournal } from '../apps/api/dist/services/recovery-authority-journal.js';
import { reserveRecoveryOperation } from '../apps/api/dist/services/recovery-operation-reservation.js';
import { acknowledgeConfluenceCopyLedgerArchive } from '../apps/api/dist/services/confluence-copy-ledger-acknowledgement.js';
import { ConfluenceCopyLedgerCaptureStore } from '../apps/api/dist/services/confluence-copy-ledger-capture-store.js';
import { ConfluenceCopyLedgerCandidateStore } from '../apps/api/dist/services/confluence-copy-ledger-candidate-store.js';
import { ConfluenceCopyLedgerProgressStore } from '../apps/api/dist/services/confluence-copy-ledger-progress-store.js';
import { inspectConfluenceCopyLedgerReconciliation } from '../apps/api/dist/services/confluence-copy-ledger-reconciliation.js';
import { PURGE_RESTORE_SNAPSHOT_SQL, PURGE_RESTORE_BINDING_PROBE_SQL, assertPurgeRestoreLedger } from './purge-restore-reconciliation.mjs';
import { createHash } from 'node:crypto';
import { recoveryFactsFixture, recoveryContextFixture } from '../apps/api/dist/tests/fixtures/confluence-copy-recovery-facts.js';
import { runConfluenceLedgerMaintenancePostgresProof } from './confluence-ledger-maintenance-postgres-proof.mjs';

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
    await prisma.$executeRawUnsafe("CREATE ROLE synthetic_ledger_runtime LOGIN PASSWORD 'synthetic-ledger-runtime-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO synthetic_ledger_runtime');
    await prisma.$executeRawUnsafe('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO synthetic_ledger_runtime');
    const runtimeUrl = new URL(url); runtimeUrl.username = 'synthetic_ledger_runtime'; runtimeUrl.password = 'synthetic-ledger-runtime-only';
    const runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl.href } }, log: [{ emit: 'event', level: 'error' }] });
    let syntheticDiagnostic = '';
    runtime.$on('error',event => { syntheticDiagnostic = event.message.slice(-1200); });
    const observedControl = { format: 2, installationId: input.installationId, organisationId: 'org-a', writerId: 'writer-a',
      writerEpoch: 1, generation: 0, digest: null, activeOperation: null, revision: 'synthetic-observed-head' };
    const durableInput = { installationId: input.installationId, operationId: 'durable-original-empty', writerEpoch: 1,
      sourceRevision: input.declaredSourceRevision, keyId: recoveryContextFixture.keyId, observedControl };
    const beforeDurable = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    let originalCapture;
    const fromAsyncSession = { $transaction: (fn,options) => runtime.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
      const result = await fn(tx);
      const [setting] = await tx.$queryRawUnsafe("SELECT current_setting('synchronous_commit') AS value");
      assert.equal(setting.value,'on'); return result;
    },options) };
    try { originalCapture = await new ConfluenceCopyLedgerCaptureStore(fromAsyncSession).prepare('org-a','owner-a',durableInput); }
    catch (error) { throw new Error(`${error.message}; disposable synthetic database diagnostic: ${syntheticDiagnostic}`); }
    finally { await runtime.$disconnect(); }
    assert.equal(originalCapture.durableCaptureRecorded,true);
    const afterDurable = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    assert.equal(afterDurable.format,13);
    assert.equal(Object.values((await prisma.$queryRawUnsafe(PURGE_RESTORE_BINDING_PROBE_SQL))[0])[0],'confluence-upload');
    assert.throws(() => assertPurgeRestoreLedger(afterDurable,beforeDurable),{ code: 'PURGE_RESTORE_RECONCILIATION_REQUIRED' });

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
    const populated = await new ConfluenceCopyLedgerCaptureStore(prisma).prepare('org-a','owner-a',{
      ...durableInput, operationId: 'ledger-archive-original' });
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
    const binding = populated.binding, context = binding.context;
    const restarted = JSON.parse(run(process.execPath,['scripts/confluence-ledger-capture-restart-proof.mjs'],{ env: {
      ...process.env, DATABASE_URL: runtimeUrl.href, CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_PROOF: '1',
      CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_INPUT: JSON.stringify(durableInput),
    } }));
    assert.equal(restarted.id,originalCapture.id); assert.equal(restarted.body,originalCapture.body);
    assert.equal(restarted.digest,originalCapture.digest); assert.equal(restarted.replayed,true);
    const durableRow = await prisma.confluenceCopyLedgerCapture.findUniqueOrThrow({ where: { id: populated.id } });
    const rejectedWrite = async fn => { await assert.rejects(fn); };
    await rejectedWrite(() => prisma.confluenceCopyLedgerCapture.update({ where: { id: populated.id }, data: { factsDigest: 'f'.repeat(64) } }));
    await rejectedWrite(() => prisma.confluenceCopyLedgerCapture.delete({ where: { id: populated.id } }));
    await rejectedWrite(() => prisma.$executeRawUnsafe('TRUNCATE public."ConfluenceCopyLedgerCapture"'));
    const cloneInput = operationId => ({ ...durableRow, id: operationId, operationId, context: { ...context, operationId } });
    await assert.rejects(prisma.confluenceCopyLedgerCapture.create({ data: cloneInput('wrong-isolation') }),/repeatable source snapshot/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
      await tx.confluenceCopyLedgerCapture.create({ data: cloneInput('async-capture') });
    },{ isolationLevel: 'RepeatableRead' }),/durable WAL settings/);
    await assert.rejects(prisma.$transaction(async tx => {
      const data = cloneInput('null-epoch'); data.context.writerEpoch = null;
      data.observedControl = { ...observedControl, writerEpoch: null };
      await tx.confluenceCopyLedgerCapture.create({ data });
    },{ isolationLevel: 'RepeatableRead' }),/binding or original facts are invalid/);
    for (const kind of ['numeric-digest','fractional-generation','fractional-epoch']) {
      await assert.rejects(prisma.$transaction(async tx => {
        const data = cloneInput(kind);
        data.observedControl = { ...observedControl, generation: 1, digest: '1'.repeat(64) };
        if (kind === 'numeric-digest') data.observedControl.digest = 1e63;
        if (kind === 'fractional-generation') data.observedControl.generation = 1.25;
        if (kind === 'fractional-epoch') {
          data.context.writerEpoch = 1.25;
          data.observedControl.writerEpoch = 1.25;
        }
        await tx.confluenceCopyLedgerCapture.create({ data });
      },{ isolationLevel: 'RepeatableRead' }),kind === 'numeric-digest'
        ? /Confluence ledger capture control types/ : /invalid input syntax for type bigint/);
    }
    // A digest containing only decimal characters is still a valid hash string.
    // Roll back this accepted positive control so later fixture counts stay exact.
    await assert.rejects(prisma.$transaction(async tx => {
      const data = cloneInput('string-digest-control');
      data.observedControl = { ...observedControl, generation: 1, digest: '1'.repeat(64) };
      await tx.confluenceCopyLedgerCapture.create({ data });
      throw new Error('ROLLBACK-VALID-STRING-DIGEST');
    },{ isolationLevel: 'RepeatableRead' }),/ROLLBACK-VALID-STRING-DIGEST/);
    const forgedRuntime = new PrismaClient({ datasources: { db: { url: runtimeUrl.href } } });
    try {
      await assert.rejects(forgedRuntime.$transaction(async tx => {
        await tx.$executeRawUnsafe('CREATE TEMP TABLE "User"(id TEXT,"organisationId" TEXT,role TEXT,"lifecycleStatus" TEXT) ON COMMIT DROP');
        await tx.$executeRawUnsafe("INSERT INTO pg_temp.\"User\" VALUES ('member-a','org-a','OWNER','ACTIVE')");
        await tx.confluenceCopyLedgerCapture.create({ data: { ...cloneInput('spoofed-owner'), actorUserId: 'member-a' } });
      },{ isolationLevel: 'RepeatableRead' }),/active charity Owner/);
    } finally { await forgedRuntime.$disconnect(); }
    const altered = JSON.parse(durableRow.facts); altered.tables.ConfluenceCopyPublicationPlan = [];
    const alteredBody = JSON.stringify(altered);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.confluenceCopyLedgerCapture.create({ data: { ...durableRow, id: 'forged-ledger-source', operationId: 'forged-ledger-source',
        context: { ...context, operationId: 'forged-ledger-source' }, facts: alteredBody,
        factsDigest: createHash('sha256').update(alteredBody).digest('hex') } });
    },{ isolationLevel: 'RepeatableRead' }),/complete current source rows/);
    assert.equal(await prisma.confluenceCopyLedgerCapture.count(),2);
    await new ConfluenceCopyLedgerCaptureStore(prisma).prepare('org-b','owner-b',{
      ...durableInput, operationId: 'empty-other-charity', observedControl: { ...observedControl, organisationId: 'org-b' } });
    await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO public."DocumentRecoveryEnforcement"
      (id,"organisationId","installationId","writerId","writerEpoch")
      VALUES ('unsafe-empty-binding','org-b','synthetic-install','writer-b',1)`),/reviewed original archive dispatch history/);
    const keys = { generate: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId, wrappedKey: 'dGVzdA==' }),
      unwrap: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId }) };
    const candidateRuntime = new PrismaClient({ datasources: { db: { url: runtimeUrl.href } } });
    let savedCandidate;
    const beforeCandidate = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    try { savedCandidate = await new ConfluenceCopyLedgerCandidateStore(candidateRuntime).prepare('org-a','owner-a',populated.id,keys); }
    finally { await candidateRuntime.$disconnect(); }
    assert.equal(savedCandidate.durableCandidateRecorded,true);
    const candidateRestarted = JSON.parse(run(process.execPath,['scripts/confluence-ledger-capture-restart-proof.mjs'],{ env: {
      ...process.env, DATABASE_URL: runtimeUrl.href, CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_PROOF: '1',
      CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_INPUT: JSON.stringify(durableInput),
      CHARITYPILOT_SYNTHETIC_LEDGER_CANDIDATE_ID: populated.id,
    } }));
    assert.equal(candidateRestarted.id,savedCandidate.id); assert.equal(candidateRestarted.replayed,true);
    assert.deepEqual(candidateRestarted.candidate,savedCandidate.candidate);
    const candidateRow = await prisma.confluenceCopyLedgerCandidate.findUniqueOrThrow({ where: { id: savedCandidate.id } });
    await assert.rejects(prisma.confluenceCopyLedgerCandidate.update({ where: { id: candidateRow.id }, data: { envelopeDigest: '0'.repeat(64) } }),/append-only/);
    await assert.rejects(prisma.confluenceCopyLedgerCandidate.delete({ where: { id: candidateRow.id } }),/append-only/);
    await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE public."ConfluenceCopyLedgerCandidate"'));
    await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE public."ConfluenceCopyLedgerCandidate",public."ConfluenceCopyLedgerProgress",public."ConfluenceCopyLedgerUploadAttempt"'),/append-only/);
    const candidateClone = { ...candidateRow, id: 'forged-candidate', captureId: originalCapture.id };
    await assert.rejects(prisma.confluenceCopyLedgerCandidate.create({ data: candidateClone }),/repeatable source binding/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
      await tx.confluenceCopyLedgerCandidate.create({ data: candidateClone });
    },{ isolationLevel: 'RepeatableRead' }),/durable WAL settings/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.confluenceCopyLedgerCandidate.create({ data: candidateClone });
    },{ isolationLevel: 'RepeatableRead' }),/hash or original envelope binding/);
    const afterCandidate = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    assert.throws(() => assertPurgeRestoreLedger(afterCandidate,beforeCandidate),{ code: 'PURGE_RESTORE_RECONCILIATION_REQUIRED' });
    assert.equal(assertPurgeRestoreLedger(afterCandidate,afterCandidate).confluenceLedgerCandidatesCompared,true);
    // SQL binds the declared immutable header, not AES-GCM. An injected invalid
    // candidate must fail application authentication, never trigger a reseal.
    const broken = JSON.parse((await sealConfluenceCopyLedgerArchive(originalCapture.body,originalCapture.binding,keys)).envelope);
    broken.sealed.ciphertext = 'YQ==';
    const brokenEnvelope = JSON.stringify(broken);
    await prisma.$transaction(async tx => {
      await tx.confluenceCopyLedgerCandidate.create({ data: { id: 'synthetic-invalid-ciphertext', organisationId: 'org-a',
        captureId: originalCapture.id, actorUserId: 'owner-a', envelope: brokenEnvelope,
        envelopeDigest: createHash('sha256').update(brokenEnvelope).digest('hex') } });
    },{ isolationLevel: 'RepeatableRead' });
    const corruptRuntime = new PrismaClient({ datasources: { db: { url: runtimeUrl.href } } });
    try {
      await assert.rejects(new ConfluenceCopyLedgerCandidateStore(corruptRuntime).prepare('org-a','owner-a',originalCapture.id,{
        ...keys, generate: async () => { throw new Error('Corruption must not generate a replacement'); },
      }),/candidate is unresolved/);
    } finally { await corruptRuntime.$disconnect(); }
    assert.equal(await prisma.confluenceCopyLedgerCandidate.count(),2);
    const concurrentCapture = await prisma.confluenceCopyLedgerCapture.findUniqueOrThrow({
      where: { organisationId_operationId: { organisationId: 'org-b', operationId: 'empty-other-charity' } } });
    const racingClients = [0,1].map(() => new PrismaClient({ datasources: { db: { url: runtimeUrl.href } } }));
    try {
      const results = await Promise.allSettled(racingClients.map(client =>
        new ConfluenceCopyLedgerCandidateStore(client).prepare('org-b','owner-b',concurrentCapture.id,keys)));
      assert.ok(results.some(result => result.status === 'fulfilled'));
      const retries = await Promise.all(racingClients.map(client =>
        new ConfluenceCopyLedgerCandidateStore(client).prepare('org-b','owner-b',concurrentCapture.id,keys)));
      assert.deepEqual(retries[0].candidate,retries[1].candidate);
      assert.ok(retries.every(result => result.replayed));
      for (const result of results) if (result.status === 'fulfilled') assert.deepEqual(result.value.candidate,retries[0].candidate);
      assert.equal(await prisma.confluenceCopyLedgerCandidate.count({ where: { captureId: concurrentCapture.id } }),1);
    } finally { await Promise.all(racingClients.map(client => client.$disconnect())); }
    let encrypted = null, encryptedWrites = 0;
    const objects = { readConfluenceCopyLedger: async () => encrypted,
      createConfluenceCopyLedger: async (_operation,envelope) => {
        assert.equal(encrypted,null); encrypted = envelope; encryptedWrites++;
        throw new Error('Synthetic original write acknowledgement lost');
      } };
    await assert.rejects(preservePreparedConfluenceCopyLedgerArchive(savedCandidate.original,savedCandidate.candidate,keys,objects),/unresolved/);
    const preserved = await preservePreparedConfluenceCopyLedgerArchive(savedCandidate.original,candidateRestarted.candidate,keys,objects);
    assert.equal(preserved.replayed,true); assert.equal(encryptedWrites,1);
    assert.equal((await readVerifiedConfluenceCopyLedgerArchive(preserved.digest,binding,keys,objects)).body,populated.body);
    assert.equal(preserved.currentHistoryVerified,false);
    let current = structuredClone(binding.observedControl), revision = 0;
    const control = { readControl: async () => structuredClone(current),
      compareAndSwapControl: async (expected,next) => {
        if (expected !== current.revision) return false;
        current = { ...next, revision: `synthetic-archive-revision-${++revision}` }; return true;
      } };
    const rows = new Map(), identity = { installationId: context.installationId, organisationId: context.organisationId };
    const journal = new RecoveryAuthorityJournal({ read: async key => rows.get(key) ?? null,
      create: async (key,body) => { if (rows.has(key)) return false; rows.set(key,body); return true; } },
      identity,{ ...identity, generation: 0, digest: null });
    await reserveRecoveryOperation({ ...identity, operationId: context.operationId, writerId: 'writer-a', writerEpoch: 1,
      preparationDigest: populated.digest, expectedGeneration: 0, expectedDigest: null },control);
    const publishedArchive = await publishVerifiedConfluenceCopyLedger(journal,control,populated.digest,binding,keys,objects);
    assert.equal(publishedArchive.headPublished,true);
    assert.equal(publishedArchive.candidatePrefixVerified,true);
    const archive = await readPublishedConfluenceCopyLedger(journal,control,binding,keys,objects);
    assert.equal(archive.body,populated.body); assert.equal(archive.currentHistoryVerified,false);
    assert.equal(archive.reopeningAuthorised,false); assert.notEqual(current.activeOperation,null);
    // Actual restricted-role coordinator composition, not substituted local
    // rows: both bounded snapshots run against the migrated PostgreSQL fixture.
    const reconciliationRuntime = new PrismaClient({ datasources: { db: { url: runtimeUrl.href } } });
    const reconciliationBefore = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    const ledgerState = ({ capturedAt: _observationTime, ...snapshot }) => snapshot;
    const originalControl = structuredClone(current), originalJournal = [...rows.values()];
    let inspections = 0, archiveReads = 0;
    const inspectedRuntime = { $transaction: (fn,options) => reconciliationRuntime.$transaction(async tx => {
      const [observed] = await tx.$queryRawUnsafe("SELECT current_user AS role,current_setting('transaction_isolation') AS isolation");
      assert.equal(observed.role,'synthetic_ledger_runtime'); assert.equal(observed.isolation,'repeatable read');
      inspections++; return fn(tx);
    },options) };
    const reconciliationObjects = { readConfluenceCopyLedger: async operationId => {
      archiveReads++; return objects.readConfluenceCopyLedger(operationId);
    } };
    const reconciliationDeps = { journal, control: { readControl: control.readControl }, keys, objects: reconciliationObjects };
    try {
      const reconciled = await inspectConfluenceCopyLedgerReconciliation(inspectedRuntime,'org-a','owner-a',binding,reconciliationDeps);
      assert.equal(inspections,2); assert.equal(reconciled.matchingRecords,4);
      assert.equal(reconciled.inserts.length,0); assert.equal(reconciled.requiresReplay,false);
      assert.equal(reconciled.actionAuthorized,false); assert.equal(reconciled.currentHistoryVerified,false);
      assert.equal(reconciled.reopeningAuthorised,false); assert.equal(reconciled.transportStateReconciled,false);
      assert.ok(archiveReads > 0);
      const readsBeforeDenied = archiveReads;
      await assert.rejects(inspectConfluenceCopyLedgerReconciliation(inspectedRuntime,'org-a','member-a',binding,reconciliationDeps),/Complete Confluence ledger reconciliation is unresolved/);
      await assert.rejects(inspectConfluenceCopyLedgerReconciliation(inspectedRuntime,'org-b','owner-a',binding,reconciliationDeps),/Complete Confluence ledger reconciliation is unresolved/);
      assert.equal(archiveReads,readsBeforeDenied,'denied actor must not read independent archive');
      const reconciliationAfter = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
      assert.deepEqual(ledgerState(reconciliationAfter),ledgerState(reconciliationBefore),'read-only inspection must preserve all observed ledgers');
      assert.deepEqual(current,originalControl); assert.deepEqual([...rows.values()],originalJournal);

      // A new real local decision is not in the already authenticated archive.
      // Inspection must preserve it and refuse, never drop it to match backup.
      const laterReview = await reviews.record('org-a','owner-a',{ ...review, evidenceRef: 'SYNTHETIC-LATER-LOCAL-REVIEW' });
      const withLater = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
      await assert.rejects(inspectConfluenceCopyLedgerReconciliation(inspectedRuntime,'org-a','owner-a',binding,reconciliationDeps),/Complete Confluence ledger reconciliation is unresolved/);
      assert.ok(await prisma.confluenceRetainedCopyReview.findUnique({ where: { id: laterReview.id } }));
      assert.deepEqual(ledgerState((await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot),ledgerState(withLater));
      assert.deepEqual(current,originalControl); assert.deepEqual([...rows.values()],originalJournal);
    } finally { await reconciliationRuntime.$disconnect(); }
    const progressRuntime = new PrismaClient({ datasources: { db: { url: runtimeUrl.href } } });
    const progressDeps = { journal, control: { readControl: control.readControl }, keys, objects };
    const beforeProgress = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    const independentBeforeLocalProgress = { control: structuredClone(current), journal: [...rows], envelope: encrypted };
    let publishedProgress;
    try {
      let loseLocalCommit = true;
      const unknownCommit = { $transaction: async (...args) => {
        const result = await progressRuntime.$transaction(...args);
        if (result.stage === 'PUBLISHED' && loseLocalCommit) { loseLocalCommit = false; throw new Error('Synthetic committed progress response lost'); }
        return result;
      } };
      await assert.rejects(new ConfluenceCopyLedgerProgressStore(unknownCommit).observe('org-a','owner-a',savedCandidate.id,'PUBLISHED',progressDeps),/unresolved/);
      publishedProgress = await new ConfluenceCopyLedgerProgressStore(progressRuntime).observe('org-a','owner-a',savedCandidate.id,'PUBLISHED',progressDeps);
      assert.equal(publishedProgress.replayed,true);
      await assert.rejects(new ConfluenceCopyLedgerProgressStore(progressRuntime).observe('org-a','owner-a',savedCandidate.id,'ACKNOWLEDGED',progressDeps),/unresolved/);
    } finally { await progressRuntime.$disconnect(); }
    const afterLocalProgress = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    for (const name of CONFLUENCE_COPY_LEDGER_TABLES) assert.deepEqual(afterLocalProgress.tables[name],beforeProgress.tables[name]);
    assert.notDeepEqual(afterLocalProgress.tables.ConfluenceCopyLedgerProgress,beforeProgress.tables.ConfluenceCopyLedgerProgress);
    assert.deepEqual({ control: current, journal: [...rows], envelope: encrypted },independentBeforeLocalProgress,
      'independent archive/control/journal cannot reveal whether a local progress receipt committed');
    console.log('Synthetic transport coverage boundary: unchanged independent archive/control/journal and eight source tables; local publication receipt changed');
    const publishedRow = await prisma.confluenceCopyLedgerProgress.findUniqueOrThrow({ where: { id: publishedProgress.receiptId } });
    await assert.rejects(prisma.confluenceCopyLedgerProgress.update({ where: { id: publishedRow.id }, data: { entryDigest: '0'.repeat(64) } }),/append-only/);
    await assert.rejects(prisma.confluenceCopyLedgerProgress.delete({ where: { id: publishedRow.id } }),/append-only/);
    await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE public."ConfluenceCopyLedgerProgress"'),/append-only/);
    const progressClone = { ...publishedRow, id: 'forged-progress', candidateId: candidateRow.id, stage: 'ACKNOWLEDGED' };
    await assert.rejects(prisma.confluenceCopyLedgerProgress.create({ data: progressClone }),/repeatable source binding/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
      await tx.confluenceCopyLedgerProgress.create({ data: progressClone });
    },{ isolationLevel: 'RepeatableRead' }),/durable WAL settings/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.confluenceCopyLedgerProgress.create({ data: { ...progressClone, entryDigest: '0'.repeat(64) } });
    },{ isolationLevel: 'RepeatableRead' }),/exact committed publication progress/);
    const noPublicationCandidate = await prisma.confluenceCopyLedgerCandidate.findUniqueOrThrow({ where: { captureId: concurrentCapture.id } });
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.confluenceCopyLedgerProgress.create({ data: { ...progressClone, id: 'ack-without-publication',
        organisationId: 'org-b', actorUserId: 'owner-b', candidateId: noPublicationCandidate.id,
        envelopeDigest: noPublicationCandidate.envelopeDigest } });
    },{ isolationLevel: 'RepeatableRead' }),/exact committed publication progress/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.confluenceCopyLedgerProgress.create({ data: { ...progressClone, actorUserId: 'member-a' } });
    },{ isolationLevel: 'RepeatableRead' }),/active charity Owner/);
    const afterProgress = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    assert.throws(() => assertPurgeRestoreLedger(afterProgress,beforeProgress),{ code: 'PURGE_RESTORE_RECONCILIATION_REQUIRED' });
    assert.equal(assertPurgeRestoreLedger(afterProgress,afterProgress).confluenceLedgerProgressCompared,true);
    const archiveControl = { ...control, releaseConfluenceCopyLedgerControl: async (expectedRevision,expected) => {
      if (current.revision !== expectedRevision) return false;
      assert.equal(expected.operationId,context.operationId); assert.equal(expected.preparationDigest,populated.digest);
      assert.equal(expected.generation,archive.entryGeneration); assert.equal(expected.digest,archive.entryDigest);
      assert.equal(expected.envelopeDigest,archive.envelopeDigest);
      current = { ...current, activeOperation: null, revision: `synthetic-archive-acknowledgement-${++revision}` }; return true;
    } };
    const acknowledged = await acknowledgeConfluenceCopyLedgerArchive(journal,archiveControl,populated.digest,binding,keys,objects);
    assert.equal(acknowledged.acknowledged,true); assert.equal(acknowledged.currentHistoryVerified,false);
    assert.equal(acknowledged.reopeningAuthorised,false); assert.equal(current.activeOperation,null);
    assert.equal(current.generation,archive.entryGeneration); assert.equal(current.digest,archive.entryDigest);
    assert.equal((await acknowledgeConfluenceCopyLedgerArchive(journal,archiveControl,populated.digest,binding,keys,objects)).replayed,true);
    const ackRuntime = new PrismaClient({ datasources: { db: { url: runtimeUrl.href } } });
    let acknowledgedProgress;
    try {
      acknowledgedProgress = await new ConfluenceCopyLedgerProgressStore(ackRuntime).observe('org-a','owner-a',savedCandidate.id,'ACKNOWLEDGED',progressDeps);
    } finally { await ackRuntime.$disconnect(); }
    const progressRestarted = JSON.parse(run(process.execPath,['scripts/confluence-ledger-capture-restart-proof.mjs'],{ env: {
      ...process.env, DATABASE_URL: runtimeUrl.href, CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_PROOF: '1',
      CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_INPUT: JSON.stringify(durableInput), CHARITYPILOT_SYNTHETIC_LEDGER_CANDIDATE_ID: populated.id,
    } }));
    assert.deepEqual(progressRestarted.progress.map(row => row.id).sort(),[publishedProgress.receiptId,acknowledgedProgress.receiptId].sort());
    assert.deepEqual(progressRestarted.progress.map(row => row.stage).sort(),['ACKNOWLEDGED','PUBLISHED']);

    const dispatchCapture = await new ConfluenceCopyLedgerCaptureStore(prisma).prepare('org-a','owner-a',{
      ...durableInput, operationId: 'dispatcher-restart-original' });
    const dispatchCandidate = await new ConfluenceCopyLedgerCandidateStore(prisma).prepare('org-a','owner-a',dispatchCapture.id,keys);
    const beforeDispatch = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    let external = { control: dispatchCapture.binding.observedControl, envelope: null, rows: [], version: 0, puts: 0, releases: 0 };
    for (const failure of ['PUT','HEAD','ACK','NONE']) {
      const step = JSON.parse(run(process.execPath,['scripts/confluence-ledger-dispatch-restart-proof.mjs'],{ env: {
        ...process.env, DATABASE_URL: runtimeUrl.href, CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_PROOF: '1',
      }, input: JSON.stringify({ candidateId: dispatchCandidate.id, external, failure }) }));
      assert.equal(step.status,failure === 'NONE' ? 'ACKNOWLEDGED' : 'UNRESOLVED');
      external = step.external;
      assert.equal(external.puts,1); assert.equal(external.envelope,dispatchCandidate.candidate.envelope);
      assert.equal(external.control.generation,failure === 'PUT' ? 0 : 1);
      assert.equal(external.control.activeOperation === null,failure === 'ACK' || failure === 'NONE');
      assert.equal(external.releases,failure === 'ACK' || failure === 'NONE' ? 1 : 0);
      assert.equal(await prisma.confluenceCopyLedgerProgress.count({ where: { candidateId: dispatchCandidate.id } }),
        failure === 'NONE' ? 2 : failure === 'ACK' ? 1 : 0);
      if (failure === 'NONE') {
        assert.equal(step.result.actionAuthorized,false); assert.equal(step.result.currentHistoryVerified,false);
        assert.equal(step.result.reopeningAuthorised,false);
      }
    }
    assert.equal(external.releases,1); assert.equal(external.control.activeOperation,null);
    assert.equal(await prisma.confluenceCopyLedgerUploadAttempt.count({ where: { candidateId: dispatchCandidate.id } }),1);
    assert.equal(await prisma.confluenceCopyLedgerProgress.count({ where: { candidateId: dispatchCandidate.id } }),2);
    const uploadRow = await prisma.confluenceCopyLedgerUploadAttempt.findUniqueOrThrow({ where: { candidateId: dispatchCandidate.id } });
    await assert.rejects(prisma.confluenceCopyLedgerUploadAttempt.update({ where: { id: uploadRow.id }, data: { actorUserId: 'member-a' } }),/append-only/);
    await assert.rejects(prisma.confluenceCopyLedgerUploadAttempt.delete({ where: { id: uploadRow.id } }),/append-only/);
    await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE public."ConfluenceCopyLedgerUploadAttempt"'),/append-only/);
    const uploadClone = { ...uploadRow, id: 'forged-upload-attempt' };
    await assert.rejects(prisma.confluenceCopyLedgerUploadAttempt.create({ data: uploadClone }),/repeatable source binding/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
      await tx.confluenceCopyLedgerUploadAttempt.create({ data: uploadClone });
    },{ isolationLevel: 'RepeatableRead' }),/durable WAL settings/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.confluenceCopyLedgerUploadAttempt.create({ data: uploadClone });
    },{ isolationLevel: 'RepeatableRead' }),/reserved unpublished binding/);
    const afterDispatch = (await prisma.$queryRawUnsafe(PURGE_RESTORE_SNAPSHOT_SQL))[0].snapshot;
    assert.throws(() => assertPurgeRestoreLedger(afterDispatch,beforeDispatch),{ code: 'PURGE_RESTORE_RECONCILIATION_REQUIRED' });
    assert.equal(assertPurgeRestoreLedger(afterDispatch,afterDispatch).confluenceLedgerUploadAttemptsCompared,true);

    await assert.rejects(captureConfluenceCopyLocalLedger(prisma,'org-a','member-a',input),/capture is unresolved/);
    await assert.rejects(captureConfluenceCopyLocalLedger(prisma,'org-b','owner-a',input),/capture is unresolved/);
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: 'owner-a' }, data: { role: 'MEMBER' } });
      await tx.user.update({ where: { id: 'member-a' }, data: { role: 'OWNER' } });
    });
    await assert.rejects(captureConfluenceCopyLocalLedger(prisma,'org-a','owner-a',input),/capture is unresolved/);
    const maintenanceProof = await runConfluenceLedgerMaintenancePostgresProof(prisma,url);
    console.log('Synthetic joined archive/PostgreSQL maintenance proof:',JSON.stringify(maintenanceProof));
  } finally {
    if (prisma) await prisma.$disconnect();
    assert.equal(docker(['inspect','--format','{{.Id}}',name]),id);
    docker(['rm','--force','--volumes',name]);
    assert.equal(docker(['ps','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}']),'');
  }
});
