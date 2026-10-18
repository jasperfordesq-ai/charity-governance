import {createHash,randomUUID} from 'node:crypto';
import {Prisma,type PrismaClient} from '@prisma/client';
import {z} from 'zod';
const name=z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const oid=z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v=>Number(v)<=4294967295);
const principal=z.object({name,oid}).strict();
const relation=z.object({schema:name,name,oid}).strict();
const configuration=z.object({database:name,databaseOid:oid,observer:principal,capture:principal,
 relations:z.array(relation).min(1).max(16)}).strict().superRefine((c,ctx)=>{
 if(new Set(c.relations.map(r=>r.oid)).size!==c.relations.length
  ||new Set(c.relations.map(r=>`${r.schema}.${r.name}`)).size!==c.relations.length)
  ctx.addIssue({code:'custom',message:'Duplicate relation boundary'});
});
const role=z.object({oid,name:z.string().min(1).max(63),login:z.boolean(),superuser:z.boolean(),
 createRole:z.boolean(),createDb:z.boolean(),replication:z.boolean(),bypassRls:z.boolean(),inherit:z.boolean()}).strict();
const table=z.object({oid,schema:z.string(),name:z.string(),ownerOid:oid,kind:z.string(),
 rowSecurity:z.boolean(),forceRowSecurity:z.boolean(),inherited:z.boolean()}).strict();
const grant=z.object({roleOid:oid,relationOid:oid,select:z.boolean(),insert:z.boolean(),update:z.boolean(),
 delete:z.boolean(),truncate:z.boolean(),references:z.boolean(),trigger:z.boolean(),
 columnInsert:z.boolean(),columnUpdate:z.boolean(),columnReferences:z.boolean()}).strict();
const member=z.object({roleOid:oid,memberOid:oid,grantorOid:oid,admin:z.boolean(),inherit:z.boolean(),set:z.boolean()}).strict();
const definer=z.object({oid,schema:z.string(),name:z.string(),ownerOid:oid,executableBy:z.array(oid).max(256)}).strict();
const captureAuthority=z.object({ownsDatabase:z.boolean(),ownsSchema:z.boolean(),ownsRelation:z.boolean(),ownsRoutine:z.boolean(),databaseCreate:z.boolean(),schemaCreate:z.boolean(),systemDefinerExecute:z.boolean()}).strict();
// Fixed PostgreSQL 16 catalogues covering the predicates below, in OID order.
// These are catalogue locks, not writes or a lock on provider management actors.
const privilegeCatalogues=['pg_attribute','pg_proc','pg_class','pg_authid','pg_auth_members','pg_database','pg_namespace','pg_policy'] as const;
const windowOptions=z.object({maxWindowMs:z.number().int().min(1000).max(30000)}).strict();
const windowFailure=()=>new Error('Managed capture SQL privilege window is unresolved; discard the candidate result');
/** Read-only internal discovery, NOT a permission fence or live operator entry.
 * No role passwords, function bodies, object contents or request claims are read.
 * Caller supplies a separately trusted registry and TLS-verified Prisma client. */
