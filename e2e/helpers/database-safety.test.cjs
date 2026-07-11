"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  ADVISORY_LOCK_SQL,
  DATABASE_IDENTITY_SQL,
  DATABASE_SAFETY_CONTRACT: CONTRACT,
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
  acquireRemoteSuiteAdvisoryLease,
  acquireRemoteSuiteAdvisoryLeaseBounded,
  assertDatabaseIdentity,
  assertDirectResetModeIsLocal,
  buildSchemaQualifiedLockSql,
  buildSchemaQualifiedTruncateSql,
  isPrivateOrLoopbackAddress,
  invokeWithRemoteSuiteLeaseAuthority,
  loadDisposableDatabaseConfig,
  loadLocalDisposableDatabaseConfig,
  queryAndAssertDatabaseIdentity,
  queryAndAssertNoTruncatePublications,
  queryAndAssertNoUnsafeTruncateTriggers,
  queryAndAssertPublicTableInventory,
  queryAndAssertRemoteSuiteAdvisoryLeaseOwnership,
  queryAndAssertRemoteSuiteAdvisoryLeasePresence,
  resetDisposableDatabase,
  releaseRemoteSuiteAdvisoryLease,
  safeDatabaseOperationError,
} = require("./database-safety.cjs");

const INSTANCE_ID = "123e4567-e89b-42d3-a456-426614174000";
const REMOTE_ADDRESS = "203.0.113.42";

function postgresUrl({
  host = CONTRACT.databaseHost,
  port = CONTRACT.databasePort,
  database = CONTRACT.databaseName,
  user = CONTRACT.databaseUser,
  password = "Db-e2e-Pass_8Zp4N7xQ2vT6mW9cR5sL3dF1",
  schema = CONTRACT.databaseSchema,
  applicationName = CONTRACT.applicationName,
  sslmode,
  extra = "",
} = {}) {
  const params = new URLSearchParams();
  if (schema !== null) params.append("schema", schema);
  if (applicationName !== null)
    params.append("application_name", applicationName);
  if (sslmode !== undefined) params.append("sslmode", sslmode);
  const query = `${params.toString()}${extra}`;
  return `postgresql://${user}:${password}@${host}:${port}/${database}${query ? `?${query}` : ""}`;
}

function localEnv(overrides = {}) {
  return {
    E2E_EXECUTION_MODE: CONTRACT.executionMode,
    E2E_DESTRUCTIVE_RESET_CONFIRMATION: CONTRACT.resetConfirmation,
    E2E_DATABASE_INSTANCE_ID: INSTANCE_ID,
    E2E_API_URL: CONTRACT.apiUrl,
    E2E_WEB_URL: CONTRACT.webUrl,
    E2E_DATABASE_URL: postgresUrl(),
    ...overrides,
  };
}

function remoteEnv(overrides = {}) {
  const host = "db.e2e.example.test";
  return {
    E2E_EXECUTION_MODE: CONTRACT.remoteExecutionMode,
    E2E_DESTRUCTIVE_RESET_CONFIRMATION: CONTRACT.resetConfirmation,
    E2E_REMOTE_DATABASE_RESET_OVERRIDE: CONTRACT.remoteResetOverride,
    E2E_DATABASE_INSTANCE_ID: INSTANCE_ID,
    E2E_REMOTE_DATABASE_HOST: host,
    E2E_DATABASE_SERVER_ADDRESS: REMOTE_ADDRESS,
    E2E_READINESS_API_KEY: "R3adiness-e2e-Key_7Kp9N4xQ2vT8mW6c",
    E2E_JWT_SECRET: "Jwt-e2e-Key_9Zp4N7xQ2vT8mW6cR5sL3dF1",
    E2E_API_URL: "https://api.e2e.example.test",
    E2E_WEB_URL: "https://web.e2e.example.test",
    E2E_AUTH_COOKIE_DOMAIN: "e2e.example.test",
    E2E_DATABASE_URL: postgresUrl({ host, port: 5432, sslmode: "verify-full" }),
    ...overrides,
  };
}

function localConfig() {
  return loadDisposableDatabaseConfig(localEnv());
}

function remoteConfig() {
  return loadDisposableDatabaseConfig(remoteEnv());
}

function identityRow(overrides = {}) {
  return {
    database_name: CONTRACT.databaseName,
    session_user: CONTRACT.databaseUser,
    current_user: CONTRACT.databaseUser,
    current_schema: CONTRACT.databaseSchema,
    server_address: "172.20.0.2",
    server_port: CONTRACT.serverPort,
    application_name: CONTRACT.applicationName,
    role_superuser: false,
    role_inherit: false,
    role_create_role: false,
    role_create_database: false,
    role_replication: false,
    role_bypass_rls: false,
    role_membership_count: 0,
    role_owns_database: false,
    role_owns_marker_schema: false,
    role_owns_marker_table: false,
    role_can_create_in_marker_schema: false,
    role_can_mutate_marker: false,
    database_comment: CONTRACT.databaseComment,
    marker_count: 1,
    marker_singleton: true,
    marker_version: CONTRACT.markerVersion,
    marker_purpose: CONTRACT.markerPurpose,
    marker_instance_id: INSTANCE_ID,
    ...overrides,
  };
}

function publicTableRows(resetTables) {
  return [...resetTables, ...PRESERVED_PUBLIC_TABLES]
    .sort()
    .map((table_name) => ({ table_name }));
}

function expectSafetyError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DatabaseSafetyError);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("accepts only the canonical local disposable configuration", () => {
  const config = localConfig();
  assert.equal(config.executionMode, "local-disposable");
  assert.equal(config.isRemote, false);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 55434);
  assert.equal(config.databaseName, "charitypilot_e2e_disposable");
  assert.equal(config.user, "charitypilot_e2e_runner");
  assert.equal(config.schema, "public");
  assert.equal(config.applicationName, "charitypilot-e2e-reset");
  assert.equal(config.expectedServerPort, 5432);
  assert.equal(config.cookieDomain, "127.0.0.1");
  assert.equal(loadLocalDisposableDatabaseConfig(localEnv()).isRemote, false);
  assert.doesNotThrow(() => assertDirectResetModeIsLocal(config));
});

