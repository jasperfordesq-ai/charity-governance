import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {S3ManagedMaintenanceControl} from '../services/managed-maintenance-control.js';
import {ManagedBackendMaintenance} from '../services/managed-backend-maintenance.js';

const config={installationId:'synthetic-installation',bucket:'synthetic-maintenance',accountId:'123456789012',
 kmsKeyArn:'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111'};
const credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'};
const operation={installationId:config.installationId,sourceSha:'1'.repeat(40),maintenanceEpoch:1};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(){
 let value={format:1,installationId:config.installationId,maintenanceEpoch:1,planDigest:'1'.repeat(64),
  phase:'READY',attemptId:null as string|null,observations:null as unknown,publicationId:randomUUID()};
 let version=1,reads=0,puts=0;
 const calls:string[]=[];
 let fault:((command:GetObjectCommand|PutObjectCommand)=>unknown)|undefined;
 const metadata=()=>({VersionId:'version-'+version,ETag:'"etag-'+version+'"',ServerSideEncryption:'aws:kms' as const,SSEKMSKeyId:config.kmsKeyArn});
 const client=new S3Client({region:'eu-west-1',credentials});
 mock.method(client,'send',async(command:GetObjectCommand|PutObjectCommand)=>{
  const path=command.input;assert.equal(path.Bucket,config.bucket);assert.equal(path.ExpectedBucketOwner,config.accountId);
  assert.equal(path.Key,`managed-maintenance/${config.installationId}/control.json`);
  const injected=fault?.(command);if(injected!==undefined)return injected;
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
  observeClosed:async()=>{calls.push('database-observe');return{observationDigest:hash('database')};}};
 const coordinator=new ManagedBackendMaintenance(operation,provider as never,database as never,store);
 value.planDigest=coordinator.planDigest();
 return{store,provider,database,coordinator,calls,metadata,get value(){return value;},set value(next){value=next;},
  get puts(){return puts;},get reads(){return reads;},setFault:(next:typeof fault)=>{fault=next;},
  commit:(command:PutObjectCommand)=>{value=JSON.parse(String(command.input.Body));version++;return metadata();}};
}

test('managed shutdown records an independent attempt before provider/database mutation and never repeats it',async()=>{
 const f=fixture();const result=await f.coordinator.close();
 assert.equal(result.phase,'OBSERVED_CLOSED');assert.equal(f.puts,2);
 assert.ok(f.calls.indexOf('put')<f.calls.indexOf('suspend'));
 assert.ok(f.calls.indexOf('suspend')<f.calls.indexOf('database-close'));
 assert.ok(f.calls.indexOf('database-close')<f.calls.indexOf('services-observe'));
 assert.ok(f.calls.indexOf('database-observe')<f.calls.lastIndexOf('put'));
 for(const flag of ['wholeBackendQuiesced','credentialRotationVerified','currentTenantAuthorityVerified','sourceHostFenced','reopeningAuthorised','actionAuthorized'])assert.equal(result[flag as keyof typeof result],false);
 const mutations=f.calls.filter(s=>['put','suspend','database-close'].includes(s)).length;
 const inspection=await f.coordinator.inspect();assert.equal(inspection.phase,'OBSERVED_CLOSED');
 await assert.rejects(f.coordinator.close());
 assert.equal(f.calls.filter(s=>['put','suspend','database-close'].includes(s)).length,mutations);
});

test('lost independent acquisition acknowledgement never dispatches, even after a new coordinator reads the committed attempt',async()=>{
 const f=fixture();f.setFault(command=>{
  if(command instanceof PutObjectCommand){f.commit(command);throw new Error('PRIVATE lost S3 ack');}
 });
 await assert.rejects(f.coordinator.close());assert.equal(f.value.phase,'ATTEMPTED');
 f.setFault(undefined);
 const fresh=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store);
 await assert.rejects(fresh.close());assert.equal(f.calls.includes('suspend'),false);assert.equal(f.calls.includes('database-close'),false);
 const observed=await fresh.inspect();assert.equal(observed.phase,'ATTEMPTED');assert.equal(observed.recordedObservations,null);
});

test('provider/database/recording failures retain attempt and forbid repeat or automatic compensation',async()=>{
 for(const stage of ['suspend','database-close','services-observe','database-observe','record'] as const){
  const f=fixture();
  const fail=async()=>{throw new Error('PRIVATE uncertain external mutation');};
  if(stage==='suspend')f.provider.suspend=fail;
  if(stage==='database-close')f.database.close=fail;
  if(stage==='services-observe')f.provider.observeSuspended=fail;
  if(stage==='database-observe')f.database.observeClosed=fail;
  if(stage==='record')f.setFault(command=>{
   if(command instanceof PutObjectCommand&&JSON.parse(String(command.input.Body)).phase==='OBSERVED_CLOSED'){
    f.commit(command);throw new Error('lost final commit');
   }
  });
  await assert.rejects(f.coordinator.close(),error=>error instanceof Error&&!error.message.includes('PRIVATE')&&error.cause===undefined);
  assert.equal(f.value.phase,stage==='record'?'OBSERVED_CLOSED':'ATTEMPTED');
  f.setFault(undefined);const mutations=f.calls.filter(s=>['put','suspend','database-close'].includes(s)).length;
  await assert.rejects(f.coordinator.close());assert.equal(f.calls.filter(s=>['put','suspend','database-close'].includes(s)).length,mutations);
  if(stage==='suspend')assert.equal(f.calls.includes('database-close'),false);
 }
});

test('maintenance plan binds copied installation/source/epoch and both component registries',async()=>{
 for(const stage of ['installation','source','epoch','provider','database'] as const){
  const f=fixture(),changed={...operation};
  if(stage==='installation')changed.installationId='different-installation';
  if(stage==='source')changed.sourceSha='2'.repeat(40);
  if(stage==='epoch')changed.maintenanceEpoch=2;
  if(stage==='provider')f.provider.configurationDigest=()=>hash('different-provider');
  if(stage==='database')f.database.configurationDigest=()=>hash('different-database');
  await assert.rejects(new ManagedBackendMaintenance(changed,f.provider as never,f.database as never,f.store).close());
  assert.equal(f.puts,0);assert.equal(f.calls.includes('suspend'),false);
 }
 const f=fixture(),input={...operation},coordinator=new ManagedBackendMaintenance(input,f.provider as never,f.database as never,f.store);
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
 f.database.observeClosed=async()=>{f.value={...f.value,publicationId:randomUUID()};return{observationDigest:hash('db')};};
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
 const f=fixture(),other=new ManagedBackendMaintenance(operation,f.provider as never,f.database as never,f.store);
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
