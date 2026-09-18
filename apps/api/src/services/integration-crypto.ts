import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../utils/errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type SealedSecret = {
  /** The key generation that sealed this envelope, so rotation never guesses. */
  generation: number;
  iv: string;
  tag: string;
  ciphertext: string;
};

/**
 * Decode a configured key. Accepts hex or base64url, matching the encodings
 * AUTH_RECOVERY_SECRET already allows, and insists on exactly 32 bytes.
 */
export function decodeIntegrationKey(raw: string): Buffer {
  const candidates = /^[0-9a-f]+$/i.test(raw)
    ? [Buffer.from(raw, 'hex')]
    : [Buffer.from(raw, 'base64url'), Buffer.from(raw, 'base64')];

  const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
  if (!key) {
    throw new AppError(
      500,
      'INTEGRATION_KEY_INVALID',
      `INTEGRATION_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes`,
    );
  }
  return key;
}

export function integrationKeyFingerprint(key: Buffer): string {
  // Fingerprint the key, never the material it protects. Safe to log.
  return createHash('sha256').update(key).digest('hex');
}

export function sealIntegrationSecret(plaintext: string, key: Buffer, generation: number): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    generation,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openIntegrationSecret(sealed: SealedSecret, key: Buffer): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failed, or the envelope is malformed. Either way the
    // material is unusable. The caught error is deliberately not surfaced: it
    // can carry fragments of the attempted plaintext.
    throw new AppError(500, 'INTEGRATION_SECRET_UNREADABLE', 'Stored integration credential could not be read.');
  }
}