test("direct reset mode rejects remote configuration so reset must use a suite lease", () => {
  expectSafetyError(
    () => assertDirectResetModeIsLocal(remoteConfig()),
    /acquired suite lease/,
  );
  expectSafetyError(
    () => assertDirectResetModeIsLocal(null),
    /explicit local-disposable mode/,
  );
});

test("requires an explicit execution mode and destructive confirmation", () => {
  expectSafetyError(
    () =>
      loadDisposableDatabaseConfig(localEnv({ E2E_EXECUTION_MODE: undefined })),
    /E2E_EXECUTION_MODE/,
  );
  expectSafetyError(
    () =>
      loadDisposableDatabaseConfig(
        localEnv({ E2E_DESTRUCTIVE_RESET_CONFIRMATION: "yes" }),
      ),
    /E2E_DESTRUCTIVE_RESET_CONFIRMATION/,
  );
});

test("E2E_DATABASE_URL has no fallback", () => {
  expectSafetyError(
    () =>
      loadDisposableDatabaseConfig(localEnv({ E2E_DATABASE_URL: undefined })),
    /required; there is no database URL fallback/,
  );
});

test("retired E2E_ALLOW_LOCAL_DB_RESET never grants authority in any value", () => {
  for (const legacyValue of ["true", "false", "1", ""]) {
    expectSafetyError(
      () =>
        loadDisposableDatabaseConfig(
          localEnv({ E2E_ALLOW_LOCAL_DB_RESET: legacyValue }),
        ),
      /retired and must be removed/,
    );
  }
});

test("local mode rejects malformed, remote, localhost, wrong-port, and privileged-role URLs", () => {
  const cases = [
    ["malformed", "not a URL"],
    ["remote host", postgresUrl({ host: "db.e2e.example.test" })],
    ["localhost alias", postgresUrl({ host: "localhost" })],
    ["old personal port", postgresUrl({ port: 5434 })],
    ["default port", postgresUrl({ port: 5432 })],
    ["privileged user", postgresUrl({ user: "postgres" })],
    ["empty password", postgresUrl({ password: "" })],
  ];
  for (const [name, url] of cases) {
    expectSafetyError(
      () => loadDisposableDatabaseConfig(localEnv({ E2E_DATABASE_URL: url })),
      undefined,
    );
    assert.ok(name);
  }
});

test("local mode rejects production, personal, development, shared, staging, and default database names", () => {
  for (const database of [
    "charitypilot",
    "charitypilot_production",
    "charitypilot_personal",
    "charitypilot_development",
    "charitypilot_shared",
    "charitypilot_staging",
    "postgres",
    "template1",
  ]) {
    expectSafetyError(
      () =>
        loadDisposableDatabaseConfig(
          localEnv({ E2E_DATABASE_URL: postgresUrl({ database }) }),
        ),
      /reserved disposable database name/,
    );
  }
});

test("local mode requires the fixed API and web endpoints", () => {
  for (const [name, value] of [
    ["E2E_API_URL", "http://localhost:3002"],
    ["E2E_API_URL", "https://api.charitypilot.ie"],
    ["E2E_WEB_URL", "http://localhost:3003"],
    ["E2E_WEB_URL", "https://app.charitypilot.ie"],
  ]) {
    expectSafetyError(
      () => loadDisposableDatabaseConfig(localEnv({ [name]: value })),
      new RegExp(name),
    );
  }
});

test("requires exact schema and application_name with no query overrides", () => {
  for (const url of [
    postgresUrl({ schema: null }),
    postgresUrl({ schema: "private" }),
    postgresUrl({ applicationName: null }),
    postgresUrl({ applicationName: "psql" }),
    postgresUrl({ extra: "&schema=public" }),
    postgresUrl({ extra: "&host=production.example.test" }),
    postgresUrl({ extra: "&dbname=charitypilot_e2e_disposable" }),
    postgresUrl({ extra: "&sslmode=disable" }),
  ]) {
    expectSafetyError(() =>
      loadDisposableDatabaseConfig(localEnv({ E2E_DATABASE_URL: url })),
    );
  }
});

test("requires a fresh canonical UUIDv4 instance marker", () => {
  for (const value of [
    undefined,
    "",
    "not-a-uuid",
    "123e4567-e89b-12d3-a456-426614174000",
    INSTANCE_ID.toUpperCase(),
  ]) {
    expectSafetyError(
      () =>
        loadDisposableDatabaseConfig(
          localEnv({ E2E_DATABASE_INSTANCE_ID: value }),
        ),
      /UUIDv4/,
    );
  }
});

test("rejects collisions with DATABASE_URL, DIRECT_URL, and SHADOW_DATABASE_URL", () => {
  for (const name of ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"]) {
    expectSafetyError(
      () =>
        loadDisposableDatabaseConfig(
          localEnv({ [name]: postgresUrl({ password: "other-secret" }) }),
        ),
      new RegExp(`${name} collides`),
    );
    expectSafetyError(
      () =>
        loadDisposableDatabaseConfig(
          localEnv({
            [name]: postgresUrl({
              host: "remote.example.test",
              port: 5432,
              password: "other-secret",
            }),
          }),
        ),
      new RegExp(`${name} collides`),
    );
  }
});

test("fails closed when a companion application DSN cannot prove isolation", () => {
  expectSafetyError(
    () => loadDisposableDatabaseConfig(localEnv({ DATABASE_URL: "not-a-dsn" })),
    /cannot be parsed to prove database isolation/,
  );
  expectSafetyError(
    () =>
      loadDisposableDatabaseConfig(
        localEnv({ DATABASE_URL: "mysql://db.example.test/app" }),
      ),
    /not a PostgreSQL URL/,
  );
  expectSafetyError(
    () =>
      loadDisposableDatabaseConfig(
        localEnv({
          DATABASE_URL:
            "postgresql://app:secret@safe.example.test:5432/app?host=127.0.0.1&dbname=charitypilot_e2e_disposable",
        }),
      ),
    /forbidden database target override/,
  );
});

