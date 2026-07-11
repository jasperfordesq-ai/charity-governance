import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BillingService } from '../../services/billing.service.js';
import { EmailService } from '../../services/email.service.js';
import { StorageService, withReadinessTimeout } from '../../services/storage.service.js';
import { isConfiguredSecret } from '../../utils/env.js';

const READINESS_HEADER = 'x-charitypilot-readiness-key';
const E2E_MARKER_VERSION = 1;
const E2E_MARKER_PURPOSE = 'charitypilot-e2e-disposable';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const E2E_DATABASE_IDENTITY_PROBE_MAX_PER_MINUTE = 10;

interface E2eDatabaseIdentityRow {
  singleton: boolean;
  marker_version: number;
  purpose: string;
  instance_id: string;
  database_name: string;
  session_user: string;
  current_user: string;
  current_schema: string;
  database_comment: string | null;
  role_superuser: boolean;
  role_create_role: boolean;
  role_create_database: boolean;
  role_replication: boolean;
  role_bypass_rls: boolean;
  role_inherit: boolean;
  role_membership_count: number;
  database_owner: string;
  marker_schema_owner: string;
  marker_table_owner: string;
  marker_schema_create: boolean;
  marker_table_mutation: boolean;
}

function readinessKeyDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function timingSafeStringEqual(a: string, b: string): boolean {
  return timingSafeEqual(readinessKeyDigest(a), readinessKeyDigest(b));
}

function hasReadinessAccess(request: FastifyRequest): boolean {
  const configuredKey = process.env.READINESS_API_KEY;
  if (!isConfiguredSecret(configuredKey)) return false;

  const suppliedKey = request.headers[READINESS_HEADER];
  return typeof suppliedKey === 'string' && timingSafeStringEqual(suppliedKey, configuredKey);
}

