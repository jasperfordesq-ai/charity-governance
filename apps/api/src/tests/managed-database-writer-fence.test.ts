import assert from 'node:assert/strict';
import test from 'node:test';
import {ManagedDatabaseWriterFence} from '../services/managed-database-writer-fence.js';
const configuration={database:'synthetic_db',databaseOid:'16384',maintenance:{name:'maintenance',oid:'10'},
 writers:[{name:'application_writer',oid:'16385'}],custodians:[{name:'maintenance',oid:'10'}]};
test('writer fence refuses ambiguous, privileged-name, duplicate and cross-boundary configuration before database use',()=>{
 const never={$transaction:async()=>{throw new Error('must not access DB');}};
 for(const change of [{writers:[]},{writers:[{name:'postgres',oid:'16385'}]},{writers:[{name:'pg_signal_backend',oid:'16385'}]},
  {writers:[...configuration.writers,...configuration.writers]},{writers:[{name:'maintenance',oid:'10'}]},
  {writers:[{name:'bad;ALTER ROLE postgres',oid:'16385'}]},{writers:[{name:'application_writer',oid:'0'}]},
  {custodians:[]},{database:'other;db'},{unexpected:true}]) {
  assert.throws(()=>new ManagedDatabaseWriterFence(never as never,{...configuration,...change}));
 }
});
test('writer fence snapshots its trusted configuration and sanitises failed database observations',async()=>{
 const cfg=structuredClone(configuration);let queries=0;
 const prisma={$transaction:async<T>(fn:(tx:unknown)=>Promise<T>)=>fn({$executeRaw:async()=>0,$queryRaw:async()=>{queries++;throw new Error('PRIVATE-PASSWORD-OR-PROVIDER-DETAIL');}})};
 const service=new ManagedDatabaseWriterFence(prisma as never,cfg);cfg.writers[0]!.name='postgres';
 for(const operation of [()=>service.observeClosed(),()=>service.close(),()=>service.observePasswordsInvalidated(),()=>service.invalidatePasswords()])await assert.rejects(operation,error=>{
  assert.ok(error instanceof Error);assert.equal(error.cause,undefined);assert.equal(error.message.includes('PRIVATE-'),false);return true;
 });
 assert.equal(queries,4);
});
