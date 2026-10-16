import {runConfluenceExecutionV2DispatchPostgresProof} from './confluence-execution-v2-dispatch-postgres-proof.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {ConfluenceExecutionV2CaptureStore,ConfluenceExecutionV2CandidateStore} from '../apps/api/dist/services/confluence-execution-v2-store.js';
import {ConfluenceCopyLedgerCandidateStore} from '../apps/api/dist/services/confluence-copy-ledger-candidate-store.js';

/** Only the existing UUID-bound disposable proof may call this fixture. */
export async function runConfluenceExecutionV2StorePostgresProof(prisma,runtime,url,context,observedControl) {
 const target=new URL(url);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.username,'postgres');
 assert.match(target.pathname,/^\/copy_ledger_[a-f0-9]{32}$/);
 const [database]=await prisma.$queryRaw`SELECT current_database() AS name,current_user AS role`;
 assert.equal(database.name,target.pathname.slice(1));assert.equal(database.role,'postgres');
 const [role]=await runtime.$queryRaw`SELECT current_database() AS name,current_user AS role`;
 assert.equal(role.name,database.name);assert.equal(role.role,'synthetic_ledger_runtime');
 const binding={context:{...context,operationId:'native-v2-durable'},observedControl};
 let lostCapture=true;
 const captureClient={$transaction:async(fn,options)=>{
  const result=await runtime.$transaction(fn,options);
  if(lostCapture){lostCapture=false;throw new Error('PRIVATE-V2-CAPTURE-ACK-LOST');}return result;
 }};
 await assert.rejects(new ConfluenceExecutionV2CaptureStore(captureClient).prepare('org-a','owner-a',binding),error=>{
  assert.match(String(error),/unresolved/);assert.equal(String(error).includes('PRIVATE-'),false);return true;
 });
 const original=await prisma.confluenceCopyLedgerCapture.findUniqueOrThrow({where:{organisationId_operationId:{organisationId:'org-a',operationId:binding.context.operationId}}});
 assert.equal(JSON.parse(original.facts).format,2);assert.equal(Object.keys(JSON.parse(original.facts).tables).length,11);
 const runtimeUrl=new URL(url);runtimeUrl.username='synthetic_ledger_runtime';runtimeUrl.password='synthetic-ledger-runtime-only';
 const replacement=new PrismaClient({datasources:{db:{url:runtimeUrl.toString()}}});
 let generations=0;
 const keys={generate:async supplied=>{generations++;return{key:Buffer.alloc(32,7),keyId:supplied.keyId,wrappedKey:'dGVzdA=='};},
  unwrap:async(_wrapped,supplied)=>({key:Buffer.alloc(32,7),keyId:supplied.keyId})};
 try {
  const resumed=await new ConfluenceExecutionV2CaptureStore(replacement).prepare('org-a','owner-a',binding);
  assert.equal(resumed.replayed,true);assert.equal(resumed.id,original.id);assert.equal(resumed.body,original.facts);
  for(const change of [{context:{...binding.context,sourceRevision:'b'.repeat(40)}},
   {observedControl:{...observedControl,revision:'different-original'}}]) {
   await assert.rejects(new ConfluenceExecutionV2CaptureStore(replacement).prepare('org-a','owner-a',{...binding,...change}));
  }
  let loseCandidate=true;
  const candidateClient={$transaction:async(fn,options)=>{
   const result=await runtime.$transaction(fn,options);
   if(loseCandidate&&result.candidate){loseCandidate=false;throw new Error('PRIVATE-V2-CANDIDATE-ACK-LOST');}return result;
  }};
  await assert.rejects(new ConfluenceExecutionV2CandidateStore(candidateClient).prepare('org-a','owner-a',original.id,keys),error=>{
   assert.match(String(error),/unresolved/);assert.equal(String(error).includes('PRIVATE-'),false);return true;
  });
  const candidate=await prisma.confluenceCopyLedgerCandidate.findUniqueOrThrow({where:{captureId:original.id}});
  const stable=await new ConfluenceExecutionV2CandidateStore(replacement).prepare('org-a','owner-a',original.id,keys);
  assert.equal(stable.replayed,true);assert.equal(stable.candidate.envelope,candidate.envelope);assert.equal(stable.original.body,original.facts);
  assert.equal(stable.durableCandidateRecorded,true);assert.equal(stable.independentlyPreserved,false);assert.equal(generations,1);
  assert.equal(await prisma.confluenceCopyLedgerCandidate.count({where:{captureId:original.id}}),1);
  await assert.rejects(new ConfluenceCopyLedgerCandidateStore(runtime).prepare('org-a','owner-a',original.id,keys));
  assert.equal(generations,1);
  for(const [org,actor]of [['org-a','member-a'],['org-b','owner-a']]) {
   await assert.rejects(new ConfluenceExecutionV2CaptureStore(runtime).prepare(org,actor,binding));
   await assert.rejects(new ConfluenceExecutionV2CandidateStore(runtime).prepare(org,actor,original.id,keys));
  }
  // Raw SQL cannot omit execution records from a supposedly complete V2 body.
  const operationId='native-v2-omitted-request',facts=JSON.parse(original.facts);
  facts.captureOperationId=operationId;facts.tables.ConfluenceCopyExecutionRequest=[];
  const changed=JSON.stringify(facts);
  await assert.rejects(runtime.$transaction(tx=>tx.confluenceCopyLedgerCapture.create({data:{...original,id:'native-v2-forged-capture',operationId,
   context:{...binding.context,operationId},facts:changed,factsDigest:createHash('sha256').update(changed).digest('hex')}}),
   {isolationLevel:'RepeatableRead'}),/complete current source rows/);
  // V1 ciphertext metadata cannot be relabelled as a V2 candidate.
  const forged=JSON.parse(candidate.envelope);forged.format=1;forged.kind='CONFLUENCE_COPY_LEDGER_ARCHIVE_V1';
  const envelope=JSON.stringify(forged);
  await assert.rejects(runtime.$transaction(tx=>tx.confluenceCopyLedgerCandidate.create({data:{...candidate,id:'native-v2-forged-candidate',
   envelope,envelopeDigest:createHash('sha256').update(envelope).digest('hex')}}),{isolationLevel:'RepeatableRead'}),/original envelope binding/);
  for(const [model,id]of [[runtime.confluenceCopyLedgerCapture,original.id],[runtime.confluenceCopyLedgerCandidate,candidate.id]]) {
   await assert.rejects(model.update({where:{id},data:{id}}),/append-only/);await assert.rejects(model.delete({where:{id}}),/append-only/);
  }
  const raceBinding={...binding,context:{...binding.context,operationId:'native-v2-ciphertext-race'}};
  const raceCapture=await new ConfluenceExecutionV2CaptureStore(runtime).prepare('org-a','owner-a',raceBinding);
  const races=await Promise.allSettled([new ConfluenceExecutionV2CandidateStore(runtime).prepare('org-a','owner-a',raceCapture.id,keys),
   new ConfluenceExecutionV2CandidateStore(replacement).prepare('org-a','owner-a',raceCapture.id,keys)]);
  assert.ok(races.some(result=>result.status==='fulfilled'));
  const winning=await prisma.confluenceCopyLedgerCandidate.findUniqueOrThrow({where:{captureId:raceCapture.id}});
  assert.equal(await prisma.confluenceCopyLedgerCandidate.count({where:{captureId:raceCapture.id}}),1);
  for(const result of races)if(result.status==='fulfilled')assert.equal(result.value.candidate.envelope,winning.envelope);
  const generated=generations;
  assert.equal((await new ConfluenceExecutionV2CandidateStore(replacement).prepare('org-a','owner-a',raceCapture.id,keys)).candidate.envelope,winning.envelope);
  assert.equal(generations,generated);
  // No external bytes are written if the Owner changes while obtaining a key.
  const revokedBinding={...binding,context:{...binding.context,operationId:'native-v2-revoked-during-key'}};
  const revoked=await new ConfluenceExecutionV2CaptureStore(runtime).prepare('org-a','owner-a',revokedBinding);
  const owner=await prisma.user.findUniqueOrThrow({where:{id:'owner-a'}}),member=await prisma.user.findUniqueOrThrow({where:{id:'member-a'}});
  let transferredDuringKey=false;
  try {
   const revokeKeys={...keys,generate:async supplied=>{
    const result=await keys.generate(supplied);
    await prisma.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL lock_timeout='500ms'`;await tx.user.update({where:{id:'owner-a'},data:{role:'MEMBER'}});await tx.user.update({where:{id:'member-a'},data:{role:'OWNER'}});});
    transferredDuringKey=true;
    return result;
   }};
   await assert.rejects(new ConfluenceExecutionV2CandidateStore(runtime).prepare('org-a','owner-a',revoked.id,revokeKeys));
   assert.equal(transferredDuringKey,true,'key generation must not hold Owner locks');
   assert.equal(await prisma.confluenceCopyLedgerCandidate.count({where:{captureId:revoked.id}}),0);
  } finally {
   await prisma.$transaction(async tx=>{await tx.user.update({where:{id:'member-a'},data:{role:member.role}});await tx.user.update({where:{id:'owner-a'},data:{role:owner.role}});});
  }
  const v2Dispatch=await runConfluenceExecutionV2DispatchPostgresProof(prisma,runtime,url,context);
  return{v2Dispatch,lostCaptureCommitReconciled:true,lostCandidateCommitReconciled:true,originalCiphertext:true,raceCommittedCandidates:1,retryKeyGenerations:0,
   sourceOmissionRefused:true,crossVersionRefused:true,revocationDuringKeyRefused:true,externalWrites:0};
 }finally{await replacement.$disconnect();}
}
