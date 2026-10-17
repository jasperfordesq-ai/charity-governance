import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {S3ManagedMaintenanceControl} from '../services/managed-maintenance-control.js';
import {z} from 'zod';
import {ManagedBackendMaintenance} from '../services/managed-backend-maintenance.js';
import {S3ManagedWriteEvidence,type ManagedWriteEvidencePin} from '../services/managed-write-evidence.js';
import type {SignedUploadEvidencePin} from '../services/signed-upload-evidence.js';

const config={installationId:'synthetic-installation',bucket:'synthetic-maintenance',accountId:'123456789012',
 kmsKeyArn:'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111'};
const credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'};
const operation={installationId:config.installationId,sourceSha:'1'.repeat(40),maintenanceEpoch:1};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(){
 let value={format:1,installationId:config.installationId,maintenanceEpoch:1,planDigest:'1'.repeat(64),
  phase:'READY',attemptId:null as string|null,observations:null as unknown,readBaseline:undefined as {body:string;sha256:string}|undefined,readObservation:undefined as {body:string;sha256:string}|undefined,
  writeBaselinePin:undefined as ManagedWriteEvidencePin|undefined,writeObservationPin:undefined as ManagedWriteEvidencePin|undefined,
  signedBaselinePin:undefined as SignedUploadEvidencePin|undefined,signedObservationPin:undefined as SignedUploadEvidencePin|undefined,publicationId:randomUUID()};
 let version=1,reads=0,puts=0;
 const calls:string[]=[];
 let fault:((command:GetObjectCommand|PutObjectCommand)=>unknown)|undefined;
 const metadata=()=>({VersionId:'version-'+version,ETag:'"etag-'+version+'"',ServerSideEncryption:'aws:kms' as const,SSEKMSKeyId:config.kmsKeyArn});
 const client=new S3Client({region:'eu-west-1',credentials});
 const artifacts=new Map<string,{body:string;version:string}>();
 mock.method(client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
  const path=command.input;assert.equal(path.Bucket,config.bucket);assert.equal(path.ExpectedBucketOwner,config.accountId);
  const injected=fault?.(command);if(injected!==undefined)return injected;
  if(path.Key!==`managed-maintenance/${config.installationId}/control.json`){
   if(command instanceof PutObjectCommand){calls.push('artifact-put');assert.equal(command.input.IfNoneMatch,'*');if(artifacts.has(path.Key!))throw new Error('synthetic existing artifact');
    const row={body:String(command.input.Body),version:'artifact-'+(artifacts.size+1)};artifacts.set(path.Key!,row);return{...metadata(),VersionId:row.version};}
   calls.push('artifact-get');const row=artifacts.get(path.Key!)!;assert.equal(command.input.VersionId,row.version);
   return{...metadata(),VersionId:row.version,ContentLength:Buffer.byteLength(row.body),Body:Readable.from([Buffer.from(row.body)])};
  }
  if(command instanceof GetObjectCommand){reads++;calls.push('get');assert.equal(command.input.VersionId,undefined);
   assert.equal(command.input.ChecksumMode,'ENABLED');const body=JSON.stringify(value);
   return{...metadata(),ContentLength:Buffer.byteLength(body),Body:Readable.from([Buffer.from(body)])};
  }
  puts++;calls.push('put');assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.IfMatch,metadata().ETag);assert.equal(command.input.IfNoneMatch,undefined);
  assert.equal(command.input.SSEKMSKeyId,config.kmsKeyArn);assert.equal(command.input.ServerSideEncryption,'aws:kms');
  assert.equal(command.input.ChecksumSHA256,createHash('sha256').update(String(command.input.Body)).digest('base64'));
  value=JSON.parse(String(command.input.Body));version++;return metadata();
 });
 const store=new S3ManagedMaintenanceControl(config,credentials,client);
 const provider={configurationDigest:()=>hash('provider-registry'),suspend:async()=>{calls.push('suspend');},
  observeSuspended:async()=>{calls.push('services-observe');return{observationDigest:hash('services')};}};
 const database={configurationDigest:()=>hash('db-registry'),close:async()=>{calls.push('database-close');},
  invalidatePasswords:async()=>{calls.push('password-invalidate');},
  observePasswordsInvalidated:async()=>{calls.push('database-observe');return{observationDigest:hash('database'),passwordCredentialsInvalidated:true};}};
 const storage={configurationDigest:()=>hash('storage-registry'),readProofScope:()=>({installationId:operation.installationId,projectRef:'abcdefghijklmnopqrst',captureKeyId:'11111111-1111-4111-8111-111111111111',secretWriterIds:['22222222-2222-4222-8222-222222222222']}),close:async()=>{calls.push('storage-close');},
  observeClosed:async()=>{calls.push('storage-observe');return{observationDigest:hash('storage'),configuredAccessPathsObservedClosed:true};}};
 const proof={configurationDigest:()=>hash('proof-registry'),assertStorageScope:(_raw:unknown)=>{},
  assertBaseline:(raw:unknown,_binding?:unknown)=>raw as {body:string;sha256:string},assertObservation:(raw:unknown,_pin:string)=>raw as {body:string;sha256:string},
  baseline:async(_caller?:AbortSignal,maintenance?:unknown)=>{calls.push('read-baseline');const body=JSON.stringify({format:1,kind:'SUPABASE_CREDENTIAL_READ_BASELINE_V1',
   configurationDigest:hash('proof-registry'),credentialCount:2,capturedAt:new Date().toISOString(),canarySha256:hash('canary'),byteLength:86,...(maintenance?{maintenance}:{})});
   return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};},
  verifyReadRefusal:async(_body:string,pin:string)=>{calls.push('read-proof');const core={kind:'SUPABASE_CREDENTIAL_READ_REFUSAL_V1',
   configurationDigest:hash('proof-registry'),baselineSha256:pin,observedAt:new Date().toISOString(),
   refusals:[{credentialId:'22222222-2222-4222-8222-222222222222',status:401 as const}]};
   return{...core,observationDigest:hash(JSON.stringify(core)),credentialReadRefusalsObserved:true,
    coverage:'EXPLICIT_MODERN_SECRET_READS_ONLY',writeRejectionVerified:false,signedCapabilitiesRevoked:false,
    inFlightWritesDrained:false,wholeStorageQuiesced:false,actionAuthorized:false};}};
 const writeOperations={baseline:async(maintenance:unknown)=>{calls.push('write-baseline');const body=JSON.stringify({format:1,kind:'SUPABASE_STANDARD_WRITE_BASELINE_V1',
  configurationDigest:hash('write-registry'),maintenance,capturedAt:new Date().toISOString(),credentialIds:storage.readProofScope().secretWriterIds,
  payloadSha256:hash('initial'),updatePayloadSha256:hash('updated'),operations:['CREATE','UPDATE','DELETE']});return{body,sha256:hash(body)};},
  verifyWriteRefusal:async(_body:string,pin:string)=>{calls.push('write-proof');const core={kind:'SUPABASE_STANDARD_WRITE_REFUSAL_V1',configurationDigest:hash('write-registry'),
   baselineSha256:pin,observedAt:new Date().toISOString(),refusals:storage.readProofScope().secretWriterIds.map(credentialId=>({credentialId,create:401,update:403,delete:401}))};
   return{...core,observationDigest:hash(JSON.stringify(core)),standardWriteRefusalsObserved:true,coverage:'EXPLICIT_MODERN_SECRET_STANDARD_WRITES_ONLY',retainedSyntheticObjects:core.refusals.length,
    writeRejectionVerified:false,signedCapabilitiesRevoked:false,inFlightWritesDrained:false,wholeStorageQuiesced:false,actionAuthorized:false};}};
 const write={configurationDigest:()=>hash('write-factory'),assertStorageScope:(_raw:unknown)=>{},forAttempt:(maintenance:unknown)=>({
  probe:{baseline:()=>writeOperations.baseline(maintenance),verifyWriteRefusal:writeOperations.verifyWriteRefusal,
   assertBaseline:(raw:unknown)=>raw as {body:string;sha256:string},assertObservation:(_raw:unknown,_pin:string)=>{}},
  evidence:new S3ManagedWriteEvidence({...config,maintenance,probeRegistryDigest:hash('write-registry')},credentials,client)})};
 const coordinator=new ManagedBackendMaintenance(operation,provider as never,database as never,store,storage as never,proof as never,write as never);
 value.planDigest=coordinator.planDigest();
 return{store,provider,database,storage,proof,write,writeOperations,artifacts,coordinator,calls,metadata,get value(){return value;},set value(next){value=next;},
  get puts(){return puts;},get reads(){return reads;},setFault:(next:typeof fault)=>{fault=next;},
  commit:(command:PutObjectCommand)=>{value=JSON.parse(String(command.input.Body));version++;return metadata();}};
}

