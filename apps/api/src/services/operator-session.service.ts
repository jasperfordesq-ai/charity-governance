import crypto from 'node:crypto';
import type {
  OperatorSessionAccessLevel,
  OperatorSessionClientKind,
  PrismaClient,
} from '@prisma/client';
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

/**
 * The posture a session is minted with.
 *
 * `clientKind` is decided by the route, never by anything the caller sends, so
 * a browser cannot mint a connector session and the connector cannot mint a
 * web one. `accessLevel` does come from the body on the connector route, which
 * is safe only because the password and the second factor gate it.
 */
export interface OperatorSessionPosture {
  clientKind: OperatorSessionClientKind;
  accessLevel: OperatorSessionAccessLevel;
}

/** What a rotation must carry forward, read from the row being replaced. */
interface OperatorSessionFamily extends OperatorSessionPosture {
  operatorId: string;
  familyId: string;
  familyCreatedAt: Date;
}

const WEB_POSTURE: OperatorSessionPosture = { clientKind: 'WEB', accessLevel: 'ADMIN' };

export async function issueOperatorSession(
  prisma: PrismaClient,
  operatorId: string,
  // Absent means the browser console, which is what every caller predating the
  // connector meant. Spelled out rather than implied, so a new caller that
  // forgets is a web session rather than whatever the last one used.
  posture: OperatorSessionPosture = WEB_POSTURE,
  // Present only on a rotation: a successor joins the family it replaces.
  family?: { familyId: string; familyCreatedAt: Date },
): Promise<OperatorTokens> {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

  const session = await prisma.platformOperatorSession.create({
    data: {
      operatorId,
      tokenHash: hashOperatorToken(refreshToken),
      expiresAt: refreshExpiry(),
      clientKind: posture.clientKind,
      accessLevel: posture.accessLevel,
      ...(family ? { familyId: family.familyId, familyCreatedAt: family.familyCreatedAt } : {}),
    },
  });

  return {
    accessToken: signOperatorAccessToken({ operatorId, sessionId: session.id }),
    refreshToken,
  };
}

/**
 * Rotates one session, carrying its posture and its family forward.
 *
 * `expectedClientKind` is what makes a stolen console credential useless to the
 * connector and a connector credential useless in the console. The refusal is
 * the same opaque one an unknown token gets, so the attempt learns nothing.
 *
 * Carrying the posture is not an optimisation. `guard_platform_operator_session`
 * pins a family to one posture, so a rotation that dropped it would fail the
 * insert — which is the point: the failure is loud rather than a read-only
 * session quietly coming back with full authority.
 */
export async function rotateOperatorSession(
  prisma: PrismaClient,
  refreshToken: string,
  expectedClientKind: OperatorSessionClientKind = 'WEB',
): Promise<OperatorTokens> {
  const now = new Date();
  const tokenHash = hashOperatorToken(refreshToken);

  // Read before claiming, so the client kind is checked against the row that
  // is about to be spent rather than against whatever is left afterwards.
  const existing = (await prisma.platformOperatorSession.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
    select: {
      operatorId: true,
      clientKind: true,
      accessLevel: true,
      familyId: true,
      familyCreatedAt: true,
    },
  })) as OperatorSessionFamily | null;

  if (!existing || existing.clientKind !== expectedClientKind) {
    throw new AppError(401, 'INVALID_OPERATOR_REFRESH', 'Invalid or expired session');
  }

  // Claimed with the same conditions it was read under, so two rotations
  // racing for one token cannot both succeed.
  const claimed = await prisma.platformOperatorSession.updateMany({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  });

  if (claimed.count !== 1) {
    throw new AppError(401, 'INVALID_OPERATOR_REFRESH', 'Invalid or expired session');
  }

  return issueOperatorSession(
    prisma,
    existing.operatorId,
    { clientKind: existing.clientKind, accessLevel: existing.accessLevel },
    { familyId: existing.familyId, familyCreatedAt: existing.familyCreatedAt },
  );
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
