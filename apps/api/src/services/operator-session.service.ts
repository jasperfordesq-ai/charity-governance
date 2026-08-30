import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { signOperatorAccessToken } from '../utils/owner-jwt.js';

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_DAYS = 7;

export type OperatorTokens = {
  accessToken: string;
  refreshToken: string;
};

export function hashOperatorToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function operatorRefreshMaxAgeSeconds(): number {
  return REFRESH_TOKEN_DAYS * 24 * 60 * 60;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + operatorRefreshMaxAgeSeconds() * 1000);
}

export async function issueOperatorSession(
  prisma: PrismaClient,
  operatorId: string,
): Promise<OperatorTokens> {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

  const session = await prisma.platformOperatorSession.create({
    data: { operatorId, tokenHash: hashOperatorToken(refreshToken), expiresAt: refreshExpiry() },
  });

  return {
    accessToken: signOperatorAccessToken({ operatorId, sessionId: session.id }),
    refreshToken,
  };
}

export async function rotateOperatorSession(
  prisma: PrismaClient,
  refreshToken: string,
): Promise<OperatorTokens> {
  const existing = await prisma.platformOperatorSession.findFirst({
    where: { tokenHash: hashOperatorToken(refreshToken), revokedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!existing) {
    throw new AppError(401, 'INVALID_OPERATOR_REFRESH', 'INVALID_OPERATOR_REFRESH');
  }

  await prisma.platformOperatorSession.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  return issueOperatorSession(prisma, existing.operatorId);
}

export async function revokeOperatorSession(
  prisma: PrismaClient,
  refreshToken: string,
): Promise<void> {
  const existing = await prisma.platformOperatorSession.findFirst({
    where: { tokenHash: hashOperatorToken(refreshToken), revokedAt: null },
  });
  if (!existing) return;

  await prisma.platformOperatorSession.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });
}
