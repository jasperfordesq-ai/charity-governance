import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {ConfluenceExecutionV2CaptureStore,ConfluenceExecutionV2CandidateStore} from '../apps/api/dist/services/confluence-execution-v2-store.js';
import {ConfluenceExecutionV2Dispatcher} from '../apps/api/dist/services/confluence-execution-v2-dispatcher.js';
import {ConfluenceExecutionV2ProgressStore} from '../apps/api/dist/services/confluence-execution-v2-progress-store.js';
import {RecoveryAuthorityJournal} from '../apps/api/dist/services/recovery-authority-journal.js';

/** Only the UUID-bound disposable parent proof may invoke this fixture. */
export async function runConfluenceExecutionV2DispatchPostgresProof(prisma,runtime,url,baseContext) {
 const target=new URL(url);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.username,'postgres');
 assert.match(target.pathname,/^\/copy_ledger_[a-f0-9]{32}$/);
 const [database]=await prisma.$queryRaw`SELECT current_database() AS name,current_user AS role`;
 assert.equal(database.name,target.pathname.slice(1));assert.equal(database.role,'postgres');
 const [role]=await runtime.$queryRaw`SELECT current_database() AS name,current_user AS role`;
 assert.equal(role.name,database.name);assert.equal(role.role,'synthetic_ledger_runtime');
 const runtimeUrl=new URL(url);runtimeUrl.username='synthetic_ledger_runtime';runtimeUrl.password='synthetic-ledger-runtime-only';
 const replacement=new PrismaClient({datasources:{db:{url:runtimeUrl.toString()}}});
 let fixtureNumber=0;
 async function fixture() {
  const n=++fixtureNumber,organisationId=`v2-dispatch-org-${n}`,actorUserId=`v2-dispatch-owner-${n}`,memberId=`v2-dispatch-member-${n}`;
  await prisma.$transaction(async tx=>{
   await tx.organisation.create({data:{id:organisationId,name:'Synthetic V2 metadata history'}});
   await tx.user.createMany({data:[{id:actorUserId,organisationId,role:'OWNER',name:'Synthetic Owner',email:`v2-owner-${n}@example.invalid`,passwordHash:'not-a-login'},
    {id:memberId,organisationId,role:'MEMBER',name:'Synthetic Member',email:`v2-member-${n}@example.invalid`,passwordHash:'not-a-login'}]});
  });
  const context={...baseContext,organisationId,operationId:`v2-native-dispatch-${n}`};
  const initial={format:2,installationId:context.installationId,organisationId,writerId:'synthetic-writer',writerEpoch:context.writerEpoch,
   generation:0,digest:null,activeOperation:null,revision:'synthetic-initial'};
  const state={current:structuredClone(initial),version:0,puts:0,releases:0,losePut:false,rejectPut:false,loseHead:false,loseRelease:false,loseEntry:false,
   revokeOnRead:false,externalReads:0};
  let generations=0,envelope=null;
  const keys={generate:async supplied=>{generations++;return{key:Buffer.alloc(32,7),keyId:supplied.keyId,wrappedKey:'dGVzdA=='};},
   unwrap:async(_wrapped,supplied)=>({key:Buffer.alloc(32,7),keyId:supplied.keyId})};
  const capture=await new ConfluenceExecutionV2CaptureStore(runtime).prepare(organisationId,actorUserId,{context,observedControl:initial});
  const candidate=await new ConfluenceExecutionV2CandidateStore(runtime).prepare(organisationId,actorUserId,capture.id,keys);
  assert.equal(Object.keys(JSON.parse(capture.body).tables).length,11);
  const rows=new Map(),journal=new RecoveryAuthorityJournal({read:async key=>rows.get(key)??null,
   create:async(key,body)=>{if(rows.has(key))return false;rows.set(key,body);if(state.loseEntry){state.loseEntry=false;throw new Error('PRIVATE-ENTRY-LOST');}return true;}},
   {installationId:context.installationId,organisationId},{installationId:context.installationId,organisationId,generation:0,digest:null});
  const control={readControl:async()=>structuredClone(state.current),compareAndSwapControl:async(revision,next)=>{
   if(revision!==state.current.revision)return false;
   const published=next.generation>state.current.generation;
   state.current={...next,revision:`synthetic-version-${++state.version}`};
   if(published&&state.loseHead){state.loseHead=false;throw new Error('PRIVATE-HEAD-LOST');}return true;
  },releaseConfluenceExecutionV2Control:async(revision,expected)=>{
   if(revision!==state.current.revision)return false;
   assert.equal(expected.operationId,context.operationId);assert.equal(expected.preparationDigest,capture.digest);
   assert.equal(expected.envelopeDigest,candidate.candidate.digest);assert.equal(expected.digest,state.current.digest);
   assert.equal(state.current.activeOperation?.operationId,context.operationId);
   state.current={...state.current,activeOperation:null,revision:`synthetic-version-${++state.version}`};state.releases++;
   if(state.loseRelease){state.loseRelease=false;throw new Error('PRIVATE-RELEASE-LOST');}return true;
  }};
  const objects={readExecutionLedgerV2:async()=>{
   state.externalReads++;
   if(state.revokeOnRead){state.revokeOnRead=false;
    await prisma.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL lock_timeout='500ms'`;
     await tx.user.update({where:{id:actorUserId},data:{role:'MEMBER'}});await tx.user.update({where:{id:memberId},data:{role:'OWNER'}});});
   }return envelope;
  },readExecutionLedgerV2At:async()=>envelope,readConfluenceCopyStateHistory:async()=>null,readConfluenceCopyLedgerHistory:async()=>null,
   createExecutionLedgerV2:async(supplied,bytes)=>{
    assert.deepEqual(supplied,context);assert.equal(bytes,candidate.candidate.envelope);state.puts++;
    if(state.rejectPut)throw new Error('PRIVATE-PUT-UNKNOWN');
    if(envelope!==null)return false;envelope=bytes;
    if(state.losePut){state.losePut=false;throw new Error('PRIVATE-PUT-LOST');}return true;
   }};
  const deps={journal,control,objects,policy:[{writerEpoch:context.writerEpoch,writerId:initial.writerId,keyIds:[context.keyId]}],
   keys:{...keys,generate:async()=>{throw new Error('Dispatch must never generate a key');}}};
  const resume=(client=runtime)=>new ConfluenceExecutionV2Dispatcher(client).resume(organisationId,actorUserId,candidate.id,deps);
  return{organisationId,actorUserId,memberId,capture,candidate,state,deps,resume,clearObject:()=>{envelope=null;},generations:()=>generations};
 }
 try {
  const happy=await fixture();await happy.resume();await happy.resume(replacement);
  assert.equal(happy.state.puts,1);assert.equal(happy.state.releases,1);assert.equal(happy.generations(),1);
  const progress=await prisma.confluenceCopyLedgerProgress.findMany({where:{candidateId:happy.candidate.id},orderBy:{recordedAt:'asc'}});
  assert.deepEqual(progress.map(row=>row.stage),['PUBLISHED','ACKNOWLEDGED']);
  assert.equal(await prisma.confluenceCopyLedgerUploadAttempt.count({where:{candidateId:happy.candidate.id}}),1);
  for(const row of progress){await assert.rejects(runtime.confluenceCopyLedgerProgress.update({where:{id:row.id},data:{id:row.id}}),/append-only/);}
  const attempt=await prisma.confluenceCopyLedgerUploadAttempt.findUniqueOrThrow({where:{candidateId:happy.candidate.id}});
  await assert.rejects(runtime.confluenceCopyLedgerUploadAttempt.update({where:{id:attempt.id},data:{id:attempt.id}}),/append-only/);
  await assert.rejects(new ConfluenceExecutionV2Dispatcher(runtime).resume(happy.organisationId,happy.memberId,happy.candidate.id,happy.deps));
  await assert.rejects(new ConfluenceExecutionV2ProgressStore(runtime).observe('org-b',happy.actorUserId,happy.candidate.id,'PUBLISHED',happy.deps));
  happy.clearObject();await assert.rejects(happy.resume(replacement));assert.equal(happy.state.puts,1);
  for(const failure of ['losePut','loseEntry','loseHead','loseRelease']) {
   const h=await fixture();h.state[failure]=true;await assert.rejects(h.resume());await h.resume(replacement);
   assert.equal(h.state.puts,1);assert.equal(h.state.releases,1);assert.equal(h.generations(),1);
   assert.equal(await prisma.confluenceCopyLedgerProgress.count({where:{candidateId:h.candidate.id}}),2);
  }
  const lost=await fixture();let armed=true;
  const lostClient={$transaction:async(fn,options)=>{const result=await runtime.$transaction(fn,options);
   if(armed&&result===true){armed=false;throw new Error('PRIVATE-COMMITTED-ATTEMPT-LOST');}return result;}};
  await assert.rejects(lost.resume(lostClient));assert.equal(armed,false);
  assert.equal(await prisma.confluenceCopyLedgerUploadAttempt.count({where:{candidateId:lost.candidate.id}}),1);
  await assert.rejects(lost.resume(replacement));assert.equal(lost.state.puts,0);assert.equal(lost.state.releases,0);
  const unknown=await fixture();unknown.state.rejectPut=true;await assert.rejects(unknown.resume());unknown.state.rejectPut=false;
  await assert.rejects(unknown.resume(replacement));assert.equal(unknown.state.puts,1);assert.equal(unknown.state.releases,0);
  for(const stage of ['PUBLISHED','ACKNOWLEDGED']) {
   const observed=await fixture();let loseProgress=true;
   const progressClient={$transaction:async(fn,options)=>{const result=await runtime.$transaction(fn,options);
    if(loseProgress&&result?.stage===stage){loseProgress=false;throw new Error('PRIVATE-COMMITTED-PROGRESS-LOST');}return result;}};
   await assert.rejects(observed.resume(progressClient));assert.equal(loseProgress,false);
   assert.equal(await prisma.confluenceCopyLedgerProgress.count({where:{candidateId:observed.candidate.id,stage}}),1);
   await observed.resume(replacement);assert.equal(observed.state.puts,1);assert.equal(observed.state.releases,1);
   assert.equal(await prisma.confluenceCopyLedgerProgress.count({where:{candidateId:observed.candidate.id}}),2);
  }
  const race=await fixture();await Promise.allSettled([race.resume(),race.resume(replacement)]);await race.resume(replacement);
  assert.equal(race.state.puts,1);assert.equal(race.state.releases,1);
  assert.equal(await prisma.confluenceCopyLedgerUploadAttempt.count({where:{candidateId:race.candidate.id}}),1);
  const revoked=await fixture();revoked.state.revokeOnRead=true;await assert.rejects(revoked.resume());
  assert.equal(revoked.state.puts,0);assert.equal(revoked.state.releases,0);
  assert.equal((await prisma.user.findUniqueOrThrow({where:{id:revoked.actorUserId}})).role,'MEMBER');
  assert.equal(await prisma.confluenceCopyLedgerUploadAttempt.count({where:{candidateId:revoked.candidate.id}}),1);
  await assert.rejects(new ConfluenceExecutionV2ProgressStore(runtime).observe(revoked.organisationId,revoked.actorUserId,revoked.candidate.id,'PUBLISHED',revoked.deps));
  return{metadataOnly:true,sourceGroups:11,sourceGroupsInitiallyEmpty:true,realSqlProgress:true,lostAttemptCommitQuarantined:true,
   unknownUploadNeverRetried:true,lostPublicationCommitReconciled:true,lostAcknowledgementCommitReconciled:true,lostReleaseReconciled:true,racingAttempts:1,
   ownerChangeDuringIORefused:true,providerContentRequests:0};
 }finally{await replacement.$disconnect();}
}
