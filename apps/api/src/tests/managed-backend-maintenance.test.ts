import {managedSignedResumableFixture} from './fixtures/managed-signed-resumable.js';
import {resumableCohortFixture} from './fixtures/resumable-cohort.js';
import type {ResumableCohortPin} from '../services/resumable-cohort-contract.js';
import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {S3ManagedMaintenanceControl} from '../services/managed-maintenance-control.js';
import {z} from 'zod';
import {ManagedBackendMaintenance} from '../services/managed-backend-maintenance.js';
import {S3ManagedWriteEvidence,type ManagedWriteEvidencePin} from '../services/managed-write-evidence.js';
import {managedSignedFixture} from './fixtures/managed-signed-upload.js';
import type {SignedUploadEvidencePin} from '../services/signed-upload-evidence.js';

const config={installationId:'synthetic-installation',bucket:'synthetic-maintenance',accountId:'123456789012',
 kmsKeyArn:'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111'};
const credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'};
const operation={installationId:config.installationId,sourceSha:'1'.repeat(40),maintenanceEpoch:1};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(options:{retired?:{id:string;secret:string}[]}={}){
 const retired=options.retired??[{id:'22222222-2222-4222-8222-222222222222',secret:'sb_secret_'+'b'.repeat(40)}];
 let value={format:1,installationId:config.installationId,maintenanceEpoch:1,planDigest:'1'.repeat(64),
  phase:'READY',attemptId:null as string|null,observations:null as unknown,readBaseline:undefined as {body:string;sha256:string}|undefined,readObservation:undefined as {body:string;sha256:string}|undefined,
  writeBaselinePin:undefined as ManagedWriteEvidencePin|undefined,writeObservationPin:undefined as ManagedWriteEvidencePin|undefined,
  signedBaselinePin:undefined as SignedUploadEvidencePin|undefined,signedObservationPin:undefined as SignedUploadEvidencePin|undefined,resumableBaselinePin:undefined as ResumableCohortPin|undefined,resumableObservationPin:undefined as ResumableCohortPin|undefined,signedResumableBaselinePin:undefined as SignedUploadEvidencePin|undefined,signedResumableObservationPin:undefined as SignedUploadEvidencePin|undefined,publicationId:randomUUID()};
 let version=1,reads=0,puts=0,storageClosed=false;
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
 const storage={configurationDigest:()=>hash('storage-registry'),readProofScope:()=>({installationId:operation.installationId,projectRef:'abcdefghijklmnopqrst',captureKeyId:'11111111-1111-4111-8111-111111111111',secretWriterIds:retired.map(k=>k.id)}),close:async()=>{calls.push('storage-close');storageClosed=true;},
  observeClosed:async()=>{calls.push('storage-observe');return{observationDigest:hash('storage'),configuredAccessPathsObservedClosed:true};}};
 const proof={configurationDigest:()=>hash('proof-registry'),assertStorageScope:(_raw:unknown)=>{},
  assertBaseline:(raw:unknown,_binding?:unknown)=>raw as {body:string;sha256:string},assertObservation:(raw:unknown,_pin:string)=>raw as {body:string;sha256:string},
  baseline:async(_caller?:AbortSignal,maintenance?:unknown)=>{calls.push('read-baseline');const body=JSON.stringify({format:1,kind:'SUPABASE_CREDENTIAL_READ_BASELINE_V1',
   configurationDigest:hash('proof-registry'),credentialCount:retired.length+1,capturedAt:new Date().toISOString(),canarySha256:hash('canary'),byteLength:86,...(maintenance?{maintenance}:{})});
   return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};},
  verifyReadRefusal:async(_body:string,pin:string)=>{calls.push('read-proof');const core={kind:'SUPABASE_CREDENTIAL_READ_REFUSAL_V1',
   configurationDigest:hash('proof-registry'),baselineSha256:pin,observedAt:new Date().toISOString(),
   refusals:retired.map(k=>({credentialId:k.id,status:401 as const}))};
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
 const signedFixture=managedSignedFixture(config,client,calls),signed=signedFixture.factory();
 const resumableFixture=resumableCohortFixture({storage:config,client,events:calls,retired,isRetiredAllowed:()=>!storageClosed});
 const signedTusFixture=managedSignedResumableFixture(signedFixture,config,client,calls);
 const coordinator=new ManagedBackendMaintenance(operation,provider as never,database as never,store,storage as never,proof as never,write as never,signed,resumableFixture.factory(),signedTusFixture.factory());
 value.planDigest=coordinator.planDigest();
 return{store,provider,database,storage,proof,write,signed,signedFixture,resumableFixture,signedTusFixture,writeOperations,artifacts,coordinator,calls,metadata,get value(){return value;},set value(next){value=next;},
  get puts(){return puts;},get reads(){return reads;},setFault:(next:typeof fault)=>{fault=next;},
  commit:(command:PutObjectCommand)=>{value=JSON.parse(String(command.input.Body));version++;return metadata();}};
}

test('managed shutdown records an independent attempt before provider/database mutation and never repeats it',async()=>{
 const f=fixture();const result=await f.coordinator.close();
 assert.equal(result.phase,'OBSERVED_CLOSED');assert.equal(f.puts,7);
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
 const fresh=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory());
 await assert.rejects(fresh.close());assert.equal(f.puts,before);
 assert.equal(f.calls.filter(x=>x==='read-baseline').length,1);
});

