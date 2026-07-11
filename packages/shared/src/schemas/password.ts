import { z } from 'zod';

export const BCRYPT_PASSWORD_MAX_UTF8_BYTES = 72 as const;
export const BCRYPT_PASSWORD_MAX_UTF8_BYTES_MESSAGE =
  'Password must be at most 72 bytes when encoded as UTF-8';

const utf8Encoder = new TextEncoder();

export function passwordUtf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function withBcryptPasswordByteLimit(
  schema: z.ZodString,
): z.ZodEffects<z.ZodString, string, string> {
  return schema.refine(
    (value) => passwordUtf8ByteLength(value) <= BCRYPT_PASSWORD_MAX_UTF8_BYTES,
    BCRYPT_PASSWORD_MAX_UTF8_BYTES_MESSAGE,
  );
}
