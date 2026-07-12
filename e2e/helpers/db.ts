import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";

import { IS_DEPLOYED_QA } from "../env";
import {
  createPasswordRecoveryTokenMaterial,
  derivePasswordRecoveryRateDigest,
} from "../../apps/api/src/services/password-recovery-crypto.js";
import {
  type DisposableDatabaseConfig,
  DatabaseSafetyError,
  DISPOSABLE_DATABASE_RESET_TABLES,
  acquireRemoteSuiteAdvisoryLease,
  assertDirectResetModeIsLocal,
  invokeWithRemoteSuiteLeaseAuthority,
  loadDisposableDatabaseConfig,
  queryAndAssertDatabaseIdentity,
  resetDisposableDatabase,
  releaseRemoteSuiteAdvisoryLease,
  safeDatabaseOperationError,
} from "./database-safety.cjs";

type E2EStorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax" | "Strict" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
};

/**
 * Direct Postgres access for the E2E harness.
 *
 * The destructive suite is permitted to use direct database access only after
 * the pure configuration guard and a connected, UUID-bound identity query have
 * proved an isolated disposable target. We use this connection for two things:
 *   1. Resetting the database to a clean state at the start of a run.
 *   2. Reading/injecting one-time tokens and flags that, in production, would
 *      be delivered by email — locally email delivery is a no-op and the
 *      verify/invite tokens are stored as sha256 hashes, so the plaintext is
 *      otherwise unrecoverable.
 */
function assertDirectDatabaseSeamAllowed(): DisposableDatabaseConfig {
  if (IS_DEPLOYED_QA) {
    throw new Error(
      "E2E_DEPLOYED_QA=true forbids direct database access. Use the approved deployed QA credentials instead of local DB reset/token seams.",
    );
  }
  return loadDisposableDatabaseConfig(process.env);
}

/**
 * Tenant/app tables truncated on reset. The seeded governance reference data
 * (GovernancePrinciple, GovernanceStandard), migration-owned singleton
 * AuthRecoveryControl, and its append-only AuthRecoveryRetiredSecret history
 * are deliberately PRESERVED so compliance journeys retain their standards and
 * recovery remains bound to the isolated stack's secret and key history.
 * (Confirmed against apps/api/prisma/seed.ts + schema.prisma — see e2e/README.md.)
 */
const DATABASE_CONNECTION_TIMEOUT_MS = 10_000;
const DATABASE_QUERY_TIMEOUT_MS = 30_000;

function createDatabaseClient(
  config: DisposableDatabaseConfig,
  options: { keepAlive?: boolean; keepAliveInitialDelayMillis?: number } = {},
): Client {
  return new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: DATABASE_QUERY_TIMEOUT_MS,
    ...options,
  });
}

