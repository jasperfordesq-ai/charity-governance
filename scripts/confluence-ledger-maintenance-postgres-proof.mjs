import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { ConfluenceRetainedCopyReviewService } from '../apps/api/dist/services/confluence-retained-copy-review.service.js';
import { registerSyntheticConfluenceScope } from '../apps/api/dist/services/confluence-synthetic-scope.js';
import { ConfluenceRetainedCopyPermissionService } from '../apps/api/dist/services/confluence-retained-copy-permission.service.js';
import { ConfluenceCopyRecoveryCaptureStore } from '../apps/api/dist/services/confluence-copy-recovery-capture.js';
import { ConfluenceCopyPublicationStore } from '../apps/api/dist/services/confluence-copy-publication-store.js';
import { ConfluenceCopyLedgerCaptureStore } from '../apps/api/dist/services/confluence-copy-ledger-capture-store.js';
import { RecoveryAuthorityJournal } from '../apps/api/dist/services/recovery-authority-journal.js';
import { reserveRecoveryOperation } from '../apps/api/dist/services/recovery-operation-reservation.js';
import { sealConfluenceCopyLedgerArchive } from '../apps/api/dist/services/confluence-copy-ledger-envelope.js';
import { publishVerifiedConfluenceCopyLedger } from '../apps/api/dist/services/published-confluence-copy-ledger.js';
import { replayConfluenceCopyLedgerRows } from '../apps/api/dist/services/confluence-copy-ledger-maintenance-replay.js';
import { recoveryFactsFixture, recoveryContextFixture } from '../apps/api/dist/tests/fixtures/confluence-copy-recovery-facts.js';

/** Test-only composition in the caller's UUID disposable database. No CLI,
 * production credentials, real provider or operator recovery path. */
