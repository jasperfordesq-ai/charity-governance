"use strict";

const { isIP } = require("node:net");

const DATABASE_SAFETY_CONTRACT = Object.freeze({
  executionMode: "local-disposable",
  remoteExecutionMode: "remote-disposable",
  resetConfirmation: "DELETE_ONLY_CHARITYPILOT_DISPOSABLE_E2E",
  remoteResetOverride:
    "I_UNDERSTAND_REMOTE_RESET_DELETES_ONLY_A_PROVEN_CHARITYPILOT_DISPOSABLE_E2E_DATABASE",
  databaseHost: "127.0.0.1",
  databasePort: 55434,
  databaseName: "charitypilot_e2e_disposable",
  databaseUser: "charitypilot_e2e_runner",
  databaseSchema: "public",
  applicationName: "charitypilot-e2e-reset",
  apiUrl: "http://127.0.0.1:3302",
  webUrl: "http://127.0.0.1:3303",
  databaseComment: "CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1",
  markerSchema: "charitypilot_e2e_guard",
  markerTable: "database_identity",
  markerVersion: 1,
  markerPurpose: "charitypilot-e2e-disposable",
  serverPort: 5432,
  advisoryLockKey: "8073202507100005",
});

const COLLISION_ENV_NAMES = Object.freeze([
  "DATABASE_URL",
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
]);

const REMOTE_FORBIDDEN_AUTOMATION_ENV_NAMES = Object.freeze([
  "CI",
  "GITHUB_ACTIONS",
  "E2E_MANAGED_LOCAL_RUNNER",
  "E2E_RELEASE_READY",
]);

const DENIED_TARGET_LABELS = Object.freeze([
  "default",
  "dev",
  "development",
  "live",
  "main",
  "master",
  "personal",
  "primary",
  "prod",
  "production",
  "shared",
  "stage",
  "staging",
]);

const REMOTE_SAFE_LABELS = Object.freeze([
  "disposable",
  "e2e",
  "preview",
  "qa",
  "sandbox",
  "test",
  "testing",
]);

const DENIED_TARGET_LABEL_PATTERNS = Object.freeze([
  /^default/,
  /^dev/,
  /^live/,
  /^main/,
  /^master/,
  /^personal/,
  /^primary/,
  /^prod(?!uct)/,
  /^production/,
  /^shared/,
  /^stage/,
  /^staging/,
]);

const TARGET_OVERRIDE_QUERY_PARAMETERS = Object.freeze([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "port",
  "service",
]);

const PRESERVED_PUBLIC_TABLES = Object.freeze([
  "GovernancePrinciple",
  "GovernanceStandard",
  "_prisma_migrations",
]);

const DISPOSABLE_DATABASE_RESET_TABLES = Object.freeze([
  "Organisation",
  "User",
  "AuthSession",
  "BillingAuthorityGrant",
  "ComplianceRecord",
  "ComplianceSignoff",
  "ComplianceApprovalSnapshot",
  "ComplianceAuditEvent",
  "SecurityAuditEvent",
  "BoardMember",
  "Document",
  "DocumentStandardLink",
  "DocumentStorageDeletion",
  "ConflictRecord",
  "RiskRecord",
  "ComplaintRecord",
  "FundraisingRecord",
  "AnnualReportReadiness",
  "FinancialControlReview",
  "Deadline",
  "TeamInvite",
  "DeadlineReminderLog",
  "Subscription",
  "BillingCheckoutAttempt",
  "StripeWebhookEvent",
]);

const PUBLIC_TABLE_INVENTORY_SQL = `
SELECT table_entry.relname AS table_name
FROM pg_catalog.pg_class AS table_entry
JOIN pg_catalog.pg_namespace AS table_namespace
  ON table_namespace.oid = table_entry.relnamespace
WHERE table_namespace.nspname = $1
  AND table_entry.relkind IN ('r', 'p')
ORDER BY table_entry.relname
`.trim();

const UNSAFE_TRUNCATE_TRIGGER_SQL = `
SELECT COUNT(*)::int AS unsafe_trigger_count
FROM pg_catalog.pg_trigger AS trigger_entry
JOIN pg_catalog.pg_class AS table_entry
  ON table_entry.oid = trigger_entry.tgrelid
JOIN pg_catalog.pg_namespace AS table_namespace
  ON table_namespace.oid = table_entry.relnamespace
WHERE table_namespace.nspname = $1
  AND table_entry.relname = ANY($2::text[])
  AND NOT trigger_entry.tgisinternal
  AND (trigger_entry.tgtype::int & 32) = 32
`.trim();

const TRUNCATE_PUBLICATION_SQL = `
SELECT COUNT(*)::int AS unsafe_publication_count
FROM pg_catalog.pg_publication_tables AS publication_table
JOIN pg_catalog.pg_publication AS publication
  ON publication.pubname = publication_table.pubname
WHERE publication_table.schemaname = $1
  AND publication_table.tablename = ANY($2::text[])
  AND publication.pubtruncate
`.trim();

