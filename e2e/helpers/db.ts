import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';

import { IS_DEPLOYED_QA } from '../env';

type E2EStorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax' | 'Strict' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
};

/**
 * Direct Postgres access for the E2E harness.
 *
 * The local Docker stack publishes Postgres on host port 5434 (compose.yml),
 * with the dev credentials from compose.local.yml. We use this connection for
 * two things only:
 *   1. Resetting the database to a clean state at the start of a run.
 *   2. Reading/injecting one-time tokens and flags that, in production, would
 *      be delivered by email — locally email delivery is a no-op and the
 *      verify/invite tokens are stored as sha256 hashes, so the plaintext is
 *      otherwise unrecoverable.
 */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://charitypilot:charitypilot_dev@localhost:5434/charitypilot';

function assertLocalDatabaseSeamAllowed(): void {
  if (IS_DEPLOYED_QA) {
    throw new Error(
      'E2E_DEPLOYED_QA=true forbids direct database access. Use the approved deployed QA credentials instead of local DB reset/token seams.',
    );
  }
}

/**
 * Tenant/app tables truncated on reset. The seeded governance reference data
 * (GovernancePrinciple, GovernanceStandard) is deliberately PRESERVED so the
 * compliance journeys have standards to work against without re-seeding.
 * (Confirmed against apps/api/prisma/seed.ts + schema.prisma — see e2e/README.md.)
 */
const APP_TABLES = [
  'Organisation',
  'User',
  'AuthSession',
  'ComplianceRecord',
  'ComplianceSignoff',
  'BoardMember',
  'Document',
  'DocumentStandardLink',
  'DocumentStorageDeletion',
  'ConflictRecord',
  'RiskRecord',
  'ComplaintRecord',
  'FundraisingRecord',
  'AnnualReportReadiness',
  'FinancialControlReview',
  'Deadline',
  'TeamInvite',
  'DeadlineReminderLog',
  'Subscription',
  'StripeWebhookEvent',
];

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  assertLocalDatabaseSeamAllowed();
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** sha256 hex — mirrors hashOpaqueToken in apps/api/src/services/session-tokens.ts:38-40. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** A random URL-safe opaque token, like the API's crypto.randomBytes(...).toString('base64url'). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function testId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signLocalAccessToken(payload: {
  userId: string;
  organisationId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  sessionId: string;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: nowSeconds,
    exp: nowSeconds + 15 * 60,
    iss: 'charitypilot-api',
    aud: 'charitypilot-web',
  };
  const encodedHeader = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const encodedBody = base64UrlJson(body);
  const signature = crypto
    .createHmac('sha256', process.env.E2E_JWT_SECRET ?? 'local-dev-jwt-secret-at-least-32-characters')
    .update(`${encodedHeader}.${encodedBody}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

/**
 * Truncate all tenant/app tables, preserving seeded governance reference data.
 * CASCADE handles foreign-key dependents (org-scoped FKs default to Restrict);
 * RESTART IDENTITY resets sequences.
 */
export async function resetDb(): Promise<void> {
  await withDb(async (client) => {
    const list = APP_TABLES.map((t) => `"${t}"`).join(', ');
    await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
  });
}

/** Look up the created user's id and organisation id by email. */
export async function getUserAndOrg(email: string): Promise<{ userId: string; organisationId: string }> {
  return withDb(async (client) => {
    const res = await client.query(
      `SELECT "id", "organisationId" FROM "User" WHERE "email" = $1`,
      [email.trim().toLowerCase()],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`getUserAndOrg: no user for ${email}`);
    return { userId: row.id as string, organisationId: row.organisationId as string };
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
    await client.query('BEGIN');
    try {
      const organisationId = testId('org');
      const organisationResult = await client.query<{ id: string }>(
        `INSERT INTO "Organisation" ("id", "name", "updatedAt") VALUES ($1, $2, $3) RETURNING "id"`,
        [organisationId, data.organisationName, now],
      );
      if (organisationResult.rows[0]?.id !== organisationId) {
        throw new Error('createVerifiedOwner: organisation insert returned no id');
      }

      const userId = testId('usr');
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt")
         VALUES ($1, $2, $3, $4, 'OWNER', $5, true, $6)
         RETURNING "id"`,
        [userId, normalizedEmail, data.name, passwordHash, organisationId, now],
      );
      if (userResult.rows[0]?.id !== userId) throw new Error('createVerifiedOwner: user insert returned no id');

      const subscriptionId = testId('sub');
      await client.query(
        `INSERT INTO "Subscription" ("id", "organisationId", "plan", "status", "trialEndsAt", "updatedAt")
         VALUES ($1, $2, 'ESSENTIALS', 'TRIALING', $3, $4)`,
        [subscriptionId, organisationId, trialEndsAt, now],
      );

      await client.query('COMMIT');
      return { userId, organisationId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export async function createAuthenticatedStorageState(data: {
  userId: string;
  organisationId: string;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
}): Promise<E2EStorageState> {
  assertLocalDatabaseSeamAllowed();
  const sessionId = testId('sess');
  const refreshToken = randomToken(48);
  const accessToken = signLocalAccessToken({
    userId: data.userId,
    organisationId: data.organisationId,
    role: data.role ?? 'OWNER',
    sessionId,
  });
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

  const webOrigin = new URL(process.env.E2E_WEB_URL ?? 'http://localhost:3003').origin;

  return {
    cookies: [
      {
        name: 'charitypilot_access',
        value: accessToken,
        domain: 'localhost',
        path: '/',
        expires: accessExpiresAt,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
      {
        name: 'charitypilot_refresh',
        value: refreshToken,
        domain: 'localhost',
        path: '/',
        expires: refreshCookieExpiresAt,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: webOrigin,
        localStorage: [{ name: 'cookie-consent', value: 'declined' }],
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
  if (n !== 1) throw new Error(`markEmailVerified: expected 1 row for ${email}, updated ${n}`);
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
  if (n !== 1) throw new Error(`injectVerifyToken: expected 1 row for ${email}, updated ${n}`);
  return token;
}

/** Read whether a user's email is verified (for assertions). */
export async function isEmailVerified(email: string): Promise<boolean> {
  return withDb(async (client) => {
    const res = await client.query(`SELECT "emailVerified" FROM "User" WHERE "email" = $1`, [
      email.trim().toLowerCase(),
    ]);
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
  if (n !== 1) throw new Error(`setInviteToken: expected 1 invite for ${email}, updated ${n}`);
  return token;
}

/** Resolve a governance principle's cuid by its stable `number` (1..6). */
export async function getPrincipleIdByNumber(num: number): Promise<string> {
  return withDb(async (client) => {
    const res = await client.query(`SELECT "id" FROM "GovernancePrinciple" WHERE "number" = $1`, [num]);
    const id = res.rows[0]?.id;
    if (!id) throw new Error(`getPrincipleIdByNumber: no principle number ${num} (is reference data seeded?)`);
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
): Promise<{ status: string; approvedByName: string | null; approvedAt: Date | null } | null> {
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
export async function countRows(table: string, whereSql = '', params: unknown[] = []): Promise<number> {
  return withDb(async (client) => {
    const res = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}" ${whereSql}`, params);
    return res.rows[0]?.n ?? 0;
  });
}
