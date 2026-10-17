import assert from 'node:assert/strict';
import test from 'node:test';
import {ManagedStorageMetadataWindow} from '../services/managed-storage-metadata-window.js';
const config={database:'synthetic_db',databaseOid:'16384',observer:{name:'maintenance',oid:'10'},
 relations:[{schema:'storage',name:'objects',oid:'16386'}],maxWindowMs:5000};
const unresolved=/^Error: Managed storage metadata window is unresolved; discard the candidate result$/;
test('metadata window refuses unsafe or ambiguous registry before database access',()=>{
 const never={$transaction:async()=>{throw new Error('must not access DB');}};
 for(const change of [{relations:[]},{relations:[...config.relations,...config.relations]},
  {relations:[{schema:'storage;drop',name:'objects',oid:'16386'}]},{databaseOid:'4294967296'},
  {observer:{name:'bad;role',oid:'10'}},{maxWindowMs:99},{maxWindowMs:3600001},{unexpected:true}])
  assert.throws(()=>new ManagedStorageMetadataWindow(never as never,{...config,...change}));
});
test('metadata window snapshots registry and sanitises failures without retaining raw causes',async()=>{
 const cfg=structuredClone(config);let calls=0;
 const service=new ManagedStorageMetadataWindow({$transaction:async()=>{calls++;throw new Error('PRIVATE-password');}} as never,cfg);
 const digest=service.configurationDigest();cfg.relations[0]!.name='changed';assert.equal(service.configurationDigest(),digest);
 for(let i=0;i<2;i++)await assert.rejects(()=>service.run(async()=> 'unreachable'),e=>{
  assert.ok(e instanceof Error);assert.match(e.toString(),unresolved);assert.equal(e.cause,undefined);return true;
 });assert.equal(calls,2);
});
test('metadata window cancels before SQL and refuses concurrent reentry',async()=>{
 let release:()=>void=()=>{};const done=new Promise<void>(r=>{release=r;});let callbacks=0,queries=0;
 const prisma={$transaction:async<T>(fn:(tx:unknown)=>Promise<T>,options:unknown)=>{
  assert.deepEqual(options,{isolationLevel:'ReadCommitted',maxWait:5000,timeout:35000});
  await done;return fn({$executeRaw:async()=>{queries++;return 0;}});
 }};
 const service=new ManagedStorageMetadataWindow(prisma as never,config),controller=new AbortController();
 const pending=service.run(async()=>{callbacks++;},controller.signal);void pending.catch(()=>{});
 await assert.rejects(()=>service.run(async()=>{callbacks++;}),unresolved);controller.abort();release();
 await assert.rejects(()=>pending,unresolved);assert.equal(callbacks,0);assert.equal(queries,0);
});

function snapshotFixture(exported='00000001-00000002-1'){
 const events:string[]=[];
 const tx={
  $executeRaw:async(query:TemplateStringsArray)=>{events.push(String(query[0]));return 0;},
  $queryRaw:async(query:TemplateStringsArray)=>{
   const text=String(query[0]);events.push(text);
   if(text.includes('pg_export_snapshot'))return[{snapshotId:exported}];
   if(text.includes('FROM pg_database'))return[{database:config.database,databaseOid:config.databaseOid,role:config.observer.name,
    sessionRole:config.observer.name,roleOid:config.observer.oid,pid:123,readOnly:true,encrypted:true,recovery:false,version:160011,observedAt:'2026-10-17 09:00:00+00'}];
   return config.relations.map(r=>({...r,kind:'r',inherited:false,locked:true}));
  }
 };
 return{events,service:new ManagedStorageMetadataWindow({$transaction:async<T>(fn:(tx:unknown)=>Promise<T>)=>fn(tx)} as never,config)};
}
test('exported snapshot is issued after configured locks and is absent from saved evidence',async()=>{
 const f=snapshotFixture(),digest=f.service.configurationDigest();
 const result=await f.service.runWithSnapshot(async(snapshot,signal)=>{
  assert.ok(Object.isFrozen(snapshot));assert.equal(signal.aborted,false);
  assert.equal(snapshot.database,config.database);assert.equal(snapshot.snapshotId,'00000001-00000002-1');
  assert.ok(f.events.findIndex(v=>v.includes('LOCK TABLE'))<f.events.findIndex(v=>v.includes('pg_export_snapshot')));
  return 'actual-consumer-result';
 });
 assert.equal(result.value,'actual-consumer-result');assert.equal(f.service.configurationDigest(),digest);
 assert.equal(result.databaseSnapshot.windowId,result.evidence.windowId);
 assert.equal(result.databaseSnapshot.exporterHeldDuringCallback,true);
 assert.equal(result.databaseSnapshot.importedByConsumerVerified,false);
 assert.equal(result.databaseSnapshot.snapshotStillImportable,false);
 assert.equal(result.databaseSnapshot.nonMvccStateCaptured,false);
 assert.equal(result.databaseSnapshot.actionAuthorized,false);
 assert.match(result.databaseSnapshot.snapshotBindingSha256,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(result.databaseSnapshot).includes('00000001-00000002-1'));
 const ordinary=await f.service.run(async()=>1);assert.equal(ordinary.databaseSnapshot,undefined);
 assert.equal(f.events.filter(v=>v.includes('pg_export_snapshot')).length,1);
});
test('invalid snapshot and consumer failure refuse without creating successful evidence',async()=>{
 for(const id of ['bad; sql','00000001-00000002-1-extra','']){
  let calls=0;await assert.rejects(()=>snapshotFixture(id).service.runWithSnapshot(async()=>{calls++;}),unresolved);assert.equal(calls,0);
 }
 const f=snapshotFixture();await assert.rejects(()=>f.service.runWithSnapshot(async()=>{throw new Error('PRIVATE-consumer-failure');}),unresolved);
 assert.equal((await f.service.run(async()=> 'subsequent-new-window')).value,'subsequent-new-window');
});
test('snapshot consumer cancellation cannot return an admitted result',async()=>{
 const controller=new AbortController(),f=snapshotFixture();
 await assert.rejects(()=>f.service.runWithSnapshot(async(_snapshot,signal)=>{
  controller.abort();assert.equal(signal.aborted,true);return 'discard';
 },controller.signal),unresolved);
});
