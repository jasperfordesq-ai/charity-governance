import { z } from 'zod';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
export const resumableLocationPinSchema = z
  .object({
    kind: z.literal('RESUMABLE_LOCATION_PIN_V1'),
    reference: uuid,
    custodyDigest: sha,
    versionId: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[!-~]+$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(32768),
  })
  .strict();
export type ResumableLocationPin = z.infer<typeof resumableLocationPinSchema>;
export const resumableLocationScopeSchema = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    attemptId: z.string().uuid(),
    uploadIdFormat: z.enum(['PATH_V1', 'FILE_VERSION_V1']),
  })
  .strict();
export function assertResumableLocation(
  raw: unknown,
  scope: unknown,
  slot: 'old' | 'control-before' | 'control-after' = 'old',
) {
  z.enum(['old', 'control-before', 'control-after']).parse(slot);
  const c = resumableLocationScopeSchema.parse(scope),
    text = z.string().min(1).max(2048).parse(raw),
    u = new URL(text),
    origin = 'https://' + c.projectRef + '.storage.supabase.co',
    start = origin + '/storage/v1/upload/resumable/';
  if (
    u.href !== text ||
    !text.startsWith(start) ||
    u.origin !== origin ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error('Unresolved resumable location scope');
  const encoded = text.slice(start.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new Error('Unresolved resumable location encoding');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded)
    throw new Error('Unresolved resumable location encoding');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    separator = c.uploadIdFormat === 'PATH_V1' ? '/' : '-$v-',
    expected =
      'charitypilot-recovery-resumable-probes/charitypilot-recovery-resumable-probe/' +
      c.installationId +
      '/' +
      c.attemptId +
      '/' +
      slot +
      '.txt' +
      separator;
  if (
    !decoded.startsWith(expected) ||
    !uuid.safeParse(decoded.slice(expected.length)).success
  )
    throw new Error('Unresolved resumable location target');
  return text;
}
