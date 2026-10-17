import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { createHash } from 'node:crypto';
export const s3FeatureHash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const hash = s3FeatureHash;
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  time = z
    .string()
    .datetime()
    .refine((v) => new Date(v).toISOString() === v);
export const s3FeatureStageSchema = z.enum(['PRE_CLOSURE', 'POST_CLOSURE']);
export const s3DisabledMetadataSchema = z
  .object({
    scope: z.literal('SUPABASE_S3_DISABLED_METADATA_V1'),
    stage: s3FeatureStageSchema,
    configurationDigest: sha,
    stateSha256: sha,
    observationDigest: sha,
    observedAt: time,
    s3ProtocolEnabled: z.literal(false),
    configuredCredentialRegistryMatched: z.literal(true),
    historicalNeverEnabledProven: z.literal(false),
    controlPlaneWritersExcluded: z.literal(false),
    providerReleaseAttested: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (v) =>
      hash(
        JSON.stringify({
          stage: v.stage,
          configurationDigest: v.configurationDigest,
          stateSha256: v.stateSha256,
          observedAt: v.observedAt,
        }),
      ) === v.observationDigest,
  );
export const s3FeatureOperations = [
  'GET',
  'PUT_CREATE',
  'PUT_UPDATE',
  'DELETE',
  'MULTIPART_CREATE',
  'UNISSUED_MULTIPART_PART',
  'UNISSUED_MULTIPART_COMPLETE',
  'INVALID_PRESIGNED_SHAPE',
] as const;
const core = z
  .object({
    format: z.literal(1),
    kind: z.literal('SUPABASE_S3_CURRENT_FEATURE_BOUNDARY_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    stage: s3FeatureStageSchema,
    beganAt: time,
    observedAt: time,
    metadataBefore: s3DisabledMetadataSchema,
    metadataAfter: s3DisabledMetadataSchema,
    refusals: z
      .array(
        z
          .object({
            endpoint: z.enum(['DIRECT', 'GATEWAY']),
            operation: z.enum(s3FeatureOperations),
            status: z.literal(403),
            code: z.literal('FeatureNotEnabled'),
            providerObservedAt: time,
          })
          .strict(),
      )
      .length(16)
      .refine((v) =>
        v.every(
          (r, i) =>
            r.endpoint === (i < 8 ? 'DIRECT' : 'GATEWAY') &&
            r.operation === s3FeatureOperations[i % 8],
        ),
      ),
  })
  .strict();
export const s3FeatureBoundarySchema = core
  .extend({
    observationDigest: sha,
    testedCurrentFeatureBoundaryObserved: z.literal(true),
    coverage: z.literal(
      'UNAUTHENTICATED_REGISTERED_S3_ROUTE_SHAPES_BOTH_ENDPOINTS_ONLY',
    ),
    originalWorkingS3BaselineProven: z.literal(false),
    historicalNeverEnabledProven: z.literal(false),
    s3CredentialsRevoked: z.literal(false),
    presignedCapabilitiesRevoked: z.literal(false),
    multipartUploadsDrained: z.literal(false),
    unknownMultipartSideEffectsExcluded: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    providerReleaseAttested: z.literal(false),
    controlPlaneWritersExcluded: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    savedObservationAuthorizesExecution: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine((v) => {
    const began = Date.parse(v.beganAt),
      observed = Date.parse(v.observedAt),
      before = Date.parse(v.metadataBefore.observedAt),
      after = Date.parse(v.metadataAfter.observedAt);
    return (
      hash(JSON.stringify(core.strip().parse(v))) === v.observationDigest &&
      v.stage === v.metadataBefore.stage &&
      v.stage === v.metadataAfter.stage &&
      v.metadataBefore.configurationDigest ===
        v.metadataAfter.configurationDigest &&
      v.metadataBefore.stateSha256 === v.metadataAfter.stateSha256 &&
      began <= before &&
      before <= after &&
      after <= observed &&
      observed - began <= 180000 &&
      v.refusals.every((r) => {
        const p = Date.parse(r.providerObservedAt);
        return (
          p >= before - 60000 &&
          p <= after + 60000 &&
          p <= observed + 60000 &&
          observed - p <= 240000
        );
      })
    );
  });
export function s3FeatureBoundaryArtifact(raw: unknown) {
  const body = JSON.stringify(s3FeatureBoundarySchema.parse(raw));
  if (Buffer.byteLength(body) > 8192)
    throw new Error('S3 feature evidence exceeds its bound');
  return { body, sha256: hash(body) };
}
export function parseS3FeatureBoundary(raw: unknown) {
  const a = z
    .object({ body: z.string().min(1).max(8192), sha256: sha })
    .strict()
    .parse(raw);
  if (Buffer.byteLength(a.body) > 8192 || hash(a.body) !== a.sha256)
    throw new Error('Unresolved S3 feature evidence');
  const value = s3FeatureBoundarySchema.parse(JSON.parse(a.body));
  if (JSON.stringify(value) !== a.body)
    throw new Error('Unresolved S3 feature evidence');
  return { artifact: a, value };
}
