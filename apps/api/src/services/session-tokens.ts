import crypto from 'node:crypto';
import {
  Prisma,
  type AuthSessionRevocationReason,
  type PrismaClient,
} from '@prisma/client';
import { signAccessToken, type TokenPayload } from '../utils/jwt.js';
import { AppError } from '../utils/errors.js';

type SessionUser = {
  id: string;
  organisationId: string;
  role: TokenPayload['role'];
};

type LoginSessionUser = SessionUser & {
  passwordHash: string;
};

type SessionLocatorRow = {
  id: string;
  userId: string;
  familyId: string;
};

type LockedPrincipalRow = {
  id: string;
  organisationId: string;
  role: TokenPayload['role'];
  userLifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  organisationLifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
};

type LockedIssuancePrincipalRow = LockedPrincipalRow & {
  passwordHash: string;
};

type LockedFamilyRow = LockedPrincipalRow & {
  sessionId: string;
  refreshTokenHash: string;
  familyId: string;
  familyCreatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

type SessionClient = PrismaClient | Prisma.TransactionClient;

const REFRESH_TOKEN_BYTES = 48;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 7;

function refreshTokenTtlDays(): number {
  const configured = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? DEFAULT_REFRESH_TOKEN_TTL_DAYS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_REFRESH_TOKEN_TTL_DAYS;
  return Math.min(configured, 30);
}

function refreshTokenExpiresAt(now = new Date()): Date {
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + refreshTokenTtlDays());
  return expiresAt;
}

