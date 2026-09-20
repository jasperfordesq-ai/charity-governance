import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '../utils/app-error.js';

/**
 * Sealing and opening an operator's TOTP secret, kept apart from
 * operator-second-factor.service.ts so that it depends on nothing but node:crypto.
 *
 * The E2E harness has to seal a secret itself to enrol an operator fixture, and
 * it must use this exact code: a secret sealed with a different key or envelope
 * cannot be opened by the API, which answers 500 and reads in a test as a broken
 * product rather than a broken fixture. Importing the service to get it pulled
 * @prisma/client and fastify into the harness's type-check, which only fails in
 * CI (scripts/check-e2e-api-imports.mjs explains the trap and guards it).
 */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

export type SealedTotpSecret = {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

/**
 * The key the secret is sealed with, derived from the operator realm's own
 * signing secret.
 *
 * Deriving rather than adding another environment variable is deliberate. The
 * deploy already carries several keys and every additional one is another
 * thing to rotate, back up and lose; a second factor that cannot be rolled out
 * without a new secret is a second factor that does not get rolled out. HKDF
 * with a fixed label keeps the derived key separate from the signing use, so
 * the two cannot be confused even though they share a root.
 */
function sealingKey(): Buffer {
  const root = process.env.OWNER_JWT_SECRET;
  if (!root || root.length < 32) {
    throw new AppError(
      500,
      'OPERATOR_SECOND_FACTOR_UNAVAILABLE',
      'OWNER_JWT_SECRET must be set, and at least 32 characters, before a second factor can be used.',
    );
  }
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(root, 'utf8'), Buffer.alloc(0), 'charitypilot:operator:totp:v1', KEY_BYTES),
  );
}

export function sealTotpSecret(secret: string): SealedTotpSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, sealingKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openTotpSecret(sealed: unknown): string {
  const envelope = sealed as Partial<SealedTotpSecret> | null;
  if (!envelope || envelope.v !== 1 || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
    throw new AppError(
      500,
      'OPERATOR_SECOND_FACTOR_UNREADABLE',
      'The stored second-factor secret could not be read.',
    );
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      sealingKey(),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A secret sealed under a different root secret cannot be opened, which is
    // what happens if OWNER_JWT_SECRET is rotated. Say so plainly: the fix is
    // to re-enrol, and a vague error would send somebody hunting elsewhere.
    throw new AppError(
      500,
      'OPERATOR_SECOND_FACTOR_UNREADABLE',
      'The stored second-factor secret could not be opened. If OWNER_JWT_SECRET was changed, '
        + 'affected operators must enrol again.',
    );
  }
}
