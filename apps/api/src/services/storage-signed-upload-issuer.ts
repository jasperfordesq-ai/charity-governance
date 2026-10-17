import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { publicSigningKeyFingerprint } from './supabase-signing-key-control.js';
const failure = () => new Error('Storage signed-upload issuer is unresolved');
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
export const storageSignedUploadIssuerSchema = z
  .object({
    providerKeyId: z
      .string()
      .uuid()
      .refine((v) => v === v.toLowerCase()),
    tokenKid: z
      .string()
      .min(1)
      .max(128)
      .refine((v) => v === v.trim() && !/[\x00-\x20\x7f]/.test(v)),
    algorithm: z.enum(['ES256', 'RS256']),
    fingerprint: sha,
    publicJwk: z.record(z.unknown()),
  })
  .strict();
/** Cryptographic association with one explicitly reviewed public issuer. No
 * remote key discovery, kid-derived URL, symmetric export or token persistence. */
export class StorageSignedUploadIssuer {
  private readonly config: z.infer<typeof storageSignedUploadIssuerSchema>;
  private readonly publicKey: KeyObject;
  constructor(raw: unknown) {
    this.config = storageSignedUploadIssuerSchema.parse(raw);
    if (
      publicSigningKeyFingerprint(
        this.config.algorithm,
        this.config.publicJwk,
      ) !== this.config.fingerprint
    )
      throw failure();
    this.publicKey = createPublicKey({
      format: 'jwk',
      key: this.config.publicJwk,
    });
  }
  identity() {
    return {
      providerKeyId: this.config.providerKeyId,
      tokenKid: this.config.tokenKid,
      algorithm: this.config.algorithm,
      fingerprint: this.config.fingerprint,
    };
  }
  verify(token: unknown, expectedPath: string) {
    try {
      if (
        typeof token !== 'string' ||
        token.length > 8192 ||
        !/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(token) ||
        !expectedPath ||
        expectedPath.length > 2048
      )
        throw failure();
      const parts = token.split('.');
      const parsed = parts.slice(0, 2).map((part) => {
        const bytes = Buffer.from(part, 'base64url');
        if (bytes.toString('base64url') !== part) throw failure();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          value: unknown = JSON.parse(text);
        if (JSON.stringify(value) !== text) throw failure();
        return value;
      });
      if (Buffer.from(parts[2], 'base64url').toString('base64url') !== parts[2])
        throw failure();
      const header = z
        .object({
          alg: z.literal(this.config.algorithm),
          kid: z.literal(this.config.tokenKid),
          typ: z.literal('JWT').optional(),
        })
        .strict()
        .parse(parsed[0]);
      const claims = z
        .object({
          url: z.literal(expectedPath),
          scope: z.literal('upload'),
          upsert: z.literal(true),
          owner: z.string().uuid().nullable().optional(),
          iat: z.number().int().nonnegative(),
          exp: z.number().int().positive(),
          nbf: z.number().int().nonnegative().optional(),
        })
        .strict()
        .parse(parsed[1]);
      const now = Math.floor(Date.now() / 1000);
      if (
        claims.iat > now + 30 ||
        claims.exp - claims.iat > 7200 ||
        claims.exp <= claims.iat ||
        claims.exp < now + 60
      )
        throw failure();
      jwt.verify(token, this.publicKey, {
        algorithms: [header.alg],
        clockTolerance: 0,
        clockTimestamp: now,
        allowInvalidAsymmetricKeyTypes: false,
      });
      return {
        tokenSha256: createHash('sha256').update(token).digest('hex'),
        providerKeyId: this.config.providerKeyId,
        tokenKid: this.config.tokenKid,
        issuerFingerprint: this.config.fingerprint,
        issuedAt: new Date(claims.iat * 1000).toISOString(),
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      };
    } catch {
      throw failure();
    }
  }
}
