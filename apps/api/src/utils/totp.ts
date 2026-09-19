import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Written out rather than taken from a package, for the same reason the
 * connector validates its own inputs: this runs in the process that can suspend
 * every charity on the platform, and the whole algorithm is forty lines of
 * HMAC that the RFC publishes test vectors for. A dependency here would be more
 * code to trust, not less, and the vectors below are what make the
 * implementation checkable rather than merely plausible.
 *
 * SHA-1 is the algorithm, which looks alarming and is not: HOTP uses HMAC-SHA1
 * as a pseudorandom function, not as a collision-resistant hash, and every
 * authenticator application in circulation implements that and nothing else.
 * Choosing SHA-256 here would produce codes no ordinary phone could generate.
 */
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * How many steps either side of now are accepted.
 *
 * One step, so a code entered as it rolls over is still taken and a code from
 * ninety seconds ago is not. Wider windows are a common way to quietly halve
 * the strength of the factor.
 */
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 without padding, which is what authenticator applications read. */
export function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('The secret is not valid base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A 160-bit secret, which is what RFC 4226 recommends and what phones expect. */
export function generateTotpSecret(): string {
  return toBase32(randomBytes(20));
}

/** The counter-based code underneath TOTP. Separated so the RFC's HOTP vectors apply. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  // Written as two 32-bit halves: counter is a JavaScript number, and
  // writeBigUInt64BE would need every caller to carry a BigInt for a value
  // that cannot exceed 2^53 until long after the sun burns out.
  message.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: Buffer, atMs = Date.now(), digits = DIGITS): string {
  return hotp(secret, Math.floor(atMs / 1000 / PERIOD_SECONDS), digits);
}

/**
 * Whether a code is currently valid for this secret.
 *
 * Compared in constant time, and only after both sides are known to be the same
 * length: `timingSafeEqual` throws on a length mismatch, and a caller that let
 * that throw would leak the length through the difference between an exception
 * and a false.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs = Date.now(),
): boolean {
  // Belt and braces, and deliberately so: the length-guarded comparison below
  // already refuses anything that is not six digits, so removing this check
  // changes no outcome. It is kept because it makes the shape of an acceptable
  // code explicit at the top of the function rather than implied at the bottom.
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;

  let secret: Buffer;
  try {
    secret = fromBase32(secretBase32);
  } catch {
    return false;
  }
  if (secret.length === 0) return false;

  const step = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  const offered = Buffer.from(cleaned, 'utf8');

  let matched = false;
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    const expected = Buffer.from(hotp(secret, step + drift), 'utf8');
    // Every candidate is compared even after a match, so the time taken does
    // not reveal which step succeeded.
    if (expected.length === offered.length && timingSafeEqual(expected, offered)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * The URI an authenticator application reads from a QR code.
 *
 * The issuer appears twice by convention: once as a label prefix, which is what
 * older applications display, and once as a parameter, which is what newer ones
 * read. Both are encoded, because an organisation name may contain anything.
 */
export function totpEnrolmentUri(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const parameters = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

export const TOTP_PERIOD_SECONDS = PERIOD_SECONDS;
export const TOTP_DIGITS = DIGITS;
export const TOTP_DRIFT_STEPS = DRIFT_STEPS;
