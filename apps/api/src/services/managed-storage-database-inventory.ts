import {createHash} from 'node:crypto';
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
/** Read-only internal discovery, NOT a permission fence or live operator entry.
 * No role passwords, function bodies, object contents or request claims are read.
 * Caller supplies a separately trusted registry and TLS-verified Prisma client. */
export class ManagedStorageDatabaseInventory {
 private readonly config:z.infer<typeof configuration>;
 constructor(private readonly prisma:PrismaClient,raw:unknown){this.config=configuration.parse(raw);}
 configurationDigest(){return createHash('sha256').update(JSON.stringify(this.config)).digest('hex');}
 async observe(){
  try{return await this.prisma.$transaction(async tx=>{
   await tx.$executeRaw`SET TRANSACTION READ ONLY`;
   await tx.$executeRaw`SET LOCAL search_path=pg_catalog`;
   await tx.$executeRaw`SET LOCAL statement_timeout='2500ms'`;
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
   const facts={format:1,kind:'MANAGED_STORAGE_DATABASE_AUTHORITY_INVENTORY_V1',configurationDigest:this.configurationDigest(),
    identity,capture:{...c.capture},relations,roles,memberships,grants,definers};
   return{...facts,observationDigest:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
    scope:'CONFIGURED_RELATIONS_CATALOGUE_OBSERVATION_ONLY' as const,
    grantsChanged:false as const,functionsExecuted:false as const,metadataWindowHeld:false as const,
    captureCredentialReadOnlyVerified:false as const,allWritersInventoried:false as const,
    wholeBackendQuiesced:false as const,actionAuthorized:false as const};
  },{isolationLevel:'RepeatableRead',maxWait:5000,timeout:15000});}
  catch{throw new Error('Managed storage database authority inventory is unverified');}
 }
}
