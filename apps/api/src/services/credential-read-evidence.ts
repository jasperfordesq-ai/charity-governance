import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase() && v === v.trim());
const time = z
  .string()
  .datetime()
  .refine((v) => new Date(v).toISOString() === v);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const credentialReadMaintenanceBindingSchema = z
  .object({
    attemptId: uuid,
    planDigest: sha,
    sourceSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .length(40),
    maintenanceEpoch: z.number().int().positive().max(2147483647),
  })
  .strict();
export const credentialReadBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('SUPABASE_CREDENTIAL_READ_BASELINE_V1'),
    configurationDigest: sha,
    credentialCount: z.number().int().min(2).max(51),
    capturedAt: time,
    canarySha256: sha,
    byteLength: z.number().int().min(1).max(1024),
    maintenance: credentialReadMaintenanceBindingSchema.optional(),
  })
  .strict();
export const credentialReadObservationSchema = z
  .object({
    kind: z.literal('SUPABASE_CREDENTIAL_READ_REFUSAL_V1'),
    configurationDigest: sha,
    baselineSha256: sha,
    observedAt: time,
    refusals: z
      .array(
        z
          .object({
            credentialId: uuid,
            status: z.union([z.literal(401), z.literal(403)]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    observationDigest: sha,
    credentialReadRefusalsObserved: z.literal(true),
    coverage: z.literal('EXPLICIT_MODERN_SECRET_READS_ONLY'),
    writeRejectionVerified: z.literal(false),
    signedCapabilitiesRevoked: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.refusals.map((r) => r.credentialId);
    const core = {
      kind: v.kind,
      configurationDigest: v.configurationDigest,
      baselineSha256: v.baselineSha256,
      observedAt: v.observedAt,
      refusals: v.refusals,
    };
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id, i) => i > 0 && ids[i - 1] >= id) ||
      hash(JSON.stringify(core)) !== v.observationDigest
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Credential read observation is inconsistent',
      });
  });
const artifactSchema = z
  .object({
    body: z.string().min(1).max(8192),
    sha256: sha,
    byteLength: z.number().int().positive().optional(),
  })
  .strict();
export type CredentialReadArtifact = { body: string; sha256: string };
function parseArtifact(
  raw: unknown,
  maximum: number,
  schema: z.ZodTypeAny,
): CredentialReadArtifact {
  const artifact = artifactSchema.parse(raw),
    count = Buffer.byteLength(artifact.body);
  const value = schema.parse(JSON.parse(artifact.body));
  if (
    count > maximum ||
    (artifact.byteLength !== undefined && artifact.byteLength !== count) ||
    hash(artifact.body) !== artifact.sha256 ||
    JSON.stringify(value) !== artifact.body
  )
    throw new Error('Credential read artifact is inconsistent');
  return { body: artifact.body, sha256: artifact.sha256 };
}
/** Integrity/canonical checks only; independent custody authenticates the pin. */
export const parseCredentialReadBaselineArtifact = (raw: unknown) =>
  parseArtifact(raw, 4096, credentialReadBaselineSchema);
export const parseCredentialReadObservationArtifact = (raw: unknown) =>
  parseArtifact(raw, 8192, credentialReadObservationSchema);
export function credentialReadObservationArtifact(
  raw: unknown,
): CredentialReadArtifact {
  const value = credentialReadObservationSchema.parse(raw),
    body = JSON.stringify(value);
  return parseCredentialReadObservationArtifact({ body, sha256: hash(body) });
}
export function assertCredentialReadEvidencePair(
  baseline: CredentialReadArtifact,
  observation: CredentialReadArtifact,
) {
  const b = credentialReadBaselineSchema.parse(JSON.parse(baseline.body)),
    o = credentialReadObservationSchema.parse(JSON.parse(observation.body));
  if (
    o.baselineSha256 !== baseline.sha256 ||
    o.configurationDigest !== b.configurationDigest ||
    o.refusals.length + 1 !== b.credentialCount ||
    Date.parse(o.observedAt) < Date.parse(b.capturedAt)
  )
    throw new Error('Credential read evidence pair is inconsistent');
}
