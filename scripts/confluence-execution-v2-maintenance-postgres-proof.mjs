import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { ConfluenceRetainedCopyReviewService } from '../apps/api/dist/services/confluence-retained-copy-review.service.js';
import { registerSyntheticConfluenceScope } from '../apps/api/dist/services/confluence-synthetic-scope.js';
import { ConfluenceRetainedCopyPermissionService } from '../apps/api/dist/services/confluence-retained-copy-permission.service.js';
import { ConfluenceCopyRecoveryCaptureStore } from '../apps/api/dist/services/confluence-copy-recovery-capture.js';
import { ConfluenceCopyPublicationStore } from '../apps/api/dist/services/confluence-copy-publication-store.js';
import { ConfluenceExecutionV2CaptureStore,ConfluenceExecutionV2CandidateStore } from '../apps/api/dist/services/confluence-execution-v2-store.js';
import {ConfluenceExecutionV2Dispatcher} from '../apps/api/dist/services/confluence-execution-v2-dispatcher.js';
import {ConfluenceCopyExecutionClaimService} from '../apps/api/dist/services/confluence-copy-execution-claim.js';
import {ConfluenceCopyExecutionJournalService} from '../apps/api/dist/services/confluence-copy-execution-journal.js';
import { RecoveryAuthorityJournal } from '../apps/api/dist/services/recovery-authority-journal.js';
import { replayConfluenceExecutionV2Rows } from '../apps/api/dist/services/confluence-execution-v2-maintenance-replay.js';
import { recoveryFactsFixture, recoveryContextFixture } from '../apps/api/dist/tests/fixtures/confluence-copy-recovery-facts.js';

/** Test-only composition in the caller's UUID disposable database. No CLI,
 * production credentials, real provider or operator recovery path. */
