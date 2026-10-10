import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '../utils/app-error.js';

/**
 * Sealing for stored authenticator (TOTP) secrets, shared by the charity-user
 * and operator realms. Depends on nothing but node:crypto, because the E2E
 * harness seals operator fixtures with this exact code.
 *
 * The key is still derived from the realm's signing secret (no new variable to
 * lose), but rotating that secret no longer locks everyone out of their
 * authenticator:
 *  - new envelopes (v2) carry a key id, a fingerprint of the derived key, so a
 *    status count can tell which secret sealed a row without decrypting it;
 *  - while a rotation is in progress the old signing secret is configured as
 *    `<ROOT>_PREVIOUS`, and envelopes sealed under it still open;
 *  - a stale envelope is re-sealed by the batch re-seal command (and a charity
 *    user's also on its next successful sign-in), after which the previous
 *    secret can be removed.
 * v1 envelopes (no key id) are still read: current secret first, then previous.
 */
export type TotpEnvelopeV1 = { v: 1; iv: string; tag: string; ciphertext: string };
export type TotpEnvelopeV2 = { v: 2; kid: string; iv: string; tag: string; ciphertext: string };
export type TotpEnvelope = TotpEnvelopeV1 | TotpEnvelopeV2;

export type TotpRealm = {
  /** Environment variable holding the realm's signing secret. */
  rootEnv: string;
  /** HKDF info label; fixed per realm so derived keys never collide. */
  label: string;
  unavailable: () => AppError;
  /** A stored value that is not an envelope at all. */
  unreadable: () => AppError;
  /** An envelope that will not decrypt under any configured secret. Defaults to `unreadable`. */
  failedToOpen?: () => AppError;
  rotatedAway: () => AppError;
};

const KEY_BYTES = 32;
const IV_BYTES = 12;

function derive(realm: TotpRealm, root: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(root, 'utf8'), Buffer.alloc(0), realm.label, KEY_BYTES));
}

function keyId(realm: TotpRealm, key: Buffer): string {
  return createHash('sha256').update(`${realm.label}:kid`).update(key).digest('hex').slice(0, 32);
}

function currentKey(realm: TotpRealm): { key: Buffer; kid: string } {
  const root = process.env[realm.rootEnv];
  if (!root || root.length < 32) throw realm.unavailable();
  const key = derive(realm, root);
  return { key, kid: keyId(realm, key) };
}

function previousKey(realm: TotpRealm): { key: Buffer; kid: string } | null {
  const root = process.env[`${realm.rootEnv}_PREVIOUS`];
  if (!root || root.length < 32) return null;
  const key = derive(realm, root);
  return { key, kid: keyId(realm, key) };
}

function decrypt(key: Buffer, envelope: TotpEnvelope): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function parse(realm: TotpRealm, value: unknown): TotpEnvelope {
  const envelope = value as { v?: unknown; kid?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown } | null;
  if (!envelope || typeof envelope !== 'object' || !envelope.iv || !envelope.tag || !envelope.ciphertext
    || (envelope.v !== 1 && envelope.v !== 2) || (envelope.v === 2 && typeof envelope.kid !== 'string')) {
    throw realm.unreadable();
  }
  return envelope as TotpEnvelope;
}

export function sealTotpEnvelope(realm: TotpRealm, secret: string): TotpEnvelopeV2 {
  const { key, kid } = currentKey(realm);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { v: 2, kid, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64') };
}

export function openTotpEnvelope(realm: TotpRealm, value: unknown): string {
  const envelope = parse(realm, value);
  const current = currentKey(realm);
  const previous = previousKey(realm);
  if (envelope.v === 2) {
    const key = envelope.kid === current.kid ? current.key
      : previous && envelope.kid === previous.kid ? previous.key : null;
    if (!key) throw realm.rotatedAway();
    try {
      return decrypt(key, envelope);
    } catch {
      throw (realm.failedToOpen ?? realm.unreadable)();
    }
  }
  for (const candidate of [current, previous]) {
    if (!candidate) continue;
    try {
      return decrypt(candidate.key, envelope);
    } catch {
      // Try the next configured secret; a v1 envelope names none.
    }
  }
  throw (realm.failedToOpen ?? realm.unreadable)();
}

/** True only for an envelope already sealed under the current secret. Decrypts nothing. */
export function totpEnvelopeIsCurrent(realm: TotpRealm, value: unknown): boolean {
  const envelope = value as Partial<TotpEnvelopeV2> | null;
  return !!envelope && envelope.v === 2 && envelope.kid === currentKey(realm).kid;
}

/** One page of a second-factor re-seal; `next` is null after the last page. */
export type SecondFactorResealPage = {
  scanned: number;
  stale: number;
  resealed: number;
  skippedChanged: number;
  failed: string[];
  next: string | null;
};
