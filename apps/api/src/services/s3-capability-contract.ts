import { z } from 'zod';
import { createHash } from 'node:crypto';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
export const s3ProbeHash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const time = z
  .string()
  .datetime()
  .refine((v) => new Date(v).toISOString() === v);
export const s3CapabilityPinSchema = z
  .object({
    kind: z.literal('S3_CAPABILITY_PIN_V1'),
    reference: uuid,
    custodyDigest: sha,
    versionId: z
      .string()
      .regex(/^[!-~]{1,1024}$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(32768),
    presignedUrlSha256: sha,
    uploadIdSha256: sha,
  })
  .strict();
export const s3ProbeOperations = [
  'GET',
  'PUT_CREATE',
  'PUT_UPDATE',
  'DELETE',
  'MULTIPART_CREATE',
  'MULTIPART_PART',
  'MULTIPART_COMPLETE',
  'PRESIGNED_PUT',
] as const;
export const s3CapabilityBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('SUPABASE_S3_CAPABILITY_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    credentialId: uuid,
    capabilityPin: s3CapabilityPinSchema,
    capturedAt: time,
    presignedIssuedAt: time,
    presignedExpiresAt: time,
    partETag: z.string().regex(/^"[\x21\x23-\x7e]{1,128}"$/),
    partBytes: z.literal(5242880),
    partSha256: z.literal(s3ProbeHash(Buffer.alloc(5242880, 0x43))),
    standardSha256: z.literal(s3ProbeHash('B')),
    presignedSha256: z.literal(s3ProbeHash('A')),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.presignedExpiresAt) - Date.parse(v.presignedIssuedAt) ===
        900000 &&
      Date.parse(v.capturedAt) >= Date.parse(v.presignedIssuedAt) &&
      Date.parse(v.presignedExpiresAt) >= Date.parse(v.capturedAt) + 60000,
  );
const core = z
  .object({
    kind: z.literal('SUPABASE_S3_DISABLED_V1'),
    configurationDigest: sha,
    baselineSha256: sha,
    capabilityPinSha256: sha,
    credentialId: uuid,
    observedAt: time,
    refusals: z
      .array(
        z
          .object({
            operation: z.enum(s3ProbeOperations),
            status: z.literal(403),
            code: z.literal('FeatureNotEnabled'),
            providerObservedAt: time,
          })
          .strict(),
      )
      .length(s3ProbeOperations.length)
      .refine((v) => v.every((r, i) => r.operation === s3ProbeOperations[i])),
  })
  .strict();
export const s3CapabilityObservationSchema = core
  .extend({
    observationDigest: sha,
    testedS3FeatureRefusalsObserved: z.literal(true),
    coverage: z.literal(
      'ONE_REVIEWED_S3_KEY_AND_ORIGINAL_CAPABILITIES_AT_ONE_ENDPOINT_ONLY',
    ),
    s3CredentialsRevoked: z.literal(false),
    presignedCapabilitiesRevoked: z.literal(false),
    multipartUploadsDrained: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    providerReleaseAttested: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (v) =>
      s3ProbeHash(JSON.stringify(core.strip().parse(v))) ===
      v.observationDigest,
  );
export function parseS3CapabilityBaseline(raw: unknown) {
  const a = z
    .object({ body: z.string().min(1).max(8192), sha256: sha })
    .strict()
    .parse(raw);
  if (Buffer.byteLength(a.body) > 8192 || s3ProbeHash(a.body) !== a.sha256)
    throw new Error('Unresolved original S3 baseline');
  const value = s3CapabilityBaselineSchema.parse(JSON.parse(a.body));
  if (JSON.stringify(value) !== a.body)
    throw new Error('Unresolved original S3 baseline');
  return { artifact: a, value };
}
export function assertS3CapabilityPair(raw: unknown, report: unknown) {
  const { artifact: a, value: b } = parseS3CapabilityBaseline(raw),
    r = s3CapabilityObservationSchema.parse(report),
    captured = Date.parse(b.capturedAt),
    observed = Date.parse(r.observedAt);
  if (
    r.baselineSha256 !== a.sha256 ||
    r.configurationDigest !== b.configurationDigest ||
    r.credentialId !== b.credentialId ||
    r.capabilityPinSha256 !== b.capabilityPin.sha256 ||
    observed < captured ||
    r.refusals.some((v) => {
      const p = Date.parse(v.providerObservedAt);
      return (
        p < captured - 60000 ||
        p > observed + 60000 ||
        observed - p > 240000 ||
        p + 60000 > Date.parse(b.presignedExpiresAt)
      );
    })
  )
    throw new Error('S3 evidence does not match its original baseline');
  return r;
}