test("accepts the exceptional remote-disposable contract only with every independent control", () => {
  const config = remoteConfig();
  assert.equal(config.executionMode, "remote-disposable");
  assert.equal(config.isRemote, true);
  assert.equal(config.host, "db.e2e.example.test");
  assert.equal(config.expectedServerAddress, REMOTE_ADDRESS);
  assert.equal(config.expectedServerPort, 5432);
  assert.equal(config.cookieDomain, ".e2e.example.test");
  expectSafetyError(
    () => loadLocalDisposableDatabaseConfig(remoteEnv()),
    /requires local-disposable/,
  );
});

test("remote mode requires the long override, exact hostname, verify-full TLS, and explicit server IP", () => {
  const cases = [
    { E2E_REMOTE_DATABASE_RESET_OVERRIDE: undefined },
    { E2E_REMOTE_DATABASE_RESET_OVERRIDE: "yes-delete-it" },
    { E2E_REMOTE_DATABASE_HOST: "other.e2e.example.test" },
    { E2E_REMOTE_DATABASE_HOST: "203.0.113.42" },
    { E2E_DATABASE_SERVER_ADDRESS: undefined },
    { E2E_DATABASE_SERVER_ADDRESS: "db.e2e.example.test" },
    {
      E2E_DATABASE_URL: postgresUrl({
        host: "db.e2e.example.test",
        port: 5432,
        sslmode: "require",
      }),
    },
    {
      E2E_DATABASE_URL: postgresUrl({
        host: "db.e2e.example.test",
        port: 5432,
      }),
    },
  ];
  for (const overrides of cases) {
    expectSafetyError(() => loadDisposableDatabaseConfig(remoteEnv(overrides)));
  }
});

test("remote mode rejects automation selection and deployed-QA mixing", () => {
  for (const name of [
    "CI",
    "GITHUB_ACTIONS",
    "E2E_MANAGED_LOCAL_RUNNER",
    "E2E_RELEASE_READY",
  ]) {
    for (const value of ["true", "false", "0", "", undefined]) {
      expectSafetyError(
        () => loadDisposableDatabaseConfig(remoteEnv({ [name]: value })),
        new RegExp(name),
      );
    }
  }
  expectSafetyError(
    () => loadDisposableDatabaseConfig(remoteEnv({ E2E_DEPLOYED_QA: "true" })),
    /cannot be combined/,
  );
});

test("remote mode requires high-entropy readiness and JWT secrets", () => {
  for (const overrides of [
    { E2E_READINESS_API_KEY: undefined },
    { E2E_READINESS_API_KEY: "short" },
    { E2E_READINESS_API_KEY: "a".repeat(64) },
    { E2E_JWT_SECRET: undefined },
    { E2E_JWT_SECRET: "short" },
    { E2E_JWT_SECRET: "b".repeat(64) },
  ]) {
    expectSafetyError(
      () => loadDisposableDatabaseConfig(remoteEnv(overrides)),
      /high-entropy/,
    );
  }
});

test("remote mode requires a high-entropy decoded database password", () => {
  for (const password of [
    "short",
    "a".repeat(64),
    "placeholder-password-with-enough-variety-123ABC",
    "sample-remote-credential-with-enough-variety-123ABC",
  ]) {
    expectSafetyError(
      () =>
        loadDisposableDatabaseConfig(
          remoteEnv({
            E2E_DATABASE_URL: postgresUrl({
              host: "db.e2e.example.test",
              port: 5432,
              password,
              sslmode: "verify-full",
            }),
          }),
        ),
      /E2E_DATABASE_URL password.*high-entropy/,
    );
  }
});

test("remote auth cookie domain is narrow, safe-labelled, normalized, and covers both origins", () => {
  assert.equal(
    loadDisposableDatabaseConfig(
      remoteEnv({ E2E_AUTH_COOKIE_DOMAIN: ".E2E.Example.Test" }),
    ).cookieDomain,
    ".e2e.example.test",
  );
  const sameHost = "https://app.e2e.example.test";
  assert.equal(
    loadDisposableDatabaseConfig(
      remoteEnv({
        E2E_API_URL: sameHost,
        E2E_WEB_URL: sameHost,
        E2E_AUTH_COOKIE_DOMAIN: "app.e2e.example.test",
      }),
    ).cookieDomain,
    "app.e2e.example.test",
  );

  for (const value of [
    undefined,
    "",
    ".com",
    "example.test",
    "charitypilot.ie",
    ".charitypilot.ie",
    "app.charitypilot.ie",
    "unrelated.e2e.example.test",
    "e2e.example.test:443",
    "https://e2e.example.test",
    "qa-personal2.example.test",
  ]) {
    expectSafetyError(() =>
      loadDisposableDatabaseConfig(
        remoteEnv({ E2E_AUTH_COOKIE_DOMAIN: value }),
      ),
    );
  }
});

test("remote mode rejects non-HTTPS, canonical production, prod-like, and unlabelled endpoints", () => {
  for (const overrides of [
    { E2E_API_URL: "http://api.e2e.example.test" },
    { E2E_WEB_URL: "https://app.charitypilot.ie" },
    { E2E_API_URL: "https://api.production.example.test" },
    { E2E_WEB_URL: "https://web.example.com" },
    { E2E_WEB_URL: "https://user:pass@web.e2e.example.test" },
    { E2E_API_URL: "https://api.e2e.example.test/path" },
  ]) {
    expectSafetyError(() => loadDisposableDatabaseConfig(remoteEnv(overrides)));
  }
});

test("remote mode rejects production-like database hostnames and application DSN collisions", () => {
  const prodHost = "db.production.example.test";
  expectSafetyError(() =>
    loadDisposableDatabaseConfig(
      remoteEnv({
        E2E_REMOTE_DATABASE_HOST: prodHost,
        E2E_DATABASE_URL: postgresUrl({
          host: prodHost,
          port: 5432,
          sslmode: "verify-full",
        }),
      }),
    ),
  );
  expectSafetyError(
    () =>
      loadDisposableDatabaseConfig(
        remoteEnv({ DATABASE_URL: remoteEnv().E2E_DATABASE_URL }),
      ),
    /DATABASE_URL collides/,
  );
});