export async function runConfluenceLedgerMaintenancePostgresProof(prisma,url) {
  const target = new URL(url);
  assert.equal(target.hostname,'127.0.0.1'); assert.equal(target.username,'postgres');
  assert.match(target.pathname,/^\/copy_ledger_[a-f0-9]{32}$/);
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name,current_user AS role`;
  assert.equal(database.name,target.pathname.slice(1)); assert.equal(database.role,'postgres');
  await prisma.$transaction(async tx => {
    await tx.user.update({ where: { id: 'member-a' }, data: { role: 'MEMBER' } });
    await tx.user.update({ where: { id: 'owner-a' }, data: { role: 'OWNER' } });
  });
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: 'doc-a' } });
  const pub = await prisma.documentPublication.findUniqueOrThrow({ where: { id: 'pub-a' } });
  const review = recoveryFactsFixture().review.review, now = Date.now();
  review.reviewedAt = new Date(now).toISOString(); review.expiresAt = new Date(now+3600000).toISOString();
  review.snapshot.sourceRevision = doc.updatedAt.toISOString(); review.snapshot.publicationRevision = pub.updatedAt.toISOString();
  review.snapshot.inventory.observedAt = new Date(now).toISOString();
  const reviewStore = new ConfluenceRetainedCopyReviewService(prisma);
  const recorded = await reviewStore.record('org-a','owner-a',review);
  const integration = await prisma.organisationIntegration.create({ data: {
    organisationId: 'org-a', provider: 'CONFLUENCE', status: 'CONNECTED', connectedAt: new Date(now),
    config: { siteId: review.snapshot.cloudId, siteUrl: review.snapshot.siteOrigin },
    grantedScopes: ['read:page:confluence','read:attachment:confluence'],
  } });
  // Synthetic maintenance scope/decision fixture; no live consent or OAuth token.
  const scopeInput = {
    organisationId: 'org-a', reviewId: recorded.id, expectedSnapshotSha256: recorded.snapshotSha256,
    evidenceRef: 'SYNTHETIC-JOINED-SCOPE', disposalPolicyEvidenceRef: 'SYNTHETIC-JOINED-DISPOSAL',
    approvedById: 'owner-a', expiresAt: new Date(now+3500000).toISOString(),
  };
  const commandDir=mkdtempSync(join(tmpdir(),'charitypilot-scope-cli-'));
  const inputFile=join(commandDir,'scope.json');
  writeFileSync(inputFile,JSON.stringify(scopeInput),{encoding:'utf8',mode:0o600});
  const runScopeCommand=(confirmation)=>{
    const env={...process.env,NODE_ENV:'test',CHARITYPILOT_DEPLOYMENT_MODE:'',DATABASE_MAINTENANCE_URL:url,
      DATABASE_URL:'postgresql://not-the-maintenance-role@127.0.0.1:1/not-a-target'};
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../apps/api/dist/jobs/register-confluence-synthetic-scope.js',import.meta.url)),
      '--input',inputFile,...(confirmation?['--confirm',confirmation]:[])],{env,encoding:'utf8',timeout:30000,maxBuffer:65536});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  let preview,registered;
  try {
    preview=runScopeCommand();
    assert.equal(preview.state,'PREVIEW');
    assert.equal(await prisma.confluenceSyntheticCopyScope.count({where:{reviewId:recorded.id}}),0);
    await assert.rejects(registerSyntheticConfluenceScope(prisma,scopeInput,'f'.repeat(64)));
    registered=runScopeCommand(preview.confirmationSha256);
  } finally {
    assert.equal(dirname(resolve(commandDir)),resolve(tmpdir()));
    rmSync(commandDir,{recursive:true});
  }
  assert.equal(preview.state,'PREVIEW'); assert.equal(preview.providerIOAuthorised,false);
  assert.equal(registered.state,'REGISTERED');
  const repeated = await registerSyntheticConfluenceScope(prisma,scopeInput,preview.confirmationSha256);
  assert.equal(repeated.state,'ALREADY_REGISTERED'); assert.equal(repeated.scopeId,registered.scopeId);
  assert.equal(await prisma.confluenceSyntheticCopyScope.count({where:{reviewId:recorded.id}}),1);
  const scope = await prisma.confluenceSyntheticCopyScope.findUniqueOrThrow({where:{id:registered.scopeId}});
  const permissionService = new ConfluenceRetainedCopyPermissionService(prisma,{observeSource:async()=>({
    snapshot:{...review.snapshot,inventory:{...review.snapshot.inventory,observedAt:new Date().toISOString()}},
    actorUserId:'owner-a',sourceBytesObserved:true,syntheticVerified:false,allCopiesVerified:false,actionAuthorized:false,
    connection:{integrationId:integration.id,connectedAt:integration.connectedAt.toISOString(),
      cloudId:review.snapshot.cloudId,siteOrigin:review.snapshot.siteOrigin},
  })});
  const permissionResult = await permissionService.issue('org-a','owner-a',recorded.id,{
    scopeId: scope.id, expectedSnapshotSha256: recorded.snapshotSha256,
    evidenceRef: 'SYNTHETIC-JOINED-PERMISSION', reason: 'Synthetic permission retained for isolated restoration proof',
    attestation: 'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY',
    scopeEvidenceRef: scope.evidenceRef, disposalPolicyEvidenceRef: scope.disposalPolicyEvidenceRef,
    expiresAt: new Date(now+3400000).toISOString(),
  });
  assert.equal(permissionResult.providerIOAuthorised,false);
  const permission=permissionResult.permission;
  await permissionService.withdraw('org-a','owner-a',permission.id,{
    evidenceRef: 'SYNTHETIC-JOINED-WITHDRAWAL', reason: 'Preserve original synthetic permission withdrawal on restore',
  });
  await reviewStore.withdraw('org-a','owner-a',recorded.id,{
    evidenceRef: 'SYNTHETIC-JOINED-REVIEW-WITHDRAWAL', reason: 'Preserve original synthetic review withdrawal on restore' });
  const identity = { installationId: 'synthetic-install', organisationId: 'org-a' };
  const capture = await new ConfluenceCopyRecoveryCaptureStore(prisma).capture('org-a','owner-a',{
    installationId: identity.installationId, operationId: 'joined-decision-original', writerEpoch: 1,
    sourceRevision: 'a'.repeat(40), reviewId: recorded.id });
  const publication = new ConfluenceCopyPublicationStore(prisma);
  const plan = await publication.prepare('org-a','owner-a',{
    captureId: capture.id, writerId: 'writer-a', keyId: recoveryContextFixture.keyId,
    keyEvidenceRef: 'SYNTHETIC-JOINED-KEY', expectedGeneration: 0, expectedDigest: null });
  let current = { format: 2,...identity,writerId: 'writer-a',writerEpoch: 1,generation: 0,digest: null,activeOperation: null,revision: 'joined-0' };
  let version = 0, externalWrites = 0;
  const control = { readControl: async () => structuredClone(current), compareAndSwapControl: async (revision,next) => {
    if (revision!==current.revision) return false;
    current = { ...next, revision: `joined-${++version}` }; return true;
  }, releaseConfluenceCopyStateControl: async (revision,expected) => {
    assert.equal(revision,current.revision); assert.equal(current.activeOperation?.operationId,expected.operationId);
    assert.equal(current.activeOperation?.preparationDigest,expected.preparationDigest);
    assert.equal(current.generation,expected.generation); assert.equal(current.digest,expected.digest);
    current = { ...current, activeOperation: null, revision: `joined-${++version}` }; return true;
  } };
  const objects = new Map(), entries = new Map();
  const store = { createConfluenceCopyState: async (operation,envelope) => {
    if (objects.has(operation)) return false; objects.set(operation,envelope); externalWrites++; return true;
  }, readConfluenceCopyState: async operation => objects.get(operation)??null,
  readConfluenceCopyLedger: async operation => objects.get(operation)??null };
  const keys = { generate: async () => ({ key: Buffer.alloc(32,29), keyId: recoveryContextFixture.keyId, wrappedKey: 'dGVzdA==' }),
    unwrap: async () => ({ key: Buffer.alloc(32,29), keyId: recoveryContextFixture.keyId }) };
  const journal = new RecoveryAuthorityJournal({ read: async key => entries.get(key)??null, create: async (key,body) => {
    if (entries.has(key)) return false; entries.set(key,body); return true;
  } },identity,{ ...identity,generation: 0,digest: null });
  await publication.resume('org-a','owner-a',plan.id,{ journal,control,keys,objects: store });
  await publication.release('org-a','owner-a',plan.id,{ journal,control,keys,objects: store },[recoveryContextFixture.keyId]);
  const saved = await new ConfluenceCopyLedgerCaptureStore(prisma).prepare('org-a','owner-a',{
    installationId: identity.installationId, operationId: 'joined-complete-archive', writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: recoveryContextFixture.keyId, observedControl: structuredClone(current) });
  const candidate = await sealConfluenceCopyLedgerArchive(saved.body,saved.binding,keys);
  objects.set(saved.binding.context.operationId,candidate.envelope); externalWrites++;
  await reserveRecoveryOperation({ ...identity,operationId: saved.binding.context.operationId,writerId: 'writer-a',writerEpoch: 1,
    preparationDigest: saved.digest,expectedGeneration: saved.binding.observedControl.generation,expectedDigest: saved.binding.observedControl.digest },control);
  await publishVerifiedConfluenceCopyLedger(journal,control,saved.digest,saved.binding,keys,store);
  const originals = JSON.parse(saved.body).tables;
  assert.ok(Object.values(originals).every(rows => rows.length>0),'joined proof requires all eight populated groups');
  // Prisma.raw receives only these fixed repository-owned identifiers.
  const meta = [
    ['ConfluenceRetainedCopyReview','ConfluenceRetainedCopyReview_guard'],['ConfluenceSyntheticCopyScope','ConfluenceSyntheticCopyScope_guard'],
    ['ConfluenceRetainedCopyPermission','ConfluenceRetainedCopyPermission_guard'],['ConfluenceRetainedCopyReviewWithdrawal','ConfluenceRetainedCopyReviewWithdrawal_guard'],
    ['ConfluenceRetainedCopyPermissionWithdrawal','ConfluenceRetainedCopyPermissionWithdrawal_guard'],['ConfluenceCopyRecoveryCapture','ConfluenceCopyRecoveryCapture_guard'],
    ['ConfluenceCopyPublicationPlan','ConfluenceCopyPlan_guard'],['ConfluenceCopyPublicationReceipt','ConfluenceCopyReceipt_guard'],
  ];
  await prisma.organisation.update({ where: { id: 'org-a' }, data: { lifecycleStatus: 'SUSPENDED' } });
  await prisma.$disconnect(); // Maintenance must be the sole actual client.
  target.searchParams.set('connection_limit','1');
  const maintenance = new PrismaClient({ datasources: { db: { url: target.href } } });
  const readRows = async () => (await maintenance.$queryRaw`SELECT public."ConfluenceCopyLedgerRecovery_rows"('org-a') AS rows`)[0].rows;
  const transportRows = async () => {
    const groups = {};
    for (const [name,delegate] of [['capture','confluenceCopyLedgerCapture'],['candidate','confluenceCopyLedgerCandidate'],
      ['progress','confluenceCopyLedgerProgress'],['attempt','confluenceCopyLedgerUploadAttempt']]) {
      groups[name] = await maintenance[delegate].findMany({ where: { organisationId: 'org-a' }, orderBy: { id: 'asc' } });
    }
    return groups;
  };
  const deps = { journal,control,keys,objects: store };
  try {
    assert.deepEqual(await readRows(),originals);
    const beforeTransport = await transportRows();
    // Disposable older-backup fixture only. No guard bypass reaches the replay.
    await maintenance.$transaction(async tx => {
      for (const [name,guard] of meta) await tx.$executeRaw(Prisma.raw(`ALTER TABLE public."${name}" DISABLE TRIGGER "${guard}"`));
      for (const [name] of [...meta].reverse()) await tx.$executeRaw(Prisma.sql`DELETE FROM public.${Prisma.raw(`"${name}"`)} WHERE "organisationId"=${'org-a'}`);
      for (const [name,guard] of meta) await tx.$executeRaw(Prisma.raw(`ALTER TABLE public."${name}" ENABLE TRIGGER "${guard}"`));
    });
    const empty = await readRows(); assert.ok(Object.values(empty).every(rows => rows.length===0));
    const beforeControl = structuredClone(current), beforeEntries = [...entries], beforeObjects = [...objects], beforeWrites = externalWrites;
    for (const failure of ['SQL','HEAD']) {
      const injected = { $queryRaw: maintenance.$queryRaw.bind(maintenance),
        $transaction: (fn,options) => maintenance.$transaction(async tx => fn({
          $executeRaw: tx.$executeRaw.bind(tx), $queryRaw: async (sql,...values) => {
            const result = await tx.$queryRaw(sql,...values);
            if (sql.join('?').includes('ConfluenceCopyLedgerRecovery_replay')) {
              if (failure==='SQL') await tx.$executeRaw`SELECT 1/0`;
              else current = { ...current, revision: 'synthetic-head-race' };
            }
            return result;
          },
        }),options) };
      await assert.rejects(replayConfluenceCopyLedgerRows(injected,'org-a',saved.binding,deps),/Complete Confluence maintenance replay is unresolved/);
      assert.deepEqual(await readRows(),empty,'late failure must roll back all eight real record groups');
      current = structuredClone(beforeControl); // Reset only synthetic external fixture between cases.
    }
    let committedRestore;
    const unknownCommit = { $queryRaw: maintenance.$queryRaw.bind(maintenance), $transaction: async (fn,options) => {
      committedRestore = await maintenance.$transaction(fn,options); throw new Error('Synthetic acknowledgement lost AFTER real PostgreSQL commit');
    } };
    await assert.rejects(replayConfluenceCopyLedgerRows(unknownCommit,'org-a',saved.binding,deps),/Complete Confluence maintenance replay is unresolved/);
    assert.equal(committedRestore.insertedRecords,Object.values(originals).reduce((count,rows) => count+rows.length,0));
    assert.deepEqual(await readRows(),originals,'unknown response must retain the actual committed eight-table state');
    const originalCiphertext = objects.get(saved.binding.context.operationId);
    objects.delete(saved.binding.context.operationId);
    await assert.rejects(replayConfluenceCopyLedgerRows(maintenance,'org-a',saved.binding,deps),/Complete Confluence maintenance replay is unresolved/);
    assert.deepEqual(await readRows(),originals,'already restored rows do not substitute for independent archive evidence');
    objects.set(saved.binding.context.operationId,originalCiphertext); // Reset synthetic missing-object fixture, no provider create.
    const retry = await replayConfluenceCopyLedgerRows(maintenance,'org-a',saved.binding,deps);
    assert.equal(retry.insertedRecords,0); assert.equal(retry.replayed,true); assert.equal(retry.ledgerRowsReconciled,true);
    for (const flag of ['actionAuthorized','currentHistoryVerified','reopeningAuthorised','transportStateReconciled']) assert.equal(retry[flag],false);
    assert.deepEqual(await readRows(),originals);
    assert.deepEqual(current,beforeControl); assert.deepEqual([...entries],beforeEntries); assert.deepEqual([...objects],beforeObjects);
    assert.equal(externalWrites,beforeWrites);
    assert.equal((await maintenance.organisation.findUniqueOrThrow({ where: { id: 'org-a' } })).lifecycleStatus,'SUSPENDED');
    assert.equal(await maintenance.documentStorageDeletion.count(),0);
    assert.equal((await maintenance.document.findUniqueOrThrow({ where: { id: 'doc-a' } })).deletedAt,null);
    assert.deepEqual(await transportRows(),beforeTransport,'eight-table replay must preserve all four transport groups without claiming reconciliation');
    return { populatedGroups: 8, restoredRecords: committedRestore.insertedRecords, lateRollbacks: 2,
      unknownCommitRetryInserts: retry.insertedRecords, missingArchiveRetryRefused: true, transportGroupsPreserved: 4 };
  } finally { await maintenance.$disconnect(); }
}
