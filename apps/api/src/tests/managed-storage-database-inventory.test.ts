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
 const catalogues=['pg_attribute','pg_proc','pg_class','pg_authid','pg_auth_members','pg_database','pg_namespace','pg_policy'].map((name,i)=>({name,oid:String(1200+i),shared:['pg_authid','pg_auth_members','pg_database'].includes(name),held:true}));
 const state={identity,roles,relations,memberships:[] as unknown[],grants,definers:[] as unknown[],authority,catalogues,lockDenied:false,commitDelay:0};let queries=0;
 const operations:string[]=[];
 const prisma={$transaction:async<T>(fn:(tx:unknown)=>Promise<T>)=>{const result=await fn({$executeRaw:async(parts:TemplateStringsArray)=>{
  const sql=parts.join('');operations.push(sql);if(state.lockDenied&&sql.startsWith('LOCK TABLE'))throw new Error('private permission detail');return 0;
 },$queryRaw:async(parts:TemplateStringsArray)=>{
  queries++;const sql=parts.join('');
  if(sql.includes('transaction_isolation'))return[{pid:101,isolation:'read committed'}];
  if(sql.includes("l.mode='ShareLock'"))return state.catalogues;
  if(sql.includes(' AS database,'))return[state.identity];
  if(sql.includes('rolcanlogin'))return state.roles;
  if(sql.includes('ownsDatabase'))return[state.authority];
  if(sql.includes('t.relowner'))return state.relations;
  if(sql.includes('FROM pg_auth_members ORDER'))return state.memberships;
  if(sql.includes('has_any_column_privilege'))return state.grants;
  if(sql.includes('ARRAY(SELECT r.oid'))return state.definers;
  if(sql.includes('ownsDatabase'))return[state.authority];throw new Error('Unexpected fixture query');
 }});if(state.commitDelay)await new Promise(r=>setTimeout(r,state.commitDelay));return result;}};
 return{state,operations,service:()=>new ManagedStorageDatabaseInventory(prisma as never,configuration),queries:()=>queries};
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

test('SQL privilege window pins all eight catalogue locks, immutable role identity and bounded evidence',async()=>{
 const f=roleBoundaryFixture(),service=f.service();let called=0,seenSignal:AbortSignal|undefined;
 const result=await service.runCaptureRoleWindow(async(boundary,signal)=>{
  called++;seenSignal=signal;assert.deepEqual(boundary.capture,configuration.capture);assert.equal(Object.isFrozen(boundary),true);assert.equal(Object.isFrozen(boundary.capture),true);
  assert.equal('prisma' in boundary,false);assert.equal(signal.aborted,false);return 'synthetic-result';
 },{maxWindowMs:1000});
 assert.equal(called,1);assert.equal(result.value,'synthetic-result');assert.equal(seenSignal?.aborted,true);
 assert.equal(result.evidence.catalogues.length,8);assert.equal(result.evidence.listedCatalogueChangesExcludedDuringCallback,true);assert.equal(result.evidence.windowStillHeld,false);
 for(const key of ['providerTokenRoleVerified','providerManagementActorsExcluded','unfilteredBucketVisibilityVerified','captureCredentialReadOnlyVerified','allWritersInventoried','wholeBackendQuiesced','actionAuthorized'] as const)assert.equal(result.evidence[key],false);
 assert.match(result.evidence.observationDigest,/^[a-f0-9]{64}$/);assert.ok(f.operations.some(v=>v.startsWith('LOCK TABLE ONLY pg_catalog.pg_attribute')));
});

test('SQL privilege window refuses absent locks, insufficient authority and unsafe identity before capture',async()=>{
 for(const mode of ['missing','not-held','wrong-name','denied','wrong-database','wrong-tls','write-grant']){
  const f=roleBoundaryFixture();let called=0;
  if(mode==='missing')f.state.catalogues.pop();if(mode==='not-held')f.state.catalogues[0]!.held=false;
  if(mode==='wrong-name')f.state.catalogues[0]!.name='pg_type';if(mode==='denied')f.state.lockDenied=true;
  if(mode==='wrong-database')f.state.identity.databaseOid='1';if(mode==='wrong-tls')f.state.identity.encrypted=false;
  if(mode==='write-grant')f.state.grants[1]!.update=true;
  await assert.rejects(f.service().runCaptureRoleWindow(async()=>{called++;},{maxWindowMs:1000}),/^Error: Managed capture SQL privilege window is unresolved; discard the candidate result$/);assert.equal(called,0);
 }
});

test('SQL privilege window aborts stalled work on caller cancellation, lost locks and expiry',{timeout:5000},async()=>{
 for(const mode of ['cancel','lost-lock','expiry']){
  const f=roleBoundaryFixture(),controller=new AbortController();let entered=false,aborted=false;
  await assert.rejects(f.service().runCaptureRoleWindow(async(_boundary,signal)=>{
   entered=true;signal.addEventListener('abort',()=>{aborted=true;},{once:true});
   if(mode==='cancel')controller.abort();if(mode==='lost-lock')f.state.catalogues[0]!.held=false;
   await new Promise(()=>{});
  },{maxWindowMs:1000},controller.signal));assert.equal(entered,true);assert.equal(aborted,true);
  f.state.catalogues[0]!.held=true;assert.equal((await f.service().observeCaptureRoleBoundary()).configuredCaptureSqlReadOnlyObserved,true);
 }
});

test('SQL privilege window refuses callback failure, concurrent use and late transaction ACK',{timeout:4000},async()=>{
 const f=roleBoundaryFixture(),service=f.service();await assert.rejects(service.runCaptureRoleWindow(async()=>{throw new Error('private callback detail');},{maxWindowMs:1000}),/SQL privilege window is unresolved/);
 const result=await service.runCaptureRoleWindow(async()=>{await assert.rejects(service.runCaptureRoleWindow(async()=>{}, {maxWindowMs:1000}));return true;},{maxWindowMs:1000});assert.equal(result.value,true);
 f.state.commitDelay=1100;await assert.rejects(service.runCaptureRoleWindow(async()=>true,{maxWindowMs:1000}));
 for(const options of [{maxWindowMs:0},{maxWindowMs:30001},{maxWindowMs:1000,unknown:true}])await assert.rejects(service.runCaptureRoleWindow(async()=>{},options));
});
