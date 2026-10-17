import {createHash,randomUUID} from 'node:crypto';
import {Prisma,type PrismaClient} from '@prisma/client';
import {z} from 'zod';
const name=z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const oid=z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v=>Number(v)<=4294967295);
const relation=z.object({schema:name,name,oid}).strict();
const configuration=z.object({database:name,databaseOid:oid,observer:z.object({name,oid}).strict(),
 relations:z.array(relation).min(1).max(16),maxWindowMs:z.number().int().min(100).max(3600000)}).strict()
 .superRefine((c,ctx)=>{if(new Set(c.relations.map(r=>r.oid)).size!==c.relations.length
  ||new Set(c.relations.map(r=>`${r.schema}.${r.name}`)).size!==c.relations.length)
  ctx.addIssue({code:'custom',message:'Duplicate metadata relation'});});
export type ManagedDatabaseSnapshot = Readonly<{snapshotId:string;database:string;databaseOid:string;observerOid:string;backendPid:number}>;
const snapshotId=z.string().regex(/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]+$/).max(80);
const failure=()=>new Error('Managed storage metadata window is unresolved; discard the candidate result');
const identity=z.object({database:name,databaseOid:oid,role:name,sessionRole:name,roleOid:oid,
 pid:z.number().int().positive(),readOnly:z.boolean(),encrypted:z.boolean(),recovery:z.boolean(),
 version:z.number().int(),observedAt:z.string().min(1).max(80)}).strict();
const table=z.object({schema:z.string(),name:z.string(),oid,kind:z.string(),inherited:z.boolean(),locked:z.boolean()}).strict();
/** Internal bounded metadata lock interval, NOT a whole-Storage fence, provider
 * activation or grant change. Snapshot export is explicit; callback never receives SQL/tx.
 * Caller must propagate the supplied cancellation signal to external reads. */
