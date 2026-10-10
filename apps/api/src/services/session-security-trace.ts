import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { PrismaClient } from '@prisma/client';

/**
 * A minimal, time-bounded record of session requests, so a future
 * SESSION_REPLAY_DETECTED event can be attributed. The nine historical replay
 * events could not be: request logs live in containers, and every blue-green
 * deploy replaces them.
 *
 * Off unless SESSION_SECURITY_TRACE_RETENTION_DAYS is set. The period is a
 * data-protection decision (P08/C05), not something the application picks.
 * When on, one row per sign-in, refresh and sign-out request records:
 * - the time, matched route, status code and request ID;
 * - a one-way fingerprint of the presented refresh token. The replay event
 *   carries the same fingerprint, so the replaying request can be compared
 *   with the earlier legitimate presentation of the same token;
 * - the client's network prefix (IPv4 /24, IPv6 /48), never the full address;
 * - a digest of the user agent, never the string.
 * No user, charity, session or token value is stored.
 */
export const MAX_SESSION_TRACE_RETENTION_DAYS = 90;

/** The configured retention in days, or null when tracing is off. Invalid
 * values also mean off; production validation reports them. */
export function sessionTraceRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.SESSION_SECURITY_TRACE_RETENTION_DAYS;
  if (raw === undefined || raw === '') return null;
  if (!/^[1-9][0-9]?$/.test(raw)) return null;
  const days = Number(raw);
  return days <= MAX_SESSION_TRACE_RETENTION_DAYS ? days : null;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** From the stored refresh-token hash (the AuthSession column). */
export function presentedTokenFingerprintFromHash(refreshTokenHash: string): string {
  return sha256(`charitypilot:session-trace:v1:${refreshTokenHash}`).slice(0, 16);
}

/** From the presented refresh token itself; equal to the value above for it. */
export function presentedTokenFingerprint(refreshToken: string): string {
  return presentedTokenFingerprintFromHash(sha256(refreshToken));
}

export function userAgentDigest(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  return sha256(`charitypilot:session-trace:ua:v1:${userAgent}`).slice(0, 16);
}

function expandIpv6(address: string): number[] | null {
  const [head, tail, extra] = address.split('::');
  if (extra !== undefined) return null;
  const part = (text: string | undefined) => (text ? text.split(':') : []);
  const left = part(head);
  const right = part(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right];
  const numbers = groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : Number.NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}

/** IPv4 /24 or IPv6 /48; an IPv4-mapped IPv6 address is treated as IPv4. */
export function networkPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1]! : ip;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (family === 6) {
    const groups = expandIpv6(address.split('%')[0]!);
    if (!groups) return null;
    return `${groups.slice(0, 3).map((g) => g.toString(16)).join(':')}::/48`;
  }
  return null;
}

/** Uses the database clock, the same one the delete guard and the row
 * default use, so an application host whose clock runs ahead can never select
 * a row the guard still considers too young and fail the whole delete. */
export async function pruneSessionSecurityTrace(prisma: Pick<PrismaClient, '$executeRaw'>,
  retentionDays: number): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_SESSION_TRACE_RETENTION_DAYS) {
    throw new RangeError('Session security trace retention must be 1 to 90 days');
  }
  return prisma.$executeRaw`DELETE FROM "SessionSecurityTrace"
    WHERE "occurredAt" < CURRENT_TIMESTAMP - make_interval(days => ${retentionDays}::integer)`;
}