test("remote mode rejects numbered production-like DB, API, web, and cookie labels without rejecting product", () => {
  const unsafeDbHost = "db.qa-prod1.example.test";
  expectSafetyError(() =>
    loadDisposableDatabaseConfig(
      remoteEnv({
        E2E_REMOTE_DATABASE_HOST: unsafeDbHost,
        E2E_DATABASE_URL: postgresUrl({
          host: unsafeDbHost,
          port: 5432,
          sslmode: "verify-full",
        }),
      }),
    ),
  );
  expectSafetyError(() =>
    loadDisposableDatabaseConfig(
      remoteEnv({ E2E_API_URL: "https://api.qa-live01.example.test" }),
    ),
  );
  expectSafetyError(() =>
    loadDisposableDatabaseConfig(
      remoteEnv({ E2E_WEB_URL: "https://web.qa-shared2.example.test" }),
    ),
  );
  expectSafetyError(() =>
    loadDisposableDatabaseConfig(
      remoteEnv({ E2E_AUTH_COOKIE_DOMAIN: "qa-personal2.example.test" }),
    ),
  );

  const productHost = "db.product.e2e.example.test";
  assert.equal(
    loadDisposableDatabaseConfig(
      remoteEnv({
        E2E_REMOTE_DATABASE_HOST: productHost,
        E2E_DATABASE_URL: postgresUrl({
          host: productHost,
          port: 5432,
          sslmode: "verify-full",
        }),
      }),
    ).host,
    productHost,
  );
});

test("database identity query covers every required connected fact and protected marker", () => {
  for (const fragment of [
    "current_database()",
    "session_user",
    "current_user",
    "current_schema()",
    "host(inet_server_addr()) AS server_address",
    "inet_server_port()",
    "current_setting('application_name', false)",
    "rolsuper",
    "rolinherit",
    "rolcreaterole",
    "rolcreatedb",
    "rolreplication",
    "rolbypassrls",
    "pg_auth_members",
    "role_owns_database",
    "role_owns_marker_schema",
    "role_owns_marker_table",
    "has_schema_privilege",
    "has_table_privilege",
    "shobj_description",
    '"charitypilot_e2e_guard"."database_identity"',
  ]) {
    assert.ok(
      DATABASE_IDENTITY_SQL.includes(fragment),
      `missing identity query fragment: ${fragment}`,
    );
  }
  assert.doesNotMatch(
    DATABASE_IDENTITY_SQL,
    /inet_server_addr\(\)::text/,
    "the inet text cast appends /32 or /128 and must not feed the bare-address classifier",
  );
  assert.doesNotMatch(
    DATABASE_IDENTITY_SQL,
    /INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER/,
  );
});

test("TypeScript database helpers retain P0-04 tables and route every direct connection through identity proof", () => {
  const source = readFileSync(require.resolve("./db.ts"), "utf8");
  assert.ok(
    DISPOSABLE_DATABASE_RESET_TABLES.includes("ComplianceApprovalSnapshot"),
  );
  assert.ok(DISPOSABLE_DATABASE_RESET_TABLES.includes("ComplianceAuditEvent"));
  assert.ok(DISPOSABLE_DATABASE_RESET_TABLES.includes("SecurityAuditEvent"));
  assert.ok(
    DISPOSABLE_DATABASE_RESET_TABLES.includes("DocumentStorageDeletionRecovery"),
  );
  assert.ok(
    DISPOSABLE_DATABASE_RESET_TABLES.includes("BillingCheckoutAttempt"),
  );
  assert.match(
    source,
    /await queryAndAssertDatabaseIdentity\(client, config\)/,
  );
  assert.match(
    source,
    /return await invokeWithRemoteSuiteLeaseAuthority\(client, config, fn\)/,
  );
  assert.match(
    source,
    /await resetDisposableDatabase\(\s*client,\s*config,\s*DISPOSABLE_DATABASE_RESET_TABLES,?\s*\)/,
  );
  assert.match(
    source,
    /export async function acquireRemoteDisposableSuiteLease/,
  );
  assert.match(
    source,
    /await acquireRemoteSuiteAdvisoryLease\(client, config\)/,
  );
  assert.match(source, /resetAndRelease/);
  assert.match(source, /assertDirectResetModeIsLocal\(config\)/);
  assert.doesNotMatch(source, /E2E_DATABASE_URL\s*\?\?/);
  assert.doesNotMatch(source, /localhost:5434\/charitypilot/);
});

test("reset inventory exactly covers every Prisma model except the two reference tables", () => {
  const dbSource = readFileSync(require.resolve("./db.ts"), "utf8");
  const schemaSource = readFileSync(
    require.resolve("../../apps/api/prisma/schema.prisma"),
    "utf8",
  );
  const resetTables = [...DISPOSABLE_DATABASE_RESET_TABLES];
  const prismaModels = [
    ...schemaSource.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{/gm),
  ].map((match) => match[1]);
  const preservedModels = ["GovernancePrinciple", "GovernanceStandard"];
  const expectedResetTables = prismaModels
    .filter((model) => !preservedModels.includes(model))
    .sort();

  assert.equal(
    new Set(resetTables).size,
    resetTables.length,
    "DISPOSABLE_DATABASE_RESET_TABLES must not contain duplicates",
  );
  assert.deepEqual(resetTables.sort(), expectedResetTables);
  assert.equal(Object.isFrozen(DISPOSABLE_DATABASE_RESET_TABLES), true);
  assert.match(dbSource, /DISPOSABLE_DATABASE_RESET_TABLES/);
  assert.doesNotMatch(dbSource, /const APP_TABLES/);
  assert.deepEqual(
    [...PRESERVED_PUBLIC_TABLES],
    ["GovernancePrinciple", "GovernanceStandard", "_prisma_migrations"],
  );
});

test("connected public-table inventory accepts only reset plus exact preserved tables", async () => {
  const resetTables = ["Organisation", "ComplianceAuditEvent"];
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: publicTableRows(resetTables) };
    },
  };
  assert.deepEqual(
    await queryAndAssertPublicTableInventory(client, resetTables),
    publicTableRows(resetTables).map((row) => row.table_name),
  );
  assert.deepEqual(calls, [
    { sql: PUBLIC_TABLE_INVENTORY_SQL, values: ["public"] },
  ]);
});

