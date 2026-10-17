import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {canonicalDocumentIdentitySha256,canonicalMetadataBindingSha256,canonicalObjectKeySha256,canonicalDocumentMetadataRowsSha256} from '../packages/shared/runtime/document-recovery-inventory.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {ManagedStorageMetadataWindow} from '../apps/api/dist/services/managed-storage-metadata-window.js';
import {SupabaseRecoveryCapture} from '../apps/api/dist/services/supabase-recovery-capture.js';
import {prepareSnapshotFingerprintCapture,parseDatabaseFingerprintReport,compareDatabaseFingerprints,sourceEndpointIdentitySha256,prepareLocalDockerCommand} from './postgres-backup.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');

/** Synthetic fixture only: actual TLS snapshot import/dump/isolated restore plus
 * real capture class, synthetic file transport. Not a provider activation. */
export async function proveManagedDatabaseSnapshot({admin,url,id,database,certificate}){
 assert.match(id,/^[a-f0-9]{64}$/);assert.match(database,/^managed_writer_[a-f0-9]{32}$/);
 const holder=new PrismaClient({datasources:{db:{url}}}),destination='snapshot_'+randomUUID().replaceAll('-','');
 const body=Buffer.from('synthetic snapshot file'),fileId=randomUUID();
 const document={id:fileId,organisationId:'synthetic_tenant',fileUrl:'record.txt',fileSize:body.length,mimeType:'text/plain'};
 const output=mkdtempSync(join(tmpdir(),'charitypilot-imported-proof-'));
 const verifyOutput=()=>{assert.equal(dirname(resolve(output)),resolve(tmpdir()));assert.ok(basename(output).startsWith('charitypilot-imported-proof-'));};verifyOutput();
 const prove=async(snapshot,identity,signal)=>{
  const source=new URL(captureUrl(database));source.searchParams.set('sslrootcert',certificate);
  const args=['prove-restore','--source-container-id='+id,'--recovery-set-id=synthetic-imported-'+randomUUID(),
   '--expected-source-database-identity-sha256='+identity,'--output-dir='+output,'--output-file=common.dump','--report-file=common.json'];
  const code=`import {runImportedSnapshotRestoreProof} from './scripts/postgres-backup.mjs';let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>8192)throw new Error('Oversized proof input');}const {args,snapshot}=JSON.parse(input);const r=await runImportedSnapshotRestoreProof(args,snapshot);process.stdout.write(JSON.stringify({status:r.status,error:r.status?r.stderr:undefined}));process.exitCode=r.status;`;
  await new Promise((done,fail)=>{
   const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,DATABASE_URL:source.href},stdio:['pipe','pipe','pipe'],signal});
   let text='',errors='';const timer=setTimeout(()=>child.kill(),90000);
   child.stdout.on('data',b=>{text+=b;if(text.length>65536)child.kill();});child.stderr.on('data',b=>{errors+=b;if(errors.length>65536)child.kill();});
   child.on('error',()=>{clearTimeout(timer);fail(new Error('Synthetic full proof process unresolved'));});child.stdin.on('error',()=>{});
   child.stdin.end(JSON.stringify({args,snapshot}));
   child.on('close',status=>{clearTimeout(timer);try{assert.equal(status,0,errors||text);assert.equal(JSON.parse(text).status,0);done();}catch(e){fail(e);}});
  });
  assert.ok(statSync(join(output,'common.json')).size<16*1024*1024);
  const report=JSON.parse(readFileSync(join(output,'common.json'),'utf8'));
  assert.equal(report.format,'charitypilot-postgres-restore-proof/v2');assert.equal(report.ok,true);
  assert.equal(report.helperImplementation.sourceMatchesCommit,true);assert.equal(report.sourceDatabaseIdentitySha256,identity);
  assert.equal(report.comparison.mismatchCount,0);assert.equal(report.restoreTarget.cleanupVerified,true);
  assert.equal(report.importedSnapshot.originalViewImported,true);assert.equal(report.importedSnapshot.metadataWindowCompletionVerified,false);
  assert.equal(report.importedSnapshot.snapshotBindingSha256,hash('CHARITYPILOT_MANAGED_EXPORTED_SNAPSHOT_V1\n'+JSON.stringify(snapshot)));
  assert.equal(report.source.tables.find(t=>t.table==='synthetic_snapshot_public').rowCount,'1');
  assert.equal(report.source.documentMetadata.rowCount,1);assert.equal(hash(readFileSync(join(output,'common.dump'))),report.dump.sha256);
  return{reportSha256:hash(readFileSync(join(output,'common.json'))),dumpSha256:report.dump.sha256,dumpBytes:Number(report.dump.bytes)};
 };
 // Verify local engine once before entering the bounded transaction, then pin
 // every child to that exact endpoint. No shell, URL or password in command args.
 const prepared=prepareLocalDockerCommand(['docker','exec','-i','--env','PGPASSWORD','--env','PGSSLMODE=verify-full',
  '--env','PGSSLROOTCERT=/tmp/cert.pem','--env','PGOPTIONS=-c statement_timeout=10s -c lock_timeout=1s',id],process.env);
 const execute=(args,input=Buffer.alloc(0),signal,extra={})=>new Promise((resolve,reject)=>{
  const names=Object.keys(extra);assert.ok(names.every(k=>/^CHARITYPILOT_[A-Z0-9_]+$/.test(k)&&typeof extra[k]==='string'));
  const child=spawn(prepared.command[0],[...prepared.command.slice(1,-1),...names.flatMap(k=>['--env',k]),id,...args],{env:{...prepared.environment,...extra,PGPASSWORD:'synthetic-maintenance-only'},
   stdio:['pipe','pipe','pipe'],...(signal?{signal}:{})});
  let bytes=0,errorBytes=0;const out=[],err=[];const timer=setTimeout(()=>child.kill(),60000);
  child.on('error',()=>{clearTimeout(timer);reject(new Error('Synthetic snapshot child unresolved'));});
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>16*1024*1024)child.kill();else out.push(b);});
  child.stderr.on('data',b=>{errorBytes+=b.length;if(errorBytes>16384)child.kill();else err.push(b);});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  child.on('close',code=>{clearTimeout(timer);if(signal?.aborted||bytes>16*1024*1024||errorBytes>16384)reject(new Error('Synthetic snapshot child unresolved'));
   else resolve({code,body:Buffer.concat(out),error:Buffer.concat(err).toString('utf8')});});
 });
 const successful=async(args,input,signal,extra)=>{const r=await execute(args,input,signal,extra);assert.equal(r.code,0,r.error);return r.body;};
 let dump,expired,sourceFingerprint,created=false;
 const captureUrl=dbName=>`postgresql://postgres:synthetic-maintenance-only@127.0.0.1:5432/${dbName}?sslmode=verify-full&sslrootcert=/tmp/cert.pem`;
 try{
  await successful(['mkdir','-m','700','/proof']);
  await admin.$executeRaw`CREATE SCHEMA managed_snapshot_fixture`;
  await admin.$executeRaw`CREATE TABLE public.synthetic_snapshot_public(id text PRIMARY KEY)`;
  await admin.$executeRaw`INSERT INTO public.synthetic_snapshot_public VALUES ('before-export')`;
  await admin.$executeRaw`CREATE TABLE public."Document"(id text PRIMARY KEY,"organisationId" text NOT NULL,"fileUrl" text NOT NULL,"fileSize" integer NOT NULL,"mimeType" text NOT NULL)`;
  await admin.$executeRaw`INSERT INTO public."Document" VALUES (${document.id},${document.organisationId},${document.fileUrl},${document.fileSize},${document.mimeType})`;
  await admin.$executeRaw`CREATE TABLE managed_snapshot_fixture.objects(id text PRIMARY KEY, body text NOT NULL)`;
  await admin.$executeRaw`CREATE TABLE managed_snapshot_fixture.app_records(id text PRIMARY KEY)`;
  await admin.$executeRaw`INSERT INTO managed_snapshot_fixture.objects VALUES ('record.txt','synthetic snapshot file')`;
  await admin.$executeRaw`INSERT INTO managed_snapshot_fixture.app_records VALUES ('before-export')`;
  const [db]=await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()`;
  const [observer]=await admin.$queryRaw`SELECT rolname AS name,oid::text AS oid FROM pg_roles WHERE rolname=current_user`;
  const [relation]=await admin.$queryRaw`SELECT t.oid::text AS oid FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='managed_snapshot_fixture' AND t.relname='objects'`;
  const service=new ManagedStorageMetadataWindow(holder,{database,databaseOid:db.oid,observer,
   relations:[{schema:'managed_snapshot_fixture',name:'objects',oid:relation.oid}],maxWindowMs:90000});
  const secret='sb_secret_'+'s'.repeat(40);
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
   await admin.$executeRaw`INSERT INTO public.synthetic_snapshot_public VALUES ('after-export')`;
   const databaseUrl=captureUrl(database),program=prepareSnapshotFingerprintCapture({databaseUrl,
    endpointIdentitySha256:sourceEndpointIdentitySha256(databaseUrl,{sourceContainerId:id}),rawReportName:'source.raw',dumpName:'source.dump',snapshot});
   const wrongScope=prepareSnapshotFingerprintCapture({databaseUrl,
    endpointIdentitySha256:sourceEndpointIdentitySha256(databaseUrl,{sourceContainerId:id}),rawReportName:'wrong.raw',dumpName:'wrong.dump',
    snapshot:{...snapshot,databaseOid:'1'}});
   const refused=await execute(['sh','-eu','-s'],Buffer.from(wrongScope.script),signal,wrongScope.environment);
   assert.notEqual(refused.code,0);assert.match(refused.error,/Original snapshot database\/exporter scope was not verified/);
   await successful(['sh','-eu','-s'],Buffer.from(program.script),signal,program.environment);
   dump=await successful(['cat','/proof/source.dump'],undefined,signal);
   sourceFingerprint=parseDatabaseFingerprintReport((await successful(['cat','/proof/source.raw'],undefined,signal)).toString());
   assert.equal(sourceFingerprint.tables.find(t=>t.table==='synthetic_snapshot_public').rowCount,'1');
   assert.equal(sourceFingerprint.capacityPreflight.verified,true);
   const metadata=[{documentIdentitySha256:canonicalDocumentIdentitySha256(document.id),metadataBindingSha256:canonicalMetadataBindingSha256(document),
    objectKeySha256:canonicalObjectKeySha256(document.fileUrl),fileSize:document.fileSize}];
   assert.equal(sourceFingerprint.documentMetadata.rowCount,1);
   assert.equal(sourceFingerprint.documentMetadata.rowsSha256,canonicalDocumentMetadataRowsSha256(metadata));
   assert.equal(dump.subarray(0,5).toString(),'PGDMP');
   const releaseProof=await prove(snapshot,sourceFingerprint.databaseIdentitySha256,signal);
   const files=await capture.capture(async(file,bytes,digest)=>{
    assert.equal(file.fileUrl,'record.txt');assert.equal(digest,hash(body));assert.deepEqual(bytes,body);
    const [row]=await admin.$queryRaw`SELECT body FROM managed_snapshot_fixture.objects WHERE id='record.txt'`;
    assert.equal(row.body,bytes.toString());
   },signal);
   return{databaseSha256:releaseProof.dumpSha256,databaseBytes:releaseProof.dumpBytes,files,releaseProof};
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
  const restoredUrl=captureUrl(destination),restoredProgram=prepareSnapshotFingerprintCapture({databaseUrl:restoredUrl,
   endpointIdentitySha256:sourceEndpointIdentitySha256(restoredUrl,{sourceContainerId:id}),rawReportName:'restored.raw'});
  await successful(['sh','-eu','-s'],Buffer.from(restoredProgram.script),undefined,restoredProgram.environment);
  const restoredFingerprint=parseDatabaseFingerprintReport((await successful(['cat','/proof/restored.raw'])).toString());
  const comparison=compareDatabaseFingerprints(sourceFingerprint,restoredFingerprint);
  assert.equal(comparison.databaseFingerprintMatched,true);assert.equal(comparison.mismatchCount,0);
  const publicRows=await successful(['psql','-h','127.0.0.1','-U','postgres','-d',destination,'-At','-v','ON_ERROR_STOP=1','-c',
   'SELECT id FROM public.synthetic_snapshot_public ORDER BY id']);assert.equal(publicRows.toString().trim(),'before-export');
  const late=await execute(['pg_dump','-h','127.0.0.1','-U','postgres','-d',database,'--format=custom','--schema=managed_snapshot_fixture','--snapshot='+expired]);
  assert.notEqual(late.code,0);assert.match(late.error,/invalid snapshot identifier/i);late.body.fill(0);
  console.log('PASS full imported v2 proof: clean committed original helper, protected dump/report, isolated restore/cleanup, source identity, Document projection and original snapshot context verified');
  console.log('PASS native canonical common capture: original helper imports guarded snapshot, dumps and fingerprints the same public view; isolated restore fingerprints match and omit later MVCC rows; file metadata matches; expired import refused');
 }finally{
  dump?.fill(0);
  try{if(created)await successful(['dropdb','-h','127.0.0.1','-U','postgres',destination]);}
  finally{await holder.$disconnect();await admin.$executeRaw`DROP SCHEMA IF EXISTS managed_snapshot_fixture CASCADE`;await admin.$executeRaw`DROP TABLE IF EXISTS public.synthetic_snapshot_public`;await admin.$executeRaw`DROP TABLE IF EXISTS public."Document"`;verifyOutput();rmSync(output,{recursive:true,force:true});}
 }
}