function readinessDependencyTimeoutMs(): number {
  const configured = Number(process.env.READINESS_DEPENDENCY_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : 3000;
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get(
    '/e2e-database-identity',
    {
      // The managed suite shares one fixed TCP-gateway IP. Keep this safety
      // probe independently bounded so ordinary browser traffic cannot consume
      // the exact binding check needed before and after destructive reset.
      config: {
        rateLimit: {
          max: E2E_DATABASE_IDENTITY_PROBE_MAX_PER_MINUTE,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const configuredInstanceId = process.env.E2E_DATABASE_INSTANCE_ID;
      const enabled =
        process.env.NODE_ENV !== 'production' &&
        process.env.E2E_DATABASE_IDENTITY_PROBE_ENABLED === 'true' &&
        typeof configuredInstanceId === 'string' &&
        UUID_V4_PATTERN.test(configuredInstanceId);

      if (!enabled) {
        return reply.status(404).send({ error: 'Not found', code: 'NOT_FOUND' });
      }
      if (!hasReadinessAccess(request)) {
        return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      try {
        const rows = await app.prisma.$queryRaw<E2eDatabaseIdentityRow[]>`
        SELECT
          marker.singleton,
          marker.marker_version,
          marker.purpose,
          marker.instance_id::text AS instance_id,
          current_database() AS database_name,
          session_user AS session_user,
          current_user AS current_user,
          current_schema() AS current_schema,
          pg_catalog.shobj_description(database.oid, 'pg_database') AS database_comment,
          role.rolsuper AS role_superuser,
          role.rolcreaterole AS role_create_role,
          role.rolcreatedb AS role_create_database,
          role.rolreplication AS role_replication,
          role.rolbypassrls AS role_bypass_rls,
          role.rolinherit AS role_inherit,
          (
            SELECT COUNT(*)::int
            FROM pg_catalog.pg_auth_members AS membership
            WHERE membership.member = role.oid OR membership.roleid = role.oid
          ) AS role_membership_count,
          pg_catalog.pg_get_userbyid(database.datdba) AS database_owner,
          pg_catalog.pg_get_userbyid(marker_schema.nspowner) AS marker_schema_owner,
          pg_catalog.pg_get_userbyid(marker_table.relowner) AS marker_table_owner,
          pg_catalog.has_schema_privilege(current_user, marker_schema.oid, 'CREATE') AS marker_schema_create,
          (
            pg_catalog.has_table_privilege(current_user, marker_table.oid, 'INSERT') OR
            pg_catalog.has_table_privilege(current_user, marker_table.oid, 'UPDATE') OR
            pg_catalog.has_table_privilege(current_user, marker_table.oid, 'DELETE') OR
            pg_catalog.has_table_privilege(current_user, marker_table.oid, 'TRUNCATE') OR
            pg_catalog.has_table_privilege(current_user, marker_table.oid, 'REFERENCES') OR
            pg_catalog.has_table_privilege(current_user, marker_table.oid, 'TRIGGER')
          ) AS marker_table_mutation
        FROM "charitypilot_e2e_guard"."database_identity" AS marker
        JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user
        JOIN pg_catalog.pg_database AS database ON database.datname = current_database()
        JOIN pg_catalog.pg_namespace AS marker_schema
          ON marker_schema.nspname = 'charitypilot_e2e_guard'
        JOIN pg_catalog.pg_class AS marker_table
          ON marker_table.relnamespace = marker_schema.oid
         AND marker_table.relname = 'database_identity'
         AND marker_table.relkind IN ('r', 'p')
        LIMIT 2
        `;
        const marker = rows[0];
        const bound =
          rows.length === 1 &&
          marker?.singleton === true &&
          Number(marker?.marker_version) === E2E_MARKER_VERSION &&
          marker?.purpose === E2E_MARKER_PURPOSE &&
          marker?.instance_id === configuredInstanceId &&
          marker?.database_name === 'charitypilot_e2e_disposable' &&
          marker?.session_user === 'charitypilot_e2e_runner' &&
          marker?.current_user === 'charitypilot_e2e_runner' &&
          marker?.current_schema === 'public' &&
          marker?.database_comment === 'CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1' &&
          marker?.role_superuser === false &&
          marker?.role_create_role === false &&
          marker?.role_create_database === false &&
          marker?.role_replication === false &&
          marker?.role_bypass_rls === false &&
          marker?.role_inherit === false &&
          Number(marker?.role_membership_count) === 0 &&
          marker?.database_owner !== 'charitypilot_e2e_runner' &&
          marker?.marker_schema_owner !== 'charitypilot_e2e_runner' &&
          marker?.marker_table_owner !== 'charitypilot_e2e_runner' &&
          marker?.marker_schema_create === false &&
          marker?.marker_table_mutation === false;
        if (!bound) {
          return reply.status(503).send({ error: 'Database binding unavailable', code: 'DATABASE_BINDING_UNAVAILABLE' });
        }

        return reply.status(200).send({ status: 'bound', instanceId: configuredInstanceId });
      } catch {
        request.log.error('E2E database identity probe failed');
        return reply.status(503).send({ error: 'Database binding unavailable', code: 'DATABASE_BINDING_UNAVAILABLE' });
      }
    },
  );

  app.get('/readiness', async (request, reply) => {
    if (!hasReadinessAccess(request)) {
      return reply.status(401).send({
        error: 'Readiness details require an internal readiness key',
        code: 'READINESS_UNAUTHORIZED',
      });
    }

    const billing = new BillingService(app.prisma);

    let database = false;
    try {
      const result = await withReadinessTimeout(app.prisma.$queryRaw`SELECT 1`, readinessDependencyTimeoutMs());
      database = result !== null;
    } catch (err) {
      request.log.error(err, 'Readiness database check failed');
    }

    let emailConfigured = false;
    try {
      emailConfigured = new EmailService().isConfigured();
    } catch (err) {
      request.log.error(err, 'Readiness email configuration check failed');
    }

    const storage = new StorageService();
    const checks = {
      database,
      billingConfigured: billing.isConfigured(),
      emailConfigured,
      storageConfigured: storage.isConfigured(),
      storageBucketReachable: await storage.verifyBucket(),
    };

    const ready =
      database &&
      checks.billingConfigured &&
      checks.emailConfigured &&
      checks.storageConfigured &&
      checks.storageBucketReachable;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