test('managed shutdown records an independent attempt before provider/database mutation and never repeats it',async()=>{
 const f=fixture();const result=await f.coordinator.close();
 assert.equal(result.phase,'OBSERVED_CLOSED');assert.equal(f.puts,4);
 assert.equal(result.databasePasswordCredentialsInvalidated,true);
 assert.equal(result.storageAccessPathsObservedClosed,true);assert.ok(f.value.observations);
 assert.equal(result.credentialReadRefusalsObserved,true);assert.ok(f.value.readBaseline);assert.ok(f.value.readObservation);
 assert.ok(f.calls.indexOf('read-baseline')<f.calls.indexOf('suspend'));
 assert.ok(f.calls.indexOf('put')<f.calls.indexOf('suspend'));
 assert.ok(f.calls.indexOf('suspend')<f.calls.indexOf('database-close'));
 assert.ok(f.calls.indexOf('database-close')<f.calls.indexOf('password-invalidate'));
 assert.ok(f.calls.indexOf('password-invalidate')<f.calls.indexOf('storage-close'));
 assert.ok(f.calls.indexOf('storage-close')<f.calls.indexOf('services-observe'));
 assert.ok(f.calls.indexOf('password-invalidate')<f.calls.indexOf('services-observe'));
 assert.ok(f.calls.indexOf('database-observe')<f.calls.lastIndexOf('put'));
 for(const flag of ['wholeBackendQuiesced','credentialRotationVerified','currentTenantAuthorityVerified','sourceHostFenced','reopeningAuthorised','actionAuthorized'])assert.equal(result[flag as keyof typeof result],false);
 const mutations=f.calls.filter(s=>['put','suspend','database-close','password-invalidate','storage-close'].includes(s)).length;
 const inspection=await f.coordinator.inspect();assert.equal(inspection.phase,'OBSERVED_CLOSED');
 await assert.rejects(f.coordinator.close());
 assert.equal(f.calls.filter(s=>['put','suspend','database-close','password-invalidate','storage-close'].includes(s)).length,mutations);
});
test('lost durable baseline acknowledgement blocks all shutdown mutations and preserves the original baseline',async()=>{
 const f=fixture();f.setFault(command=>{
  if(command instanceof PutObjectCommand&&JSON.parse(String(command.input.Body)).phase==='BASELINED'){
   f.commit(command);throw new Error('PRIVATE lost baseline publication ACK');
  }
 });
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'BASELINED');
 assert.ok(f.value.readBaseline);assert.equal(f.value.observations,null);
 assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('storage-close'),false);
 f.setFault(undefined);const before=f.puts;
 const fresh=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never);
 await assert.rejects(fresh.close());assert.equal(f.puts,before);
 assert.equal(f.calls.filter(x=>x==='read-baseline').length,1);
});

