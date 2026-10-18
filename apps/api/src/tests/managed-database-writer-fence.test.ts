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
 for(const operation of [()=>service.observeCompatibility(),()=>service.observeClosed(),()=>service.close(),()=>service.observePasswordsInvalidated(),()=>service.invalidatePasswords()])await assert.rejects(operation,error=>{
  assert.ok(error instanceof Error);assert.equal(error.cause,undefined);assert.equal(error.message.includes('PRIVATE-'),false);return true;
 });
 assert.equal(queries,5);
});

test('maintenance compatibility is read-only, refuses missing privileges and never reads raw passwords',async()=>{
 for(const missing of [null,'alterConfiguredRoles','inspectAllSessions','terminateConfiguredSessions','readPasswordState'] as const){
  const statements:string[]=[];
  const predicates={maintenanceOid:'10',serverVersion:170000,readOnly:true,maintenanceLogin:true,
   alterConfiguredRoles:true,inspectAllSessions:true,terminateConfiguredSessions:true,readPasswordState:true};
  if(missing)predicates[missing]=false;
  const tx={$executeRaw:async(parts:TemplateStringsArray)=>{const sql=parts.join('?');statements.push(sql);assert.ok(sql.startsWith('SET '));return 0;},
   $queryRaw:async(parts:TemplateStringsArray)=>{
    const sql=parts.join('?');statements.push(sql);
    assert.equal(/ALTER ROLE|SELECT\s+pg_terminate_backend\s*\(/i.test(sql),false);
    if(sql.includes('server_version_num'))return[predicates];
    if(sql.includes('current_database()'))return[{database:'synthetic_db',databaseOid:'16384',currentRole:'maintenance',sessionRole:'maintenance',recovery:false,durable:true,encrypted:true,observedAt:'2026-10-18'}];
    if(sql.includes('rolpassword')){assert.ok(sql.includes('rolpassword IS NULL AS invalidated'));return[{name:'application_writer',oid:'16385',invalidated:false}];}
    if(sql.includes('rolcanlogin AS'))return [configuration.writers[0],configuration.maintenance].map(p=>({...p,canLogin:true,superuser:false,createRole:false,createDb:false,replication:false,bypassRls:false}));
    return[];
   }};
  const service=new ManagedDatabaseWriterFence({$transaction:async(fn:(value:unknown)=>Promise<unknown>)=>fn(tx)} as never,configuration);
  const result=await service.observeCompatibility();
  assert.equal(statements[0],'SET TRANSACTION READ ONLY');assert.equal(statements[1],'SET LOCAL search_path=pg_catalog');
  assert.equal(result.requiredCataloguePredicatesObserved,!missing);
  assert.deepEqual(result.missingPredicates,missing?[missing]:[]);
  assert.equal(result.passwordStateReadVerified,!missing);
  assert.equal(result.rolesChanged,false);assert.equal(result.sessionsTerminated,false);assert.equal(result.executionAuthorized,false);
  if(missing)assert.equal(statements.some(sql=>sql.includes('rolpassword IS NULL')),false);
 }
});
