export const PRODUCTION_RUNTIME_PROTECTED_TABLES = [
  '_prisma_migrations', 'ComplaintRecoveryEnforcement', 'ComplaintHoldRecoveryOutcome',
  'ComplaintRecoveryExecution', 'ComplaintRecoveryOutcome', 'ComplaintRecoveryCancellation',
  'DocumentRecoveryEnforcement', 'DocumentRecoveryExecution', 'DocumentRecoveryOutcome',
  'DocumentBytePermitCandidateBinding', 'DocumentByteExecutionLease', 'DocumentByteProviderAttempt',
  'DocumentByteProviderObservation', 'DocumentBytePrimaryCompletion',
] as const;
export const PRODUCTION_RUNTIME_MAINTENANCE_FUNCTIONS = [
  'ConfluenceCopyRecovery_rows', 'ConfluenceCopyRecovery_replay', 'ConfluenceCopyLedgerRecovery_assert',
  'ConfluenceCopyLedgerRecovery_rows', 'ConfluenceCopyLedgerRecovery_replay',
] as const;

// Metadata uses driver parameters. No URL/password or caller-supplied SQL enters
// this query. Before migration, missing later objects are permitted; once present,
// their privileges must already be safe. After migration all named objects exist.
export const PRODUCTION_RUNTIME_DATABASE_ROLE_SQL = `
WITH expected AS (
  SELECT $1::text AS runtime_role, $2::text AS maintenance_role,
         $3::text AS database_name, $4::boolean AS after_migration
), protected AS (
  SELECT name, to_regclass(format('public.%I', name)) AS relation
  FROM (VALUES ${PRODUCTION_RUNTIME_PROTECTED_TABLES.map(name => `('${name}')`).join(',')}) AS names(name)
), maintenance AS (
  SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN (${PRODUCTION_RUNTIME_MAINTENANCE_FUNCTIONS.map(name => `'${name}'`).join(',')})
)
SELECT EXISTS (
  SELECT 1 FROM expected e JOIN pg_roles r ON r.rolname=e.runtime_role
  JOIN pg_roles owner_role ON owner_role.rolname=e.maintenance_role
  WHERE current_user=e.runtime_role AND session_user=e.runtime_role
    AND current_database()=e.database_name AND r.oid<>owner_role.oid
    AND NOT pg_is_in_recovery()
    AND EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl)
    AND current_setting('default_transaction_read_only')='off'
    AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
    AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND NOT r.rolinherit
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proowner=r.oid)
    AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT has_schema_privilege(r.oid,'public','CREATE')
    AND NOT EXISTS (SELECT 1 FROM protected WHERE
      (e.after_migration AND relation IS NULL) OR
      (relation IS NOT NULL AND has_table_privilege(r.oid,relation,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
    AND NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND has_schema_privilege(r.oid,n.oid,'USAGE') AND has_function_privilege(r.oid,p.oid,'EXECUTE')
        AND NOT coalesce((
          p.oid IN (
            to_regprocedure('public."DocumentByteExecutionLease_claim"(text,text)'),
            to_regprocedure('public."DocumentByteProviderAttempt_start"(text,text)'),
            to_regprocedure('public."DocumentByteProviderObservation_recordAbsent"(text,text,timestamp with time zone)'),
            to_regprocedure('public."DocumentBytePrimaryCompletion_record"(text,text,text,text,text)'))
          AND p.proowner=owner_role.oid
          AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
          AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
            WHERE grantee=0 AND privilege_type='EXECUTE')
        ), false)
    )
    AND (NOT e.after_migration OR ((SELECT count(*) FROM maintenance)=5
      AND (SELECT count(DISTINCT proname) FROM maintenance)=5))
    AND NOT EXISTS (SELECT 1 FROM maintenance p WHERE
      p.prosecdef OR p.proowner<>owner_role.oid
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
      OR has_function_privilege(r.oid,p.oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
        WHERE grantee=0 AND privilege_type='EXECUTE'))
) AS safe`;

interface RuntimeRoleTransaction {
  $executeRawUnsafe(sql: string): Promise<unknown>;
  $queryRawUnsafe<T>(sql: string, ...parameters: unknown[]): Promise<T>;
}
export interface RuntimeRoleProbeClient {
  $transaction<T>(fn: (tx: RuntimeRoleTransaction) => Promise<T>,
    options: { isolationLevel: 'RepeatableRead'; timeout: number; maxWait: number }): Promise<T>;
}
export interface ProductionRuntimeRoleTarget {
  runtimeRole: string;
  maintenanceRole: string;
  database: string;
  phase: 'before-migration' | 'after-migration';
}

/** Read-only catalogue check on a fresh client connected with the runtime URL.
 * Does not provision/reconcile grants, attest provider custody, or prove that
 * a caller actually supplied a fresh client/the reviewed TLS connection URL.
 */
export async function verifyProductionRuntimeDatabaseRole(client: RuntimeRoleProbeClient, target: ProductionRuntimeRoleTarget) {
  try {
    if (!target || !['before-migration','after-migration'].includes(target.phase)
      || !/^[a-z_][a-z0-9_]{0,62}$/u.test(target.runtimeRole)
      || [target.maintenanceRole, target.database].some(value => typeof value !== 'string' || !value
        || Buffer.byteLength(value,'utf8')>63 || /[\x00-\x1f\x7f]/u.test(value))
      || target.runtimeRole===target.maintenanceRole) throw new Error();
    return await client.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_catalog, public, pg_temp');
      const rows = await tx.$queryRawUnsafe<Array<{ safe: boolean }>>(PRODUCTION_RUNTIME_DATABASE_ROLE_SQL,
        target.runtimeRole,target.maintenanceRole,target.database,target.phase==='after-migration');
      if (!Array.isArray(rows) || rows.length!==1 || rows[0]?.safe!==true) throw new Error();
      return { verified: true as const, phase: target.phase };
    }, { isolationLevel: 'RepeatableRead', timeout: 15000, maxWait: 5000 });
  } catch {
    // Driver errors may include connection strings. Do not attach cause/metadata.
    throw new Error('Production runtime database verification failed.');
  }
}