test("connected public-table inventory fails closed on missing, extra, malformed, duplicate, or preserved reset entries", async () => {
  const resetTables = ["Organisation", "ComplianceAuditEvent"];
  const exactRows = publicTableRows(resetTables);
  const cases = [
    exactRows.slice(1),
    [...exactRows, { table_name: "FutureUntrackedModel" }],
    [...exactRows, { table_name: null }],
    [...exactRows, exactRows[0]],
  ];
  for (const rows of cases) {
    await assert.rejects(
      () =>
        queryAndAssertPublicTableInventory(
          { query: async () => ({ rows }) },
          resetTables,
        ),
      /public-table inventory|public tables/,
    );
  }
  await assert.rejects(
    () =>
      queryAndAssertPublicTableInventory(
        { query: async () => ({ rows: exactRows }) },
        ["Organisation", "Organisation"],
      ),
    /duplicate tables/,
  );
  await assert.rejects(
    () =>
      queryAndAssertPublicTableInventory(
        { query: async () => ({ rows: exactRows }) },
        ["Organisation", "GovernancePrinciple"],
      ),
    /protected preserved tables/,
  );
  await assert.rejects(
    () =>
      queryAndAssertPublicTableInventory(
        {
          query: async () => {
            const error = new Error(
              "postgresql://runner:inventory-secret@db.production.example/db",
            );
            error.code = "42501";
            throw error;
          },
        },
        resetTables,
      ),
    (error) => {
      assert.match(error.message, /code=42501/);
      assert.doesNotMatch(
        error.message,
        /inventory-secret|production\.example/,
      );
      return true;
    },
  );
});

test("truncate trigger and publication preflights require one exact zero-count row", async () => {
  const resetTables = ["Organisation", "ComplianceAuditEvent"];
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql === UNSAFE_TRUNCATE_TRIGGER_SQL) {
        return { rows: [{ unsafe_trigger_count: 0 }] };
      }
      if (sql === TRUNCATE_PUBLICATION_SQL) {
        return { rows: [{ unsafe_publication_count: 0 }] };
      }
      return { rows: [] };
    },
  };
  await queryAndAssertNoUnsafeTruncateTriggers(client, resetTables);
  await queryAndAssertNoTruncatePublications(client, resetTables);
  assert.deepEqual(calls, [
    {
      sql: UNSAFE_TRUNCATE_TRIGGER_SQL,
      values: [CONTRACT.databaseSchema, resetTables],
    },
    {
      sql: TRUNCATE_PUBLICATION_SQL,
      values: [CONTRACT.databaseSchema, resetTables],
    },
  ]);
});

test("truncate trigger preflight rejects nonzero and malformed evidence", async () => {
  for (const rows of [
    [],
    [{ unsafe_trigger_count: 0 }, { unsafe_trigger_count: 0 }],
    [{ unsafe_trigger_count: 1 }],
    [{ unsafe_trigger_count: -1 }],
    [{ unsafe_trigger_count: "0" }],
    [{ unsafe_trigger_count: null }],
    [{}],
  ]) {
    await assert.rejects(
      () =>
        queryAndAssertNoUnsafeTruncateTriggers(
          { query: async () => ({ rows }) },
          ["Organisation"],
        ),
      /unsafe non-internal ON TRUNCATE trigger|malformed trigger evidence/,
    );
  }
});

test("truncate publication preflight rejects nonzero and malformed evidence", async () => {
  for (const rows of [
    [],
    [{ unsafe_publication_count: 0 }, { unsafe_publication_count: 0 }],
    [{ unsafe_publication_count: 1 }],
    [{ unsafe_publication_count: -1 }],
    [{ unsafe_publication_count: "0" }],
    [{ unsafe_publication_count: null }],
    [{}],
  ]) {
    await assert.rejects(
      () =>
        queryAndAssertNoTruncatePublications(
          { query: async () => ({ rows }) },
          ["Organisation"],
        ),
      /truncate-publishing logical publication|malformed publication evidence/,
    );
  }
});

test("remote suite advisory lease uses a distinct session lock and releases it explicitly", async () => {
  assert.notEqual(REMOTE_SUITE_ADVISORY_LOCK_KEY, CONTRACT.advisoryLockKey);
  const config = remoteConfig();
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql === REMOTE_SUITE_LOCK_SQL) return { rows: [{ acquired: true }] };
      if (sql === REMOTE_SUITE_UNLOCK_SQL)
        return { rows: [{ released: true }] };
      return { rows: [] };
    },
  };
  await acquireRemoteSuiteAdvisoryLease(client, config);
  await releaseRemoteSuiteAdvisoryLease(client, config);
  assert.deepEqual(calls, [
    { sql: REMOTE_SUITE_LOCK_SQL, values: [REMOTE_SUITE_ADVISORY_LOCK_KEY] },
    { sql: REMOTE_SUITE_UNLOCK_SQL, values: [REMOTE_SUITE_ADVISORY_LOCK_KEY] },
  ]);
});

test("remote helper callbacks require an active target-database suite lease", async () => {
  const config = remoteConfig();
  let callbackCalls = 0;
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ lease_present: false }] };
    },
  };

  await assert.rejects(
    () =>
      invokeWithRemoteSuiteLeaseAuthority(client, config, async () => {
        callbackCalls += 1;
      }),
    /requires the active suite advisory lease/,
  );
  assert.equal(callbackCalls, 0);
  assert.deepEqual(calls, [
    {
      sql: REMOTE_SUITE_LEASE_PRESENCE_SQL,
      values: [REMOTE_SUITE_ADVISORY_LOCK_KEY],
    },
  ]);

  const authorisedClient = {
    query: async (sql, values) => {
      assert.equal(sql, REMOTE_SUITE_LEASE_PRESENCE_SQL);
      assert.deepEqual(values, [REMOTE_SUITE_ADVISORY_LOCK_KEY]);
      return { rows: [{ lease_present: true }] };
    },
  };
  assert.equal(
    await invokeWithRemoteSuiteLeaseAuthority(
      authorisedClient,
      config,
      async () => "authorised",
    ),
    "authorised",
  );

  let localCallbackCalls = 0;
  assert.equal(
    await invokeWithRemoteSuiteLeaseAuthority(
      {
        query: async () => assert.fail("local callbacks need no remote lease"),
      },
      localConfig(),
      async () => {
        localCallbackCalls += 1;
        return "local";
      },
    ),
    "local",
  );
  assert.equal(localCallbackCalls, 1);
});

