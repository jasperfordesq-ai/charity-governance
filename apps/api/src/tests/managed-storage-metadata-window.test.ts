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
