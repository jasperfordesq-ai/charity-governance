import { z } from 'zod';
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
export const signedUploadCredentialPinSchema = z
  .object({
    kind: z.literal('SIGNED_UPLOAD_CREDENTIAL_PIN_V1'),
    reference: z
      .string()
      .uuid()
      .refine((v) => v === v.toLowerCase()),
    custodyDigest: sha,
    versionId: z
      .string()
      .regex(/^[\x21-\x7e]{1,1024}$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(32768),
    tokenSha256: sha,
  })
  .strict();
export type SignedUploadCredentialPin = z.infer<
  typeof signedUploadCredentialPinSchema
>;