export async function withDb<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const config = assertDirectDatabaseSeamAllowed();
  const client = createDatabaseClient(config);
  try {
    await client.connect();
  } catch (error) {
    throw safeDatabaseOperationError("Disposable database connection", error);
  }
  try {
    await queryAndAssertDatabaseIdentity(client, config);
    // Remote worker connections cannot own global setup's session-affine
    // lease, but they must prove that exact lease is active on this target
    // database before any arbitrary helper callback can read or mutate it.
    return await invokeWithRemoteSuiteLeaseAuthority(client, config, fn);
  } catch (error) {
    if (error instanceof DatabaseSafetyError) throw error;
    if (
      error &&
      typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string"
    ) {
      throw safeDatabaseOperationError(
        "Disposable database helper query",
        error,
      );
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Fail-fast configuration preflight for the destructive E2E runner. */
export function assertDisposableDatabaseConfiguration(): DisposableDatabaseConfig {
  return assertDirectDatabaseSeamAllowed();
}

/** Non-destructively connect and prove the reset target identity. */
export async function verifyDisposableDatabaseIdentity(): Promise<void> {
  await withDb(async () => undefined);
}

export type RemoteDisposableSuiteLease = Readonly<{
  reset: () => Promise<void>;
  release: () => Promise<void>;
  resetAndRelease: () => Promise<void>;
}>;

/**
 * Hold a session-level lease for an entire exceptional remote-destructive
 * Playwright run. The returned handle retains one physical PostgreSQL client;
 * callers must use resetAndRelease() from global teardown on both pass/fail.
 */
export async function acquireRemoteDisposableSuiteLease(): Promise<RemoteDisposableSuiteLease> {
  const config = assertDirectDatabaseSeamAllowed();
  if (!config.isRemote) {
    throw new DatabaseSafetyError(
      "A suite-wide database lease is only valid for remote-disposable mode.",
    );
  }

  const client = createDatabaseClient(config, {
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  try {
    await client.connect();
    await queryAndAssertDatabaseIdentity(client, config);
    await acquireRemoteSuiteAdvisoryLease(client, config);
  } catch (error) {
    await client.end().catch(() => undefined);
    if (error instanceof DatabaseSafetyError) throw error;
    throw safeDatabaseOperationError(
      "Remote disposable suite lease connection",
      error,
    );
  }

  let released = false;
  const assertActive = () => {
    if (released) {
      throw new DatabaseSafetyError(
        "Remote disposable suite database lease has already been released.",
      );
    }
  };
  const reset = async () => {
    assertActive();
    await resetDisposableDatabase(
      client,
      config,
      DISPOSABLE_DATABASE_RESET_TABLES,
    );
  };
  const release = async () => {
    if (released) return;
    let releaseError: unknown;
    try {
      await releaseRemoteSuiteAdvisoryLease(client, config);
    } catch (error) {
      releaseError = error;
    } finally {
      released = true;
      await client.end().catch(() => undefined);
    }
    if (releaseError) throw releaseError;
  };
  const resetAndRelease = async () => {
    let resetError: unknown;
    try {
      await reset();
    } catch (error) {
      resetError = error;
    }

    let releaseError: unknown;
    try {
      await release();
    } catch (error) {
      releaseError = error;
    }
    if (resetError) throw resetError;
    if (releaseError) throw releaseError;
  };

  return Object.freeze({ reset, release, resetAndRelease });
}

/** sha256 hex — mirrors hashOpaqueToken in apps/api/src/services/session-tokens.ts:38-40. */
export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** A random URL-safe opaque token, like the API's crypto.randomBytes(...).toString('base64url'). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function testId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signLocalAccessToken(
  payload: {
    userId: string;
    organisationId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    sessionId: string;
  },
  config: DisposableDatabaseConfig,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: nowSeconds,
    exp: nowSeconds + 15 * 60,
    iss: "charitypilot-api",
    aud: "charitypilot-web",
  };
  const encodedHeader = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const encodedBody = base64UrlJson(body);
  const jwtSecret = process.env.E2E_JWT_SECRET;
  if (config.isRemote && !jwtSecret) {
    throw new DatabaseSafetyError(
      "remote-disposable direct authentication requires an explicit E2E_JWT_SECRET for the isolated QA stack.",
    );
  }
  const signature = crypto
    .createHmac(
      "sha256",
      jwtSecret ?? "local-dev-jwt-secret-at-least-32-characters",
    )
    .update(`${encodedHeader}.${encodedBody}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

/**
 * Truncate all tenant/app tables, preserving seeded governance reference data.
 * The guarded reset uses per-table ONLY, CONTINUE IDENTITY, and RESTRICT after
 * exact table, trigger, publication, role, and marker preflights.
 */
export async function resetDb(): Promise<void> {
  const config = assertDirectDatabaseSeamAllowed();
  assertDirectResetModeIsLocal(config);
  const client = createDatabaseClient(config);
  try {
    await client.connect();
  } catch (error) {
    throw safeDatabaseOperationError("Disposable database connection", error);
  }

  try {
    // Initial non-destructive proof gives callers a distinct preflight failure.
    // resetDisposableDatabase repeats it under the transaction-scoped lock
    // immediately before its schema-qualified TRUNCATE.
    await queryAndAssertDatabaseIdentity(client, config);
    await resetDisposableDatabase(
      client,
      config,
      DISPOSABLE_DATABASE_RESET_TABLES,
    );
  } catch (error) {
    if (error instanceof DatabaseSafetyError) throw error;
    throw safeDatabaseOperationError("Disposable database reset", error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Look up the created user's id and organisation id by email. */
export async function getUserAndOrg(
  email: string,
): Promise<{ userId: string; organisationId: string }> {
  return withDb(async (client) => {
    const res = await client.query(
      `SELECT "id", "organisationId" FROM "User" WHERE "email" = $1`,
      [email.trim().toLowerCase()],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`getUserAndOrg: no user for ${email}`);
    return {
      userId: row.id as string,
      organisationId: row.organisationId as string,
    };
  });
}

export async function createVerifiedOwner(data: {
  email: string;
  password: string;
  name: string;
  organisationName: string;
}): Promise<{ userId: string; organisationId: string }> {
  const normalizedEmail = data.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(data.password, 12);
  const now = new Date();
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 14);

  return withDb(async (client) => {
    await client.query("BEGIN");
    try {
      const organisationId = testId("org");
      const organisationResult = await client.query<{ id: string }>(
        `INSERT INTO "Organisation" ("id", "name", "updatedAt") VALUES ($1, $2, $3) RETURNING "id"`,
        [organisationId, data.organisationName, now],
      );
      if (organisationResult.rows[0]?.id !== organisationId) {
        throw new Error(
          "createVerifiedOwner: organisation insert returned no id",
        );
      }

      const userId = testId("usr");
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt")
         VALUES ($1, $2, $3, $4, 'OWNER', $5, true, $6)
         RETURNING "id"`,
        [userId, normalizedEmail, data.name, passwordHash, organisationId, now],
      );
      if (userResult.rows[0]?.id !== userId)
        throw new Error("createVerifiedOwner: user insert returned no id");

      const subscriptionId = testId("sub");
      await client.query(
        `INSERT INTO "Subscription" ("id", "organisationId", "plan", "status", "trialEndsAt", "updatedAt")
         VALUES ($1, $2, 'ESSENTIALS', 'TRIALING', $3, $4)`,
        [subscriptionId, organisationId, trialEndsAt, now],
      );

      await client.query("COMMIT");
      return { userId, organisationId };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

/**
 * Create a verified MEMBER directly inside one already-proven disposable
 * organisation. Authorization tests use this narrow seam so they exercise the
 * MEMBER UI contract without coupling their result to the invitation journey.
 */
export async function createVerifiedMember(data: {
  email: string;
  name: string;
  organisationId: string;
}): Promise<{
  userId: string;
  organisationId: string;
  role: "MEMBER";
}> {
  const normalizedEmail = data.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(randomToken(32), 12);
  const userId = testId("usr");
  const now = new Date();

  return withDb(async (client) => {
    const result = await client.query<{
      id: string;
      organisationId: string;
      role: "MEMBER";
    }>(
      `INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt")
       SELECT $1, $2, $3, $4, 'MEMBER', "id", true, $6
         FROM "Organisation"
        WHERE "id" = $5
       RETURNING "id", "organisationId", "role"`,
      [
        userId,
        normalizedEmail,
        data.name,
        passwordHash,
        data.organisationId,
        now,
      ],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.id !== userId ||
      row.organisationId !== data.organisationId ||
      row.role !== "MEMBER"
    ) {
      throw new Error(
        "createVerifiedMember: disposable organisation was absent or the inserted tenant/role did not match",
      );
    }
    return {
      userId: row.id,
      organisationId: row.organisationId,
      role: row.role,
    };
  });
}

/**
 * Create a verified ADMIN directly inside one proven disposable organisation.
 * Lifecycle security integration tests use an ADMIN because the session must
 * be demonstrably authorised for both a representative read and write before
 * an owner suspends or removes it.
 */
export async function createVerifiedAdmin(data: {
  email: string;
  name: string;
  organisationId: string;
}): Promise<{
  userId: string;
  organisationId: string;
  role: "ADMIN";
}> {
  const normalizedEmail = data.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(randomToken(32), 12);
  const userId = testId("usr");
  const now = new Date();

  return withDb(async (client) => {
    const result = await client.query<{
      id: string;
      organisationId: string;
      role: "ADMIN";
    }>(
      `INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt")
       SELECT $1, $2, $3, $4, 'ADMIN', "id", true, $6
         FROM "Organisation"
        WHERE "id" = $5
       RETURNING "id", "organisationId", "role"`,
      [
        userId,
        normalizedEmail,
        data.name,
        passwordHash,
        data.organisationId,
        now,
      ],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.id !== userId ||
      row.organisationId !== data.organisationId ||
      row.role !== "ADMIN"
    ) {
      throw new Error(
        "createVerifiedAdmin: disposable organisation was absent or the inserted tenant/role did not match",
      );
    }
    return {
      userId: row.id,
      organisationId: row.organisationId,
      role: row.role,
    };
  });
}

export async function createAuthenticatedStorageState(data: {
  userId: string;
  organisationId: string;
  role?: "OWNER" | "ADMIN" | "MEMBER";
}): Promise<E2EStorageState> {
  const config = assertDirectDatabaseSeamAllowed();
  const sessionId = testId("sess");
  const refreshToken = randomToken(48);
  const accessToken = signLocalAccessToken(
    {
      userId: data.userId,
      organisationId: data.organisationId,
      role: data.role ?? "OWNER",
      sessionId,
    },
    config,
  );
  const now = new Date();
  const refreshExpiresAt = new Date(now);
  refreshExpiresAt.setDate(refreshExpiresAt.getDate() + 7);

  await withDb(async (client) => {
    await client.query(
      `INSERT INTO "AuthSession" ("id", "userId", "refreshTokenHash", "expiresAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, data.userId, sha256Hex(refreshToken), refreshExpiresAt, now],
    );
  });

  const accessExpiresAt = Math.floor((Date.now() + 15 * 60 * 1000) / 1000);
  const refreshCookieExpiresAt = Math.floor(refreshExpiresAt.getTime() / 1000);

  const webOrigin = new URL(config.webUrl).origin;
  const cookieDomain = config.cookieDomain;

  return {
    cookies: [
      {
        name: "charitypilot_access",
        value: accessToken,
        domain: cookieDomain,
        path: "/",
        expires: accessExpiresAt,
        httpOnly: true,
        secure: config.isRemote,
        sameSite: "Lax",
      },
      {
        name: "charitypilot_refresh",
        value: refreshToken,
        domain: cookieDomain,
        path: "/",
        expires: refreshCookieExpiresAt,
        httpOnly: true,
        secure: config.isRemote,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: webOrigin,
        localStorage: [{ name: "cookie-consent", value: "declined" }],
      },
    ],
  };
}

/**
 * Mark a user's email verified directly. Used by the shared-owner fixture to
 * skip the verification UI (the REAL verification flow is exercised end-to-end
 * by tests/auth.spec.ts via injectVerifyToken).
 */
export async function markEmailVerified(email: string): Promise<void> {
  const n = await withDb(async (client) => {
    const res = await client.query(
      `UPDATE "User" SET "emailVerified" = true, "verifyToken" = NULL, "verifyTokenExpiry" = NULL WHERE "email" = $1`,
      [email.trim().toLowerCase()],
    );
    return res.rowCount ?? 0;
  });
  if (n !== 1)
    throw new Error(
      `markEmailVerified: expected 1 row for ${email}, updated ${n}`,
    );
}

/**
 * Inject a known email-verification token for a user. The API stores
 * User.verifyToken as sha256(token) with a 24h expiry, so we set the hash of a
 * token we control and then drive /verify-email#token=<plaintext>.
 * Returns the plaintext token to navigate with.
 */
export async function injectVerifyToken(email: string): Promise<string> {
  const token = randomToken();
  const n = await withDb(async (client) => {
    const res = await client.query(
      `UPDATE "User"
         SET "verifyToken" = $1,
             "verifyTokenExpiry" = NOW() + INTERVAL '1 day',
             "emailVerified" = false
       WHERE "email" = $2`,
      [sha256Hex(token), email.trim().toLowerCase()],
    );
    return res.rowCount ?? 0;
  });
  if (n !== 1)
    throw new Error(
      `injectVerifyToken: expected 1 row for ${email}, updated ${n}`,
    );
  return token;
}

/**
 * Insert an accepted self-service recovery request with a controlled token.
 * All timeline values come from one database timestamp: PostgreSQL stores these
 * columns without a zone, so serialising the Windows host clock would introduce
 * a DST offset and could manufacture an impossible recovery timeline.
 */
export async function injectResetToken(email: string): Promise<string> {
  const config = assertDirectDatabaseSeamAllowed();
  const recoverySecret = process.env.E2E_AUTH_RECOVERY_SECRET?.trim();
  if (!recoverySecret) {
    throw new Error(
      "injectResetToken requires E2E_AUTH_RECOVERY_SECRET to match the isolated API runtime.",
    );
  }
  const normalizedEmail = email.trim().toLowerCase();
  const requestId = crypto.randomUUID();
  const material = createPasswordRecoveryTokenMaterial(requestId, recoverySecret);
  const identifierDigest = derivePasswordRecoveryRateDigest(
    "forgot-identifier",
    normalizedEmail,
    recoverySecret,
  );
  const requestIpDigest = derivePasswordRecoveryRateDigest(
    "forgot-ip",
    "127.0.0.1",
    recoverySecret,
  );
  const requestNetworkDigest = derivePasswordRecoveryRateDigest(
    "forgot-network",
    "127.0.0.1",
    recoverySecret,
  );
  const n = await withDb(async (client) => {
    const res = await client.query(
      `WITH locked_account AS MATERIALIZED (
         SELECT account."id", account."organisationId", account."email", account."name"
           FROM "User" AS account
           JOIN "Organisation" AS organisation
             ON organisation."id" = account."organisationId"
          WHERE account."email" = $10
            AND account."lifecycleStatus" = 'ACTIVE'
            AND organisation."lifecycleStatus" = 'ACTIVE'
          FOR UPDATE OF account
       ),
       database_clock AS MATERIALIZED (
         SELECT clock_timestamp()::timestamp(3) AS "now"
       )
       INSERT INTO "PasswordRecoveryRequest" (
         "id", "source", "organisationId", "userId",
         "identifierDigest", "requestIpDigest", "requestNetworkDigest", "rateKeyVersion",
         "tokenHash", "tokenNonce", "tokenKeyVersion",
         "recipientEmail", "recipientName", "frontendOrigin", "deliveryTemplateVersion",
         "deliveryState", "claimedAt", "deliveryAttemptedAt", "deliveryFinalizedAt",
         "deliveryAttemptCount", "providerMessageId", "expiresAt", "createdAt", "updatedAt"
       )
       SELECT $1, 'SELF_SERVICE_EMAIL', locked_account."organisationId", locked_account."id",
              $2, $3, $4, 1,
              $5, $6, $7,
              locked_account."email", locked_account."name", $8, 1,
              'ACCEPTED', database_clock."now", database_clock."now", database_clock."now",
              1, $9, database_clock."now" + INTERVAL '1 hour',
              database_clock."now", database_clock."now"
         FROM locked_account
         CROSS JOIN database_clock`,
      [
        requestId,
        identifierDigest,
        requestIpDigest,
        requestNetworkDigest,
        material.tokenHash,
        material.tokenNonceHex,
        material.tokenKeyVersion,
        config.webUrl,
        `e2e-password-recovery-${requestId}`,
        normalizedEmail,
      ],
    );
    return res.rowCount ?? 0;
  });
  if (n !== 1)
    throw new Error(
      `injectResetToken: expected 1 active account for ${email}, inserted ${n} recovery requests`,
    );
  return material.token;
}

export type PasswordRecoveryResetEvidence = {
  activeSessionCount: number;
  passwordResetSessionCount: number;
  outstandingRecoveryCount: number;
  completedRecoveryCount: number;
  resetAuditCount: number;
  completionOutboxCount: number;
  legacyResetSlotCleared: boolean;
  plaintextArtifactCount: number;
};

/** Read the atomic reset effects without exposing any stored credential material. */
export async function getPasswordRecoveryResetEvidence(
  email: string,
  plaintextToken: string,
): Promise<PasswordRecoveryResetEvidence> {
  return withDb(async (client) => {
    const result = await client.query<PasswordRecoveryResetEvidence>(
      `SELECT
         (SELECT COUNT(*)::INTEGER FROM "AuthSession" session
           WHERE session."userId" = account."id" AND session."revokedAt" IS NULL) AS "activeSessionCount",
         (SELECT COUNT(*)::INTEGER FROM "AuthSession" session
           WHERE session."userId" = account."id" AND session."revocationReason" = 'PASSWORD_RESET') AS "passwordResetSessionCount",
         (SELECT COUNT(*)::INTEGER FROM "PasswordRecoveryRequest" recovery
           WHERE recovery."userId" = account."id" AND recovery."terminatedAt" IS NULL
             AND recovery."expiresAt" > NOW()) AS "outstandingRecoveryCount",
         (SELECT COUNT(*)::INTEGER FROM "PasswordRecoveryRequest" recovery
           WHERE recovery."userId" = account."id"
             AND recovery."terminationReason" = 'PASSWORD_RESET_COMPLETED') AS "completedRecoveryCount",
         (SELECT COUNT(*)::INTEGER FROM "SecurityAuditEvent" event
           WHERE event."subjectUserId" = account."id"
             AND event."type" = 'ALL_SESSIONS_REVOKED'
             AND event."context" ->> 'eventKind' = 'PASSWORD_RESET_COMPLETED'
             AND event."context" ->> 'method' = 'PASSWORD_RECOVERY_LINK') AS "resetAuditCount",
         (SELECT COUNT(*)::INTEGER FROM "AuthSecurityEmailOutbox" outbox
           WHERE outbox."userId" = account."id"
             AND outbox."kind" = 'PASSWORD_RESET_COMPLETED_NOTICE') AS "completionOutboxCount",
         (account."resetToken" IS NULL AND account."resetTokenExpiry" IS NULL) AS "legacyResetSlotCleared",
          (
            SELECT COALESCE(SUM(artifact."matches"), 0)::INTEGER
            FROM (
              SELECT COUNT(*)::BIGINT AS "matches"
              FROM "PasswordRecoveryRequest" recovery
              WHERE recovery."userId" = account."id"
                AND (
                  recovery."tokenHash" = $2
                  OR recovery."tokenNonce" = $2
                  OR recovery."recipientEmail" = $2
                  OR recovery."recipientName" = $2
                  OR recovery."providerMessageId" = $2
                  OR recovery."identifierDigest" = $2
                  OR recovery."requestIpDigest" = $2
                  OR recovery."requestNetworkDigest" = $2
                )
              UNION ALL
              SELECT COUNT(*)::BIGINT
              FROM "SecurityAuditEvent" event
              WHERE event."subjectUserId" = account."id"
                AND (
                  event."reason" = $2
                  OR event."subjectLabel" = $2
                  OR POSITION($2 IN event."context"::text) > 0
                )
              UNION ALL
              SELECT COUNT(*)::BIGINT
              FROM "AuthSecurityEmailOutbox" outbox
              WHERE outbox."userId" = account."id"
                AND (
                  outbox."recipientEmail" = $2
                  OR outbox."recipientName" = $2
                  OR outbox."providerMessageId" = $2
                )
              UNION ALL
              SELECT COUNT(*)::BIGINT
              FROM "User" credential_owner
              WHERE credential_owner."id" = account."id"
                AND credential_owner."resetToken" = $2
              UNION ALL
              SELECT COUNT(*)::BIGINT
              FROM "AuthRecoveryRateLimitBucket" bucket
              WHERE bucket."subjectDigest" = $2
            ) artifact
          ) AS "plaintextArtifactCount"
       FROM "User" AS account
       WHERE account."email" = $1`,
      [email.trim().toLowerCase(), plaintextToken],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`getPasswordRecoveryResetEvidence: account not found for ${email}`);
    return row;
  });
}

/** Read whether a user's email is verified (for assertions). */
export async function isEmailVerified(email: string): Promise<boolean> {
  return withDb(async (client) => {
    const res = await client.query(
      `SELECT "emailVerified" FROM "User" WHERE "email" = $1`,
      [email.trim().toLowerCase()],
    );
    return Boolean(res.rows[0]?.emailVerified);
  });
}

/**
 * Set a known plaintext token on the most recent (single, post-reset) team
 * invite for an email. TeamInvite.token is stored as a sha256 hash
 * (team.service.ts:304) and acceptInvite looks it up by hash
 * (team.service.ts:410-414), so to drive /accept-invite#token=<plaintext> the
 * test sends a real invite via the UI, then overwrites its token hash here.
 * Returns the plaintext to navigate with.
 */
export async function setInviteToken(email: string): Promise<string> {
  const token = randomToken();
  const n = await withDb(async (client) => {
    const res = await client.query(
      `UPDATE "TeamInvite"
         SET "token" = $1,
             "expiresAt" = NOW() + INTERVAL '7 days',
             "acceptedAt" = NULL,
             "revokedAt" = NULL
       WHERE "email" = $2`,
      [sha256Hex(token), email.trim().toLowerCase()],
    );
    return res.rowCount ?? 0;
  });
  if (n !== 1)
    throw new Error(
      `setInviteToken: expected 1 invite for ${email}, updated ${n}`,
    );
  return token;
}

/** Resolve a governance principle's cuid by its stable `number` (1..6). */
export async function getPrincipleIdByNumber(num: number): Promise<string> {
  return withDb(async (client) => {
    const res = await client.query(
      `SELECT "id" FROM "GovernancePrinciple" WHERE "number" = $1`,
      [num],
    );
    const id = res.rows[0]?.id;
    if (!id)
      throw new Error(
        `getPrincipleIdByNumber: no principle number ${num} (is reference data seeded?)`,
      );
    return id as string;
  });
}

/** Read a compliance record for an org + standard code + year (for DB assertions). */
export async function getComplianceRecord(
  organisationId: string,
  standardCode: string,
  reportingYear: number,
): Promise<{ status: string; actionTaken: string | null } | null> {
  return withDb(async (client) => {
    const res = await client.query(
      `SELECT cr."status", cr."actionTaken"
         FROM "ComplianceRecord" cr
         JOIN "GovernanceStandard" gs ON gs."id" = cr."standardId"
        WHERE cr."organisationId" = $1 AND gs."code" = $2 AND cr."reportingYear" = $3`,
      [organisationId, standardCode, reportingYear],
    );
    return res.rows[0] ?? null;
  });
}

/** Read the compliance sign-off for an org + year (for DB assertions). */
export async function getSignoff(
  organisationId: string,
  reportingYear: number,
): Promise<{
  status: string;
  approvedByName: string | null;
  approvedAt: Date | null;
} | null> {
  return withDb(async (client) => {
    const res = await client.query(
      `SELECT "status", "approvedByName", "approvedAt"
         FROM "ComplianceSignoff"
        WHERE "organisationId" = $1 AND "reportingYear" = $2`,
      [organisationId, reportingYear],
    );
    return res.rows[0] ?? null;
  });
}

/** Count rows in a table (handy for asserting side effects). */
export async function countRows(
  table: string,
  whereSql = "",
  params: unknown[] = [],
): Promise<number> {
  return withDb(async (client) => {
    const res = await client.query(
      `SELECT COUNT(*)::int AS n FROM "${table}" ${whereSql}`,
      params,
    );
    return res.rows[0]?.n ?? 0;
  });
}
