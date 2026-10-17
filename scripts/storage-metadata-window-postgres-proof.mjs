import assert from 'node:assert/strict';
import {ManagedStorageMetadataWindow} from '../apps/api/dist/services/managed-storage-metadata-window.js';
const unresolved=/^Error: Managed storage metadata window is unresolved; discard the candidate result$/;
export async function proveStorageMetadataWindow({admin,fencer,actor,capture,config}){
 await admin.$executeRaw`CREATE TABLE public.synthetic_window_second(value text PRIMARY KEY)`;
 await admin.$executeRaw`GRANT SELECT ON public.synthetic_window_second TO storage_probe_capture`;
 const [second]=await admin.$queryRaw`SELECT oid::text AS oid FROM pg_class WHERE oid='public.synthetic_window_second'::regclass`;
 const registry={database:config.database,databaseOid:config.databaseOid,observer:config.observer,
  relations:[{schema:'public',name:'synthetic_window_second',oid:second.oid},...config.relations],maxWindowMs:5000};
 const window=new ManagedStorageMetadataWindow(fencer,registry);
 const waitFor=async(pid,relationOid,mode)=>{
  for(let i=0;i<150;i++){
   const [state]=await admin.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid}
    AND relation=${relationOid}::oid AND mode=${mode} AND NOT granted) AS waiting`;
   if(state.waiting)return;await new Promise(r=>setTimeout(r,10));
  }throw new Error('Expected exact pending relation lock was not observed');
 };
 let releasePrior,priorEntered;
 const priorStarted=new Promise(r=>{priorEntered=r;}),priorRelease=new Promise(r=>{releasePrior=r;});
 const prior=actor.$transaction(async tx=>{
  await tx.$executeRaw`INSERT INTO public.synthetic_storage_boundary VALUES ('window-prior-committed')`;
  priorEntered();await priorRelease;
 },{timeout:15000});void prior.catch(()=>{});await priorStarted;
 const [{pid}]=await fencer.$queryRaw`SELECT pg_backend_pid() AS pid`;
 let callbackEntered=false,blockedWrite,callbackSignal;
 const active=window.run(async signal=>{
  callbackSignal=signal;callbackEntered=true;
  // This row committed while the window waited: a pre-lock RR snapshot would miss it.
  assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_storage_boundary WHERE value='window-prior-committed'`)[0].n,1);
  let writerEntered,writerPid;const writerStarted=new Promise(r=>{writerEntered=r;});
  blockedWrite=actor.$transaction(async tx=>{
   writerPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
   await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;writerEntered();
   await tx.$executeRaw`INSERT INTO public.synthetic_window_second VALUES ('window-writer-after-release')`;
  },{timeout:15000});void blockedWrite.catch(()=>{});
  await writerStarted;await waitFor(writerPid,second.oid,'RowExclusiveLock');
  assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_window_second`)[0].n,0);
  assert.equal(signal.aborted,false);return 'synthetic-capture-result';
 });void active.catch(()=>{});
 try{await waitFor(pid,config.relations[0].oid,'ShareLock');assert.equal(callbackEntered,false);}
 finally{releasePrior();}await prior;
 const result=await active;await blockedWrite;
 assert.equal(result.value,'synthetic-capture-result');assert.equal(callbackSignal.aborted,true);
 assert.equal(result.evidence.metadataWindowCompleted,true);assert.equal(result.evidence.windowStillHeld,false);
 assert.equal(result.evidence.wholeBackendQuiesced,false);assert.equal(result.evidence.objectBytesFenced,false);
 const originalDigest=window.configurationDigest();
 result.evidence.observer.name='invalid;role';result.evidence.relations[0].name='invalid;relation';
 assert.equal(window.configurationDigest(),originalDigest);
 assert.equal((await window.run(async()=> 'safe-after-returned-evidence-mutation')).value,'safe-after-returned-evidence-mutation');
 assert.equal(result.evidence.relations.length,2);assert.match(result.evidence.observationDigest,/^[a-f0-9]{64}$/);
 assert.equal((await capture.$queryRaw`SELECT count(*)::integer AS n FROM public.synthetic_window_second`)[0].n,1);

 let heldRelease,heldEntered;
 const heldStarted=new Promise(r=>{heldEntered=r;}),heldDone=new Promise(r=>{heldRelease=r;});
 const held=actor.$transaction(async tx=>{
  await tx.$executeRaw`INSERT INTO public.synthetic_window_second VALUES ('lock-timeout-writer')`;
  heldEntered();await heldDone;
 },{timeout:15000});void held.catch(()=>{});await heldStarted;
 let lockTimeoutEntered=false;
 try{await assert.rejects(()=>window.run(async()=>{lockTimeoutEntered=true;}),unresolved);}
 finally{heldRelease();}await held;assert.equal(lockTimeoutEntered,false);
 const cancelled=new AbortController();cancelled.abort();let cancelledEntered=false;
 await assert.rejects(()=>window.run(async()=>{cancelledEntered=true;},cancelled.signal),unresolved);
 assert.equal(cancelledEntered,false);
 let liveAbortSignal;const liveAbort=new AbortController();
 await assert.rejects(()=>window.run(async signal=>{
  liveAbortSignal=signal;liveAbort.abort();await new Promise(resolve=>setTimeout(resolve,1));return 'cancelled';
 },liveAbort.signal),unresolved);assert.equal(liveAbortSignal.aborted,true);

 let thrownSignal;
 await assert.rejects(()=>window.run(async signal=>{thrownSignal=signal;throw new Error('PRIVATE-capture-data');}),unresolved);
 assert.equal(thrownSignal.aborted,true);
 await actor.$executeRaw`INSERT INTO public.synthetic_window_second VALUES ('after-callback-failure')`;
 let expiredSignal,releaseExpired;
 const expired=new Promise(r=>{releaseExpired=r;});
 await assert.rejects(()=>new ManagedStorageMetadataWindow(fencer,{...registry,maxWindowMs:100}).run(async signal=>{
  expiredSignal=signal;await expired;return 'ignored-late-result';
 }),unresolved);assert.equal(expiredSignal.aborted,true);releaseExpired();
 await actor.$executeRaw`INSERT INTO public.synthetic_window_second VALUES ('after-window-expiry')`;

 const lossPid=(await fencer.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
 let lossSignal;
 await assert.rejects(()=>window.run(async signal=>{
  lossSignal=signal;
  assert.equal((await admin.$queryRaw`SELECT pg_terminate_backend(${lossPid}) AS stopped`)[0].stopped,true);
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return 'discard-on-connection-loss';
 }),unresolved);assert.equal(lossSignal.aborted,true);
 await actor.$executeRaw`INSERT INTO public.synthetic_window_second VALUES ('after-window-connection-loss')`;

 let ackCallbackCount=0;
 const unknownAck={$transaction:async(fn,options)=>{await fencer.$transaction(fn,options);throw new Error('PRIVATE-commit-ACK-unknown');}};
 await assert.rejects(()=>new ManagedStorageMetadataWindow(unknownAck,registry).run(async()=>{ackCallbackCount++;return 'unacknowledged';}),unresolved);
 assert.equal(ackCallbackCount,1); // No replay, fallback or manufactured successful receipt.
 let wrongIdentityEntered=false;
 await assert.rejects(()=>new ManagedStorageMetadataWindow(fencer,{...registry,databaseOid:'1'}).run(async()=>{wrongIdentityEntered=true;}),unresolved);
 assert.equal(wrongIdentityEntered,false);
 console.log('PASS native guarded metadata window: both-table locks drain prior commit before fresh reads; writer waits; callback failure, expiry, session loss, identity mismatch lock timeout, cancellation, evidence mutation and unknown ACK discard unsafe results and release locks');
}
