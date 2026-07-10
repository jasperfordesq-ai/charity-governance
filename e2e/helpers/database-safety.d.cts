export type DisposableExecutionMode = "local-disposable" | "remote-disposable";

export interface DisposableDatabaseConfig {
  databaseUrl: string;
  instanceId: string;
  executionMode: DisposableExecutionMode;
  isRemote: boolean;
  apiUrl: string;
  webUrl: string;
  cookieDomain: string;
  expectedServerAddress: string | null;
  expectedServerPort: number;
  host: string;
  port: number;
  databaseName: string;
  user: string;
  schema: "public";
  applicationName: "charitypilot-e2e-reset";
}

export interface DatabaseIdentityRow {
  database_name: string;
  session_user: string;
  current_user: string;
  current_schema: string;
  server_address: string | null;
  server_port: number;
  application_name: string;
  role_superuser: boolean;
  role_inherit: boolean;
  role_create_role: boolean;
  role_create_database: boolean;
  role_replication: boolean;
  role_bypass_rls: boolean;
  role_membership_count: number;
  role_owns_database: boolean;
  role_owns_marker_schema: boolean;
  role_owns_marker_table: boolean;
  role_can_create_in_marker_schema: boolean;
  role_can_mutate_marker: boolean;
  database_comment: string | null;
  marker_count: number;
  marker_singleton: boolean | null;
  marker_version: number | null;
  marker_purpose: string | null;
  marker_instance_id: string | null;
}

export interface QueryResultLike<T = unknown> {
  rows: T[];
}

export interface DatabaseClientLike {
  query<T = unknown>(
    query: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
}

export declare const DATABASE_SAFETY_CONTRACT: Readonly<{
  executionMode: "local-disposable";
  remoteExecutionMode: "remote-disposable";
  resetConfirmation: string;
  remoteResetOverride: string;
  databaseHost: "127.0.0.1";
  databasePort: 55434;
  databaseName: "charitypilot_e2e_disposable";
  databaseUser: "charitypilot_e2e_runner";
  databaseSchema: "public";
  applicationName: "charitypilot-e2e-reset";
  apiUrl: "http://127.0.0.1:3302";
  webUrl: "http://127.0.0.1:3303";
  databaseComment: "CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1";
  markerSchema: "charitypilot_e2e_guard";
  markerTable: "database_identity";
  markerVersion: 1;
  markerPurpose: "charitypilot-e2e-disposable";
  serverPort: 5432;
  advisoryLockKey: string;
}>;

export declare const COLLISION_ENV_NAMES: readonly string[];
export declare const DENIED_TARGET_LABELS: readonly string[];
export declare const REMOTE_FORBIDDEN_AUTOMATION_ENV_NAMES: readonly string[];
export declare const DATABASE_IDENTITY_SQL: string;
export declare const ADVISORY_LOCK_SQL: string;
export declare const DISPOSABLE_DATABASE_RESET_TABLES: readonly string[];
export declare const PRESERVED_PUBLIC_TABLES: readonly [
  "GovernancePrinciple",
  "GovernanceStandard",
  "_prisma_migrations",
];
export declare const PUBLIC_TABLE_INVENTORY_SQL: string;
export declare const REMOTE_SUITE_ADVISORY_LOCK_KEY: string;
export declare const REMOTE_SUITE_LEASE_OWNERSHIP_SQL: string;
export declare const REMOTE_SUITE_LEASE_PRESENCE_SQL: string;
export declare const REMOTE_SUITE_LOCK_SQL: string;
export declare const REMOTE_SUITE_UNLOCK_SQL: string;
export declare const UNSAFE_TRUNCATE_TRIGGER_SQL: string;
export declare const TRUNCATE_PUBLICATION_SQL: string;

export declare class DatabaseSafetyError extends Error {}

export declare function loadDisposableDatabaseConfig(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): DisposableDatabaseConfig;
export declare function loadLocalDisposableDatabaseConfig(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): DisposableDatabaseConfig & { isRemote: false };
export declare function isPrivateOrLoopbackAddress(address: unknown): boolean;
export declare function assertDatabaseIdentity(
  identity: DatabaseIdentityRow,
  config: DisposableDatabaseConfig,
): DatabaseIdentityRow;
export declare function assertDirectResetModeIsLocal(
  config: DisposableDatabaseConfig,
): void;
export declare function queryAndAssertDatabaseIdentity(
  client: DatabaseClientLike,
  config: DisposableDatabaseConfig,
): Promise<DatabaseIdentityRow>;
export declare function queryAndAssertPublicTableInventory(
  client: DatabaseClientLike,
  tables: readonly string[],
): Promise<string[]>;
export declare function queryAndAssertNoUnsafeTruncateTriggers(
  client: DatabaseClientLike,
  tables: readonly string[],
): Promise<void>;
export declare function queryAndAssertNoTruncatePublications(
  client: DatabaseClientLike,
  tables: readonly string[],
): Promise<void>;
export declare function queryAndAssertRemoteSuiteAdvisoryLeasePresence(
  client: DatabaseClientLike,
  config: DisposableDatabaseConfig,
): Promise<void>;
export declare function queryAndAssertRemoteSuiteAdvisoryLeaseOwnership(
  client: DatabaseClientLike,
  config: DisposableDatabaseConfig,
): Promise<void>;
export declare function invokeWithRemoteSuiteLeaseAuthority<
  TClient extends DatabaseClientLike,
  T,
>(
  client: TClient,
  config: DisposableDatabaseConfig,
  callback: (client: TClient) => T | Promise<T>,
): Promise<T>;
export declare function acquireRemoteSuiteAdvisoryLease(
  client: DatabaseClientLike,
  config: DisposableDatabaseConfig,
): Promise<void>;
export declare function acquireRemoteSuiteAdvisoryLeaseBounded(
  client: DatabaseClientLike,
  config: DisposableDatabaseConfig,
  options?: Readonly<{
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  }>,
): Promise<void>;
export declare function releaseRemoteSuiteAdvisoryLease(
  client: DatabaseClientLike,
  config: DisposableDatabaseConfig,
): Promise<void>;
export declare function buildSchemaQualifiedTruncateSql(
  tables: readonly string[],
): string;
export declare function buildSchemaQualifiedLockSql(
  tables: readonly string[],
): string;
export declare function resetDisposableDatabase(
  client: DatabaseClientLike,
  config: DisposableDatabaseConfig,
  tables: readonly string[],
): Promise<void>;
export declare function safeDatabaseOperationError(
  operation: string,
  error: unknown,
): DatabaseSafetyError;
