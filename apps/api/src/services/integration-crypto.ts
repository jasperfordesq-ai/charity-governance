import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../utils/errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Domain-separates the fingerprint from any other SHA-256 hash ever taken of
// this key, so this fingerprint can never be confused with (or collide
// against) a hash computed over the same bytes for an unrelated purpose.
const FINGERPRINT_LABEL = 'integration-key-v1';

export type SealedSecret = {
  /** The key generation that sealed this envelope, so rotation never guesses. */
  generation: number;
  iv: string;
  tag: string;
  ciphertext: string;
};

/**
 * The context an envelope is bound to via AAD (see `buildAad`). Every field
 * here — plus `generation` — must match exactly what the envelope was sealed
 * with, or opening fails closed. This is what stops a ciphertext copied from
 * one organisation's row into another's (by a bug or by DB write access)
 * from decrypting: AES-GCM's tag authenticates *modification*, but only AAD
 * binds the ciphertext to *where it is allowed to live*.
 */
export type SecretContext = {
  organisationId: string;
  provider: string;
  kind: string;
};

function requireValidKeyLength(key: Buffer): void {
  // Deliberately outside any try/catch that swallows errors: a
  // misconfigured key is an operational problem that must be loud, never
  // misreported as a corrupted credential (see openIntegrationSecret).
  if (key.length !== KEY_BYTES) {
    throw new AppError(
      500,
      'INTEGRATION_KEY_INVALID',
      `Integration encryption key must be exactly ${KEY_BYTES} bytes`,
    );
  }
}

function requireValidGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new AppError(
      500,
      'INTEGRATION_SECRET_GENERATION_INVALID',
      'generation must be a non-negative integer',
    );
  }
}

function requireNonEmptyPlaintext(plaintext: string): void {
  if (plaintext.length === 0) {
    throw new AppError(
      500,
      'INTEGRATION_SECRET_PLAINTEXT_REQUIRED',
      'plaintext must not be empty',
    );
  }
}

/**
 * Encode one field as a netstring (`<byte length>:<value>`). Netstrings are
 * self-delimiting: because the length prefix says exactly how many bytes of
 * content follow, concatenating several of them is an injective function of
 * the tuple of input strings — no separator choice can make two distinct
 * tuples collide, regardless of what characters the fields themselves
 * contain (including digits, colons, or the separator you'd otherwise have
 * picked).
 */
function encodeAadField(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * Build the AAD an envelope is bound to. Uses netstring-framed
 * (length-prefixed) fields specifically so the encoding is unambiguous: a
 * naive `organisationId + ':' + provider` join would let
 * `("a:b", "c")` collide with `("a", "b:c")`. `generation` is included so a
 * caller who edits the plaintext generation field on a stored row (without
 * re-sealing) fails the same way a tampered ciphertext does.
 */
function buildAad(context: SecretContext, generation: number): Buffer {
  const encoded =
    encodeAadField(context.organisationId) +
    encodeAadField(context.provider) +
    encodeAadField(context.kind) +
    encodeAadField(String(generation));
  return Buffer.from(encoded, 'utf8');
}

/**
 * Decode a configured key. Accepts hex or base64url, matching the encodings
 * AUTH_RECOVERY_SECRET already allows, and insists on exactly 32 bytes.
 *
 * Both branches round-trip the decoded bytes back through the same encoding
 * and compare against the raw input before accepting it. Node's decoders are
 * lenient — hex silently drops a trailing odd character, and base64/base64url
 * silently skip bytes outside the alphabet — so length alone is not enough
 * to guarantee every byte of the input was actually consumed.
 */
export function decodeIntegrationKey(raw: string): Buffer {
  const isHex = /^[0-9a-f]+$/i.test(raw);

  if (isHex) {
    // Node's hex decoder truncates to the last whole byte pair rather than
    // rejecting an odd-length string, so a 65-character string would
    // otherwise silently decode to the same 32 bytes as its first 64
    // characters. Reject on length before decoding at all.
    if (raw.length !== KEY_BYTES * 2) {
      throw new AppError(
        500,
        'INTEGRATION_KEY_INVALID',
        `INTEGRATION_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes`,
      );
    }
    const key = Buffer.from(raw, 'hex');
    if (key.toString('hex') !== raw.toLowerCase()) {
      throw new AppError(
        500,
        'INTEGRATION_KEY_INVALID',
        `INTEGRATION_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes`,
      );
    }
    return key;
  }

  const key = Buffer.from(raw, 'base64url');
  if (key.length !== KEY_BYTES || key.toString('base64url') !== raw) {
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
  return createHash('sha256').update(FINGERPRINT_LABEL).update(key).digest('hex');
}

export function sealIntegrationSecret(
  plaintext: string,
  key: Buffer,
  generation: number,
  context: SecretContext,
): SealedSecret {
  requireValidKeyLength(key);
  requireValidGeneration(generation);
  requireNonEmptyPlaintext(plaintext);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(context, generation));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    generation,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openIntegrationSecret(sealed: SealedSecret, key: Buffer, context: SecretContext): string {
  // Outside the try/catch below: a key of the wrong length is an
  // operational misconfiguration, not a corrupted envelope, and must not be
  // misreported as INTEGRATION_SECRET_UNREADABLE. Without this guard, Node
  // throws ERR_CRYPTO_INVALID_KEYLEN raw from sealIntegrationSecret but the
  // identical problem is silently swallowed here — the same misconfiguration
  // would surface as two different failure shapes, which is the worst
  // possible signal during an incident.
  requireValidKeyLength(key);

  try {
    const iv = Buffer.from(sealed.iv, 'base64');
    if (iv.length !== IV_BYTES) {
      throw new Error('envelope iv is not the expected length');
    }

    const tag = Buffer.from(sealed.tag, 'base64');
    if (tag.length !== TAG_BYTES) {
      throw new Error('envelope tag is not the expected length');
    }

    // `authTagLength` is the load-bearing fix here: without it, Node accepts
    // a `setAuthTag` call with a tag shorter than 16 bytes and will still
    // authenticate against it, which collapses forgery resistance from 2^128
    // down to roughly 2^(8*len) — verified directly against this Node
    // version, where a 4-byte tag was accepted and the plaintext recovered.
    // The explicit length check above is defence-in-depth on top of this.
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad(context, sealed.generation));
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failed — because the ciphertext or tag was
    // tampered with, the IV/tag length was wrong, or the AAD context
    // (organisation/provider/kind/generation) didn't match what this
    // envelope was sealed with — or the envelope is otherwise malformed.
    // Observed on this Node/OpenSSL build, the underlying error is just
    // "Unsupported state or unable to authenticate data" with no plaintext
    // fragment and `cause: undefined`. That is not a contract Node makes,
    // though, so the caught error is deliberately discarded rather than
    // attached as `cause`: the request/error logger serialises `cause`, and
    // a future change to Node's or OpenSSL's error shape could put plaintext
    // fragments right back into logs. Swallowing here is defence-in-depth
    // against that, not a workaround for today's behaviour.
    throw new AppError(500, 'INTEGRATION_SECRET_UNREADABLE', 'Stored integration credential could not be read.');
  }
}
