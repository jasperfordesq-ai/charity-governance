import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { s3CapabilityEvidencePinSchema } from './s3-capability-evidence.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex'),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase()),
  time = z
    .string()
    .datetime()
    .refine((v) => new Date(v).toISOString() === v);
export type S3CapabilityParentBinding = z.infer<
  typeof credentialReadMaintenanceBindingSchema
>;
/** Application-defined UUIDv8 identity. It is never acquisition/ACK authority. */
export function s3CapabilityChildAttempt(
  raw: unknown,
  credentialId: string,
  endpoint: string,
  configurationDigest: string,
) {
  const parent = credentialReadMaintenanceBindingSchema.parse(raw),
    id = uuid.parse(credentialId),
    route = z.enum(['DIRECT', 'GATEWAY']).parse(endpoint),
    digest = sha.parse(configurationDigest),
    bytes = createHash('sha256')
      .update(
        JSON.stringify({
          purpose: 'CHARITYPILOT_S3_COHORT_CHILD_V1',
          parent,
          credentialId: id,
          endpoint: route,
          configurationDigest: digest,
        }),
      )
      .digest()
      .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return uuid.parse(
    hex.slice(0, 8) +
      '-' +
      hex.slice(8, 12) +
      '-' +
      hex.slice(12, 16) +
      '-' +
      hex.slice(16, 20) +
      '-' +
      hex.slice(20),
  );
}
const baselineEntry = z
  .object({
    credentialId: uuid,
    endpoint: z.enum(['DIRECT', 'GATEWAY']),
    childAttemptId: uuid,
    baselinePin: s3CapabilityEvidencePinSchema.refine(
      (p) => p.kind === 'BASELINE',
    ),
  })
  .strict();
const reportEntry = z
  .object({
    credentialId: uuid,
    endpoint: z.enum(['DIRECT', 'GATEWAY']),
    childAttemptId: uuid,
    observationPin: s3CapabilityEvidencePinSchema.refine(
      (p) => p.kind === 'OBSERVATION',
    ),
    observationDigest: sha,
  })
  .strict();
function ordered(
  entries: { credentialId: string; endpoint: string; childAttemptId: string }[],
  parent: S3CapabilityParentBinding,
  digest: string,
) {
  return (
    entries.length % 2 === 0 &&
    new Set(entries.map((e) => e.childAttemptId)).size === entries.length &&
    entries.every(
      (e, i) =>
        e.endpoint === (i % 2 === 0 ? 'DIRECT' : 'GATEWAY') &&
        (i % 2 === 0
          ? i === 0 || entries[i - 1].credentialId < e.credentialId
          : entries[i - 1].credentialId === e.credentialId) &&
        e.childAttemptId ===
          s3CapabilityChildAttempt(
            parent,
            e.credentialId,
            e.endpoint,
            digest,
          ) &&
        e.childAttemptId !== parent.attemptId,
    )
  );
}
export const s3CapabilityCohortBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('S3_CAPABILITY_COHORT_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    capturedAt: time,
    entries: z.array(baselineEntry).min(2).max(100),
  })
  .strict()
  .refine((v) => ordered(v.entries, v.maintenance, v.configurationDigest));
export const s3CapabilityCohortObservationSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('S3_CAPABILITY_COHORT_OBSERVATION_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    baselineSha256: sha,
    observedAt: time,
    entries: z.array(reportEntry).min(2).max(100),
    configuredCredentialCohortRefusalsObserved: z.literal(true),
    coverage: z.literal(
      'ORIGINAL_KEY_PRESIGNED_PUT_AND_MULTIPART_PER_CONFIGURED_KEY_AT_BOTH_ENDPOINTS',
    ),
    s3CredentialsRevoked: z.literal(false),
    presignedCapabilitiesRevoked: z.literal(false),
    multipartUploadsDrained: z.literal(false),
    credentialInventoryComplete: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    providerReleaseAttested: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine((v) => ordered(v.entries, v.maintenance, v.configurationDigest));
export const s3CapabilityCohortPinSchema = z
  .object({
    kind: z.enum(['BASELINE', 'OBSERVATION']),
    versionId: z
      .string()
      .regex(/^[!-~]{1,1024}$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(131072),
  })
  .strict();
export type S3CapabilityCohortPin = z.infer<typeof s3CapabilityCohortPinSchema>;
export type S3CapabilityCohortArtifact = { body: string; sha256: string };
const artifactSchema = z
  .object({ body: z.string().min(1).max(131072), sha256: sha })
  .strict();
function parse(raw: unknown, schema: z.ZodTypeAny): S3CapabilityCohortArtifact {
  const a = artifactSchema.parse(raw);
  if (
    Buffer.byteLength(a.body) > 131072 ||
    hash(a.body) !== a.sha256 ||
    JSON.stringify(schema.parse(JSON.parse(a.body))) !== a.body
  )
    throw new Error('Unresolved original s3Capability cohort artifact');
  return a;
}
export const parseS3CapabilityCohortBaseline = (raw: unknown) =>
  parse(raw, s3CapabilityCohortBaselineSchema);
export const parseS3CapabilityCohortObservation = (raw: unknown) =>
  parse(raw, s3CapabilityCohortObservationSchema);
export function s3CapabilityCohortObservationArtifact(raw: unknown) {
  const body = JSON.stringify(s3CapabilityCohortObservationSchema.parse(raw));
  return parseS3CapabilityCohortObservation({ body, sha256: hash(body) });
}
export function assertS3CapabilityCohortPair(
  baseline: unknown,
  observation: unknown,
) {
  const ba = parseS3CapabilityCohortBaseline(baseline),
    ra = parseS3CapabilityCohortObservation(observation),
    b = s3CapabilityCohortBaselineSchema.parse(JSON.parse(ba.body)),
    r = s3CapabilityCohortObservationSchema.parse(JSON.parse(ra.body));
  if (
    r.baselineSha256 !== ba.sha256 ||
    r.configurationDigest !== b.configurationDigest ||
    JSON.stringify(r.maintenance) !== JSON.stringify(b.maintenance) ||
    Date.parse(r.observedAt) < Date.parse(b.capturedAt) ||
    JSON.stringify(
      r.entries.map((e) => [e.credentialId, e.endpoint, e.childAttemptId]),
    ) !==
      JSON.stringify(
        b.entries.map((e) => [e.credentialId, e.endpoint, e.childAttemptId]),
      )
  )
    throw new Error('Unresolved original s3Capability cohort pair');
}
