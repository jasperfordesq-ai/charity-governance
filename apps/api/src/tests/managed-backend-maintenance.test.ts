import {managedReadRoleConfigurationSchema} from '../services/managed-read-role-configuration.js';
import {ManagedRecoveryEpochCatalogue,ManagedRecoveryEpochPublisher,managedRecoveryEpochSchemas as epochSchemas,type ManagedRecoveryEpochReader,type ManagedRecoveryEpochWriter} from '../services/managed-recovery-epoch-catalogue.js';
import {S3ManagedRecoveryEpochReader,S3ManagedRecoveryEpochWriter} from '../services/managed-recovery-epoch-s3.js';
import {ManagedCaptureControlRetirement} from '../services/managed-capture-control-retirement.js';
import {managedPlanSchema} from '../services/managed-plan-bootstrap.js';
import {retiredControlReadFixture} from './fixtures/retired-control-read.js';
import {backend as archivedSdkBackend,config as archivedSdkConfig} from './fixtures/archived-custody.js';
import {readRoleCommonCandidateReportSchema} from '../services/managed-common-candidate-contract.js';
import {commonCandidateBindingSchema,commonCandidateReportSchema,commonCaptureObjectInventory,candidateReportArtifact as anyReportArtifact,retiredControlCommonCandidateReportSchema} from '../services/managed-common-candidate-contract.js';
import {ManagedSavedRetirementCustody} from '../services/managed-retirement-custody.js';
import {candidateBindingSchema,candidateReportArtifact} from '../services/managed-candidate-capture-contract.js';
import {ManagedCandidateCaptureJournal} from '../services/managed-candidate-capture-journal.js';
import {jobScope} from '../services/managed-proof-job-contract.js';
import {SupabaseRecoveryCapture} from '../services/supabase-recovery-capture.js';
import {managedS3WorkingFixture} from './fixtures/managed-s3-working.js';
import {managedS3CurrentFixture} from './fixtures/managed-s3-current.js';
import {SupabaseStorageWriterControl} from '../services/supabase-storage-writer-control.js';
import {managedSignedResumableFixture} from './fixtures/managed-signed-resumable.js';
import {resumableCohortFixture} from './fixtures/resumable-cohort.js';
import type {ResumableCohortPin} from '../services/resumable-cohort-contract.js';
import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {S3Client,GetObjectCommand,PutObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
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
function fixture(options:{retired?:{id:string;secret:string}[];epoch?:number}={}){
 const selectedOperation={...operation,maintenanceEpoch:options.epoch??operation.maintenanceEpoch};
 const retired=options.retired??[{id:'22222222-2222-4222-8222-222222222222',secret:'sb_secret_'+'b'.repeat(40)}];
 let value={format:1,installationId:config.installationId,maintenanceEpoch:selectedOperation.maintenanceEpoch,planDigest:'1'.repeat(64),
  phase:'READY',attemptId:null as string|null,observations:null as unknown,readBaseline:undefined as {body:string;sha256:string}|undefined,readObservation:undefined as {body:string;sha256:string}|undefined,
  writeBaselinePin:undefined as ManagedWriteEvidencePin|undefined,writeObservationPin:undefined as ManagedWriteEvidencePin|undefined,
  signedBaselinePin:undefined as SignedUploadEvidencePin|undefined,signedObservationPin:undefined as SignedUploadEvidencePin|undefined,resumableBaselinePin:undefined as ResumableCohortPin|undefined,resumableObservationPin:undefined as ResumableCohortPin|undefined,signedResumableBaselinePin:undefined as SignedUploadEvidencePin|undefined,signedResumableObservationPin:undefined as SignedUploadEvidencePin|undefined,s3BaselinePin:undefined as ResumableCohortPin|undefined,s3ObservationPin:undefined as ResumableCohortPin|undefined,publicationId:randomUUID()};
 let version=1,reads=0,puts=0,storageClosed=false,initialS3Enabled=false;
 const calls:string[]=[];
 let fault:((command:GetObjectCommand|PutObjectCommand)=>unknown)|undefined;
 const metadata=()=>({VersionId:'version-'+version,ETag:'"etag-'+version+'"',ServerSideEncryption:'aws:kms' as const,SSEKMSKeyId:config.kmsKeyArn});
 const client=new S3Client({region:'eu-west-1',credentials});
 const artifacts=new Map<string,{body:string;version:string}>();
 mock.method(client,'send',async(command:GetObjectCommand|PutObjectCommand|ListObjectsV2Command)=>{
  assert.equal(command.input.Bucket,config.bucket);assert.equal(command.input.ExpectedBucketOwner,config.accountId);
  if(command instanceof ListObjectsV2Command){
   calls.push('candidate-list');assert.equal(command.input.Delimiter,undefined);
   assert.ok(command.input.Prefix?.startsWith('managed-maintenance/'+config.installationId+'/'));
   const jobs=/\/capture-job\/[a-f0-9]{64}\/$/.test(command.input.Prefix!);
   assert.ok(jobs||command.input.Prefix?.endsWith('/capture-candidate/'));
   assert.ok(jobs?[2,3].includes(command.input.MaxKeys!):command.input.MaxKeys===1000);
   const rows=[...artifacts].filter(([key])=>key.startsWith(command.input.Prefix!)).sort(([a],[b])=>a<b?-1:1);
   return{Name:config.bucket,Prefix:command.input.Prefix,MaxKeys:command.input.MaxKeys,KeyCount:rows.length,IsTruncated:false,
    Contents:rows.map(([Key,row])=>({Key,Size:Buffer.byteLength(row.body),ETag:'"'+row.version+'"'}))};
  }
  const path=command.input;
  const injected=fault?.(command);if(injected!==undefined)return injected;
  if(path.Key!==`managed-maintenance/${config.installationId}/control.json`){
   if(command instanceof PutObjectCommand){calls.push('artifact-put');assert.equal(command.input.IfNoneMatch,'*');if(artifacts.has(path.Key!))throw new Error('synthetic existing artifact');
    const row={body:String(command.input.Body),version:'artifact-'+(artifacts.size+1)};artifacts.set(path.Key!,row);return{...metadata(),VersionId:row.version};}
   calls.push('artifact-get');const row=artifacts.get(path.Key!)!;if(command.input.VersionId!==undefined)assert.equal(command.input.VersionId,row.version);else assert.ok(path.Key?.includes('/capture-candidate/')||path.Key?.includes('/capture-job/')||path.Key?.endsWith('/plan-bootstrap.json')||path.Key?.endsWith('/capture-control-baseline.json')||path.Key?.endsWith('/capture-control-observation.json')||path.Key?.endsWith('/capture-control-read-baseline.json'));
   return{...metadata(),VersionId:row.version,ETag:'"'+row.version+'"',ContentLength:Buffer.byteLength(row.body),ChecksumSHA256:Buffer.from(hash(row.body),'hex').toString('base64'),ChecksumType:'FULL_OBJECT',Body:Readable.from([Buffer.from(row.body)])};
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
  observeCompatibility:async()=>{calls.push('database-preflight');return{requiredCataloguePredicatesObserved:true,configurationDigest:hash('db-registry')};},
  invalidatePasswords:async()=>{calls.push('password-invalidate');},
  observePasswordsInvalidated:async()=>{calls.push('database-observe');return{observationDigest:hash('database'),passwordCredentialsInvalidated:true};}};
 const s3MetadataConfig={installationId:operation.installationId,projectRef:'abcdefghijklmnopqrst',region:'eu-west-1',bucket:'synthetic-governance',organisationId:'org-synthetic',captureKeyId:'11111111-1111-4111-8111-111111111111',writerKeys:retired.map(k=>({id:k.id,type:'secret'}))};
 const s3Metadata=new SupabaseStorageWriterControl(s3MetadataConfig,'synthetic-management',async(input,init)=>{
  calls.push('s3-metadata-'+init?.method);assert.equal(init?.method,'GET');const u=new URL(String(input));
  if(u.pathname.endsWith('/config/storage'))return Response.json({features:{s3Protocol:{enabled:initialS3Enabled&&!storageClosed}}});
  if(u.pathname.endsWith('/api-keys/legacy'))return Response.json({enabled:!storageClosed});
  if(u.pathname.endsWith('/api-keys'))return Response.json([{id:s3MetadataConfig.captureKeyId,type:'secret'},...(!storageClosed?s3MetadataConfig.writerKeys:[])]);
  return Response.json({ref:s3MetadataConfig.projectRef,organization_id:s3MetadataConfig.organisationId,region:s3MetadataConfig.region,status:'ACTIVE_HEALTHY'});
 });
 const storage={candidateCaptureScope:()=>s3Metadata.candidateCaptureScope(),configurationDigest:()=>s3Metadata.configurationDigest(),s3FeatureProofScope:()=>s3Metadata.s3FeatureProofScope(),readProofScope:()=>({installationId:operation.installationId,projectRef:'abcdefghijklmnopqrst',captureKeyId:'11111111-1111-4111-8111-111111111111',secretWriterIds:retired.map(k=>k.id)}),close:async()=>{calls.push('storage-close');storageClosed=true;},
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
 const s3Fixture=managedS3CurrentFixture(config,client,s3Metadata,{id:s3MetadataConfig.captureKeyId,secret:'sb_secret_'+'a'.repeat(40)},calls);
 const coordinator=new ManagedBackendMaintenance(selectedOperation,provider as never,database as never,store,storage as never,proof as never,write as never,signed,resumableFixture.factory(),signedTusFixture.factory(),s3Fixture.factory());
 value.planDigest=coordinator.planDigest();
 return{client,setInitiallyEnabledS3:()=>{initialS3Enabled=true;},isStorageClosed:()=>storageClosed,store,provider,database,storage,proof,write,signed,signedFixture,resumableFixture,signedTusFixture,s3Fixture,s3Metadata,writeOperations,artifacts,coordinator,calls,metadata,get value(){return value;},set value(next){value=next;},
  get puts(){return puts;},get reads(){return reads;},setFault:(next:typeof fault)=>{fault=next;},
  commit:(command:PutObjectCommand)=>{value=JSON.parse(String(command.input.Body));version++;return metadata();}};
}

test('database preflight refusal leaves control READY and performs no provider or credential actions',async()=>{
 for(const mode of ['missing','wrong-config','error']){
  const f=fixture();
  f.database.observeCompatibility=async()=>{if(mode==='error')throw new Error('PRIVATE preflight detail');return {
   requiredCataloguePredicatesObserved:mode!=='missing',configurationDigest:hash(mode==='wrong-config'?'wrong':'db-registry')};};
  await assert.rejects(f.coordinator.close(),error=>error instanceof Error&&!error.message.includes('PRIVATE'));
  assert.equal(f.value.phase,'READY');assert.equal(f.puts,0);assert.deepEqual(f.calls,[]);
 }
});

test('managed shutdown records an independent attempt before provider/database mutation and never repeats it',async()=>{
 const f=fixture();const result=await f.coordinator.close();
 assert.equal(result.phase,'OBSERVED_CLOSED');assert.equal(f.puts,8);
 assert.equal(result.databasePasswordCredentialsInvalidated,true);
 assert.equal(result.storageAccessPathsObservedClosed,true);assert.ok(f.value.observations);
 assert.equal(result.credentialReadRefusalsObserved,true);assert.ok(f.value.readBaseline);assert.ok(f.value.readObservation);
 assert.ok(f.calls.indexOf('read-baseline')<f.calls.indexOf('suspend'));
 assert.equal(f.calls[0],'database-preflight');
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
 const fresh=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory());
 await assert.rejects(fresh.close());assert.equal(f.puts,before);
 assert.equal(f.calls.filter(x=>x==='read-baseline').length,1);
});

test('lost independent acquisition acknowledgement never dispatches, even after a new coordinator reads the committed attempt',async()=>{
 const f=fixture();f.setFault(command=>{
  if(command instanceof PutObjectCommand){f.commit(command);throw new Error('PRIVATE lost S3 ack');}
 });
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'ATTEMPTED');
 f.setFault(undefined);
 const fresh=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory());
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
  assert.equal(f.value.phase,stage==='record'?'OBSERVED_CLOSED':'S3_BASELINED');
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
  await assert.rejects(async()=>new ManagedBackendMaintenance(changed,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory()).close());
  assert.equal(f.puts,0);assert.equal(f.calls.includes('suspend'),false);
 }
 const f=fixture(),input={...operation},coordinator=new ManagedBackendMaintenance(input,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory());
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
 await new Promise<void>(resolve=>setImmediate(resolve)); // Let the read-only preflight finish before advancing the provider deadline.
 t.mock.timers.tick(16001);await result;assert.equal(f.calls.includes('suspend'),false);
});

test('two concurrent maintenance callers cannot both dispatch from one READY record',async()=>{
 const f=fixture(),other=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory());
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.readObservation,undefined);
 f.proof.verifyReadRefusal=verify;const before=f.puts,baseline=f.value.readBaseline?.sha256;
 const inspected=await f.coordinator.inspect();assert.equal(inspected.phase,'S3_BASELINED');assert.equal(inspected.recordedReadObservation,null);
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.writeObservationPin,undefined);
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.ok(f.value.writeBaselinePin);assert.equal(f.value.writeObservationPin,undefined);
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.signedObservationPin,undefined);
 f.setFault(undefined);const before=f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('signed-kms-')||c==='signed-storage-POST'||c==='signed-storage-PUT').length;
 const observed=await f.coordinator.inspect();assert.equal(observed.recordedSignedObservation,null);assert.equal(observed.recordedTestedSignedUploadRefusalObserved,false);
 assert.equal(f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('signed-kms-')||c==='signed-storage-POST'||c==='signed-storage-PUT').length,before);
});

test('management key revocation cannot substitute for an actual original-token refusal',async()=>{
 const f=fixture();f.signedFixture.acceptOld=true;await assert.rejects(f.coordinator.close());
 assert.equal(f.signedFixture.revoked,true);assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.signedObservationPin,undefined);
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
 await assert.rejects(f.coordinator.close());assert.equal(f.signedFixture.revoked,true);assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.signedObservationPin,undefined);
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
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.resumableObservationPin,undefined);
  f.setFault(undefined);const before=f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length;
  const observed=await f.coordinator.inspect();assert.equal(observed.recordedResumableCredentialCohortRefusalsObserved,false);await assert.rejects(f.coordinator.close());
  assert.equal(f.calls.filter(c=>c==='put'||c==='artifact-put'||c.startsWith('kms-')||c==='tus-POST'||c==='tus-PATCH').length,before);
 }
});

test('storage metadata closure cannot substitute for actual TUS refusal and an incomplete completed head refuses',async()=>{
 const f=fixture();f.resumableFixture.allowRetiredAfterClose=true;await assert.rejects(f.coordinator.close());
 assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.resumableObservationPin,undefined);const observed=await f.coordinator.inspect();assert.equal(observed.recordedResumableObservation,null);assert.equal(observed.resumableSessionsRevoked,false);
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
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.signedResumableObservationPin,undefined);assert.equal(f.signedFixture.revoked,true);
 f.setFault(undefined);const count=f.artifacts.size,before=f.signedTusFixture.calls.length,observed=await f.coordinator.inspect();assert.equal(observed.recordedSignedResumablePatchRefusalObserved,false);assert.equal(f.artifacts.size,count);assert.equal(f.signedTusFixture.calls.length,before);
});
test('signing metadata closure cannot substitute for original signed TUS refusal',async()=>{
 const f=fixture();f.signedTusFixture.mode.stillWorks=true;await assert.rejects(f.coordinator.close());assert.equal(f.signedFixture.revoked,true);assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.signedResumableObservationPin,undefined);
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

test('protocol9 parent composes previously working S3 credentials at both endpoints before recording closure',async()=>{
 const f=fixture();f.setInitiallyEnabledS3();
 const working=managedS3WorkingFixture(config,f.client,f.s3Metadata,{id:'11111111-1111-4111-8111-111111111111',secret:'sb_secret_'+'a'.repeat(40)},f.calls,
  ()=>({attemptId:f.value.attemptId!,planDigest:f.value.planDigest,sourceSha:operation.sourceSha,maintenanceEpoch:1}),f.isStorageClosed);
 const coordinator=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),working.factory());
 f.value={...f.value,planDigest:coordinator.planDigest()};
 const result=await coordinator.close();assert.equal(result.s3Mode,'WORKING_CAPABILITIES');assert.equal(result.configuredS3CoverageObserved,true);
 assert.equal(working.children.size,4);assert.ok(f.value.s3BaselinePin&&f.value.s3ObservationPin);assert.equal(result.wholeBackendQuiesced,false);
 const active=()=>f.calls.filter(c=>c.startsWith('s3-working-')||c==='kms-generate'||c==='kms-decrypt'||c==='artifact-put'||c==='put').length,before=active();
 const inspected=await coordinator.inspect();assert.equal(inspected.recordedS3CoverageObserved,true);assert.equal(inspected.freshS3CoverageObserved,false);assert.equal(active(),before);
 assert.ok(working.crypto.plaintext.every(p=>p.every(v=>v===0)));
});

test('S3 current baseline and original head are acknowledged before any shutdown mutation',async()=>{
 const f=fixture(),suspend=f.provider.suspend;f.provider.suspend=async()=>{assert.equal(f.value.phase,'S3_BASELINED');assert.ok(f.value.s3BaselinePin);assert.ok([...f.artifacts.keys()].some(k=>k.endsWith('/s3-current-feature-baseline.json')));await suspend();};
 const result=await f.coordinator.close();assert.equal(result.s3Mode,'CURRENT_DISABLED');assert.ok(result.s3ObservationPin);
 const before=f.s3Fixture.calls.length,observed=await f.coordinator.inspect();assert.equal(observed.recordedS3CoverageObserved,true);assert.equal(observed.freshS3CoverageObserved,false);assert.equal(f.s3Fixture.calls.length,before);
});

