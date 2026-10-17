import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {ManagedProofJobCustody} from '../services/managed-proof-job-custody.js';
import {jobScope} from '../services/managed-proof-job-contract.js';
import {backend,config,credentials} from './fixtures/archived-custody.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const b=backend(),client=b.s3(),storage={installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,kmsKeyArn:config.storageKeyArn};
 const binding={format:3 as const,kind:'MANAGED_QUARANTINED_COMMON_CAPTURE_V3' as const,installationId:config.installationId,sourceSha:'1'.repeat(40),maintenanceEpoch:1,
  candidateId:randomUUID(),attemptId:randomUUID(),controlRevision:'2'.repeat(64),captureConfigurationDigest:'3'.repeat(64),metadataWindowConfigurationDigest:'4'.repeat(64),journalConfigurationDigest:'5'.repeat(64),archiveConfigurationDigest:'6'.repeat(64),planDigest:'7'.repeat(64)};
 const original={kind:'BASELINE' as const,versionId:'original-candidate-request',sha256:'8'.repeat(64),byteLength:100};let live=true;
 const create=()=>new ManagedProofJobCustody(storage,binding,credentials,client,p=>live&&JSON.stringify(p)===JSON.stringify(original));
 const request={format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_V1',jobId:randomUUID(),scope:jobScope(binding,original),sourceSha:binding.sourceSha,
  workspaceDigest:'a'.repeat(64),snapshotDigest:'b'.repeat(64),argumentsDigest:'c'.repeat(64),createdAt:new Date().toISOString(),state:'REQUESTED_ONLY',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false};
 const local=(v:unknown)=>{const body=JSON.stringify(v);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
 const input=local(request),pin={sha256:input.sha256,byteLength:input.byteLength};
 const observation=(change={})=>local({format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_OBSERVATION_V1',jobId:request.jobId,requestPin:pin,state:'WORKER_EXIT_ACK_OBSERVED',jobContainersObservedAbsent:true,executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false,...change});
 const session=create();return{b,client,binding,original,request,input,observation,session,create,local,setLive(v:boolean){live=v;},close(){client.destroy();b.close();}};
}
test('original request ACK gates job write; exact immutable request/result discovery grants no execution',async()=>{
 const f=fixture();try{
  f.setLive(false);await assert.rejects(f.session.reserve(f.input,f.original));assert.equal(f.b.writes,0);
  f.setLive(true);await f.session.reserve(f.input,f.original);await f.session.observe(f.observation(),f.original);
  const writes=f.b.writes;f.setLive(false);const found=await f.create().discover(f.original);
  assert.equal(found.jobId,f.request.jobId);assert.equal(found.state,'WORKER_EXIT_ACK_OBSERVED');assert.equal(found.originalAcknowledgementReconstructed,false);assert.equal(found.executionAuthorized,false);assert.equal(found.publicationAuthorized,false);
  assert.equal(f.b.writes,writes);assert.equal(f.b.generates,0);await assert.rejects(f.create().reserve(f.input,f.original));assert.equal(f.b.writes,writes);
 }finally{f.close();}
});
test('lost descriptor readback ACK leaves discoverable requested-only job without a worker lease',async()=>{
 const f=fixture();try{
  f.b.loseJobRequestRead=true;await assert.rejects(f.session.reserve(f.input,f.original));assert.equal(f.b.objects.size,1);
  await assert.rejects(f.session.observe(f.observation(),f.original));f.b.loseJobRequestRead=false;f.setLive(false);
  const writes=f.b.writes,found=await f.create().discover(f.original);assert.equal(found.jobId,f.request.jobId);assert.equal(found.state,'REQUESTED_ONLY');assert.equal(found.observationPin,null);
  assert.equal(found.reportStatus,'NOT_LISTED_AT_BOUNDARY');assert.equal(found.savedObservationAuthorizesExecution,false);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});
test('lost observation ACK is independently observable and never reconstructed as execution permission',async()=>{
 const f=fixture();try{
  await f.session.reserve(f.input,f.original);f.b.loseJobObservationRead=true;await assert.rejects(f.session.observe(f.observation(),f.original));
  f.b.loseJobObservationRead=false;f.setLive(false);const writes=f.b.writes,found=await f.create().discover(f.original);
  assert.equal(found.state,'WORKER_EXIT_ACK_OBSERVED');assert.equal(found.originalAcknowledgementReconstructed,false);assert.equal(found.executionAuthorized,false);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});
test('request scope, release, bytes and extra secret fields refuse before storage',async()=>{
 for(const change of [{scope:{kind:'COMMON_CANDIDATE',bindingDigest:'0'.repeat(64),requestPinDigest:'0'.repeat(64),sourceSha:'1'.repeat(40)}},
  {sourceSha:'9'.repeat(40)},{executionAuthorized:true},{databaseUrl:'private-secret'}]){
  const f=fixture();try{await assert.rejects(f.session.reserve(f.local({...f.request,...change}),f.original));assert.equal(f.b.writes,0);}finally{f.close();}
 }
 const f=fixture();try{await assert.rejects(f.session.reserve({...f.input,sha256:'0'.repeat(64)},f.original));assert.equal(f.b.writes,0);}finally{f.close();}
});
test('different job/result baseline and repeated outcomes cannot replace original observations',async()=>{
 const f=fixture();try{
  await f.session.reserve(f.input,f.original);const writes=f.b.writes;
  await assert.rejects(f.session.observe(f.observation({jobId:randomUUID()}),f.original));assert.equal(f.b.writes,writes);
  await assert.rejects(f.session.observe(f.observation(),f.original));assert.equal(f.b.writes,writes);
  f.session.closeExecution();await assert.rejects(f.session.observe(f.observation(),f.original));
 }finally{f.close();}
});
test('unexpected job catalogue objects and changed original request pins fail discovery',async()=>{
 const f=fixture();try{
  await f.session.reserve(f.input,f.original);await assert.rejects(f.create().discover({...f.original,versionId:'substituted'}));
  const [key,value]=[...f.b.objects][0]!;f.b.objects.set(key.replace('baseline.json','unexpected.json'),value);
  await assert.rejects(f.create().discover(f.original));
 }finally{f.close();}
});
