import crypto from 'node:crypto';
import { Client } from 'pg';

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
