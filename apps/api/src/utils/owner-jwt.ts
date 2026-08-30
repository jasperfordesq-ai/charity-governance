import jwt from 'jsonwebtoken';

const OWNER_TOKEN_ALGORITHM = 'HS256';
const OWNER_TOKEN_ISSUER = 'charitypilot-owner-api';
const OWNER_TOKEN_AUDIENCE = 'charitypilot-owner';
const OWNER_TOKEN_EXPIRY = '30m';

export interface OperatorTokenPayload {
  operatorId: string;
  sessionId: string;
}

// Resolved lazily, never at module load. Personal-server installs never set
// OWNER_JWT_SECRET and must still boot: a module-load requireEnv (as in
// utils/jwt.ts) would crash them on import.
function ownerSecret(): string {
  const value = process.env.OWNER_JWT_SECRET;
  if (!value) {
    throw new Error('FATAL: OWNER_JWT_SECRET environment variable must be set to use the owner console.');
  }
  return value;
}

export function assertOwnerJwtSecretConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const secret = env.OWNER_JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: OWNER_JWT_SECRET must be set when the owner console is enabled.');
  }
  if (secret === env.JWT_SECRET) {
    throw new Error('FATAL: OWNER_JWT_SECRET must not equal JWT_SECRET; the two-secret isolation would be lost.');
  }
}

export function signOperatorAccessToken(payload: OperatorTokenPayload): string {
  return jwt.sign(payload, ownerSecret(), {
    algorithm: OWNER_TOKEN_ALGORITHM,
    issuer: OWNER_TOKEN_ISSUER,
    audience: OWNER_TOKEN_AUDIENCE,
    expiresIn: OWNER_TOKEN_EXPIRY,
  });
}

export function verifyOperatorAccessToken(token: string): OperatorTokenPayload {
  const decoded = jwt.verify(token, ownerSecret(), {
    algorithms: [OWNER_TOKEN_ALGORITHM],
    issuer: OWNER_TOKEN_ISSUER,
    audience: OWNER_TOKEN_AUDIENCE,
  });

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Invalid operator token payload');
  }

  const payload = decoded as Partial<OperatorTokenPayload> & { organisationId?: unknown; role?: unknown };
  if (typeof payload.operatorId !== 'string' || typeof payload.sessionId !== 'string') {
    throw new Error('Invalid operator token payload');
  }
  // A token carrying tenant claims is not an operator token, whatever it is signed with.
  if (payload.organisationId !== undefined || payload.role !== undefined) {
    throw new Error('Invalid operator token payload');
  }

  return { operatorId: payload.operatorId, sessionId: payload.sessionId };
}
