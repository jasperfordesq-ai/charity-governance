import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {Prisma,PrismaClient} from '@prisma/client';
import {ManagedReadRoleCapture} from '../apps/api/dist/services/managed-read-role-capture.js';
import {SupabaseRecoveryCapture} from '../apps/api/dist/services/supabase-recovery-capture.js';
import {ManagedStorageDatabaseInventory} from '../apps/api/dist/services/managed-storage-database-inventory.js';
import {ManagedStorageMetadataWindow} from '../apps/api/dist/services/managed-storage-metadata-window.js';

/** Exact original disposable TLS fixture only; HTTP is an explicit SQL-backed
 * provider model. No hosted token/project/key/release assertion is made. */
export async function proveReadRoleCapture({admin,fencer,actor,config,readerRole,url}){
 assert.match(config.database,/^managed_writer_[a-f0-9]{32}$/);assert.equal(new URL(url).pathname,'/'+config.database);
 await admin.$executeRaw`CREATE SCHEMA storage`;
 await admin.$executeRaw`CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean NOT NULL)`;
 await admin.$executeRaw`CREATE TABLE storage.objects(id uuid PRIMARY KEY,name text UNIQUE NOT NULL,bucket_id text NOT NULL,data text NOT NULL)`;
 await admin.$executeRaw`ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY`;
 await admin.$executeRaw`ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY`;
 await admin.$executeRaw`GRANT USAGE ON SCHEMA storage TO storage_probe_reader`;
 await admin.$executeRaw`GRANT SELECT ON storage.buckets,storage.objects TO storage_probe_reader`;
 await admin.$executeRaw`CREATE POLICY synthetic_read ON storage.buckets FOR SELECT TO storage_probe_reader USING(true)`;
 await admin.$executeRaw`CREATE POLICY synthetic_read ON storage.objects FOR SELECT TO storage_probe_reader USING(true)`;
 const objectId=randomUUID(),projectRef='abcdefghijklmnopqrst',subject=randomUUID();
 await admin.$executeRaw`INSERT INTO storage.buckets VALUES ('synthetic-read-bucket',false)`;
 await admin.$executeRaw`INSERT INTO storage.objects VALUES (${objectId}::uuid,'synthetic.txt','synthetic-read-bucket','synthetic-read-role-bytes')`;
 const relations=await admin.$queryRaw`SELECT n.nspname::text AS schema,c.relname::text AS name,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='storage' AND c.relname IN ('buckets','objects') ORDER BY c.oid`;
 assert.equal(relations.length,2);
 const catalogue=new ManagedStorageDatabaseInventory(fencer,{...config,capture:readerRole,relations});
 const metadata=new ManagedStorageMetadataWindow(actor,{database:config.database,databaseOid:config.databaseOid,observer:config.observer,relations,maxWindowMs:5000});
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),hash=v=>createHash('sha256').update(v).digest('hex');let reads=0;
 const profile=(lifetime=300)=>{
  const now=Math.floor(Date.now()/1000),authentication={kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',sqlRole:readerRole,subject,
   verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic-composed',use:'sig'}};
  const token=jwt.sign({iss:`https://${projectRef}.supabase.co/auth/v1`,aud:'authenticated',sub:subject,role:readerRole.name,iat:now,exp:now+lifetime},pair.privateKey,{algorithm:'ES256',header:{alg:'ES256',typ:'JWT',kid:'synthetic-composed'}});
  const capture=new SupabaseRecoveryCapture({installationId:'synthetic-composed',projectRef,bucket:'synthetic-read-bucket',credential:{id:subject,sha256:hash(token)},authentication},token,async(input,init)=>{
   reads++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+token);const path=new URL(String(input)).pathname;
   const claims=jwt.verify(token,pair.publicKey,{algorithms:['ES256'],issuer:`https://${projectRef}.supabase.co/auth/v1`,audience:'authenticated'});assert.equal(claims.role,readerRole.name);
   return admin.$transaction(async tx=>{
    await tx.$queryRaw`SELECT set_config('role','storage_probe_reader',true)`;
    if(path.includes('/bucket/')){const rows=await tx.$queryRaw`SELECT id,public FROM storage.buckets`;assert.equal(rows.length,1);return Response.json(rows[0]);}
    const rows=await tx.$queryRaw`SELECT id,name,data FROM storage.objects ORDER BY name`;assert.equal(rows.length,1);
    if(path.includes('/object/list/'))return Response.json(rows.map(r=>({id:r.id,name:r.name,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',metadata:{size:Buffer.byteLength(r.data),mimetype:'text/plain'}})));
    return new Response(rows[0].data,{headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(rows[0].data))}});
   });
  });
  const raw={kind:'MANAGED_READ_ROLE_CAPTURE_CONFIGURATION_V1',installationId:'synthetic-composed',sourceSha:'a'.repeat(40),maintenanceEpoch:1,projectRef,bucket:'synthetic-read-bucket',subject,sqlRole:readerRole,
   database:{name:config.database,oid:config.databaseOid},catalogueObserver:config.observer,snapshotObserver:config.observer,
   storageRelations:{buckets:relations.find(r=>r.name==='buckets'),objects:relations.find(r=>r.name==='objects')},
   captureConfigurationDigest:capture.configurationDigest(),catalogueConfigurationDigest:catalogue.configurationDigest(),metadataWindowConfigurationDigest:metadata.configurationDigest(),maxWindowMs:5000};
  return{service:new ManagedReadRoleCapture(raw,capture,catalogue,metadata),token};
 };
 const outsider=new PrismaClient({datasources:{db:{url}}});let pending;
 try{
  const initial=profile(),result=await initial.service.runWithSnapshot(async(snapshot,signal)=>{
   assert.equal(signal.aborted,false);assert.equal(snapshot.databaseOid,config.databaseOid);assert.match(snapshot.snapshotId,/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]+$/);
   const imported=await admin.$transaction(async tx=>{
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION SNAPSHOT ${Prisma.raw("'"+snapshot.snapshotId+"'")}`);
    return tx.$queryRaw`SELECT count(*)::integer AS total FROM storage.objects`;
   },{isolationLevel:'RepeatableRead'});assert.equal(imported[0].total,1);
   let pid,started;const ready=new Promise(r=>{started=r;});
   pending=outsider.$transaction(async tx=>{pid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;started();await tx.$executeRaw`INSERT INTO storage.objects VALUES (${randomUUID()}::uuid,'later.txt','synthetic-read-bucket','later')`;});void pending.catch(()=>{});
   await ready;let waiting=false;for(let i=0;i<100;i++){
    waiting=(await admin.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='storage.objects'::regclass AND NOT granted AND mode='RowExclusiveLock') AS waiting`)[0].waiting;
    if(waiting)break;await new Promise(r=>setTimeout(r,10));
   }assert.equal(waiting,true);
   return{visit:async(_file,bytes)=>assert.equal(bytes.toString(),'synthetic-read-role-bytes'),value:{importedCount:imported[0].total}};
  });
  assert.equal(result.kind,'MANAGED_READ_ROLE_CAPTURE_INTERVAL_V1');assert.equal(result.sourceValue.importedCount,1);assert.equal(result.captured.objects.length,1);
  assert.equal(result.snapshotInterval.metadataWindow.relations.length,2);assert.equal(result.sqlPrivilegeWindow.listedCatalogueChangesExcludedDuringCallback,true);
  for(const key of ['providerTokenRoleVerified','providerProjectDatabaseVerified','unfilteredBucketVisibilityVerified','retainedPrivilegedCredentialsExcluded','wholeBackendQuiesced','actionAuthorized'])assert.equal(result[key],false);
  assert.equal(JSON.stringify(result).includes(initial.token),false);assert.equal(JSON.stringify(initial.service).includes(initial.token),false);
  await pending;assert.equal((await admin.$queryRaw`SELECT count(*)::integer AS total FROM storage.objects`)[0].total,2);
  await admin.$executeRaw`DELETE FROM storage.objects WHERE name='later.txt'`;
  const expiring=profile(2),before=reads;let expiredSignal;
  await assert.rejects(expiring.service.runWithSnapshot(async(_snapshot,signal)=>{expiredSignal=signal;await new Promise(()=>{});}));
  assert.equal(expiredSignal?.aborted,true);assert.equal(reads,before);
  assert.equal((await admin.$queryRaw`SELECT count(*)::integer AS total FROM pg_locks WHERE mode='ShareLock' AND granted AND relation IN ('storage.objects'::regclass,'storage.buckets'::regclass,'pg_catalog.pg_authid'::regclass)`)[0].total,0);
  console.log('PASS native configured read-role composition: exact role/project/SQL/snapshot registry, two metadata tables SHARE-locked, real snapshot import, blocked DML until completion, authenticated SQL-backed capture; short JWT cancels source before HTTP and releases both windows; provider identity and global authority remain unproven');
 }finally{if(pending)await pending.catch(()=>{});await outsider.$disconnect();}
}
