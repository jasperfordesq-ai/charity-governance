import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceExecutionV2CaptureStore,ConfluenceExecutionV2CandidateStore } from '../services/confluence-execution-v2-store.js';
import { CONFLUENCE_COPY_LEDGER_TABLES } from '../services/confluence-copy-ledger-snapshot.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
function fixture() {
 const input={context,observedControl:{format:2,installationId:context.installationId,organisationId:'org-a',writerId:'writer-a',
  writerEpoch:1,generation:0,digest:null,activeOperation:null,revision:'synthetic-original'}};
 const state={owner:true,active:true,reads:0,keys:0,loseCapture:false,loseCandidate:false,
  saved:null as null|Record<string,unknown>,candidate:null as null|Record<string,unknown>};
 const now=new Date('2026-10-16T12:00:00.000Z');
 const tx:Record<string,unknown>={
  $executeRaw:async()=>0,
  $queryRaw:async(query:TemplateStringsArray|{sql:string})=>Array.isArray(query)?[{now}]:
   ((query as {sql:string}).sql.includes('ConfluenceCopyExecutionClaim')?['ConfluenceCopyExecutionClaim','ConfluenceCopyExecutionRequest','ConfluenceCopyExecutionOutcome']:CONFLUENCE_COPY_LEDGER_TABLES).map(name=>({name,count:0n,bytes:0n})),
  user:{findFirst:async({where}:{where:{id:string;organisationId:string}})=>state.owner&&where.id==='owner-a'&&where.organisationId==='org-a'?{id:'owner-a'}:null},
  organisation:{findFirst:async()=>state.active?{id:'org-a'}:null},
  confluenceCopyLedgerCapture:{findUnique:async()=>structuredClone(state.saved),findFirst:async()=>structuredClone(state.saved),
   create:async({data}:{data:Record<string,unknown>})=>{state.saved={id:'capture-v2',...data,recordedAt:now};return structuredClone(state.saved);}},
  confluenceCopyLedgerCandidate:{findUnique:async()=>structuredClone(state.candidate),
   create:async({data}:{data:Record<string,unknown>})=>{assert.equal(state.candidate,null);state.candidate={id:'candidate-v2',...data,recordedAt:now};return structuredClone(state.candidate);}},
 };
 for(const name of ['confluenceRetainedCopyReview','confluenceRetainedCopyReviewWithdrawal','confluenceSyntheticCopyScope','confluenceRetainedCopyPermission',
  'confluenceRetainedCopyPermissionWithdrawal','confluenceCopyRecoveryCapture','confluenceCopyPublicationPlan','confluenceCopyPublicationReceipt',
  'confluenceCopyExecutionClaim','confluenceCopyExecutionRequest','confluenceCopyExecutionOutcome'])tx[name]={findMany:async()=>{state.reads++;return [];}};
 const prisma={$transaction:async<T>(fn:(client:typeof tx)=>Promise<T>,options:unknown)=>{
  assert.deepEqual(options,{isolationLevel:'RepeatableRead',maxWait:5000,timeout:30000});
  const saved=state.saved,candidate=state.candidate,result=await fn(tx);
  if(state.loseCapture&&state.saved!==saved){state.loseCapture=false;throw new Error('PRIVATE-CAPTURE-ACK');}
  if(state.loseCandidate&&state.candidate!==candidate){state.loseCandidate=false;throw new Error('PRIVATE-CANDIDATE-ACK');}return result;
 }};
 const keys:RecoveryDataKeys={generate:async supplied=>{state.keys++;return{key:Buffer.alloc(32,7),keyId:supplied.keyId,wrappedKey:'dGVzdA=='};},
  unwrap:async(_wrapped,supplied)=>({key:Buffer.alloc(32,7),keyId:supplied.keyId})};
 return{state,input,keys,capture:()=>new ConfluenceExecutionV2CaptureStore(prisma as never),candidate:()=>new ConfluenceExecutionV2CandidateStore(prisma as never)};
}
test('V2 persists one original capture and resumes a lost commit through a new service without recapturing',async()=>{
 const h=fixture();h.state.loseCapture=true;
 await assert.rejects(h.capture().prepare('org-a','owner-a',h.input),/unresolved/);
 const original=h.state.saved!.facts;
 const resumed=await h.capture().prepare('org-a','owner-a',h.input);
 assert.equal(resumed.body,original);assert.equal(resumed.replayed,true);assert.equal(h.state.reads,11);
 assert.equal(JSON.parse(resumed.body).format,2);assert.equal(resumed.durableCaptureRecorded,true);assert.equal(resumed.actionAuthorized,false);
 for(const changed of [{...h.input,context:{...context,sourceRevision:'b'.repeat(40)}},{...h.input,observedControl:{...h.input.observedControl,revision:'changed'}}])
  await assert.rejects(h.capture().prepare('org-a','owner-a',changed));
});
test('V2 encrypted candidate resumes original committed ciphertext without another key generation',async()=>{
 const h=fixture(),capture=await h.capture().prepare('org-a','owner-a',h.input);h.state.loseCandidate=true;
 await assert.rejects(h.candidate().prepare('org-a','owner-a',capture.id,h.keys),/unresolved/);
 const envelope=h.state.candidate!.envelope;
 const resumed=await h.candidate().prepare('org-a','owner-a',capture.id,h.keys);
 assert.equal(resumed.candidate.envelope,envelope);assert.equal(resumed.replayed,true);assert.equal(h.state.keys,1);
 assert.equal(resumed.durableCandidateRecorded,true);assert.equal(resumed.independentlyPreserved,false);
});
test('V2 refuses caller body overrides, inactive Owner, changed actor and revocation during key generation',async()=>{
 const h=fixture();await assert.rejects(h.capture().prepare('org-a','owner-a',{...h.input,facts:'PRIVATE-BODY'}));
 h.state.owner=false;await assert.rejects(h.capture().prepare('org-a','owner-a',h.input));h.state.owner=true;
 const capture=await h.capture().prepare('org-a','owner-a',h.input);
 await assert.rejects(h.candidate().prepare('org-a','other-owner',capture.id,h.keys));
 const keys={...h.keys,generate:async(supplied:typeof context)=>{const result=await h.keys.generate(supplied);h.state.owner=false;return result;}};
 await assert.rejects(h.candidate().prepare('org-a','owner-a',capture.id,keys));assert.equal(h.state.candidate,null);
});

test('corrupt original or committed ciphertext fails closed without recapture or new encryption',async()=>{
 for(const field of ['factsDigest','envelope']) {
  const h=fixture(),capture=await h.capture().prepare('org-a','owner-a',h.input);
  await h.candidate().prepare('org-a','owner-a',capture.id,h.keys);
  if(field==='factsDigest')h.state.saved![field]='0'.repeat(64);else h.state.candidate![field]='PRIVATE-CORRUPTED-ENVELOPE';
  await assert.rejects(h.candidate().prepare('org-a','owner-a',capture.id,h.keys),error=>{
   assert.equal(String(error).includes('PRIVATE-'),false);return true;
  });
  assert.equal(h.state.reads,11);assert.equal(h.state.keys,1);
 }
});