test('lost independent acquisition acknowledgement never dispatches, even after a new coordinator reads the committed attempt',async()=>{
 const f=fixture();f.setFault(command=>{
  if(command instanceof PutObjectCommand){f.commit(command);throw new Error('PRIVATE lost S3 ack');}
 });
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'ATTEMPTED');
 f.setFault(undefined);
 const fresh=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never);
 await assert.rejects(fresh.close());assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('database-close'),false);
 const observed=await fresh.inspect();assert.equal(observed.phase,'ATTEMPTED');assert.equal(observed.recordedObservations,null);
});

test('provider/database/recording failures retain attempt and forbid repeat or automatic compensation',async()=>{
 for(const stage of ['suspend','database-close','password-invalidate','storage-close','read-proof','services-observe','database-observe','storage-observe','record'] as const){
  const f=fixture();
  const fail=async()=>{throw new Error('PRIVATE uncertain external mutation');};
  if(stage==='suspend')f.provider.suspend=fail;
  if(stage==='database-close')f.database.close=fail;
  if(stage==='password-invalidate')f.database.invalidatePasswords=fail;
  if(stage==='storage-close')f.storage.close=fail;
  if(stage==='read-proof')f.proof.verifyReadRefusal=fail;
  if(stage==='storage-observe')f.storage.observeClosed=fail;
  if(stage==='services-observe')f.provider.observeSuspended=fail;
  if(stage==='database-observe')f.database.observePasswordsInvalidated=fail;
  if(stage==='record')f.setFault(command=>{
   if(command instanceof PutObjectCommand&&JSON.parse(String(command.input.Body)).phase==='OBSERVED_CLOSED'){
    f.commit(command);throw new Error('lost final commit');
   }
  });
  await assert.rejects(f.coordinator.close(),error=>error instanceof Error&&!error.message.includes('PRIVATE')&&error.cause===undefined);
  assert.equal(f.value.phase,stage==='record'?'OBSERVED_CLOSED':'WRITE_BASELINED');
  f.setFault(undefined);const mutations=f.calls.filter(s=>['put','suspend','database-close','password-invalidate','storage-close'].includes(s)).length;
  await assert.rejects(f.coordinator.close());assert.equal(f.calls.filter(s=>['put','suspend','database-close','password-invalidate','storage-close'].includes(s)).length,mutations);
  if(stage==='suspend')assert.equal(f.calls.includes('database-close'),false);
  if(stage==='database-close')assert.equal(f.calls.includes('password-invalidate'),false);
 }
});

