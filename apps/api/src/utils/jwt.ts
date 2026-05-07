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

export interface TokenPayload {
  userId: string;
  organisationId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY as string & jwt.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
