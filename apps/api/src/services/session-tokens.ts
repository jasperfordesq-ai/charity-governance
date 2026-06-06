import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { signAccessToken, type TokenPayload } from '../utils/jwt.js';
import { AppError } from '../utils/errors.js';

type SessionUser = {
  id: string;
  organisationId: string;
  role: TokenPayload['role'];
};

type SessionRow = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

const REFRESH_TOKEN_BYTES = 48;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 7;

function refreshTokenTtlDays(): number {
  const configured = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? DEFAULT_REFRESH_TOKEN_TTL_DAYS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_REFRESH_TOKEN_TTL_DAYS;
  return Math.min(configured, 30);
}

function refreshTokenExpiresAt(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + refreshTokenTtlDays());
  return expiresAt;
}

export function refreshTokenMaxAgeSeconds(): number {
  return refreshTokenTtlDays() * 24 * 60 * 60;
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createAccessToken(user: SessionUser, sessionId: string): string {
  return signAccessToken({
    userId: user.id,
    organisationId: user.organisationId,
    role: user.role,
    sessionId,
  });
}

async function createSession(prisma: PrismaClient, userId: string, refreshTokenHash: string): Promise<string> {
  const session = await prisma.authSession.create({
    data: {
      userId,
      refreshTokenHash,
      expiresAt: refreshTokenExpiresAt(),
    },
    select: { id: true },
  });

  return session.id;
}

export async function issueSessionTokens(prisma: PrismaClient, user: SessionUser) {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const sessionId = await createSession(prisma, user.id, hashOpaqueToken(refreshToken));

  return {
    accessToken: createAccessToken(user, sessionId),
    refreshToken,
  };
}

export async function rotateSessionTokens(prisma: PrismaClient, refreshToken: string) {
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const sessions = await prisma.$queryRaw<SessionRow[]>`
    SELECT "id", "userId", "expiresAt", "revokedAt"
    FROM "AuthSession"
    WHERE "refreshTokenHash" = ${refreshTokenHash}
    LIMIT 1
  `;
  const session = sessions[0];

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
  });

  if (!user) {
    throw new AppError(401, 'USER_NOT_FOUND', 'User no longer exists');
  }

  const nextRefreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const nextRefreshTokenHash = hashOpaqueToken(nextRefreshToken);
  const now = new Date();
  let nextSessionId = '';

  await prisma.$transaction(async (tx) => {
    const revoked = await tx.authSession.updateMany({
      where: {
        id: session.id,
        refreshTokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        revokedAt: now,
      },
    });

    if (revoked.count !== 1) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
    }

    const nextSession = await tx.authSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: nextRefreshTokenHash,
        expiresAt: refreshTokenExpiresAt(),
      },
      select: { id: true },
    });
    nextSessionId = nextSession.id;
  });

  return {
    accessToken: createAccessToken(user, nextSessionId),
    refreshToken: nextRefreshToken,
  };
}

export async function revokeSessionToken(prisma: PrismaClient, refreshToken: string): Promise<void> {
  const now = new Date();
  await prisma.$executeRaw`
    UPDATE "AuthSession"
    SET "revokedAt" = ${now}, "updatedAt" = ${now}
    WHERE "refreshTokenHash" = ${hashOpaqueToken(refreshToken)} AND "revokedAt" IS NULL
  `;
}

export async function revokeUserSessions(prisma: PrismaClient, userId: string): Promise<void> {
  const now = new Date();
  await prisma.$executeRaw`
    UPDATE "AuthSession"
    SET "revokedAt" = ${now}, "updatedAt" = ${now}
    WHERE "userId" = ${userId} AND "revokedAt" IS NULL
  `;
}