test('maintenance plan binds copied installation/source/epoch and all component registries',async()=>{
 for(const stage of ['installation','source','epoch','provider','database','storage','proof','write'] as const){
  const f=fixture(),changed={...operation};
  if(stage==='installation')changed.installationId='different-installation';
  if(stage==='source')changed.sourceSha='2'.repeat(40);
  if(stage==='epoch')changed.maintenanceEpoch=2;
  if(stage==='provider')f.provider.configurationDigest=()=>hash('different-provider');
  if(stage==='database')f.database.configurationDigest=()=>hash('different-database');
  if(stage==='storage')f.storage.configurationDigest=()=>hash('different-storage');
  if(stage==='proof')f.proof.configurationDigest=()=>hash('different-proof');
  if(stage==='write')f.write.configurationDigest=()=>hash('different-write');
  await assert.rejects(new ManagedBackendMaintenance(changed,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never).close());
  assert.equal(f.puts,0);assert.equal(f.calls.includes('suspend'),false);
 }
 const f=fixture(),input={...operation},coordinator=new ManagedBackendMaintenance(input,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never);
 const before=coordinator.planDigest();input.sourceSha='2'.repeat(40);assert.equal(coordinator.planDigest(),before);
});

test('maintenance store refuses absent or unauthenticated control, wrong metadata, malformed bytes and conditional-write loss',async()=>{
 for(const mode of ['missing','key','version','delete','length','utf8','noncanonical','binding','phase','etag','oversize','412','409'] as const){
  const f=fixture();f.setFault(command=>{
   if(command instanceof PutObjectCommand&&['412','409'].includes(mode))throw{$metadata:{httpStatusCode:Number(mode)}};
   if(command instanceof PutObjectCommand)return;
   if(mode==='missing')throw{name:'NoSuchKey',$metadata:{httpStatusCode:404}};
   if(['412','409'].includes(mode))return;
   let text=JSON.stringify(f.value),metadata:Record<string,unknown>={...f.metadata()};
   if(mode==='key')metadata.SSEKMSKeyId='wrong-key';
   if(mode==='version')metadata.VersionId='null';
   if(mode==='delete')metadata.DeleteMarker=true;
   if(mode==='etag')metadata.ETag='unquoted';
   if(mode==='binding')text=JSON.stringify({...f.value,installationId:'other-installation'});
   if(mode==='phase')text=JSON.stringify({...f.value,phase:'ATTEMPTED'});
   if(mode==='noncanonical')text=' '+text;
   const bytes=mode==='utf8'?Buffer.from([0xff]):Buffer.from(text);
   return{...metadata,ContentLength:mode==='oversize'?8193:bytes.length+(mode==='length'?1:0),Body:Readable.from([bytes])};
  });
  await assert.rejects(f.coordinator.close());assert.equal(f.calls.includes('suspend'),false,mode);
 }
});

test('maintenance readback rejects a competing publication and inspection rejects a head changed during fresh checks',async()=>{
 const f=fixture();let changed=false;
 f.setFault(command=>{
  if(command instanceof PutObjectCommand){const metadata=f.commit(command);f.value={...f.value,publicationId:randomUUID()};changed=true;return metadata;}
 });
 await assert.rejects(f.coordinator.close());assert.equal(changed,true);assert.equal(f.calls.includes('suspend'),false);
 f.setFault(undefined);
 f.database.observePasswordsInvalidated=async()=>{f.value={...f.value,publicationId:randomUUID()};return{observationDigest:hash('db'),passwordCredentialsInvalidated:true};};
 await assert.rejects(f.coordinator.inspect());
});

