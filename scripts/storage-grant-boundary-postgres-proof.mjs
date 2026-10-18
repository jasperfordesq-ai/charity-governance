import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {SupabaseRecoveryCapture} from '../apps/api/dist/services/supabase-recovery-capture.js';
import {PrismaClient} from '@prisma/client';
import {proveStorageMetadataWindow} from './storage-metadata-window-postgres-proof.mjs';
import {ManagedStorageDatabaseInventory} from '../apps/api/dist/services/managed-storage-database-inventory.js';
import {proveCaptureRoleWindow} from './capture-role-window-postgres-proof.mjs';
import {proveReadRoleCapture} from './read-role-capture-postgres-proof.mjs';

/** Explicit provider model: real JWT crypto + actual TLS role-scoped SQL,
 * not a hosted Storage server or a held provider privilege interval. */
async function proveReadRoleJwtCapture(admin,readerRole,boundary,readerBoundary){
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),subject=randomUUID(),now=Math.floor(Date.now()/1000),projectRef='abcdefghijklmnopqrst';
 const authentication={kind:'SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1',sqlRole:readerRole,subject,
  verificationKey:{...pair.publicKey.export({format:'jwk'}),alg:'ES256',kid:'synthetic-read-role',use:'sig'}};
 const token=jwt.sign({iss:`https://${projectRef}.supabase.co/auth/v1`,aud:'authenticated',sub:subject,role:readerRole.name,iat:now,exp:now+300},pair.privateKey,
  {algorithm:'ES256',header:{alg:'ES256',typ:'JWT',kid:'synthetic-read-role'}});
 const asRole=async operation=>{
  const claims=jwt.verify(token,pair.publicKey,{algorithms:['ES256'],issuer:`https://${projectRef}.supabase.co/auth/v1`,audience:'authenticated'});
  assert.equal(claims.role,readerRole.name);assert.equal(claims.sub,subject);
  return admin.$transaction(async tx=>{await tx.$queryRaw`SELECT set_config('role',${claims.role},true)`;return operation(tx);});
 };
 let calls=0;
 const capture=new SupabaseRecoveryCapture({installationId:'synthetic-reader',projectRef,bucket:'synthetic-read-bucket',credential:{id:subject,sha256:createHash('sha256').update(token).digest('hex')},authentication},token,async(input,init)=>{
  calls++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+token);assert.equal(new Headers(init.headers).get('apikey'),null);
  const u=new URL(String(input));assert.equal(u.origin,`https://${projectRef}.supabase.co`);
  const rows=await asRole(tx=>tx.$queryRaw`SELECT value FROM public.synthetic_storage_boundary WHERE value='synthetic-reader-control'`);assert.equal(rows.length,1);
  if(u.pathname.includes('/bucket/'))return Response.json({id:'synthetic-read-bucket',public:false});
  if(u.pathname.includes('/object/list/')){assert.equal(init.method,'POST');return Response.json([{name:'synthetic.txt',id:subject,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',metadata:{size:Buffer.byteLength(rows[0].value),mimetype:'text/plain'}}]);}
  assert.equal(init.method,'GET');return new Response(rows[0].value,{headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(rows[0].value))}});
 });
 let visited=0;const result=await capture.capture(async(_file,bytes)=>{visited++;assert.equal(bytes.toString(),'synthetic-reader-control');});
 assert.equal(visited,1);assert.equal(result.kind,'SUPABASE_READ_ROLE_CANDIDATE_CAPTURE_V1');assert.equal(result.jwtVerification.signatureVerified,true);
 assert.deepEqual(result.jwtVerification.sqlRole,boundary.capture);assert.equal(result.jwtVerification.providerSqlRoleVerified,false);assert.equal(result.credentialWriteAuthorityExcluded,false);
 assert.equal(JSON.stringify(result).includes(token),false);assert.equal(JSON.stringify(capture).includes(token),false);assert.ok(calls>=5);
 const guarded=await capture.captureWithSqlRoleWindow(readerBoundary,async(_file,bytes)=>assert.equal(bytes.toString(),'synthetic-reader-control'),{maxWindowMs:5000});
 assert.equal(guarded.kind,'SUPABASE_SQL_ROLE_WINDOW_CANDIDATE_V1');assert.equal(guarded.configuredJwtSqlRoleMatched,true);assert.equal(guarded.providerTokenRoleVerified,false);
 assert.equal(guarded.sqlPrivilegeWindow.listedCatalogueChangesExcludedDuringCallback,true);assert.equal(JSON.stringify(guarded).includes(token),false);
 let mismatchCalls=0;const mismatched=new SupabaseRecoveryCapture({installationId:'synthetic-reader',projectRef,bucket:'synthetic-read-bucket',credential:{id:subject,sha256:createHash('sha256').update(token).digest('hex')},authentication:{...authentication,sqlRole:{...readerRole,oid:'1'}}},token,async()=>{mismatchCalls++;throw new Error();});
 await assert.rejects(mismatched.captureWithSqlRoleWindow(readerBoundary,async()=>{}, {maxWindowMs:5000}));assert.equal(mismatchCalls,0);
 let held;const cancelled=new AbortController();
 await assert.rejects(capture.captureWithSqlRoleWindow(readerBoundary,async(_file,bytes)=>{held=bytes;cancelled.abort();await new Promise(()=>{});},{maxWindowMs:5000},cancelled.signal));
 assert.ok(held?.every(v=>v===0));
 await assert.rejects(()=>asRole(tx=>tx.$executeRaw`UPDATE public.synthetic_storage_boundary SET value='jwt-must-not-write' WHERE value='synthetic-reader-control'`),e=>e?.code==='P2010'&&e?.meta?.code==='42501');
 console.log('PASS capture JWT/native SQL composition: verified asymmetric custom-role bearer, actual role-scoped reads and 42501 write refusal, token-free output; provider transport is synthetic, no hosted privilege-interval claim');
}

