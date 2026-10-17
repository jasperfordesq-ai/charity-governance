import assert from 'node:assert/strict';
import test from 'node:test';
import {ManagedStorageDatabaseInventory} from '../services/managed-storage-database-inventory.js';
const configuration={database:'synthetic_db',databaseOid:'16384',observer:{name:'maintenance',oid:'10'},
 capture:{name:'storage_capture',oid:'16385'},relations:[{schema:'storage',name:'objects',oid:'16386'}]};
test('storage inventory rejects ambiguous or injectable registry before database use',()=>{
 const never={$transaction:async()=>{throw new Error('must not access DB');}};
 for(const change of [{relations:[]},{relations:[...configuration.relations,...configuration.relations]},
  {relations:[{schema:'storage;delete',name:'objects',oid:'16386'}]},{databaseOid:'4294967296'},
  {observer:{name:'maintenance',oid:'0'}},{capture:{name:'other;role',oid:'16385'}},{unknown:true}])
  assert.throws(()=>new ManagedStorageDatabaseInventory(never as never,{...configuration,...change}));
});
test('storage inventory snapshots configuration and sanitises transaction/transport failure',async()=>{
 const cfg=structuredClone(configuration);let called=0;
 const prisma={$transaction:async()=>{called++;throw new Error('PRIVATE-password-or-URL');}};
 const service=new ManagedStorageDatabaseInventory(prisma as never,cfg),digest=service.configurationDigest();
 cfg.capture.name='changed';cfg.relations[0]!.oid='99';
 assert.equal(service.configurationDigest(),digest);
 await assert.rejects(()=>service.observe(),e=>{
  assert.ok(e instanceof Error);assert.equal(e.message,'Managed storage database authority inventory is unverified');
  assert.equal(e.cause,undefined);return true;
 });assert.equal(called,1);
});
test('storage inventory refuses wrong identity, TLS, write transaction and unsupported server before catalogue scan',async()=>{
 const identity={database:'synthetic_db',databaseOid:'16384',currentRole:'maintenance',sessionRole:'maintenance',observerOid:'10',
  encrypted:true,readOnly:true,version:160000,observedAt:'2026-10-17 07:00:00+00'};
 for(const change of [{database:'other'},{databaseOid:'99'},{currentRole:'other'},{sessionRole:'other'},
  {observerOid:'99'},{encrypted:false},{readOnly:false},{version:150000},{version:170000}]){
  let queries=0;const operations:string[]=[];
  const prisma={$transaction:async<T>(fn:(tx:unknown)=>Promise<T>,options:unknown)=>{
   assert.deepEqual(options,{isolationLevel:'RepeatableRead',maxWait:5000,timeout:15000});
   return fn({$executeRaw:async(parts:TemplateStringsArray)=>{operations.push(parts.join(''));return 0;},
    $queryRaw:async()=>{queries++;return[{...identity,...change}];}});
  }};
  await assert.rejects(()=>new ManagedStorageDatabaseInventory(prisma as never,configuration).observe());
  assert.equal(queries,1);assert.equal(operations[0],'SET TRANSACTION READ ONLY');
  assert.ok(operations.includes('SET LOCAL search_path=pg_catalog'));
 }
});