const DATABASE_IDENTITY_SQL = `
SELECT
  current_database() AS database_name,
  session_user AS session_user,
  current_user AS current_user,
  current_schema() AS current_schema,
  host(inet_server_addr()) AS server_address,
  inet_server_port() AS server_port,
  current_setting('application_name', false) AS application_name,
  runner_role.rolsuper AS role_superuser,
  runner_role.rolinherit AS role_inherit,
  runner_role.rolcreaterole AS role_create_role,
  runner_role.rolcreatedb AS role_create_database,
  runner_role.rolreplication AS role_replication,
  runner_role.rolbypassrls AS role_bypass_rls,
  (SELECT COUNT(*)::int
     FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = runner_role.oid OR membership.roleid = runner_role.oid
  ) AS role_membership_count,
  (database.datdba = runner_role.oid) AS role_owns_database,
  (SELECT marker_namespace.nspowner = runner_role.oid
     FROM pg_catalog.pg_namespace AS marker_namespace
    WHERE marker_namespace.nspname = 'charitypilot_e2e_guard'
  ) AS role_owns_marker_schema,
  (SELECT marker_table.relowner = runner_role.oid
     FROM pg_catalog.pg_class AS marker_table
     JOIN pg_catalog.pg_namespace AS marker_namespace
       ON marker_namespace.oid = marker_table.relnamespace
    WHERE marker_namespace.nspname = 'charitypilot_e2e_guard'
      AND marker_table.relname = 'database_identity'
      AND marker_table.relkind IN ('r', 'p')
  ) AS role_owns_marker_table,
  pg_catalog.has_schema_privilege(
    current_user,
    'charitypilot_e2e_guard',
    'CREATE'
  ) AS role_can_create_in_marker_schema,
  (
    pg_catalog.has_table_privilege(current_user, 'charitypilot_e2e_guard.database_identity', 'INSERT') OR
    pg_catalog.has_table_privilege(current_user, 'charitypilot_e2e_guard.database_identity', 'UPDATE') OR
    pg_catalog.has_table_privilege(current_user, 'charitypilot_e2e_guard.database_identity', 'DELETE') OR
    pg_catalog.has_table_privilege(current_user, 'charitypilot_e2e_guard.database_identity', 'TRUNCATE') OR
    pg_catalog.has_table_privilege(current_user, 'charitypilot_e2e_guard.database_identity', 'REFERENCES') OR
    pg_catalog.has_table_privilege(current_user, 'charitypilot_e2e_guard.database_identity', 'TRIGGER')
  ) AS role_can_mutate_marker,
  pg_catalog.shobj_description(database.oid, 'pg_database') AS database_comment,
  (SELECT COUNT(*)::int FROM "charitypilot_e2e_guard"."database_identity") AS marker_count,
  (SELECT singleton FROM "charitypilot_e2e_guard"."database_identity" LIMIT 1) AS marker_singleton,
  (SELECT marker_version FROM "charitypilot_e2e_guard"."database_identity" LIMIT 1) AS marker_version,
  (SELECT purpose FROM "charitypilot_e2e_guard"."database_identity" LIMIT 1) AS marker_purpose,
  (SELECT instance_id::text FROM "charitypilot_e2e_guard"."database_identity" LIMIT 1) AS marker_instance_id
FROM pg_catalog.pg_roles AS runner_role
JOIN pg_catalog.pg_database AS database ON database.datname = current_database()
WHERE runner_role.rolname = current_user
`.trim();

const ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock($1::bigint)";
const REMOTE_SUITE_ADVISORY_LOCK_KEY = "8073202507100006";
const REMOTE_SUITE_LOCK_SQL =
  "SELECT pg_try_advisory_lock($1::bigint) AS acquired";
const REMOTE_SUITE_UNLOCK_SQL =
  "SELECT pg_advisory_unlock($1::bigint) AS released";
const REMOTE_SUITE_LEASE_PRESENCE_SQL = `
SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_locks AS advisory_lock
  WHERE advisory_lock.locktype = 'advisory'
    AND advisory_lock.database = (
      SELECT database.oid
      FROM pg_catalog.pg_database AS database
      WHERE database.datname = current_database()
    )
    AND advisory_lock.classid::bigint = (($1::bigint >> 32) & 4294967295::bigint)
    AND advisory_lock.objid::bigint = ($1::bigint & 4294967295::bigint)
    AND advisory_lock.objsubid = 1
    AND advisory_lock.mode = 'ExclusiveLock'
    AND advisory_lock.granted
) AS lease_present
`.trim();
const REMOTE_SUITE_LEASE_OWNERSHIP_SQL = `
SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_locks AS advisory_lock
  WHERE advisory_lock.locktype = 'advisory'
    AND advisory_lock.database = (
      SELECT database.oid
      FROM pg_catalog.pg_database AS database
      WHERE database.datname = current_database()
    )
    AND advisory_lock.pid = pg_backend_pid()
    AND advisory_lock.classid::bigint = (($1::bigint >> 32) & 4294967295::bigint)
    AND advisory_lock.objid::bigint = ($1::bigint & 4294967295::bigint)
    AND advisory_lock.objsubid = 1
    AND advisory_lock.mode = 'ExclusiveLock'
    AND advisory_lock.granted
) AS lease_owned
`.trim();

class DatabaseSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseSafetyError";
  }
}

function fail(message) {
  throw new DatabaseSafetyError(message);
}

function requireExactEnv(env, name, expected) {
  if (env[name] !== expected) {
    fail(`${name} must be set to the isolated E2E contract value.`);
  }
}

function parsePostgresUrl(raw, name) {
  if (typeof raw !== "string" || raw.trim() === "") {
    fail(`${name} is required; there is no database URL fallback.`);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${name} must be a valid PostgreSQL URL (value redacted).`);
  }

  if (parsed.protocol !== "postgresql:") {
    fail(`${name} must use the postgresql scheme (value redacted).`);
  }

  return parsed;
}

function decodedUrlPart(value, name) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${name} contains invalid URL encoding (value redacted).`);
  }
}