test('lost independent acquisition acknowledgement never dispatches, even after a new coordinator reads the committed attempt',async()=>{
 const f=fixture();f.setFault(command=>{
  if(command instanceof PutObjectCommand){f.commit(command);throw new Error('PRIVATE lost S3 ack');}
 });
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'ATTEMPTED');
 f.setFault(undefined);
 const fresh=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory());
 await assert.rejects(fresh.close());assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('database-close'),false);
 f.signedFixture.forceRevoked(); // explicit fixture resolution, not inspection or a resumed command.
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
  assert.equal(f.value.phase,stage==='record'?'OBSERVED_CLOSED':'SIGNED_RESUMABLE_BASELINED');
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
  await assert.rejects(async()=>new ManagedBackendMaintenance(changed,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory()).close());
  assert.equal(f.puts,0);assert.equal(f.calls.includes('suspend'),false);
 }
 const f=fixture(),input={...operation},coordinator=new ManagedBackendMaintenance(input,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory());
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
 const f=fixture(),other=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory());
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.readObservation,undefined);
 f.proof.verifyReadRefusal=verify;const before=f.puts,baseline=f.value.readBaseline?.sha256;
 const inspected=await f.coordinator.inspect();assert.equal(inspected.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(inspected.recordedReadObservation,null);
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
  f.setFault(undefined);f.signedFixture.forceRevoked();const before=f.calls.filter(c=>['write-baseline','write-proof','artifact-put','put'].includes(c)).length;
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.writeObservationPin,undefined);
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.ok(f.value.writeBaselinePin);assert.equal(f.value.writeObservationPin,undefined);
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
 const observations={servicesDigest:hash('services'),databaseDigest:hash('database'),storageDigest:hash('storage'),readProofDigest:report.observationDigest,writeProofDigest:hash('write-report'),signedProofDigest:hash('signed-report'),signingDigest:hash('signing-registry'),observedAt:new Date().toISOString()};
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