export class ManagedStorageDatabaseInventory {
 private readonly config:z.infer<typeof configuration>;
 private windowRunning=false;
 constructor(private readonly prisma:PrismaClient,raw:unknown){this.config=configuration.parse(raw);}
 configurationDigest(){return createHash('sha256').update(JSON.stringify(this.config)).digest('hex');}
 observe(){return this.inspect(false);}
 async observeCaptureRoleBoundary(){
  try{const observed=await this.inspect(true);if(!observed.captureRoleBoundary)throw new Error();
   const facts={format:1,kind:'MANAGED_CAPTURE_SQL_ROLE_BOUNDARY_V1' as const,configurationDigest:this.configurationDigest(),
    inventoryObservationDigest:observed.observationDigest,capture:observed.capture,relations:observed.relations.map(r=>({schema:r.schema,name:r.name,oid:r.oid})),
    observedAt:observed.identity.observedAt,authority:observed.captureRoleBoundary};
   return{...facts,observationDigest:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
    scope:'CONFIGURED_SQL_ROLE_PREDICATES_ONLY' as const,configuredCaptureSqlReadOnlyObserved:true as const,privilegeIntervalHeld:false as const,privilegeChangesExcluded:false as const,
    providerTokenRoleVerified:false as const,unfilteredBucketVisibilityVerified:false as const,
    captureCredentialReadOnlyVerified:false as const,allWritersInventoried:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};
  }catch{throw new Error('Managed capture SQL role boundary is unverified');}
 }
 /** A bounded, live SQL catalogue interval. No SQL client escapes the callback.
  * System-catalogue lock authority must already exist; no grants are attempted. */
 async runCaptureRoleWindow<T>(capture:(boundary:Readonly<{capture:Readonly<{name:string;oid:string}>;configurationDigest:string}>,signal:AbortSignal)=>Promise<T>,rawOptions:unknown,caller?:AbortSignal){
  const options=windowOptions.parse(rawOptions);
  if(this.windowRunning||typeof capture!=='function'||caller!==undefined&&!(caller instanceof AbortSignal))throw windowFailure();
  this.windowRunning=true;const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  let deadline=0;
  const active=()=>{signal.throwIfAborted();if(deadline&&performance.now()>=deadline)throw windowFailure();};
  try{active();const result=await this.prisma.$transaction(async tx=>{
   await tx.$executeRaw`SET TRANSACTION READ ONLY`;
   await tx.$executeRaw`SET LOCAL search_path=pg_catalog`;
   await tx.$executeRaw`SET LOCAL statement_timeout='1500ms'`;
   await tx.$executeRaw`SET LOCAL lock_timeout='1000ms'`;
   await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout='5s'`;
   // Verify exact configured database/observer and TLS before catalogue locks.
   await this.inspect(false,tx);
   active();
   await tx.$executeRaw`LOCK TABLE ONLY pg_catalog.pg_attribute,pg_catalog.pg_proc,pg_catalog.pg_class,pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_namespace,pg_catalog.pg_policy IN SHARE MODE`;
   // PostgreSQL DCL can close its catalogue relation lock at command end,
   // before COMMIT. Such a writer retains its transaction-ID lock. After the
   // catalogue locks block new DCL, refuse any foreign assigned transaction,
   // including prepared transactions (pid NULL) and other databases because
   // role/database catalogues are shared. A plain MVCC observation misses this.
   const [prior]=z.array(z.object({pending:z.boolean()}).strict()).length(1).parse(await tx.$queryRaw`SELECT EXISTS(
    SELECT 1 FROM pg_locks WHERE locktype='transactionid' AND mode='ExclusiveLock' AND granted
     AND pid IS DISTINCT FROM pg_backend_pid()) AS pending`);
   if(prior!.pending)throw windowFailure();active();
   const check=async(pid?:number)=>{
    active();const [identity]=z.array(z.object({pid:z.number().int().positive(),isolation:z.literal('read committed')}).strict()).length(1).parse(
     await tx.$queryRaw`SELECT pg_backend_pid() AS pid,current_setting('transaction_isolation') AS isolation`);
    if(pid!==undefined&&identity!.pid!==pid)throw windowFailure();
    const locks=z.array(z.object({name:z.string(),oid,shared:z.boolean(),held:z.literal(true)}).strict()).length(privilegeCatalogues.length).parse(await tx.$queryRaw`SELECT c.relname::text AS name,c.oid::text AS oid,c.relisshared AS shared,
     EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='relation' AND l.relation=c.oid
      AND l.database=CASE WHEN c.relisshared THEN 0::oid ELSE ${this.config.databaseOid}::oid END AND l.mode='ShareLock' AND l.granted) AS held
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pg_catalog' AND c.relname IN (${Prisma.join([...privilegeCatalogues])}) ORDER BY c.oid`);
    if(locks.some((v,i)=>v.name!==privilegeCatalogues[i]))throw windowFailure();active();return{pid:identity!.pid,locks};
   };
   const initial=await check(),start=await this.inspect(true,tx);active();
   if(!start.captureRoleBoundary)throw windowFailure();
   deadline=performance.now()+options.maxWindowMs;
   const boundary=Object.freeze({capture:Object.freeze({...this.config.capture}),configurationDigest:this.configurationDigest()});
   let closing=false,heartbeat:ReturnType<typeof setTimeout>|undefined,checking:Promise<void>|undefined;
   const schedule=()=>{heartbeat=setTimeout(()=>{checking=check(initial.pid).then(()=>{if(!closing)schedule();}).catch(()=>controller.abort());},250);};
   const timeout=setTimeout(()=>controller.abort(),options.maxWindowMs);
   let rejectCancelled:(reason:Error)=>void=()=>{};
   const cancelled=new Promise<never>((_,reject)=>{rejectCancelled=reject;});void cancelled.catch(()=>{});
   const stop=()=>rejectCancelled(windowFailure());signal.addEventListener('abort',stop,{once:true});schedule();
   try{
    active();const value=await Promise.race([Promise.resolve().then(()=>{active();return capture(boundary,signal);}),cancelled]);
    active();await check(initial.pid);const end=await this.inspect(true,tx);active();
    if(!end.captureRoleBoundary)throw windowFailure();
    const facts={format:1,kind:'MANAGED_CAPTURE_SQL_PRIVILEGE_WINDOW_V1' as const,windowId:randomUUID(),configurationDigest:this.configurationDigest(),
     database:this.config.database,databaseOid:this.config.databaseOid,capture:{...this.config.capture},backendPid:initial.pid,catalogues:initial.locks,
     startedAt:start.identity.observedAt,finishedAt:end.identity.observedAt,maxWindowMs:options.maxWindowMs};
    return{value,evidence:{...facts,observationDigest:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
     scope:'LISTED_SQL_CATALOGUES_DURING_CALLBACK_ONLY' as const,configuredCaptureSqlReadOnlyObserved:true as const,
     preexistingAssignedTransactionsExcludedAtEntry:true as const,
     listedCatalogueChangesExcludedDuringCallback:true as const,windowStillHeld:false as const,
     providerTokenRoleVerified:false as const,providerManagementActorsExcluded:false as const,unfilteredBucketVisibilityVerified:false as const,
     captureCredentialReadOnlyVerified:false as const,allWritersInventoried:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const}};
   }finally{closing=true;clearTimeout(timeout);clearTimeout(heartbeat);await checking;
    const failed=signal.aborted;signal.removeEventListener('abort',stop);controller.abort();if(failed)throw windowFailure();}
  },{isolationLevel:'ReadCommitted',maxWait:5000,timeout:options.maxWindowMs+30000});
  // Transaction completion is another async boundary; an expired/unknown ACK
  // never releases a successful candidate to the caller.
  if(caller?.aborted||performance.now()>=deadline)throw windowFailure();return result;}
  catch{throw windowFailure();}finally{controller.abort();this.windowRunning=false;}
 }
 private async inspect(requireCaptureBoundary:boolean,within?:Prisma.TransactionClient){
  try{const read=async(tx:Prisma.TransactionClient)=>{
   if(!within){
   await tx.$executeRaw`SET TRANSACTION READ ONLY`;
   await tx.$executeRaw`SET LOCAL search_path=pg_catalog`;
   await tx.$executeRaw`SET LOCAL statement_timeout='2500ms'`;
   }
   const c=this.config;
   const [identity]=z.array(z.object({database:name,databaseOid:oid,currentRole:name,sessionRole:name,
    observerOid:oid,encrypted:z.boolean(),readOnly:z.boolean(),version:z.number().int(),observedAt:z.string()}).strict()).length(1)
    .parse(await tx.$queryRaw`SELECT current_database()::text AS database,d.oid::text AS "databaseOid",
     current_user::text AS "currentRole",session_user::text AS "sessionRole",r.oid::text AS "observerOid",
     EXISTS(SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS encrypted,
     current_setting('transaction_read_only')='on' AS "readOnly",
     current_setting('server_version_num')::integer AS version,clock_timestamp()::text AS "observedAt"
     FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`);
   if(identity.database!==c.database||identity.databaseOid!==c.databaseOid||identity.currentRole!==c.observer.name
    ||identity.sessionRole!==c.observer.name||identity.observerOid!==c.observer.oid||!identity.encrypted
    ||!identity.readOnly||identity.version<160000||identity.version>=170000)throw new Error();
   const roles=z.array(role).max(256).parse(await tx.$queryRaw`SELECT oid::text AS oid,rolname::text AS name,
    rolcanlogin AS login,rolsuper AS superuser,rolcreaterole AS "createRole",rolcreatedb AS "createDb",
    rolreplication AS replication,rolbypassrls AS "bypassRls",rolinherit AS inherit FROM pg_roles ORDER BY oid LIMIT 257`);
   if(!roles.some(r=>r.oid===c.capture.oid&&r.name===c.capture.name))throw new Error();
   const relations=z.array(table).max(16).parse(await tx.$queryRaw`SELECT t.oid::text AS oid,n.nspname::text AS schema,
    t.relname::text AS name,t.relowner::text AS "ownerOid",t.relkind::text AS kind,
    t.relrowsecurity AS "rowSecurity",t.relforcerowsecurity AS "forceRowSecurity",
    EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=t.oid OR i.inhparent=t.oid) AS inherited
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE t.oid::text IN (${Prisma.join(c.relations.map(r=>r.oid))}) ORDER BY t.oid`);
   if(relations.length!==c.relations.length||c.relations.some(r=>!relations.some(t=>t.oid===r.oid
    &&t.schema===r.schema&&t.name===r.name&&t.kind==='r'&&!t.inherited)))throw new Error();
   const memberships=z.array(member).max(512).parse(await tx.$queryRaw`SELECT roleid::text AS "roleOid",
    member::text AS "memberOid",grantor::text AS "grantorOid",admin_option AS admin,
    inherit_option AS inherit,set_option AS set FROM pg_auth_members ORDER BY roleid,member,grantor LIMIT 513`);
   const grants=z.array(grant).max(4096).parse(await tx.$queryRaw`SELECT r.oid::text AS "roleOid",t.oid::text AS "relationOid",
    has_table_privilege(r.oid,t.oid,'SELECT') AS select,has_table_privilege(r.oid,t.oid,'INSERT') AS insert,
    has_table_privilege(r.oid,t.oid,'UPDATE') AS update,has_table_privilege(r.oid,t.oid,'DELETE') AS delete,
    has_table_privilege(r.oid,t.oid,'TRUNCATE') AS truncate,has_table_privilege(r.oid,t.oid,'REFERENCES') AS references,
    has_table_privilege(r.oid,t.oid,'TRIGGER') AS trigger,has_any_column_privilege(r.oid,t.oid,'INSERT') AS "columnInsert",
    has_any_column_privilege(r.oid,t.oid,'UPDATE') AS "columnUpdate",has_any_column_privilege(r.oid,t.oid,'REFERENCES') AS "columnReferences"
    FROM pg_roles r CROSS JOIN pg_class t WHERE t.oid::text IN (${Prisma.join(c.relations.map(r=>r.oid))})
    ORDER BY r.oid,t.oid LIMIT 4097`);
   if(grants.length!==roles.length*relations.length)throw new Error();
   // All non-system definers are included conservatively; no attempt to infer
   // their table dependencies from function text. Never execute these routines.
   const definers=z.array(definer).max(256).parse(await tx.$queryRaw`SELECT p.oid::text AS oid,n.nspname::text AS schema,
    p.proname::text AS name,p.proowner::text AS "ownerOid",ARRAY(SELECT r.oid::text FROM pg_roles r
     WHERE has_function_privilege(r.oid,p.oid,'EXECUTE') ORDER BY r.oid) AS "executableBy"
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef
    AND n.nspname<>'information_schema' AND n.nspname!~'^pg_' ORDER BY p.oid LIMIT 257`);
   let captureRoleBoundary:z.infer<typeof captureAuthority>|undefined;
   if(requireCaptureBoundary){
    const selected=roles.find(r=>r.oid===c.capture.oid&&r.name===c.capture.name)!;
    if(selected.login||selected.superuser||selected.createRole||selected.createDb||selected.replication||selected.bypassRls||selected.inherit
     ||memberships.some(m=>m.memberOid===selected.oid)||relations.some(t=>t.ownerOid===selected.oid||!t.rowSecurity)
     ||definers.some(f=>f.executableBy.includes(selected.oid)))throw new Error();
    const selectedGrants=grants.filter(g=>g.roleOid===selected.oid);
    if(selectedGrants.length!==relations.length||selectedGrants.some(g=>!g.select||g.insert||g.update||g.delete||g.truncate||g.references||g.trigger||g.columnInsert||g.columnUpdate||g.columnReferences))throw new Error();
    const [authority]=z.array(captureAuthority).length(1).parse(await tx.$queryRaw`SELECT
     EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid) AS "ownsDatabase",
     EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid) AS "ownsSchema",
     EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.relowner=r.oid) AS "ownsRelation",
     EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid) AS "ownsRoutine",
     has_database_privilege(r.oid,d.oid,'CREATE') AS "databaseCreate",
     EXISTS(SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(r.oid,n.oid,'CREATE')) AS "schemaCreate",
     EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND (n.nspname='information_schema' OR n.nspname~'^pg_') AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS "systemDefinerExecute"
     FROM pg_roles r,pg_database d WHERE r.oid::text=${c.capture.oid} AND r.rolname=${c.capture.name} AND d.datname=current_database()`);
    if(!authority||Object.values(authority).some(v=>v))throw new Error();captureRoleBoundary=authority;
   }
   const facts={format:1,kind:'MANAGED_STORAGE_DATABASE_AUTHORITY_INVENTORY_V1',configurationDigest:this.configurationDigest(),
    identity,capture:{...c.capture},relations,roles,memberships,grants,definers};
   return{...facts,observationDigest:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
    ...(requireCaptureBoundary?{captureRoleBoundary}:{}),scope:'CONFIGURED_RELATIONS_CATALOGUE_OBSERVATION_ONLY' as const,
    grantsChanged:false as const,functionsExecuted:false as const,metadataWindowHeld:false as const,
    captureCredentialReadOnlyVerified:false as const,allWritersInventoried:false as const,
    wholeBackendQuiesced:false as const,actionAuthorized:false as const};
  };return await (within?read(within):this.prisma.$transaction(read,{isolationLevel:'RepeatableRead',maxWait:5000,timeout:15000}));}
  catch{throw new Error('Managed storage database authority inventory is unverified');}
 }
}
