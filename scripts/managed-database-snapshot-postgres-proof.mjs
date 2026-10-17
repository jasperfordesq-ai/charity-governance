import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {ManagedStorageMetadataWindow} from '../apps/api/dist/services/managed-storage-metadata-window.js';
import {SupabaseRecoveryCapture} from '../apps/api/dist/services/supabase-recovery-capture.js';
import {prepareLocalDockerCommand} from './postgres-backup.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');

/** Synthetic fixture only: actual TLS snapshot import/dump/isolated restore plus
 * real capture class, synthetic file transport. Not a provider activation. */
export async function proveManagedDatabaseSnapshot({admin,url,id,database}){
 assert.match(id,/^[a-f0-9]{64}$/);assert.match(database,/^managed_writer_[a-f0-9]{32}$/);
 const holder=new PrismaClient({datasources:{db:{url}}}),destination='snapshot_'+randomUUID().replaceAll('-','');
 // Verify local engine once before entering the bounded transaction, then pin
 // every child to that exact endpoint. No shell, URL or password in command args.
 const prepared=prepareLocalDockerCommand(['docker','exec','-i','--env','PGPASSWORD','--env','PGSSLMODE=verify-full',
  '--env','PGSSLROOTCERT=/tmp/cert.pem','--env','PGOPTIONS=-c statement_timeout=10s -c lock_timeout=1s',id],process.env);
 const execute=(args,input=Buffer.alloc(0),signal)=>new Promise((resolve,reject)=>{
  const child=spawn(prepared.command[0],[...prepared.command.slice(1),...args],{env:{...prepared.environment,PGPASSWORD:'synthetic-maintenance-only'},
   stdio:['pipe','pipe','pipe'],...(signal?{signal}:{})});
  let bytes=0,errorBytes=0;const out=[],err=[];const timer=setTimeout(()=>child.kill(),15000);
  child.on('error',()=>{clearTimeout(timer);reject(new Error('Synthetic snapshot child unresolved'));});
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>16*1024*1024)child.kill();else out.push(b);});
  child.stderr.on('data',b=>{errorBytes+=b.length;if(errorBytes>16384)child.kill();else err.push(b);});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  child.on('close',code=>{clearTimeout(timer);if(signal?.aborted||bytes>16*1024*1024||errorBytes>16384)reject(new Error('Synthetic snapshot child unresolved'));
   else resolve({code,body:Buffer.concat(out),error:Buffer.concat(err).toString('utf8')});});
 });
 const successful=async(args,input,signal)=>{const r=await execute(args,input,signal);assert.equal(r.code,0,r.error);return r.body;};
 let dump,expired,created=false;
 try{
  await admin.$executeRaw`CREATE SCHEMA managed_snapshot_fixture`;
  await admin.$executeRaw`CREATE TABLE managed_snapshot_fixture.objects(id text PRIMARY KEY, body text NOT NULL)`;
  await admin.$executeRaw`CREATE TABLE managed_snapshot_fixture.app_records(id text PRIMARY KEY)`;
  await admin.$executeRaw`INSERT INTO managed_snapshot_fixture.objects VALUES ('record.txt','synthetic snapshot file')`;
  await admin.$executeRaw`INSERT INTO managed_snapshot_fixture.app_records VALUES ('before-export')`;
  const [db]=await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()`;
  const [observer]=await admin.$queryRaw`SELECT rolname AS name,oid::text AS oid FROM pg_roles WHERE rolname=current_user`;
  const [relation]=await admin.$queryRaw`SELECT t.oid::text AS oid FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='managed_snapshot_fixture' AND t.relname='objects'`;
  const service=new ManagedStorageMetadataWindow(holder,{database,databaseOid:db.oid,observer,
   relations:[{schema:'managed_snapshot_fixture',name:'objects',oid:relation.oid}],maxWindowMs:15000});
  const body=Buffer.from('synthetic snapshot file'),secret='sb_secret_'+'s'.repeat(40),fileId=randomUUID();
  const capture=new SupabaseRecoveryCapture({installationId:'synthetic-snapshot-proof',projectRef:'a'.repeat(20),bucket:'documents',
   credential:{id:randomUUID(),sha256:hash(secret)}},secret,async(raw,options)=>{
   const path=new URL(raw).pathname;
   if(path==='/storage/v1/bucket/documents')return Response.json({id:'documents',public:false});
   if(path==='/storage/v1/object/list/documents')return Response.json([{name:'record.txt',id:fileId,
    created_at:'2026-10-17T00:00:00.000Z',updated_at:'2026-10-17T00:00:00.000Z',metadata:{size:body.length,mimetype:'text/plain'}}]);
   assert.equal(options.method,'GET');assert.equal(path,'/storage/v1/object/documents/record.txt');
   return new Response(body,{headers:{'Content-Type':'text/plain','Content-Length':String(body.length)}});
  });
  const result=await service.runWithSnapshot(async(snapshot,signal)=>{
   expired=snapshot.snapshotId;
   // An unrelated MVCC row commits after export but before pg_dump starts.
   // The imported dump must omit it; a fresh unbound dump would include it.
   await admin.$executeRaw`INSERT INTO managed_snapshot_fixture.app_records VALUES ('after-export')`;
   dump=await successful(['pg_dump','-h','127.0.0.1','-U','postgres','-d',database,'--format=custom','--no-owner','--no-privileges',
    '--no-blobs','--schema=managed_snapshot_fixture','--strict-names','--snapshot='+snapshot.snapshotId],undefined,signal);
   assert.equal(dump.subarray(0,5).toString(),'PGDMP');
   const files=await capture.capture(async(file,bytes,digest)=>{
    assert.equal(file.fileUrl,'record.txt');assert.equal(digest,hash(body));assert.deepEqual(bytes,body);
    const [row]=await admin.$queryRaw`SELECT body FROM managed_snapshot_fixture.objects WHERE id='record.txt'`;
    assert.equal(row.body,bytes.toString());
   },signal);
   return{databaseSha256:hash(dump),databaseBytes:dump.length,files};
  });
  assert.equal(result.databaseSnapshot.exporterHeldDuringCallback,true);
  assert.equal(result.databaseSnapshot.importedByConsumerVerified,false); // Generic API cannot attest its caller.
  assert.equal(result.evidence.windowId,result.databaseSnapshot.windowId);
  assert.equal(result.value.files.objects.length,1);
  await successful(['createdb','-h','127.0.0.1','-U','postgres',destination]);created=true;
  await successful(['pg_restore','-h','127.0.0.1','-U','postgres','--dbname='+destination,'--no-owner','--no-privileges','--exit-on-error'],dump);
  const rows=await successful(['psql','-h','127.0.0.1','-U','postgres','-d',destination,'-At','-v','ON_ERROR_STOP=1','-c',
   'SELECT id FROM managed_snapshot_fixture.app_records ORDER BY id']);
  assert.equal(rows.toString().trim(),'before-export');
  const restored=await successful(['psql','-h','127.0.0.1','-U','postgres','-d',destination,'-At','-v','ON_ERROR_STOP=1','-c',
   'SELECT body FROM managed_snapshot_fixture.objects']);assert.equal(restored.toString().trim(),body.toString());
  const late=await execute(['pg_dump','-h','127.0.0.1','-U','postgres','-d',database,'--format=custom','--schema=managed_snapshot_fixture','--snapshot='+expired]);
  assert.notEqual(late.code,0);assert.match(late.error,/invalid snapshot identifier/i);late.body.fill(0);
  console.log('PASS native common capture interval: export after metadata locks; real TLS pg_dump imports snapshot before file capture; isolated restore omits later MVCC row and matches file metadata; expired import refused');
 }finally{
  dump?.fill(0);
  try{if(created)await successful(['dropdb','-h','127.0.0.1','-U','postgres',destination]);}
  finally{await holder.$disconnect();await admin.$executeRaw`DROP SCHEMA IF EXISTS managed_snapshot_fixture CASCADE`;}
 }
}