test('signed credential baseline and head ACK loss never starts shutdown or resumes the consumed attempt',async()=>{
 for(const stage of ['credential','baseline','head'] as const){
  const f=fixture();f.setFault(command=>{
   if(!(command instanceof PutObjectCommand))return;
   const suffix=stage==='credential'?'signed-upload-credential.json':'signed-baseline.json';
   if(stage!=='head'&&command.input.Key!.endsWith(suffix)){
    f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'committed-unknown-signed'});throw new Error('synthetic lost signed artifact ACK');
   }
   if(stage==='head'&&command.input.Key!.endsWith('/control.json')&&JSON.parse(String(command.input.Body)).phase==='SIGNED_BASELINED'){
    f.commit(command);throw new Error('synthetic lost signed baseline head ACK');
   }
  });
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,stage==='head'?'SIGNED_BASELINED':'WRITE_BASELINED');
  assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('signed-management-PATCH'),false);
  f.setFault(undefined);f.signedFixture.forceRevoked();
  const before=f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('signed-kms-')||c==='signed-storage-POST'||c==='signed-storage-PUT').length;
  await assert.rejects(f.coordinator.close());const observed=await f.coordinator.inspect();
  assert.equal(observed.recordedSignedObservation,null);assert.equal(observed.freshSignedUploadRefusalObserved,false);
  assert.equal(f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('signed-kms-')||c==='signed-storage-POST'||c==='signed-storage-PUT').length,before);
 }
});

test('lost signed report acknowledgement remains missing and fresh inspection never decrypts or repeats active signed probes',async()=>{
 const f=fixture();f.setFault(command=>{
  if(command instanceof PutObjectCommand&&command.input.Key!.endsWith('signed-observation.json')){
   f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'signed-report-lost-ack'});throw new Error('synthetic lost signed report ACK');
  }
 });
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.signedObservationPin,undefined);
 f.setFault(undefined);const before=f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('signed-kms-')||c==='signed-storage-POST'||c==='signed-storage-PUT').length;
 const observed=await f.coordinator.inspect();assert.equal(observed.recordedSignedObservation,null);assert.equal(observed.recordedTestedSignedUploadRefusalObserved,false);
 assert.equal(f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('signed-kms-')||c==='signed-storage-POST'||c==='signed-storage-PUT').length,before);
});

test('management key revocation cannot substitute for an actual original-token refusal',async()=>{
 const f=fixture();f.signedFixture.acceptOld=true;await assert.rejects(f.coordinator.close());
 assert.equal(f.signedFixture.revoked,true);assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.signedObservationPin,undefined);
 const mutations=f.calls.filter(c=>c==='signed-storage-PUT').length,observed=await f.coordinator.inspect();
 assert.equal(observed.recordedSignedObservation,null);assert.equal(observed.signedCapabilitiesRevoked,false);
 assert.equal(f.calls.filter(c=>c==='signed-storage-PUT').length,mutations);
});

test('protocol5 unsigned plan cannot dispatch the newly required signed workflow',async()=>{
 const f=fixture();f.value={...f.value,planDigest:hash(JSON.stringify({format:5,...operation,
  databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',writeProofPolicy:'EXACT_VERSION_BASELINE_PIN_BEFORE_REVOCATION_V1',
  provider:f.provider.configurationDigest(),database:f.database.configurationDigest(),storage:f.storage.configurationDigest(),readProof:f.proof.configurationDigest(),writeProof:f.write.configurationDigest()}))};
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.some(c=>c.startsWith('signed-storage-')),false);
});

test('lost signing-key acknowledgement cannot be promoted into a completed original-token test',async()=>{
 const f=fixture();f.signedFixture.loseRevocationAck=true;
 await assert.rejects(f.coordinator.close());assert.equal(f.signedFixture.revoked,true);assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.signedObservationPin,undefined);
 const mutations=f.calls.filter(c=>c==='signed-management-PATCH'||c==='signed-storage-PUT'||c.startsWith('signed-kms-')).length;
 const observed=await f.coordinator.inspect();assert.equal(observed.recordedTestedSignedUploadRefusalObserved,false);
 await assert.rejects(f.coordinator.close());assert.equal(f.calls.filter(c=>c==='signed-management-PATCH'||c==='signed-storage-PUT'||c.startsWith('signed-kms-')).length,mutations);
});