export class ManagedStorageMetadataWindow {
 private readonly config:z.infer<typeof configuration>;
 private running=false;
 constructor(private readonly prisma:PrismaClient,raw:unknown){
  this.config=configuration.parse(raw);this.config.relations.sort((a,b)=>Number(a.oid)-Number(b.oid));
 }
 configurationDigest(){return createHash('sha256').update(JSON.stringify(this.config)).digest('hex');}
 private async check(tx:Prisma.TransactionClient,locked:boolean,pid?:number){
  const c=this.config;
  const [actual]=z.array(identity).length(1).parse(await tx.$queryRaw`SELECT current_database()::text AS database,
   d.oid::text AS "databaseOid",current_user::text AS role,session_user::text AS "sessionRole",r.oid::text AS "roleOid",
   pg_backend_pid() AS pid,current_setting('transaction_read_only')='on' AS "readOnly",
   EXISTS(SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS encrypted,pg_is_in_recovery() AS recovery,
   current_setting('server_version_num')::integer AS version,clock_timestamp()::text AS "observedAt"
   FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`);
  if(actual.database!==c.database||actual.databaseOid!==c.databaseOid||actual.role!==c.observer.name
   ||actual.sessionRole!==c.observer.name||actual.roleOid!==c.observer.oid||!actual.readOnly||!actual.encrypted
   ||actual.recovery||actual.version<160000||actual.version>=170000||(pid!==undefined&&actual.pid!==pid))throw failure();
  const tables=z.array(table).max(16).parse(await tx.$queryRaw`SELECT n.nspname::text AS schema,t.relname::text AS name,
   t.oid::text AS oid,t.relkind::text AS kind,EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=t.oid OR i.inhparent=t.oid) AS inherited,
   EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.database=${c.databaseOid}::oid
    AND l.relation=t.oid AND l.mode='ShareLock' AND l.granted) AS locked
   FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE t.oid::text IN (${Prisma.join(c.relations.map(r=>r.oid))}) ORDER BY t.oid`);
  if(tables.length!==c.relations.length||c.relations.some(r=>!tables.some(t=>t.oid===r.oid&&t.schema===r.schema
   &&t.name===r.name&&t.kind==='r'&&!t.inherited&&(!locked||t.locked))))throw failure();
  return actual;
 }
 async run<T>(capture:(signal:AbortSignal)=>Promise<T>,caller?:AbortSignal){
  return this.execute(capture,false,caller);
 }
 /** Export only after all configured relations are locked. The ephemeral ID is
  * valid only in this callback; no SQL client or replay permission is exposed. */
 async runWithSnapshot<T>(capture:(snapshot:ManagedDatabaseSnapshot,signal:AbortSignal)=>Promise<T>,caller?:AbortSignal){
  if(typeof capture!=='function')throw failure();
  const result=await this.execute((signal,snapshot)=>{if(!snapshot)throw failure();return capture(snapshot,signal);},true,caller);
  if(!result.databaseSnapshot)throw failure();return{...result,databaseSnapshot:result.databaseSnapshot};
 }
 private async execute<T>(capture:(signal:AbortSignal,snapshot?:ManagedDatabaseSnapshot)=>Promise<T>,exportSnapshot:boolean,caller?:AbortSignal){
  if(this.running||typeof capture!=='function'||(caller!==undefined&&!(caller instanceof AbortSignal)))throw failure();
  this.running=true;
  const controller=new AbortController(),signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  try{signal.throwIfAborted();return await this.prisma.$transaction(async tx=>{
   signal.throwIfAborted();await tx.$executeRaw`SET TRANSACTION READ ONLY`;
   await tx.$executeRaw`SET LOCAL search_path=pg_catalog`;
   await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout='15s'`;
   await tx.$executeRaw`SET LOCAL statement_timeout='1500ms'`;await tx.$executeRaw`SET LOCAL lock_timeout='1000ms'`;
   const before=await this.check(tx,false);
   for(const r of this.config.relations){
    signal.throwIfAborted();
    // Identifiers come only from the strict ASCII registry, never caller SQL.
    await tx.$executeRaw(Prisma.sql`LOCK TABLE ONLY ${Prisma.raw('"'+r.schema+'"."'+r.name+'"')} IN SHARE MODE`);
   }
   const start=await this.check(tx,true,before.pid);signal.throwIfAborted();
   let snapshot:ManagedDatabaseSnapshot|undefined;
   if(exportSnapshot){
    const [row]=z.array(z.object({snapshotId}).strict()).length(1).parse(await tx.$queryRaw`SELECT pg_export_snapshot()::text AS "snapshotId"`);
    snapshot=Object.freeze({snapshotId:row!.snapshotId,database:this.config.database,databaseOid:this.config.databaseOid,
     observerOid:start.roleOid,backendPid:start.pid});signal.throwIfAborted();
   }
   let closing=false,heartbeat:ReturnType<typeof setTimeout>|undefined,checking:Promise<void>|undefined;
   const schedule=()=>{heartbeat=setTimeout(()=>{
    checking=this.check(tx,true,start.pid).then(()=>{if(!closing)schedule();}).catch(()=>{controller.abort();});
   },250);};
   const timeout=setTimeout(()=>controller.abort(),this.config.maxWindowMs);
   let rejectCancelled:(reason:Error)=>void=()=>{};
   const cancelled=new Promise<never>((_,reject)=>{rejectCancelled=reject;});void cancelled.catch(()=>{});
   const stop=()=>rejectCancelled(failure());signal.addEventListener('abort',stop,{once:true});schedule();
   try{
    signal.throwIfAborted();
    const candidate=Promise.resolve().then(()=>{signal.throwIfAborted();return capture(signal,snapshot);});
    const value=await Promise.race([candidate,cancelled]);
    const end=await this.check(tx,true,start.pid);signal.throwIfAborted();
    const facts={format:1,kind:'MANAGED_STORAGE_METADATA_WINDOW_V1',windowId:randomUUID(),
     configurationDigest:this.configurationDigest(),database:this.config.database,databaseOid:this.config.databaseOid,
     observer:{...this.config.observer},relations:this.config.relations.map(r=>({...r})),backendPid:start.pid,
     lockMode:'SHARE',transactionReadOnly:true,transactionIsolation:'ReadCommitted',startedAt:start.observedAt,finishedAt:end.observedAt};
    return{value,...(snapshot?{databaseSnapshot:{format:1 as const,kind:'MANAGED_EXPORTED_DATABASE_SNAPSHOT_V1' as const,
     database:snapshot.database,databaseOid:snapshot.databaseOid,observerOid:snapshot.observerOid,backendPid:snapshot.backendPid,
     snapshotBindingSha256:createHash('sha256').update('CHARITYPILOT_MANAGED_EXPORTED_SNAPSHOT_V1\n'+JSON.stringify(snapshot)).digest('hex'),
     configurationDigest:this.configurationDigest(),windowId:facts.windowId,exportedAfterRelationLocks:true as const,
     exporterHeldDuringCallback:true as const,importedByConsumerVerified:false as const,
     snapshotStillImportable:false as const,nonMvccStateCaptured:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const}}:{}),evidence:{...facts,observationDigest:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
     scope:'CONFIGURED_RELATIONS_DURING_CALLBACK_ONLY' as const,metadataWindowCompleted:true as const,
     windowStillHeld:false as const,objectBytesFenced:false as const,allWritersInventoried:false as const,
     wholeBackendQuiesced:false as const,actionAuthorized:false as const}};
   }finally{
    closing=true;clearTimeout(timeout);clearTimeout(heartbeat);await checking;
    const failed=signal.aborted;signal.removeEventListener('abort',stop);controller.abort();
    if(failed)throw failure();
   }
  },{isolationLevel:'ReadCommitted',maxWait:5000,timeout:this.config.maxWindowMs+30000});}
  catch{throw failure();}finally{controller.abort();this.running=false;}
 }
}
