import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { resumableLocationPinSchema } from './resumable-location-contract.js';
const hash = (v: string | Uint8Array) =>
    createHash('sha256').update(v).digest('hex'),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const time = z
    .string()
    .datetime()
    .refine((v) => new Date(v).toISOString() === v),
  failure = () =>
    new Error('Resumable evidence does not match its original baseline');
export const resumablePrefixSha256 = hash(Buffer.alloc(6291456, 0x43));
export const resumableUploadBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('SUPABASE_RESUMABLE_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    credentialId: uuid,
    reference: uuid,
    locationSha256: sha,
    locationPin: resumableLocationPinSchema,
    capturedAt: time,
    expiresAt: time,
    offset: z.literal(6291456),
    uploadLength: z.literal(6291457),
    prefixSha256: sha,
  })
  .strict()
  .refine(
    (v) =>
      v.reference === v.locationPin.reference &&
      v.prefixSha256 === resumablePrefixSha256 &&
      Date.parse(v.expiresAt) >= Date.parse(v.capturedAt) + 60000 &&
      Date.parse(v.expiresAt) <= Date.parse(v.capturedAt) + 86460000,
  );
const coreSchema = z
  .object({
    kind: z.literal('SUPABASE_RESUMABLE_REFUSAL_V1'),
    configurationDigest: sha,
    baselineSha256: sha,
    locationPinSha256: sha,
    credentialId: uuid,
    observedAt: time,
    refusalStatus: z.union([z.literal(401), z.literal(403)]),
    providerObservedAt: time,
  })
  .strict();
export const resumableUploadObservationSchema = coreSchema
  .extend({
    observationDigest: sha,
    testedResumablePatchRefusalObserved: z.literal(true),
    coverage: z.literal('ONE_REVIEWED_MODERN_SECRET_TUS_SESSION_ONLY'),
    resumableSessionsRevoked: z.literal(false),
    signedResumableVerified: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    providerReleaseAttested: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (v) =>
      hash(JSON.stringify(coreSchema.strip().parse(v))) === v.observationDigest,
  );
export type ResumableUploadArtifact = { body: string; sha256: string };
const artifactSchema = z
  .object({
    body: z.string().min(1).max(8192),
    sha256: sha,
    byteLength: z.number().int().positive().optional(),
  })
  .strict();
function parse(raw: unknown, schema: z.ZodTypeAny): ResumableUploadArtifact {
  const a = artifactSchema.parse(raw),
    size = Buffer.byteLength(a.body);
  if (
    size > 8192 ||
    (a.byteLength !== undefined && a.byteLength !== size) ||
    hash(a.body) !== a.sha256
  )
    throw failure();
  const value = schema.parse(JSON.parse(a.body));
  if (JSON.stringify(value) !== a.body) throw failure();
  return { body: a.body, sha256: a.sha256 };
}
export const parseResumableUploadBaseline = (raw: unknown) =>
  parse(raw, resumableUploadBaselineSchema);
export const parseResumableUploadObservation = (raw: unknown) =>
  parse(raw, resumableUploadObservationSchema);
export function resumableUploadObservationArtifact(raw: unknown) {
  const body = JSON.stringify(resumableUploadObservationSchema.parse(raw));
  return parseResumableUploadObservation({ body, sha256: hash(body) });
}
export function assertResumableUploadPair(
  baseline: unknown,
  observation: unknown,
) {
  const ba = parseResumableUploadBaseline(baseline),
    ra = parseResumableUploadObservation(observation),
    b = resumableUploadBaselineSchema.parse(JSON.parse(ba.body)),
    r = resumableUploadObservationSchema.parse(JSON.parse(ra.body)),
    captured = Date.parse(b.capturedAt),
    observed = Date.parse(r.observedAt),
    provider = Date.parse(r.providerObservedAt);
  if (
    r.baselineSha256 !== ba.sha256 ||
    r.configurationDigest !== b.configurationDigest ||
    r.locationPinSha256 !== b.locationPin.sha256 ||
    r.credentialId !== b.credentialId ||
    observed < captured ||
    provider < captured - 60000 ||
    provider > observed + 60000 ||
    observed - provider > 240000 ||
    provider + 60000 > Date.parse(b.expiresAt)
  )
    throw failure();
}