test("remote suite lease presence and ownership proofs reject false or malformed evidence", async () => {
  const config = remoteConfig();
  for (const [proof, field, pattern] of [
    [
      queryAndAssertRemoteSuiteAdvisoryLeasePresence,
      "lease_present",
      /active suite advisory lease/,
    ],
    [
      queryAndAssertRemoteSuiteAdvisoryLeaseOwnership,
      "lease_owned",
      /exact database session to own/,
    ],
  ]) {
    for (const rows of [[], [{ [field]: false }], [{ [field]: "true" }]]) {
      await assert.rejects(
        () => proof({ query: async () => ({ rows }) }, config),
        pattern,
      );
    }
  }
});

test("outer janitor lease acquisition retries contention only within an explicit bound", async () => {
  const config = remoteConfig();
  const outcomes = [false, false, true];
  const sleeps = [];
  const client = {
    query: async (sql, values) => {
      assert.equal(sql, REMOTE_SUITE_LOCK_SQL);
      assert.deepEqual(values, [REMOTE_SUITE_ADVISORY_LOCK_KEY]);
      return { rows: [{ acquired: outcomes.shift() }] };
    },
  };
  await acquireRemoteSuiteAdvisoryLeaseBounded(client, config, {
    maxAttempts: 3,
    retryDelayMs: 7,
    sleep: async (delayMs) => sleeps.push(delayMs),
  });
  assert.deepEqual(sleeps, [7, 7]);

  let attempts = 0;
  await assert.rejects(
    acquireRemoteSuiteAdvisoryLeaseBounded(
      {
        query: async () => {
          attempts += 1;
          return { rows: [{ acquired: false }] };
        },
      },
      config,
      { maxAttempts: 2, retryDelayMs: 0 },
    ),
    /did not become available.*cleanup was not attempted/,
  );
  assert.equal(attempts, 2);

  await assert.rejects(
    acquireRemoteSuiteAdvisoryLeaseBounded(
      { query: async () => ({ rows: [{ acquired: "false" }] }) },
      config,
      { maxAttempts: 2, retryDelayMs: 0 },
    ),
    /malformed evidence/,
  );
});

test("remote suite advisory lease fails closed for local mode, contention, malformed results, or lost ownership", async () => {
  const noQuery = {
    query: async () => assert.fail("local lease must not query"),
  };
  await assert.rejects(
    () => acquireRemoteSuiteAdvisoryLease(noQuery, localConfig()),
    /only valid for remote-disposable/,
  );
  for (const rows of [[], [{ acquired: false }], [{ acquired: "true" }]]) {
    await assert.rejects(
      () =>
        acquireRemoteSuiteAdvisoryLease(
          { query: async () => ({ rows }) },
          remoteConfig(),
        ),
      /concurrent destructive execution is forbidden/,
    );
  }
  await assert.rejects(
    () =>
      releaseRemoteSuiteAdvisoryLease(
        { query: async () => ({ rows: [{ released: false }] }) },
        remoteConfig(),
      ),
    /lease was not held/,
  );
});

