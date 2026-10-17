import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {ManagedProofJobCustody} from '../services/managed-proof-job-custody.js';
import {jobScope,jobServiceScope,jobRequestArtifact,jobServiceArtifact} from '../services/managed-proof-job-contract.js';
import {ManagedDaemonIntentCustody,daemonCustodyScope} from '../services/managed-daemon-intent-custody.js';
import {GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
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
function service(f:ReturnType<typeof fixture>,change={},identityChange={}){
 return f.local({format:1,kind:'MANAGED_IMPORTED_PROOF_SERVICE_V1',jobId:f.request.jobId,requestPin:{sha256:f.input.sha256,byteLength:f.input.byteLength},
  identity:{format:1,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V1',jobId:f.request.jobId,unit:`charitypilot-containment-${f.request.jobId}.service`,invocationId:'a'.repeat(32),uid:1000,mainPid:123,
   mainStartMonotonic:'123456',sourceSha:f.binding.sourceSha,inputDigest:'d'.repeat(64),executionAuthorized:false,actionAuthorized:false,...identityChange},
  executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false,...change});
}
test('version two service custody preserves original boot/group without granting execution',async()=>{
 const f=fixture();try{
  const next={format:2,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V2',bootId:'12345678-1234-1234-1234-123456789012',
   controlGroup:`/user.slice/user-1000.slice/user@1000.service/app.slice/charitypilot-containment-${f.request.jobId}.service`};
  await f.session.reserve(f.input,f.original);await f.session.bindService(service(f,{},next),f.original);
  const r=await f.create().discover(f.original);assert.equal(r.serviceIdentity?.format,2);
  assert.equal(r.serviceIdentity?.kind,'MANAGED_GUARDIAN_LIVE_BINDING_V2');assert.equal(r.executionAuthorized,false);
 }finally{f.close();}
 for(const controlGroup of ['/other','/user.slice/user-1000.slice/user@1000.service/../bad','/user.slice/user-2000.slice/user@2000.service/unrelated.service']){
  const g=fixture();try{await g.session.reserve(g.input,g.original);await assert.rejects(g.session.bindService(service(g,{},
   {format:2,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V2',bootId:'12345678-1234-1234-1234-123456789012',controlGroup}),g.original));}finally{g.close();}
 }
});

test('original descriptor ACK gates one exact service binding and fresh discovery is read-only',async()=>{
 const f=fixture();try{
  await assert.rejects(f.session.bindService(service(f),f.original));assert.equal(f.b.writes,0);
  await f.session.reserve(f.input,f.original);const saved=await f.session.bindService(service(f),f.original);await assert.rejects(f.session.bindService(service(f),f.original));
  f.session.closeExecution();f.setLive(false);const writes=f.b.writes,found=await f.create().discover(f.original);
  assert.equal(found.serviceStatus,'SAVED_SERVICE_BINDING');assert.equal(found.jobServicePin?.versionId,saved.pin.versionId);assert.equal(found.serviceIdentity?.invocationId,'a'.repeat(32));
  assert.equal(found.state,'REQUESTED_ONLY');assert.equal(found.executionAuthorized,false);assert.equal(found.originalAcknowledgementReconstructed,false);assert.equal(f.b.writes,writes);assert.equal(f.b.generates,0);
  await assert.rejects(f.session.bindService(service(f),f.original));await assert.rejects(f.create().bindService(service(f),f.original));
 }finally{f.close();}
});
test('unknown original service ACK remains discoverable without permission or a second attempt',async()=>{
 const f=fixture();try{
  await f.session.reserve(f.input,f.original);f.b.loseJobServiceRead=true;await assert.rejects(f.session.bindService(service(f),f.original));
  f.b.loseJobServiceRead=false;await assert.rejects(f.session.bindService(service(f),f.original));f.setLive(false);const writes=f.b.writes,found=await f.create().discover(f.original);
  assert.equal(found.serviceStatus,'SAVED_SERVICE_BINDING');assert.equal(found.state,'REQUESTED_ONLY');assert.equal(found.savedObservationAuthorizesExecution,false);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});
test('substituted service identity, local baseline, scope or secret fields refuse before storage',async()=>{
 for(const [change,identityChange] of [[{jobId:randomUUID()},{}],[{requestPin:{sha256:'0'.repeat(64),byteLength:1}},{}],[{rawSecret:'private-secret'},{}],
  [{},{sourceSha:'f'.repeat(40)}],[{},{jobId:randomUUID()}],[{},{unit:'unrelated.service'}],[{},{uid:0}],[{},{mainPid:0}],[{},{executionAuthorized:true}]] as const){
  const f=fixture();try{await f.session.reserve(f.input,f.original);const writes=f.b.writes;await assert.rejects(f.session.bindService(service(f,change,identityChange),f.original));
   assert.equal(f.b.writes,writes);await assert.rejects(f.session.bindService(service(f),f.original));
  }finally{f.close();}
 }
});
test('late service additions and unexpected service catalogue entries refuse rather than hide history',async()=>{
 const f=fixture();try{
  await f.session.reserve(f.input,f.original);await f.session.observe(f.observation(),f.original);await assert.rejects(f.session.bindService(service(f),f.original));
  const found=await f.create().discover(f.original);assert.equal(found.serviceStatus,'NOT_LISTED_AT_BOUNDARY');assert.equal(found.serviceIdentity,null);
 }finally{f.close();}
 const g=fixture();try{
  await g.session.reserve(g.input,g.original);await g.session.bindService(service(g),g.original);
  const prefix=`/capture-job/${jobServiceScope(g.binding.candidateId)}/`,[key,value]=[...g.b.objects].find(([k])=>k.includes(prefix))!;
  g.b.objects.set(key.replace('baseline.json','observation.json'),value);await assert.rejects(g.create().discover(g.original));
 }finally{g.close();}
});

async function daemonFixture(){
 const f=fixture(),request=await f.session.reserve(f.input,f.original);
 const localService=service(f,{}, {format:2,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V2',bootId:'12345678-1234-1234-1234-123456789012',
  controlGroup:`/user.slice/user-1000.slice/user@1000.service/app.slice/charitypilot-containment-${f.request.jobId}.service`});
 const bound=await f.session.bindService(localService,f.original);
 const image='postgres@sha256:'+'1'.repeat(64);
 const header=f.local({format:2,kind:'MANAGED_DAEMON_REQUEST_HEADER_V2',jobId:f.request.jobId,inputDigest:'d'.repeat(64),image,imageVolumeTargets:['/var/lib/postgresql/data']});
 const intent=(sequence=1,previousDigest=header.sha256,change={})=>f.local({format:2,kind:'MANAGED_DAEMON_REQUEST_INTENT_V2',jobId:f.request.jobId,sequence,previousDigest,
  operation:'run',target:'charitypilot-source-snapshot-123-456-abcdef12',storagePlan:{format:2,kind:'MANAGED_PROOF_STORAGE_PLAN_V2',image,
   mounts:[{target:'/var/lib/postgresql/data',type:'tmpfs',readOnly:false,tmpfsOptions:'rw,noexec,nosuid,size=1m'}],declaredImageVolumesCovered:true},argumentsDigest:'e'.repeat(64),...change});
 const custody=(live=()=>false)=>new ManagedDaemonIntentCustody({installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,kmsKeyArn:config.storageKeyArn},f.binding,credentials,f.client,
  jobRequestArtifact(f.binding,f.original,f.input),request.pin,jobServiceArtifact(f.binding,request.pin,localService),bound.pin,live);
 const reader=()=>custody();
 return{...f,header,intent,reader,custody};
}

test('original daemon responses are retained against exact intents and fresh reads confer no resolution',async()=>{
 const f=await daemonFixture();try{
  let live=true;const writer=f.custody(()=>live),local=f.intent();
  await writer.reserveHeader(f.header);await writer.reserveIntent(local);
  const value=f.local({format:1,kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId:f.request.jobId,sequence:1,
   intentPin:{sha256:local.sha256,byteLength:local.byteLength},status:0,transportError:false,signal:false,removalAlreadyAbsent:false});
  const ack=await writer.observeResponse(value);assert.equal(ack.pin.kind,'OBSERVATION');assert.equal(ack.pendingRequestResolved,false);
  const writes=f.b.writes;live=false;
  const read=await f.reader().inspectResponse(1,f.header.sha256);
  assert.equal(read.localRecord.sha256,value.sha256);assert.equal(read.originalAcknowledgementReconstructed,false);
  assert.equal(read.pendingRequestResolved,false);assert.equal(read.savedEvidenceAuthorizesDispatch,false);assert.equal(f.b.writes,writes);
  await assert.rejects(writer.observeResponse(value));await assert.rejects(f.reader().observeResponse(value));
 }finally{f.close();}
});

test('response custody rejects mismatched intent, secret fields and invalid absent-container claims before writes',async()=>{
 for(const change of [{intentPin:{sha256:'0'.repeat(64),byteLength:1}},{stderr:'SYNTHETIC_SECRET'},{removalAlreadyAbsent:true,status:1},
  {sequence:2},{jobId:randomUUID()}]){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);
   const value=f.local({format:1,kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId:f.request.jobId,sequence:1,
    intentPin:{sha256:local.sha256,byteLength:local.byteLength},status:0,transportError:false,signal:false,removalAlreadyAbsent:false,...change});
   const writes=f.b.writes;await assert.rejects(writer.observeResponse(value));await assert.rejects(writer.reserveIntent(f.intent(2,local.sha256)));
   assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('lost response readback consumes the original writer while saved evidence remains inspectable',async()=>{
 const f=await daemonFixture();try{
  const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);
  const value=f.local({format:1,kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId:f.request.jobId,sequence:1,
   intentPin:{sha256:local.sha256,byteLength:local.byteLength},status:null,transportError:true,signal:false,removalAlreadyAbsent:false});
  const original=f.client.send.bind(f.client);let lost=true;
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
   if(lost&&command instanceof GetObjectCommand&&command.input.Key?.endsWith('/observation.json'))throw new Error('synthetic response ACK loss');
   return original(command as never);
  });
  await assert.rejects(writer.observeResponse(value));const writes=f.b.writes;
  await assert.rejects(writer.observeResponse(value));await assert.rejects(writer.reserveIntent(f.intent(2,local.sha256)));
  lost=false;const saved=await f.reader().inspectResponse(1,f.header.sha256);
  assert.equal(saved.pendingRequestResolved,false);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});

test('response ACK refuses closure during I/O and concurrent response attempts',async()=>{
 for(const concurrent of [false,true]){
  const f=await daemonFixture();try{
   let live=true;const writer=f.custody(()=>live),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);
   const value=f.local({format:1,kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId:f.request.jobId,sequence:1,
    intentPin:{sha256:local.sha256,byteLength:local.byteLength},status:0,transportError:false,signal:false,removalAlreadyAbsent:false});
   if(concurrent){
    const outcomes=await Promise.allSettled([writer.observeResponse(value),writer.observeResponse(value)]);
    assert.ok(outcomes.every(v=>v.status==='rejected'));
   }else{
    const original=f.client.send.bind(f.client);
    mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{live=false;return original(command as never);});
    await assert.rejects(writer.observeResponse(value));
   }
   await assert.rejects(writer.reserveIntent(f.intent(2,local.sha256)));
  }finally{f.close();}
 }
});

test('original service ACK gates immutable daemon header/intents; saved reads reconstruct no dispatch permission',async()=>{
 const f=await daemonFixture();try{
  const h=await f.session.reserveDaemonHeader(f.header,f.original),first=f.intent();
  h.pin.versionId='caller-edited-return-pin';
  await f.session.reserveDaemonIntent(first,f.original);await f.session.reserveDaemonIntent(f.intent(2,first.sha256),f.original);
  const writes=f.b.writes;f.session.closeExecution();const reader=f.reader();
  const saved=await reader.inspectHeader();assert.equal(saved.localRecord.sha256,f.header.sha256);
  const one=await reader.inspectIntent(1,f.header.sha256),two=await reader.inspectIntent(2,one.localRecord.sha256);
  assert.equal(two.pendingRequestResolved,false);assert.equal(one.savedEvidenceAuthorizesDispatch,false);assert.equal(one.originalAcknowledgementReconstructed,false);
  assert.equal(f.b.writes,writes);assert.equal(f.b.generates,0);
  await assert.rejects(reader.reserveHeader(f.header));await assert.rejects(f.session.reserveDaemonIntent(f.intent(3,two.localRecord.sha256),f.original));
  await assert.rejects(reader.inspectIntent(2,'0'.repeat(64)));
 }finally{f.close();}
 const g=fixture();try{
  await g.session.reserve(g.input,g.original);await assert.rejects(g.session.reserveDaemonHeader({},g.original));
  await g.session.bindService(service(g),g.original);await assert.rejects(g.session.reserveDaemonHeader({},g.original));
 }finally{g.close();}
});

test('daemon custody rejects secret fields, wrong input/job/chain and unsafe storage before writing; invalid original attempts stay consumed',async()=>{
 for(const change of [{inputDigest:'0'.repeat(64)},{jobId:randomUUID()},{databaseUrl:'SYNTHETIC_PRIVATE_BODY'}]){
  const f=await daemonFixture();try{
   const before=f.b.writes;await assert.rejects(f.session.reserveDaemonHeader(f.local({...JSON.parse(f.header.body),...change}),f.original));
   await assert.rejects(f.session.reserveDaemonHeader(f.header,f.original));assert.equal(f.b.writes,before);
  }finally{f.close();}
 }
 for(const change of [{previousDigest:'0'.repeat(64)},{sequence:2},{jobId:randomUUID()},{rawArguments:['SYNTHETIC_PRIVATE_BODY']},
  {storagePlan:{format:2,kind:'MANAGED_PROOF_STORAGE_PLAN_V2',image:'postgres@sha256:'+'1'.repeat(64),declaredImageVolumesCovered:true,
   mounts:[{target:'/var/lib/postgresql/data',type:'tmpfs',readOnly:false,tmpfsOptions:'rw,noexec,nosuid,size=1m'},
    {target:'/backup',type:'bind',readOnly:false,sourceDigest:'f'.repeat(64)}]}}]){
  const f=await daemonFixture();try{
   await f.session.reserveDaemonHeader(f.header,f.original);const before=f.b.writes;
   await assert.rejects(f.session.reserveDaemonIntent(f.intent(1,f.header.sha256,change),f.original));assert.equal(f.b.writes,before);
   await assert.rejects(f.session.reserveDaemonIntent(f.intent(),f.original));
  }finally{f.close();}
 }
});

test('lost daemon intent readback ACK remains discoverable without retry or reconstructed acknowledgement',async()=>{
 for(const sequence of [0,1]){
 const f=await daemonFixture();try{
  if(sequence===1)await f.session.reserveDaemonHeader(f.header,f.original);const original=f.client.send.bind(f.client);let lost=true;
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
   if(lost&&command instanceof GetObjectCommand&&command.input.Key?.includes('/'+daemonCustodyScope(f.binding.candidateId,sequence)+'/'))throw new Error('synthetic lost intent readback');
   return original(command as never);
  });
  const reserve=()=>sequence===0?f.session.reserveDaemonHeader(f.header,f.original):f.session.reserveDaemonIntent(f.intent(),f.original);
  await assert.rejects(reserve());const writes=f.b.writes;
  await assert.rejects(f.session.reserveDaemonIntent(f.intent(),f.original));assert.equal(f.b.writes,writes);
  lost=false;const saved=sequence===0?await f.reader().inspectHeader():await f.reader().inspectIntent(1,f.header.sha256);
  assert.equal(saved.savedEvidenceAuthorizesDispatch,false);assert.equal(saved.originalAcknowledgementReconstructed,false);assert.equal(f.b.writes,writes);
 }finally{f.close();}
 }
});

test('concurrent intent calls and closure during header read refuse rather than return a live ACK',async()=>{
 const f=await daemonFixture();try{
  await f.session.reserveDaemonHeader(f.header,f.original);
  const settled=await Promise.allSettled([f.session.reserveDaemonIntent(f.intent(),f.original),f.session.reserveDaemonIntent(f.intent(),f.original)]);
  assert.ok(settled.every(r=>r.status==='rejected'));
 }finally{f.close();}
 const g=await daemonFixture();try{
  await g.session.reserveDaemonHeader(g.header,g.original);const original=g.client.send.bind(g.client),before=g.b.writes;
  mock.method(g.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{if(command instanceof GetObjectCommand)g.setLive(false);return original(command as never);});
  await assert.rejects(g.session.reserveDaemonIntent(g.intent(),g.original));assert.equal(g.b.writes,before);
 }finally{g.close();}
});

test('daemon intent sequence is bounded to64 and cannot begin without the original header ACK',async()=>{
 const g=await daemonFixture();try{
  const before=g.b.writes;await assert.rejects(g.session.reserveDaemonIntent(g.intent(),g.original));
  await assert.rejects(g.session.reserveDaemonHeader(g.header,g.original));assert.equal(g.b.writes,before);
 }finally{g.close();}
 const f=await daemonFixture();try{
  await f.session.reserveDaemonHeader(f.header,f.original);let previous=f.header.sha256,lastPrevious=previous;
  for(let sequence=1;sequence<=64;sequence++){lastPrevious=previous;const local=f.intent(sequence,previous);await f.session.reserveDaemonIntent(local,f.original);previous=local.sha256;}
  const before=f.b.writes;await assert.rejects(f.session.reserveDaemonIntent(f.intent(65,previous),f.original));assert.equal(f.b.writes,before);
  assert.equal(JSON.parse((await f.reader().inspectIntent(64,lastPrevious)).localRecord.body).sequence,64);
  await assert.rejects(f.reader().inspectIntent(64,previous));
 }finally{f.close();}
});
