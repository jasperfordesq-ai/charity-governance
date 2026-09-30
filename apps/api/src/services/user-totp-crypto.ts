import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '../utils/app-error.js';

type Envelope = { v: 1; iv: string; tag: string; ciphertext: string };

function key(): Buffer {
  const root = process.env.JWT_SECRET;
  if (!root || root.length < 32) {
    throw new AppError(500, 'SECOND_FACTOR_UNAVAILABLE', 'Account sign-in security is unavailable.');
  }
  return Buffer.from(hkdfSync(
    'sha256', Buffer.from(root, 'utf8'), Buffer.alloc(0),
    'charitypilot:charity-user:totp:v1', 32,
  ));
}

export function sealUserTotpSecret(secret: string): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openUserTotpSecret(value: unknown): string {
  const envelope = value as Partial<Envelope> | null;
  if (!envelope || envelope.v !== 1 || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
    throw new AppError(500, 'SECOND_FACTOR_UNREADABLE', 'The account authenticator could not be read.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(500, 'SECOND_FACTOR_UNREADABLE', 'The account authenticator could not be opened. Use a saved recovery code or contact an administrator.');
  }
}