test("accepts the exact connected local identity on private and loopback addresses", () => {
  const config = localConfig();
  for (const address of [
    "172.16.0.2",
    "172.31.255.254",
    "10.2.3.4",
    "192.168.1.5",
    "127.0.0.1",
    "::1",
    "fd00::2",
    "FD00::2",
    "::ffff:172.18.0.2",
    "::ffff:ac12:2",
    "::FFFF:AC12:2",
    "::ffff:10.2.3.4",
    "::ffff:c0a8:105",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(
      assertDatabaseIdentity(identityRow({ server_address: address }), config)
        .server_address,
      address,
    );
  }
});

test("private-address classifier excludes public, malformed, and null addresses", () => {
  for (const address of [
    "172.15.0.1",
    "172.32.0.1",
    "8.8.8.8",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "::ffff:172.15.0.1",
    "::ffff:ac20:1",
    "::ffff:100.64.0.1",
    "::ffff:gggg:1",
    "::ffff:172.18.0.2:1",
    "64:ff9b::a00:1",
    "2001:4860:4860::8888",
    "example.test",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isPrivateOrLoopbackAddress(address), false);
  }
});

test("rejects every connected identity mismatch", () => {
  const config = localConfig();
  const cases = [
    { database_name: "charitypilot" },
    { session_user: "postgres" },
    { current_user: "postgres" },
    { current_schema: "private" },
    { server_address: "8.8.8.8" },
    { server_address: "::ffff:808:808" },
    { server_address: null },
    { server_port: 55434 },
    { application_name: "psql" },
    { database_comment: "almost-right" },
    { marker_count: 0 },
    { marker_count: 2 },
    { marker_singleton: false },
    { marker_version: 2 },
    { marker_purpose: "general-tests" },
    { marker_instance_id: "923e4567-e89b-42d3-a456-426614174000" },
  ];
  for (const overrides of cases) {
    expectSafetyError(() =>
      assertDatabaseIdentity(identityRow(overrides), config),
    );
  }
});

test("rejects every privileged connected role flag", () => {
  const config = localConfig();
  for (const property of [
    "role_superuser",
    "role_inherit",
    "role_create_role",
    "role_create_database",
    "role_replication",
    "role_bypass_rls",
    "role_owns_database",
    "role_owns_marker_schema",
    "role_owns_marker_table",
    "role_can_create_in_marker_schema",
    "role_can_mutate_marker",
  ]) {
    expectSafetyError(() =>
      assertDatabaseIdentity(identityRow({ [property]: true }), config),
    );
    expectSafetyError(() =>
      assertDatabaseIdentity(identityRow({ [property]: null }), config),
    );
  }
  for (const count of [1, 2, -1, null, undefined, "0"]) {
    expectSafetyError(() =>
      assertDatabaseIdentity(
        identityRow({ role_membership_count: count }),
        config,
      ),
    );
  }
});

test("remote connected identity requires the exact explicit server address and DSN server port", () => {
  const config = remoteConfig();
  const row = identityRow({
    server_address: REMOTE_ADDRESS,
    server_port: 5432,
  });
  assert.equal(
    assertDatabaseIdentity(row, config).server_address,
    REMOTE_ADDRESS,
  );
  expectSafetyError(() =>
    assertDatabaseIdentity({ ...row, server_address: "203.0.113.43" }, config),
  );
  expectSafetyError(() =>
    assertDatabaseIdentity({ ...row, server_port: 6432 }, config),
  );
});

test("queryAndAssertDatabaseIdentity fails closed on row counts and redacts query errors", async () => {
  const config = localConfig();
  await assert.rejects(
    () =>
      queryAndAssertDatabaseIdentity(
        { query: async () => ({ rows: [] }) },
        config,
      ),
    /exactly one identity row/,
  );
  await assert.rejects(
    () =>
      queryAndAssertDatabaseIdentity(
        {
          query: async () => {
            const error = new Error(
              "postgresql://user:super-secret@prod.example.test/db",
            );
            error.code = "42P01";
            throw error;
          },
        },
        config,
      ),
    (error) => {
      assert.match(error.message, /code=42P01/);
      assert.doesNotMatch(error.message, /super-secret|prod\.example/);
      return true;
    },
  );
});

test("safe operation failures never echo URLs, passwords, hosts, or raw messages", () => {
  const raw = new Error(
    "connect failed for postgresql://charitypilot_e2e_runner:extremely-secret@db.production.example/db",
  );
  raw.code = "28P01";
  const safe = safeDatabaseOperationError("Connection", raw);
  assert.ok(safe instanceof DatabaseSafetyError);
  assert.match(safe.message, /code=28P01/);
  assert.doesNotMatch(
    safe.message,
    /extremely-secret|production\.example|postgresql:\/\//,
  );
});

test("lock and truncate builders constrain every relation with ONLY and never cascade or restart identities", () => {
  const tables = [
    "Organisation",
    "ComplianceApprovalSnapshot",
    "ComplianceAuditEvent",
  ];
  const lockSql = buildSchemaQualifiedLockSql(tables);
  const truncateSql = buildSchemaQualifiedTruncateSql(tables);
  assert.equal(
    lockSql,
    'LOCK TABLE ONLY "public"."Organisation", ONLY "public"."ComplianceApprovalSnapshot", ONLY "public"."ComplianceAuditEvent" IN ACCESS EXCLUSIVE MODE;',
  );
  assert.equal(
    truncateSql,
    'TRUNCATE TABLE ONLY "public"."Organisation", ONLY "public"."ComplianceApprovalSnapshot", ONLY "public"."ComplianceAuditEvent" CONTINUE IDENTITY RESTRICT;',
  );
  assert.doesNotMatch(truncateSql, /CASCADE|RESTART IDENTITY/);
  assert.match(UNSAFE_TRUNCATE_TRIGGER_SQL, /NOT trigger_entry\.tgisinternal/);
  assert.match(UNSAFE_TRUNCATE_TRIGGER_SQL, /tgtype::int & 32/);
  assert.match(TRUNCATE_PUBLICATION_SQL, /publication\.pubtruncate/);
  expectSafetyError(
    () => buildSchemaQualifiedTruncateSql([]),
    /must not be empty/,
  );
  expectSafetyError(() =>
    buildSchemaQualifiedTruncateSql(["Organisation; DROP DATABASE x"]),
  );
  expectSafetyError(() =>
    buildSchemaQualifiedLockSql(["Organisation", "Organisation"]),
  );
});

test("remote reset cannot begin unless the same physical session owns the suite lease", async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql === REMOTE_SUITE_LEASE_OWNERSHIP_SQL) {
        return { rows: [{ lease_owned: false }] };
      }
      assert.fail(`remote reset bypass reached forbidden SQL: ${sql}`);
    },
  };

  await assert.rejects(
    () => resetDisposableDatabase(client, remoteConfig(), ["Organisation"]),
    /exact database session to own the suite advisory lease/,
  );
  assert.deepEqual(calls, [
    {
      sql: REMOTE_SUITE_LEASE_OWNERSHIP_SQL,
      values: [REMOTE_SUITE_ADVISORY_LOCK_KEY],
    },
  ]);
});

test("reset uses one transaction, advisory lock, fresh identity, qualified truncate, and commit in order", async () => {
  const config = localConfig();
  const resetTables = ["Organisation", "ComplianceAuditEvent"];
  const lockSql = buildSchemaQualifiedLockSql(resetTables);
  const truncateSql = buildSchemaQualifiedTruncateSql(resetTables);
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql === PUBLIC_TABLE_INVENTORY_SQL) {
        return { rows: publicTableRows(resetTables) };
      }
      if (sql === UNSAFE_TRUNCATE_TRIGGER_SQL) {
        return { rows: [{ unsafe_trigger_count: 0 }] };
      }
      if (sql === TRUNCATE_PUBLICATION_SQL) {
        return { rows: [{ unsafe_publication_count: 0 }] };
      }
      if (sql === DATABASE_IDENTITY_SQL) return { rows: [identityRow()] };
      return { rows: [] };
    },
  };

  await resetDisposableDatabase(client, config, resetTables);
  assert.deepEqual(
    calls.map((call) => call.sql),
    [
      "BEGIN",
      ADVISORY_LOCK_SQL,
      PUBLIC_TABLE_INVENTORY_SQL,
      lockSql,
      UNSAFE_TRUNCATE_TRIGGER_SQL,
      TRUNCATE_PUBLICATION_SQL,
      DATABASE_IDENTITY_SQL,
      truncateSql,
      "COMMIT",
    ],
  );
  assert.deepEqual(calls[1].values, [CONTRACT.advisoryLockKey]);
  assert.deepEqual(calls[2].values, [CONTRACT.databaseSchema]);
  assert.deepEqual(calls[4].values, [CONTRACT.databaseSchema, resetTables]);
  assert.deepEqual(calls[5].values, [CONTRACT.databaseSchema, resetTables]);
  assert.equal(calls.at(-3).sql, DATABASE_IDENTITY_SQL);
  assert.equal(calls.at(-2).sql, truncateSql);
});

