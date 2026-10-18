import assert from 'node:assert/strict';
import {ManagedStorageDatabaseInventory} from '../apps/api/dist/services/managed-storage-database-inventory.js';

/** Runs only in the original disposable TLS writer fixture. All SQL below is
 * synthetic, fixed or derived from that fixture's validated database name. */
export async function proveCaptureRoleWindow({admin,fencer,actor,capture,config,readerRole,prepareCatalogueTransaction}){
 assert.match(config.database,/^managed_writer_[a-f0-9]{32}$/);
 const service=new ManagedStorageDatabaseInventory(fencer,{...config,capture:readerRole});
 const options={maxWindowMs:5000};
 let deniedCalls=0;await assert.rejects(new ManagedStorageDatabaseInventory(capture,{...config,observer:config.capture,capture:readerRole})
  .runCaptureRoleWindow(async()=>{deniedCalls++;},options));assert.equal(deniedCalls,0);
 const cases=[
  ['table','GRANT INSERT ON public.synthetic_storage_boundary TO storage_probe_reader','REVOKE INSERT ON public.synthetic_storage_boundary FROM storage_probe_reader'],
  ['column','GRANT INSERT(value) ON public.synthetic_storage_boundary TO storage_probe_reader','REVOKE INSERT(value) ON public.synthetic_storage_boundary FROM storage_probe_reader'],
  ['membership','GRANT storage_probe_alternate TO storage_probe_reader WITH INHERIT FALSE, SET TRUE','REVOKE storage_probe_alternate FROM storage_probe_reader'],
  ['role','ALTER ROLE storage_probe_reader BYPASSRLS','ALTER ROLE storage_probe_reader NOBYPASSRLS'],
  ['definer','GRANT EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) TO storage_probe_reader','REVOKE EXECUTE ON FUNCTION public.synthetic_storage_elevated_write(text) FROM storage_probe_reader'],
  ['schema','GRANT CREATE ON SCHEMA public TO storage_probe_reader','REVOKE CREATE ON SCHEMA public FROM storage_probe_reader'],
  ['database',`GRANT CREATE ON DATABASE "${config.database}" TO storage_probe_reader`,`REVOKE CREATE ON DATABASE "${config.database}" FROM storage_probe_reader`],
  ['rls','ALTER TABLE public.synthetic_storage_boundary DISABLE ROW LEVEL SECURITY','ALTER TABLE public.synthetic_storage_boundary ENABLE ROW LEVEL SECURITY'],
  ['routine','ALTER FUNCTION public.synthetic_storage_elevated_write(text) SECURITY INVOKER','ALTER FUNCTION public.synthetic_storage_elevated_write(text) SECURITY DEFINER'],
 ];
 for(const [label,mutation,restore] of cases){
  let pending,committed=false,entered,actorPid;
  const started=new Promise(r=>{entered=r;});
  try{
   const result=await service.runCaptureRoleWindow(async(boundary,signal)=>{
    assert.deepEqual(boundary.capture,readerRole);assert.equal(signal.aborted,false);
    // Positive role-scoped read before a DDL actor can lock the user table.
    const rows=await admin.$transaction(async tx=>{await tx.$queryRaw`SELECT set_config('role','storage_probe_reader',true)`;return tx.$queryRaw`SELECT value FROM public.synthetic_storage_boundary WHERE value='synthetic-reader-control'`;});
    assert.equal(rows.length,1);
    pending=actor.$transaction(async tx=>{
     actorPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
     await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;entered();
     await tx.$executeRawUnsafe(mutation);
    },{maxWait:5000,timeout:10000}).then(()=>{committed=true;});void pending.catch(()=>{});
    await started;let waiting=false;
    for(let i=0;i<100;i++){
     waiting=(await admin.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=${actorPid} AND NOT l.granted AND n.nspname='pg_catalog'
      AND c.relname IN ('pg_attribute','pg_proc','pg_class','pg_authid','pg_auth_members','pg_database','pg_namespace','pg_policy')) AS waiting`)[0].waiting;
     if(waiting)break;await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(waiting,true,label);assert.equal(committed,false,label);return label;
   },options);
   assert.equal(result.value,label);assert.equal(result.evidence.listedCatalogueChangesExcludedDuringCallback,true);
   assert.equal(result.evidence.providerManagementActorsExcluded,false);await pending;assert.equal(committed,true,label);
  }finally{if(pending)await pending.catch(()=>{});await admin.$executeRawUnsafe(restore);}
 }
 // Existing DCL must finish before any successful interval/callback begins.
 let release,started;const ready=new Promise(r=>{started=r;}),hold=new Promise(r=>{release=r;});
 const prior=actor.$transaction(async tx=>{await tx.$executeRaw`GRANT UPDATE ON public.synthetic_storage_boundary TO storage_probe_reader`;started();await hold;throw new Error('synthetic rollback');},{timeout:10000});void prior.catch(()=>{});
 await ready;let callbacks=0;
 try{await assert.rejects(service.runCaptureRoleWindow(async()=>{callbacks++;},options));assert.equal(callbacks,0);}
 finally{release();await assert.rejects(prior,/synthetic rollback/);}
 assert.equal(typeof prepareCatalogueTransaction,'function');prepareCatalogueTransaction();
 try{
  const [prepared]=await admin.$queryRaw`SELECT count(*)::integer AS total FROM pg_locks WHERE locktype='transactionid' AND mode='ExclusiveLock' AND granted AND pid IS NULL`;
  assert.ok(prepared.total>0);let preparedCalls=0;
  await assert.rejects(service.runCaptureRoleWindow(async()=>{preparedCalls++;},options));assert.equal(preparedCalls,0);
 }finally{await admin.$executeRaw`ROLLBACK PREPARED 'synthetic-catalogue-grant'`;}
 // Cancellation, real deadline and loss of the actual lock-holding connection.
 for(const mode of ['cancel','expiry','connection-loss','callback-error']){
  const controller=new AbortController();let pid,observedSignal;
  await assert.rejects(service.runCaptureRoleWindow(async(_boundary,signal)=>{
   observedSignal=signal;
   const rows=await admin.$queryRaw`SELECT pid FROM pg_locks WHERE relation='pg_catalog.pg_authid'::regclass AND mode='ShareLock' AND granted`;
   assert.equal(rows.length,1);pid=rows[0].pid;
   if(mode==='cancel')controller.abort();
   if(mode==='connection-loss')assert.equal((await admin.$queryRaw`SELECT pg_terminate_backend(${pid}) AS terminated`)[0].terminated,true);
   if(mode==='callback-error')throw new Error('synthetic callback refusal');
   await new Promise(()=>{});
  },{maxWindowMs:1000},controller.signal));
  assert.equal(observedSignal?.aborted,true);
  assert.equal((await admin.$queryRaw`SELECT count(*)::integer AS total FROM pg_locks WHERE pid=${pid} AND mode='ShareLock' AND granted`)[0].total,0);
 }
 const final=await service.runCaptureRoleWindow(async()=>true,options);assert.equal(final.value,true);
 console.log('PASS native SQL capture privilege window: nine concurrent DCL/DDL actors wait until release, prior uncommitted and prepared DCL plus insufficient lock authority refuse before callback; cancellation, real expiry, holder termination and callback failure discard and release; no provider/global-authority claim');
}