test('lost S3 canary public baseline or control head acknowledgement prevents shutdown and is not reconstructed',async()=>{
 for(const stage of ['canary','public','readback','head','head-readback']){
  const f=fixture();let once=false;
  if(stage==='canary')f.s3Fixture.mode.lostCanaryAck=true;
  f.setFault(c=>{
   if(stage==='head-readback'&&c instanceof GetObjectCommand&&c.input.Key!.endsWith('/control.json')&&f.value.phase==='S3_BASELINED'&&!once){once=true;throw new Error('synthetic lost S3 head readback');}
   if(stage==='head'&&c instanceof PutObjectCommand&&c.input.Key!.endsWith('/control.json')&&JSON.parse(String(c.input.Body)).phase==='S3_BASELINED'){f.commit(c);throw new Error('synthetic committed S3 head ACK lost');}
   if(stage==='public'&&c instanceof PutObjectCommand&&c.input.Key!.endsWith('/s3-current-feature-baseline.json')){f.artifacts.set(c.input.Key!,{body:String(c.input.Body),version:'unknown-s3'});throw new Error('synthetic public S3 ACK lost');}
   if(stage==='readback'&&c instanceof GetObjectCommand&&c.input.Key!.endsWith('/s3-current-feature-baseline.json'))throw new Error('synthetic S3 baseline readback lost');
  });
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,['head','head-readback'].includes(stage)?'S3_BASELINED':'SIGNED_RESUMABLE_BASELINED');assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('database-close'),false);
  f.setFault(undefined);f.signedFixture.forceRevoked();f.s3Fixture.mode.lostCanaryAck=false;
  const before=f.s3Fixture.calls.length,puts=f.puts,artifacts=f.artifacts.size;
  await assert.rejects(f.coordinator.close());const inspected=await f.coordinator.inspect();assert.equal(inspected.recordedS3CoverageObserved,false);assert.equal(inspected.freshS3CoverageObserved,false);assert.equal(f.s3Fixture.calls.length,before);assert.equal(f.puts,puts);assert.equal(f.artifacts.size,artifacts);
 }
});

test('lost S3 report acknowledgement or stale POST gateway cannot be backfilled into the parent',async()=>{
 for(const stage of ['report','readback','gateway']){
  const f=fixture();if(stage==='gateway')f.s3Fixture.mode.stalePostGateway=true;
  f.setFault(c=>{
   if(stage==='report'&&c instanceof PutObjectCommand&&c.input.Key!.endsWith('/s3-current-feature-observation.json')){f.artifacts.set(c.input.Key!,{body:String(c.input.Body),version:'unknown-s3-report'});throw new Error('synthetic committed report ACK lost');}
   if(stage==='readback'&&c instanceof GetObjectCommand&&c.input.Key!.endsWith('/s3-current-feature-observation.json'))throw new Error('synthetic S3 report readback lost');
  });
  await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.s3ObservationPin,undefined);
  f.setFault(undefined);const before=f.s3Fixture.calls.length,puts=f.puts;
  const inspected=await f.coordinator.inspect();assert.equal(inspected.recordedS3Observation,null);assert.equal(inspected.freshS3CoverageObserved,false);assert.equal(f.s3Fixture.calls.length,before);assert.equal(f.puts,puts);
 }
});

test('S3 original head transition rejects early wrong attempt revision kind and repeat grants',async()=>{
 const f=fixture(),original=f.store.recordS3BaselinePin.bind(f.store);let captured:Parameters<typeof original>|undefined;
 f.store.recordS3BaselinePin=async(...input)=>{captured=input;throw new Error('synthetic pause before head publication');};
 await assert.rejects(f.coordinator.close());assert.ok(captured);f.store.recordS3BaselinePin=original;assert.equal(f.value.phase,'SIGNED_RESUMABLE_BASELINED');
 const [attempt,revision,pin]=captured,before=f.puts;
 await assert.rejects(original(randomUUID(),revision,pin));await assert.rejects(original(attempt,'0'.repeat(64),pin));await assert.rejects(original(attempt,revision,{...(pin as object),kind:'OBSERVATION'}));assert.equal(f.puts,before);
 const ready=await original(attempt,revision,pin);assert.equal(ready.value.phase,'S3_BASELINED');await assert.rejects(original(attempt,ready.revision,pin));
 const early=fixture(),a=await early.store.acquire(operation.installationId,early.coordinator.planDigest(),1);await assert.rejects(early.store.recordS3BaselinePin(a.value.attemptId!,a.revision,pin));
});

test('current parent refuses missing S3 observations or digest and generic control refuses an incomplete final S3 pin',async()=>{
 const f=fixture();await f.coordinator.close();const saved=f.value;
 const facts=saved.observations as Record<string,unknown>;
 for(const field of ['s3BaselinePin','s3ObservationPin','s3ProofDigest']){
  const changed={...facts};if(field==='s3ProofDigest')delete changed.s3ProofDigest;
  f.value={...saved,observations:changed,...(field==='s3BaselinePin'?{s3BaselinePin:undefined}:field==='s3ObservationPin'?{s3ObservationPin:undefined}:{})};
  const before=f.calls.length;await assert.rejects(f.coordinator.inspect());assert.equal(f.calls.slice(before).includes('services-observe'),false);
 }
 f.value={...saved,phase:'S3_BASELINED',observations:null,readObservation:undefined,writeObservationPin:undefined,signedObservationPin:undefined,resumableObservationPin:undefined,signedResumableObservationPin:undefined,s3ObservationPin:undefined};
 const current=await f.store.observe(),args=[saved.attemptId!,current.revision,facts,JSON.parse(saved.readObservation!.body),saved.writeObservationPin,saved.signedObservationPin,saved.resumableObservationPin,saved.signedResumableObservationPin] as const;
 await assert.rejects(f.store.recordObservedClosed(...args));await assert.rejects(f.store.recordObservedClosed(...args,{...saved.s3ObservationPin!,sha256:'0'.repeat(64)}));
});

test('authentic protocol8 plan and omitted S3 component cannot dispatch the protocol9 coordinator',async()=>{
 const f=fixture(),legacy={format:8,...operation,databaseCredentialPolicy:'PASSWORD_NULL_WHILE_CLOSED',storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_KEEP_CAPTURE_V1',readProofPolicy:'INDEPENDENT_BASELINE_BEFORE_CREDENTIAL_REVOCATION_V1',writeProofPolicy:'EXACT_VERSION_BASELINE_PIN_BEFORE_REVOCATION_V1',signedProofPolicy:'ORIGINAL_ENCRYPTED_TOKEN_AND_BASELINE_PIN_BEFORE_REVOCATION_V1',resumableProofPolicy:'ALL_CONFIGURED_ORIGINAL_TUS_MANIFEST_BEFORE_REVOCATION_V1',signedResumableProofPolicy:'ORIGINAL_SIGNED_TUS_BASELINE_PIN_BEFORE_REVOCATION_V1',provider:f.provider.configurationDigest(),database:f.database.configurationDigest(),storage:f.storage.configurationDigest(),readProof:f.proof.configurationDigest(),writeProof:f.write.configurationDigest(),signedProof:f.signed.configurationDigest(),resumableProof:f.resumableFixture.factory().configurationDigest(),signedResumableProof:f.signedTusFixture.factory().configurationDigest()};
 f.value={...f.value,planDigest:hash(JSON.stringify(legacy))};await assert.rejects(f.coordinator.close());assert.equal(f.puts,0);assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('read-baseline'),false);
 assert.throws(()=>Reflect.construct(ManagedBackendMaintenance,[operation,f.provider,f.database,f.store,f.storage,f.proof,f.write,f.signed,f.resumableFixture.factory(),f.signedTusFixture.factory()]));
});

test('slow final metadata cannot turn an old S3 observation into a fresh closed record',async t=>{
 const f=fixture(),observe=f.provider.observeSuspended,now=Date.now;
 f.provider.observeSuspended=async()=>{const result=await observe();t.mock.method(Date,'now',()=>now()+181000);return result;};
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'S3_BASELINED');assert.equal(f.value.s3ObservationPin,undefined);assert.equal(f.value.observations,null);
});

function candidateFixture(f:ReturnType<typeof fixture>,onDownload:()=>Buffer=()=>Buffer.from('pdf')){
 const journal=new ManagedCandidateCaptureJournal(config,credentials,f.client);
 const scope=f.storage.candidateCaptureScope(),secret='sb_secret_'+'a'.repeat(40);let reads=0,visits=0;
 const capture=new SupabaseRecoveryCapture({installationId:scope.installationId,projectRef:scope.projectRef,bucket:scope.bucket,
  credential:{id:scope.captureKeyId,sha256:hash(secret)}},secret,async(input)=>{
  reads++;const path=new URL(String(input)).pathname;
  if(path.includes('/bucket/'))return Response.json({id:scope.bucket,public:false});
  if(path.includes('/object/list/'))return Response.json([{name:'record.pdf',id:'11111111-1111-4111-8111-111111111111',
   created_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:00:00Z',metadata:{size:3,mimetype:'application/pdf'}}]);
  return new Response(onDownload(),{headers:{'content-type':'application/pdf','content-length':'3'}});
 });
 const window={configurationDigest:()=>hash('synthetic-window'),run:async<T>(fn:(signal:AbortSignal)=>Promise<T>)=>{
  const controller=new AbortController();try{return{value:await fn(controller.signal),
   evidence:(()=>{const facts={format:1,kind:'MANAGED_STORAGE_METADATA_WINDOW_V1',windowId:randomUUID(),configurationDigest:hash('synthetic-window'),
    database:'synthetic',databaseOid:'16384',observer:{name:'postgres',oid:'10'},relations:[{schema:'storage',name:'objects',oid:'16385'}],
    backendPid:123,lockMode:'SHARE',transactionReadOnly:true,transactionIsolation:'ReadCommitted',startedAt:'synthetic-start',finishedAt:'synthetic-end'};
    return{...facts,observationDigest:hash(JSON.stringify(facts)),scope:'CONFIGURED_RELATIONS_DURING_CALLBACK_ONLY',metadataWindowCompleted:true,
     windowStillHeld:false,objectBytesFenced:false,allWritersInventoried:false,wholeBackendQuiesced:false,actionAuthorized:false};})()};}
  finally{controller.abort();}
 }};
 return{capture,window,journal,visit:async()=>{visits++;},get reads(){return reads;},get visits(){return visits;},
  request:async()=>{if(![...f.artifacts.keys()].some(k=>k.endsWith('/plan-bootstrap.json')))await f.coordinator.publishCaptureBootstrap(journal);
   return({candidateId:randomUUID(),attemptId:f.value.attemptId,controlRevision:(await f.store.observe()).revision,
   captureConfigurationDigest:capture.configurationDigest(),metadataWindowConfigurationDigest:window.configurationDigest(),journalConfigurationDigest:journal.configurationDigest()});}};
}
test('maintenance composes actual capture with declared window under the exact original closed head, remaining quarantine-only',async()=>{
 const f=fixture();await f.coordinator.close();const candidate=candidateFixture(f),puts=f.puts;
 const request=await candidate.request();const completed=await f.coordinator.captureQuarantined(request,candidate.capture,candidate.window as never,candidate.journal,candidate.visit);
 const result=completed.candidate;
 assert.equal(result.restoreMode,'QUARANTINE_ONLY');assert.equal(result.capture.objects.length,1);assert.equal(candidate.visits,1);
 assert.equal(result.binding.sourceSha,operation.sourceSha);assert.equal(result.binding.attemptId,request.attemptId);
 assert.equal(result.binding.candidateId,request.candidateId);assert.equal(result.binding.controlRevision,request.controlRevision);
 for(const flag of ['wholeBackendQuiesced','objectBytesFenced','currentTenantAuthorityVerified','archivedSetAdmitted','actionAuthorized'])
  assert.equal(result[flag as keyof typeof result],false);
 assert.equal(f.puts,puts);assert.equal(f.value.phase,'OBSERVED_CLOSED');
});
test('maintenance rejects candidate component, attempt, revision and storage scope substitutions before capture',async()=>{
 const f=fixture();await f.coordinator.close();const c=candidateFixture(f),request=await c.request();
 for(const change of [{attemptId:randomUUID()},{controlRevision:hash('different')},{captureConfigurationDigest:hash('different')},
  {metadataWindowConfigurationDigest:hash('different')},{candidateId:'not-an-id'},{extra:true}])
  await assert.rejects(()=>f.coordinator.captureQuarantined({...request,...change},c.capture,c.window as never,c.journal,c.visit));
 const original=f.storage.candidateCaptureScope;f.storage.candidateCaptureScope=()=>({...original(),bucket:'other'});
 await assert.rejects(()=>f.coordinator.captureQuarantined(request,c.capture,c.window as never,c.journal,c.visit));
 assert.equal(c.reads,0);assert.equal(c.visits,0);
});
test('maintenance discards completed candidate on head drift and preserves partial visitor work on byte drift',async()=>{
 const f=fixture();await f.coordinator.close();let downloads=0;
 const c=candidateFixture(f,()=>{downloads++;return Buffer.from(downloads===1?'pdf':'bad');});
 const request=await c.request();
 await assert.rejects(()=>f.coordinator.captureQuarantined(request,c.capture,c.window as never,c.journal,c.visit));
 assert.equal(c.visits,1);assert.equal(f.value.phase,'OBSERVED_CLOSED');
 const drift=candidateFixture(f,()=>{f.value={...f.value,publicationId:randomUUID()};return Buffer.from('pdf');});
 const driftRequest=await drift.request();
 await assert.rejects(()=>f.coordinator.captureQuarantined(driftRequest,drift.capture,drift.window as never,drift.journal,drift.visit));
 assert.equal(drift.visits,1);
 const uncertain=candidateFixture(f),uncertainRequest=await uncertain.request();let runs=0;
 const lost={configurationDigest:uncertain.window.configurationDigest,run:async(fn:(signal:AbortSignal)=>Promise<unknown>)=>{
  runs++;await uncertain.window.run(fn);throw new Error('PRIVATE-unknown-window-ACK');
 }};
 await assert.rejects(()=>f.coordinator.captureQuarantined(uncertainRequest,uncertain.capture,lost as never,uncertain.journal,uncertain.visit),e=>{
  assert.ok(e instanceof Error);assert.equal(e.cause,undefined);assert.equal(e.message.includes('PRIVATE'),false);return true;
 });assert.equal(runs,1);assert.equal(uncertain.visits,1);
});

test('candidate journal request/report ACK loss survives fresh inspection without replay or admission',async()=>{
 for(const stage of ['baseline','observation']){
  const f=fixture();await f.coordinator.close();const c=candidateFixture(f),request=await c.request();let lost=false;
  f.setFault(command=>{
   if(command instanceof PutObjectCommand&&command.input.Key?.includes('/capture-candidate/')&&command.input.Key.endsWith('/'+stage+'.json')){
    assert.equal(lost,false);lost=true;
    f.artifacts.set(command.input.Key,{body:String(command.input.Body),version:'synthetic-lost-'+stage});
    throw new Error('synthetic ACK lost after journal storage');
   }
  });
  await assert.rejects(()=>f.coordinator.captureQuarantined(request,c.capture,c.window as never,c.journal,c.visit));
  assert.equal(lost,true);assert.equal(c.visits,stage==='baseline'?0:1);const reads=c.reads;
  f.setFault(undefined);
  const fresh=new ManagedCandidateCaptureJournal(config,credentials,f.client);
  const binding=candidateBindingSchema.parse({format:2,kind:'MANAGED_QUARANTINED_STORAGE_CAPTURE_V2',...operation,...request,planDigest:f.coordinator.planDigest()});
  const session=fresh.forCandidate(binding),saved=await session.discoverRequest();
  assert.equal(saved.savedObservationAuthorizesExecution,false);assert.equal(saved.originalAcknowledgementReconstructed,false);
  if(stage==='observation'){
   const result=await session.discoverReport(saved.pin);
   assert.equal(result.value.binding.candidateId,request.candidateId);assert.equal(result.savedObservationAuthorizesExecution,false);
   assert.equal(result.originalAcknowledgementReconstructed,false);assert.equal(result.archivedSetAdmitted,false);
   const attempted=f.calls.filter(v=>v==='artifact-put').length;
   await assert.rejects(()=>session.publishReport(result.value,saved.pin));
   assert.equal(f.calls.filter(v=>v==='artifact-put').length,attempted);
   assert.throws(()=>candidateReportArtifact({...result.value,actionAuthorized:true}));
   assert.throws(()=>candidateReportArtifact({...result.value,capture:{...result.value.capture,unreviewedSecret:'synthetic'}}));
   assert.throws(()=>fresh.forCandidate({...binding,captureConfigurationDigest:hash('substitution')}));
  }else await assert.rejects(()=>session.discoverReport(saved.pin));
  const count=f.artifacts.size;
  await assert.rejects(()=>f.coordinator.captureQuarantined(request,c.capture,c.window as never,fresh,c.visit));
  assert.equal(c.reads,reads);assert.equal(f.artifacts.size,count);assert.equal(f.value.phase,'OBSERVED_CLOSED');
 }
});

test('candidate report publication snapshots caller data before awaited readback and returns stored bytes',async()=>{
 const f=fixture();await f.coordinator.close();const c=candidateFixture(f),request=await c.request();
 const binding=candidateBindingSchema.parse({format:2,kind:'MANAGED_QUARANTINED_STORAGE_CAPTURE_V2',...operation,...request,planDigest:f.coordinator.planDigest()});
 const session=c.journal.forCandidate(binding),publish=session.publishReport.bind(session);
 session.publishReport=async(raw,pin,signal)=>{
  const pending=publish(raw,pin,signal);
  const mutable=raw as {capture:{files:{mimeType:string}[]}};
  mutable.capture.files=[{...mutable.capture.files[0]!,mimeType:'modified-after-snapshot'}];return pending;
 };
 const result=await f.coordinator.captureQuarantined(request,c.capture,c.window as never,c.journal,c.visit);
 assert.equal(result.candidate.capture.files[0]!.mimeType,'application/pdf');
 const saved=await session.inspectReport(result.reportPin,result.requestPin);
 assert.equal(saved.value.capture.files[0]!.mimeType,'application/pdf');assert.equal(saved.value.observationDigest,result.candidate.observationDigest);
});

test('live head plus persisted plan bootstraps source and candidates with no local IDs or source SHA',async()=>{
 const f=fixture();await f.coordinator.close();const c=candidateFixture(f),request=await c.request();
 await f.coordinator.captureQuarantined(request,c.capture,c.window as never,c.journal,c.visit);
 const before=f.artifacts.size,reads=c.reads,fresh=new ManagedCandidateCaptureJournal(config,credentials,f.client);
 const result=await fresh.discoverCurrentCandidates(f.store,1);
 assert.equal(result.plan.sourceSha,operation.sourceSha);assert.equal(result.head.value.planDigest,f.coordinator.planDigest());
 assert.equal(result.catalogue.records.length,1);assert.equal(result.descriptorPlanDigestMatched,true);
 assert.equal(result.savedObservationAuthorizesExecution,false);assert.equal(result.monotonicHistoryVerified,false);
 assert.equal(f.artifacts.size,before);assert.equal(c.reads,reads);
 await assert.rejects(()=>fresh.discoverCurrentCandidates(f.store,2));
 const key=[...f.artifacts.keys()].find(k=>k.endsWith('/plan-bootstrap.json'))!,entry=f.artifacts.get(key)!;
 const plan=JSON.parse(entry.body);plan.sourceSha='2'.repeat(40);f.artifacts.set(key,{...entry,body:JSON.stringify(plan)});
 await assert.rejects(()=>fresh.discoverCurrentCandidates(f.store,1));assert.equal(f.artifacts.size,before);
});
test('missing bootstrap stops capture before a request, while lost bootstrap ACK is inspected without publication replay',async()=>{
 const f=fixture();await f.coordinator.close();const c=candidateFixture(f),head=await f.store.observe();
 const request={candidateId:randomUUID(),attemptId:head.value.attemptId,controlRevision:head.revision,
  captureConfigurationDigest:c.capture.configurationDigest(),metadataWindowConfigurationDigest:c.window.configurationDigest(),journalConfigurationDigest:c.journal.configurationDigest()};
 const before=f.artifacts.size;
 await assert.rejects(()=>f.coordinator.captureQuarantined(request,c.capture,c.window as never,c.journal,c.visit));
 assert.equal(c.reads,0);assert.equal(f.artifacts.size,before);
 let faulted=false;
 f.setFault(command=>{if(command instanceof PutObjectCommand&&command.input.Key?.endsWith('/plan-bootstrap.json')){
  assert.equal(faulted,false);faulted=true;f.artifacts.set(command.input.Key,{body:String(command.input.Body),version:'lost-bootstrap-version'});
  throw new Error('synthetic bootstrap publication ACK lost');
 }});
 await assert.rejects(()=>f.coordinator.publishCaptureBootstrap(c.journal));assert.equal(faulted,true);
 f.setFault(undefined);const stored=f.artifacts.size;
 await assert.rejects(()=>f.coordinator.publishCaptureBootstrap(c.journal));assert.equal(f.artifacts.size,stored);
 const fresh=new ManagedCandidateCaptureJournal(config,credentials,f.client);
 const found=await fresh.discoverCurrentCandidates(f.store,1);
 assert.equal(found.plan.sourceSha,operation.sourceSha);assert.equal(found.originalAcknowledgementReconstructed,false);
 assert.equal(found.catalogue.records.length,0);assert.equal(found.actionAuthorized,false);assert.equal(c.reads,0);
});
test('current bootstrap refuses a moving live head and does not fall back to an earlier epoch',async()=>{
 const f=fixture();await f.coordinator.close();const c=candidateFixture(f);await c.request();
 const fresh=new ManagedCandidateCaptureJournal(config,credentials,f.client);let count=0;
 f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.endsWith('/control.json')&&++count===2)
  f.value={...f.value,publicationId:randomUUID()};});
 await assert.rejects(()=>fresh.discoverCurrentCandidates(f.store,1));assert.equal(count,2);
 f.setFault(undefined);
 const epochTwo=fixture({epoch:2});await epochTwo.coordinator.close();
 await assert.rejects(()=>fresh.discoverCurrentCandidates(epochTwo.store,1));assert.equal(c.reads,0);
 // Publish only the declarative epoch2 preimage into the independently shared
 // synthetic journal. The old epoch1 file stays original; no candidate is made.
 await epochTwo.coordinator.publishCaptureBootstrap(fresh);
 const current=await fresh.discoverCurrentCandidates(epochTwo.store,2);
 assert.equal(current.head.value.maintenanceEpoch,2);assert.equal(current.plan.maintenanceEpoch,2);
 assert.equal(current.catalogue.records.length,0);assert.equal(current.monotonicHistoryVerified,false);
});

