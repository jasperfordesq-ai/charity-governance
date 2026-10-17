import {proveStorageGrantBoundary} from './storage-grant-boundary-postgres-proof.mjs';
import {mkdtempSync,readFileSync,rmSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {toStrictPrismaTlsUrl} from '../packages/shared/runtime/prisma-database-url.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {PrismaClient} from '@prisma/client';
import {ManagedDatabaseWriterFence} from '../apps/api/dist/services/managed-database-writer-fence.js';
import {proveManagedBackendMaintenance,proveManagedPasswordInvalidation} from './managed-backend-maintenance-postgres-proof.mjs';
import {validateLocalDockerEndpoint} from './personal-server-docker-boundary.mjs';
const containmentSelector=process.env.CHARITYPILOT_TEST_CONTAINED_SOURCE;
if(containmentSelector!==undefined&&!['0','1'].includes(containmentSelector))throw new Error('Contained source test selector must be exactly zero or one');
const containedSource=containmentSelector==='1';
const image='postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
function run(command,args,input){const r=spawnSync(command,args,{input,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.equal(r.status,0,(r.stderr||r.error?.message||'synthetic command failed').slice(-1200));return r.stdout.trim();}
test('managed database fence closes real stale credentials and sessions while refusing aliases, prepared and cross-database writers',{timeout:containedSource?480000:240000},async()=>{
 if(containedSource){assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);}
 console.log('SOURCE_EXECUTION_MODE='+(containedSource?'KERNEL_CONTAINED':'INTERNAL_IPC_PROOF'));
 const endpoint=JSON.parse(run('docker',['context','inspect','--format','{{json .Endpoints.docker}}']));
 validateLocalDockerEndpoint({endpoint:endpoint.Host,skipTlsVerify:endpoint.SkipTLSVerify},process.env);
 const docker=(args,input)=>run('docker',['--host',endpoint.Host,...args],input);assert.equal(docker(['info','--format','{{.OSType}}']),'linux');
 const name=`charitypilot-managed-writer-${randomUUID()}`,database=`managed_writer_${randomUUID().replaceAll('-','')}`;
 const certDir=mkdtempSync(join(tmpdir(),'charitypilot-managed-writer-tls-'));
 assert.equal(dirname(resolve(certDir)),resolve(tmpdir()));assert.ok(basename(certDir).startsWith('charitypilot-managed-writer-tls-'));
 let id,admin,writerA,writerB;
 try {
 const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
 run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),
  '-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE']);
 if(process.platform!=='win32'){
  chmodSync(join(certDir,'cert.pem'),0o644);chmodSync(join(certDir,'key.pem'),0o600);
  assert.equal(statSync(join(certDir,'cert.pem')).mode&0o777,0o644);assert.equal(statSync(join(certDir,'key.pem')).mode&0o777,0o600);
 }
 id=docker(['run','--detach','--network','bridge','--name',name,'--tmpfs','/var/lib/postgresql/data','--tmpfs','/tmp',
  '--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD=synthetic-maintenance-only','--env',`POSTGRES_DB=${database}`,
  '--entrypoint','sh',image,'-eu','-c',
  'while [ ! -f /tmp/fence-ready ]; do sleep 0.1; done; chown postgres:postgres /tmp/cert.pem /tmp/key.pem; chmod 600 /tmp/key.pem; exec docker-entrypoint.sh postgres -c max_prepared_transactions=4 -c ssl=on -c ssl_cert_file=/tmp/cert.pem -c ssl_key_file=/tmp/key.pem']);
 assert.match(id,/^[a-f0-9]{64}$/);
 docker(['exec','-i',id,'sh','-c','cat > /tmp/cert.pem'],readFileSync(join(certDir,'cert.pem')));
 docker(['exec','-i',id,'sh','-c','cat > /tmp/key.pem'],readFileSync(join(certDir,'key.pem')));
 docker(['exec',id,'touch','/tmp/fence-ready']);
  let ready=false;for(let i=0;i<80;i++){
   const r=spawnSync('docker',['--host',endpoint.Host,'exec',id,'pg_isready','-h','127.0.0.1','-U','postgres'],{encoding:'utf8',timeout:5000});
   if(r.status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));
  }assert.ok(ready);
  const port=/^127\.0\.0\.1:(\d{1,5})$/.exec(docker(['port',id,'5432/tcp']));assert.ok(port);
  const canonical=new URL(`postgresql://postgres:synthetic-maintenance-only@127.0.0.1:${port[1]}/${database}`);
  canonical.searchParams.set('connect_timeout','2');canonical.searchParams.set('sslmode','verify-full');
  canonical.searchParams.set('target_session_attrs','read-write');canonical.searchParams.set('sslrootcert',join(certDir,'cert.pem'));
  const driver=new URL(toStrictPrismaTlsUrl(canonical.href));driver.searchParams.set('connection_limit','1');driver.searchParams.set('pool_timeout','3');
  const url=driver.href;
  admin=new PrismaClient({datasources:{db:{url}}});
  const [actual]=await admin.$queryRaw`SELECT current_database() AS name,current_user AS role`;
  assert.equal(actual.name,database);assert.equal(actual.role,'postgres');assert.match(database,/^managed_writer_[a-f0-9]{32}$/);
  await admin.$executeRaw`CREATE ROLE managed_writer_a LOGIN PASSWORD 'synthetic-writer-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`;
  await admin.$executeRaw`CREATE ROLE managed_writer_b LOGIN PASSWORD 'synthetic-writer-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`;
  await admin.$executeRaw`CREATE ROLE managed_alias LOGIN PASSWORD 'synthetic-writer-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`;
  await admin.$executeRaw`CREATE TABLE public.synthetic_managed_writer(id TEXT PRIMARY KEY)`;
  await admin.$executeRaw`GRANT INSERT,SELECT ON public.synthetic_managed_writer TO managed_writer_a,managed_writer_b`;
  const roles=await admin.$queryRaw`SELECT rolname AS name,oid::text AS oid FROM pg_roles WHERE rolname IN ('postgres','managed_writer_a','managed_writer_b')`;
  const [db]=await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()`;
  const configuration={database,databaseOid:db.oid,maintenance:roles.find(r=>r.name==='postgres'),
   writers:roles.filter(r=>r.name!=='postgres'),custodians:[roles.find(r=>r.name==='postgres')]};
  const service=new ManagedDatabaseWriterFence(admin,configuration);
  const roleState=()=>admin.$queryRaw`SELECT rolname AS name,rolcanlogin AS login FROM pg_roles WHERE rolname IN ('managed_writer_a','managed_writer_b') ORDER BY rolname`;
  const client=(role,dbName=database)=>{const target=new URL(url);target.username=role;target.password='synthetic-writer-only';target.pathname='/'+dbName;
   return new PrismaClient({datasources:{db:{url:target.href}}});};
  writerA=client('managed_writer_a');writerB=client('managed_writer_b');
  await writerA.$executeRaw`INSERT INTO public.synthetic_managed_writer VALUES ('before-a')`;
  await writerB.$executeRaw`INSERT INTO public.synthetic_managed_writer VALUES ('before-b')`;
  await assert.rejects(service.observeClosed());
  const plainUrl=new URL(url);plainUrl.searchParams.set('sslmode','disable');plainUrl.searchParams.delete('sslcert');plainUrl.searchParams.delete('sslaccept');
  const plain=new PrismaClient({datasources:{db:{url:plainUrl.href}}});
  try {await assert.rejects(new ManagedDatabaseWriterFence(plain,configuration).close());}finally{await plain.$disconnect();}

  await assert.rejects(new ManagedDatabaseWriterFence(admin,{...configuration,database:'wrong_database'}).close());
  const wrong=structuredClone(configuration);wrong.writers[0].oid=String(Number(wrong.writers[0].oid)+1000);
  await assert.rejects(new ManagedDatabaseWriterFence(admin,wrong).close());
  await assert.rejects(new ManagedDatabaseWriterFence(writerA,configuration).close());
  assert.ok((await roleState()).every(r=>r.login));
  await admin.$executeRaw`CREATE ROLE managed_parent NOLOGIN CREATEROLE`;
  await admin.$executeRaw`GRANT managed_parent TO managed_writer_a`;
  await assert.rejects(service.close());assert.ok((await roleState()).every(r=>r.login));
  await admin.$executeRaw`REVOKE managed_parent FROM managed_writer_a`;
  await admin.$executeRaw`ALTER ROLE managed_writer_a CREATEDB`;
  await assert.rejects(service.close());assert.ok((await roleState()).every(r=>r.login));
  await admin.$executeRaw`ALTER ROLE managed_writer_a NOCREATEDB`;
  await admin.$executeRaw`GRANT managed_writer_a TO managed_alias`;
  await admin.$executeRaw`ALTER ROLE managed_writer_a NOLOGIN`;
  // A LOGIN member can still SET ROLE despite the target's NOLOGIN. Do not
  // mistake closing one username for closing every application principal.
  docker(['exec','--env','PGPASSWORD=synthetic-writer-only',id,'psql','-h','127.0.0.1','-U','managed_alias','-d',database,'-v','ON_ERROR_STOP=1',
   '-c',"SET ROLE managed_writer_a; INSERT INTO public.synthetic_managed_writer VALUES ('alias-still-writes');"]);
  await assert.rejects(service.close());assert.equal((await roleState())[1].login,true);
  await admin.$executeRaw`REVOKE managed_writer_a FROM managed_alias`;
  await admin.$executeRaw`ALTER ROLE managed_writer_a LOGIN`;
  await admin.$executeRaw`GRANT CONNECT ON DATABASE postgres TO managed_writer_a`;
  await assert.rejects(service.close());assert.ok((await roleState()).every(r=>r.login));
  await admin.$executeRaw`REVOKE CONNECT ON DATABASE postgres FROM managed_writer_a`;
  const other=client('managed_writer_a','postgres');try{await other.$queryRaw`SELECT 1`;await assert.rejects(service.close());}
  finally{await other.$disconnect();}
  docker(['exec','--env','PGPASSWORD=synthetic-writer-only',id,'psql','-h','127.0.0.1','-U','managed_writer_a','-d',database,'-v','ON_ERROR_STOP=1',
   '-c',"BEGIN; INSERT INTO public.synthetic_managed_writer VALUES ('prepared-pending'); PREPARE TRANSACTION 'synthetic-managed-writer';"]);
  await assert.rejects(service.close());assert.ok((await roleState()).every(r=>r.login));
  await admin.$executeRaw`ROLLBACK PREPARED 'synthetic-managed-writer'`;
  let lost=true;
  const unknown={$transaction:async(fn,options)=>{const value=await admin.$transaction(fn,options);if(lost){lost=false;throw new Error('PRIVATE-REAL-COMMIT-ACK-LOST');}return value;}};
  await assert.rejects(new ManagedDatabaseWriterFence(unknown,configuration).close());assert.equal(lost,false);
  assert.ok((await roleState()).every(r=>!r.login));
  // NOLOGIN has committed but old sessions remain usable until explicitly
  // drained. A lost acknowledgement must never be called complete here.
  await writerA.$executeRaw`INSERT INTO public.synthetic_managed_writer VALUES ('old-session-after-nologin')`;
  await assert.rejects(service.observeClosed());
  const closed=await service.close();assert.equal(closed.databaseWriterPrincipalsClosed,true);assert.equal(closed.remainingSessions,0);
  for(const flag of ['wholeBackendQuiesced','sourceHostFenced','providerJobsFenced','reopeningAuthorised','actionAuthorized'])assert.equal(closed[flag],false);
  assert.ok((await roleState()).every(r=>!r.login));
  for(const role of ['managed_writer_a','managed_writer_b']){
   const fresh=client(role);try{await assert.rejects(fresh.$queryRaw`SELECT 1`);}finally{await fresh.$disconnect();}
  }
  assert.equal((await service.close()).databaseWriterPrincipalsClosed,true);
  const mutable=structuredClone(configuration),snapshot=new ManagedDatabaseWriterFence(admin,mutable);mutable.writers[0].name='postgres';
  assert.equal((await snapshot.observeClosed()).databaseWriterPrincipalsClosed,true);
  const [count]=await admin.$queryRaw`SELECT count(*)::integer AS total FROM public.synthetic_managed_writer`;
  assert.equal(count.total,4); // No source rows were deleted; prepared insert rolled back only by this fixture.
  await proveManagedPasswordInvalidation({admin,configuration,url});
  await proveManagedBackendMaintenance({admin,configuration,url,id,database,certificate:join(certDir,'cert.pem'),sourceExecutionMode:containedSource?'KERNEL_CONTAINED':'INTERNAL_IPC_PROOF'});
  await proveStorageGrantBoundary({admin,url});
 }finally{
  await writerA?.$disconnect();await writerB?.$disconnect();await admin?.$disconnect();
  try {if(id)docker(['rm','--force',id]);}
  finally {assert.equal(dirname(resolve(certDir)),resolve(tmpdir()));assert.ok(basename(certDir).startsWith('charitypilot-managed-writer-tls-'));rmSync(certDir,{recursive:true,force:true});}
 }
});
