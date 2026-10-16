import {createHash} from 'node:crypto';
import {Prisma,type PrismaClient} from '@prisma/client';
import {z} from 'zod';
const name=z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const oid=z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value=>Number(value)<=4294967295);
const principal=z.object({name,oid}).strict();
const configuration=z.object({database:name,databaseOid:oid,maintenance:principal,
 writers:z.array(principal).min(1).max(16),custodians:z.array(principal).min(1).max(16)}).strict().superRefine((value,ctx)=>{
 const all=[...value.writers,...value.custodians];
 if(new Set(all.map(p=>p.name)).size!==all.length||new Set(all.map(p=>p.oid)).size!==all.length
  ||!value.custodians.some(p=>p.name===value.maintenance.name&&p.oid===value.maintenance.oid)
  ||value.writers.some(p=>p.name==='postgres'||p.name==='rdsadmin'||p.name.startsWith('pg_')||p.name.startsWith('supabase_')))ctx.addIssue({code:'custom',message:'Invalid managed principal boundary'});
});
type Configuration=z.infer<typeof configuration>;
const role=z.object({name,oid,canLogin:z.boolean(),superuser:z.boolean(),createRole:z.boolean(),createDb:z.boolean(),
 replication:z.boolean(),bypassRls:z.boolean()}).strict();
const identity=z.object({database:name,databaseOid:oid,currentRole:name,sessionRole:name,recovery:z.boolean(),durable:z.boolean(),encrypted:z.boolean(),
 observedAt:z.string().min(1).max(80)}).strict();
const session=z.object({pid:z.number().int().positive(),roleOid:oid,databaseOid:oid.nullable(),backendStart:z.string().min(1).max(80)}).strict();
/** Internal privileged maintenance primitive, never an application route. Caller
 * supplies a separately trusted database/principal registry and verified TLS
 * connection. Closing roles is cluster-wide. Custodians remain trusted writers.
 * This does not suspend provider jobs, fence physical hosts, rotate credentials,
 * reconcile history, perform migration or authorise reopening. No reopen API. */