function databaseNameFromUrl(parsed, name) {
  const pathname = decodedUrlPart(parsed.pathname, name);
  if (
    !pathname.startsWith("/") ||
    pathname.length <= 1 ||
    pathname.slice(1).includes("/")
  ) {
    fail(`${name} must identify exactly one database (value redacted).`);
  }
  return pathname.slice(1);
}

function assertExactQueryParameter(parsed, envName, parameterName, expected) {
  const values = parsed.searchParams.getAll(parameterName);
  if (values.length !== 1 || values[0] !== expected) {
    fail(
      `${envName} must contain exactly one ${parameterName}=${expected} parameter (value redacted).`,
    );
  }
}

function assertNoUnexpectedQueryParameters(parsed, envName, allowedParameters) {
  const allowed = new Set(allowedParameters);
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key)) {
      fail(
        `${envName} contains an unsupported connection parameter (value redacted).`,
      );
    }
  }
}

function labels(value) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function assertNoDeniedTargetLabels(value, fieldName) {
  const targetLabels = labels(value);
  if (
    targetLabels.some(
      (targetLabel) =>
        DENIED_TARGET_LABELS.includes(targetLabel) ||
        DENIED_TARGET_LABEL_PATTERNS.some((pattern) =>
          pattern.test(targetLabel),
        ),
    )
  ) {
    fail(
      `${fieldName} contains a forbidden production/development/shared target label (value redacted).`,
    );
  }
}

function assertRemoteSafeLabel(value, fieldName) {
  const targetLabels = new Set(labels(value));
  if (!REMOTE_SAFE_LABELS.some((label) => targetLabels.has(label))) {
    fail(
      `${fieldName} must contain an explicit disposable test/QA hostname label (value redacted).`,
    );
  }
}

function normalizeHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ? "127.0.0.1" : normalized;
}

function assertNoQueryTargetOverrides(parsed, envName) {
  for (const key of parsed.searchParams.keys()) {
    if (TARGET_OVERRIDE_QUERY_PARAMETERS.includes(key.toLowerCase())) {
      fail(
        `${envName} contains a forbidden database target override (value redacted).`,
      );
    }
  }
  if (parsed.hostname.includes(",")) {
    fail(
      `${envName} must identify exactly one database host (value redacted).`,
    );
  }
}

function companionDatabaseIdentity(raw, envName) {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(
      `${envName} is set but cannot be parsed to prove database isolation (value redacted).`,
    );
  }

  if (!["postgresql:", "postgres:"].includes(parsed.protocol)) {
    fail(
      `${envName} is set but is not a PostgreSQL URL, so database isolation cannot be proved.`,
    );
  }
  assertNoQueryTargetOverrides(parsed, envName);

  return {
    host: normalizeHost(parsed.hostname),
    port: Number.parseInt(parsed.port || "5432", 10),
    databaseName: databaseNameFromUrl(parsed, envName),
  };
}

function assertNoApplicationDatabaseCollision(env, e2eIdentity) {
  for (const envName of COLLISION_ENV_NAMES) {
    const companion = companionDatabaseIdentity(env[envName], envName);
    if (!companion) continue;

    const sameTarget =
      companion.host === e2eIdentity.host &&
      companion.port === e2eIdentity.port &&
      companion.databaseName === e2eIdentity.databaseName;
    const reservedDisposableName =
      companion.databaseName === DATABASE_SAFETY_CONTRACT.databaseName;
    if (sameTarget || reservedDisposableName) {
      fail(
        `${envName} collides with the disposable E2E database target (values redacted).`,
      );
    }
  }
}

function assertCanonicalUuid(value, name) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    fail(`${name} must be a fresh canonical UUIDv4.`);
  }
}

function assertBaseDisposableEnvironment(env) {
  requireExactEnv(
    env,
    "E2E_DESTRUCTIVE_RESET_CONFIRMATION",
    DATABASE_SAFETY_CONTRACT.resetConfirmation,
  );

  if (Object.prototype.hasOwnProperty.call(env, "E2E_ALLOW_LOCAL_DB_RESET")) {
    fail(
      "E2E_ALLOW_LOCAL_DB_RESET is retired and must be removed; it never authorises a destructive reset.",
    );
  }
  assertCanonicalUuid(env.E2E_DATABASE_INSTANCE_ID, "E2E_DATABASE_INSTANCE_ID");
}

function assertExactLocalEndpoint(env, name, expected) {
  requireExactEnv(env, name, expected);
}