test('maintenance SDK has no ambient endpoint/credential fallback and sanitises read deadlines',async t=>{
 assert.throws(()=>new S3ManagedMaintenanceControl(config,undefined as never));
 assert.throws(()=>new S3ManagedMaintenanceControl({...config,accountId:'000000000000'},credentials));
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture();f.setFault(()=>new Promise((_resolve,reject)=>setTimeout(()=>reject(new Error('PRIVATE deadline')),16000)));
 const result=assert.rejects(f.coordinator.close(),error=>error instanceof Error&&!error.message.includes('PRIVATE'));
 t.mock.timers.tick(16001);await result;assert.equal(f.calls.includes('suspend'),false);
});

test('two concurrent maintenance callers cannot both dispatch from one READY record',async()=>{
 const f=fixture(),other=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never);
 const outcomes=await Promise.allSettled([f.coordinator.close(),other.close()]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(f.calls.filter(c=>c==='suspend').length,1);assert.equal(f.calls.filter(c=>c==='database-close').length,1);
 assert.equal(f.value.phase,'OBSERVED_CLOSED');
});

test('maintenance deadline destroys a provider body that never finishes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),body=new Readable({read(){}});
 f.setFault(command=>command instanceof GetObjectCommand?
  {...f.metadata(),ContentLength:100,Body:body}:undefined);
 const refusal=assert.rejects(f.coordinator.close());
 await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(15001);await refusal;
 assert.equal(body.destroyed,true);assert.equal(f.calls.includes('suspend'),false);
});

test('default maintenance SDK pins Ireland endpoint, single attempt and no region redirect',async()=>{
 const interception=mock.method(S3Client.prototype,'send',async function(this:S3Client){
  assert.equal(await this.config.region(),'eu-west-1');assert.equal(await this.config.maxAttempts(),1);
  assert.equal(this.config.followRegionRedirects,false);
  const endpoint=await this.config.endpoint!();assert.equal(endpoint.protocol,'https:');assert.equal(endpoint.hostname,'s3.eu-west-1.amazonaws.com');
  throw new Error('synthetic read refusal');
 });
 try{await assert.rejects(new S3ManagedMaintenanceControl(config,credentials).observe());}
 finally{interception.mock.restore();}
});