export function refreshTokenMaxAgeSeconds(): number {
  return refreshTokenTtlDays() * 24 * 60 * 60;
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function invalidRefreshToken(): AppError {
  return new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
}

function invalidLoginCredentials(): AppError {
  return new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
}

function createAccessToken(user: SessionUser, sessionId: string): string {
  return signAccessToken({
    userId: user.id,
    organisationId: user.organisationId,
    role: user.role,
    sessionId,
  });
}

async function lockActivePrincipal(
  client: SessionClient,
  userId: string,
  expectedOrganisationId?: string,
  expectedPasswordHash?: string,
): Promise<SessionUser> {
  // MATERIALIZED CTEs make the lock order explicit while FOR SHARE permits
  // unrelated users in one organisation to establish sessions concurrently.
  // Lifecycle writers take FOR UPDATE and therefore cannot pass this boundary
  // until the issuance/rotation transaction has committed.
  const principals = await client.$queryRaw<LockedIssuancePrincipalRow[]>`
    WITH principal_organisation AS MATERIALIZED (
      SELECT "organisationId"
      FROM "User"
      WHERE "id" = ${userId}
    ),
    locked_organisation AS MATERIALIZED (
      SELECT organisation."id", organisation."lifecycleStatus"
      FROM "Organisation" AS organisation
      JOIN principal_organisation
        ON principal_organisation."organisationId" = organisation."id"
      FOR SHARE OF organisation
    ),
    locked_user AS MATERIALIZED (
      SELECT
        account."id", account."organisationId", account."role",
        account."passwordHash", account."lifecycleStatus"
      FROM "User" AS account
      JOIN locked_organisation
        ON locked_organisation."id" = account."organisationId"
      WHERE account."id" = ${userId}
      FOR SHARE OF account
    )
    SELECT
      locked_user."id",
      locked_user."organisationId",
      locked_user."role",
      locked_user."passwordHash",
      locked_user."lifecycleStatus" AS "userLifecycleStatus",
      locked_organisation."lifecycleStatus" AS "organisationLifecycleStatus"
    FROM locked_user
    JOIN locked_organisation
      ON locked_organisation."id" = locked_user."organisationId"
  `;
  const principal = principals[0];

  if (
    !principal ||
    principal.userLifecycleStatus !== 'ACTIVE' ||
    principal.organisationLifecycleStatus !== 'ACTIVE' ||
    (expectedOrganisationId && principal.organisationId !== expectedOrganisationId) ||
    (expectedPasswordHash !== undefined && principal.passwordHash !== expectedPasswordHash)
  ) {
    throw expectedPasswordHash === undefined
      ? invalidRefreshToken()
      : invalidLoginCredentials();
  }

  return {
    id: principal.id,
    organisationId: principal.organisationId,
    role: principal.role,
  };
}

async function lockPrincipalAndFamily(
  tx: Prisma.TransactionClient,
  locator: SessionLocatorRow,
): Promise<LockedFamilyRow[]> {
  // Lock the organisation and user before any family row. All lifecycle and
  // administrative session mutations use the same order.
  return tx.$queryRaw<LockedFamilyRow[]>`
    WITH principal_organisation AS MATERIALIZED (
      SELECT "organisationId"
      FROM "User"
      WHERE "id" = ${locator.userId}
    ),
    locked_organisation AS MATERIALIZED (
      SELECT organisation."id", organisation."lifecycleStatus"
      FROM "Organisation" AS organisation
      JOIN principal_organisation
        ON principal_organisation."organisationId" = organisation."id"
      FOR SHARE OF organisation
    ),
    locked_user AS MATERIALIZED (
      SELECT account."id", account."organisationId", account."role", account."lifecycleStatus"
      FROM "User" AS account
      JOIN locked_organisation
        ON locked_organisation."id" = account."organisationId"
      WHERE account."id" = ${locator.userId}
      FOR SHARE OF account
    ),
    locked_family AS MATERIALIZED (
      SELECT
        session."id",
        session."refreshTokenHash",
        session."familyId",
        session."familyCreatedAt",
        session."expiresAt",
        session."revokedAt"
      FROM "AuthSession" AS session
      JOIN locked_user ON locked_user."id" = session."userId"
      WHERE session."familyId" = ${locator.familyId}::uuid
      ORDER BY session."id"
      FOR UPDATE OF session
    )
    SELECT
      locked_user."id",
      locked_user."organisationId",
      locked_user."role",
      locked_user."lifecycleStatus" AS "userLifecycleStatus",
      locked_organisation."lifecycleStatus" AS "organisationLifecycleStatus",
      locked_family."id" AS "sessionId",
      locked_family."refreshTokenHash",
      locked_family."familyId",
      locked_family."familyCreatedAt",
      locked_family."expiresAt",
      locked_family."revokedAt"
    FROM locked_family
    JOIN locked_user ON true
    JOIN locked_organisation
      ON locked_organisation."id" = locked_user."organisationId"
  `;
}

async function issueSessionTokensWithClient(
  client: SessionClient,
  expectedUser: SessionUser,
  expectedPasswordHash?: string,
) {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const familyId = crypto.randomUUID();
  const issuedAt = new Date();

  const user = await lockActivePrincipal(
    client,
    expectedUser.id,
    expectedUser.organisationId,
    expectedPasswordHash,
  );
  const session = await client.authSession.create({
    data: {
      userId: user.id,
      refreshTokenHash,
      familyId,
      // Let PostgreSQL assign familyCreatedAt and createdAt from the same
      // CURRENT_TIMESTAMP. Supplying an application-host timestamp here can
      // put the family start fractionally after the database-created row.
      expiresAt: refreshTokenExpiresAt(issuedAt),
    },
    select: { id: true },
  });

  return {
    accessToken: createAccessToken(user, session.id),
    refreshToken,
  };
}

export async function issueSessionTokensInTransaction(
  tx: Prisma.TransactionClient,
  expectedUser: SessionUser,
) {
  return issueSessionTokensWithClient(tx, expectedUser);
}

export async function issueSessionTokens(prisma: PrismaClient, expectedUser: SessionUser) {
  return prisma.$transaction((tx) => issueSessionTokensWithClient(tx, expectedUser));
}

/**
 * Establish a login session only if the password credential verified before
 * bcrypt comparison is still the live credential under the principal lock.
 * A concurrent password reset therefore either commits first and prevents
 * issuance, or waits for issuance and then revokes the newly-created session.
 */
export async function issueLoginSessionTokens(
  prisma: PrismaClient,
  expectedUser: LoginSessionUser,
) {
  return prisma.$transaction((tx) => issueSessionTokensWithClient(
    tx,
    expectedUser,
    expectedUser.passwordHash,
  ));
}

export async function rotateSessionTokens(prisma: PrismaClient, refreshToken: string) {
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const locators = await prisma.$queryRaw<SessionLocatorRow[]>`
    SELECT "id", "userId", "familyId"
    FROM "AuthSession"
    WHERE "refreshTokenHash" = ${refreshTokenHash}
    LIMIT 1
  `;
  const locator = locators[0];
  if (!locator) throw invalidRefreshToken();

  const nextRefreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const nextRefreshTokenHash = hashOpaqueToken(nextRefreshToken);

  const outcome = await prisma.$transaction(async (tx) => {
    const family = await lockPrincipalAndFamily(tx, locator);
    const session = family.find(
      (candidate) =>
        candidate.sessionId === locator.id &&
        candidate.refreshTokenHash === refreshTokenHash,
    );

    if (!session) return { kind: 'invalid' as const };

    if (
      session.userLifecycleStatus !== 'ACTIVE' ||
      session.organisationLifecycleStatus !== 'ACTIVE'
    ) {
      return { kind: 'invalid' as const };
    }

    const now = new Date();
    if (session.revokedAt) {
      await tx.authSession.updateMany({
        where: {
          userId: session.id,
          familyId: session.familyId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
          revocationReason: 'REFRESH_REUSE',
        },
      });
      return { kind: 'replay' as const };
    }

    if (session.expiresAt <= now) return { kind: 'invalid' as const };

    await tx.authSession.update({
      where: { id: session.sessionId },
      data: {
        revokedAt: now,
        revocationReason: 'ROTATED',
      },
    });

    const nextSession = await tx.authSession.create({
      data: {
        userId: session.id,
        refreshTokenHash: nextRefreshTokenHash,
        familyId: session.familyId,
        familyCreatedAt: session.familyCreatedAt,
        expiresAt: refreshTokenExpiresAt(now),
      },
      select: { id: true },
    });

    return {
      kind: 'rotated' as const,
      sessionId: nextSession.id,
      user: {
        id: session.id,
        organisationId: session.organisationId,
        role: session.role,
      },
    };
  });

  // Replay quarantine must commit before its public rejection is raised.
  if (outcome.kind !== 'rotated') throw invalidRefreshToken();

  return {
    accessToken: createAccessToken(outcome.user, outcome.sessionId),
    refreshToken: nextRefreshToken,
  };
}

export async function revokeSessionToken(
  client: SessionClient,
  refreshToken: string,
  reason: AuthSessionRevocationReason,
): Promise<void> {
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const revokeLockedFamily = async (tx: Prisma.TransactionClient) => {
    const locators = await tx.$queryRaw<SessionLocatorRow[]>`
      SELECT "id", "userId", "familyId"
      FROM "AuthSession"
      WHERE "refreshTokenHash" = ${refreshTokenHash}
      LIMIT 1
    `;
    const locator = locators[0];

    // Logout is deliberately idempotent. An unknown token must not disclose
    // whether a session ever existed and has no family that can be locked.
    if (!locator) return;

    const family = await lockPrincipalAndFamily(tx, locator);
    const presentedSession = family.find(
      (candidate) =>
        candidate.sessionId === locator.id &&
        candidate.refreshTokenHash === refreshTokenHash,
    );

    // The row may have been deleted between the non-locking locator read and
    // the ordered locks. Treat that exactly like an unknown token.
    if (!presentedSession) return;

    // Revoke the whole family, not just the presented row. If rotation won the
    // race, its successor is now covered; if logout won, rotation observes the
    // revoked original under the same family lock and cannot mint a successor.
    await tx.authSession.updateMany({
      where: {
        userId: presentedSession.id,
        familyId: presentedSession.familyId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revocationReason: reason,
      },
    });
  };

  if ('$transaction' in client) {
    await client.$transaction(revokeLockedFamily);
    return;
  }

  await revokeLockedFamily(client);
}

export async function revokeSessionFamily(
  client: SessionClient,
  userId: string,
  familyId: string,
  reason: AuthSessionRevocationReason,
): Promise<number> {
  const revoked = await client.authSession.updateMany({
    where: { userId, familyId, revokedAt: null },
    data: { revokedAt: new Date(), revocationReason: reason },
  });
  return revoked.count;
}

export async function revokeUserSessions(
  client: SessionClient,
  userId: string,
  reason: AuthSessionRevocationReason,
): Promise<number> {
  const revoked = await client.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revocationReason: reason },
  });
  return revoked.count;
}