function assertRemoteHttpsEndpoint(env, name) {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    fail(`${name} is required for remote-disposable execution.`);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${name} must be an explicit HTTPS origin (value redacted).`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    raw.endsWith("/")
  ) {
    fail(
      `${name} must be an explicit HTTPS origin without credentials, path, query, or fragment.`,
    );
  }
  assertNoDeniedTargetLabels(parsed.hostname, `${name} hostname`);
  assertRemoteSafeLabel(parsed.hostname, `${name} hostname`);
  if (
    ["app.charitypilot.ie", "api.charitypilot.ie"].includes(
      parsed.hostname.toLowerCase(),
    )
  ) {
    fail(`${name} must never target a canonical production hostname.`);
  }
  return raw;
}

function assertStrongRemoteSecretValue(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    new Set(value).size < 12 ||
    /(change[-_ ]?me|dummy|example|not[-_ ]?real|password|placeholder|sample)/i.test(
      value,
    )
  ) {
    fail(`${name} must be an explicit high-entropy remote-disposable secret.`);
  }
  return value;
}

function requireStrongRemoteSecret(env, name) {
  return assertStrongRemoteSecretValue(env[name], name);
}

function remoteCookieDomain(env, apiUrl, webUrl) {
  const raw = env.E2E_AUTH_COOKIE_DOMAIN;
  if (
    typeof raw !== "string" ||
    raw.trim() !== raw ||
    raw.length === 0 ||
    raw.startsWith("..") ||
    raw.endsWith(".")
  ) {
    fail(
      "E2E_AUTH_COOKIE_DOMAIN must be an explicit plain DNS domain (value redacted).",
    );
  }

  const normalized = (raw.startsWith(".") ? raw.slice(1) : raw).toLowerCase();
  const domainLabels = normalized.split(".");
  if (
    isIP(normalized) !== 0 ||
    domainLabels.length < 3 ||
    domainLabels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    fail(
      "E2E_AUTH_COOKIE_DOMAIN must be a narrow non-public DNS domain (value redacted).",
    );
  }
  assertNoDeniedTargetLabels(normalized, "E2E_AUTH_COOKIE_DOMAIN");
  assertRemoteSafeLabel(normalized, "E2E_AUTH_COOKIE_DOMAIN");
  if (
    ["charitypilot.ie", "app.charitypilot.ie", "api.charitypilot.ie"].includes(
      normalized,
    )
  ) {
    fail(
      "E2E_AUTH_COOKIE_DOMAIN must never use a CharityPilot production cookie scope.",
    );
  }

  const apiHostname = new URL(apiUrl).hostname;
  const webHostname = new URL(webUrl).hostname;
  const covers = (hostname) =>
    hostname === normalized || hostname.endsWith(`.${normalized}`);
  if (!covers(apiHostname) || !covers(webHostname)) {
    fail(
      "E2E_AUTH_COOKIE_DOMAIN must narrowly cover both remote E2E web and API hostnames.",
    );
  }

  return apiHostname === normalized && webHostname === normalized
    ? normalized
    : `.${normalized}`;
}

function loadDisposableDatabaseConfig(env = process.env) {
  const executionMode = env.E2E_EXECUTION_MODE;
  if (
    executionMode !== DATABASE_SAFETY_CONTRACT.executionMode &&
    executionMode !== DATABASE_SAFETY_CONTRACT.remoteExecutionMode
  ) {
    fail(
      "E2E_EXECUTION_MODE must explicitly select local-disposable or remote-disposable.",
    );
  }
  assertBaseDisposableEnvironment(env);

  const isRemote =
    executionMode === DATABASE_SAFETY_CONTRACT.remoteExecutionMode;
  let apiUrl;
  let webUrl;
  let cookieDomain;
  if (isRemote) {
    requireExactEnv(
      env,
      "E2E_REMOTE_DATABASE_RESET_OVERRIDE",
      DATABASE_SAFETY_CONTRACT.remoteResetOverride,
    );
    for (const envName of REMOTE_FORBIDDEN_AUTOMATION_ENV_NAMES) {
      if (Object.prototype.hasOwnProperty.call(env, envName)) {
        fail(
          `remote-disposable execution is forbidden while ${envName} is active.`,
        );
      }
    }
    if (env.E2E_DEPLOYED_QA === "true") {
      fail(
        "remote-disposable reset mode cannot be combined with non-destructive deployed QA mode.",
      );
    }
    requireStrongRemoteSecret(env, "E2E_READINESS_API_KEY");
    requireStrongRemoteSecret(env, "E2E_JWT_SECRET");
    apiUrl = assertRemoteHttpsEndpoint(env, "E2E_API_URL");
    webUrl = assertRemoteHttpsEndpoint(env, "E2E_WEB_URL");
    cookieDomain = remoteCookieDomain(env, apiUrl, webUrl);
  } else {
    assertExactLocalEndpoint(
      env,
      "E2E_API_URL",
      DATABASE_SAFETY_CONTRACT.apiUrl,
    );
    assertExactLocalEndpoint(
      env,
      "E2E_WEB_URL",
      DATABASE_SAFETY_CONTRACT.webUrl,
    );
    apiUrl = DATABASE_SAFETY_CONTRACT.apiUrl;
    webUrl = DATABASE_SAFETY_CONTRACT.webUrl;
    cookieDomain = DATABASE_SAFETY_CONTRACT.databaseHost;
    if (
      Object.prototype.hasOwnProperty.call(
        env,
        "E2E_REMOTE_DATABASE_RESET_OVERRIDE",
      )
    ) {
      fail(
        "E2E_REMOTE_DATABASE_RESET_OVERRIDE must not be present in local-disposable mode.",
      );
    }
  }

  const databaseUrl = env.E2E_DATABASE_URL;
  const parsed = parsePostgresUrl(databaseUrl, "E2E_DATABASE_URL");
  const username = decodedUrlPart(parsed.username, "E2E_DATABASE_URL username");
  const password = decodedUrlPart(parsed.password, "E2E_DATABASE_URL password");
  const databaseName = databaseNameFromUrl(parsed, "E2E_DATABASE_URL");
  assertNoQueryTargetOverrides(parsed, "E2E_DATABASE_URL");

  let expectedServerAddress;
  let expectedServerPort;
  if (isRemote) {
    const expectedRemoteHost = env.E2E_REMOTE_DATABASE_HOST;
    if (
      typeof expectedRemoteHost !== "string" ||
      expectedRemoteHost !== parsed.hostname ||
      isIP(expectedRemoteHost) !== 0 ||
      !expectedRemoteHost.includes(".")
    ) {
      fail(
        "E2E_REMOTE_DATABASE_HOST must exactly match an explicit non-IP DSN hostname.",
      );
    }
    assertNoDeniedTargetLabels(expectedRemoteHost, "E2E_REMOTE_DATABASE_HOST");
    assertRemoteSafeLabel(expectedRemoteHost, "E2E_REMOTE_DATABASE_HOST");
    if (
      !parsed.port ||
      !Number.isInteger(Number(parsed.port)) ||
      Number(parsed.port) < 1 ||
      Number(parsed.port) > 65535
    ) {
      fail(
        "Remote E2E_DATABASE_URL must contain an explicit valid database port (value redacted).",
      );
    }
    expectedServerAddress = env.E2E_DATABASE_SERVER_ADDRESS;
    if (
      typeof expectedServerAddress !== "string" ||
      isIP(expectedServerAddress) === 0
    ) {
      fail(
        "E2E_DATABASE_SERVER_ADDRESS must be an explicit connected-server IP address.",
      );
    }
    expectedServerPort = Number(parsed.port);
  } else {
    if (parsed.hostname !== DATABASE_SAFETY_CONTRACT.databaseHost) {
      fail(
        "E2E_DATABASE_URL must use the dedicated 127.0.0.1 loopback target (value redacted).",
      );
    }
    if (
      Number.parseInt(parsed.port, 10) !== DATABASE_SAFETY_CONTRACT.databasePort
    ) {
      fail(
        "E2E_DATABASE_URL must use the dedicated disposable database port (value redacted).",
      );
    }
    expectedServerAddress = null;
    expectedServerPort = DATABASE_SAFETY_CONTRACT.serverPort;
  }
  if (databaseName !== DATABASE_SAFETY_CONTRACT.databaseName) {
    fail(
      "E2E_DATABASE_URL must use the reserved disposable database name (value redacted).",
    );
  }
  if (username !== DATABASE_SAFETY_CONTRACT.databaseUser) {
    fail(
      "E2E_DATABASE_URL must use the non-privileged disposable runner role (value redacted).",
    );
  }
  if (password.length === 0) {
    fail(
      "E2E_DATABASE_URL must contain a non-empty runner password (value redacted).",
    );
  }
  if (isRemote) {
    assertStrongRemoteSecretValue(password, "E2E_DATABASE_URL password");
  }
  if (parsed.hash) {
    fail(
      "E2E_DATABASE_URL contains an unsafe target override (value redacted).",
    );
  }

  assertExactQueryParameter(
    parsed,
    "E2E_DATABASE_URL",
    "schema",
    DATABASE_SAFETY_CONTRACT.databaseSchema,
  );
  assertExactQueryParameter(
    parsed,
    "E2E_DATABASE_URL",
    "application_name",
    DATABASE_SAFETY_CONTRACT.applicationName,
  );
  if (isRemote) {
    assertExactQueryParameter(
      parsed,
      "E2E_DATABASE_URL",
      "sslmode",
      "verify-full",
    );
  }
  assertNoUnexpectedQueryParameters(
    parsed,
    "E2E_DATABASE_URL",
    isRemote
      ? ["schema", "application_name", "sslmode"]
      : ["schema", "application_name"],
  );

  assertNoDeniedTargetLabels(databaseName, "E2E_DATABASE_URL database name");
  assertNoDeniedTargetLabels(username, "E2E_DATABASE_URL user");

  const e2eIdentity = {
    host: normalizeHost(parsed.hostname),
    port: Number.parseInt(parsed.port, 10),
    databaseName,
  };
  assertNoApplicationDatabaseCollision(env, e2eIdentity);

  return Object.freeze({
    databaseUrl,
    instanceId: env.E2E_DATABASE_INSTANCE_ID,
    executionMode,
    isRemote,
    apiUrl,
    webUrl,
    cookieDomain,
    expectedServerAddress,
    expectedServerPort,
    ...e2eIdentity,
    user: username,
    schema: DATABASE_SAFETY_CONTRACT.databaseSchema,
    applicationName: DATABASE_SAFETY_CONTRACT.applicationName,
  });
}

function loadLocalDisposableDatabaseConfig(env = process.env) {
  const config = loadDisposableDatabaseConfig(env);
  if (config.isRemote) {
    fail("This operation requires local-disposable execution mode.");
  }
  return config;
}

function assertDirectResetModeIsLocal(config) {
  if (config?.isRemote) {
    fail(
      "Remote destructive resets require an acquired suite lease; use acquireRemoteDisposableSuiteLease().reset().",
    );
  }
  if (
    !config ||
    config.executionMode !== DATABASE_SAFETY_CONTRACT.executionMode
  ) {
    fail("Direct database reset requires the explicit local-disposable mode.");
  }
}

function isPrivateOrLoopbackIpv4(address) {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function mappedIpv4Address(address) {
  if (!address.startsWith("::ffff:")) return null;
  const suffix = address.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const match = suffix.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

function isPrivateOrLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase();
  const family = isIP(normalized);
  if (family === 0) return false;
  if (family === 4) return isPrivateOrLoopbackIpv4(normalized);

  if (normalized === "::1") return true;
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4 !== null) return isPrivateOrLoopbackIpv4(mappedIpv4);
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function assertFalseRoleFlag(identity, property, label) {
  if (identity[property] !== false) {
    fail(`Connected E2E database role must not have ${label}.`);
  }
}

function assertDatabaseIdentity(identity, config) {
  if (!identity || typeof identity !== "object") {
    fail("Connected E2E database identity query returned no identity row.");
  }
  if (identity.database_name !== DATABASE_SAFETY_CONTRACT.databaseName) {
    fail("Connected database name does not match the disposable E2E contract.");
  }
  if (
    identity.session_user !== DATABASE_SAFETY_CONTRACT.databaseUser ||
    identity.current_user !== DATABASE_SAFETY_CONTRACT.databaseUser
  ) {
    fail(
      "Connected database session/current user does not match the disposable runner role.",
    );
  }
  if (identity.current_schema !== DATABASE_SAFETY_CONTRACT.databaseSchema) {
    fail(
      "Connected database schema does not match the disposable E2E contract.",
    );
  }
  if (config.isRemote) {
    if (identity.server_address !== config.expectedServerAddress) {
      fail(
        "Connected remote database server address does not match the explicit identity contract.",
      );
    }
  } else if (!isPrivateOrLoopbackAddress(identity.server_address)) {
    fail(
      "Connected database server address is not a private local-container address.",
    );
  }
  if (Number(identity.server_port) !== config.expectedServerPort) {
    fail(
      "Connected database server port does not match the disposable container contract.",
    );
  }
  if (identity.application_name !== DATABASE_SAFETY_CONTRACT.applicationName) {
    fail(
      "Connected database application_name does not match the destructive E2E contract.",
    );
  }

  assertFalseRoleFlag(identity, "role_superuser", "superuser authority");
  assertFalseRoleFlag(identity, "role_inherit", "INHERIT authority");
  assertFalseRoleFlag(identity, "role_create_role", "CREATEROLE authority");
  assertFalseRoleFlag(identity, "role_create_database", "CREATEDB authority");
  assertFalseRoleFlag(identity, "role_replication", "REPLICATION authority");
  assertFalseRoleFlag(identity, "role_bypass_rls", "BYPASSRLS authority");
  if (identity.role_membership_count !== 0) {
    fail(
      "Connected E2E database role must have zero granted-role or member relationships.",
    );
  }
  assertFalseRoleFlag(identity, "role_owns_database", "database ownership");
  assertFalseRoleFlag(
    identity,
    "role_owns_marker_schema",
    "marker-schema ownership",
  );
  assertFalseRoleFlag(
    identity,
    "role_owns_marker_table",
    "marker-table ownership",
  );
  assertFalseRoleFlag(
    identity,
    "role_can_create_in_marker_schema",
    "CREATE authority on the protected marker schema",
  );
  assertFalseRoleFlag(
    identity,
    "role_can_mutate_marker",
    "mutation authority on the protected marker table",
  );

  if (identity.database_comment !== DATABASE_SAFETY_CONTRACT.databaseComment) {
    fail(
      "Connected database comment does not match the disposable E2E sentinel.",
    );
  }
  if (
    Number(identity.marker_count) !== 1 ||
    identity.marker_singleton !== true
  ) {
    fail(
      "Connected database must contain exactly one protected disposable identity marker.",
    );
  }
  if (
    Number(identity.marker_version) !== DATABASE_SAFETY_CONTRACT.markerVersion
  ) {
    fail(
      "Connected database marker version does not match the E2E safety contract.",
    );
  }
  if (identity.marker_purpose !== DATABASE_SAFETY_CONTRACT.markerPurpose) {
    fail(
      "Connected database marker purpose does not match the E2E safety contract.",
    );
  }
  if (identity.marker_instance_id !== config.instanceId) {
    fail(
      "Connected database marker instance UUID does not match this isolated runner instance.",
    );
  }

  return identity;
}

function safeDatabaseOperationError(operation, error) {
  if (error instanceof DatabaseSafetyError) return error;

  const code =
    error &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    /^[A-Z0-9]{5}$/.test(error.code)
      ? ` code=${error.code}`
      : "";
  return new DatabaseSafetyError(
    `${operation} failed (${code.trim() || "database error"}); target details and credentials are redacted.`,
  );
}

async function queryAndAssertDatabaseIdentity(client, config) {
  let result;
  try {
    result = await client.query(DATABASE_IDENTITY_SQL);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Disposable database identity query",
      error,
    );
  }

  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
    fail(
      "Connected E2E database identity query must return exactly one identity row.",
    );
  }
  return assertDatabaseIdentity(result.rows[0], config);
}

function quoteIdentifier(identifier) {
  if (
    typeof identifier !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
  ) {
    fail("Unsafe E2E reset table identifier rejected.");
  }
  return `"${identifier}"`;
}

function validateResetTables(tables) {
  if (!Array.isArray(tables) || tables.length === 0) {
    fail("E2E reset table inventory must not be empty.");
  }
  for (const table of tables) quoteIdentifier(table);
  if (new Set(tables).size !== tables.length) {
    fail("E2E reset table inventory must not contain duplicate tables.");
  }
  if (tables.some((table) => PRESERVED_PUBLIC_TABLES.includes(table))) {
    fail(
      "E2E reset table inventory must not include protected preserved tables.",
    );
  }
}

function qualifiedOnlyResetTables(tables) {
  validateResetTables(tables);
  return tables.map(
    (table) =>
      `ONLY ${quoteIdentifier(DATABASE_SAFETY_CONTRACT.databaseSchema)}.${quoteIdentifier(table)}`,
  );
}

function buildSchemaQualifiedLockSql(tables) {
  return `LOCK TABLE ${qualifiedOnlyResetTables(tables).join(", ")} IN ACCESS EXCLUSIVE MODE;`;
}

function buildSchemaQualifiedTruncateSql(tables) {
  return `TRUNCATE TABLE ${qualifiedOnlyResetTables(tables).join(", ")} CONTINUE IDENTITY RESTRICT;`;
}

function expectedPublicTableInventory(tables) {
  validateResetTables(tables);
  return [...tables, ...PRESERVED_PUBLIC_TABLES].sort();
}

async function queryAndAssertPublicTableInventory(client, tables) {
  let result;
  try {
    result = await client.query(PUBLIC_TABLE_INVENTORY_SQL, [
      DATABASE_SAFETY_CONTRACT.databaseSchema,
    ]);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Disposable database public-table inventory query",
      error,
    );
  }

  if (!result || !Array.isArray(result.rows)) {
    fail(
      "Connected E2E database public-table inventory returned no rows array.",
    );
  }
  const actual = result.rows.map((row) => row?.table_name);
  if (
    actual.some((table) => typeof table !== "string") ||
    new Set(actual).size !== actual.length
  ) {
    fail("Connected E2E database public-table inventory is malformed.");
  }
  const expected = expectedPublicTableInventory(tables);
  const sortedActual = [...actual].sort();
  if (
    sortedActual.length !== expected.length ||
    sortedActual.some((table, index) => table !== expected[index])
  ) {
    fail(
      "Connected E2E database public tables do not exactly match the reset and preserved-table contract.",
    );
  }
  return sortedActual;
}

function assertSingleZeroCount(result, property, failureMessage) {
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    result.rows[0]?.[property] !== 0
  ) {
    fail(failureMessage);
  }
}

async function queryAndAssertNoUnsafeTruncateTriggers(client, tables) {
  validateResetTables(tables);
  let result;
  try {
    result = await client.query(UNSAFE_TRUNCATE_TRIGGER_SQL, [
      DATABASE_SAFETY_CONTRACT.databaseSchema,
      tables,
    ]);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Disposable database truncate-trigger preflight",
      error,
    );
  }
  assertSingleZeroCount(
    result,
    "unsafe_trigger_count",
    "Connected E2E reset tables contain an unsafe non-internal ON TRUNCATE trigger or returned malformed trigger evidence.",
  );
}

async function queryAndAssertNoTruncatePublications(client, tables) {
  validateResetTables(tables);
  let result;
  try {
    result = await client.query(TRUNCATE_PUBLICATION_SQL, [
      DATABASE_SAFETY_CONTRACT.databaseSchema,
      tables,
    ]);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Disposable database truncate-publication preflight",
      error,
    );
  }
  assertSingleZeroCount(
    result,
    "unsafe_publication_count",
    "Connected E2E reset tables participate in a truncate-publishing logical publication or returned malformed publication evidence.",
  );
}

async function queryAndAssertRemoteSuiteAdvisoryLeasePresence(client, config) {
  if (!config?.isRemote) {
    fail(
      "Suite-wide advisory-lease presence is only valid for remote-disposable mode.",
    );
  }
  let result;
  try {
    result = await client.query(REMOTE_SUITE_LEASE_PRESENCE_SQL, [
      REMOTE_SUITE_ADVISORY_LOCK_KEY,
    ]);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Remote disposable suite advisory-lease presence proof",
      error,
    );
  }
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    result.rows[0]?.lease_present !== true
  ) {
    fail(
      "Remote disposable helper access requires the active suite advisory lease on this target database.",
    );
  }
}

async function queryAndAssertRemoteSuiteAdvisoryLeaseOwnership(client, config) {
  if (!config?.isRemote) {
    fail(
      "Same-session suite advisory-lease ownership is only valid for remote-disposable mode.",
    );
  }
  let result;
  try {
    result = await client.query(REMOTE_SUITE_LEASE_OWNERSHIP_SQL, [
      REMOTE_SUITE_ADVISORY_LOCK_KEY,
    ]);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Remote disposable same-session advisory-lease ownership proof",
      error,
    );
  }
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    result.rows[0]?.lease_owned !== true
  ) {
    fail(
      "Remote disposable reset requires this exact database session to own the suite advisory lease.",
    );
  }
}

async function invokeWithRemoteSuiteLeaseAuthority(client, config, callback) {
  if (typeof callback !== "function") {
    fail("Disposable database helper callback must be callable.");
  }
  if (config?.isRemote) {
    await queryAndAssertRemoteSuiteAdvisoryLeasePresence(client, config);
  }
  return callback(client);
}

async function acquireRemoteSuiteAdvisoryLease(client, config) {
  if (!config?.isRemote) {
    fail(
      "A suite-wide database lease is only valid for remote-disposable mode.",
    );
  }
  let result;
  try {
    result = await client.query(REMOTE_SUITE_LOCK_SQL, [
      REMOTE_SUITE_ADVISORY_LOCK_KEY,
    ]);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Remote disposable suite advisory-lease acquisition",
      error,
    );
  }
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    result.rows[0]?.acquired !== true
  ) {
    fail(
      "Another remote disposable E2E suite holds the database lease; concurrent destructive execution is forbidden.",
    );
  }
}

async function acquireRemoteSuiteAdvisoryLeaseBounded(
  client,
  config,
  options = {},
) {
  if (!config?.isRemote) {
    fail(
      "A suite-wide database lease is only valid for remote-disposable mode.",
    );
  }
  const maxAttempts = options.maxAttempts ?? 40;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const sleep =
    options.sleep ??
    ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    fail("Remote disposable suite lease attempts must be a positive integer.");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    fail(
      "Remote disposable suite lease retry delay must be a non-negative integer.",
    );
  }
  if (typeof sleep !== "function") {
    fail("Remote disposable suite lease retry sleep must be callable.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result;
    try {
      result = await client.query(REMOTE_SUITE_LOCK_SQL, [
        REMOTE_SUITE_ADVISORY_LOCK_KEY,
      ]);
    } catch (error) {
      throw safeDatabaseOperationError(
        "Remote disposable suite advisory-lease acquisition",
        error,
      );
    }
    if (
      !result ||
      !Array.isArray(result.rows) ||
      result.rows.length !== 1 ||
      ![true, false].includes(result.rows[0]?.acquired)
    ) {
      fail(
        "Remote disposable suite advisory-lease acquisition returned malformed evidence.",
      );
    }
    if (result.rows[0].acquired === true) return;
    if (attempt < maxAttempts && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  fail(
    "Remote disposable E2E suite lease did not become available after bounded child shutdown; destructive cleanup was not attempted.",
  );
}

async function releaseRemoteSuiteAdvisoryLease(client, config) {
  if (!config?.isRemote) {
    fail(
      "A suite-wide database lease is only valid for remote-disposable mode.",
    );
  }
  let result;
  try {
    result = await client.query(REMOTE_SUITE_UNLOCK_SQL, [
      REMOTE_SUITE_ADVISORY_LOCK_KEY,
    ]);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Remote disposable suite advisory-lease release",
      error,
    );
  }
  if (
    !result ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    result.rows[0]?.released !== true
  ) {
    fail("Remote disposable E2E suite database lease was not held at release.");
  }
}

async function resetDisposableDatabase(client, config, tables) {
  let transactionStarted = false;
  try {
    // Remote resets are exceptional and may run only on the physical session
    // that owns the suite-wide advisory lease. This proof must precede BEGIN
    // and every transaction/table lock so an exported direct call cannot
    // bypass the global-setup lease contract.
    if (config?.isRemote) {
      await queryAndAssertRemoteSuiteAdvisoryLeaseOwnership(client, config);
    }
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(ADVISORY_LOCK_SQL, [
      DATABASE_SAFETY_CONTRACT.advisoryLockKey,
    ]);

    // Prove the live public-table inventory while the reset lock is held. This
    // fails closed if a future Prisma model is omitted from the reset list or
    // if an unexpected residual table exists.
    await queryAndAssertPublicTableInventory(client, tables);

    // Prevent concurrent DDL from adding inheritance, foreign-key, trigger, or
    // other table-bound scope between preflight and the destructive statement.
    await client.query(buildSchemaQualifiedLockSql(tables));
    await queryAndAssertNoUnsafeTruncateTriggers(client, tables);
    await queryAndAssertNoTruncatePublications(client, tables);

    // This is deliberately the final database round trip before TRUNCATE. It
    // re-proves the connection identity while the same transaction-scoped lock
    // and same physical session are held.
    await queryAndAssertDatabaseIdentity(client, config);
    await client.query(buildSchemaQualifiedTruncateSql(tables));
    await client.query("COMMIT");
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original safety/operation failure. A rollback failure
        // must not cause a destructive retry or expose connection details.
      }
    }
    throw safeDatabaseOperationError(
      "Disposable database reset transaction",
      error,
    );
  }
}

module.exports = {
  ADVISORY_LOCK_SQL,
  COLLISION_ENV_NAMES,
  DENIED_TARGET_LABELS,
  DATABASE_IDENTITY_SQL,
  DATABASE_SAFETY_CONTRACT,
  DISPOSABLE_DATABASE_RESET_TABLES,
  PRESERVED_PUBLIC_TABLES,
  PUBLIC_TABLE_INVENTORY_SQL,
  REMOTE_SUITE_ADVISORY_LOCK_KEY,
  REMOTE_SUITE_LEASE_OWNERSHIP_SQL,
  REMOTE_SUITE_LEASE_PRESENCE_SQL,
  REMOTE_SUITE_LOCK_SQL,
  REMOTE_SUITE_UNLOCK_SQL,
  TRUNCATE_PUBLICATION_SQL,
  UNSAFE_TRUNCATE_TRIGGER_SQL,
  DatabaseSafetyError,
  REMOTE_FORBIDDEN_AUTOMATION_ENV_NAMES,
  assertDatabaseIdentity,
  assertDirectResetModeIsLocal,
  acquireRemoteSuiteAdvisoryLease,
  acquireRemoteSuiteAdvisoryLeaseBounded,
  buildSchemaQualifiedLockSql,
  buildSchemaQualifiedTruncateSql,
  isPrivateOrLoopbackAddress,
  invokeWithRemoteSuiteLeaseAuthority,
  loadDisposableDatabaseConfig,
  loadLocalDisposableDatabaseConfig,
  queryAndAssertPublicTableInventory,
  queryAndAssertNoTruncatePublications,
  queryAndAssertNoUnsafeTruncateTriggers,
  queryAndAssertRemoteSuiteAdvisoryLeaseOwnership,
  queryAndAssertRemoteSuiteAdvisoryLeasePresence,
  queryAndAssertDatabaseIdentity,
  resetDisposableDatabase,
  releaseRemoteSuiteAdvisoryLease,
  safeDatabaseOperationError,
};