test('legacy closure-only plan cannot authorise the password-invalidation workflow',async()=>{
 const f=fixture();
 f.value={...f.value,planDigest:hash(JSON.stringify({format:1,...operation,
  provider:f.provider.configurationDigest(),database:f.database.configurationDigest()}))};
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.includes('suspend'),false);
});
test('legacy four-service protocol2 cannot dispatch the new named storage-key workflow',async()=>{
 const f=fixture();
 f.value={...f.value,planDigest:hash(JSON.stringify({format:2,...operation,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',provider:f.provider.configurationDigest(),database:f.database.configurationDigest()}))};
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.includes('suspend'),false);
 assert.equal(f.calls.includes('storage-close'),false);
});
test('protocol4 inspection cannot promote an incomplete recorded storage observation',async()=>{
 const f=fixture();await f.coordinator.close();
 const original=f.value.observations as Record<string,unknown>,changed={...original};delete changed.storageDigest;
 f.value={...f.value,observations:changed};const before=f.calls.filter(x=>x==='storage-observe').length;
 await assert.rejects(f.coordinator.inspect());assert.equal(f.calls.filter(x=>x==='storage-observe').length,before);
});
test('protocol3 cannot dispatch protocol4 baseline work',async()=>{
 const f=fixture();f.value={...f.value,planDigest:hash(JSON.stringify({format:3,...operation,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',
  provider:f.provider.configurationDigest(),database:f.database.configurationDigest(),storage:f.storage.configurationDigest()}))};
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.includes('read-baseline'),false);
});
test('failed baseline never shuts writers; later inspection cannot invent a missing original refusal report',async()=>{
 const first=fixture();first.proof.baseline=async()=>{throw new Error('synthetic baseline unavailable');};
 await assert.rejects(first.coordinator.close());assert.equal(first.value.phase,'ATTEMPTED');assert.equal(first.calls.includes('suspend'),false);
 const f=fixture(),verify=f.proof.verifyReadRefusal;f.proof.verifyReadRefusal=async()=>{throw new Error('synthetic refusal observation lost');};
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'WRITE_BASELINED');assert.equal(f.value.readObservation,undefined);
 f.proof.verifyReadRefusal=verify;const before=f.puts,baseline=f.value.readBaseline?.sha256;
 const inspected=await f.coordinator.inspect();assert.equal(inspected.phase,'WRITE_BASELINED');assert.equal(inspected.recordedReadObservation,null);
 assert.ok(inspected.freshReadObservation);assert.equal(f.puts,before);assert.equal(f.value.readBaseline?.sha256,baseline);
});
test('fifty read refusals fit the bounded independent head and oversized updates cannot corrupt the saved baseline',async()=>{
 const f=fixture(),baseline=f.proof.baseline,verify=f.proof.verifyReadRefusal;
 const scope=f.storage.readProofScope();f.storage.readProofScope=()=>({...scope,secretWriterIds:Array.from({length:50},(_,i)=>'22222222-2222-4222-8222-'+String(i+1).padStart(12,'0'))});
 f.proof.baseline=async(caller,binding)=>{const value=await baseline(caller,binding),decoded=JSON.parse(value.body);decoded.credentialCount=51;
  const body=JSON.stringify(decoded);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
 f.proof.verifyReadRefusal=async(body,pin)=>{const value=await verify(body,pin),refusals=Array.from({length:50},(_,i)=>({credentialId:'22222222-2222-4222-8222-'+String(i+1).padStart(12,'0'),status:401 as const}));
  const core={kind:value.kind,configurationDigest:value.configurationDigest,baselineSha256:pin,observedAt:value.observedAt,refusals};
  return{...value,...core,observationDigest:hash(JSON.stringify(core))};};
 await f.coordinator.close();assert.ok(Buffer.byteLength(JSON.stringify(f.value))<=8192);
 assert.equal(JSON.parse(f.value.readObservation!.body).refusals.length,50);
 const g=fixture(),attempt=await g.store.acquire(operation.installationId,g.coordinator.planDigest(),1),b=await g.proof.baseline(undefined,{attemptId:attempt.value.attemptId!,planDigest:g.coordinator.planDigest(),sourceSha:operation.sourceSha,maintenanceEpoch:1});
 const pinned=await g.store.recordReadBaseline(attempt.value.attemptId!,attempt.revision,b),report=await g.proof.verifyReadRefusal(b.body,b.sha256);
 const oversizedTime='2026-10-17T00:00:00.'+'0'.repeat(9000)+'Z';z.string().datetime().parse(oversizedTime);
 const before=g.puts;
 await assert.rejects(g.store.recordObservedClosed(attempt.value.attemptId!,pinned.revision,{servicesDigest:hash('services'),databaseDigest:hash('database'),storageDigest:hash('storage'),readProofDigest:report.observationDigest,observedAt:oversizedTime},report));
 assert.equal(g.puts,before);assert.equal(g.value.phase,'BASELINED');assert.equal(g.value.readBaseline?.sha256,b.sha256);
});
test('a substituted baseline link refuses even when its report hashes and observation digest were recomputed',async()=>{
 const f=fixture();await f.coordinator.close();const report=JSON.parse(f.value.readObservation!.body);
 report.baselineSha256='0'.repeat(64);const core={kind:report.kind,configurationDigest:report.configurationDigest,baselineSha256:report.baselineSha256,observedAt:report.observedAt,refusals:report.refusals};
 report.observationDigest=hash(JSON.stringify(core));const body=JSON.stringify(report);
 f.value={...f.value,readObservation:{body,sha256:hash(body)},observations:{...(f.value.observations as object),readProofDigest:report.observationDigest}};
 const before=f.calls.filter(x=>x==='storage-observe').length;await assert.rejects(f.coordinator.inspect());
 assert.equal(f.calls.filter(x=>x==='storage-observe').length,before);
});

test('independent baseline publication rejects copied attempt, epoch or plan without changing the head',async()=>{
 for(const changed of [{attemptId:randomUUID()},{maintenanceEpoch:2},{planDigest:'3'.repeat(64)}]){
  const f=fixture(),attempt=await f.store.acquire(operation.installationId,f.coordinator.planDigest(),1);
  const b=await f.proof.baseline(undefined,{attemptId:attempt.value.attemptId!,planDigest:f.coordinator.planDigest(),sourceSha:operation.sourceSha,maintenanceEpoch:1});
  const value=JSON.parse(b.body);value.maintenance={...value.maintenance,...changed};const body=JSON.stringify(value),before=f.puts;
  await assert.rejects(f.store.recordReadBaseline(attempt.value.attemptId!,attempt.revision,{body,sha256:hash(body)}));
  assert.equal(f.puts,before);assert.equal(f.value.phase,'ATTEMPTED');assert.equal(f.calls.includes('suspend'),false);
 }
});

test('write publication or head ACK loss never dispatches shutdown and cannot be promoted by inspection',async()=>{
 for(const stage of ['artifact','head'] as const){
  const f=fixture();f.setFault(command=>{
   if(command instanceof PutObjectCommand&&stage==='artifact'&&command.input.Key!.endsWith('write-baseline.json')){
    f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'committed-unknown'});throw new Error('PRIVATE artifact ACK lost');
   }
   if(command instanceof PutObjectCommand&&stage==='head'&&JSON.parse(String(command.input.Body)).phase==='WRITE_BASELINED'){
    f.commit(command);throw new Error('PRIVATE head ACK lost');
   }
  });
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,stage==='head'?'WRITE_BASELINED':'BASELINED');
  assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('storage-close'),false);
  f.setFault(undefined);const before=f.calls.filter(c=>['write-baseline','write-proof','artifact-put','put'].includes(c)).length;
  const observed=await f.coordinator.inspect();assert.equal(observed.recordedStandardWriteRefusalsObserved,false);
  assert.equal(observed.freshStandardWriteRefusalsObserved,false);await assert.rejects(f.coordinator.close());
  assert.equal(f.calls.filter(c=>['write-baseline','write-proof','artifact-put','put'].includes(c)).length,before);
 }
});