/** SQL semantics experiment in the EXISTING disposable TLS PostgreSQL fixture.
 * Not a Supabase migration, operator command, live ACL fence or release claim. */
export async function proveStorageGrantBoundary({admin,url,prepareCatalogueTransaction}){
 const target=new URL(url);
 assert.ok(['127.0.0.1','localhost'].includes(target.hostname));
 assert.match(target.pathname,/^\/managed_writer_[a-f0-9]{32}$/);
 const [identity]=await admin.$queryRaw`SELECT current_database() AS name,current_user AS role,
  (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls`;
 assert.equal(identity.name,target.pathname.slice(1));assert.equal(identity.role,'postgres');assert.equal(identity.tls,true);
 await admin.$executeRaw`CREATE ROLE storage_probe_capture LOGIN PASSWORD 'synthetic-capture-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT`;
 await admin.$executeRaw`CREATE ROLE storage_probe_alternate NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT`;
 await admin.$executeRaw`CREATE TABLE public.synthetic_storage_boundary(value text PRIMARY KEY)`;
 await admin.$executeRaw`ALTER TABLE public.synthetic_storage_boundary ENABLE ROW LEVEL SECURITY`;
 await admin.$executeRaw`ALTER TABLE public.synthetic_storage_boundary FORCE ROW LEVEL SECURITY`;
 await admin.$executeRaw`GRANT USAGE ON SCHEMA public TO storage_probe_capture,storage_probe_alternate`;
 await admin.$executeRaw`GRANT SELECT,INSERT,UPDATE,DELETE ON public.synthetic_storage_boundary TO storage_probe_capture`;
 const captureUrl=new URL(target);captureUrl.username='storage_probe_capture';captureUrl.password='synthetic-capture-only';
 const capture=new PrismaClient({datasources:{db:{url:captureUrl.href}}}),
  fencer=new PrismaClient({datasources:{db:{url}}}),
  actor=new PrismaClient({datasources:{db:{url}}});
 const [database]=await admin.$queryRaw`SELECT current_database() AS name,oid::text AS oid FROM pg_database WHERE datname=current_database()`;
 const principals=await admin.$queryRaw`SELECT rolname AS name,oid::text AS oid FROM pg_roles WHERE rolname IN ('postgres','storage_probe_capture','storage_probe_alternate')`;
 const [relation]=await admin.$queryRaw`SELECT oid::text AS oid FROM pg_class WHERE oid='public.synthetic_storage_boundary'::regclass`;
 const config={database:database.name,databaseOid:database.oid,observer:principals.find(p=>p.name==='postgres'),
  capture:principals.find(p=>p.name==='storage_probe_capture'),relations:[{schema:'public',name:'synthetic_storage_boundary',oid:relation.oid}]};
 const inventory=new ManagedStorageDatabaseInventory(admin,config);
 const captureGrant=report=>report.grants.find(g=>g.roleOid===config.capture.oid&&g.relationOid===relation.oid);
 let releasePending;
 const denied=fn=>assert.rejects(fn,e=>e?.code==='P2010'&&e?.meta?.code==='42501');
 const options={maxWait:5000,timeout:15000};
 try{
  const [role]=await capture.$queryRaw`SELECT current_user AS name,
   (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
   (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`;
  assert.equal(role.name,'storage_probe_capture');assert.equal(role.bypass,true);assert.equal(role.super,false);
  await capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('baseline')`;
  assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary`)[0].n,1);

  let entered;const started=new Promise(r=>{entered=r;}),release=new Promise(r=>{releasePending=r;});
  const pending=capture.$transaction(async tx=>{
   await tx.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('commit-after-plain-revoke')`;
   entered();await release;
  },options);void pending.catch(()=>{});
  await started;
  await admin.$executeRaw`REVOKE INSERT,UPDATE,DELETE ON public.synthetic_storage_boundary FROM storage_probe_capture`;
  const [acl]=await admin.$queryRaw`SELECT has_table_privilege('storage_probe_capture','public.synthetic_storage_boundary','INSERT') AS insert`;
  assert.equal(acl.insert,false);
  assert.equal((await admin.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='commit-after-plain-revoke'`)[0].n,0);
  releasePending();await pending;
  assert.equal((await admin.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='commit-after-plain-revoke'`)[0].n,1);
  await denied(()=>capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('new-write-denied')`);
  assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary`)[0].n,2);
  console.log('PASS storage SQL boundary: BYPASSRLS is not SELECT-only; plain REVOKE does not drain an already-authorised transaction');

  await admin.$executeRaw`GRANT INSERT(value) ON public.synthetic_storage_boundary TO storage_probe_capture`;
  const [column]=await admin.$queryRaw`SELECT has_table_privilege('storage_probe_capture','public.synthetic_storage_boundary','INSERT') AS table_insert,
   has_column_privilege('storage_probe_capture','public.synthetic_storage_boundary','value','INSERT') AS column_insert`;
  assert.equal(column.table_insert,false);assert.equal(column.column_insert,true);
  const columnReport=await inventory.observe();
  assert.equal(captureGrant(columnReport).insert,false);assert.equal(captureGrant(columnReport).columnInsert,true);
  assert.equal(columnReport.identity.readOnly,true);assert.equal(columnReport.identity.encrypted,true);
  assert.equal(columnReport.roles.find(r=>r.oid===config.capture.oid).bypassRls,true);
  assert.equal(columnReport.captureCredentialReadOnlyVerified,false);assert.equal(columnReport.wholeBackendQuiesced,false);
  assert.equal(columnReport.allWritersInventoried,false);assert.equal(columnReport.metadataWindowHeld,false);
  assert.equal(columnReport.relations[0].ownerOid,config.observer.oid);
  assert.doesNotMatch(JSON.stringify(columnReport),/synthetic-capture-only|commit-after-plain-revoke|INSERT INTO/);
  await capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('column-grant-writes')`;
  await admin.$executeRaw`REVOKE INSERT(value) ON public.synthetic_storage_boundary FROM storage_probe_capture`;
  await denied(()=>capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('column-grant-revoked')`);

  await admin.$executeRaw`CREATE FUNCTION public.synthetic_storage_elevated_write(text) RETURNS integer
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS
   'INSERT INTO public.synthetic_storage_boundary VALUES ($1); SELECT 1'`;
  await admin.$executeRaw`REVOKE ALL ON FUNCTION public.synthetic_storage_elevated_write(text) FROM PUBLIC`;
  await admin.$executeRaw`GRANT EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) TO storage_probe_capture`;
  const functionReport=await inventory.observe();
  assert.equal(functionReport.definers.find(f=>f.name==='synthetic_storage_elevated_write').executableBy.includes(config.capture.oid),true);
  assert.equal((await capture.$queryRaw`SELECT public.synthetic_storage_elevated_write('function-still-writes') AS ok`)[0].ok,1);
  await admin.$executeRaw`REVOKE EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) FROM storage_probe_capture`;
  assert.equal((await inventory.observe()).definers.find(f=>f.name==='synthetic_storage_elevated_write').executableBy.includes(config.capture.oid),false);
  await denied(()=>capture.$queryRaw`SELECT public.synthetic_storage_elevated_write('function-revoked') AS ok`);

  await admin.$executeRaw`GRANT INSERT ON public.synthetic_storage_boundary TO storage_probe_alternate`;
  await admin.$executeRaw`GRANT storage_probe_alternate TO storage_probe_capture`;
  const membershipReport=await inventory.observe(),alternate=principals.find(p=>p.name==='storage_probe_alternate');
  const membership=membershipReport.memberships.find(m=>m.memberOid===config.capture.oid&&m.roleOid===alternate.oid);
  assert.equal(membership.set,true);assert.equal(membership.inherit,false);
  assert.equal(membershipReport.grants.find(g=>g.roleOid===alternate.oid).insert,true);
  assert.equal(captureGrant(membershipReport).insert,false);
  await denied(()=>capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('noinherit-direct-denied')`);
  await capture.$transaction(async tx=>{
   await tx.$executeRaw`SET LOCAL ROLE storage_probe_alternate`;
   await tx.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('set-role-still-writes')`;
  },options);
  await admin.$executeRaw`REVOKE storage_probe_alternate FROM storage_probe_capture`;
  console.log('PASS storage SQL boundary: column ACLs, privileged functions and NOINHERIT SET ROLE can retain write paths');

  // Fixture-only reset for the lock/drain counterfactual, never an operator path.
  await admin.$executeRaw`GRANT INSERT,UPDATE,DELETE ON public.synthetic_storage_boundary TO storage_probe_capture`;
  let writerEntered,unlockWriter;
  const writerStarted=new Promise(r=>{writerEntered=r;}),unlock=new Promise(r=>{unlockWriter=r;releasePending=r;});
  const beforeFence=capture.$transaction(async tx=>{
   await tx.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('committed-before-lock-ack')`;
   writerEntered();await unlock;
  },options);void beforeFence.catch(()=>{});
  await writerStarted;
  let lockEntered,lockPid,acknowledged=false;
  const lockStarted=new Promise(r=>{lockEntered=r;});
  const fence=fencer.$transaction(async tx=>{
   lockPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
   await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;
   lockEntered();await tx.$executeRaw`LOCK TABLE public.synthetic_storage_boundary IN ACCESS EXCLUSIVE MODE`;
   await tx.$executeRaw`REVOKE INSERT,UPDATE,DELETE ON public.synthetic_storage_boundary FROM storage_probe_capture`;
   const [effective]=await tx.$queryRaw`SELECT has_table_privilege('storage_probe_capture','public.synthetic_storage_boundary','SELECT') AS read,
    has_table_privilege('storage_probe_capture','public.synthetic_storage_boundary','INSERT,UPDATE,DELETE,TRUNCATE') AS write`;
   assert.equal(effective.read,true);assert.equal(effective.write,false);
  },options).then(()=>{acknowledged=true;});void fence.catch(()=>{});
  try{
   await lockStarted;let waiting=false;
   for(let i=0;i<100;i++){
    waiting=(await admin.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${lockPid}
     AND relation='public.synthetic_storage_boundary'::regclass AND mode='AccessExclusiveLock' AND NOT granted) AS waiting`)[0].waiting;
    if(waiting)break;await new Promise(r=>setTimeout(r,10));
   }
   assert.equal(waiting,true);assert.equal(acknowledged,false);
  }finally{unlockWriter();}
  await beforeFence;await fence;assert.equal(acknowledged,true);
  for(const operation of [
   ()=>capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('after-fence')`,
   ()=>capture.$executeRaw`UPDATE public.synthetic_storage_boundary SET value='after-update' WHERE value='baseline'`,
   ()=>capture.$executeRaw`DELETE FROM public.synthetic_storage_boundary WHERE value='baseline'`,
  ])await denied(operation);
  assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='committed-before-lock-ack'`)[0].n,1);
  await admin.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('privileged-custodian-still-writes')`;
  assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='privileged-custodian-still-writes'`)[0].n,1);
  console.log('PASS storage SQL boundary: observed exclusive-lock wait drains prior DML before grant ACK; positive reads survive; privileged custodian remains outside this fence');

  let shareEntered,releaseShare;
  const shareStarted=new Promise(r=>{shareEntered=r;}),shareRelease=new Promise(r=>{releaseShare=r;releasePending=r;});
  const readWindow=fencer.$transaction(async tx=>{
   await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;
   await tx.$executeRaw`LOCK TABLE public.synthetic_storage_boundary IN SHARE MODE`;
   shareEntered();await shareRelease;
  },options);void readWindow.catch(()=>{});
  await shareStarted;
  let actorEntered,actorPid,actorCommitted=false;
  const actorStarted=new Promise(r=>{actorEntered=r;});
  const outsideWrite=actor.$transaction(async tx=>{
   actorPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
   await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;actorEntered();
   await tx.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('privileged-write-after-read-window')`;
  },options).then(()=>{actorCommitted=true;});void outsideWrite.catch(()=>{});
  try{
   await actorStarted;let waiting=false;
   for(let i=0;i<100;i++){
    waiting=(await admin.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${actorPid}
     AND relation='public.synthetic_storage_boundary'::regclass AND mode='RowExclusiveLock' AND NOT granted) AS waiting`)[0].waiting;
    if(waiting)break;await new Promise(r=>setTimeout(r,10));
   }
   assert.equal(waiting,true);assert.equal(actorCommitted,false);
   const [read]=await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='baseline'`;
   assert.equal(read.n,1);
   assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='privileged-write-after-read-window'`)[0].n,0);
  }finally{releaseShare();}
  await readWindow;await outsideWrite;assert.equal(actorCommitted,true);
  assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='privileged-write-after-read-window'`)[0].n,1);
  console.log('PASS storage SQL boundary: SHARE capture window permits positive reads while blocking observed privileged DML, then releases it; this is no permanent actor fence');

  const report=await inventory.observe();
  assert.equal(captureGrant(report).select,true);assert.equal(captureGrant(report).insert,false);
  assert.equal(report.grants.find(g=>g.roleOid===config.observer.oid).insert,true);
  assert.equal(report.roles.find(r=>r.oid===config.observer.oid).superuser,true);
  // A hostile ambient search_path must not substitute privilege predicates.
  await admin.$executeRaw`CREATE FUNCTION public.has_table_privilege(oid,oid,text) RETURNS boolean LANGUAGE sql AS 'SELECT false'`;
  await capture.$executeRaw`SET search_path=public,pg_catalog`;
  assert.equal((await capture.$queryRaw`SELECT has_table_privilege(${config.capture.oid}::oid,${relation.oid}::oid,'SELECT'::text) AS allowed`)[0].allowed,false);
  const limitedReport=await new ManagedStorageDatabaseInventory(capture,{...config,observer:config.capture}).observe();
  assert.equal((await capture.$queryRaw`SELECT current_setting('search_path') AS path`)[0].path,'public, pg_catalog');
  assert.equal(limitedReport.identity.currentRole,config.capture.name);assert.equal(limitedReport.identity.readOnly,true);
  assert.equal(captureGrant(limitedReport).select,true);assert.equal(captureGrant(limitedReport).insert,false);
  assert.equal(limitedReport.roles.find(r=>r.oid===config.capture.oid).superuser,false);
  assert.equal(report.configurationDigest,inventory.configurationDigest());assert.match(report.observationDigest,/^[a-f0-9]{64}$/);
  for(const altered of [
   {...config,databaseOid:'1'},
   {...config,observer:{...config.observer,oid:'1'}},
   {...config,capture:{...config.capture,oid:'1'}},
   {...config,relations:[{...config.relations[0],name:'incorrect_relation'}]},
  ])await assert.rejects(()=>new ManagedStorageDatabaseInventory(admin,altered).observe(),/^Error: Managed storage database authority inventory is unverified$/);
  assert.throws(()=>new ManagedStorageDatabaseInventory(admin,{...config,relations:[...config.relations,...config.relations]}));
  await admin.$executeRaw`CREATE TABLE public.synthetic_inventory_partition(value text) PARTITION BY RANGE(value)`;
  const [partition]=await admin.$queryRaw`SELECT oid::text AS oid FROM pg_class WHERE oid='public.synthetic_inventory_partition'::regclass`;
  await assert.rejects(()=>new ManagedStorageDatabaseInventory(admin,{...config,relations:[{schema:'public',name:'synthetic_inventory_partition',oid:partition.oid}]}).observe());
  const originalInventoryDigest=inventory.configurationDigest();report.capture.name='mutated-result';
  assert.equal(inventory.configurationDigest(),originalInventoryDigest);
  assert.equal((await inventory.observe()).capture.name,config.capture.name);
  await proveStorageMetadataWindow({admin,fencer,actor,capture,config});
  // Dedicated NOLOGIN JWT-role shape: direct SELECT only, no inherited or
  // switchable roles. This is a disposable SQL contract, not hosted JWT proof.
  await admin.$executeRaw`CREATE ROLE storage_probe_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
  await admin.$executeRaw`GRANT USAGE ON SCHEMA public TO storage_probe_reader`;
  await admin.$executeRaw`GRANT SELECT ON public.synthetic_storage_boundary TO storage_probe_reader`;
  await admin.$executeRaw`CREATE POLICY synthetic_reader_select ON public.synthetic_storage_boundary FOR SELECT TO storage_probe_reader USING (true)`;
  await admin.$executeRaw`INSERT INTO public.synthetic_storage_boundary(value) VALUES ('synthetic-reader-control') ON CONFLICT DO NOTHING`;
  const [readerRole]=await admin.$queryRaw`SELECT rolname AS name,oid::text AS oid FROM pg_roles WHERE rolname='storage_probe_reader'`;
  const readerBoundary=new ManagedStorageDatabaseInventory(admin,{...config,capture:readerRole});
  const boundary=await readerBoundary.observeCaptureRoleBoundary();assert.equal(boundary.configuredCaptureSqlReadOnlyObserved,true);
  assert.equal(boundary.privilegeIntervalHeld,false);assert.equal(boundary.privilegeChangesExcluded,false);assert.equal(boundary.captureCredentialReadOnlyVerified,false);assert.equal(boundary.providerTokenRoleVerified,false);assert.equal(boundary.wholeBackendQuiesced,false);
  const visible=await admin.$transaction(async tx=>{await tx.$queryRaw`SELECT set_config('role','storage_probe_reader',true)`;return tx.$queryRaw`SELECT count(*)::integer AS total FROM public.synthetic_storage_boundary WHERE value='synthetic-reader-control'`;});
  assert.equal(visible[0].total,1);
  await denied(()=>admin.$transaction(async tx=>{await tx.$queryRaw`SELECT set_config('role','storage_probe_reader',true)`;await tx.$executeRaw`UPDATE public.synthetic_storage_boundary SET value='reader-must-not-write' WHERE value='synthetic-reader-control'`;}));
  await proveReadRoleJwtCapture(admin,readerRole,boundary,new ManagedStorageDatabaseInventory(fencer,{...config,capture:readerRole}));
  await proveCaptureRoleWindow({admin,fencer,actor,capture,config,readerRole,prepareCatalogueTransaction});
  await proveReadRoleCapture({admin,fencer,actor,config,readerRole,url});
  await admin.$executeRaw`GRANT INSERT(value) ON public.synthetic_storage_boundary TO storage_probe_reader`;
  await assert.rejects(()=>readerBoundary.observeCaptureRoleBoundary());await admin.$executeRaw`REVOKE INSERT(value) ON public.synthetic_storage_boundary FROM storage_probe_reader`;
  await admin.$executeRaw`GRANT storage_probe_alternate TO storage_probe_reader WITH INHERIT FALSE, SET TRUE`;
  await assert.rejects(()=>readerBoundary.observeCaptureRoleBoundary());await admin.$executeRaw`REVOKE storage_probe_alternate FROM storage_probe_reader`;
  await admin.$executeRaw`GRANT EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) TO storage_probe_reader`;
  await assert.rejects(()=>readerBoundary.observeCaptureRoleBoundary());await admin.$executeRaw`REVOKE EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) FROM storage_probe_reader`;
  await admin.$executeRaw`GRANT CREATE ON SCHEMA public TO storage_probe_reader`;
  await assert.rejects(()=>readerBoundary.observeCaptureRoleBoundary());await admin.$executeRaw`REVOKE CREATE ON SCHEMA public FROM storage_probe_reader`;
  await admin.$executeRaw`ALTER ROLE storage_probe_reader BYPASSRLS`;
  await assert.rejects(()=>readerBoundary.observeCaptureRoleBoundary());await admin.$executeRaw`ALTER ROLE storage_probe_reader NOBYPASSRLS`;
  assert.equal((await readerBoundary.observeCaptureRoleBoundary()).configuredCaptureSqlReadOnlyObserved,true);
  console.log('PASS custom capture SQL role: positive RLS read, actual 42501 write refusal, column mutation, SET ROLE, definer EXECUTE, schema CREATE and BYPASSRLS rejected; no provider-token/global-authority claim');
  // Read-only report must refuse truncation instead of hiding another definer.
  await admin.$executeRaw`DO $fixture$ BEGIN FOR i IN 1..257 LOOP
   EXECUTE format('CREATE FUNCTION public.synthetic_inventory_overflow_%s() RETURNS integer LANGUAGE sql SECURITY DEFINER AS %L',i,'SELECT 1');
  END LOOP; END $fixture$`;
  await assert.rejects(()=>inventory.observe(),/^Error: Managed storage database authority inventory is unverified$/);
  console.log('PASS native storage authority inventory: column grants, definer EXECUTE changes, NOINHERIT SET ROLE, owner/superuser and positive reads detected; identity, unsupported partition and overflow refused');

 }finally{
  releasePending?.();await capture.$disconnect();await fencer.$disconnect();await actor.$disconnect();
 }
}
