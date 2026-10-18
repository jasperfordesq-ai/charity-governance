import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,generateKeyPairSync} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {ManagedReadRoleCapture} from '../services/managed-read-role-capture.js';
import {ManagedStorageDatabaseInventory} from '../services/managed-storage-database-inventory.js';
import {ManagedStorageMetadataWindow} from '../services/managed-storage-metadata-window.js';
import {SupabaseRecoveryCapture} from '../services/supabase-recovery-capture.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(){
 let queries=0;const never={$transaction:async()=>{queries++;throw new Error('private-db-credential');}};
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),subject='11111111-1111-4111-8111-111111111111',projectRef='abcdefghijklmnopqrst',now=Math.floor(Date.now()/1000);
 const sqlRole={name:'capture_reader',oid:'17000'},observer={name:'maintenance',oid:'10'},database={name:'synthetic_db',oid:'16000'};
 const storageRelations={buckets:{schema:'storage' as const,name:'buckets' as const,oid:'17001'},objects:{schema:'storage' as const,name:'objects' as const,oid:'17002'}},relations=Object.values(storageRelations);
 const token=jwt.sign({iss:`https://${projectRef}.supabase.co/auth/v1`,aud:'authenticated',sub:subject,role:sqlRole.name,iat:now,exp:now+300},pair.privateKey,{algorithm:'ES256',header:{alg:'ES256',typ:'JWT',kid:'synthetic'}});
 const capture=new SupabaseRecoveryCapture({installationId:'synthetic',projectRef,bucket:'documents',credential:{id:subject,sha256:hash(token)},authentication:{kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',sqlRole,subject,verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic',use:'sig'}}},token,async()=>{throw new Error('must not use HTTP');});
 const catalogue=new ManagedStorageDatabaseInventory(never as never,{database:database.name,databaseOid:database.oid,observer,capture:sqlRole,relations});
 const metadata=new ManagedStorageMetadataWindow(never as never,{database:database.name,databaseOid:database.oid,observer,relations,maxWindowMs:1000});
 const config={kind:'MANAGED_READ_ROLE_CAPTURE_CONFIGURATION_V1',installationId:'synthetic',sourceSha:'a'.repeat(40),maintenanceEpoch:1,projectRef,bucket:'documents',subject,sqlRole,database,catalogueObserver:observer,snapshotObserver:observer,storageRelations,maxWindowMs:1000,
  captureConfigurationDigest:capture.configurationDigest(),catalogueConfigurationDigest:catalogue.configurationDigest(),metadataWindowConfigurationDigest:metadata.configurationDigest()};
 return{config,token,capture,catalogue,metadata,queries:()=>queries,service:(raw:unknown=config)=>new ManagedReadRoleCapture(raw,capture,catalogue,metadata)};
}

test('read-role registry binds actual crypto/capture, SQL identity and both metadata relations without exposing credentials',()=>{
 const f=fixture(),service=f.service(),digest=service.configurationDigest();assert.equal(f.queries(),0);
 service.assertMaintenanceScope({installationId:'synthetic',sourceSha:'a'.repeat(40),maintenanceEpoch:1});
 service.assertStorageScope({installationId:'synthetic',projectRef:f.config.projectRef,bucket:'documents',captureKeyId:f.config.subject});
 f.config.storageRelations.objects.oid='99999';assert.equal(service.configurationDigest(),digest);
 assert.equal(JSON.stringify(service).includes(f.token),false);assert.equal(JSON.stringify(service).includes('private-db-credential'),false);
});

test('read-role registry refuses mismatched token/project/bucket/role/database/observers/relations/digests and extra authority before I/O',()=>{
 for(const change of [{projectRef:'z'.repeat(20)},{bucket:'other'},{subject:'22222222-2222-4222-8222-222222222222'},
  {sqlRole:{name:'capture_reader',oid:'17003'}},{database:{name:'other_db',oid:'16000'}},
  {catalogueObserver:{name:'other',oid:'10'}},{snapshotObserver:{name:'other',oid:'10'}},
  {captureConfigurationDigest:'0'.repeat(64)},{catalogueConfigurationDigest:'0'.repeat(64)},{metadataWindowConfigurationDigest:'0'.repeat(64)},
  {maxWindowMs:1001},{maxWindowMs:30001},{actionAuthorized:true}]){
  const f=fixture();assert.throws(()=>f.service({...f.config,...change}),/read-role capture is unresolved/);assert.equal(f.queries(),0);
 }
 const f=fixture();assert.throws(()=>f.service({...f.config,storageRelations:{...f.config.storageRelations,objects:{schema:'public',name:'objects',oid:'17002'}}}));
 assert.throws(()=>f.service({...f.config,storageRelations:{...f.config.storageRelations,objects:{...f.config.storageRelations.objects,oid:'17001'}}}));
 const service=f.service();for(const change of [{installationId:'other'},{sourceSha:'b'.repeat(40)},{maintenanceEpoch:2}])assert.throws(()=>service.assertMaintenanceScope({installationId:'synthetic',sourceSha:'a'.repeat(40),maintenanceEpoch:1,...change}));
 assert.throws(()=>service.assertStorageScope({installationId:'synthetic',projectRef:f.config.projectRef,bucket:'other',captureKeyId:f.config.subject}));
});

test('expired token leaves the declarative plan digest stable but refuses work before SQL or source execution',async(t)=>{
 const f=fixture(),service=f.service(),digest=service.configurationDigest();
 // The configured digest remains inspectable after execution authority expires.
 const future=new Date().getTime()+601000;t.mock.method(Date,'now',()=>future);
 service.assertMaintenanceScope({installationId:'synthetic',sourceSha:'a'.repeat(40),maintenanceEpoch:1});assert.equal(service.configurationDigest(),digest);
 let sources=0;await assert.rejects(service.runWithSnapshot(async()=>{sources++;throw new Error();}));assert.equal(sources,0);assert.equal(f.queries(),0);
});

test('already-cancelled callers refuse before SQL/source and private SQL errors are sanitised',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(f.service().runWithSnapshot(async()=>{calls++;throw new Error();},controller.signal));assert.equal(f.queries(),0);
 await assert.rejects(f.service().runWithSnapshot(async()=>{calls++;throw new Error();}),e=>{assert.ok(e instanceof Error);assert.equal(e.message,'Managed read-role capture is unresolved; discard the candidate without retry or admission');assert.equal(e.cause,undefined);return true;});
 assert.equal(calls,0);assert.equal(f.queries(),1);
});