test("reset rolls back before identity and truncate when locked public-table inventory mismatches", async () => {
  const config = localConfig();
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql === PUBLIC_TABLE_INVENTORY_SQL) {
        return { rows: [{ table_name: "UnexpectedResidualTable" }] };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    () => resetDisposableDatabase(client, config, ["Organisation"]),
    /public tables do not exactly match/,
  );
  assert.deepEqual(calls, [
    "BEGIN",
    ADVISORY_LOCK_SQL,
    PUBLIC_TABLE_INVENTORY_SQL,
    "ROLLBACK",
  ]);
});

test("reset rolls back before identity and truncate when a locked table has an ON TRUNCATE trigger", async () => {
  const resetTables = ["Organisation"];
  const lockSql = buildSchemaQualifiedLockSql(resetTables);
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql === PUBLIC_TABLE_INVENTORY_SQL) {
        return { rows: publicTableRows(resetTables) };
      }
      if (sql === UNSAFE_TRUNCATE_TRIGGER_SQL) {
        return { rows: [{ unsafe_trigger_count: 1 }] };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    () => resetDisposableDatabase(client, localConfig(), resetTables),
    /unsafe non-internal ON TRUNCATE trigger/,
  );
  assert.deepEqual(calls, [
    "BEGIN",
    ADVISORY_LOCK_SQL,
    PUBLIC_TABLE_INVENTORY_SQL,
    lockSql,
    UNSAFE_TRUNCATE_TRIGGER_SQL,
    "ROLLBACK",
  ]);
});

test("reset rolls back before identity and truncate when a locked table publishes truncates", async () => {
  const resetTables = ["Organisation"];
  const lockSql = buildSchemaQualifiedLockSql(resetTables);
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql === PUBLIC_TABLE_INVENTORY_SQL) {
        return { rows: publicTableRows(resetTables) };
      }
      if (sql === UNSAFE_TRUNCATE_TRIGGER_SQL) {
        return { rows: [{ unsafe_trigger_count: 0 }] };
      }
      if (sql === TRUNCATE_PUBLICATION_SQL) {
        return { rows: [{ unsafe_publication_count: 1 }] };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    () => resetDisposableDatabase(client, localConfig(), resetTables),
    /truncate-publishing logical publication/,
  );
  assert.deepEqual(calls, [
    "BEGIN",
    ADVISORY_LOCK_SQL,
    PUBLIC_TABLE_INVENTORY_SQL,
    lockSql,
    UNSAFE_TRUNCATE_TRIGGER_SQL,
    TRUNCATE_PUBLICATION_SQL,
    "ROLLBACK",
  ]);
});

test("reset rolls back without truncating when the locked fresh identity check fails", async () => {
  const config = localConfig();
  const resetTables = ["Organisation"];
  const lockSql = buildSchemaQualifiedLockSql(resetTables);
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql === PUBLIC_TABLE_INVENTORY_SQL) {
        return { rows: publicTableRows(resetTables) };
      }
      if (sql === UNSAFE_TRUNCATE_TRIGGER_SQL) {
        return { rows: [{ unsafe_trigger_count: 0 }] };
      }
      if (sql === TRUNCATE_PUBLICATION_SQL) {
        return { rows: [{ unsafe_publication_count: 0 }] };
      }
      if (sql === DATABASE_IDENTITY_SQL) {
        return {
          rows: [
            identityRow({
              marker_instance_id: "923e4567-e89b-42d3-a456-426614174000",
            }),
          ],
        };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => resetDisposableDatabase(client, config, resetTables),
    /instance UUID/,
  );
  assert.deepEqual(calls, [
    "BEGIN",
    ADVISORY_LOCK_SQL,
    PUBLIC_TABLE_INVENTORY_SQL,
    lockSql,
    UNSAFE_TRUNCATE_TRIGGER_SQL,
    TRUNCATE_PUBLICATION_SQL,
    DATABASE_IDENTITY_SQL,
    "ROLLBACK",
  ]);
  assert.equal(
    calls.some((sql) => sql.startsWith("TRUNCATE")),
    false,
  );
});

test("reset rolls back and redacts a truncate failure without retrying", async () => {
  const config = localConfig();
  const resetTables = ["Organisation"];
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql === PUBLIC_TABLE_INVENTORY_SQL) {
        return { rows: publicTableRows(resetTables) };
      }
      if (sql === UNSAFE_TRUNCATE_TRIGGER_SQL) {
        return { rows: [{ unsafe_trigger_count: 0 }] };
      }
      if (sql === TRUNCATE_PUBLICATION_SQL) {
        return { rows: [{ unsafe_publication_count: 0 }] };
      }
      if (sql === DATABASE_IDENTITY_SQL) return { rows: [identityRow()] };
      if (sql.startsWith("TRUNCATE")) {
        const error = new Error(
          "postgresql://runner:do-not-leak@db.production.example.test/db",
        );
        error.code = "XX001";
        throw error;
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => resetDisposableDatabase(client, config, resetTables),
    (error) => {
      assert.match(error.message, /code=XX001/);
      assert.doesNotMatch(error.message, /do-not-leak|production\.example/);
      return true;
    },
  );
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.filter((sql) => sql.startsWith("TRUNCATE")).length, 1);
});

test("rollback failure never masks the original fail-closed identity result", async () => {
  const config = localConfig();
  const resetTables = ["Organisation"];
  const client = {
    query: async (sql) => {
      if (sql === PUBLIC_TABLE_INVENTORY_SQL) {
        return { rows: publicTableRows(resetTables) };
      }
      if (sql === UNSAFE_TRUNCATE_TRIGGER_SQL) {
        return { rows: [{ unsafe_trigger_count: 0 }] };
      }
      if (sql === TRUNCATE_PUBLICATION_SQL) {
        return { rows: [{ unsafe_publication_count: 0 }] };
      }
      if (sql === DATABASE_IDENTITY_SQL)
        return { rows: [identityRow({ marker_count: 0 })] };
      if (sql === "ROLLBACK")
        throw new Error("rollback details must not surface");
      return { rows: [] };
    },
  };
  await assert.rejects(
    () => resetDisposableDatabase(client, config, resetTables),
    /exactly one protected disposable identity marker/,
  );
});