test('complete TUS manifest is acknowledged before shutdown and two configured credentials retain their original reports',async()=>{
 const f=fixture({retired:[{id:'22222222-2222-4222-8222-222222222222',secret:'sb_secret_'+'b'.repeat(40)},{id:'33333333-3333-4333-8333-333333333333',secret:'sb_secret_'+'c'.repeat(40)}]}),result=await f.coordinator.close();
 assert.equal(result.resumableCredentialCohortRefusalsObserved,true);assert.equal(result.resumableSessionsRevoked,false);
 assert.ok(f.value.resumableBaselinePin&&f.value.resumableObservationPin);assert.ok(Buffer.byteLength(JSON.stringify(f.value))<=8192);
 const baseline=[...f.artifacts.entries()].find(([key])=>key.endsWith('/resumable-cohort-baseline.json'))![1];assert.equal(JSON.parse(baseline.body).entries.length,2);
 const before=f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length;
 const inspected=await f.coordinator.inspect();assert.equal(inspected.recordedResumableCredentialCohortRefusalsObserved,true);assert.equal(inspected.freshResumableCredentialCohortRefusalsObserved,false);
 assert.equal(f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length,before);
});

test('lost TUS location child manifest or head ACK never starts shutdown and original inspection cannot resume it',async()=>{
 for(const stage of ['location','child','manifest','head'] as const){
  const f=fixture();f.setFault(command=>{
   if(!(command instanceof PutObjectCommand))return;
   const suffix=stage==='location'?'/resumable-location.json':stage==='child'?'/resumable-baseline.json':'/resumable-cohort-baseline.json';
   if(stage!=='head'&&command.input.Key!.endsWith(suffix)){
    f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'committed-unknown-tus'});throw new Error('synthetic lost TUS ACK');
   }
   if(stage==='head'&&command.input.Key!.endsWith('/control.json')&&JSON.parse(String(command.input.Body)).phase==='RESUMABLE_BASELINED'){
    f.commit(command);throw new Error('synthetic lost TUS head ACK');
   }
  });
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,stage==='head'?'RESUMABLE_BASELINED':'SIGNED_BASELINED');assert.equal(f.calls.includes('suspend'),false);
  f.setFault(undefined);f.signedFixture.forceRevoked();const before=f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length;
  await assert.rejects(f.coordinator.close());const observed=await f.coordinator.inspect();assert.equal(observed.recordedResumableObservation,null);assert.equal(observed.freshResumableCredentialCohortRefusalsObserved,false);
  assert.equal(f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length,before);
 }
});

test('lost original TUS child or aggregate report ACK remains absent at the parent and cannot be recreated by inspection',async()=>{
 for(const suffix of ['/resumable-observation.json','/resumable-cohort-observation.json']){
  const f=fixture();f.setFault(command=>{if(command instanceof PutObjectCommand&&command.input.Key!.endsWith(suffix)){f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'committed-unknown-tus-report'});throw new Error('synthetic report ACK lost');}});
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.resumableObservationPin,undefined);
  f.setFault(undefined);const before=f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length;
  const observed=await f.coordinator.inspect();assert.equal(observed.recordedResumableCredentialCohortRefusalsObserved,false);await assert.rejects(f.coordinator.close());
  assert.equal(f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length,before);
 }
});

test('storage metadata closure cannot substitute for actual TUS refusal and an incomplete completed head refuses',async()=>{
 const f=fixture();f.resumableFixture.allowRetiredAfterClose=true;await assert.rejects(f.coordinator.close());
 assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.resumableObservationPin,undefined);const observed=await f.coordinator.inspect();assert.equal(observed.recordedResumableObservation,null);assert.equal(observed.resumableSessionsRevoked,false);
 const good=fixture();await good.coordinator.close();good.value={...good.value,resumableObservationPin:undefined};await assert.rejects(good.store.observe());await assert.rejects(good.coordinator.inspect());
});