export class ManagedDatabaseWriterFence {
 private readonly config:Configuration;
 constructor(private readonly prisma:PrismaClient,raw:unknown){this.config=configuration.parse(raw);}
 configurationDigest(){return createHash('sha256').update(JSON.stringify(this.config)).digest('hex');}
 private async transaction<T>(fn:(tx:Prisma.TransactionClient)=>Promise<T>) {
  return this.prisma.$transaction(async tx=>{
   await tx.$executeRaw`SET LOCAL synchronous_commit=on`;
   await tx.$executeRaw`SET LOCAL statement_timeout='1500ms'`;
   await tx.$executeRaw`SET LOCAL lock_timeout='1000ms'`;
   return fn(tx);
  },{isolationLevel:'ReadCommitted',maxWait:5000,timeout:30000});
 }
 private async read(tx:Prisma.TransactionClient) {
  const c=this.config;
  const result=await tx.$queryRaw<Array<unknown>>`SELECT current_database()::text AS database,d.oid::text AS "databaseOid",
   current_user::text AS "currentRole",session_user::text AS "sessionRole",pg_is_in_recovery() AS recovery,
   (current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AND current_setting('synchronous_commit')='on') AS durable,
   EXISTS(SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS encrypted,
   clock_timestamp()::text AS "observedAt" FROM pg_database d WHERE d.datname=current_database()`;
  if(result.length!==1)throw new Error();const actual=identity.parse(result[0]);
  if(actual.database!==c.database||actual.databaseOid!==c.databaseOid||actual.currentRole!==c.maintenance.name
   ||actual.sessionRole!==c.maintenance.name||actual.recovery||!actual.durable||!actual.encrypted)throw new Error();
  const configured=[...c.writers,...c.custodians],names=configured.map(p=>p.name),writers=c.writers.map(p=>p.oid);
  const roles=z.array(role).parse(await tx.$queryRaw`SELECT rolname::text AS name,oid::text AS oid,rolcanlogin AS "canLogin",
   rolsuper AS superuser,rolcreaterole AS "createRole",rolcreatedb AS "createDb",rolreplication AS replication,rolbypassrls AS "bypassRls"
   FROM pg_roles WHERE rolname IN (${Prisma.join(names)}) ORDER BY rolname`);
  if(roles.length!==configured.length||configured.some(p=>!roles.some(r=>r.name===p.name&&r.oid===p.oid)))throw new Error();
  const targets=roles.filter(r=>writers.includes(r.oid));
  if(targets.some(r=>r.superuser||r.createRole||r.createDb||r.replication||r.bypassRls))throw new Error();
  const allowed=[...writers,...c.custodians.map(p=>p.oid)];
  // Membership is intentionally conservative: a LOGIN alias with membership
  // refuses even when one particular INHERIT/SET option is currently disabled.
  const inherited=await tx.$queryRaw<Array<unknown>>`SELECT 1 FROM pg_auth_members
   WHERE member::text IN (${Prisma.join(writers)}) LIMIT 1`;
  const aliases=await tx.$queryRaw<Array<unknown>>`SELECT 1 FROM pg_roles r,pg_roles target
   WHERE target.oid::text IN (${Prisma.join(writers)}) AND r.rolcanlogin AND r.oid::text NOT IN (${Prisma.join(allowed)})
    AND pg_has_role(r.oid,target.oid,'MEMBER') LIMIT 1`;
  const otherDatabase=await tx.$queryRaw<Array<unknown>>`SELECT 1 FROM pg_shdepend dep
   WHERE dep.refclassid='pg_authid'::regclass AND dep.refobjid::text IN (${Prisma.join(writers)})
    AND ((dep.dbid<>0 AND dep.dbid::text<>${c.databaseOid}) OR
     (dep.dbid=0 AND dep.classid='pg_database'::regclass AND dep.objid::text<>${c.databaseOid})) LIMIT 1`;
  const prepared=await tx.$queryRaw<Array<unknown>>`SELECT 1 FROM pg_prepared_xacts
   WHERE owner IN (${Prisma.join(c.writers.map(p=>p.name))}) LIMIT 1`;
  await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text AS cleared`;
  const sessions=z.array(session).max(256).parse(await tx.$queryRaw`SELECT pid,usesysid::text AS "roleOid",datid::text AS "databaseOid",
   backend_start::text AS "backendStart" FROM pg_stat_activity WHERE usesysid::text IN (${Prisma.join(writers)})
    AND pid<>pg_backend_pid() ORDER BY pid LIMIT 257`);
  if(inherited.length||aliases.length||otherDatabase.length||prepared.length||sessions.some(s=>s.databaseOid!==c.databaseOid))throw new Error();
  return{actual,targets,sessions};
 }
 private proof(state:Awaited<ReturnType<ManagedDatabaseWriterFence['read']>>) {
  if(state.targets.some(r=>r.canLogin)||state.sessions.length)throw new Error();
  const facts={database:this.config.database,databaseOid:this.config.databaseOid,
   maintenance:this.config.maintenance,writers:this.config.writers,custodians:this.config.custodians,
   observedAt:state.actual.observedAt,roles:state.targets};
  return{scope:'CONFIGURED_DATABASE_PRINCIPALS_ONLY' as const,databaseWriterPrincipalsClosed:true as const,
   loginRolesClosed:state.targets.length,remainingSessions:0,observationDigest:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
   observedAt:state.actual.observedAt,sourceHostFenced:false as const,providerJobsFenced:false as const,
   wholeBackendQuiesced:false as const,reopeningAuthorised:false as const,actionAuthorized:false as const};
 }
 async observeClosed() {
  try{return await this.transaction(async tx=>this.proof(await this.read(tx)));}
  catch{throw new Error('Managed database writer closure is unverified; keep the maintenance operation unresolved');}
 }
 async close() {
  try {
   // Commit NOLOGIN before terminating sessions. A lost commit response stops
   // here; no automatic compensation can reopen these principals.
   await this.transaction(async tx=>{
    const before=await this.read(tx);
    for(const target of before.targets){
     if(target.canLogin)await tx.$executeRaw(Prisma.sql`ALTER ROLE ${Prisma.raw('"'+target.name+'"')} NOLOGIN`);
    }
    const after=await this.read(tx);if(after.targets.some(r=>r.canLogin))throw new Error();
   });
   await this.transaction(async tx=>{
    const state=await this.read(tx);if(state.targets.some(r=>r.canLogin))throw new Error();
    for(const previous of state.sessions){
     // PID reuse cannot select an unrelated backend: match role, database and
     // the exact server-side timestamp, never a rounded JavaScript Date.
     const result=await tx.$queryRaw<Array<{terminated:boolean}>>`SELECT pg_terminate_backend(pid,1000) AS terminated
      FROM pg_stat_activity WHERE pid=${previous.pid} AND usesysid::text=${previous.roleOid}
       AND datid::text=${previous.databaseOid} AND backend_start=${previous.backendStart}::timestamptz
       AND pid<>pg_backend_pid()`;
     if(result.length>1||result.some(r=>r.terminated!==true))throw new Error();
    }
   });
   return await this.observeClosed();
  }catch{throw new Error('Managed database writer fence is unresolved; inspect current roles and sessions without reopening them');}
 }
}
