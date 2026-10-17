import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  parseS3FeatureBoundary,
  s3FeatureHash as hash,
} from './s3-feature-boundary-contract.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  time = z
    .string()
    .datetime()
    .refine((v) => new Date(v).toISOString() === v);
const feature = z
  .object({ body: z.string().min(1).max(8192), sha256: sha })
  .strict();
export const s3CurrentFeatureBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('S3_CURRENT_FEATURE_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    capturedAt: time,
    preObservation: feature,
  })
  .strict();
export const s3CurrentFeatureObservationSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('S3_CURRENT_FEATURE_OBSERVATION_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    baselineSha256: sha,
    observedAt: time,
    postObservation: feature,
    configuredCurrentFeatureBoundaryObserved: z.literal(true),
    coverage: z.literal(
      'CURRENT_UNAUTHENTICATED_S3_FEATURE_BOUNDARY_PRE_AND_POST_BOTH_ENDPOINTS',
    ),
    originalWorkingS3BaselineProven: z.literal(false),
    historicalNeverEnabledProven: z.literal(false),
    credentialInventoryComplete: z.literal(false),
    s3CredentialsRevoked: z.literal(false),
    presignedCapabilitiesRevoked: z.literal(false),
    multipartUploadsDrained: z.literal(false),
    unknownMultipartSideEffectsExcluded: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    providerReleaseAttested: z.literal(false),
    controlPlaneWritersExcluded: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    originalAcknowledgementReconstructed: z.literal(false),
    savedObservationAuthorizesExecution: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict();
export const s3CurrentFeaturePinSchema = z
  .object({
    kind: z.enum(['BASELINE', 'OBSERVATION']),
    versionId: z
      .string()
      .regex(/^[!-~]{1,1024}$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(16384),
  })
  .strict();
const artifactSchema = z
  .object({ body: z.string().min(1).max(16384), sha256: sha })
  .strict();
const failure = () =>
  new Error('Original current-S3 feature evidence is unresolved');
function canonical(raw: unknown, schema: z.ZodTypeAny) {
  const a = artifactSchema.parse(raw);
  if (
    Buffer.byteLength(a.body) > 16384 ||
    hash(a.body) !== a.sha256 ||
    JSON.stringify(schema.parse(JSON.parse(a.body))) !== a.body
  )
    throw failure();
  return a;
}
export function parseS3CurrentFeatureBaseline(raw: unknown) {
  const a = canonical(raw, s3CurrentFeatureBaselineSchema),
    v = s3CurrentFeatureBaselineSchema.parse(JSON.parse(a.body)),
    p = parseS3FeatureBoundary(v.preObservation).value;
  if (
    p.stage !== 'PRE_CLOSURE' ||
    JSON.stringify(p.maintenance) !== JSON.stringify(v.maintenance) ||
    Date.parse(p.observedAt) > Date.parse(v.capturedAt) ||
    Date.parse(v.capturedAt) - Date.parse(p.observedAt) > 60000
  )
    throw failure();
  return a;
}
export function parseS3CurrentFeatureObservation(raw: unknown) {
  const a = canonical(raw, s3CurrentFeatureObservationSchema),
    v = s3CurrentFeatureObservationSchema.parse(JSON.parse(a.body)),
    p = parseS3FeatureBoundary(v.postObservation).value;
  if (
    p.stage !== 'POST_CLOSURE' ||
    JSON.stringify(p.maintenance) !== JSON.stringify(v.maintenance) ||
    Date.parse(p.observedAt) > Date.parse(v.observedAt) ||
    Date.parse(v.observedAt) - Date.parse(p.observedAt) > 60000
  )
    throw failure();
  return a;
}
export function s3CurrentFeatureObservationArtifact(raw: unknown) {
  const body = JSON.stringify(s3CurrentFeatureObservationSchema.parse(raw));
  return parseS3CurrentFeatureObservation({ body, sha256: hash(body) });
}
export function assertS3CurrentFeaturePair(
  baseline: unknown,
  observation: unknown,
) {
  const ba = parseS3CurrentFeatureBaseline(baseline),
    ra = parseS3CurrentFeatureObservation(observation),
    b = s3CurrentFeatureBaselineSchema.parse(JSON.parse(ba.body)),
    r = s3CurrentFeatureObservationSchema.parse(JSON.parse(ra.body)),
    pre = parseS3FeatureBoundary(b.preObservation).value,
    post = parseS3FeatureBoundary(r.postObservation).value;
  if (
    r.configurationDigest !== b.configurationDigest ||
    r.baselineSha256 !== ba.sha256 ||
    JSON.stringify(r.maintenance) !== JSON.stringify(b.maintenance) ||
    Date.parse(post.beganAt) < Date.parse(b.capturedAt) ||
    pre.metadataBefore.configurationDigest !==
      post.metadataBefore.configurationDigest
  )
    throw failure();
}
