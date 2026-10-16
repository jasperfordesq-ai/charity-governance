import { PrismaClient } from '@prisma/client';
import { toStrictPrismaTlsUrl } from '@charitypilot/shared/prisma-database-url';

const connectionProofSql=`SELECT current_user=$1::text AND session_user=$1::text
  AND current_database()=$2::text AND NOT pg_is_in_recovery()
  AND current_setting('default_transaction_read_only')='off'
  AND EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS safe`;

/** Runtime/ordinary-job connection creation. Public TLS checks are additional to
 * the existing environment validator and full pre/postmigration role gate.
 * Private/local non-TLS profiles retain Prisma's normal lazy constructor.
 */
export async function createApplicationPrismaClient(
  env: NodeJS.ProcessEnv=process.env,
  {createClient=(url?:string)=>url
    ? new PrismaClient({datasources:{db:{url}},log:[],errorFormat:'minimal'})
    : new PrismaClient()}: {createClient?: (url?:string)=>PrismaClient}={},
): Promise<PrismaClient> {
  let client: PrismaClient|undefined;
  try {
    const raw=env.DATABASE_URL;
    let verifiedTls=env.CHARITYPILOT_DEPLOYMENT_MODE==='production';
    if(raw) {
      try {verifiedTls ||= new URL(raw).searchParams.getAll('sslmode').includes('verify-full');}
      catch {if(verifiedTls) throw new Error();}
    }
    if(!verifiedTls) return createClient();
    const transport=toStrictPrismaTlsUrl(raw ?? '');
    const target=new URL(transport);
    client=createClient(transport);
    await client.$connect();
    await client.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_catalog, public, pg_temp');
      const rows=await tx.$queryRawUnsafe<Array<{safe:boolean}>>(connectionProofSql,
        decodeURIComponent(target.username),decodeURIComponent(target.pathname.slice(1)));
      if(!Array.isArray(rows)||rows.length!==1||rows[0]?.safe!==true) throw new Error();
    },{isolationLevel:'RepeatableRead',timeout:15000,maxWait:5000});
    return client;
  } catch {
    try {await client?.$disconnect();} catch { /* No raw driver diagnostics. */ }
    throw new Error('Application database connection verification failed.');
  }
}