async function commonJournalFixture(){
 const f=fixture();await f.coordinator.close();const c=candidateFixture(f),request=await c.request();
 const archiveDigest=hash('synthetic-common-archive');
 const binding=commonCandidateBindingSchema.parse({format:3,kind:'MANAGED_QUARANTINED_COMMON_CAPTURE_V3',...operation,...request,
  candidateId:randomUUID(),planDigest:f.coordinator.planDigest(),archiveConfigurationDigest:archiveDigest});
 const session=c.journal.forCandidate(binding),requestPin=await session.reserve();
 const old=await f.coordinator.captureQuarantined(request,c.capture,c.window as never,c.journal,c.visit),w=old.candidate.metadataWindow;
 const arn=(n:string)=>`arn:aws:kms:eu-west-1:123456789012:key/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
 const context={installationId:operation.installationId,setId:randomUUID(),sourceSha:operation.sourceSha,databaseIdentitySha256:hash('db-id'),
  sourceCaptureReportSha256:hash('source-report'),databaseSha256:hash('database'),byteLength:5,keyArn:arn('2')};
 const index={installationId:context.installationId,setId:context.setId,sourceSha:context.sourceSha,databaseSha256:context.databaseSha256,
  sourceCaptureReportSha256:context.sourceCaptureReportSha256,databaseIdentitySha256:context.databaseIdentitySha256,
  objectStoreIdentitySha256:binding.captureConfigurationDigest,dataKeyArn:arn('2'),macKeyArn:arn('4'),metadataCapturedAt:old.candidate.capture.observedAt,
  metadataCaptureTransactionId:'42',objectCapturedAt:old.candidate.capture.observedAt};
 const snapshot={format:1,kind:'MANAGED_EXPORTED_DATABASE_SNAPSHOT_V1',database:w.database,databaseOid:w.databaseOid,observerOid:w.observer.oid,
  backendPid:w.backendPid,snapshotBindingSha256:hash('synthetic-snapshot'),configurationDigest:w.configurationDigest,windowId:w.windowId,
  exportedAfterRelationLocks:true,exporterHeldDuringCallback:true,importedByConsumerVerified:false,snapshotStillImportable:false,
  nonMvccStateCaptured:false,wholeBackendQuiesced:false,actionAuthorized:false};
 const raw=commonCandidateReportSchema.parse({...old.candidate,kind:'MANAGED_QUARANTINED_COMMON_CANDIDATE',binding,bindingDigest:hash(JSON.stringify(binding)),requestPin,
  databaseSnapshot:snapshot,rootReference:{pin:{scope:{index,database:context,storage:{bucket:'synthetic-common-roots',accountId:'123456789012',storageKeyArn:arn('3')},rootMacKeyArn:arn('5')},sha256:hash('synthetic-root')},
   preparedVersionId:'prepared-original-version',expectedRootFormat:2,state:'PREPARED_ROOT_REFERENCE_ONLY',finalPublicationAcknowledgementReconstructed:false}});
 const {observationDigest,...core}=raw;const report={...core,observationDigest:hash(JSON.stringify(core))};
 return{f,c,binding,session,requestPin,report,archiveDigest};
}
test('common candidate request and report bootstrap preserve prepared root reference without an execution grant',async()=>{
 const x=await commonJournalFixture();await x.session.publishReport(x.report,x.requestPin);x.session.closeExecution();
 const fresh=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),before=x.f.artifacts.size;
 const discovered=await fresh.discoverCurrentCandidates(x.f.store,1);
 const row=discovered.catalogue.records.find(r=>r.binding.candidateId===x.binding.candidateId);
 assert.equal(row?.commonRoot?.pin.sha256,x.report.rootReference.pin.sha256);
 assert.equal(row?.commonRoot?.state,'PREPARED_ROOT_REFERENCE_ONLY');assert.equal(discovered.savedObservationAuthorizesExecution,false);
 let reads=0;const archive={configurationDigest:()=>x.archiveDigest,verifySet:async()=>{reads++;return{kind:'ARCHIVED_SET_VERIFIED' as const,
  restoreMode:'QUARANTINE_ONLY' as const,captureConsistency:'EXTERNAL_VERIFICATION_REQUIRED' as const,sha256:x.report.rootReference.pin.sha256,rootVersionId:'root-original',
  documentCount:1,objectCount:1,snapshotInterval:{metadataWindow:x.report.metadataWindow,databaseSnapshot:x.report.databaseSnapshot},
  objectInventorySha256:commonCaptureObjectInventory(x.report),completedIntervalBindingVerified:true as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};}};
 const verified=await fresh.verifyDiscoveredCommonRoot(x.binding,archive);assert.equal(verified.actionAuthorized,false);assert.equal(reads,1);
 await assert.rejects(fresh.forCandidate(x.binding).publishReport(x.report,x.requestPin));
 await assert.rejects(fresh.verifyDiscoveredCommonRoot(x.binding,{...archive,configurationDigest:()=>hash('other')}));assert.equal(reads,1);
 await assert.rejects(fresh.verifyDiscoveredCommonRoot(x.binding,{...archive,verifySet:async()=>({...await archive.verifySet(),objectInventorySha256:hash('other-objects')})}));
 assert.equal(x.f.artifacts.size,before);
});
test('common report cannot substitute archive scope, object time, binding or prepared state',async()=>{
 const x=await commonJournalFixture();
 for(const mutate of [(v:typeof x.report)=>{v.rootReference.pin.scope.index.sourceSha='2'.repeat(40);},
  (v:typeof x.report)=>{v.rootReference.pin.scope.index.objectCapturedAt='2026-01-01T00:00:00.000Z';},
  (v:typeof x.report)=>{v.databaseSnapshot.backendPid++;},
  (v:typeof x.report)=>{Object.assign(v.rootReference,{state:'ROOT_PUBLICATION_ACKNOWLEDGED'});}]){
  const v=structuredClone(x.report);mutate(v);const {observationDigest,...core}=v;
  assert.throws(()=>anyReportArtifact({...core,observationDigest:hash(JSON.stringify(core))}));
 }
 const fresh=new ManagedCandidateCaptureJournal(config,credentials,x.f.client);
 await assert.rejects(fresh.forCandidate(x.binding).publishReport(x.report,x.requestPin));
});

async function commonParentFixture(){
 const x=await commonJournalFixture(),events:string[]=[];let completed:unknown,captured:typeof x.report.capture|undefined;
 const window={configurationDigest:x.c.window.configurationDigest,runWithSnapshot:async<T>(fn:(snapshot:unknown,signal:AbortSignal)=>Promise<T>)=>{
  events.push('window');const r=await x.c.window.run(signal=>fn({snapshotId:'00000001-00000002-1',database:'synthetic',databaseOid:'16384',observerOid:'10',backendPid:123},signal));
  const snapshot={...x.report.databaseSnapshot,windowId:r.evidence.windowId,configurationDigest:r.evidence.configurationDigest};
  return{...r,databaseSnapshot:snapshot};
 }};
 const getReport=()=>JSON.parse([...x.f.artifacts.values()].find(v=>{try{return JSON.parse(v.body).kind==='MANAGED_QUARANTINED_COMMON_CANDIDATE';}catch{return false;}})!.body) as typeof x.report;
 const archive={configurationDigest:()=>x.archiveDigest,
  prepareImported:async(_raw:unknown,interval:unknown)=>{events.push('prepare');completed=interval;const pin=structuredClone(x.report.rootReference.pin);
   pin.scope.index.objectCapturedAt=captured!.observedAt;pin.scope.index.metadataCapturedAt=captured!.observedAt;return{pin,artifact:{body:'synthetic-unit-preparation',sha256:pin.sha256}};},
  stagePrepared:async()=>{events.push('stage');return{versionId:'original-preparation'};},
  publishPrepared:async()=>{events.push('root-write');assert.equal(getReport().rootReference.state,'PREPARED_ROOT_REFERENCE_ONLY');return{};},
  verifySet:async()=>{events.push('root-read');const report=getReport();return{kind:'ARCHIVED_SET_VERIFIED' as const,restoreMode:'QUARANTINE_ONLY' as const,
   captureConsistency:'EXTERNAL_VERIFICATION_REQUIRED' as const,sha256:report.rootReference.pin.sha256,rootVersionId:'original-root',documentCount:1,objectCount:1,
   snapshotInterval:completed as {metadataWindow:typeof report.metadataWindow;databaseSnapshot:typeof report.databaseSnapshot},objectInventorySha256:commonCaptureObjectInventory(report),
   completedIntervalBindingVerified:true as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};}
 };
 const request={...await x.c.request(),archiveConfigurationDigest:x.archiveDigest};
 const source=async()=>{events.push('source');return{visit:x.c.visit,prepareArchiveInput:async(cap:typeof x.report.capture)=>{events.push('input');captured=cap;return{};}};};
 return{...x,events,window,archive,request,source,getReport};
}
test('common parent saves original root reference before final root write under unchanged closed head',async()=>{
 const x=await commonParentFixture();let jobContext:unknown,retainedJob:Readonly<{reserve:(v:unknown)=>Promise<unknown>;observe:(v:unknown)=>Promise<unknown>;bindService:(v:unknown)=>Promise<unknown>;reserveDaemonHeader:(v:unknown)=>Promise<unknown>;reserveDaemonIntent:(v:unknown)=>Promise<unknown>;bindDaemonOwner:(v:unknown)=>Promise<unknown>;createDaemonOwnerOutcomeWriter:()=>Promise<unknown>;createDaemonOwnerOutcomeTransfer:()=>Promise<unknown>;observeDaemonResponse:(v:unknown)=>Promise<unknown>;finishDaemonRequests:(v:unknown)=>Promise<unknown>}>|undefined;
 const r=await x.f.coordinator.captureCommonQuarantined(x.request,x.c.capture,x.window as never,x.c.journal,x.archive as never,async(_snapshot,_signal,context)=>{
  assert.equal(Object.isFrozen(context),true);assert.equal(Object.isFrozen(context.jobCustody),true);
  assert.equal(typeof context.jobCustody.reserve,'function');assert.equal(typeof context.jobCustody.bindService,'function');
  assert.equal(typeof context.jobCustody.reserveDaemonHeader,'function');assert.equal(typeof context.jobCustody.reserveDaemonIntent,'function');assert.equal(typeof context.jobCustody.bindDaemonOwner,'function');assert.equal(typeof context.jobCustody.createDaemonOwnerOutcomeWriter,'function');assert.equal(typeof context.jobCustody.createDaemonOwnerOutcomeTransfer,'function');assert.equal(typeof context.jobCustody.observeDaemonResponse,'function');assert.equal(typeof context.jobCustody.finishDaemonRequests,'function');
  const {jobCustody,...facts}=context;retainedJob=jobCustody;jobContext=facts;return x.source();
 });
 assert.deepEqual(jobContext,{kind:'COMMON_CANDIDATE',sourceSha:r.candidate.binding.sourceSha,
  bindingDigest:hash(JSON.stringify(r.candidate.binding)),requestPinDigest:hash(JSON.stringify(r.requestPin))});
 const before=x.f.artifacts.size;await assert.rejects(retainedJob!.reserve({}));await assert.rejects(retainedJob!.observe({}));await assert.rejects(retainedJob!.bindService({}));
 await assert.rejects(retainedJob!.reserveDaemonHeader({}));await assert.rejects(retainedJob!.reserveDaemonIntent({}));await assert.rejects(retainedJob!.bindDaemonOwner({}));await assert.rejects(retainedJob!.createDaemonOwnerOutcomeWriter());await assert.rejects(retainedJob!.createDaemonOwnerOutcomeTransfer());await assert.rejects(retainedJob!.observeDaemonResponse({}));await assert.rejects(retainedJob!.finishDaemonRequests({}));assert.equal(x.f.artifacts.size,before);
 assert.deepEqual(x.events,['window','source','input','prepare','stage','root-write','root-read']);
 assert.equal(r.candidate.binding.format,3);assert.equal(r.actionAuthorized,false);assert.equal(r.root.completedIntervalBindingVerified,true);
 const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),catalogue=await cold.discoverCurrentCandidates(x.f.store,1);
 assert.ok(catalogue.catalogue.records.some(v=>v.binding.candidateId===x.request.candidateId&&v.commonRoot));
});
test('lost common report readback ACK prevents final root write and discovery never authorises repair',async()=>{
 const x=await commonParentFixture(),prefix='/capture-candidate/'+hash(x.request.candidateId)+'/observation.json';
 x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.endsWith(prefix))throw new Error('synthetic lost common report ACK');});
 await assert.rejects(x.f.coordinator.captureCommonQuarantined(x.request,x.c.capture,x.window as never,x.c.journal,x.archive as never,x.source));
 assert.ok(x.events.includes('stage'));assert.ok(!x.events.includes('root-write'));x.f.setFault(undefined);
 const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),c=await cold.discoverCurrentCandidates(x.f.store,1);
 const row=c.catalogue.records.find(v=>v.binding.candidateId===x.request.candidateId);assert.ok(row?.commonRoot);assert.equal(c.savedObservationAuthorizesExecution,false);
 const sources=x.events.filter(v=>v==='source').length;
 await assert.rejects(x.f.coordinator.captureCommonQuarantined(x.request,x.c.capture,x.window as never,cold,x.archive as never,x.source));
 assert.equal(x.events.filter(v=>v==='source').length,sources);assert.ok(!x.events.includes('root-write'));
});
test('archive substitution refuses before common source execution and unknown final root ACK keeps discoverable pin',async()=>{
 const x=await commonParentFixture();
 await assert.rejects(x.f.coordinator.captureCommonQuarantined(x.request,x.c.capture,x.window as never,x.c.journal,
  {...x.archive,configurationDigest:()=>hash('wrong')} as never,x.source));assert.equal(x.events.length,0);
 const lost={...x.archive,publishPrepared:async()=>{x.events.push('unknown-root-ACK');throw new Error('synthetic root ACK lost');}};
 await assert.rejects(x.f.coordinator.captureCommonQuarantined(x.request,x.c.capture,x.window as never,x.c.journal,lost as never,x.source));
 const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),c=await cold.discoverCurrentCandidates(x.f.store,1);
 const row=c.catalogue.records.find(v=>v.binding.candidateId===x.request.candidateId);assert.ok(row?.commonRoot);
 const verified=await cold.verifyDiscoveredCommonRoot(row!.binding,x.archive);assert.equal(verified.actionAuthorized,false);
});

async function currentRecoveryFixture(){
 const x=await commonJournalFixture(),jobId=randomUUID();
 const artifact=(value:unknown)=>{const body=JSON.stringify(value);return{body,sha256:hash(body),byteLength:Buffer.byteLength(body)};};
 const local=artifact({format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_V1',jobId,scope:jobScope(x.binding,x.requestPin),sourceSha:x.binding.sourceSha,
  workspaceDigest:hash('workspace'),snapshotDigest:hash('snapshot'),argumentsDigest:hash('arguments'),createdAt:new Date().toISOString(),
  state:'REQUESTED_ONLY',executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false});
 const requestPin={sha256:local.sha256,byteLength:local.byteLength};
 await x.session.reserveSourceJob(local,x.requestPin);
 await x.session.bindSourceJobService(artifact({format:1,kind:'MANAGED_IMPORTED_PROOF_SERVICE_V1',jobId,requestPin,
  identity:{format:2,kind:'MANAGED_GUARDIAN_LIVE_BINDING_V2',jobId,unit:`charitypilot-containment-${jobId}.service`,invocationId:'a'.repeat(32),uid:1000,mainPid:123,
   mainStartMonotonic:'12345',sourceSha:x.binding.sourceSha,inputDigest:hash('input'),bootId:'12345678-1234-1234-1234-123456789012',
   controlGroup:`/user.slice/user-1000.slice/user@1000.service/app.slice/charitypilot-containment-${jobId}.service`,executionAuthorized:false,actionAuthorized:false},
  executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false}),x.requestPin);
 const header=artifact({format:2,kind:'MANAGED_DAEMON_REQUEST_HEADER_V2',jobId,inputDigest:hash('input'),image:'postgres@sha256:'+'1'.repeat(64),imageVolumeTargets:['/var/lib/postgresql/data']});
 await x.session.reserveSourceDaemonHeader(header,x.requestPin);
 const intent=artifact({format:2,kind:'MANAGED_DAEMON_REQUEST_INTENT_V2',jobId,sequence:1,previousDigest:header.sha256,
  operation:'exec',target:'charitypilot-source-snapshot-123-456-abcdef12',storagePlan:null,argumentsDigest:hash('synthetic arguments')});
 await x.session.reserveSourceDaemonIntent(intent,x.requestPin);
 await x.session.observeSourceDaemonResponse(artifact({format:1,kind:'MANAGED_DAEMON_CLIENT_RESPONSE_V1',jobId,sequence:1,
  intentPin:{sha256:intent.sha256,byteLength:intent.byteLength},status:0,transportError:false,signal:false,removalAlreadyAbsent:false}),x.requestPin);
 await x.session.finishSourceDaemonRequests(artifact({format:1,kind:'MANAGED_DAEMON_REQUEST_END_V1',jobId,
  headerPin:{sha256:header.sha256,byteLength:header.byteLength},requestCount:1,lastIntentDigest:intent.sha256}),x.requestPin);
 await x.session.observeSourceJob(artifact({format:1,kind:'MANAGED_IMPORTED_PROOF_JOB_OBSERVATION_V1',jobId,requestPin,state:'WORKER_EXIT_ACK_OBSERVED',
  jobContainersObservedAbsent:true,executionAuthorized:false,publicationAuthorized:false,actionAuthorized:false}),x.requestPin);
 await x.session.publishReport(x.report,x.requestPin);x.session.closeExecution();
 let rootReads=0;
 const archive={configurationDigest:()=>x.archiveDigest,verifySet:async()=>{rootReads++;return{kind:'ARCHIVED_SET_VERIFIED' as const,
  restoreMode:'QUARANTINE_ONLY' as const,captureConsistency:'EXTERNAL_VERIFICATION_REQUIRED' as const,sha256:x.report.rootReference.pin.sha256,rootVersionId:'root-original',
  documentCount:1,objectCount:1,snapshotInterval:{metadataWindow:x.report.metadataWindow,databaseSnapshot:x.report.databaseSnapshot},
  objectInventorySha256:commonCaptureObjectInventory(x.report),completedIntervalBindingVerified:true as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};}};
 return{...x,archive,get rootReads(){return rootReads;},cold:()=>new ManagedCandidateCaptureJournal(config,credentials,x.f.client)};
}

test('cold current recovery composes saved job discovery and archive verification without writes or authority',async()=>{
 const x=await currentRecoveryFixture(),before=x.f.artifacts.size,puts=x.f.puts;
 x.f.setFault(command=>{if(command instanceof PutObjectCommand)throw new Error('unexpected mutation');});
 const observed=await x.cold().inspectCurrentRecovery(x.f.store,1,x.archive);
 assert.equal(observed.records.filter(r=>r.kind==='COMMON_CAPTURE_RECOVERY_OBSERVATION').length,1);
 const common=observed.records.find(r=>r.kind==='COMMON_CAPTURE_RECOVERY_OBSERVATION');
 assert.equal(common?.jobStatus,'SAVED_RECORDS_VERIFIED');assert.equal(common?.rootStatus,'ARCHIVE_VERIFIED_QUARANTINE_ONLY');
 assert.equal(observed.unresolvedCommonCandidates,0);assert.equal(x.rootReads,1);assert.equal(x.f.artifacts.size,before);assert.equal(x.f.puts,puts);
 for(const field of ['currentTenantAuthorityVerified','historyCompletenessVerified','sourceHostLossProven','daemonRequestsAccountedFor','writerFencingVerified','archivedSetAdmitted','cleanupAuthorized','executionAuthorized','actionAuthorized'] as const)assert.equal(observed[field],false);
});

test('cold recovery keeps missing/corrupt job evidence and unknown root verification unresolved without repairing history',async()=>{
 for(const fault of ['missing-job','corrupt-job','missing-report','root-unavailable','missing-daemon-response']){
  const x=await currentRecoveryFixture();
  const key=[...x.f.artifacts.keys()].find(k=>k.includes('/capture-job/')&&k.endsWith('/baseline.json'))!;
  if(fault==='missing-job')x.f.artifacts.delete(key);
  if(fault==='corrupt-job')x.f.artifacts.set(key,{...x.f.artifacts.get(key)!,body:'{}'});
  if(fault==='missing-daemon-response')x.f.artifacts.delete([...x.f.artifacts.keys()].find(k=>x.f.artifacts.get(k)!.body.includes('MANAGED_DAEMON_CUSTODY_RESPONSE_V1'))!);
  if(fault==='missing-report')x.f.artifacts.delete([...x.f.artifacts.keys()].find(k=>k.includes('/capture-candidate/')&&k.includes(hash(x.binding.candidateId))&&k.endsWith('/observation.json'))!);
  const before=x.f.artifacts.size;
  const archive=fault==='root-unavailable'?{...x.archive,verifySet:async()=>{throw new Error('PRIVATE provider failure');}}:x.archive;
  const observed=await x.cold().inspectCurrentRecovery(x.f.store,1,archive);
  assert.equal(observed.unresolvedCommonCandidates,1);assert.equal(observed.actionAuthorized,false);assert.equal(x.f.artifacts.size,before);
  const common=observed.records.find(r=>r.kind==='COMMON_CAPTURE_RECOVERY_OBSERVATION');assert.equal(common?.unresolved,true);
  if(fault==='missing-job'||fault==='corrupt-job'||fault==='missing-daemon-response')assert.equal(common?.jobStatus,'UNRESOLVED');
  else assert.notEqual(common?.rootStatus,'ARCHIVE_VERIFIED_QUARANTINE_ONLY');
 }
});

test('cold recovery refuses moving head/catalogue after archive read and cancellation without fallback',async()=>{
 for(const fault of ['head','late-head','catalogue','job','cancel']){
  const x=await currentRecoveryFixture(),controller=new AbortController();
  const archive={...x.archive,verifySet:async()=>{
   const value=await x.archive.verifySet();
   if(fault==='head')x.f.commit(new PutObjectCommand({Bucket:config.bucket,Key:`managed-maintenance/${config.installationId}/control.json`,Body:JSON.stringify({...x.f.value,publicationId:randomUUID()})}));
   if(fault==='catalogue')x.f.artifacts.delete([...x.f.artifacts.keys()].find(k=>k.includes('/capture-candidate/')&&k.includes(hash(x.binding.candidateId))&&k.endsWith('/observation.json'))!);
   if(fault==='job')x.f.artifacts.delete([...x.f.artifacts.keys()].find(k=>k.includes('/capture-job/')&&k.endsWith('/observation.json'))!);
   if(fault==='late-head')x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.includes('/capture-job/')){
    x.f.commit(new PutObjectCommand({Bucket:config.bucket,Key:`managed-maintenance/${config.installationId}/control.json`,Body:JSON.stringify({...x.f.value,publicationId:randomUUID()})}));
   }});
   if(fault==='cancel')controller.abort();return value;
  }};
  await assert.rejects(x.cold().inspectCurrentRecovery(x.f.store,1,archive,controller.signal));
  assert.equal(x.rootReads,1);
 }
 const x=await currentRecoveryFixture();await assert.rejects(x.cold().inspectCurrentRecovery(x.f.store,2,x.archive));assert.equal(x.rootReads,0);
 const aborted=new AbortController();aborted.abort();const reads=x.f.reads;
 await assert.rejects(x.cold().inspectCurrentRecovery(x.f.store,1,x.archive,aborted.signal));assert.equal(x.f.reads,reads);
});

test('explicit read-role policy uses a distinct protocol10 plan and refuses legacy capture paths before I/O',async()=>{
 const f=fixture();let checks=0;
 const profile={observeCompatibility:async()=>({catalogueLockAclPredicatesObserved:true}),configurationDigest:()=>hash('read-role-authorization'),assertMaintenanceScope:(raw:unknown)=>{assert.deepEqual(raw,operation);checks++;},assertStorageScope:(raw:unknown)=>{assert.deepEqual(raw,f.storage.candidateCaptureScope());checks++;}};
 const coordinator=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory(),profile as never);
 const plan=coordinator.planDescriptor();assert.equal(plan.format,10);assert.notEqual(coordinator.planDigest(),f.coordinator.planDigest());assert.ok(checks>=4);
 assert.equal('captureAuthorization' in plan&&plan.captureAuthorization,profile.configurationDigest());
 const {managedPlanSchema}=await import('../services/managed-plan-bootstrap.js');assert.deepEqual(managedPlanSchema.parse(plan),plan);
 assert.throws(()=>managedPlanSchema.parse({...plan,format:9}));const{captureAuthorization,...missing}=plan as typeof plan&{captureAuthorization:string};assert.throws(()=>managedPlanSchema.parse(missing));
 const before=f.calls.length;await assert.rejects(coordinator.captureQuarantined({},undefined as never,undefined as never,undefined as never,async()=>{}));
 await assert.rejects(coordinator.captureCommonQuarantined({},undefined as never,undefined as never,undefined as never,undefined as never,async()=>{throw new Error();}));
 assert.equal(f.calls.length,before);assert.equal(f.puts,0);
 await assert.rejects(coordinator.close());assert.equal(f.calls.includes('provider-suspend'),false);assert.equal(f.puts,0);
});

test('protocol10 original closure and bootstrap preserve the capture authorization in fresh read-only discovery',async()=>{
 const f=fixture(),profile={observeCompatibility:async()=>({catalogueLockAclPredicatesObserved:true}),configurationDigest:()=>hash('reviewed-read-role-registry'),assertMaintenanceScope:(_raw:unknown)=>{},assertStorageScope:(_raw:unknown)=>{}};
 const coordinator=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory(),profile as never);
 // Provision only this synthetic fixture's READY head for the distinct plan.
 f.value.planDigest=coordinator.planDigest();assert.equal((await coordinator.close()).phase,'OBSERVED_CLOSED');
 const journal=new ManagedCandidateCaptureJournal(config,credentials,f.client);await coordinator.publishCaptureBootstrap(journal);
 const cold=new ManagedCandidateCaptureJournal(config,credentials,f.client),seen=await cold.discoverCurrentCandidates(f.store,1);
 assert.equal(seen.plan.format,10);assert.equal('captureAuthorization' in seen.plan&&seen.plan.captureAuthorization,profile.configurationDigest());
 assert.equal(seen.catalogue.records.length,0);assert.equal(seen.savedObservationAuthorizesExecution,false);assert.equal(seen.originalAcknowledgementReconstructed,false);
});

async function readRoleCommonParentFixture(retired=false){
 // Structure/custody fixture only; real JWT, SQL and source/archive execution
 // are covered by the native PostgreSQL cohort.
 const seed=await commonJournalFixture(),events:string[]=[];let f=fixture(),sourceCalls=0,published=false,interval:unknown,context:unknown;
 const readFixture=retired?retiredControlReadFixture({installationId:config.installationId,controlId:'11111111-1111-4111-8111-111111111111'}):undefined;
 const role=readFixture?.config.readRole.sqlRole??{name:'capture_reader',oid:'20000'},relations=[{schema:'storage' as const,name:'buckets' as const,oid:'20001'},{schema:'storage' as const,name:'objects' as const,oid:'20002'}];
 const w=structuredClone(seed.report.metadataWindow);w.relations=relations;w.configurationDigest=hash('read-role-metadata');
 const {observationDigest:oldWindowHash,scope,metadataWindowCompleted,windowStillHeld,objectBytesFenced,allWritersInventoried,wholeBackendQuiesced,actionAuthorized,...windowFacts}=w;w.observationDigest=hash(JSON.stringify(windowFacts));
 const snapshot={...seed.report.databaseSnapshot,configurationDigest:w.configurationDigest};
 const jwt={format:1,kind:'SUPABASE_CAPTURE_JWT_VERIFICATION_V1',algorithm:'ES256',keyId:'synthetic-unit',verificationKeySha256:hash('unit-key'),sqlRole:role,subject:'11111111-1111-4111-8111-111111111111',issuedAt:1700000000,expiresAt:1700000600,
  signatureVerified:true,configuredClaimsMatched:true,sqlRoleOidDeclared:true,sqlRoleOidVerified:false,providerKeyCurrentVerified:false,providerSqlRoleVerified:false,privilegeIntervalHeld:false};
 const capture={...seed.report.capture,kind:'SUPABASE_READ_ROLE_CANDIDATE_CAPTURE_V1',credentialCapability:'ASYMMETRIC_CUSTOM_ROLE_JWT',configurationDigest:hash('read-role-capture'),jwtVerification:readFixture?.positive.readRoleVerificationEvidence()??jwt};
 const authorization=managedReadRoleConfigurationSchema.parse({kind:'MANAGED_READ_ROLE_CAPTURE_CONFIGURATION_V1',...operation,projectRef:f.storage.candidateCaptureScope().projectRef,bucket:f.storage.candidateCaptureScope().bucket,subject:jwt.subject,sqlRole:role,
  database:{name:w.database,oid:w.databaseOid},catalogueObserver:{name:'maintenance',oid:'10'},snapshotObserver:w.observer,storageRelations:{buckets:relations[0],objects:relations[1]},
  captureConfigurationDigest:capture.configurationDigest,catalogueConfigurationDigest:hash('role-catalogue'),metadataWindowConfigurationDigest:w.configurationDigest,maxWindowMs:5000});
 const catalogueNames=['pg_attribute','pg_proc','pg_class','pg_authid','pg_auth_members','pg_database','pg_namespace','pg_policy'];
 const facts={format:1,kind:'MANAGED_CAPTURE_SQL_PRIVILEGE_WINDOW_V1',windowId:randomUUID(),configurationDigest:authorization.catalogueConfigurationDigest,database:w.database,databaseOid:w.databaseOid,capture:role,backendPid:222,
  catalogues:catalogueNames.map((name,i)=>({name,oid:String(1200+i),shared:['pg_authid','pg_auth_members','pg_database'].includes(name),held:true})),startedAt:w.startedAt,finishedAt:w.finishedAt,maxWindowMs:5000};
 const sqlPrivilegeWindow={...facts,observationDigest:hash(JSON.stringify(facts)),scope:'LISTED_SQL_CATALOGUES_DURING_CALLBACK_ONLY',configuredCaptureSqlReadOnlyObserved:true,preexistingAssignedTransactionsExcludedAtEntry:true,listedCatalogueChangesExcludedDuringCallback:true,windowStillHeld:false,
  providerTokenRoleVerified:false,providerManagementActorsExcluded:false,unfilteredBucketVisibilityVerified:false,captureCredentialReadOnlyVerified:false,allWritersInventoried:false,wholeBackendQuiesced:false,actionAuthorized:false};
 const profile={observeCompatibility:async()=>({catalogueLockAclPredicatesObserved:true}),configurationDescriptor:()=>structuredClone(authorization),configurationDigest:()=>hash(JSON.stringify(authorization)),assertMaintenanceScope:(_raw:unknown)=>{},assertStorageScope:(_raw:unknown)=>{},
   runWithSnapshot:async(fn:(snapshot:unknown,signal:AbortSignal)=>Promise<{visit:unknown;value:unknown}>)=>{events.push('windows');if(retired)capture.startedAt=new Date().toISOString();const prepared=await fn({snapshotId:'00000001-00000002-1',database:w.database,databaseOid:w.databaseOid,observerOid:w.observer.oid,backendPid:w.backendPid},new AbortController().signal);
   if(retired)capture.observedAt=new Date().toISOString();
   return{configurationDigest:hash(JSON.stringify(authorization)),captured:capture,snapshotInterval:{metadataWindow:w,databaseSnapshot:snapshot},sqlPrivilegeWindow,sourceValue:prepared.value};}};
 const retirement=retired?await captureControlRetirementFixture(true,true,profile,readFixture):undefined;
 if(retirement)f=retirement.f;
 const coordinator=retirement?.coordinator??new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory(),profile as never);
 if(!retirement){f.value.planDigest=coordinator.planDigest();await coordinator.close();}
 const journal=new ManagedCandidateCaptureJournal(config,credentials,f.client);if(!retirement)await coordinator.publishCaptureBootstrap(journal);
 const retiredResult=retirement?await coordinator.retireCaptureControl():undefined;
 const getReport=()=>JSON.parse([...f.artifacts.values()].find(v=>{try{return JSON.parse(v.body).kind===(retired?'MANAGED_QUARANTINED_RETIRED_CONTROL_COMMON_CANDIDATE':'MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE');}catch{return false;}})!.body) as z.infer<typeof readRoleCommonCandidateReportSchema>|z.infer<typeof retiredControlCommonCandidateReportSchema>;
 const archive={configurationDigest:()=>seed.archiveDigest,prepareImported:async(_raw:unknown,completed:unknown)=>{events.push('prepare');interval=completed;const pin=structuredClone(seed.report.rootReference.pin);pin.scope.index.objectStoreIdentitySha256=capture.configurationDigest;pin.scope.index.objectCapturedAt=capture.observedAt;return{pin,artifact:{body:'unit-preparation',sha256:pin.sha256}};},
  stagePrepared:async()=>{events.push('stage');return{versionId:'role-original-preparation'};},publishPrepared:async()=>{events.push('root-write');assert.equal(getReport().rootReference.state,'PREPARED_ROOT_REFERENCE_ONLY');published=true;},
  verifySet:async()=>{if(!published)throw new Error('No original root');events.push('root-read');const report=getReport();return{kind:'ARCHIVED_SET_VERIFIED' as const,restoreMode:'QUARANTINE_ONLY' as const,captureConsistency:'EXTERNAL_VERIFICATION_REQUIRED' as const,
   sha256:report.rootReference.pin.sha256,rootVersionId:'role-original-root',documentCount:1,objectCount:1,snapshotInterval:interval,objectInventorySha256:commonCaptureObjectInventory(report),completedIntervalBindingVerified:true as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};}};
 const head=await f.store.observe(),request={candidateId:randomUUID(),attemptId:head.value.attemptId,controlRevision:head.revision,captureConfigurationDigest:capture.configurationDigest,metadataWindowConfigurationDigest:w.configurationDigest,
  journalConfigurationDigest:journal.configurationDigest(),archiveConfigurationDigest:archive.configurationDigest(),captureAuthorizationDigest:profile.configurationDigest(),sqlPrivilegeConfigurationDigest:authorization.catalogueConfigurationDigest,
  ...(retiredResult&&retiredResult.report.format===2?{retirementConfigurationDigest:retirement!.retirement.configurationDigest(),readComparisonConfigurationDigest:retirement!.retirement.readComparisonConfigurationDigest(),
   retirementRequestPin:retiredResult.requestPin,retirementReadBaselinePin:retiredResult.report.readBaselinePin,retirementReportPin:retiredResult.reportPin}:{})};
 const source=async(_snapshot:unknown,_signal:AbortSignal,ctx:unknown)=>{sourceCalls++;context=ctx;events.push('source');return{visit:async()=>{},prepareArchiveInput:async()=>{events.push('input');return{};}};};
 return{f,coordinator,journal,archive,request,source,profile,getReport,events,retirement,sourceCalls:()=>sourceCalls,context:()=>context,published:()=>published};
}

test('format4 common path binds original request/role evidence and root reference; cold readers preserve quarantine',async()=>{
 const x=await readRoleCommonParentFixture(),result=await x.coordinator.captureReadRoleCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
 assert.equal(result.candidate.kind,'MANAGED_QUARANTINED_READ_ROLE_COMMON_CANDIDATE');assert.equal(result.candidate.binding.format,4);assert.equal(result.actionAuthorized,false);
 assert.deepEqual(x.events,['windows','source','input','prepare','stage','root-write','root-read']);assert.equal(x.sourceCalls(),1);
 const context=x.context() as {bindingDigest:string;jobCustody:{reserve:(raw:unknown)=>Promise<unknown>}};assert.equal(context.bindingDigest,hash(JSON.stringify(result.candidate.binding)));
 const before=x.f.artifacts.size;await assert.rejects(context.jobCustody.reserve({}));assert.equal(x.f.artifacts.size,before);
 const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),seen=await cold.discoverCurrentCandidates(x.f.store,1);
 assert.equal(seen.plan.format,10);assert.equal(seen.catalogue.records[0]?.binding.format,4);assert.ok(seen.catalogue.records[0]?.commonRoot);
 assert.equal((await cold.verifyDiscoveredCommonRoot(result.candidate.binding,x.archive as never)).actionAuthorized,false);
 await assert.rejects(x.coordinator.captureReadRoleCommonQuarantined(x.request,cold,x.archive as never,x.source));assert.equal(x.sourceCalls(),1);
});

test('format4 request ACK loss never enters source and fresh inspection cannot reconstitute its execution grant',async()=>{
 const x=await readRoleCommonParentFixture();x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.includes('/capture-candidate/')&&command.input.Key.endsWith('/baseline.json'))throw new Error('original request ACK lost');});
 await assert.rejects(x.coordinator.captureReadRoleCommonQuarantined(x.request,x.journal,x.archive as never,x.source));assert.equal(x.sourceCalls(),0);assert.equal(x.published(),false);
 x.f.setFault(()=>{});const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),seen=await cold.discoverCurrentCandidates(x.f.store,1);
 assert.equal(seen.catalogue.records.length,1);assert.equal(seen.catalogue.records[0]?.binding.format,4);assert.equal(seen.catalogue.records[0]?.reportPin,null);
 await assert.rejects(x.coordinator.captureReadRoleCommonQuarantined(x.request,cold,x.archive as never,x.source));assert.equal(x.sourceCalls(),0);
});

test('format4 report/root ACK losses preserve prepared or committed original roots without automatic repair',async()=>{
 for(const mode of ['report','root']){
  const x=await readRoleCommonParentFixture();
  if(mode==='report')x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.includes('/capture-candidate/')&&command.input.Key.endsWith('/observation.json'))throw new Error('report ACK lost');});
  else{const original=x.archive.publishPrepared;x.archive.publishPrepared=async()=>{await original();throw new Error('root ACK lost');};}
  await assert.rejects(x.coordinator.captureReadRoleCommonQuarantined(x.request,x.journal,x.archive as never,x.source));assert.equal(x.sourceCalls(),1);assert.equal(x.published(),mode==='root');
  x.f.setFault(()=>{});const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),seen=await cold.discoverCurrentCandidates(x.f.store,1),row=seen.catalogue.records[0]!;assert.ok(row.commonRoot);
  if(mode==='report')await assert.rejects(cold.verifyDiscoveredCommonRoot(row.binding,x.archive as never));else assert.equal((await cold.verifyDiscoveredCommonRoot(row.binding,x.archive as never)).actionAuthorized,false);
  const before=x.f.artifacts.size;await assert.rejects(x.coordinator.captureReadRoleCommonQuarantined(x.request,cold,x.archive as never,x.source));assert.equal(x.f.artifacts.size,before);assert.equal(x.sourceCalls(),1);
 }
});

test('format4 report refuses version, role, authority and catalogue-evidence substitutions even with a recomputed outer hash',async()=>{
 const x=await readRoleCommonParentFixture();await x.coordinator.captureReadRoleCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
 const mutations:Array<(r:z.infer<typeof readRoleCommonCandidateReportSchema>)=>void>=[r=>{Object.assign(r.binding,{format:3});},r=>{Object.assign(r,{providerTokenRoleVerified:true});},r=>{Object.assign(r.capture,{credentialCapability:'PRIVILEGED_MODERN_SERVER_KEY'});},
  r=>{r.capture.jwtVerification.sqlRole.oid='1';},r=>{r.authorization.projectRef='z'.repeat(20);},r=>{Object.assign(r.sqlPrivilegeWindow,{preexistingAssignedTransactionsExcludedAtEntry:false});},
  r=>{Object.assign(r.sqlPrivilegeWindow.catalogues[0]!,{held:false});},r=>{r.sqlPrivilegeWindow.capture.name='other';},r=>{r.metadataWindow.relations.pop();}];
 for(const mutate of mutations){
  const report=readRoleCommonCandidateReportSchema.parse(structuredClone(x.getReport()));mutate(report);const{observationDigest,...core}=report;assert.throws(()=>anyReportArtifact({...core,observationDigest:hash(JSON.stringify(core))}));
 }
});

test('format4 mismatched request scopes refuse before source or new custody writes',async()=>{
 const x=await readRoleCommonParentFixture(),before=x.f.artifacts.size;
 for(const key of ['captureAuthorizationDigest','sqlPrivilegeConfigurationDigest','captureConfigurationDigest','metadataWindowConfigurationDigest','journalConfigurationDigest','archiveConfigurationDigest','controlRevision'] as const){
  await assert.rejects(x.coordinator.captureReadRoleCommonQuarantined({...x.request,[key]:'0'.repeat(64)},x.journal,x.archive as never,x.source));
  assert.equal(x.sourceCalls(),0);assert.equal(x.f.artifacts.size,before);
 }
 const legacy=fixture();await assert.rejects(legacy.coordinator.captureReadRoleCommonQuarantined({},undefined as never,undefined as never,x.source));assert.equal(legacy.puts,0);
});

test('format10 current discovery refuses format4 authorization substitution or a legacy capture baseline',async()=>{
 for(const mode of ['authorization','legacy']){
  const x=await readRoleCommonParentFixture();await x.coordinator.captureReadRoleCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
  const original=x.getReport().binding;
  const altered=mode==='authorization'?{...original,candidateId:randomUUID(),captureAuthorizationDigest:'0'.repeat(64)}:
   commonCandidateBindingSchema.parse(Object.fromEntries(Object.entries({...original,format:3,kind:'MANAGED_QUARANTINED_COMMON_CAPTURE_V3',candidateId:randomUUID()}).filter(([k])=>!['captureAuthorizationDigest','sqlPrivilegeConfigurationDigest'].includes(k))));
  await new ManagedCandidateCaptureJournal(config,credentials,x.f.client).forCandidate(altered).reserve();
  const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),before=x.f.artifacts.size;
  await assert.rejects(cold.discoverCurrentCandidates(x.f.store,1));assert.equal(x.f.artifacts.size,before);assert.equal(x.sourceCalls(),1);
 }
});

test('unsupported capture catalogue permissions refuse before maintenance acquisition or provider mutation',async()=>{
 const f=fixture(),profile={configurationDigest:()=>hash('unsupported-read-role'),assertMaintenanceScope:(_raw:unknown)=>{},assertStorageScope:(_raw:unknown)=>{},observeCompatibility:async()=>({catalogueLockAclPredicatesObserved:false})};
 const coordinator=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,f.storage as never,f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory(),profile as never);
 f.value.planDigest=coordinator.planDigest();const before=f.calls.length,reads=f.reads;
 await assert.rejects(coordinator.close());assert.equal(f.puts,0);assert.equal(f.reads,reads);assert.deepEqual(f.calls.slice(before),['database-preflight']);assert.equal(f.value.phase,'READY');
 const x=await readRoleCommonParentFixture(),count=x.f.artifacts.size;x.profile.observeCompatibility=async()=>({catalogueLockAclPredicatesObserved:false});
 await assert.rejects(x.coordinator.captureReadRoleCommonQuarantined(x.request,x.journal,x.archive as never,x.source));assert.equal(x.sourceCalls(),0);assert.equal(x.f.artifacts.size,count);
});

async function captureControlRetirementFixture(integrated=false,withComparison=false,readProfile?:unknown,selectedReadFixture?:ReturnType<typeof retiredControlReadFixture>){
 const f=fixture();let deleted=false,deleteCalls=0,lostDelete=false,extraKey=false;
 const readFixture=withComparison?(selectedReadFixture??retiredControlReadFixture({installationId:config.installationId,controlId:'11111111-1111-4111-8111-111111111111'})):undefined;
 const readProbe=readFixture?.create(),readDescriptor=readProbe?.configurationDescriptor();
 const registry={installationId:config.installationId,projectRef:'abcdefghijklmnopqrst',region:'eu-west-1',bucket:'synthetic-governance',organisationId:'org-synthetic',captureKeyId:'11111111-1111-4111-8111-111111111111',writerKeys:[{id:'22222222-2222-4222-8222-222222222222',type:'secret'}]};
 const provider=new SupabaseStorageWriterControl(registry,'synthetic-management',async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,'https://api.supabase.com');
  if(init?.method==='DELETE'){
   assert.equal(url.pathname,'/v1/projects/'+registry.projectRef+'/api-keys/'+registry.captureKeyId);assert.equal(url.searchParams.get('reveal'),'false');
   deleteCalls++;deleted=true;if(readFixture)readFixture.state.retired=true;if(lostDelete)throw new Error('synthetic accepted DELETE without ACK');return Response.json({id:registry.captureKeyId,type:'secret',api_key:'discard-provider-secret-field'});
  }
  assert.equal(init?.method,'GET');
  if(url.pathname.endsWith('/config/storage'))return Response.json({features:{s3Protocol:{enabled:false}}});
  if(url.pathname.endsWith('/api-keys/legacy'))return Response.json({enabled:false});
  if(url.pathname.endsWith('/api-keys')){assert.equal(url.searchParams.get('reveal'),'false');return Response.json([...(deleted?[]:[{id:registry.captureKeyId,type:'secret'}]),...(extraKey?[{id:'33333333-3333-4333-8333-333333333333',type:'secret'}]:[])]);}
  return Response.json({ref:registry.projectRef,organization_id:registry.organisationId,region:registry.region,status:'ACTIVE_HEALTHY'});
 });
 const create=(selectedClient?:S3Client,execution=true)=>new ManagedCaptureControlRetirement(config,provider,f.store,credentials,selectedClient??f.client,
  readDescriptor?{descriptor:JSON.parse(JSON.stringify(readDescriptor)),...(execution?{probe:readProbe}:{})}:undefined),retirement=create();
 const profile=readProfile??{observeCompatibility:async()=>({catalogueLockAclPredicatesObserved:true}),configurationDigest:()=>hash('synthetic-read-role'),
  assertMaintenanceScope:(_raw:unknown)=>{},assertStorageScope:(_raw:unknown)=>{}};
 // This fixture's existing legacy proof transports share the original closure
 // flag. Keep that model while using the real retirement provider instance.
 if(integrated)provider.close=async()=>{await f.storage.close();return provider.observeClosed();};
 const coordinator=integrated?new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store,provider,
  f.proof as never,f.write as never,f.signedFixture.factory(),f.resumableFixture.factory(),f.signedTusFixture.factory(),f.s3Fixture.factory(),profile as never,retirement):f.coordinator;
 const plan=managedPlanSchema.parse(integrated?coordinator.planDescriptor():{...f.coordinator.planDescriptor(),format:11,storageCredentialPolicy:'REVOKE_REVIEWED_KEYS_THEN_RETIRE_CAPTURE_CONTROL_V1',
  capturePolicy:'EXPLICIT_JWT_SQL_PRIVILEGE_AND_METADATA_WINDOW_V1',captureAuthorization:hash('synthetic-read-role'),captureControlRetirement:retirement.configurationDigest()});
 // Component-only tests pin the plan directly; integrated tests above use
 // the explicit production coordinator constructor, with synthetic transports.
 if(!integrated)Object.defineProperty(f.coordinator,'planDescriptor',{value:()=>structuredClone(plan)});
 f.value.planDigest=hash(JSON.stringify(plan));const closed=await coordinator.close();
 const journal=new ManagedCandidateCaptureJournal(config,credentials,f.client);
 if(integrated)await journal.publishPlanBootstrap(plan,await f.store.observe());else await f.coordinator.publishCaptureBootstrap(journal);
 return{f,provider,retirement,create,plan,coordinator,profile,closed,readProbe,readDescriptor,readFixture,get deletes(){return deleteCalls;},get deleted(){return deleted;},set lostDelete(v:boolean){lostDelete=v;},set extraKey(v:boolean){extraKey=v;}};
}

test('format11 retirement records original intent before exact key deletion; cold inspection is read-only',async()=>{
 const x=await captureControlRetirementFixture();let requestAcknowledged=false;
 const original=x.provider.retireCaptureControl.bind(x.provider);
 x.provider.retireCaptureControl=async signal=>{assert.equal(requestAcknowledged,true);return original(signal);};
 x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.endsWith('capture-control-baseline.json'))requestAcknowledged=true;});
 const result=await x.retirement.retire(x.plan);assert.equal(x.deletes,1);assert.equal(x.deleted,true);
 assert.equal(result.report.originalDeleteAcknowledgementObserved,true);assert.equal(result.report.observation.retainedCaptureKeys,0);
 assert.equal(JSON.stringify(result).includes('discard-provider-secret-field'),false);assert.equal(result.wholeBackendQuiesced,false);
 const before=x.f.artifacts.size,writes=x.f.puts;
 const cold=await x.create().inspect(x.plan);assert.equal(cold.originalAcknowledgementReconstructed,false);assert.equal(cold.savedObservationAuthorizesExecution,false);
 assert.equal(cold.current.controlPlaneWritersExcluded,false);assert.equal(x.f.artifacts.size,before);assert.equal(x.f.puts,writes);assert.equal(x.deletes,1);
 await assert.rejects(x.retirement.retire(x.plan));await assert.rejects(x.create().retire(x.plan));assert.equal(x.deletes,1);
 const lists=x.f.calls.filter(v=>v==='candidate-list').length;
 await assert.rejects(new ManagedCandidateCaptureJournal(config,credentials,x.f.client).discoverCurrentCandidates(x.f.store,1));
 assert.equal(x.f.calls.filter(v=>v==='candidate-list').length,lists);
});

test('lost retirement request acknowledgement prevents DELETE and cannot be reconstructed by a fresh caller',async()=>{
 const x=await captureControlRetirementFixture();let lose=true;
 x.f.setFault(command=>{if(lose&&command instanceof GetObjectCommand&&command.input.Key?.endsWith('capture-control-baseline.json'))throw new Error('synthetic lost original request ACK');});
 await assert.rejects(x.retirement.retire(x.plan));assert.equal(x.deletes,0);assert.equal(x.f.artifacts.size>0,true);
 lose=false;await assert.rejects(x.create().retire(x.plan));await assert.rejects(x.create().inspect(x.plan));assert.equal(x.deletes,0);
});

test('accepted DELETE with unknown ACK preserves requested-only evidence, never replaying or inventing a report',async()=>{
 const x=await captureControlRetirementFixture();x.lostDelete=true;
 await assert.rejects(x.retirement.retire(x.plan));assert.equal(x.deletes,1);assert.equal(x.deleted,true);
 assert.equal([...x.f.artifacts.keys()].some(k=>k.endsWith('capture-control-observation.json')),false);
 assert.equal((await x.provider.observeCaptureControlRetired()).retainedCaptureKeys,0);
 await assert.rejects(x.create().retire(x.plan));await assert.rejects(x.create().inspect(x.plan));assert.equal(x.deletes,1);
});

test('lost retirement report acknowledgement allows saved inspection but never a repeated DELETE',async()=>{
 const x=await captureControlRetirementFixture();let lose=true;
 x.f.setFault(command=>{if(lose&&command instanceof GetObjectCommand&&command.input.Key?.endsWith('capture-control-observation.json'))throw new Error('synthetic lost report ACK');});
 await assert.rejects(x.retirement.retire(x.plan));assert.equal(x.deletes,1);lose=false;
 assert.equal((await x.create().inspect(x.plan)).originalAcknowledgementReconstructed,false);
 await assert.rejects(x.create().retire(x.plan));assert.equal(x.deletes,1);
});

test('retirement refuses changed policy, head, registry, cancellation and recreated keys',async()=>{
 for(const mode of ['legacy-plan','digest','head-after-request','extra-key','cancelled']){
  const x=await captureControlRetirementFixture(),plan=structuredClone(x.plan),before=x.f.artifacts.size;
  if(mode==='legacy-plan'){(plan as {format:number}).format=10;}
  if(mode==='digest'&&plan.format===11)plan.captureControlRetirement=hash('wrong');
  if(mode==='head-after-request')x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.endsWith('capture-control-baseline.json'))x.f.value={...x.f.value,publicationId:randomUUID()};});
  if(mode==='extra-key')x.extraKey=true;const controller=new AbortController();if(mode==='cancelled')controller.abort();
  await assert.rejects(x.retirement.retire(plan,controller.signal));assert.equal(x.deletes,0,mode);
  if(['legacy-plan','digest','cancelled'].includes(mode))assert.equal(x.f.artifacts.size,before,mode);
 }
 const x=await captureControlRetirementFixture();await x.retirement.retire(x.plan);x.extraKey=true;
 await assert.rejects(x.create().inspect(x.plan));assert.equal(x.deletes,1);
});

test('retirement custody uses real SDK serialization, exact-version readback and conditional conflict without KMS generation',async()=>{
 const x=await captureControlRetirementFixture(),sdk=archivedSdkBackend({...archivedSdkConfig,installationId:config.installationId,bucket:config.bucket,storageKeyArn:config.kmsKeyArn}),client=sdk.s3();
 try{
  const original=await x.create(client).retire(x.plan);assert.equal(x.deletes,1);assert.equal(sdk.writes,2);assert.equal(sdk.generates,0);
  const cold=await x.create(client).inspect(x.plan);assert.deepEqual(cold.reportPin,original.reportPin);assert.equal(sdk.writes,2);
  await assert.rejects(x.create(client).retire(x.plan));assert.equal(x.deletes,1);assert.equal(sdk.writes,3);assert.equal(sdk.objects.size,2);
  assert.deepEqual((await x.create(client).inspect(x.plan)).reportPin,original.reportPin);
 }finally{sdk.close();client.destroy();}
});

test('retirement inspection refuses internally altered reports even when latest transport checksums agree',async()=>{
 for(const change of ['observation','pin','claim','binding']){
  const x=await captureControlRetirementFixture();await x.retirement.retire(x.plan);
  const row=[...x.f.artifacts].find(([key])=>key.endsWith('capture-control-observation.json'))![1];
  const report=JSON.parse(row.body);
  if(change==='observation')report.observation.stateSha256=hash('changed');
  if(change==='pin')report.requestPin.versionId='substituted-version';
  if(change==='claim')report.observation.wholeStorageQuiesced=true;
  if(change==='binding')report.binding.sourceSha='9'.repeat(40);
  row.body=JSON.stringify(report);await assert.rejects(x.create().inspect(x.plan));assert.equal(x.deletes,1);
 }
});

test('explicit coordinator format11 preserves positive controls before retirement and never replays them afterwards',async()=>{
 const x=await captureControlRetirementFixture(true);assert.equal(x.coordinator.planDescriptor().format,11);assert.equal(x.plan.format,11);
 assert.equal('captureControlRetirementRequired' in x.closed&&x.closed.captureControlRetirementRequired,true);
 assert.equal('captureControlRetirementAcknowledged' in x.closed&&x.closed.captureControlRetirementAcknowledged,false);assert.equal(x.deletes,0);
 const before=x.f.calls.filter(v=>v==='read-proof').length;await assert.rejects(x.coordinator.inspect());
 assert.equal(x.f.calls.filter(v=>v==='read-proof').length,before);
 const result=await x.coordinator.retireCaptureControl();assert.equal(result.report.originalDeleteAcknowledgementObserved,true);assert.equal(x.deletes,1);
 assert.equal(x.f.calls.filter(v=>v==='read-proof').length,before);
 x.provider.observeClosed=async()=>{throw new Error('retired-key positive control must never run');};
 x.f.proof.verifyReadRefusal=async()=>{throw new Error('legacy credential read proof must never rerun');};
 const writes=x.f.artifacts.size,reads=x.f.calls.filter(v=>v==='read-proof').length;
 const inspected=await x.coordinator.inspect();assert.equal(inspected.credentialReadRefusalsObserved,false);assert.equal(inspected.freshReadObservation,null);
 assert.ok('captureControlRetirement' in inspected);assert.equal('freshRetiredControlDataPlaneRefusalVerified' in inspected&&inspected.freshRetiredControlDataPlaneRefusalVerified,false);
 assert.equal(inspected.wholeBackendQuiesced,false);assert.equal(x.f.artifacts.size,writes);assert.equal(x.f.calls.filter(v=>v==='read-proof').length,reads);
 await assert.rejects(x.coordinator.retireCaptureControl());assert.equal(x.deletes,1);
});

test('retirement coordinator requires matching original component instances and read-role policy',async()=>{
 const x=await captureControlRetirementFixture(true);
 const build=(readRole:unknown,retirement:ManagedCaptureControlRetirement,storage=x.provider,control=x.f.store)=>new ManagedBackendMaintenance(operation,x.f.provider as never,x.f.database as never,control,storage,
  x.f.proof as never,x.f.write as never,x.f.signedFixture.factory(),x.f.resumableFixture.factory(),x.f.signedTusFixture.factory(),x.f.s3Fixture.factory(),readRole as never,retirement);
 assert.throws(()=>build(undefined,x.retirement));assert.throws(()=>build(x.profile,x.retirement,x.f.s3Metadata));
 const other=fixture();assert.throws(()=>build(x.profile,x.retirement,x.provider,other.store));
 assert.throws(()=>x.retirement.assertCoordinatorScope('different-installation',x.provider,x.f.store));assert.equal(x.deletes,0);
 const legacy=fixture();await assert.rejects(legacy.coordinator.retireCaptureControl());assert.equal(legacy.puts,0);assert.equal(legacy.calls.length,0);
});

test('coordinator retirement refuses missing original artifacts or unknown request ACK before key mutation',async()=>{
 for(const mode of ['missing-original','lost-request']){
  const x=await captureControlRetirementFixture(true),readProofs=x.f.calls.filter(v=>v==='read-proof').length;
  if(mode==='missing-original'){
   const key=[...x.f.artifacts.keys()].find(k=>k.endsWith('/write-baseline.json'));assert.ok(key);x.f.artifacts.delete(key);
  }else x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.endsWith('capture-control-baseline.json'))throw new Error('synthetic unknown original ACK');});
  await assert.rejects(x.coordinator.retireCaptureControl());assert.equal(x.deletes,0);assert.equal(x.f.calls.filter(v=>v==='read-proof').length,readProofs);
  await assert.rejects(x.coordinator.inspect());assert.equal(x.deletes,0);
 }
});

test('format12 acknowledges intent before canary reads and exact baseline before DELETE; cold inspection needs no capture credential',async t=>{
 const x=await captureControlRetirementFixture(true,true);assert.equal(x.plan.format,12);assert.equal(x.readFixture!.state.requests.length,0);
 let intentAcknowledged=false,readBaselineAcknowledged=false;
 x.f.setFault(command=>{if(command instanceof GetObjectCommand){if(command.input.Key?.endsWith('/capture-control-baseline.json'))intentAcknowledged=true;
  if(command.input.Key?.endsWith('/capture-control-read-baseline.json'))readBaselineAcknowledged=true;}});
 const baseline=x.readProbe!.baseline.bind(x.readProbe!);x.readProbe!.baseline=async signal=>{assert.equal(intentAcknowledged,true);return baseline(signal);};
 const remove=x.provider.retireCaptureControl.bind(x.provider);x.provider.retireCaptureControl=async signal=>{assert.equal(readBaselineAcknowledged,true);return remove(signal);};
 const result=await x.coordinator.retireCaptureControl();assert.equal(result.report.format,2);assert.equal(x.deletes,1);assert.equal(x.readFixture!.state.requests.length,11);
 if(result.report.format!==2)throw new Error('missing comparison report');
 assert.equal(result.report.originalReadBaselineAcknowledgementObserved,true);assert.equal(result.report.readRefusal.retiredControlCanaryGetRefusalObserved,true);
 const inspection=await x.coordinator.inspect();assert.ok('recordedRetiredControlCanaryGetRefusalObserved' in inspection);
 assert.equal(inspection.recordedRetiredControlCanaryGetRefusalObserved,true);assert.equal(inspection.freshRetiredControlDataPlaneRefusalVerified,false);
 assert.equal(x.readFixture!.state.requests.length,11);
 const lists=x.f.calls.filter(v=>v==='candidate-list').length;
 const current=await new ManagedCandidateCaptureJournal(config,credentials,x.f.client).discoverCurrentCandidates(x.f.store,1);
 assert.equal(current.plan.format,12);assert.equal(current.catalogue.records.length,0);assert.equal(current.originalAcknowledgementReconstructed,false);
 assert.ok(x.f.calls.filter(v=>v==='candidate-list').length>lists);
 const retained=await new ManagedSavedRetirementCustody(config,credentials,x.f.client).inspect(await x.f.store.observe(),x.plan);
 assert.deepEqual(retained.bundle.report.pin,result.reportPin);assert.equal(retained.currentProviderFencingVerified,false);
 const before=x.readFixture!.state.requests.length,writes=x.f.artifacts.size,now=Date.now();
 t.mock.method(Date,'now',()=>now+600000);assert.throws(()=>x.readFixture!.positive.readRoleVerificationEvidence());
 x.readProbe!.configurationDescriptor=()=>{throw new Error('cold reader must not use original execution object');};
 const cold=x.create(undefined,false),saved=await cold.inspect(x.plan);
 assert.equal(saved.report.format,2);assert.equal(saved.originalAcknowledgementReconstructed,false);assert.equal(x.readFixture!.state.requests.length,before);
 await assert.rejects(cold.retire(x.plan));assert.equal(x.f.artifacts.size,writes);assert.equal(x.deletes,1);
});

test('format12 keeps intent, baseline, DELETE, refusal and report ACK loss distinct with no probe or deletion replay',async()=>{
 for(const stage of ['intent','read-baseline','delete','refusal','report']){
  const x=await captureControlRetirementFixture(true,true);let lose=true;
  if(stage==='delete')x.lostDelete=true;
  if(stage==='refusal')x.readFixture!.state.afterFault='hash';
  x.f.setFault(command=>{if(!lose||!(command instanceof GetObjectCommand))return;
   const suffix=stage==='intent'?'/capture-control-baseline.json':stage==='read-baseline'?'/capture-control-read-baseline.json':stage==='report'?'/capture-control-observation.json':null;
   if(suffix&&command.input.Key?.endsWith(suffix))throw new Error('synthetic lost '+stage+' ACK');});
  await assert.rejects(x.coordinator.retireCaptureControl());assert.equal(x.deletes,['delete','refusal','report'].includes(stage)?1:0,stage);
  assert.equal(x.readFixture!.state.requests.length,stage==='intent'?0:stage==='read-baseline'||stage==='delete'?6:11,stage);
  const before=x.readFixture!.state.requests.length;lose=false;
  await assert.rejects(x.create().retire(x.plan));assert.equal(x.readFixture!.state.requests.length,before,stage);
  if(stage==='report')assert.equal((await x.create(undefined,false).inspect(x.plan)).report.format,2);
  else await assert.rejects(x.create(undefined,false).inspect(x.plan));
  assert.equal(x.readFixture!.state.requests.length,before,stage);
 }
});

test('format12 SDK custody preserves all three original records and refuses pin or public descriptor substitution',async()=>{
 const x=await captureControlRetirementFixture(true,true),sdk=archivedSdkBackend({...archivedSdkConfig,installationId:config.installationId,bucket:config.bucket,storageKeyArn:config.kmsKeyArn}),client=sdk.s3();
 try{
  const result=await x.create(client).retire(x.plan);assert.equal(result.report.format,2);assert.equal(sdk.writes,3);assert.equal(sdk.objects.size,3);assert.equal(sdk.generates,0);
  const reader=new ManagedSavedRetirementCustody(config,credentials,client),saved=await reader.inspect(await x.f.store.observe(),x.plan);
  assert.deepEqual(saved.bundle.report.pin,result.reportPin);assert.equal(saved.originalAcknowledgementReconstructed,false);assert.equal(JSON.stringify(reader),'{}');assert.equal(sdk.writes,3);
  const before=x.readFixture!.state.requests.length;assert.equal((await x.create(client,false).inspect(x.plan)).report.format,2);assert.equal(sdk.writes,3);
  await assert.rejects(x.create(client).retire(x.plan));assert.equal(sdk.objects.size,3);assert.equal(x.readFixture!.state.requests.length,before);
 }finally{sdk.close();client.destroy();}
 const y=await captureControlRetirementFixture(true,true);await y.coordinator.retireCaptureControl();
 const row=[...y.f.artifacts].find(([key])=>key.endsWith('/capture-control-observation.json'))![1],report=JSON.parse(row.body);
 const original=row.body;
 report.readBaselinePin.versionId='substituted-version';row.body=JSON.stringify(report);await assert.rejects(y.create(undefined,false).inspect(y.plan));assert.equal(y.deletes,1);
 const inverted=JSON.parse(original),o=inverted.observation;
 o.observedAt=new Date(Date.parse(inverted.readRefusal.startedAt)-60000).toISOString();
 o.observationDigest=hash(JSON.stringify({format:o.format,kind:o.kind,installationId:o.installationId,projectRef:o.projectRef,bucket:o.bucket,
  captureKeyId:o.captureKeyId,storageConfigurationDigest:o.storageConfigurationDigest,observedAt:o.observedAt,stateSha256:o.stateSha256}));
 row.body=JSON.stringify(inverted);await assert.rejects(y.create(undefined,false).inspect(y.plan));
 const wrong=JSON.parse(JSON.stringify(y.readDescriptor));wrong.positiveReader.credential.sha256='0'.repeat(64);
 assert.throws(()=>new ManagedCaptureControlRetirement(config,y.provider,y.f.store,credentials,y.f.client,{descriptor:wrong}));
});

test('format12 rechecks the original head and cancellation around the new baseline ACK before DELETE',async()=>{
 for(const mode of ['head-after-read','head-after-ack','cancel-after-ack']){
  const x=await captureControlRetirementFixture(true,true),controller=new AbortController();
  if(mode==='head-after-read'){
   const original=x.readProbe!.baseline.bind(x.readProbe!);x.readProbe!.baseline=async signal=>{const result=await original(signal);x.f.value={...x.f.value,publicationId:randomUUID()};return result;};
  }else x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.endsWith('/capture-control-read-baseline.json')){
   if(mode==='head-after-ack')x.f.value={...x.f.value,publicationId:randomUUID()};else controller.abort();
  }});
  await assert.rejects(x.coordinator.retireCaptureControl(controller.signal));assert.equal(x.deletes,0,mode);
  assert.equal([...x.f.artifacts.keys()].some(k=>k.endsWith('/capture-control-observation.json')),false);
 }
});

test('format5 capture pins original retirement records, source context and quarantine root; current discovery rereads independent custody',async()=>{
 const x=await readRoleCommonParentFixture(true),result=await x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
 assert.equal(result.candidate.kind,'MANAGED_QUARANTINED_RETIRED_CONTROL_COMMON_CANDIDATE');assert.equal(result.candidate.binding.format,5);assert.equal(x.sourceCalls(),1);
 if(result.candidate.kind!=='MANAGED_QUARANTINED_RETIRED_CONTROL_COMMON_CANDIDATE')throw new Error('wrong candidate kind');
 assert.equal(result.actionAuthorized,false);assert.equal(x.retirement!.readFixture!.state.requests.length,21);
 const context=x.context() as {bindingDigest:string};assert.equal(context.bindingDigest,hash(JSON.stringify(result.candidate.binding)));
 const before=x.f.artifacts.size,cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),found=await cold.discoverCurrentCandidates(x.f.store,1);
 assert.equal(found.plan.format,12);assert.equal(found.catalogue.records[0]!.binding.format,5);assert.equal(found.catalogue.records[0]!.commonRoot?.pin.sha256,result.candidate.rootReference.pin.sha256);
 assert.equal('retirementEvidence' in found,true);assert.equal(found.originalAcknowledgementReconstructed,false);assert.equal(x.f.artifacts.size,before);
 await assert.rejects(x.coordinator.captureRetiredControlCommonQuarantined(x.request,cold,x.archive as never,x.source));assert.equal(x.sourceCalls(),1);
});

test('format5 original candidate ACK precedes fresh probes and source; substituted retirement pins refuse before writes',async()=>{
 const x=await readRoleCommonParentFixture(true),probes=x.retirement!.readFixture!.state.requests.length;
 x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.includes('/capture-candidate/')&&command.input.Key.endsWith('/baseline.json'))throw new Error('synthetic lost original candidate ACK');});
 await assert.rejects(x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,x.source));assert.equal(x.sourceCalls(),0);assert.equal(x.retirement!.readFixture!.state.requests.length,probes);
 x.f.setFault(()=>undefined);await assert.rejects(x.coordinator.captureRetiredControlCommonQuarantined(x.request,new ManagedCandidateCaptureJournal(config,credentials,x.f.client),x.archive as never,x.source));assert.equal(x.sourceCalls(),0);
 const y=await readRoleCommonParentFixture(true),request=structuredClone(y.request),before=y.f.artifacts.size;request.retirementReportPin!.versionId='wrong-original-version';
 await assert.rejects(y.coordinator.captureRetiredControlCommonQuarantined(request,y.journal,y.archive as never,y.source));assert.equal(y.sourceCalls(),0);assert.equal(y.f.artifacts.size,before);
 await assert.rejects(y.coordinator.captureReadRoleCommonQuarantined(y.request,y.journal,y.archive as never,y.source));assert.equal(y.sourceCalls(),0);
});

test('format5 report and root ACK losses preserve original prepared state without automatic publication repair',async()=>{
 for(const mode of ['report','root']){
  const x=await readRoleCommonParentFixture(true);
  if(mode==='report')x.f.setFault(command=>{if(command instanceof GetObjectCommand&&command.input.Key?.includes('/capture-candidate/')&&command.input.Key.endsWith('/observation.json'))throw new Error('synthetic lost format5 report ACK');});
  else{const original=x.archive.publishPrepared;x.archive.publishPrepared=async()=>{await original();throw new Error('synthetic lost root ACK');};}
  await assert.rejects(x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,x.source));assert.equal(x.sourceCalls(),1);assert.equal(x.published(),mode==='root');
  x.f.setFault(()=>undefined);const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client),seen=await cold.discoverCurrentCandidates(x.f.store,1),row=seen.catalogue.records[0]!;
  assert.equal(row.binding.format,5);assert.ok(row.commonRoot);
  if(mode==='report')await assert.rejects(cold.verifyDiscoveredCommonRoot(row.binding,x.archive as never));else assert.equal((await cold.verifyDiscoveredCommonRoot(row.binding,x.archive as never)).actionAuthorized,false);
  const before=x.f.artifacts.size;await assert.rejects(x.coordinator.captureRetiredControlCommonQuarantined(x.request,cold,x.archive as never,x.source));assert.equal(x.f.artifacts.size,before);assert.equal(x.sourceCalls(),1);
 }
});

test('format5 cold discovery refuses missing or replaced original retirement objects despite the embedded report copy',async()=>{
 for(const mode of ['missing','replacement','wrong-key']){
  const x=await readRoleCommonParentFixture(true);await x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
  const key=[...x.f.artifacts.keys()].find(k=>k.endsWith('/capture-control-read-baseline.json'))!;
  if(mode==='missing')x.f.artifacts.delete(key);else if(mode==='replacement')x.f.artifacts.get(key)!.version+='-replacement';
  const before=x.f.artifacts.size,probes=x.retirement!.readFixture!.state.requests.length;
  if(mode==='wrong-key')await assert.rejects(new ManagedSavedRetirementCustody({...config,kmsKeyArn:config.kmsKeyArn.replace('11111111-','99999999-')},credentials,x.f.client).inspect(await x.f.store.observe(),x.coordinator.planDescriptor()));
  else {
   const cold=new ManagedCandidateCaptureJournal(config,credentials,x.f.client);
   await assert.rejects(cold.discoverCurrentCandidates(x.f.store,1));
   await assert.rejects(cold.verifyDiscoveredCommonRoot(x.getReport().binding,x.archive as never));
  }
  assert.equal(x.f.artifacts.size,before);assert.equal(x.retirement!.readFixture!.state.requests.length,probes);
 }
});

test('format5 refuses altered retirement pins, plan, canary evidence and broad authority claims with recomputed outer hashes',async()=>{
 const x=await readRoleCommonParentFixture(true);await x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
 for(const mode of ['pin','plan','canary-key','capture-key','authority']){
  const v=retiredControlCommonCandidateReportSchema.parse(structuredClone(x.getReport()));
  if(mode==='pin')v.retirement.evidence.readBaseline.pin.versionId='not-original';
  if(mode==='plan'&&v.retirement.plan.format===12)v.retirement.plan.captureControlRetirement='0'.repeat(64);
  if(mode==='capture-key')v.capture.jwtVerification.verificationKeySha256='0'.repeat(64);
  if(mode==='authority')Object.assign(v,{retainedPrivilegedCredentialsExcluded:true});
  if(mode==='canary-key'){
   const p=v.retirement.before.freshReadRefusal;p.positiveJwt.verificationKeySha256='0'.repeat(64);
   const facts={format:p.format,kind:p.kind,configurationDigest:p.configurationDigest,baselineSha256:p.baselineSha256,retiredControlId:p.retiredControlId,canarySha256:p.canarySha256,bytes:p.bytes,status:p.status,startedAt:p.startedAt,observedAt:p.observedAt,positiveJwt:p.positiveJwt};p.observationDigest=hash(JSON.stringify(facts));
  }
  const{observationDigest,...core}=v;assert.throws(()=>anyReportArtifact({...core,observationDigest:hash(JSON.stringify(core))}));
 }
});

test('format5 current head movement or a failed post-source canary comparison prevents source or archive publication',async()=>{
 for(const mode of ['head','after']){
  const x=await readRoleCommonParentFixture(true);let source=x.source;
  if(mode==='head'){
   const original=x.retirement!.readProbe!.verifyRefusal.bind(x.retirement!.readProbe!);x.retirement!.readProbe!.verifyRefusal=async(...args)=>{const result=await original(...args);x.f.value={...x.f.value,publicationId:randomUUID()};return result;};
  }else{const original=source;source=async(...args)=>{const result=await original(...args);x.retirement!.readFixture!.state.afterFault='hash';return result;};}
  await assert.rejects(x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,source));
  assert.equal(x.sourceCalls(),mode==='head'?0:1);assert.equal(x.published(),false);assert.equal(x.events.includes('prepare'),false);
 }
});

function epochStoreFixture(){
 const wrap=(v:unknown)=>{const body=JSON.stringify(v);return{body,sha256:hash(body)};};
 const genesis=wrap(epochSchemas.head.parse({format:1,kind:'MANAGED_RECOVERY_EPOCH_HEAD_V1',installationId:config.installationId,sequence:0,entryPin:null,publicationId:randomUUID()}));
 const selected={installationId:config.installationId,storeConfigurationDigest:hash('separate-epoch-store'),genesisHeadSha256:genesis.sha256,trustedCheckpoint:{sequence:0,sha256:genesis.sha256}};
 type Record=z.infer<typeof epochSchemas.record>;type Pin=z.infer<typeof epochSchemas.pin>;type Artifact=z.infer<typeof epochSchemas.artifact>;
 let current:Record={revision:'independent-version-0',artifact:genesis},sequence=0,entryAttempts=0,headAttempts=0,reads=0;
 const entries=new Map<number,{pin:Pin;artifact:Artifact}>(),state={loseEntryAck:false,loseHeadAck:false,onHeadRead:undefined as (()=>void)|undefined};
 const reader:ManagedRecoveryEpochReader={configurationDigest:()=>selected.storeConfigurationDigest,
  readHead:async signal=>{signal.throwIfAborted();reads++;state.onHeadRead?.();return structuredClone(current);},
  readEntry:async(n,_pin,signal)=>{signal.throwIfAborted();const row=entries.get(n);if(!row)throw new Error('Missing original epoch');return structuredClone(row);}};
 const writer:ManagedRecoveryEpochWriter={configurationDigest:reader.configurationDigest,
  createEntry:async(n,artifact,signal)=>{signal.throwIfAborted();entryAttempts++;if(entries.has(n))throw new Error('Original conditional conflict');
   const pin=epochSchemas.pin.parse({kind:'BASELINE',versionId:'original-entry-'+n,sha256:artifact.sha256,byteLength:Buffer.byteLength(artifact.body)});entries.set(n,{pin,artifact:structuredClone(artifact)});
   if(state.loseEntryAck)throw new Error('Stored entry ACK unknown');return pin;},
  replaceHead:async(expected,artifact,signal)=>{signal.throwIfAborted();headAttempts++;if(expected!==current.revision)throw new Error('Original head conflict');
   current={revision:'independent-version-'+(++sequence),artifact:structuredClone(artifact)};if(state.loseHeadAck)throw new Error('Stored head ACK unknown');return structuredClone(current);}};
 const catalogue=()=>new ManagedRecoveryEpochCatalogue(selected,reader);
 return{selected,state,reader,writer,entries,wrap,catalogue,publisher:()=>new ManagedRecoveryEpochPublisher(catalogue(),reader,writer),
  get current(){return structuredClone(current);},set current(v:Record){current=structuredClone(v);},
  get counts(){return{entryAttempts,headAttempts,reads};}};
}
async function closedEpochFixture(epoch=1){
 const f=fixture({epoch});await f.coordinator.close();const journal=new ManagedCandidateCaptureJournal(config,credentials,f.client);
 await f.coordinator.publishCaptureBootstrap(journal);return{f,journal,archiveDigest:hash('synthetic-epoch-archive')};
}

test('separate epoch catalogue follows original closed lineage and enforces an external checkpoint without granting authority',async()=>{
 const store=epochStoreFixture(),a=await closedEpochFixture(),b=await closedEpochFixture(2);
 const empty=await store.catalogue().observe();assert.equal(empty.entryCount,0);assert.equal(empty.latest,null);
 const first=await store.publisher().publishClosedEpoch(a.f.store,a.journal,a.archiveDigest,store.current.revision);const firstHead=store.current;
 assert.equal(first.originalEntryAcknowledgementObserved,true);assert.equal(first.originalHeadAcknowledgementObserved,true);
 await store.publisher().publishClosedEpoch(b.f.store,b.journal,b.archiveDigest,store.current.revision);
 const writesBeforeReplay=store.counts.entryAttempts;
 await assert.rejects(store.publisher().publishClosedEpoch(b.f.store,b.journal,b.archiveDigest,store.current.revision));
 assert.equal(store.counts.entryAttempts,writesBeforeReplay);
 const before=store.counts,observed=await store.catalogue().observe();assert.equal(observed.entryCount,2);assert.equal(observed.latest!.plan.maintenanceEpoch,2);
 for(const key of ['providerRollbackExclusionVerified','independentCustodyVerified','currentTenantAuthorityVerified','completeHistoryVerified','originalAcknowledgementReconstructed','executionAuthorized','reopeningAuthorized','actionAuthorized'] as const)assert.equal(observed[key],false);
 assert.equal(store.counts.entryAttempts,before.entryAttempts);assert.equal(store.counts.headAttempts,before.headAttempts);
 const pinned={...store.selected,trustedCheckpoint:{sequence:2,sha256:store.entries.get(2)!.artifact.sha256}};
 assert.equal(new ManagedRecoveryEpochCatalogue(pinned,store.reader).configurationDigest(),store.catalogue().configurationDigest());
 await new ManagedRecoveryEpochCatalogue(pinned,store.reader).observe();store.current=firstHead;
 await assert.rejects(new ManagedRecoveryEpochCatalogue(pinned,store.reader).observe());
});

test('epoch publication lost entry or head ACK never permits replay or reconstructed acknowledgement',async()=>{
 for(const loss of ['entry','head']){
  const store=epochStoreFixture(),x=await closedEpochFixture(),original=store.current;
  if(loss==='entry')store.state.loseEntryAck=true;else store.state.loseHeadAck=true;
  await assert.rejects(store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,original.revision));
  const observed=await store.catalogue().observe();assert.equal(observed.entryCount,loss==='head'?1:0);assert.equal(observed.originalAcknowledgementReconstructed,false);
  store.state.loseEntryAck=false;store.state.loseHeadAck=false;
  await assert.rejects(store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,store.current.revision));
  assert.equal(store.entries.size,1);assert.equal(store.counts.headAttempts,loss==='head'?1:0);
 }
});

test('epoch reader refuses missing originals, substituted versions, altered plans and broken genesis even with fresh outer hashes',async()=>{
 for(const change of ['missing','version','plan','prior','checkpoint']){
  const store=epochStoreFixture(),x=await closedEpochFixture();await store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,store.current.revision);
  const row=store.entries.get(1)!;
  if(change==='missing')store.entries.delete(1);
  else if(change==='version')row.pin.versionId='replacement-version';
  else if(change==='checkpoint')store.selected.trustedCheckpoint={sequence:1,sha256:'0'.repeat(64)};
  else {
   const entry=JSON.parse(row.artifact.body);
   if(change==='plan')entry.plan.sourceSha='2'.repeat(40);else entry.previousHead=store.wrap({...JSON.parse(entry.previousHead.body),publicationId:randomUUID()});
   row.artifact=store.wrap(entry);row.pin.sha256=row.artifact.sha256;row.pin.byteLength=Buffer.byteLength(row.artifact.body);
   const current=store.current;current.artifact=store.wrap({...JSON.parse(current.artifact.body),entryPin:row.pin});store.current=current;
  }
  await assert.rejects(store.catalogue().observe());assert.equal(store.counts.headAttempts,1);
 }
});

test('epoch publisher refuses wrong registry configuration, stale expected head, non-advancing epochs and drift before CAS',async()=>{
 const store=epochStoreFixture(),x=await closedEpochFixture();
 assert.throws(()=>new ManagedRecoveryEpochCatalogue({...store.selected,storeConfigurationDigest:'0'.repeat(64)},store.reader));
 await assert.rejects(store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,'stale'));assert.equal(store.counts.entryAttempts,0);
 const original=store.writer.createEntry;store.writer.createEntry=async(...args)=>{const pin=await original(...args);x.f.value={...x.f.value,publicationId:randomUUID()};return pin;};
 await assert.rejects(store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,store.current.revision));assert.equal(store.counts.headAttempts,0);
 assert.equal(store.entries.size,1);assert.equal((await store.catalogue().observe()).latest,null);
});

test('anchored format5 inspection binds original control and archive while remaining read-only and refusing drift',async()=>{
 const x=await readRoleCommonParentFixture(true);await x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
 const store=epochStoreFixture();await store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archive.configurationDigest(),store.current.revision);
 const writes=x.f.artifacts.size,originalCounts=store.counts;
 const observed=await x.journal.inspectAnchoredCurrentRecovery(store.catalogue(),x.f.store,x.archive as never);
 assert.equal(observed.epochCatalogueBoundAtReadBoundaries,true);assert.equal(observed.independentEpochProviderVerified,false);assert.equal(observed.actionAuthorized,false);
 assert.equal(x.f.artifacts.size,writes);assert.equal(store.counts.entryAttempts,originalCounts.entryAttempts);assert.equal(store.counts.headAttempts,originalCounts.headAttempts);
 await assert.rejects(x.journal.inspectAnchoredCurrentRecovery(store.catalogue(),x.f.store,{...x.archive,configurationDigest:()=>hash('wrong-archive')} as never));
 const verify=x.archive.verifySet;x.archive.verifySet=async()=>{const r=await verify();const h=store.current;h.revision+='-drift';store.current=h;return r;};
 await assert.rejects(x.journal.inspectAnchoredCurrentRecovery(store.catalogue(),x.f.store,x.archive as never));
 x.f.value={...x.f.value,publicationId:randomUUID()};await assert.rejects(x.journal.inspectAnchoredCurrentRecovery(store.catalogue(),x.f.store,x.archive as never));
});

test('epoch observation cancellation discards late head reads without entering history or writing',async()=>{
 const store=epochStoreFixture(),abort=new AbortController();let release!:(v:unknown)=>void,entries=0;
 const reader:ManagedRecoveryEpochReader={...store.reader,readHead:async()=>new Promise(resolve=>{release=resolve;}),readEntry:async(...args)=>{entries++;return store.reader.readEntry(...args);}};
 const pending=new ManagedRecoveryEpochCatalogue(store.selected,reader).observe(abort.signal);abort.abort();await assert.rejects(pending);
 release(store.current);await new Promise(resolve=>setImmediate(resolve));assert.equal(entries,0);assert.equal(store.counts.entryAttempts,0);assert.equal(store.counts.headAttempts,0);
});

test('concurrent original epoch publishers cannot create two entries or heads for one sequence',async()=>{
 const store=epochStoreFixture(),x=await closedEpochFixture(),revision=store.current.revision;
 const results=await Promise.allSettled([store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,revision),store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,revision)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(store.entries.size,1);assert.equal(store.counts.headAttempts,1);assert.equal((await store.catalogue().observe()).entryCount,1);
});

test('epoch cancellation after entry persistence cannot start head CAS when a late ACK arrives',async()=>{
 const store=epochStoreFixture(),x=await closedEpochFixture(),abort=new AbortController();
 let release!:()=>void,started!:()=>void;const entryStarted=new Promise<void>(resolve=>{started=resolve;});
 const original=store.writer.createEntry;
 store.writer.createEntry=async(...args)=>{const pin=await original(...args);started();await new Promise<void>(resolve=>{release=resolve;});return pin;};
 const pending=store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,store.current.revision,abort.signal);
 await entryStarted;abort.abort();await assert.rejects(pending);release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(store.entries.size,1);assert.equal(store.counts.headAttempts,0);assert.equal((await store.catalogue().observe()).latest,null);
});

test('epoch head drift and substituted reader configuration cannot yield a partial chain observation',async()=>{
 const store=epochStoreFixture(),x=await closedEpochFixture();await store.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,store.current.revision);
 let boundaries=0;store.state.onHeadRead=()=>{if(++boundaries===2){const current=store.current;current.revision+='-changed';store.current=current;}};
 await assert.rejects(store.catalogue().observe());assert.equal(store.counts.headAttempts,1);
 store.state.onHeadRead=undefined;const reader={...store.reader,configurationDigest:()=>hash('substituted-store')};
 assert.throws(()=>new ManagedRecoveryEpochCatalogue(store.selected,reader));
});

async function sdkEpochFixture(){
 const storage={installationId:config.installationId,bucket:archivedSdkConfig.bucket,accountId:archivedSdkConfig.accountId,kmsKeyArn:archivedSdkConfig.storageKeyArn};
 const backend=archivedSdkBackend({...archivedSdkConfig,installationId:storage.installationId}),client=backend.s3();
 const reader=()=>new S3ManagedRecoveryEpochReader(storage,credentials,client),writer=()=>new S3ManagedRecoveryEpochWriter(storage,credentials,client);
 const genesis=epochStoreFixture().current.artifact,prefix='managed-maintenance/'+storage.installationId+'/recovery-epochs/';
 // Explicit synthetic original provisioning, outside the adapter/publication API.
 await client.send(new PutObjectCommand({Bucket:storage.bucket,ExpectedBucketOwner:storage.accountId,Key:prefix+'heads/00000.json',IfNoneMatch:'*',Body:genesis.body,
  ContentType:'application/json',ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn,BucketKeyEnabled:false,ChecksumSHA256:Buffer.from(genesis.sha256,'hex').toString('base64')}));
 const selected={installationId:storage.installationId,storeConfigurationDigest:reader().configurationDigest(),genesisHeadSha256:genesis.sha256,trustedCheckpoint:{sequence:0,sha256:genesis.sha256}};
 const catalogue=()=>new ManagedRecoveryEpochCatalogue(selected,reader()),publisher=()=>new ManagedRecoveryEpochPublisher(catalogue(),reader(),writer());
 const coldClients:S3Client[]=[];
 return{storage,backend,client,prefix,reader,writer,selected,catalogue,publisher,
  freshCatalogue(){const client=backend.s3();coldClients.push(client);return new ManagedRecoveryEpochCatalogue(selected,new S3ManagedRecoveryEpochReader(storage,credentials,client));},
  async close(){client.destroy();for(const client of coldClients)client.destroy();backend.close();}};
}

test('actual signed SDK epoch adapter composes two closed epochs, read-only cold discovery and anchored format5 recovery',async()=>{
 const x=await readRoleCommonParentFixture(true);await x.coordinator.captureRetiredControlCommonQuarantined(x.request,x.journal,x.archive as never,x.source);
 const sdk=await sdkEpochFixture();
 try{
  assert.equal(JSON.stringify(sdk.reader()),'{}');assert.equal(JSON.stringify(sdk.writer()),'{}');assert.equal('createEntry' in sdk.reader(),false);
  const h=await sdk.catalogue().observe();await sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archive.configurationDigest(),h.head.revision);
  const anchored=await x.journal.inspectAnchoredCurrentRecovery(sdk.catalogue(),x.f.store,x.archive as never);
  assert.equal(anchored.epochCatalogueBoundAtReadBoundaries,true);assert.equal(anchored.currentTenantAuthorityVerified,false);
  const second=await closedEpochFixture(2);await sdk.publisher().publishClosedEpoch(second.f.store,second.journal,second.archiveDigest,(await sdk.catalogue().observe()).head.revision);
  const writes=sdk.backend.writes,generates=sdk.backend.generates,observed=await sdk.freshCatalogue().observe();assert.equal(observed.entryCount,2);assert.equal(observed.latest!.plan.maintenanceEpoch,2);
  assert.equal(sdk.backend.objects.size,5);assert.equal(sdk.backend.writes,writes);assert.equal(sdk.backend.generates,generates);assert.equal(generates,0);
  await assert.rejects(x.journal.inspectAnchoredCurrentRecovery(sdk.catalogue(),x.f.store,x.archive as never));
  assert.equal(sdk.backend.writes,writes);assert.deepEqual([...sdk.backend.objects.keys()].sort(),[sdk.prefix+'heads/00000.json',sdk.prefix+'heads/00001.json',sdk.prefix+'heads/00002.json',sdk.prefix+'entries/00001.json',sdk.prefix+'entries/00002.json'].sort());
 }finally{await sdk.close();}
});

test('SDK epoch adapter lost entry/head PUT ACKs preserve originals and refuse fresh publication replay',async()=>{
 for(const loss of ['entry','head']){
  const sdk=await sdkEpochFixture(),x=await closedEpochFixture(),handler=await sdk.client.config.requestHandler,original=handler.handle.bind(handler);
  let lost=false;const target=sdk.prefix+(loss==='entry'?'entries':'heads')+'/00001.json';
  mock.method(handler,'handle',async(...args:Parameters<typeof original>)=>{const result=await original(...args);if(!lost&&args[0].method==='PUT'&&args[0].path==='/'+target){lost=true;result.response.body?.destroy();throw new Error('PRIVATE stored SDK ACK lost');}return result;});
  try{
   await assert.rejects(sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,(await sdk.catalogue().observe()).head.revision),e=>e instanceof Error&&!e.message.includes('PRIVATE'));
   assert.equal(lost,true);const cold=await sdk.catalogue().observe();assert.equal(cold.entryCount,loss==='head'?1:0);assert.equal(cold.originalAcknowledgementReconstructed,false);
   if(loss==='entry'){
    const row=sdk.backend.objects.get(target)!,head=epochSchemas.head.parse({format:1,kind:'MANAGED_RECOVERY_EPOCH_HEAD_V1',installationId:sdk.storage.installationId,sequence:1,
     entryPin:{kind:'BASELINE',versionId:row.version,sha256:hash(row.body.toString()),byteLength:row.body.length},publicationId:randomUUID()});
    const body=JSON.stringify(head),writes=sdk.backend.writes,reads=sdk.backend.reads;
    await assert.rejects(sdk.writer().replaceHead(cold.head.revision,{body,sha256:hash(body)},new AbortController().signal));
    assert.equal(sdk.backend.writes,writes);assert.equal(sdk.backend.reads,reads);
   }
   await assert.rejects(sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,cold.head.revision));
   assert.equal(sdk.backend.objects.size,loss==='head'?3:2);assert.equal(sdk.backend.generates,0);
  }finally{await sdk.close();}
 }
});

test('SDK epoch object metadata, byte drift and malformed listings refuse without writes or data keys',async()=>{
 for(const mode of ['version','kms','checksum','checksum-type','size','bucket-key','delete-marker','encoding','noncanonical','scope','gap']){
  const sdk=await sdkEpochFixture(),handler=await sdk.client.config.requestHandler,original=handler.handle.bind(handler);
  mock.method(handler,'handle',async(...args:Parameters<typeof original>)=>{
   const result=await original(...args),request=args[0],headers=result.response.headers;
   if(request.query['list-type']==='2'&&mode==='scope'){
    const body='<ListBucketResult><Name>'+sdk.storage.bucket+'</Name><Prefix>other/</Prefix><MaxKeys>1000</MaxKeys><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>';
    result.response.body?.destroy();result.response.body=Readable.from([Buffer.from(body)]);return result;
   }
   if(request.method==='GET'&&request.query['list-type']!=='2'){
    if(mode==='version')headers['x-amz-version-id']='null';
    if(mode==='kms')headers['x-amz-server-side-encryption-aws-kms-key-id']=sdk.storage.kmsKeyArn.replace(/key\/.+$/,'key/99999999-9999-4999-8999-999999999999');
    if(mode==='checksum')headers['x-amz-checksum-sha256']=Buffer.alloc(32).toString('base64');
    if(mode==='checksum-type')headers['x-amz-checksum-type']='COMPOSITE';
    if(mode==='size')headers['content-length']='65537';
    if(mode==='bucket-key')headers['x-amz-server-side-encryption-bucket-key-enabled']='true';
    if(mode==='delete-marker')headers['x-amz-delete-marker']='true';
    if(mode==='encoding')headers['content-encoding']='gzip';
    if(mode==='noncanonical'){
     const bytes=Buffer.from(' '+epochStoreFixture().current.artifact.body);result.response.body?.destroy();result.response.body=Readable.from([bytes]);
     headers['content-length']=String(bytes.length);headers['x-amz-checksum-sha256']=Buffer.from(hash(bytes.toString()),'hex').toString('base64');
    }
   }
   return result;
  });
  if(mode==='gap'){const row=sdk.backend.objects.get(sdk.prefix+'heads/00000.json')!;sdk.backend.objects.delete(sdk.prefix+'heads/00000.json');sdk.backend.objects.set(sdk.prefix+'heads/00001.json',row);}
  try{const writes=sdk.backend.writes;await assert.rejects(sdk.catalogue().observe(),'metadata mode='+mode);assert.equal(sdk.backend.writes,writes);assert.equal(sdk.backend.generates,0);}finally{await sdk.close();}
 }
});

test('SDK epoch reader distinguishes identical ETags/bodies from a changed physical version at the last boundary',async()=>{
 const sdk=await sdkEpochFixture(),handler=await sdk.client.config.requestHandler,original=handler.handle.bind(handler);let currentReads=0;
 mock.method(handler,'handle',async(...args:Parameters<typeof original>)=>{const result=await original(...args);
  if(args[0].method==='GET'&&args[0].query['list-type']!=='2'&&!args[0].query.versionId&&++currentReads===2)result.response.headers['x-amz-version-id']='different-real-version-same-etag-and-bytes';return result;});
 try{const writes=sdk.backend.writes;await assert.rejects(sdk.catalogue().observe());assert.equal(currentReads,2);assert.equal(sdk.backend.writes,writes);}finally{await sdk.close();}
});

test('SDK epoch cancellation discards a late GET response and starts no exact readback or publication',async()=>{
 const sdk=await sdkEpochFixture(),handler=await sdk.client.config.requestHandler,original=handler.handle.bind(handler),abort=new AbortController();
 let release!:()=>void,started!:()=>void,gets=0;const entered=new Promise<void>(resolve=>{started=resolve;});
 mock.method(handler,'handle',async(...args:Parameters<typeof original>)=>{const result=await original(...args);
  if(args[0].method==='GET'&&args[0].query['list-type']!=='2'){gets++;started();await new Promise<void>(resolve=>{release=resolve;});}return result;});
 try{const writes=sdk.backend.writes,pending=sdk.reader().readHead(abort.signal);await entered;abort.abort();await assert.rejects(pending);release();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(gets,1);assert.equal(sdk.backend.writes,writes);assert.equal(sdk.backend.generates,0);
 }finally{await sdk.close();}
});

test('SDK epoch head pagination is complete and repeated tokens or listing drift cannot yield a head',async()=>{
 for(const mode of ['complete','repeated-token','drift','more-than-max']){
  const sdk=await sdkEpochFixture(),genesis=sdk.backend.objects.get(sdk.prefix+'heads/00000.json')!;
  // Synthetic historical slots only; this is list geometry, not original ACK proof.
  for(let n=1;n<=1000;n++){
   const body=Buffer.from(JSON.stringify(epochSchemas.head.parse({format:1,kind:'MANAGED_RECOVERY_EPOCH_HEAD_V1',installationId:sdk.storage.installationId,sequence:n,
    entryPin:{kind:'BASELINE',versionId:'historical-entry-'+n,sha256:hash('entry-'+n),byteLength:1},publicationId:randomUUID()})));
   sdk.backend.objects.set(sdk.prefix+'heads/'+String(n).padStart(5,'0')+'.json',{...genesis,body,version:'historical-head-'+n,checksum:Buffer.from(hash(body.toString()),'hex').toString('base64')});
  }
  const handler=await sdk.client.config.requestHandler,original=handler.handle.bind(handler);let listings=0;
  mock.method(handler,'handle',async(...args:Parameters<typeof original>)=>{
   if(args[0].query['list-type']==='2'&&++listings===3&&mode==='drift')sdk.backend.objects.delete(sdk.prefix+'heads/01000.json');
   const result=await original(...args);
   if(mode==='more-than-max'&&args[0].query['list-type']==='2'){
    const rows=[...sdk.backend.objects].filter(([key])=>key.startsWith(sdk.prefix+'heads/')).sort(([a],[b])=>a<b?-1:1);
    const xml='<ListBucketResult><Name>'+sdk.storage.bucket+'</Name><Prefix>'+sdk.prefix+'heads/</Prefix><MaxKeys>1000</MaxKeys><KeyCount>'+rows.length+'</KeyCount><IsTruncated>false</IsTruncated>'+rows.map(([key,row])=>'<Contents><Key>'+key+'</Key><Size>'+row.body.length+'</Size><ETag>"'+row.version+'"</ETag></Contents>').join('')+'</ListBucketResult>';
    result.response.body?.destroy();result.response.body=Readable.from([Buffer.from(xml)]);
   }
   if(mode==='repeated-token'&&args[0].query['continuation-token']){
    const chunks:Buffer[]=[];for await(const chunk of result.response.body)chunks.push(Buffer.from(chunk));
    const xml=Buffer.concat(chunks).toString().replace('<IsTruncated>false</IsTruncated>','<IsTruncated>true</IsTruncated>').replace('</ListBucketResult>','<NextContinuationToken>1000</NextContinuationToken></ListBucketResult>');
    result.response.body=Readable.from([Buffer.from(xml)]);
   }return result;
  });
  try{const writes=sdk.backend.writes;
   if(mode==='complete'){const observed=await sdk.reader().readHead(new AbortController().signal);assert.equal(JSON.parse(observed.artifact.body).sequence,1000);assert.equal(listings,4);}
   else await assert.rejects(sdk.reader().readHead(new AbortController().signal));
   assert.equal(sdk.backend.writes,writes);assert.equal(sdk.backend.generates,0);
  }finally{await sdk.close();}
 }
});

test('concurrent signed SDK epoch publishers have one original winner and no overwritten slots',async()=>{
 const sdk=await sdkEpochFixture(),x=await closedEpochFixture();
 try{const revision=(await sdk.catalogue().observe()).head.revision;
  const results=await Promise.allSettled([sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,revision),sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,revision)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(sdk.backend.objects.size,3);assert.equal((await sdk.catalogue().observe()).entryCount,1);assert.equal(sdk.backend.generates,0);
 }finally{await sdk.close();}
});

test('SDK epoch entry cancellation after provider acceptance cannot publish a head after late ACK',async()=>{
 const sdk=await sdkEpochFixture(),x=await closedEpochFixture(),handler=await sdk.client.config.requestHandler,original=handler.handle.bind(handler),abort=new AbortController();
 let release!:()=>void,started!:()=>void;const accepted=new Promise<void>(resolve=>{started=resolve;});
 mock.method(handler,'handle',async(...args:Parameters<typeof original>)=>{const result=await original(...args);
  if(args[0].method==='PUT'&&args[0].path.endsWith('/entries/00001.json')){started();await new Promise<void>(resolve=>{release=resolve;});}return result;});
 try{const revision=(await sdk.catalogue().observe()).head.revision,pending=sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,revision,abort.signal);
  await accepted;abort.abort();await assert.rejects(pending);release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sdk.backend.objects.size,2);assert.equal(sdk.backend.objects.has(sdk.prefix+'heads/00001.json'),false);assert.equal((await sdk.catalogue().observe()).latest,null);
 }finally{await sdk.close();}
});

test('SDK epoch exact readback ACK loss never recovers original publication permission',async()=>{
 for(const kind of ['entries','heads']){
  const sdk=await sdkEpochFixture(),x=await closedEpochFixture(),handler=await sdk.client.config.requestHandler,original=handler.handle.bind(handler);let lost=false;
  mock.method(handler,'handle',async(...args:Parameters<typeof original>)=>{const result=await original(...args);
   if(!lost&&args[0].method==='GET'&&args[0].query.versionId&&args[0].path.endsWith('/'+kind+'/00001.json')){lost=true;result.response.body?.destroy();throw new Error('PRIVATE exact readback ACK lost');}return result;});
  try{const revision=(await sdk.catalogue().observe()).head.revision;
   await assert.rejects(sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,revision));assert.equal(lost,true);
   const cold=await sdk.catalogue().observe();assert.equal(cold.entryCount,kind==='heads'?1:0);assert.equal(cold.originalAcknowledgementReconstructed,false);
   await assert.rejects(sdk.publisher().publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,cold.head.revision));
   assert.equal(sdk.backend.objects.size,kind==='heads'?3:2);assert.equal(sdk.backend.generates,0);
  }finally{await sdk.close();}
 }
});

test('SDK epoch configuration refuses unsupported bucket families and missing genesis never becomes an empty initialisation',async()=>{
 const sdk=await sdkEpochFixture();
 try{
  const reads=sdk.backend.reads,writes=sdk.backend.writes;
  for(const bucket of ['synthetic--zone--x-s3','synthetic--ol-s3','synthetic-s3alias','synthetic--table-s3'])assert.throws(()=>new S3ManagedRecoveryEpochReader({...sdk.storage,bucket},credentials,sdk.client));
  assert.throws(()=>new S3ManagedRecoveryEpochReader({...sdk.storage,kmsKeyArn:sdk.storage.kmsKeyArn.replace(/key\/.+$/,'key/'+'-'.repeat(36))},credentials,sdk.client));
  assert.throws(()=>new S3ManagedRecoveryEpochReader({...sdk.storage,endpoint:'https://untrusted.invalid'},credentials,sdk.client));
  assert.equal(sdk.backend.reads,reads);assert.equal(sdk.backend.writes,writes);
  sdk.backend.objects.delete(sdk.prefix+'heads/00000.json');await assert.rejects(sdk.reader().readHead(new AbortController().signal));
  assert.equal(sdk.backend.objects.size,0);assert.equal(sdk.backend.writes,writes);
 }finally{await sdk.close();}
});

test('SDK epoch head publication copies its validated bytes before awaited reads',async()=>{
 const sdk=await sdkEpochFixture(),x=await closedEpochFixture(),original=sdk.writer();let originalBody='';
 const writer:ManagedRecoveryEpochWriter={configurationDigest:()=>original.configurationDigest(),createEntry:(...args)=>original.createEntry(...args),
  replaceHead:async(revision,artifact,signal)=>{
   originalBody=artifact.body;const pending=original.replaceHead(revision,artifact,signal);
   artifact.body=JSON.stringify({...JSON.parse(artifact.body),publicationId:randomUUID()});artifact.sha256=hash(artifact.body);return pending;
  }};
 try{const publisher=new ManagedRecoveryEpochPublisher(sdk.catalogue(),sdk.reader(),writer);
  await assert.rejects(publisher.publishClosedEpoch(x.f.store,x.journal,x.archiveDigest,(await sdk.catalogue().observe()).head.revision));
  assert.ok(originalBody);assert.equal(sdk.backend.objects.get(sdk.prefix+'heads/00001.json')!.body.toString(),originalBody);
  assert.equal((await sdk.freshCatalogue().observe()).originalAcknowledgementReconstructed,false);
 }finally{await sdk.close();}
});