test('write-report ACK loss stays consumed and inspection does not run active write probes',async()=>{
 const f=fixture();f.setFault(command=>{
  if(command instanceof PutObjectCommand&&command.input.Key!.endsWith('write-observation.json')){
   f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'committed-report'});throw new Error('PRIVATE report ACK lost');
  }
 });
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'WRITE_BASELINED');assert.equal(f.value.writeObservationPin,undefined);
 f.setFault(undefined);const mutations=f.calls.filter(c=>['write-baseline','write-proof','artifact-put','put'].includes(c)).length;
 const observed=await f.coordinator.inspect();assert.equal(observed.recordedWriteObservation,null);assert.equal(observed.freshStandardWriteRefusalsObserved,false);
 assert.equal(f.calls.filter(c=>['write-baseline','write-proof','artifact-put','put'].includes(c)).length,mutations);
});

test('protocol4 read-only plan cannot dispatch newly required active write probes',async()=>{
 const f=fixture();f.value={...f.value,planDigest:hash(JSON.stringify({format:4,...operation,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',
  provider:f.provider.configurationDigest(),database:f.database.configurationDigest(),storage:f.storage.configurationDigest(),readProof:f.proof.configurationDigest()}))};
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.includes('write-baseline'),false);
});
test('failed active write baseline or refusal cannot bypass its durable barrier',async()=>{
 const first=fixture();first.writeOperations.baseline=async()=>{throw new Error('synthetic write baseline failure');};
 await assert.rejects(first.coordinator.close());assert.equal(first.value.phase,'BASELINED');assert.equal(first.calls.includes('suspend'),false);
 const f=fixture();f.writeOperations.verifyWriteRefusal=async()=>{throw new Error('synthetic refusal failure');};
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'WRITE_BASELINED');assert.ok(f.value.writeBaselinePin);assert.equal(f.value.writeObservationPin,undefined);
 const before=f.calls.filter(c=>c==='write-proof').length;const observed=await f.coordinator.inspect();assert.equal(observed.recordedWriteObservation,null);
 assert.equal(f.calls.filter(c=>c==='write-proof').length,before);
});
async function prepareSignedHead(){
 const f=fixture(),attempt=await f.store.acquire(operation.installationId,f.coordinator.planDigest(),1);
 const binding={attemptId:attempt.value.attemptId!,planDigest:f.coordinator.planDigest(),sourceSha:operation.sourceSha,maintenanceEpoch:1};
 const baseline=await f.proof.baseline(undefined,binding);
 const read=await f.store.recordReadBaseline(binding.attemptId,attempt.revision,baseline);
 const writePin={kind:'BASELINE' as const,versionId:'synthetic-write-version',sha256:hash('write-baseline'),byteLength:1024};
 const write=await f.store.recordWriteBaselinePin(binding.attemptId,read.revision,writePin);
 const signedPin={kind:'BASELINE' as const,versionId:'synthetic-signed-version',sha256:hash('signed-baseline'),byteLength:1024};
 const report=await f.proof.verifyReadRefusal(baseline.body,baseline.sha256);
 const observations={servicesDigest:hash('services'),databaseDigest:hash('database'),storageDigest:hash('storage'),readProofDigest:report.observationDigest,writeProofDigest:hash('write-report'),signedProofDigest:hash('signed-report'),observedAt:new Date().toISOString()};
 const writeReportPin={...writePin,kind:'OBSERVATION' as const,sha256:hash('write-report')};
 const signedReportPin={...signedPin,kind:'OBSERVATION' as const,sha256:hash('signed-report')};
 return{f,binding,write,signedPin,report,observations,writeReportPin,signedReportPin};
}

