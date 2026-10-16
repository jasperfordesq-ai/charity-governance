import { Prisma, PrismaClient } from '@prisma/client';
import { toStrictPrismaTlsUrl } from '@charitypilot/shared/prisma-database-url';

const connectionProofSql = (role: string, database: string) => Prisma.sql`SELECT current_user=${role}::text AND session_user=${role}::text
  AND current_database()=${database}::text AND NOT pg_is_in_recovery()
  AND current_setting('default_transaction_read_only')='off'
  AND EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS safe`;

// The existing blue-green private VM deliberately uses an unpublished, same-host
// db service without TLS (see .env.bluegreen.private-vm.example). Its legacy
// verify-full URL passed validation but Prisma did not enforce that mode. Keep
// that exact private profile operational; never treat it as verified TLS or let
// an explicitly declared public-production mode enter this compatibility path.
function isLegacyPrivateVmDatabase(env: NodeJS.ProcessEnv): boolean {
  if (env.CHARITYPILOT_DEPLOYMENT_MODE !== undefined && env.CHARITYPILOT_DEPLOYMENT_MODE !== '') return false;
  if (env.NODE_ENV !== 'production' || env.CHARITYPILOT_TENANCY !== 'multi'
    || env.CHARITYPILOT_REGISTRATION !== 'closed' || env.CHARITYPILOT_EMAIL_DELIVERY !== 'manual-link'
    || env.CHARITYPILOT_BILLING !== 'none' || env.CHARITYPILOT_ERROR_ALERTS !== 'none'
    || env.DOCUMENT_STORAGE_DRIVER !== 'local') return false;
  try {
    const origin = env.CHARITYPILOT_CANONICAL_API_ORIGIN;
    if (!origin) return false;
    const front = new URL(origin);
    if (front.protocol !== 'https:' || front.origin !== origin || front.port
      || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.ts\.net$/u.test(front.hostname)
      || [env.FRONTEND_URL, env.NEXT_PUBLIC_API_URL, env.CHARITYPILOT_CANONICAL_WEB_ORIGIN]
        .some(value => value !== origin)) return false;
    const db = new URL(env.DATABASE_URL ?? '');
    return ['postgresql:', 'postgres:'].includes(db.protocol) && db.hostname === 'db'
      && (db.port === '' || db.port === '5432') && !db.hash
      && db.searchParams.size === 2 && db.searchParams.get('sslmode') === 'verify-full'
      && db.searchParams.get('target_session_attrs') === 'read-write';
  } catch { return false; }
}

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
    if(!verifiedTls || isLegacyPrivateVmDatabase(env)) return createClient();
    const transport=toStrictPrismaTlsUrl(raw ?? '');
    const target=new URL(transport);
    client=createClient(transport);
    await client.$connect();
    await client.$transaction(async tx=>{
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL search_path = pg_catalog, public, pg_temp`;
      const rows=await tx.$queryRaw<Array<{safe:boolean}>>(connectionProofSql(
        decodeURIComponent(target.username),decodeURIComponent(target.pathname.slice(1))));
      if(!Array.isArray(rows)||rows.length!==1||rows[0]?.safe!==true) throw new Error();
    },{isolationLevel:'RepeatableRead',timeout:15000,maxWait:5000});
    return client;
  } catch {
    try {await client?.$disconnect();} catch { /* No raw driver diagnostics. */ }
    throw new Error('Application database connection verification failed.');
  }
}
