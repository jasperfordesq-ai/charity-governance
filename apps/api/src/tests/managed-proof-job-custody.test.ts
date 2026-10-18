import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {ManagedProofJobCustody} from '../services/managed-proof-job-custody.js';
import {jobScope,jobServiceScope,jobRequestArtifact,jobServiceArtifact} from '../services/managed-proof-job-contract.js';
import {ManagedDaemonIntentCustody,daemonCustodyScope,daemonOwnerCustodyScope} from '../services/managed-daemon-intent-custody.js';
import {GetObjectCommand,PutObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
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
 const custody=(live=()=>false,sourceCredentials:typeof credentials|(()=>Promise<typeof credentials>)=credentials)=>new ManagedDaemonIntentCustody({installationId:config.installationId,bucket:config.bucket,accountId:config.accountId,kmsKeyArn:config.storageKeyArn},f.binding,sourceCredentials,f.client,
  jobRequestArtifact(f.binding,f.original,f.input),request.pin,jobServiceArtifact(f.binding,request.pin,localService),bound.pin,live);
 const reader=()=>custody();
 const response=(local:ReturnType<typeof f.local>,change={})=>f.local({format:1,kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId:f.request.jobId,
  sequence:JSON.parse(local.body).sequence,intentPin:{sha256:local.sha256,byteLength:local.byteLength},status:0,transportError:false,signal:false,removalAlreadyAbsent:false,...change});
 const end=(requestCount:number,lastIntentDigest:string,change={})=>f.local({format:1,kind:'MANAGED_DAEMON_REQUEST_END_V1',jobId:f.request.jobId,
  headerPin:{sha256:header.sha256,byteLength:header.byteLength},requestCount,lastIntentDigest,...change});
 const owner=(local:ReturnType<typeof f.local>,change={},identityChange={})=>{
  const ownerId=randomUUID(),unit=`charitypilot-containment-${ownerId}.service`;
  return f.local({format:1,kind:'MANAGED_DAEMON_REQUEST_OWNER_V1',jobId:f.request.jobId,sequence:JSON.parse(local.body).sequence,
   intentPin:{sha256:local.sha256,byteLength:local.byteLength},identity:{ownerId,unit,invocationId:'f'.repeat(32),uid:1000,mainPid:4321,
    mainStartMonotonic:'987654',sourceSha:f.binding.sourceSha,inputDigest:'9'.repeat(64),bootId:'12345678-1234-1234-1234-123456789012',
    controlGroup:`/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,...identityChange},...change});
 };
 const ownerOutcome=(local:ReturnType<typeof f.local>,bound:ReturnType<typeof f.local>,change={})=>f.local({format:1,kind:'MANAGED_DAEMON_OWNER_OUTCOME_V1',jobId:f.request.jobId,
  sequence:JSON.parse(local.body).sequence,intentPin:{sha256:local.sha256,byteLength:local.byteLength},ownerPin:{sha256:bound.sha256,byteLength:bound.byteLength},
  ownerInputDigest:JSON.parse(bound.body).identity.inputDigest,status:0,transportError:false,signal:false,removalAlreadyAbsent:false,
  stdout:{sha256:hash('marker'),byteLength:6},stderr:{sha256:hash(''),byteLength:0},...change});
 return{...f,header,intent,reader,custody,response,end,owner,ownerOutcome};
}

async function transferFixture(){
 const f=await daemonFixture(),live={value:true},writer=f.custody(()=>live.value),local=f.intent(),bound=f.owner(local);
 await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.bindOwner(bound);
 return{...f,writer,live,local,bound};
}

test('original live transfer observes its delivered SDK receipt once without a duplicate write',async()=>{
 const f=await transferFixture();let grant;
 try{
  const transfer=await f.writer.createOwnerOutcomeTransfer(),input=transfer.take();
  grant=await ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client);
  assert.equal(transfer.confirmReady(),true);const outcome=f.ownerOutcome(f.local,f.bound),stored=await grant.publish(outcome),writes=f.b.writes;
  const receipt={pin:stored.pin,originalAcknowledgementReconstructed:false,pendingRequestResolved:false,actionAuthorized:false};
  const observed=await transfer.observeReceipt(outcome,receipt);assert.deepEqual(observed.pin,stored.pin);assert.equal(observed.pendingRequestResolved,false);assert.equal(observed.savedEvidenceAuthorizesDispatch,false);
  assert.equal(f.b.writes,writes);await assert.rejects(transfer.observeReceipt(outcome,receipt));assert.equal(f.b.writes,writes);
 }finally{grant?.revoke();f.close();}
});

test('original receiver readiness cannot be confirmed before claim or after source closure',async()=>{
 for(const stage of ['before-claim','closed']){const f=await transferFixture();let grant;try{
  const transfer=await f.writer.createOwnerOutcomeTransfer(),input=transfer.take();
  if(stage==='closed'){grant=await ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client);f.live.value=false;}
  const writes=f.b.writes;assert.throws(()=>transfer.confirmReady());assert.equal(f.b.writes,writes);
 }finally{grant?.revoke();f.close();}}
});

test('transferred receipt refuses missing original claim, changed pin/body, source closure and reconstructed flags without writes',async()=>{
 for(const mode of ['unclaimed','version','body','closed','reconstructed','during-read']){
  const f=await transferFixture();let grant;
  try{
   const transfer=await f.writer.createOwnerOutcomeTransfer(),input=transfer.take();
   if(mode!=='unclaimed')grant=await ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client);
   const outcome=f.ownerOutcome(f.local,f.bound),stored=grant?await grant.publish(outcome):{pin:{kind:'OBSERVATION',versionId:'synthetic-missing',sha256:'0'.repeat(64),byteLength:1}};
   const receipt={pin:{...stored.pin},originalAcknowledgementReconstructed:false,pendingRequestResolved:false,actionAuthorized:false};
   if(mode==='version')receipt.pin.versionId='other-version';if(mode==='closed')f.live.value=false;
   if(mode==='reconstructed')receipt.originalAcknowledgementReconstructed=true;
   if(mode==='during-read'){const original=f.client.send.bind(f.client);mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{if(command instanceof GetObjectCommand)f.live.value=false;return original(command as never);});}
   const writes=f.b.writes;
   await assert.rejects(transfer.observeReceipt(mode==='body'?f.ownerOutcome(f.local,f.bound,{status:1}):outcome,receipt));
   await assert.rejects(transfer.observeReceipt(outcome,receipt));assert.equal(f.b.writes,writes);
  }finally{grant?.revoke();f.close();}
 }
});

test('original transfer receipt cannot renew its monotonic deadline',async(t)=>{
 const real=process.hrtime.bigint.bind(process.hrtime);let now=real();t.mock.method(process.hrtime,'bigint',()=>now);
 const f=await transferFixture();let grant;try{
  const transfer=await f.writer.createOwnerOutcomeTransfer(),input=transfer.take();grant=await ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client);
  const outcome=f.ownerOutcome(f.local,f.bound),stored=await grant.publish(outcome),writes=f.b.writes;now+=120000000001n;
  await assert.rejects(transfer.observeReceipt(outcome,{pin:stored.pin,originalAcknowledgementReconstructed:false,pendingRequestResolved:false,actionAuthorized:false}));assert.equal(f.b.writes,writes);
 }finally{grant?.revoke();f.close();}
});

test('original live outcome authority transfers once and publishes after source closure without recreating a cold grant',async()=>{
 const f=await transferFixture();try{
  const transfer=await f.writer.createOwnerOutcomeTransfer();assert.equal(Object.isFrozen(transfer),true);assert.equal(JSON.stringify(transfer),'{}');
  const input=transfer.take(),writes=f.b.writes;
  assert.equal(input.kind,'ORIGINAL_DAEMON_OUTCOME_TRANSFER_V1');assert.equal(input.credentials.accessKeyId,credentials.accessKeyId);
  assert.throws(()=>f.writer.createOwnerOutcomeWriter());await assert.rejects(f.writer.createOwnerOutcomeTransfer());
  // A separate issuer is required after the deliberately invalid repeat above.
  assert.equal(f.b.writes,writes);
 }finally{f.close();}
 const g=await transferFixture();let grant;
 try{
  const transfer=await g.writer.createOwnerOutcomeTransfer(),input=transfer.take();
  grant=await ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(nonce,digest)=>transfer.claim(nonce,digest),g.client);
  g.live.value=false;const outcome=g.ownerOutcome(g.local,g.bound),saved=await grant.publish(outcome);
  assert.equal(saved.pin.kind,'OBSERVATION');assert.equal(saved.pendingRequestResolved,false);
  const writes=g.b.writes,read=await g.reader().inspectOwnerOutcome(1,g.header.sha256);
  assert.equal(read.localRecord.sha256,outcome.sha256);assert.equal(read.originalAcknowledgementReconstructed,false);
  await assert.rejects(grant.publish(outcome));await assert.rejects(g.reader().createOwnerOutcomeTransfer());assert.equal(g.b.writes,writes);
 }finally{grant?.revoke();g.close();}
});

test('private outcome transfer refuses modified input, repeated/lost claims and source closure before claim without provider writes',async()=>{
 for(const mode of ['modified','repeat-take','closed','claim-lost','abandoned']){
  const f=await transferFixture();try{
   const transfer=await f.writer.createOwnerOutcomeTransfer(),input=transfer.take(),writes=f.b.writes;
   if(mode==='modified')input.ownerPin.versionId='substituted';if(mode==='repeat-take')assert.throws(()=>transfer.take());if(mode==='closed')f.live.value=false;if(mode==='abandoned')transfer.abandon();
   let calls=0;const original=f.client.send.bind(f.client);mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand|ListObjectsV2Command)=>{calls++;return original(command as never);});
   await assert.rejects(ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(nonce,digest)=>{
    const accepted=transfer.claim(nonce,digest);if(mode==='claim-lost')throw new Error('synthetic original claim ACK lost');return accepted;
   },f.client));
   assert.equal(calls,0);assert.equal(f.b.writes,writes);
   await assert.rejects(ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(nonce,digest)=>transfer.claim(nonce,digest),f.client));assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('outcome transfer keeps the original monotonic deadline across activation and never extends it',async(t)=>{
 let now=process.hrtime.bigint();t.mock.method(process.hrtime,'bigint',()=>now);
 for(const stage of ['before-take','before-claim','before-publish']){
  const f=await transferFixture();let grant;
  try{
   const transfer=await f.writer.createOwnerOutcomeTransfer(),writes=f.b.writes;
   if(stage==='before-take'){now+=120000000001n;assert.throws(()=>transfer.take());}
   else{const input=transfer.take();
    if(stage==='before-claim'){now+=120000000001n;await assert.rejects(ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client));}
    else{grant=await ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client);now+=120000000001n;await assert.rejects(grant.publish(f.ownerOutcome(f.local,f.bound)));}
   }
   assert.equal(f.b.writes,writes);
  }finally{grant?.revoke();f.close();}
 }
});

test('transferred writer preserves an accepted outcome with lost readback ACK and cannot be replaced or retried',async()=>{
 const f=await transferFixture();let grant;
 try{
  const transfer=await f.writer.createOwnerOutcomeTransfer(),input=transfer.take();
  grant=await ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client);f.live.value=false;
  const original=f.client.send.bind(f.client);let lost=true;
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
   if(lost&&command instanceof GetObjectCommand&&command.input.Key?.includes('/'+daemonOwnerCustodyScope(f.binding.candidateId,1)+'/observation.json'))throw new Error('synthetic delegated outcome ACK lost');
   return original(command as never);
  });
  const outcome=f.ownerOutcome(f.local,f.bound);await assert.rejects(grant.publish(outcome));const writes=f.b.writes;
  await assert.rejects(grant.publish(outcome));await assert.rejects(ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,async(n,d)=>transfer.claim(n,d),f.client));lost=false;
  const found=await f.reader().inspectOwnerOutcome(1,f.header.sha256);assert.equal(found.localRecord.sha256,outcome.sha256);
  assert.equal(found.originalAcknowledgementReconstructed,false);assert.equal(found.pendingRequestResolved,false);assert.equal(f.b.writes,writes);
 }finally{grant?.revoke();f.close();}
});

test('stalled credential resolution and original claim are bounded and cannot renew transfer authority',{timeout:3000},async(t)=>{
 const actualTimeout=AbortSignal.timeout.bind(AbortSignal);t.mock.method(AbortSignal,'timeout',(ms:number)=>actualTimeout(Math.min(ms,100)));
 const hold=setTimeout(()=>{},2000);
 try{
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true,()=>new Promise(()=>{})),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.bindOwner(f.owner(local));
   const writes=f.b.writes;await assert.rejects(writer.createOwnerOutcomeTransfer());await assert.rejects(writer.createOwnerOutcomeTransfer());assert.equal(f.b.writes,writes);
  }finally{f.close();}
  const g=await transferFixture();try{
   const transfer=await g.writer.createOwnerOutcomeTransfer(),input=transfer.take(),writes=g.b.writes;
   await assert.rejects(ManagedDaemonIntentCustody.acceptOwnerOutcomeTransfer(input,()=>new Promise(()=>{}),g.client));assert.equal(g.b.writes,writes);
  }finally{g.close();}
 }finally{clearTimeout(hold);}
});

test('cold discovery refuses contradictory owner and source results without repairing or writing history',async()=>{
 for(const field of ['status','transportError','signal','removalAlreadyAbsent','matching-success','matching-failure']){
  const f=await daemonFixture();try{
   const removal=field==='removalAlreadyAbsent',local=f.intent(1,f.header.sha256,removal?{operation:'rm',storagePlan:null}:{}),bound=f.owner(local),writer=f.custody(()=>true);
   await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.bindOwner(bound);
   const ownerChange=field==='status'||field==='matching-failure'?{status:1}:field==='transportError'?{transportError:true}:field==='signal'?{signal:true}:removal?{status:1,removalAlreadyAbsent:true}:{};
   await writer.createOwnerOutcomeWriter().publish(f.ownerOutcome(local,bound,ownerChange));
   await writer.observeResponse(f.response(local,field==='matching-failure'||removal?{status:1}:{}));
   if(field==='matching-success')await writer.finishRequests(f.end(1,local.sha256));
   f.setLive(false);const writes=f.b.writes,generates=f.b.generates;
   if(field.startsWith('matching-')){
    const found=await f.reader().discover();assert.equal(found.ownerOutcomeCount,1);assert.equal(found.responseCount,1);
    assert.equal(found.state,field==='matching-success'?'RECORDED_CLIENT_RESPONSES':'UNRESOLVED_REQUESTS');
    assert.equal(found.pendingRequestResolved,false);assert.equal(found.cleanupAuthorized,false);assert.equal(found.actionAuthorized,false);
   }else await assert.rejects(f.reader().discover());
   assert.equal(f.b.writes,writes);assert.equal(f.b.generates,generates);
  }finally{f.close();}
 }
});

test('original one-shot outcome writer survives source closure while fresh reads cannot recreate it',async()=>{
 const f=await daemonFixture();try{
  const local=f.intent(),bound=f.owner(local);await f.session.reserveDaemonHeader(f.header,f.original);await f.session.reserveDaemonIntent(local,f.original);
  await f.session.bindDaemonOwner(bound,f.original);const grant=f.session.createDaemonOwnerOutcomeWriter(f.original);
  assert.equal(Object.isFrozen(grant),true);assert.equal(JSON.stringify(grant),'{}');
  assert.throws(()=>f.session.createDaemonOwnerOutcomeWriter(f.original));f.session.closeExecution();f.setLive(false);
  const outcome=f.ownerOutcome(local,bound),saved=await grant.publish(outcome);assert.equal(saved.pin.kind,'OBSERVATION');assert.equal(saved.pendingRequestResolved,false);
  const writes=f.b.writes,found=await f.reader().inspectOwnerOutcome(1,f.header.sha256);
  assert.equal(found.localRecord.sha256,outcome.sha256);assert.equal(found.originalAcknowledgementReconstructed,false);assert.equal(found.executionAuthorized,false);
  const catalogue=await f.reader().discover();assert.equal(catalogue.ownerOutcomeCount,1);assert.ok(catalogue.records[0].ownerOutcomePin);
  assert.equal(catalogue.state,'UNRESOLVED_REQUESTS');assert.equal(catalogue.independentOwnerDispatchVerified,false);
  await assert.rejects(grant.publish(outcome));assert.throws(()=>f.reader().createOwnerOutcomeWriter());assert.equal(f.b.writes,writes);
 }finally{f.close();}
});

test('outcome writer rejects mismatched original pins/input and raw output fields, then stays consumed',async()=>{
 for(const change of [{ownerPin:{sha256:'0'.repeat(64),byteLength:1}},{intentPin:{sha256:'0'.repeat(64),byteLength:1}},{ownerInputDigest:'0'.repeat(64)},
  {jobId:randomUUID()},{sequence:2},{rawOutput:'SYNTHETIC_PRIVATE_BODY'},{removalAlreadyAbsent:true,status:1},{stdout:{sha256:'0'.repeat(64),byteLength:0}}]){
  const f=await daemonFixture();try{
   const local=f.intent(),bound=f.owner(local),writer=f.custody(()=>true);await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.bindOwner(bound);
   const grant=writer.createOwnerOutcomeWriter(),writes=f.b.writes;
   await assert.rejects(grant.publish(f.ownerOutcome(local,bound,change)));await assert.rejects(grant.publish(f.ownerOutcome(local,bound)));assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('lost outcome readback ACK retains independently readable bytes without retry or manufactured acknowledgement',async()=>{
 const f=await daemonFixture();try{
  const local=f.intent(),bound=f.owner(local),writer=f.custody(()=>true);await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.bindOwner(bound);
  const grant=writer.createOwnerOutcomeWriter(),original=f.client.send.bind(f.client);let lost=true;
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
   if(lost&&command instanceof GetObjectCommand&&command.input.Key?.includes('/'+daemonOwnerCustodyScope(f.binding.candidateId,1)+'/observation.json'))throw new Error('synthetic original outcome ACK lost');
   return original(command as never);
  });
  const outcome=f.ownerOutcome(local,bound);await assert.rejects(grant.publish(outcome));const writes=f.b.writes;
  await assert.rejects(grant.publish(outcome));assert.throws(()=>writer.createOwnerOutcomeWriter());lost=false;
  assert.equal((await f.reader().inspectOwnerOutcome(1,f.header.sha256)).localRecord.sha256,outcome.sha256);
  assert.equal((await f.reader().discover()).ownerOutcomeCount,1);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});

test('outcome writer expiry and explicit revocation cannot be reset into write authority',async(t)=>{
 let elapsed=0;t.mock.method(performance,'now',()=>elapsed);
 for(const revoke of [false,true]){
  elapsed=0;const f=await daemonFixture();try{
   const local=f.intent(),bound=f.owner(local),writer=f.custody(()=>true);await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.bindOwner(bound);
   const grant=writer.createOwnerOutcomeWriter(),writes=f.b.writes;if(revoke)grant.revoke();else elapsed=120001;
   await assert.rejects(grant.publish(f.ownerOutcome(local,bound)));elapsed=0;await assert.rejects(grant.publish(f.ownerOutcome(local,bound)));assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('outcome grant cannot be backfilled without original owner ACK or after a source response',async()=>{
 for(const stage of ['no-owner','after-response']){
  const f=await daemonFixture();try{
   const local=f.intent(),writer=f.custody(()=>true);await writer.reserveHeader(f.header);await writer.reserveIntent(local);
   if(stage==='after-response'){await writer.bindOwner(f.owner(local));await writer.observeResponse(f.response(local));}
   const writes=f.b.writes;assert.throws(()=>writer.createOwnerOutcomeWriter());assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('revocation after accepted outcome PUT denies ACK and retry without deleting stored evidence',async()=>{
 const f=await daemonFixture();try{
  const local=f.intent(),bound=f.owner(local),writer=f.custody(()=>true);await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.bindOwner(bound);
  const grant=writer.createOwnerOutcomeWriter(),original=f.client.send.bind(f.client);
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
   const value=await original(command as never);
   if(command instanceof PutObjectCommand&&command.input.Key?.includes('/'+daemonOwnerCustodyScope(f.binding.candidateId,1)+'/observation.json'))grant.revoke();
   return value;
  });
  const outcome=f.ownerOutcome(local,bound);await assert.rejects(grant.publish(outcome));const writes=f.b.writes;
  await assert.rejects(grant.publish(outcome));assert.equal((await f.reader().inspectOwnerOutcome(1,f.header.sha256)).localRecord.sha256,outcome.sha256);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});

test('original intent ACK permits one distinct owner binding; saved reads grant no dispatch or resolution',async()=>{
 const f=await daemonFixture();try{
  const local=f.intent(),binding=f.owner(local);await f.session.reserveDaemonHeader(f.header,f.original);await f.session.reserveDaemonIntent(local,f.original);
  const saved=await f.session.bindDaemonOwner(binding,f.original);assert.equal(saved.pin.kind,'BASELINE');assert.equal(saved.independentOwnerDispatchVerified,false);
  const writes=f.b.writes;f.session.closeExecution();const read=await f.reader().inspectOwner(1,f.header.sha256);
  assert.equal(read.localRecord.sha256,binding.sha256);assert.equal(read.originalAcknowledgementReconstructed,false);assert.equal(read.pendingRequestResolved,false);
  assert.equal(read.savedEvidenceAuthorizesDispatch,false);assert.equal(read.independentOwnerDispatchVerified,false);assert.equal(f.b.writes,writes);
  const discovered=await f.create().discover(f.original);assert.equal(discovered.daemon?.ownerBindingCount,1);
  assert.ok(discovered.daemon?.records[0].ownerPin);assert.equal(discovered.daemon?.independentOwnerDispatchVerified,false);assert.equal(f.b.writes,writes);
  await assert.rejects(f.reader().bindOwner(binding));await assert.rejects(f.session.bindDaemonOwner(binding,f.original));
 }finally{f.close();}
});

test('owner binding refuses scope/intent/identity/secret substitutions and consumes the writer',async()=>{
 for(const change of [{jobId:randomUUID()},{sequence:2},{intentPin:{sha256:'0'.repeat(64),byteLength:1}},{secret:'SYNTHETIC_PRIVATE_BODY'},
  {identity:{bootId:'other-boot'}},{identity:{bootId:'87654321-4321-4321-4321-210987654321'}},{identity:{uid:1001}},{identity:{mainPid:123}},{identity:{sourceSha:'2'.repeat(40)}},
  {identity:{controlGroup:'/user.slice/../unrelated'}},{identity:{unit:'other.service'}}]){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);
   const identity='identity' in change?change.identity:{},other='identity' in change?{}:change;
   const writes=f.b.writes;await assert.rejects(writer.bindOwner(f.owner(local,other,identity)));await assert.rejects(writer.bindOwner(f.owner(local)));
   assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('unknown owner ACK cannot be retried or replaced, but its exact saved bytes remain inspectable',async()=>{
 const f=await daemonFixture();try{
  const writer=f.custody(()=>true),local=f.intent(),binding=f.owner(local);await writer.reserveHeader(f.header);await writer.reserveIntent(local);
  const original=f.client.send.bind(f.client);let lost=true;
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
   if(lost&&command instanceof GetObjectCommand&&command.input.Key?.includes('/'+daemonOwnerCustodyScope(f.binding.candidateId,1)+'/'))throw new Error('synthetic owner ACK loss');
   return original(command as never);
  });
  await assert.rejects(writer.bindOwner(binding));const writes=f.b.writes;
  await assert.rejects(writer.bindOwner(f.owner(local)));await assert.rejects(writer.observeResponse(f.response(local)));assert.equal(f.b.writes,writes);
  lost=false;const read=await f.reader().inspectOwner(1,f.header.sha256);assert.equal(read.localRecord.sha256,binding.sha256);
  assert.equal(read.originalAcknowledgementReconstructed,false);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});

test('owner readiness cannot be attached before an original intent or after its response',async()=>{
 for(const stage of ['before-intent','after-response']){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);
   if(stage==='after-response'){await writer.reserveIntent(local);await writer.observeResponse(f.response(local));}
   const writes=f.b.writes;await assert.rejects(writer.bindOwner(f.owner(local)));assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('owner readiness requires the acknowledged header and intent to remain current versions',async()=>{
 for(const sequence of [0,1]){
  const f=await daemonFixture();try{
   const local=f.intent();await f.session.reserveDaemonHeader(f.header,f.original);await f.session.reserveDaemonIntent(local,f.original);
   const key=[...f.b.objects.keys()].find(k=>k.includes('/'+daemonCustodyScope(f.binding.candidateId,sequence)+'/baseline.json'))!;
   const original=f.client.send.bind(f.client);let sawCurrent=false;
   mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
    const value=await original(command as never);
    if(command instanceof GetObjectCommand&&command.input.Key===key&&command.input.VersionId===undefined){sawCurrent=true;return{...value,VersionId:'substituted-current-version'};}
    return value;
   });
   const writes=f.b.writes;await assert.rejects(f.session.bindDaemonOwner(f.owner(local),f.original));assert.equal(sawCurrent,true);assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('owner binding refuses a descendant source group, concurrent calls and closure during original-intent read',async()=>{
 for(const fault of ['descendant','concurrent','closed']){
  const f=await daemonFixture();try{
   const local=f.intent();await f.session.reserveDaemonHeader(f.header,f.original);await f.session.reserveDaemonIntent(local,f.original);
   const value=JSON.parse(f.owner(local).body),writes=f.b.writes;
   if(fault==='descendant'){
    value.identity.controlGroup=`/user.slice/user-1000.slice/user@1000.service/app.slice/charitypilot-containment-${f.request.jobId}.service/${value.identity.unit}`;
    await assert.rejects(f.session.bindDaemonOwner(f.local(value),f.original));
   }else if(fault==='concurrent'){
    const results=await Promise.allSettled([f.session.bindDaemonOwner(f.local(value),f.original),f.session.bindDaemonOwner(f.local(value),f.original)]);
    assert.ok(results.every(v=>v.status==='rejected'));
   }else{
    const original=f.client.send.bind(f.client);
    mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{if(command instanceof GetObjectCommand)f.setLive(false);return original(command as never);});
    await assert.rejects(f.session.bindDaemonOwner(f.local(value),f.original));
   }
   assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('cold owner discovery rejects orphaned owner records, unexpected observations and changed original intent version pins',async()=>{
 for(const fault of ['orphan','observation','version']){
  const f=await daemonFixture();try{
   const local=f.intent();await f.session.reserveDaemonHeader(f.header,f.original);await f.session.reserveDaemonIntent(local,f.original);
   await f.session.bindDaemonOwner(f.owner(local),f.original);
   const scope='/capture-job/'+daemonOwnerCustodyScope(f.binding.candidateId,1)+'/',[key,value]=[...f.b.objects].find(([k])=>k.includes(scope))!;
   if(fault==='orphan')f.b.objects.delete([...f.b.objects.keys()].find(k=>k.includes('/'+daemonCustodyScope(f.binding.candidateId,1)+'/baseline.json'))!);
   if(fault==='observation')f.b.objects.set(key.replace('/baseline.json','/observation.json'),value);
   if(fault==='version'){
    const changed=JSON.parse(value.body.toString());changed.intentCustodyPin.versionId='substituted-original-version';const body=Buffer.from(JSON.stringify(changed));
    f.b.objects.set(key,{...value,body,checksum:Buffer.from(hash(body.toString()),'hex').toString('base64')});
   }
   const writes=f.b.writes;await assert.rejects(f.reader().discover());assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

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

test('original end ACK binds all acknowledged responses; fresh reads remain evidence without resolution or inventory authority',async()=>{
 const f=await daemonFixture();try{
  const local=f.intent();await f.session.reserveDaemonHeader(f.header,f.original);await f.session.reserveDaemonIntent(local,f.original);
  await f.session.observeDaemonResponse(f.response(local),f.original);
  const end=f.end(1,local.sha256),saved=await f.session.finishDaemonRequests(end,f.original);assert.equal(saved.pin.kind,'OBSERVATION');
  const writes=f.b.writes;f.session.closeExecution();const observed=await f.reader().inspectEnd();
  assert.equal(observed.localRecord.sha256,end.sha256);assert.equal(observed.pendingRequestResolved,false);assert.equal(observed.completeResourceInventory,false);
  assert.equal(observed.originalAcknowledgementReconstructed,false);assert.equal(f.b.writes,writes);
  const discovered=await f.create().discover(f.original);
  assert.equal(discovered.daemon?.state,'RECORDED_CLIENT_RESPONSES');assert.equal(discovered.daemon?.records.length,1);
  assert.equal(discovered.daemon?.responseCount,1);assert.equal(discovered.daemon?.pendingRequestResolved,false);assert.equal(f.b.writes,writes);
  await assert.rejects(f.session.finishDaemonRequests(end,f.original));await assert.rejects(f.reader().finishRequests(end));
 }finally{f.close();}
});

test('fresh daemon discovery distinguishes absent records, lost ACK and missing response without replay',async()=>{
 for(const stage of ['absent','header','intent','response','end']){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true),local=f.intent();
   if(stage!=='absent')await writer.reserveHeader(f.header);
   if(['intent','response','end'].includes(stage))await writer.reserveIntent(local);
   if(['response','end'].includes(stage))await writer.observeResponse(f.response(local));
   if(stage==='end')await writer.finishRequests(f.end(1,local.sha256));
   const writes=f.b.writes,found=await f.reader().discover();
   assert.equal(found.state,stage==='absent'?'NOT_LISTED_AT_BOUNDARY':stage==='end'?'RECORDED_CLIENT_RESPONSES':'UNRESOLVED_REQUESTS');
   assert.equal(found.records.length,['intent','response','end'].includes(stage)?1:0);
   assert.equal(found.responseCount,['response','end'].includes(stage)?1:0);
   assert.equal(found.pendingRequestResolved,false);assert.equal(found.originalAcknowledgementReconstructed,false);assert.equal(found.historyCompletenessVerified,false);
   assert.equal(found.cleanupAuthorized,false);assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('bounded daemon discovery rejects orphan, gap and unexpected ordinal objects',async()=>{
 for(const fault of ['orphan','gap','unexpected']){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.observeResponse(f.response(local));
   const prefix='/capture-job/'+daemonCustodyScope(f.binding.candidateId,1)+'/',[key,value]=[...f.b.objects].find(([k])=>k.includes(prefix)&&k.endsWith('/baseline.json'))!;
   if(fault==='orphan')f.b.objects.delete(key);
   if(fault==='gap'){
    f.b.objects.set(key.replace(daemonCustodyScope(f.binding.candidateId,1),daemonCustodyScope(f.binding.candidateId,2)),value);
    f.b.objects.delete(key);f.b.objects.delete(key.replace('/baseline.json','/observation.json'));
   }
   if(fault==='unexpected')f.b.objects.set(key.replace('/baseline.json','/unexpected.json'),value);
   const writes=f.b.writes;await assert.rejects(f.reader().discover());assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('empty discovery checks all65 request and64 owner scopes twice and refuses pagination or cancellation',async()=>{
 const f=await daemonFixture();try{
  const reads=f.b.reads;assert.equal((await f.reader().discover()).state,'NOT_LISTED_AT_BOUNDARY');assert.equal(f.b.reads-reads,258);
  const controller=new AbortController();controller.abort();const before=f.b.reads;
  await assert.rejects(f.reader().discover(controller.signal));assert.equal(f.b.reads,before);
  const original=f.client.send.bind(f.client);
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand|ListObjectsV2Command)=>{
   const value=await original(command as never);return command instanceof ListObjectsV2Command?{...value,IsTruncated:true,NextContinuationToken:'unexpected'}:value;
  });
  await assert.rejects(f.reader().discover());
 }finally{f.close();}
});

test('daemon discovery refuses changing listings, wrong ETag and GET failure instead of treating evidence as absent',async()=>{
 for(const fault of ['late','etag','get']){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true);await writer.reserveHeader(f.header);
   const prefix='/capture-job/'+daemonCustodyScope(f.binding.candidateId,0)+'/',[key,value]=[...f.b.objects].find(([k])=>k.includes(prefix))!;
   const original=f.client.send.bind(f.client);let changed=false;
   mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
    if(command instanceof GetObjectCommand&&command.input.Key===key){
     if(fault==='get')throw new Error('synthetic read unavailable');
     if(fault==='etag')f.b.objects.set(key,{...value,version:'synthetic-substitution'});
     if(fault==='late'&&!changed){changed=true;f.b.objects.set(key.replace(daemonCustodyScope(f.binding.candidateId,0),daemonCustodyScope(f.binding.candidateId,64)),value);}
    }
    return original(command as never);
   });
   const writes=f.b.writes;await assert.rejects(f.reader().discover());assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('missing response ACK forbids next intent or end and consumes original writer',async()=>{
 for(const next of ['intent','end']){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);const writes=f.b.writes;
   await assert.rejects(next==='intent'?writer.reserveIntent(f.intent(2,local.sha256)):writer.finishRequests(f.end(1,local.sha256)));
   await assert.rejects(writer.observeResponse(f.response(local)));assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('end refuses changed header, last digest, count, job and secret fields before writes',async()=>{
 for(const change of [{headerPin:{sha256:'0'.repeat(64),byteLength:1}},{lastIntentDigest:'0'.repeat(64)},{requestCount:0},{jobId:randomUUID()},{secret:'SYNTHETIC_SECRET'}]){
  const f=await daemonFixture();try{
   const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.observeResponse(f.response(local));
   const writes=f.b.writes;await assert.rejects(writer.finishRequests(f.end(1,local.sha256,change)));
   await assert.rejects(writer.finishRequests(f.end(1,local.sha256)));assert.equal(f.b.writes,writes);
  }finally{f.close();}
 }
});

test('lost end readback leaves saved completion readable but never revives source or retry permission',async()=>{
 const f=await daemonFixture();try{
  const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);await writer.observeResponse(f.response(local));
  const original=f.client.send.bind(f.client);let lost=true;
  mock.method(f.client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
   if(lost&&command instanceof GetObjectCommand&&command.input.Key?.includes('/'+daemonCustodyScope(f.binding.candidateId,0)+'/observation.json'))throw new Error('synthetic end ACK loss');
   return original(command as never);
  });
  await assert.rejects(writer.finishRequests(f.end(1,local.sha256)));const writes=f.b.writes;
  await assert.rejects(writer.finishRequests(f.end(1,local.sha256)));await assert.rejects(writer.reserveIntent(f.intent(2,local.sha256)));
  lost=false;assert.equal((await f.reader().inspectEnd()).pendingRequestResolved,false);assert.equal(f.b.writes,writes);
 }finally{f.close();}
});

test('transport uncertainty is retained but prevents another daemon intent even with response ACK',async()=>{
 const f=await daemonFixture();try{
  const writer=f.custody(()=>true),local=f.intent();await writer.reserveHeader(f.header);await writer.reserveIntent(local);
  await writer.observeResponse(f.response(local,{status:null,transportError:true}));const writes=f.b.writes;
  await assert.rejects(writer.reserveIntent(f.intent(2,local.sha256)));assert.equal(f.b.writes,writes);
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
  await f.session.reserveDaemonIntent(first,f.original);await f.session.observeDaemonResponse(f.response(first),f.original);
  await f.session.reserveDaemonIntent(f.intent(2,first.sha256),f.original);
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
  for(let sequence=1;sequence<=64;sequence++){lastPrevious=previous;const local=f.intent(sequence,previous);await f.session.reserveDaemonIntent(local,f.original);await f.session.observeDaemonResponse(f.response(local),f.original);previous=local.sha256;}
  const before=f.b.writes;await assert.rejects(f.session.reserveDaemonIntent(f.intent(65,previous),f.original));assert.equal(f.b.writes,before);
  assert.equal(JSON.parse((await f.reader().inspectIntent(64,lastPrevious)).localRecord.body).sequence,64);
  await assert.rejects(f.reader().inspectIntent(64,previous));
 }finally{f.close();}
});