test('signed baseline head CAS retains exact original pins and requires both reports at completion',async()=>{
 const {f,binding,write,signedPin,report,observations,writeReportPin,signedReportPin}=await prepareSignedHead();
 const ready=await f.store.recordSignedBaselinePin(binding.attemptId,write.revision,signedPin);
 assert.equal(ready.value.phase,'SIGNED_BASELINED');assert.deepEqual(ready.value.signedBaselinePin,signedPin);
 const before=f.puts;
 await assert.rejects(f.store.recordObservedClosed(binding.attemptId,ready.revision,observations,report,writeReportPin));
 await assert.rejects(f.store.recordObservedClosed(binding.attemptId,ready.revision,{...observations,signedProofDigest:undefined},report,writeReportPin,signedReportPin));
 await assert.rejects(f.store.recordObservedClosed(binding.attemptId,ready.revision,observations,report,undefined,signedReportPin));
 assert.equal(f.puts,before);
 const complete=await f.store.recordObservedClosed(binding.attemptId,ready.revision,observations,report,writeReportPin,signedReportPin);
 assert.equal(complete.value.phase,'OBSERVED_CLOSED');assert.deepEqual(complete.value.signedObservationPin,signedReportPin);
 const n=f.puts,observed=await f.store.observe();
 assert.deepEqual(observed.value.signedBaselinePin,signedPin);assert.equal(f.puts,n);assert.equal(f.calls.includes('suspend'),false);
});

test('signed pin transition rejects wrong attempt revision kind and premature completion without writing',async()=>{
 const {f,binding,write,signedPin,report,observations,writeReportPin,signedReportPin}=await prepareSignedHead(),before=f.puts;
 for(const [attempt,revision,pin] of [[randomUUID(),write.revision,signedPin],[binding.attemptId,'0'.repeat(64),signedPin],[binding.attemptId,write.revision,signedReportPin]] as const){
  await assert.rejects(f.store.recordSignedBaselinePin(attempt,revision,pin));
 }
 await assert.rejects(f.store.recordObservedClosed(binding.attemptId,write.revision,observations,report,writeReportPin,signedReportPin));
 assert.equal(f.puts,before);assert.equal(f.value.phase,'WRITE_BASELINED');
 const early=fixture(),attempt=await early.store.acquire(operation.installationId,early.coordinator.planDigest(),1),n=early.puts;
 await assert.rejects(early.store.recordSignedBaselinePin(attempt.value.attemptId!,attempt.revision,signedPin));assert.equal(early.puts,n);
});

test('lost signed head acknowledgement stays consumed and cannot authorise a fresh coordinator shutdown',async()=>{
 const {f,binding,write,signedPin}=await prepareSignedHead();
 f.setFault(command=>{
  if(command instanceof PutObjectCommand&&JSON.parse(String(command.input.Body)).phase==='SIGNED_BASELINED'){
   f.commit(command);throw new Error('synthetic lost signed head acknowledgement');
  }
 });
 await assert.rejects(f.store.recordSignedBaselinePin(binding.attemptId,write.revision,signedPin));
 f.setFault(undefined);const before=f.puts,observed=await f.store.observe();
 assert.equal(observed.value.phase,'SIGNED_BASELINED');assert.equal(observed.value.signedObservationPin,undefined);
 await assert.rejects(f.store.recordSignedBaselinePin(binding.attemptId,write.revision,signedPin));
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,before);assert.equal(f.calls.includes('suspend'),false);
});

test('signed evidence cannot appear in earlier phases or vanish from a completed signed head',async()=>{
 for(const phase of ['READY','ATTEMPTED','BASELINED','WRITE_BASELINED']){
  const {f,signedPin}=await prepareSignedHead();f.value={...f.value,phase,signedBaselinePin:signedPin};
  await assert.rejects(f.store.observe());
 }
 const {f,binding,write,signedPin,observations,report,writeReportPin,signedReportPin}=await prepareSignedHead();
 const ready=await f.store.recordSignedBaselinePin(binding.attemptId,write.revision,signedPin);
 await f.store.recordObservedClosed(binding.attemptId,ready.revision,observations,report,writeReportPin,signedReportPin);
 f.value={...f.value,signedObservationPin:undefined};await assert.rejects(f.store.observe());
});
