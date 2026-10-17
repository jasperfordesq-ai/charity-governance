import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';

/** SQL semantics experiment in the EXISTING disposable TLS PostgreSQL fixture.
 * Not a Supabase migration, operator command, live ACL fence or release claim. */
export async function proveStorageGrantBoundary({admin,url}){
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
  await capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('column-grant-writes')`;
  await admin.$executeRaw`REVOKE INSERT(value) ON public.synthetic_storage_boundary FROM storage_probe_capture`;
  await denied(()=>capture.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('column-grant-revoked')`);

  await admin.$executeRaw`CREATE FUNCTION public.synthetic_storage_elevated_write(text) RETURNS integer
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS
   'INSERT INTO public.synthetic_storage_boundary VALUES ($1); SELECT 1'`;
  await admin.$executeRaw`REVOKE ALL ON FUNCTION public.synthetic_storage_elevated_write(text) FROM PUBLIC`;
  await admin.$executeRaw`GRANT EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) TO storage_probe_capture`;
  assert.equal((await capture.$queryRaw`SELECT public.synthetic_storage_elevated_write('function-still-writes') AS ok`)[0].ok,1);
  await admin.$executeRaw`REVOKE EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) FROM storage_probe_capture`;
  await denied(()=>capture.$queryRaw`SELECT public.synthetic_storage_elevated_write('function-revoked') AS ok`);

  await admin.$executeRaw`GRANT INSERT ON public.synthetic_storage_boundary TO storage_probe_alternate`;
  await admin.$executeRaw`GRANT storage_probe_alternate TO storage_probe_capture`;
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

 }finally{
  releasePending?.();await capture.$disconnect();await fencer.$disconnect();await actor.$disconnect();
 }
}
