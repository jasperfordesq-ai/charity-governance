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

function roleBoundaryFixture(){
 const identity={database:'synthetic_db',databaseOid:'16384',currentRole:'maintenance',sessionRole:'maintenance',observerOid:'10',encrypted:true,readOnly:true,version:160000,observedAt:'2026-10-18 11:00:00+00'};
 const attributes={login:false,superuser:false,createRole:false,createDb:false,replication:false,bypassRls:false,inherit:false};
 const roles=[{...attributes,oid:'10',name:'maintenance',login:true},{...attributes,oid:'16385',name:'storage_capture'}];
 const relations=[{oid:'16386',schema:'storage',name:'objects',ownerOid:'10',kind:'r',rowSecurity:true,forceRowSecurity:true,inherited:false}];
 const privileges={select:true,insert:false,update:false,delete:false,truncate:false,references:false,trigger:false,columnInsert:false,columnUpdate:false,columnReferences:false};
 const grants=roles.map(r=>({...privileges,roleOid:r.oid,relationOid:'16386'}));
 const authority={ownsDatabase:false,ownsSchema:false,ownsRelation:false,ownsRoutine:false,databaseCreate:false,schemaCreate:false,systemDefinerExecute:false};
 const state={roles,relations,memberships:[] as unknown[],grants,definers:[] as unknown[],authority};let queries=0;
 const prisma={$transaction:async<T>(fn:(tx:unknown)=>Promise<T>)=>fn({$executeRaw:async()=>0,$queryRaw:async()=>{
  const rows=[[identity],state.roles,state.relations,state.memberships,state.grants,state.definers,[state.authority]];return rows[queries++];
 }})};
 return{state,service:()=>new ManagedStorageDatabaseInventory(prisma as never,configuration),queries:()=>queries};
}

test('SQL capture-role boundary requires exact SELECT-only NOLOGIN/NOINHERIT role without upgrading provider claims',async()=>{
 const f=roleBoundaryFixture(),result=await f.service().observeCaptureRoleBoundary();assert.equal(f.queries(),7);
 assert.equal(result.configuredCaptureSqlReadOnlyObserved,true);assert.deepEqual(result.capture,configuration.capture);
 for(const key of ['privilegeIntervalHeld','privilegeChangesExcluded','captureCredentialReadOnlyVerified','providerTokenRoleVerified','unfilteredBucketVisibilityVerified','allWritersInventoried','wholeBackendQuiesced','actionAuthorized'] as const)assert.equal(result[key],false);
 assert.match(result.observationDigest,/^[a-f0-9]{64}$/);
});

test('SQL role boundary refuses privilege/ownership/role-switch and definer counterexamples',async()=>{
 for(const key of ['login','superuser','createRole','createDb','replication','bypassRls','inherit'] as const){const f=roleBoundaryFixture();f.state.roles[1]![key]=true;await assert.rejects(f.service().observeCaptureRoleBoundary(),/SQL role boundary is unverified/);}
 for(const key of ['insert','update','delete','truncate','references','trigger','columnInsert','columnUpdate','columnReferences'] as const){const f=roleBoundaryFixture();f.state.grants[1]![key]=true;await assert.rejects(f.service().observeCaptureRoleBoundary());}
 for(const key of ['ownsDatabase','ownsSchema','ownsRelation','ownsRoutine','databaseCreate','schemaCreate','systemDefinerExecute'] as const){const f=roleBoundaryFixture();f.state.authority[key]=true;await assert.rejects(f.service().observeCaptureRoleBoundary());}
 for(const mode of ['membership','definer','owner','no-rls','no-select']){const f=roleBoundaryFixture();
  if(mode==='membership')f.state.memberships.push({roleOid:'10',memberOid:'16385',grantorOid:'10',admin:false,inherit:false,set:true});
  if(mode==='definer')f.state.definers.push({oid:'17000',schema:'public',name:'elevated',ownerOid:'10',executableBy:['16385']});
  if(mode==='owner')f.state.relations[0]!.ownerOid='16385';if(mode==='no-rls')f.state.relations[0]!.rowSecurity=false;if(mode==='no-select')f.state.grants[1]!.select=false;
  await assert.rejects(f.service().observeCaptureRoleBoundary());
 }
});
