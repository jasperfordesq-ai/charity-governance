import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ManagedStorageDatabaseInventory} from '../services/managed-storage-database-inventory.js';
import {preflightManagedCaptureWindow} from '../jobs/preflight-managed-capture-window.js';

const configuration={database:'synthetic_db',databaseOid:'16384',observer:{name:'maintenance',oid:'10'},
 capture:{name:'capture_reader',oid:'16385'},relations:[{schema:'public',name:'synthetic_objects',oid:'16386'}]};
const raw={format:1,databaseUrl:'postgresql://maintenance:synthetic-private@db.example/synthetic_db?sslmode=verify-full&target_session_attrs=read-write',
 configuration,expectedConfigurationDigest:new ManagedStorageDatabaseInventory(undefined as never,configuration).configurationDigest()};

test('capture preflight refuses invalid registry, URL and mutation input before connecting',async()=>{
 let connects=0;const create=()=>{connects++;throw new Error('must not connect');};
 for(const change of [{format:2},{apply:true},{expectedConfigurationDigest:'0'.repeat(64)},
  {databaseUrl:raw.databaseUrl.replace('maintenance:','other:')},{databaseUrl:raw.databaseUrl.replace('/synthetic_db','/other')},
  {databaseUrl:raw.databaseUrl.replace('verify-full','disable')},{databaseUrl:raw.databaseUrl+'&sslmode=verify-full'},
  {databaseUrl:raw.databaseUrl.replace('&target_session_attrs=read-write','')},
  {databaseUrl:raw.databaseUrl+'&options=-csearch_path%3Dpublic'},{databaseUrl:'\n'+raw.databaseUrl}]){
  await assert.rejects(preflightManagedCaptureWindow({...raw,...change},create),/Managed capture preflight refused/);
 }
 assert.equal(connects,0);
});

test('capture CLI refuses malformed secret input and extra arguments with fixed output',()=>{
 for(const args of [[],['--stdin'],['--stdin','--apply']]){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../jobs/preflight-managed-capture-window.js',import.meta.url)),...args],
   {input:'{"password":"synthetic-private"',encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.equal(result.stderr,'Managed capture preflight refused; no capture or maintenance actions authorised\n');
 }
});

test('capture preflight reads real service predicates without acquiring locks or upgrading authority',async()=>{
 for(const missing of [false,true]){
  let closed=0;const operations:string[]=[];
  const result=await preflightManagedCaptureWindow(raw,url=>{
   assert.ok(url.includes('sslaccept=strict'));assert.ok(url.includes('connect_timeout=10'));
   return {$disconnect:async()=>{closed++;},$transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn({
    $executeRaw:async(parts:TemplateStringsArray)=>{operations.push(parts.join(''));return 0;},
    $queryRaw:async(parts:TemplateStringsArray)=>{
     if(parts.join('').includes(' AS database,'))return[{database:'synthetic_db',databaseOid:'16384',
      currentRole:'maintenance',sessionRole:'maintenance',observerOid:'10',encrypted:true,readOnly:true,
      version:160000,observedAt:'2026-10-19 14:00:00+00'}];
     return ['pg_attribute','pg_proc','pg_class','pg_authid','pg_auth_members','pg_database','pg_namespace','pg_policy']
      .map((name,i)=>({name,oid:String(1200+i),shared:['pg_authid','pg_auth_members','pg_database'].includes(name),
       update:!(missing&&name==='pg_authid'),delete:false,truncate:false}));
    },
   })} as never;
  });
  assert.equal(closed,1);
  assert.equal(result.status,missing?'ACL_PREDICATES_MISSING':'ACL_PREDICATES_PRESENT');
  assert.deepEqual(result.missingCatalogueLockAclPredicates,missing?['pg_authid']:[]);
  for(const key of ['catalogueLocksAcquired','privilegeWindowHeld','providerCompatibilityVerified','executionAuthorized','actionAuthorized'] as const)
   assert.equal(result[key],false);
  assert.equal(operations[0],'SET TRANSACTION READ ONLY');
  assert.ok(operations.every(sql=>! /LOCK TABLE|ALTER ROLE|CREATE|DELETE|INSERT|UPDATE/.test(sql)));
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private|db.example|databaseUrl/);
 }
});

test('capture preflight redacts provider and cleanup failures without a result',async()=>{
 let closed=0;
 await assert.rejects(preflightManagedCaptureWindow(raw,()=>({$transaction:async()=>{throw new Error('PRIVATE provider');},
  $disconnect:async()=>{closed++;throw new Error('PRIVATE cleanup');}} as never)),
  error=>error instanceof Error&&!error.message.includes('PRIVATE')&&error.cause===undefined);
 assert.equal(closed,1);
});
