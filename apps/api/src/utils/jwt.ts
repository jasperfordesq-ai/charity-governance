import jwt from 'jsonwebtoken';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`FATAL: ${name} environment variable must be set. The server will not start without it.`);
  }
  return value;
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const JWT_EXPIRY = process.env.JWT_EXPIRY ?? '15m';
const ACCESS_TOKEN_ALGORITHM = 'HS256';

export interface TokenPayload {
  userId: string;
  organisationId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  sessionId: string;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: ACCESS_TOKEN_ALGORITHM,
    expiresIn: JWT_EXPIRY as string & jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: [ACCESS_TOKEN_ALGORITHM] });

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Invalid token payload');
  }

  const payload = decoded as Partial<TokenPayload>;
  if (
    typeof payload.userId !== 'string' ||
    typeof payload.organisationId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    !['OWNER', 'ADMIN', 'MEMBER'].includes(payload.role ?? '')
  ) {
    throw new Error('Invalid token payload');
  }

  return {
    userId: payload.userId,
    organisationId: payload.organisationId,
    role: payload.role as TokenPayload['role'],
    sessionId: payload.sessionId,
  };
}
