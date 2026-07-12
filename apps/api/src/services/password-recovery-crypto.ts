import crypto from 'node:crypto';
import { isIP } from 'node:net';

export const AUTH_RECOVERY_KEY_VERSION = 1;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 64;
const TOKEN_NONCE_BYTES = 32;
const TOKEN_CONTEXT = 'CharityPilot/password-recovery/v1\0';
const HKDF_SALT = Buffer.from('CharityPilot/auth-recovery/hkdf-salt/v1', 'utf8');
const ROOT_FINGERPRINT_CONTEXT = 'CharityPilot/auth-recovery/root-fingerprint/v1\0';

export type PasswordRecoveryRateDigestPurpose =
  | 'forgot-identifier'
  | 'forgot-ip'
  | 'forgot-network'
  | 'reset-token'
  | 'reset-network';

export type PasswordRecoveryTokenDescriptor = {
  requestId: string;
  tokenNonceHex: string;
  tokenKeyVersion: number;
};

function configuredSecret(secret = process.env.AUTH_RECOVERY_SECRET): Buffer {
  const value = secret?.trim() ?? '';
  let decoded: Buffer;

  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    decoded = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9_-]+$/.test(value)) {
    decoded = Buffer.from(value, 'base64url');
  } else {
    throw new Error('AUTH_RECOVERY_SECRET must be canonical hex or base64url');
  }

  const canonicalHex = decoded.toString('hex');
  const canonicalBase64url = decoded.toString('base64url');
  if (
    decoded.length < MIN_SECRET_BYTES || decoded.length > MAX_SECRET_BYTES ||
    (value.toLowerCase() !== canonicalHex && value !== canonicalBase64url)
  ) {
    throw new Error('AUTH_RECOVERY_SECRET must canonically encode 32 to 64 high-entropy bytes');
  }
  return decoded;
}

export function authRecoverySecretFingerprint(secret?: string): string {
  return crypto
    .createHash('sha256')
    .update(ROOT_FINGERPRINT_CONTEXT, 'utf8')
    .update(configuredSecret(secret))
    .digest('hex');
}

function subkey(label: 'token' | 'rate', secret?: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      configuredSecret(secret),
      HKDF_SALT,
      Buffer.from(`CharityPilot/auth-recovery/${label}/v1`, 'utf8'),
      MIN_SECRET_BYTES,
    ),
  );
}

function assertHexNonce(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Password recovery token nonce must be 32 lowercase hexadecimal bytes');
  }
  return Buffer.from(value, 'hex');
}

export function derivePasswordRecoveryToken(
  descriptor: PasswordRecoveryTokenDescriptor,
  secret?: string,
): string {
  if (descriptor.tokenKeyVersion !== AUTH_RECOVERY_KEY_VERSION) {
    throw new Error(`Unsupported password recovery token key version: ${descriptor.tokenKeyVersion}`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(descriptor.requestId)) {
    throw new TypeError('Password recovery request id must be a UUIDv4');
  }

  const nonce = assertHexNonce(descriptor.tokenNonceHex);
  return crypto
    .createHmac('sha256', subkey('token', secret))
    .update(TOKEN_CONTEXT, 'utf8')
    .update(descriptor.requestId.toLowerCase(), 'utf8')
    .update('\0', 'utf8')
    .update(nonce)
    .digest('base64url');
}

export function hashPasswordRecoveryToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createPasswordRecoveryTokenMaterial(
  requestId: string,
  secret?: string,
): { token: string; tokenHash: string; tokenNonceHex: string; tokenKeyVersion: number } {
  const tokenNonceHex = crypto.randomBytes(TOKEN_NONCE_BYTES).toString('hex');
  const tokenKeyVersion = AUTH_RECOVERY_KEY_VERSION;
  const token = derivePasswordRecoveryToken(
    { requestId, tokenNonceHex, tokenKeyVersion },
    secret,
  );
  return {
    token,
    tokenHash: hashPasswordRecoveryToken(token),
    tokenNonceHex,
    tokenKeyVersion,
  };
}

export function derivePasswordRecoveryRateDigest(
  purpose: PasswordRecoveryRateDigestPurpose,
  canonicalValue: string,
  secret?: string,
): string {
  if (!canonicalValue || canonicalValue !== canonicalValue.trim()) {
    throw new TypeError('Password recovery rate-limit input must be non-empty and canonical');
  }
  return crypto
    .createHmac('sha256', subkey('rate', secret))
    .update(`CharityPilot/auth-recovery/rate/${purpose}/v1\0`, 'utf8')
    .update(canonicalValue, 'utf8')
    .digest('hex');
}

function parseIpv4(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  const octets = value.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function expandIpv6(value: string): number[] | null {
  const withoutZone = value.toLowerCase().split('%', 1)[0];
  if (isIP(withoutZone) !== 6) return null;

  let normalized = withoutZone;
  const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const octets = parseIpv4(dottedTail);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = normalized.slice(0, -dottedTail.length) + `${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => Number.parseInt(group || '0', 16));
  return parsed.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? parsed
    : null;
}

export function canonicalizePasswordRecoveryAddress(address: string): {
  exactAddress: string;
  networkAddress: string;
} {
  const trimmed = address.trim().toLowerCase();
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = parseIpv4(mapped ?? trimmed);
  if (ipv4) {
    const exactAddress = ipv4.join('.');
    // IPv4 remains /32. Shared-network abuse is bounded independently by the
    // global Fastify limiter; collapsing NAT users here would deny charities.
    return { exactAddress, networkAddress: exactAddress };
  }

  const ipv6 = expandIpv6(trimmed);
  if (!ipv6) throw new TypeError('Password recovery request address must be a valid IP address');
  if (ipv6.slice(0, 5).every((group) => group === 0) && ipv6[5] === 0xffff) {
    const mappedIpv4 = [
      ipv6[6] >> 8,
      ipv6[6] & 0xff,
      ipv6[7] >> 8,
      ipv6[7] & 0xff,
    ];
    const exactAddress = mappedIpv4.join('.');
    return { exactAddress, networkAddress: exactAddress };
  }
  const exactAddress = ipv6.map((group) => group.toString(16).padStart(4, '0')).join(':');
  const networkAddress = [...ipv6.slice(0, 4), 0, 0, 0, 0]
    .map((group) => group.toString(16).padStart(4, '0'))
    .join(':');
  return { exactAddress, networkAddress };
}