test('resumable head transition rejects premature wrong revision attempt kind and repeated grants',async()=>{
 const {f,binding,write,signedPin}=await prepareSignedHead(),pin={kind:'BASELINE' as const,versionId:'synthetic-manifest',sha256:hash('tus-manifest'),byteLength:1024};
 await assert.rejects(f.store.recordResumableBaselinePin(binding.attemptId,write.revision,pin));
 const signed=await f.store.recordSignedBaselinePin(binding.attemptId,write.revision,signedPin),n=f.puts;
 await assert.rejects(f.store.recordResumableBaselinePin(randomUUID(),signed.revision,pin));await assert.rejects(f.store.recordResumableBaselinePin(binding.attemptId,'0'.repeat(64),pin));await assert.rejects(f.store.recordResumableBaselinePin(binding.attemptId,signed.revision,{...pin,kind:'OBSERVATION'}));assert.equal(f.puts,n);
 const ready=await f.store.recordResumableBaselinePin(binding.attemptId,signed.revision,pin);assert.equal(ready.value.phase,'RESUMABLE_BASELINED');
 await assert.rejects(f.store.recordResumableBaselinePin(binding.attemptId,ready.revision,pin));assert.equal(f.puts,n+1);
});

test('protocol6 signed-only plan cannot dispatch the newly required complete TUS credential workflow',async()=>{
 const f=fixture();f.value={...f.value,planDigest:hash(JSON.stringify({format:6,...operation,databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',writeProofPolicy:'EXACT_VERSION_BASELINE_PIN_BEFORE_REVOCATION_V1',signedProofPolicy:'ORIGINAL_ENCRYPTED_TOKEN_AND_BASELINE_PIN_BEFORE_REVOCATION_V1',provider:f.provider.configurationDigest(),database:f.database.configurationDigest(),storage:f.storage.configurationDigest(),readProof:f.proof.configurationDigest(),writeProof:f.write.configurationDigest(),signedProof:f.signed.configurationDigest()}))};
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.some(c=>c.startsWith('tus-')||c.startsWith('kms-')),false);
});


test('protocol8 requires original signed TUS evidence and fresh inspection performs no active capability or KMS work',async()=>{
 const f=fixture(),result=await f.coordinator.close();assert.equal(result.testedSignedResumablePatchRefusalObserved,true);
 assert.ok(f.value.signedResumableBaselinePin&&f.value.signedResumableObservationPin);assert.ok(Buffer.byteLength(JSON.stringify(f.value))<=8192);
 const entry=[...f.artifacts.entries()].find(([key])=>key.endsWith('/signed-resumable-baseline.json'))!,baseline=JSON.parse(entry[1].body);
 assert.notEqual(baseline.maintenance.attemptId,f.value.attemptId);assert.ok(entry[0].includes('/'+baseline.maintenance.attemptId+'/'));
 const children=JSON.parse([...f.artifacts.entries()].find(([key])=>key.endsWith('/resumable-cohort-baseline.json'))![1].body).entries;
 assert.ok(children.every((v:{childAttemptId:string})=>v.childAttemptId!==baseline.maintenance.attemptId));
 const active=()=>f.calls.filter(c=>c==='put'||c==='artifact-put'||c==='signed-tus-POST'||c==='signed-tus-PATCH'||c.startsWith('secret-kms-')).length,before=active();
 const observed=await f.coordinator.inspect();assert.equal(observed.recordedSignedResumablePatchRefusalObserved,true);assert.equal(observed.freshSignedResumablePatchRefusalObserved,false);assert.equal(active(),before);
 assert.ok(f.signedTusFixture.aws.plaintextResponses.every(p=>p.every(v=>v===0)));
});
test('lost signed TUS secret baseline readback or parent ACK prevents shutdown and cannot resume from inspection',async()=>{
 for(const stage of ['secret','baseline','readback','head']){const f=fixture();
  f.setFault(command=>{const suffix=stage==='secret'?'/signed-resumable-credential.json':'/signed-resumable-baseline.json';
   if(stage==='readback'&&command instanceof GetObjectCommand&&command.input.Key!.endsWith(suffix))throw new Error('synthetic readback lost');
   if(stage!=='head'&&stage!=='readback'&&command instanceof PutObjectCommand&&command.input.Key!.endsWith(suffix)){f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'unknown-signed-tus'});throw new Error('synthetic committed ACK lost');}
   if(stage==='head'&&command instanceof PutObjectCommand&&command.input.Key!.endsWith('/control.json')&&JSON.parse(String(command.input.Body)).phase==='SIGNED_RESUMABLE_BASELINED'){f.commit(command);throw new Error('synthetic parent ACK lost');}
  });
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,stage==='head'?'SIGNED_RESUMABLE_BASELINED':'RESUMABLE_BASELINED');assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('database-close'),false);
  f.setFault(undefined);f.signedFixture.forceRevoked();const before=f.calls.filter(c=>c==='artifact-put'||c==='put'||c==='signed-tus-POST'||c==='signed-tus-PATCH'||c.startsWith('secret-kms-')).length;
  await assert.rejects(f.coordinator.close());const observed=await f.coordinator.inspect();assert.equal(observed.recordedSignedResumableObservation,null);assert.equal(f.calls.filter(c=>c==='artifact-put'||c==='put'||c==='signed-tus-POST'||c==='signed-tus-PATCH'||c.startsWith('secret-kms-')).length,before);
 }
});
test('lost original signed TUS report remains absent at the parent and is never backfilled',async()=>{
 const f=fixture();f.setFault(command=>{if(command instanceof PutObjectCommand&&command.input.Key!.endsWith('/signed-resumable-observation.json')){f.artifacts.set(command.input.Key!,{body:String(command.input.Body),version:'unknown-signed-tus-report'});throw new Error('synthetic report ACK lost');}});
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.signedResumableObservationPin,undefined);assert.equal(f.signedFixture.revoked,true);
 f.setFault(undefined);const count=f.artifacts.size,before=f.signedTusFixture.calls.length,observed=await f.coordinator.inspect();assert.equal(observed.recordedSignedResumablePatchRefusalObserved,false);assert.equal(f.artifacts.size,count);assert.equal(f.signedTusFixture.calls.length,before);
});
test('signing metadata closure cannot substitute for original signed TUS refusal',async()=>{
 const f=fixture();f.signedTusFixture.mode.stillWorks=true;await assert.rejects(f.coordinator.close());assert.equal(f.signedFixture.revoked,true);assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');assert.equal(f.value.signedResumableObservationPin,undefined);
 const observed=await f.coordinator.inspect();assert.equal(observed.recordedSignedResumablePatchRefusalObserved,false);assert.equal(observed.signedCapabilitiesRevoked,false);
});
test('completed protocol8 head requires signed TUS dependencies and rejects recomputed report-association forgeries',async()=>{
 const missing=fixture();await missing.coordinator.close();missing.value={...missing.value,signedResumableObservationPin:undefined};await assert.rejects(missing.store.observe());await assert.rejects(missing.coordinator.inspect());
 const f=fixture();await f.coordinator.close();const row=[...f.artifacts.entries()].find(([key])=>key.endsWith('/signed-resumable-observation.json'))![1],r=JSON.parse(row.body);
 r.tokenSha256='0'.repeat(64);const keys=['kind','configurationDigest','baselineSha256','credentialPinSha256','tokenSha256','locationSha256','issuerFingerprint','observedAt','providerObservedAt','refusalStatus','refusalCode'];
 r.observationDigest=hash(JSON.stringify(Object.fromEntries(keys.map(k=>[k,r[k]]))));row.body=JSON.stringify(r);
 f.value={...f.value,signedResumableObservationPin:{...f.value.signedResumableObservationPin!,sha256:hash(row.body),byteLength:Buffer.byteLength(row.body)},observations:{...(f.value.observations as Record<string,unknown>),signedResumableProofDigest:r.observationDigest}};
 await assert.rejects(f.coordinator.inspect());
});
test('signed TUS transition rejects wrong phase attempt revision kind and repeated acknowledgements',async()=>{
 const{f,binding,write,signedPin}=await prepareSignedHead(),pin={kind:'BASELINE' as const,versionId:'synthetic-signed-tus',sha256:hash('signed-tus'),byteLength:1024};
 await assert.rejects(f.store.recordSignedResumableBaselinePin(binding.attemptId,write.revision,pin));const signed=await f.store.recordSignedBaselinePin(binding.attemptId,write.revision,signedPin),ordinary=await f.store.recordResumableBaselinePin(binding.attemptId,signed.revision,pin),before=f.puts;
 await assert.rejects(f.store.recordSignedResumableBaselinePin(randomUUID(),ordinary.revision,pin));await assert.rejects(f.store.recordSignedResumableBaselinePin(binding.attemptId,'0'.repeat(64),pin));await assert.rejects(f.store.recordSignedResumableBaselinePin(binding.attemptId,ordinary.revision,{...pin,kind:'OBSERVATION'}));assert.equal(f.puts,before);
 const ready=await f.store.recordSignedResumableBaselinePin(binding.attemptId,ordinary.revision,pin);assert.equal(ready.value.phase,'SIGNED_RESUMABLE_BASELINED');await assert.rejects(f.store.recordSignedResumableBaselinePin(binding.attemptId,ready.revision,pin));assert.equal(f.puts,before+1);
});
test('protocol7 ordinary-TUS plan refuses protocol8 before capability dispatch',async()=>{
 const f=fixture();f.value={...f.value,planDigest:hash(JSON.stringify({format:7,...operation,databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',writeProofPolicy:'EXACT_VERSION_BASELINE_PIN_BEFORE_REVOCATION_V1',signedProofPolicy:'ORIGINAL_ENCRYPTED_TOKEN_AND_BASELINE_PIN_BEFORE_REVOCATION_V1',resumableProofPolicy:'ALL_CONFIGURED_ORIGINAL_TUS_MANIFEST_BEFORE_REVOCATION_V1',provider:f.provider.configurationDigest(),database:f.database.configurationDigest(),storage:f.storage.configurationDigest(),readProof:f.proof.configurationDigest(),writeProof:f.write.configurationDigest(),signedProof:f.signed.configurationDigest(),resumableProof:f.resumableFixture.factory().configurationDigest()}))};
 await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.some(c=>c==='signed-tus-POST'||c==='signed-tus-PATCH'||c.startsWith('secret-kms-')),false);
});

test('signed TUS child identity binds every parent dimension and configuration without granting execution',()=>{
 const f=fixture(),factory=f.signedTusFixture.factory(),parent={attemptId:randomUUID(),planDigest:hash('parent-plan'),sourceSha:operation.sourceSha,maintenanceEpoch:1},first=factory.forAttempt(parent).maintenance.attemptId;
 assert.equal(factory.forAttempt(parent).maintenance.attemptId,first);assert.notEqual(first,parent.attemptId);
 for(const patch of [{attemptId:randomUUID()},{planDigest:hash('different-plan')},{sourceSha:'0'.repeat(40)},{maintenanceEpoch:2}])assert.notEqual(factory.forAttempt({...parent,...patch}).maintenance.attemptId,first);
 assert.throws(()=>factory.configurationDigest('other-installation'));assert.throws(()=>factory.assertSignedScope('0'.repeat(64)));
 assert.throws(()=>factory.assertStorageScope({...f.storage.readProofScope(),captureKeyId:randomUUID()}));
 assert.equal(f.puts,0);assert.equal(f.calls.some(c=>c==='signed-tus-POST'||c==='signed-tus-PATCH'||c.startsWith('secret-kms-')),false);
});
