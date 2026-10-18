import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {PrismaClient} from '@prisma/client';
import {ManagedReadRoleCapture} from '../apps/api/dist/services/managed-read-role-capture.js';
import {SupabaseRecoveryCapture} from '../apps/api/dist/services/supabase-recovery-capture.js';
import {ManagedStorageDatabaseInventory} from '../apps/api/dist/services/managed-storage-database-inventory.js';
import {ManagedStorageMetadataWindow} from '../apps/api/dist/services/managed-storage-metadata-window.js';
import {SupabaseRetiredControlReadProof} from '../apps/api/dist/services/supabase-retired-control-read-proof.js';

/** Original disposable TLS fixture only. No hosted issuer/role/policy grant. */
export async function createReadRoleSnapshotFixture({admin,url,operation,scope,retiredControl}){
 assert.match(new URL(url).pathname,/^\/managed_writer_[a-f0-9]{32}$/);
 await admin.$executeRaw`CREATE ROLE managed_capture_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
 await admin.$executeRaw`CREATE SCHEMA storage`;
 await admin.$executeRaw`CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean NOT NULL)`;
 await admin.$executeRaw`CREATE TABLE storage.objects(id uuid PRIMARY KEY,name text UNIQUE NOT NULL,data text NOT NULL)`;
 await admin.$executeRaw`ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY`;
 await admin.$executeRaw`ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY`;
 await admin.$executeRaw`GRANT USAGE ON SCHEMA storage TO managed_capture_reader`;
 await admin.$executeRaw`GRANT SELECT ON storage.buckets,storage.objects TO managed_capture_reader`;
 // The synthetic PUBLIC read policy does not grant SELECT. Only the reader
 // receives table grants; it avoids inventing a restored cluster role during
 // the original disposable dump/restore proof. Real provider policy is separate.
 await admin.$executeRaw`CREATE POLICY synthetic_read ON storage.buckets FOR SELECT USING(true)`;
 await admin.$executeRaw`CREATE POLICY synthetic_read ON storage.objects FOR SELECT USING(true)`;
 await admin.$executeRaw`INSERT INTO storage.buckets VALUES (${scope.bucket},false)`;
 await admin.$executeRaw`INSERT INTO storage.objects VALUES (${randomUUID()}::uuid,'record.txt','synthetic snapshot file')`;
 const[database]=await admin.$queryRaw`SELECT current_database()::text AS name,oid::text AS oid FROM pg_database WHERE datname=current_database()`;
 const principals=await admin.$queryRaw`SELECT rolname AS name,oid::text AS oid FROM pg_roles WHERE rolname IN ('postgres','managed_capture_reader')`;
 const observer=principals.find(p=>p.name==='postgres'),sqlRole=principals.find(p=>p.name==='managed_capture_reader');
 const relations=await admin.$queryRaw`SELECT n.nspname::text AS schema,c.relname::text AS name,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='storage' AND c.relname IN ('buckets','objects') ORDER BY c.oid`;
 const catalogueClient=new PrismaClient({datasources:{db:{url}}}),metadataClient=new PrismaClient({datasources:{db:{url}}});
 const catalogue=new ManagedStorageDatabaseInventory(catalogueClient,{database:database.name,databaseOid:database.oid,observer,capture:sqlRole,relations});
 const metadata=new ManagedStorageMetadataWindow(metadataClient,{database:database.name,databaseOid:database.oid,observer,relations,maxWindowMs:30000});
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),subject=randomUUID(),now=Math.floor(Date.now()/1000);
 const token=jwt.sign({iss:`https://${scope.projectRef}.supabase.co/auth/v1`,aud:'authenticated',sub:subject,role:sqlRole.name,iat:now,exp:now+600},pair.privateKey,{algorithm:'ES256',header:{alg:'ES256',typ:'JWT',kid:'synthetic-common-reader'}});
 const capture=new SupabaseRecoveryCapture({installationId:operation.installationId,projectRef:scope.projectRef,bucket:scope.bucket,credential:{id:subject,sha256:createHash('sha256').update(token).digest('hex')},
  authentication:{kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',subject,sqlRole,verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic-common-reader',use:'sig'}}},token,async(input,init)=>{
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+token);assert.equal(new Headers(init.headers).get('apikey'),null);
  jwt.verify(token,pair.publicKey,{algorithms:['ES256'],issuer:`https://${scope.projectRef}.supabase.co/auth/v1`,audience:'authenticated'});
  const path=new URL(String(input)).pathname;
  return admin.$transaction(async tx=>{
   await tx.$queryRaw`SELECT set_config('role','managed_capture_reader',true)`;
   if(path.includes('/bucket/')){const rows=await tx.$queryRaw`SELECT id,public FROM storage.buckets`;assert.equal(rows.length,1);return Response.json(rows[0]);}
   const rows=await tx.$queryRaw`SELECT id,name,data FROM storage.objects`;assert.equal(rows.length,1);
   if(path.includes('/object/list/'))return Response.json(rows.map(r=>({name:r.name,id:r.id,created_at:'2026-10-17T00:00:00.000Z',updated_at:'2026-10-17T00:00:00.000Z',metadata:{size:Buffer.byteLength(r.data),mimetype:'text/plain'}})));
   return new Response(rows[0].data,{headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(rows[0].data))}});
  });
 });
 const profile=new ManagedReadRoleCapture({kind:'MANAGED_READ_ROLE_CAPTURE_CONFIGURATION_V1',...operation,projectRef:scope.projectRef,bucket:scope.bucket,subject,sqlRole,database,
  catalogueObserver:observer,snapshotObserver:observer,storageRelations:{buckets:relations.find(r=>r.name==='buckets'),objects:relations.find(r=>r.name==='objects')},
  captureConfigurationDigest:capture.configurationDigest(),catalogueConfigurationDigest:catalogue.configurationDigest(),metadataWindowConfigurationDigest:metadata.configurationDigest(),maxWindowMs:30000},capture,catalogue,metadata);
 let comparison;
 if(retiredControl){
  const bucket='charitypilot-recovery-canaries',fileUrl='charitypilot-recovery-canary/'+operation.installationId+'/native-retirement.txt',body='synthetic SQL-backed retirement canary';
  await admin.$executeRaw`CREATE TABLE storage.synthetic_canary(name text PRIMARY KEY,data text NOT NULL)`;
  await admin.$executeRaw`ALTER TABLE storage.synthetic_canary ENABLE ROW LEVEL SECURITY`;
  await admin.$executeRaw`CREATE POLICY synthetic_canary_read ON storage.synthetic_canary FOR SELECT USING(true)`;
  await admin.$executeRaw`GRANT SELECT ON storage.synthetic_canary TO managed_capture_reader`;
  await admin.$executeRaw`INSERT INTO storage.synthetic_canary VALUES (${fileUrl},${body})`;
  const digest=v=>createHash('sha256').update(v).digest('hex');
  const transport=async(input,init)=>{
   const target=new URL(String(input)),headers=new Headers(init.headers),legacy=headers.get('apikey');
   assert.equal(target.origin,`https://${scope.projectRef}.supabase.co`);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
   if(legacy){assert.equal(legacy,retiredControl.credential.secret);if(!retiredControl.isPresent()){retiredControl.events.push('retired-control-canary-refusal');return new Response(null,{status:401});}}
   else {assert.equal(headers.get('authorization'),'Bearer '+token);jwt.verify(token,pair.publicKey,{algorithms:['ES256'],issuer:`https://${scope.projectRef}.supabase.co/auth/v1`,audience:'authenticated'});}
   if(target.pathname===`/storage/v1/bucket/${bucket}`)return Response.json({id:bucket,public:false});
   assert.equal(target.pathname,`/storage/v1/object/${bucket}/${fileUrl}`);
   return admin.$transaction(async tx=>{
    if(!legacy)await tx.$queryRaw`SELECT set_config('role','managed_capture_reader',true)`;
    const rows=await tx.$queryRaw`SELECT data FROM storage.synthetic_canary WHERE name=${fileUrl}`;assert.equal(rows.length,1);
    retiredControl.events.push(legacy?'original-control-canary-positive':'jwt-sql-canary-positive');
    return new Response(rows[0].data,{headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(rows[0].data))}});
   });
  };
  const positive=new SupabaseRecoveryCapture({installationId:operation.installationId,projectRef:scope.projectRef,bucket,credential:{id:subject,sha256:digest(token)},
   authentication:{kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',subject,sqlRole,verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic-common-reader',use:'sig'}}},token,transport);
  const probe=new SupabaseRetiredControlReadProof({installationId:operation.installationId,projectRef:scope.projectRef,bucket,
   canary:{fileUrl,bytes:Buffer.byteLength(body),sha256:digest(body)},retiredControl:{id:retiredControl.credential.id,sha256:digest(retiredControl.credential.secret)},
   readRole:{configurationDigest:positive.configurationDigest(),subject,sqlRole}},retiredControl.credential.secret,positive,transport);
  comparison={descriptor:probe.configurationDescriptor(),probe};
 }
 return{profile,comparison,async close(){await catalogueClient.$disconnect();await metadataClient.$disconnect();await admin.$executeRaw`DROP SCHEMA storage CASCADE`;await admin.$executeRaw`DROP ROLE managed_capture_reader`;}};
}
