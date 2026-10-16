import assert from 'node:assert/strict';
import { runConfluenceExecutionV2StorePostgresProof } from './confluence-execution-v2-store-postgres-proof.mjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { captureConfluenceExecutionLedgerV2 } from '../apps/api/dist/services/confluence-execution-ledger-v2.js';
import { sealConfluenceExecutionArchiveV2,openConfluenceExecutionArchiveV2 } from '../apps/api/dist/services/confluence-execution-archive-v2.js';
import { recoveryContextFixture } from '../apps/api/dist/tests/fixtures/confluence-copy-recovery-facts.js';
import { ConfluenceCopyExecutionJournalService } from '../apps/api/dist/services/confluence-copy-execution-journal.js';
import { ConfluenceRetainedCopyPermissionService } from '../apps/api/dist/services/confluence-retained-copy-permission.service.js';
import { PURGE_RESTORE_SNAPSHOT_SQL, PURGE_RESTORE_BINDING_PROBE_SQL, assertPurgeRestoreLedger } from './purge-restore-reconciliation.mjs';

/** Joined only to the existing UUID-bound, disposable PostgreSQL proof. */
export async function runConfluenceExecutionJournalPostgresProof(prisma,url,claimId) {
  const target=new URL(url);
  assert.equal(target.hostname,'127.0.0.1');assert.equal(target.username,'postgres');
  assert.match(target.pathname,/^\/copy_ledger_[a-f0-9]{32}$/);
  const [identity]=await prisma.$queryRaw`SELECT current_database() AS name,current_user AS role`;
  assert.equal(identity.name,target.pathname.slice(1));assert.equal(identity.role,'postgres');
  const runtimeUrl=new URL(url);runtimeUrl.username='synthetic_ledger_runtime';runtimeUrl.password='synthetic-ledger-runtime-only';
  const runtime=new PrismaClient({datasources:{db:{url:runtimeUrl.toString()}}});
  const originalOwner=await prisma.user.findUniqueOrThrow({where:{id:'owner-a'}});
  const originalMember=await prisma.user.findUniqueOrThrow({where:{id:'member-a'}});
  const restoreOwner=async()=>prisma.$transaction(async tx=>{
    await tx.user.update({where:{id:'member-a'},data:{role:originalMember.role}});
    await tx.user.update({where:{id:'owner-a'},data:{role:originalOwner.role}});
  });
  const before=(await prisma.$queryRaw(Prisma.raw(PURGE_RESTORE_SNAPSHOT_SQL)))[0].snapshot;
  const input={claimId,requestKey:'journal-race-a',action:'TRASH',evidenceRef:'SYNTHETIC-JOURNAL',reason:'Synthetic quarantined request intent; no provider dispatch'};
  try {
    const service=new ConfluenceCopyExecutionJournalService(runtime);
    const raced=await Promise.allSettled([service.prepare('org-a','owner-a',input),service.prepare('org-a','owner-a',{...input,requestKey:'journal-race-b'})]);
    assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);
    const request=await prisma.confluenceCopyExecutionRequest.findFirstOrThrow({where:{claimId}});
    assert.equal(request.phase,'QUARANTINED');assert.equal(request.providerIOAuthorised,false);
    assert.equal(await prisma.confluenceCopyExecutionRequest.count({where:{claimId}}),1);
    const raw={...input,organisationId:'org-a',actorUserId:'owner-a',action:'PURGE',requestKey:'journal-refused'};
    await assert.rejects(runtime.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL synchronous_commit=off`;
      await tx.confluenceCopyExecutionRequest.create({data:raw});
    }),/durable WAL/);
    await assert.rejects(runtime.$transaction(async tx=>{
      await tx.confluenceCopyExecutionRequest.create({data:raw});
    },{isolationLevel:'RepeatableRead'}),/Read Committed/);
    await assert.rejects(runtime.$transaction(async tx=>{
      await tx.document.update({where:{id:'doc-a'},data:{deletionHold:true}});
      await tx.confluenceCopyExecutionRequest.create({data:raw});
    }));
    await assert.rejects(runtime.$transaction(async tx=>{
      await tx.organisationIntegration.update({where:{organisationId_provider:{organisationId:'org-a',provider:'CONFLUENCE'}},data:{connectedAt:new Date()}});
      await tx.confluenceCopyExecutionRequest.create({data:raw});
    }),/current exact unwithdrawn authority/);
    for (const [org,actor] of [['org-a','member-a'],['org-b','owner-a']]) {
      await assert.rejects(service.prepare(org,actor,{...input,action:'PURGE',requestKey:'journal-foreign'}));
      await assert.rejects(service.receipt(org,actor,request.requestKey));
    }
    await assert.rejects(runtime.confluenceCopyExecutionRequest.create({data:{...raw,providerIOAuthorised:true}}));
    // A second exact claim exercises acknowledgement loss AFTER real commit.
    const second=await prisma.confluenceCopyExecutionClaim.findFirstOrThrow({where:{id:{not:claimId},organisationId:'org-a'}});
    let lostId;
    const lostClient={confluenceCopyExecutionRequest:{create:async args=>{
      const row=await runtime.confluenceCopyExecutionRequest.create(args);lostId=row.id;
      throw new Error('PRIVATE-JOURNAL-RESPONSE-LOST');
    }}};
    await assert.rejects(new ConfluenceCopyExecutionJournalService(lostClient).prepare('org-a','owner-a',{
      ...input,claimId:second.id,requestKey:'journal-response-lost'}),error=>{
      assert.equal(error.code,'CONFLUENCE_COPY_EXECUTION_JOURNAL_UNRESOLVED');assert.equal(String(error).includes('PRIVATE-JOURNAL'),false);return true;
    });
    assert.ok(lostId);
    const replacement=new PrismaClient({datasources:{db:{url:runtimeUrl.toString()}}});
    try {
      const restarted=new ConfluenceCopyExecutionJournalService(replacement);
      assert.equal((await restarted.receipt('org-a','owner-a','journal-response-lost')).request.id,lostId);
      await assert.rejects(restarted.prepare('org-a','owner-a',{...input,claimId:second.id,requestKey:'journal-new-key'}));
    } finally {await replacement.$disconnect();}
    // Withdrawal and demotion cannot make the already-prepared report disappear.
    const claim=await prisma.confluenceCopyExecutionClaim.findUniqueOrThrow({where:{id:claimId}});
    await new ConfluenceRetainedCopyPermissionService(runtime).withdraw('org-a','owner-a',claim.permissionId,{
      evidenceRef:'SYNTHETIC-JOURNAL-WITHDRAW',reason:'Withdraw synthetic permission before recording an unresolved report'});
    await assert.rejects(service.prepare('org-a','owner-a',{...input,action:'PURGE',requestKey:'journal-after-withdrawal'}));
    await prisma.$transaction(async tx=>{
      await tx.user.update({where:{id:'owner-a'},data:{role:'MEMBER'}});
      await tx.user.update({where:{id:'member-a'},data:{role:'OWNER'}});
    });
    const outcome={requestId:request.id,requestOutcome:'UNRESOLVED',automaticRetryAllowed:false,providerAbsenceVerified:false,allCopiesVerified:false};
    let outcomeId;
    const lostOutcome={confluenceCopyExecutionOutcome:{create:async args=>{
      const row=await runtime.confluenceCopyExecutionOutcome.create(args);outcomeId=row.id;throw new Error('PRIVATE-JOURNAL-OUTCOME-LOST');
    }}};
    await assert.rejects(new ConfluenceCopyExecutionJournalService(lostOutcome).recordOutcome('org-a',outcome),error=>{
      assert.equal(error.code,'CONFLUENCE_COPY_EXECUTION_JOURNAL_UNRESOLVED');assert.equal(String(error).includes('PRIVATE-JOURNAL'),false);return true;
    });
    assert.ok(outcomeId);
    await assert.rejects(service.recordOutcome('org-a',outcome));
    await assert.rejects(service.receipt('org-a','owner-a',request.requestKey));
    await restoreOwner();
    const restarted=new PrismaClient({datasources:{db:{url:runtimeUrl.toString()}}});
    try {
      const receipt=await new ConfluenceCopyExecutionJournalService(restarted).receipt('org-a','owner-a',request.requestKey);
      assert.equal(receipt.request.outcome.id,outcomeId);assert.equal(receipt.request.outcome.requestOutcome,'UNRESOLVED');
      assert.equal(receipt.request.outcome.automaticRetryAllowed,false);assert.equal(receipt.absenceProvesFailure,false);
    } finally {await restarted.$disconnect();}
    const persisted=await prisma.confluenceCopyExecutionOutcome.findUniqueOrThrow({where:{requestId:request.id}});
    assert.equal(persisted.recordedByDatabaseRole,'synthetic_ledger_runtime');assert.equal(persisted.reportingBasis,'APPLICATION_REPORT');
    assert.equal(persisted.providerIOAuthorised,false);assert.equal(persisted.providerAbsenceVerified,false);assert.equal(persisted.allCopiesVerified,false);
    await assert.rejects(runtime.confluenceCopyExecutionOutcome.create({data:{...outcome,organisationId:'org-b',requestId:lostId}}),/exact tenant request/);
    for (const property of ['automaticRetryAllowed','providerAbsenceVerified','allCopiesVerified','providerIOAuthorised']) {
      await assert.rejects(runtime.confluenceCopyExecutionOutcome.create({data:{...outcome,requestId:lostId,organisationId:'org-a',[property]:true}}));
    }
    const acknowledged=await runtime.confluenceCopyExecutionOutcome.create({data:{...outcome,requestId:lostId,
      organisationId:'org-a',requestOutcome:'ACKNOWLEDGED',recordedByDatabaseRole:'FORGED-EXTERNAL-AUTHORITY'}});
    assert.equal(acknowledged.recordedByDatabaseRole,'synthetic_ledger_runtime');
    assert.equal(acknowledged.reportingBasis,'APPLICATION_REPORT');assert.equal(acknowledged.providerAbsenceVerified,false);
    assert.equal(acknowledged.allCopiesVerified,false);assert.equal(acknowledged.automaticRetryAllowed,false);
    for (const [model,id] of [[runtime.confluenceCopyExecutionRequest,request.id],[runtime.confluenceCopyExecutionOutcome,outcomeId]]) {
      await assert.rejects(model.update({where:{id},data:{id}}),/append-only/);
      await assert.rejects(model.delete({where:{id}}),/append-only/);
    }
    await assert.rejects(prisma.$executeRaw`TRUNCATE public."ConfluenceCopyExecutionOutcome"`,/append-only/);
    await assert.rejects(prisma.$executeRaw`TRUNCATE public."ConfluenceCopyExecutionRequest",public."ConfluenceCopyExecutionOutcome"`,/append-only/);
    const after=(await prisma.$queryRaw(Prisma.raw(PURGE_RESTORE_SNAPSHOT_SQL)))[0].snapshot;
    assert.equal(after.format,15);assert.equal(assertPurgeRestoreLedger(after,after).confluenceExecutionJournalCompared,true);
    assert.throws(()=>assertPurgeRestoreLedger(after,before),{code:'PURGE_RESTORE_RECONCILIATION_REQUIRED'});
    assert.equal(Object.values((await prisma.$queryRaw(Prisma.raw(PURGE_RESTORE_BINDING_PROBE_SQL)))[0])[0],'confluence-journal');
    await assert.rejects(prisma.$transaction(async tx=>{
      await tx.$executeRaw`DROP TABLE public."ConfluenceCopyExecutionOutcome"`;
      assert.equal(Object.values((await tx.$queryRaw(Prisma.raw(PURGE_RESTORE_BINDING_PROBE_SQL)))[0])[0],'partial-confluence');
      throw new Error('SYNTHETIC-PARTIAL-SCHEMA-ROLLBACK');
    }),/SYNTHETIC-PARTIAL-SCHEMA-ROLLBACK/);
    assert.equal(await prisma.confluenceCopyExecutionOutcome.count({where:{organisationId:'org-a'}}),2);
    const sourceBinding=await prisma.confluenceCopyRecoveryCapture.findFirstOrThrow({where:{organisationId:'org-a'}});
    const context={...recoveryContextFixture,installationId:sourceBinding.installationId,sourceRevision:sourceBinding.sourceRevision,
      writerEpoch:sourceBinding.writerEpoch,operationId:'native-execution-v2'};
    let captureIsolation;
    const inspected={$transaction:(fn,options)=>runtime.$transaction(async tx=>{
      const [isolation]=await tx.$queryRaw`SHOW transaction_isolation`;
      captureIsolation=isolation.transaction_isolation;return fn(tx);
    },options)};
    const execution=await captureConfluenceExecutionLedgerV2(inspected,'org-a','owner-a',context);
    assert.equal(captureIsolation,'repeatable read');assert.equal(execution.executionHistoryIncluded,true);
    assert.equal(execution.currentHistoryVerified,false);assert.equal(execution.reopeningAuthorised,false);
    for(const [name,delegate]of [['ConfluenceCopyExecutionClaim',runtime.confluenceCopyExecutionClaim],
      ['ConfluenceCopyExecutionRequest',runtime.confluenceCopyExecutionRequest],['ConfluenceCopyExecutionOutcome',runtime.confluenceCopyExecutionOutcome]]) {
      const rows=await delegate.findMany({where:{organisationId:'org-a'},orderBy:{id:'asc'}});
      assert.deepEqual(execution.ledger.tables[name],JSON.parse(JSON.stringify(rows)));
    }
    await assert.rejects(captureConfluenceExecutionLedgerV2(runtime,'org-a','member-a',context));
    await assert.rejects(captureConfluenceExecutionLedgerV2(runtime,'org-b','owner-a',context));
    const binding={context,observedControl:{format:2,installationId:context.installationId,organisationId:'org-a',
      writerId:'synthetic-writer',writerEpoch:context.writerEpoch,generation:0,digest:null,activeOperation:null,revision:'synthetic-only'}};
    const keys={generate:async supplied=>({key:Buffer.alloc(32,7),keyId:supplied.keyId,wrappedKey:'dGVzdA=='}),
      unwrap:async(_wrapped,supplied)=>({key:Buffer.alloc(32,7),keyId:supplied.keyId})};
    const encrypted=await sealConfluenceExecutionArchiveV2(execution.body,binding,keys);
    const opened=await openConfluenceExecutionArchiveV2(encrypted.envelope,binding,keys);
    assert.equal(opened.body,execution.body);assert.equal(opened.independentlyPreserved,false);
    const v2Persistence=await runConfluenceExecutionV2StorePostgresProof(prisma,runtime,url,context,binding.observedControl);
    return {v2Persistence,executionV2Groups:Object.keys(execution.ledger.tables).length,executionV2OriginalBytes:true,racingRequests:2,raceCommittedRequests:1,lostRequestReceipt:true,lostOutcomeReceipt:true,outcomeAfterRevocation:true,
      immutable:true,olderRestoreRefused:true,providerRequests:0};
  } finally {
    await restoreOwner();await runtime.$disconnect();
  }
}