export async function runConfluenceExecutionV2MaintenancePostgresProof(prisma,url) {
  const target = new URL(url);
  assert.equal(target.hostname,'127.0.0.1'); assert.equal(target.username,'postgres');
  assert.match(target.pathname,/^\/copy_ledger_[a-f0-9]{32}$/);
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name,current_user AS role`;
  assert.equal(database.name,target.pathname.slice(1)); assert.equal(database.role,'postgres');
  await prisma.$transaction(async tx => {
    await tx.organisation.create({data:{id:'v2-replay-org',name:'Synthetic V2 replay'}});
    await tx.user.createMany({data:[{id:'v2-replay-owner',organisationId:'v2-replay-org',role:'OWNER',name:'Synthetic Owner',email:'v2-replay-owner@example.invalid',passwordHash:'not-a-login'},
      {id:'v2-replay-member',organisationId:'v2-replay-org',role:'MEMBER',name:'Synthetic Member',email:'v2-replay-member@example.invalid',passwordHash:'not-a-login'}]});
  });
  const doc=await prisma.document.create({data:{id:'v2-replay-doc',organisationId:'v2-replay-org',name:'Synthetic replay source',category:'OTHER',
    fileUrl:'v2-replay-org/source.txt',fileSize:42,mimeType:'text/plain',lifecycleStatus:'RETIRED',updatedAt:new Date(Date.now()-120000)}});
  const pub=await prisma.documentPublication.create({data:{id:'v2-replay-pub',organisationId:'v2-replay-org',documentId:doc.id,state:'RETIRED',
    cloudId:'00000000-0000-4000-8000-000000000001',spaceId:'space-a',pageId:'page-a',retiredAt:new Date(),nextAttemptAt:null}});
  const review = recoveryFactsFixture().review.review, now = Date.now();
  review.reviewerId='v2-replay-owner';Object.assign(review.snapshot,{organisationId:'v2-replay-org',documentId:doc.id,publicationId:pub.id});
  review.reviewedAt = new Date(now).toISOString(); review.expiresAt = new Date(now+3600000).toISOString();
  review.snapshot.sourceRevision = doc.updatedAt.toISOString(); review.snapshot.publicationRevision = pub.updatedAt.toISOString();
  review.snapshot.inventory.observedAt = new Date(now).toISOString();
  const reviewStore = new ConfluenceRetainedCopyReviewService(prisma);
  const recorded = await reviewStore.record('v2-replay-org','v2-replay-owner',review);
  const integration = await prisma.organisationIntegration.create({ data: {
    organisationId: 'v2-replay-org', provider: 'CONFLUENCE', status: 'CONNECTED', connectedAt: new Date(now),
    config: { siteId: review.snapshot.cloudId, siteUrl: review.snapshot.siteOrigin },
    grantedScopes: ['read:page:confluence','read:attachment:confluence'],
  } });
  // Synthetic maintenance scope/decision fixture; no live consent or OAuth token.
  const scopeInput = {
    organisationId: 'v2-replay-org', reviewId: recorded.id, expectedSnapshotSha256: recorded.snapshotSha256,
    evidenceRef: 'SYNTHETIC-JOINED-SCOPE', disposalPolicyEvidenceRef: 'SYNTHETIC-JOINED-DISPOSAL',
    approvedById: 'v2-replay-owner', expiresAt: new Date(now+3500000).toISOString(),
  };
  const preview=await registerSyntheticConfluenceScope(prisma,scopeInput);
  const registered=await registerSyntheticConfluenceScope(prisma,scopeInput,preview.confirmationSha256);
  const scope=await prisma.confluenceSyntheticCopyScope.findUniqueOrThrow({where:{id:registered.scopeId}});
  const permissionService = new ConfluenceRetainedCopyPermissionService(prisma,{observeSource:async()=>({
    snapshot:{...review.snapshot,inventory:{...review.snapshot.inventory,observedAt:new Date().toISOString()}},
    actorUserId:'v2-replay-owner',sourceBytesObserved:true,syntheticVerified:false,allCopiesVerified:false,actionAuthorized:false,
    connection:{integrationId:integration.id,connectedAt:integration.connectedAt.toISOString(),
      cloudId:review.snapshot.cloudId,siteOrigin:review.snapshot.siteOrigin},
  })});
  const permissionResult = await permissionService.issue('v2-replay-org','v2-replay-owner',recorded.id,{
    scopeId: scope.id, expectedSnapshotSha256: recorded.snapshotSha256,
    evidenceRef: 'SYNTHETIC-JOINED-PERMISSION', reason: 'Synthetic permission retained for isolated restoration proof',
    attestation: 'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY',
    scopeEvidenceRef: scope.evidenceRef, disposalPolicyEvidenceRef: scope.disposalPolicyEvidenceRef,
    expiresAt: new Date(now+3400000).toISOString(),
  });
  assert.equal(permissionResult.providerIOAuthorised,false);
  const permission=permissionResult.permission;
  const runtimeUrl=new URL(url);runtimeUrl.username='synthetic_ledger_runtime';runtimeUrl.password='synthetic-ledger-runtime-only';
  const runtime=new PrismaClient({datasources:{db:{url:runtimeUrl.href}}});
  try {
    const claim=await new ConfluenceCopyExecutionClaimService(runtime).claim('v2-replay-org','v2-replay-owner',{
      permissionId:permission.id,operationId:'v2-replay-claim',expectedSnapshotSha256:recorded.snapshotSha256,
      evidenceRef:'SYNTHETIC-REPLAY-CLAIM',reason:'Synthetic historical claim for eleven-group replay proof'});
    const claimRow=await prisma.confluenceCopyExecutionClaim.findUniqueOrThrow({where:{organisationId_operationId:{organisationId:'v2-replay-org',operationId:'v2-replay-claim'}}});
    const journalService=new ConfluenceCopyExecutionJournalService(runtime);
    const request=await journalService.prepare('v2-replay-org','v2-replay-owner',{claimId:claimRow.id,requestKey:'v2-replay-request',action:'TRASH',
      evidenceRef:'SYNTHETIC-REPLAY-REQUEST',reason:'Synthetic quarantined request, no provider contact'});
    await journalService.recordOutcome('v2-replay-org',{requestId:request.id,requestOutcome:'UNRESOLVED',automaticRetryAllowed:false,providerAbsenceVerified:false,allCopiesVerified:false});
    assert.equal(claim.providerIOAuthorised,false);
    await assert.rejects(runtime.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org')`,/permission denied/);
    await prisma.$executeRaw`GRANT EXECUTE ON FUNCTION public."ConfluenceExecutionV2Recovery_rows"(TEXT),public."ConfluenceExecutionV2Recovery_assert"(TEXT) TO synthetic_ledger_runtime`;
    try {await assert.rejects(runtime.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org')`,/maintenance table owner/);}
    finally {await prisma.$executeRaw`REVOKE EXECUTE ON FUNCTION public."ConfluenceExecutionV2Recovery_rows"(TEXT),public."ConfluenceExecutionV2Recovery_assert"(TEXT) FROM synthetic_ledger_runtime`;}

  } finally {await runtime.$disconnect();}

  await permissionService.withdraw('v2-replay-org','v2-replay-owner',permission.id,{
    evidenceRef: 'SYNTHETIC-JOINED-WITHDRAWAL', reason: 'Preserve original synthetic permission withdrawal on restore',
  });
  await reviewStore.withdraw('v2-replay-org','v2-replay-owner',recorded.id,{
    evidenceRef: 'SYNTHETIC-JOINED-REVIEW-WITHDRAWAL', reason: 'Preserve original synthetic review withdrawal on restore' });
  const identity = { installationId: 'synthetic-install', organisationId: 'v2-replay-org' };
  const capture = await new ConfluenceCopyRecoveryCaptureStore(prisma).capture('v2-replay-org','v2-replay-owner',{
    installationId: identity.installationId, operationId: 'joined-decision-original', writerEpoch: 1,
    sourceRevision: 'a'.repeat(40), reviewId: recorded.id });
  const publication = new ConfluenceCopyPublicationStore(prisma);
  const plan = await publication.prepare('v2-replay-org','v2-replay-owner',{
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
  },releaseConfluenceExecutionV2Control:async(revision,expected)=>{
    assert.equal(revision,current.revision);assert.equal(current.activeOperation?.operationId,expected.operationId);
    assert.equal(current.activeOperation?.preparationDigest,expected.preparationDigest);assert.equal(current.digest,expected.digest);
    current={...current,activeOperation:null,revision:`joined-${++version}`};return true;
  } };
  const objects = new Map(), entries = new Map();
  const store = { createConfluenceCopyState: async (operation,envelope) => {
    if (objects.has(operation)) return false; objects.set(operation,envelope); externalWrites++; return true;
  }, readConfluenceCopyState: async operation => objects.get(operation)??null,
  readConfluenceCopyLedger: async operation => objects.get(operation)??null,
    readConfluenceCopyStateHistory:async operation=>objects.get(operation)??null,readConfluenceCopyLedgerHistory:async operation=>objects.get(operation)??null,
    readExecutionLedgerV2:async context=>objects.get(context.operationId)??null,readExecutionLedgerV2At:async locator=>objects.get(locator.operationId)??null,
    createExecutionLedgerV2:async(context,envelope)=>{if(objects.has(context.operationId))return false;objects.set(context.operationId,envelope);externalWrites++;return true;} };
  const keys = { generate: async () => ({ key: Buffer.alloc(32,29), keyId: recoveryContextFixture.keyId, wrappedKey: 'dGVzdA==' }),
    unwrap: async () => ({ key: Buffer.alloc(32,29), keyId: recoveryContextFixture.keyId }) };
  const journal = new RecoveryAuthorityJournal({ read: async key => entries.get(key)??null, create: async (key,body) => {
    if (entries.has(key)) return false; entries.set(key,body); return true;
  } },identity,{ ...identity,generation: 0,digest: null });
  await publication.resume('v2-replay-org','v2-replay-owner',plan.id,{ journal,control,keys,objects: store });
  await publication.release('v2-replay-org','v2-replay-owner',plan.id,{ journal,control,keys,objects: store },[recoveryContextFixture.keyId]);
  const context={...recoveryContextFixture,...identity,operationId:'joined-execution-v2-archive',writerEpoch:1,sourceRevision:'a'.repeat(40)};
  const saved=await new ConfluenceExecutionV2CaptureStore(prisma).prepare('v2-replay-org','v2-replay-owner',{context,observedControl:structuredClone(current)});
  const encrypted=await new ConfluenceExecutionV2CandidateStore(prisma).prepare('v2-replay-org','v2-replay-owner',saved.id,keys);
  const policy=[{writerEpoch:1,writerId:'writer-a',keyIds:[recoveryContextFixture.keyId]}];
  const deps={journal,control,keys,objects:store,policy};
  await new ConfluenceExecutionV2Dispatcher(prisma).resume('v2-replay-org','v2-replay-owner',encrypted.id,deps);
  assert.equal(current.activeOperation,null);
  const originals = JSON.parse(saved.body).tables;
  assert.ok(Object.values(originals).every(rows => rows.length>0),'joined proof requires all eleven populated groups');
  // Prisma.raw receives only these fixed repository-owned identifiers.
  const meta = [
    ['ConfluenceRetainedCopyReview','ConfluenceRetainedCopyReview_guard'],['ConfluenceSyntheticCopyScope','ConfluenceSyntheticCopyScope_guard'],
    ['ConfluenceRetainedCopyPermission','ConfluenceRetainedCopyPermission_guard'],['ConfluenceRetainedCopyReviewWithdrawal','ConfluenceRetainedCopyReviewWithdrawal_guard'],
    ['ConfluenceRetainedCopyPermissionWithdrawal','ConfluenceRetainedCopyPermissionWithdrawal_guard'],['ConfluenceCopyRecoveryCapture','ConfluenceCopyRecoveryCapture_guard'],
    ['ConfluenceCopyPublicationPlan','ConfluenceCopyPlan_guard'],['ConfluenceCopyPublicationReceipt','ConfluenceCopyReceipt_guard'],
    ['ConfluenceCopyExecutionClaim','ConfluenceCopyExecutionClaim_guard'],['ConfluenceCopyExecutionRequest','ConfluenceCopyExecutionRequest_guard'],
    ['ConfluenceCopyExecutionOutcome','ConfluenceCopyExecutionOutcome_guard'],
  ];
  await prisma.$disconnect(); // One fresh client isolates the active-charity refusal from idle pool sessions.
  await assert.rejects(prisma.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org')`,/quarantined charity/);
  await prisma.organisation.update({ where: { id: 'v2-replay-org' }, data: { lifecycleStatus: 'SUSPENDED' } });
  await prisma.$disconnect(); // Maintenance must be the sole actual client.
  target.searchParams.set('connection_limit','1');
  let maintenance = new PrismaClient({ datasources: { db: { url: target.href } } });
  const readRows = async () => (await maintenance.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org') AS rows`)[0].rows;
  const transportRows = async () => {
    const groups = {};
    for (const [name,delegate] of [['capture','confluenceCopyLedgerCapture'],['candidate','confluenceCopyLedgerCandidate'],
      ['progress','confluenceCopyLedgerProgress'],['attempt','confluenceCopyLedgerUploadAttempt']]) {
      groups[name] = await maintenance[delegate].findMany({ where: { organisationId: 'v2-replay-org' }, orderBy: { id: 'asc' } });
    }
    return groups;
  };
  try {
    assert.deepEqual(await readRows(),originals);
    for(const mode of ['replica','local'])await assert.rejects(maintenance.$transaction(async tx=>{
      if(mode==='replica')await tx.$executeRaw`SET LOCAL session_replication_role='replica'`;
      else await tx.$executeRaw`SET LOCAL session_replication_role='local'`;
      await tx.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org')`;
    }),/origin replication role/);
    await assert.rejects(maintenance.$transaction(tx=>tx.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org')`,
      {isolationLevel:'RepeatableRead'}),/read-committed/);
    await assert.rejects(maintenance.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL synchronous_commit=off`;
      await tx.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org')`;}),/durable WAL/);
    for(const mode of ['disabled','wrong-event','wrong-function','unvalidated']) {
      await assert.rejects(maintenance.$transaction(async tx=>{
        if(mode==='disabled')await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionOutcome" DISABLE TRIGGER "ConfluenceCopyExecutionOutcome_guard"`;
        if(mode==='wrong-event'){
          await tx.$executeRaw`DROP TRIGGER "ConfluenceCopyExecutionOutcome_guard" ON public."ConfluenceCopyExecutionOutcome"`;
          await tx.$executeRaw`CREATE TRIGGER "ConfluenceCopyExecutionOutcome_guard" BEFORE UPDATE ON public."ConfluenceCopyExecutionOutcome"
            FOR EACH ROW EXECUTE FUNCTION public."ConfluenceCopyExecutionOutcome_guard_fn"()`;
        }
        if(mode==='wrong-function'){
          await tx.$executeRaw`CREATE FUNCTION public.synthetic_v2_wrong_guard() RETURNS trigger AS 'BEGIN RETURN NEW; END' LANGUAGE plpgsql`;
          await tx.$executeRaw`DROP TRIGGER "ConfluenceCopyExecutionOutcome_guard" ON public."ConfluenceCopyExecutionOutcome"`;
          await tx.$executeRaw`CREATE TRIGGER "ConfluenceCopyExecutionOutcome_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyExecutionOutcome"
            FOR EACH ROW EXECUTE FUNCTION public.synthetic_v2_wrong_guard()`;
        }
        if(mode==='unvalidated')await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionOutcome" ADD CONSTRAINT synthetic_v2_unvalidated CHECK (true) NOT VALID`;
        await tx.$queryRaw`SELECT public."ConfluenceExecutionV2Recovery_rows"('v2-replay-org')`;
      }),/exact enabled guards/);
    }
    const outsider=new PrismaClient({datasources:{db:{url:target.href}}});
    let acquired,release;
    const ready=new Promise(resolve=>{acquired=resolve;}),unblock=new Promise(resolve=>{release=resolve;});
    const blocked=outsider.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM public."Organisation" WHERE id='v2-replay-org' FOR UPDATE`;
      await tx.$executeRaw`LOCK TABLE public."ConfluenceCopyExecutionOutcome" IN SHARE MODE`;
      acquired();await unblock;
    },{timeout:15000});
    let timer;
    try {
      await Promise.race([ready,blocked.then(()=>{throw new Error("Synthetic blocker ended before acquisition");})]);
      await assert.rejects(Promise.race([readRows(),new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Synthetic blocked-client refusal exceeded deadline')),1500);
      })]),/exclusive maintenance client/);
    } finally {clearTimeout(timer);release();await blocked;await outsider.$disconnect();}
    assert.deepEqual(await readRows(),originals);
    const beforeTransport = await transportRows();
    // Disposable older-backup fixture only. No guard bypass reaches the replay.
    await maintenance.$transaction(async tx => {
      for (const [name,guard] of meta) await tx.$executeRaw(Prisma.raw(`ALTER TABLE public."${name}" DISABLE TRIGGER "${guard}"`));
      for (const [name] of [...meta].reverse()) await tx.$executeRaw(Prisma.sql`DELETE FROM public.${Prisma.raw(`"${name}"`)} WHERE "organisationId"=${'v2-replay-org'}`);
      for (const [name,guard] of meta) await tx.$executeRaw(Prisma.raw(`ALTER TABLE public."${name}" ENABLE TRIGGER "${guard}"`));
    });
    const empty = await readRows(); assert.ok(Object.values(empty).every(rows => rows.length===0));
    const beforeControl = structuredClone(current), beforeEntries = [...entries], beforeObjects = [...objects], beforeWrites = externalWrites;
    for (const failure of ['SQL','HEAD','ARCHIVE']) {
      const injected = { $queryRaw: maintenance.$queryRaw.bind(maintenance),
        $transaction: (fn,options) => maintenance.$transaction(async tx => fn({
          $executeRaw: tx.$executeRaw.bind(tx), $queryRaw: async (sql,...values) => {
            const result = await tx.$queryRaw(sql,...values);
            if (sql.join('?').includes('ConfluenceExecutionV2Recovery_replay')) {
              if (failure==='SQL') await tx.$executeRaw`SELECT 1/0`;
              else if(failure==='HEAD') current={...current,revision:'synthetic-head-race'};
              else objects.delete(saved.binding.context.operationId);
            }
            return result;
          },
        }),options) };
      await assert.rejects(replayConfluenceExecutionV2Rows(injected,'v2-replay-org',saved.binding,deps),/Confluence execution V2 maintenance replay is unresolved/);
      assert.deepEqual(await readRows(),empty,'late failure must roll back all eleven real record groups');
      current=structuredClone(beforeControl);objects.clear();for(const [key,value]of beforeObjects)objects.set(key,value); // Reset synthetic external fixture only.
    }
    let committedRestore;
    const unknownCommit = { $queryRaw: maintenance.$queryRaw.bind(maintenance), $transaction: async (fn,options) => {
      committedRestore = await maintenance.$transaction(fn,options); throw new Error('Synthetic acknowledgement lost AFTER real PostgreSQL commit');
    } };
    await assert.rejects(replayConfluenceExecutionV2Rows(unknownCommit,'v2-replay-org',saved.binding,deps),/Confluence execution V2 maintenance replay is unresolved/);
    await maintenance.$disconnect();maintenance=new PrismaClient({datasources:{db:{url:target.href}}});
    assert.equal(committedRestore.insertedRecords,Object.values(originals).reduce((count,rows) => count+rows.length,0));
    assert.deepEqual(await readRows(),originals,'unknown response must retain the actual committed eleven-table state');
    const originalCiphertext = objects.get(saved.binding.context.operationId);
    objects.delete(saved.binding.context.operationId);
    await assert.rejects(replayConfluenceExecutionV2Rows(maintenance,'v2-replay-org',saved.binding,deps),/Confluence execution V2 maintenance replay is unresolved/);
    assert.deepEqual(await readRows(),originals,'already restored rows do not substitute for independent archive evidence');
    objects.set(saved.binding.context.operationId,originalCiphertext); // Reset synthetic missing-object fixture, no provider create.
    const retry = await replayConfluenceExecutionV2Rows(maintenance,'v2-replay-org',saved.binding,deps);
    assert.equal(retry.insertedRecords,0); assert.equal(retry.replayed,true); assert.equal(retry.ledgerRowsReconciled,true);
    for (const flag of ['actionAuthorized','currentHistoryVerified','reopeningAuthorised','transportStateReconciled']) assert.equal(retry[flag],false);
    assert.deepEqual(await readRows(),originals);
    assert.deepEqual(current,beforeControl); assert.deepEqual([...entries],beforeEntries); assert.deepEqual([...objects],beforeObjects);
    assert.equal(externalWrites,beforeWrites);
    assert.equal((await maintenance.organisation.findUniqueOrThrow({ where: { id: 'v2-replay-org' } })).lifecycleStatus,'SUSPENDED');
    assert.equal(await maintenance.documentStorageDeletion.count(),0);
    assert.equal((await maintenance.document.findUniqueOrThrow({ where: { id: 'v2-replay-doc' } })).deletedAt,null);
    assert.deepEqual(await transportRows(),beforeTransport,'eleven-table replay must preserve all four transport groups without claiming reconciliation');
    const originalOutcome=originals.ConfluenceCopyExecutionOutcome[0];
    await maintenance.$transaction(async tx=>{
      await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionOutcome" DISABLE TRIGGER "ConfluenceCopyExecutionOutcome_guard"`;
      await tx.confluenceCopyExecutionOutcome.update({where:{id:originalOutcome.id},data:{recordedByDatabaseRole:'synthetic-conflicting-role'}});
      await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionOutcome" ENABLE TRIGGER "ConfluenceCopyExecutionOutcome_guard"`;
    });
    const conflicting=await readRows();await assert.rejects(replayConfluenceExecutionV2Rows(maintenance,'v2-replay-org',saved.binding,deps));
    assert.deepEqual(await readRows(),conflicting,'conflicting evidence must not be overwritten');
    await maintenance.$transaction(async tx=>{
      await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionOutcome" DISABLE TRIGGER "ConfluenceCopyExecutionOutcome_guard"`;
      await tx.confluenceCopyExecutionOutcome.update({where:{id:originalOutcome.id},data:{recordedByDatabaseRole:originalOutcome.recordedByDatabaseRole}});
      await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionOutcome" ENABLE TRIGGER "ConfluenceCopyExecutionOutcome_guard"`;
      await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionRequest" DISABLE TRIGGER "ConfluenceCopyExecutionRequest_guard"`;
      const original=await tx.confluenceCopyExecutionRequest.findUniqueOrThrow({where:{id:originals.ConfluenceCopyExecutionRequest[0].id}});
      await tx.confluenceCopyExecutionRequest.create({data:{...original,id:'v2-later-unarchived-request',requestKey:'v2-later-unarchived-key',action:'PURGE'}});
      await tx.$executeRaw`ALTER TABLE public."ConfluenceCopyExecutionRequest" ENABLE TRIGGER "ConfluenceCopyExecutionRequest_guard"`;
    });
    const later=await readRows();await assert.rejects(replayConfluenceExecutionV2Rows(maintenance,'v2-replay-org',saved.binding,deps));
    assert.deepEqual(await readRows(),later,'later unarchived evidence must never be deleted');
    assert.deepEqual(await transportRows(),beforeTransport);
    return { populatedGroups: 11, restoredRecords: committedRestore.insertedRecords, lateRollbacks: 3,
      unknownCommitRetryInserts: retry.insertedRecords, missingArchiveRetryRefused: true, transportGroupsPreserved: 4,invalidSessionsRefused:4,guardDriftRefused:4,secondClientRefused:true,lockHoldingClientRefusedWithoutWaiting:true,grantedRuntimeStillRefused:true,conflictingEvidencePreserved:true,laterEvidencePreserved:true };
  } finally { await maintenance.$disconnect(); }
}
