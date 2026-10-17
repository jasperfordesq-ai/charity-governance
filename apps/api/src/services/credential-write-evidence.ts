import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const time = z
  .string()
  .datetime()
  .refine((v) => new Date(v).toISOString() === v);
const ordered = (ids: string[]) =>
  new Set(ids).size === ids.length &&
  ids.every((id, i) => i === 0 || ids[i - 1] < id);
export const credentialWriteBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('SUPABASE_STANDARD_WRITE_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    capturedAt: time,
    credentialIds: z.array(uuid).min(1).max(50).refine(ordered),
    payloadSha256: sha,
    updatePayloadSha256: sha,
    operations: z.tuple([
      z.literal('CREATE'),
      z.literal('UPDATE'),
      z.literal('DELETE'),
    ]),
  })
  .strict();
const refusal = z.union([z.literal(401), z.literal(403)]);
export const credentialWriteObservationSchema = z
  .object({
    kind: z.literal('SUPABASE_STANDARD_WRITE_REFUSAL_V1'),
    configurationDigest: sha,
    baselineSha256: sha,
    observedAt: time,
    refusals: z
      .array(
        z
          .object({
            credentialId: uuid,
            create: refusal,
            update: refusal,
            delete: refusal,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    observationDigest: sha,
    standardWriteRefusalsObserved: z.literal(true),
    coverage: z.literal('EXPLICIT_MODERN_SECRET_STANDARD_WRITES_ONLY'),
    retainedSyntheticObjects: z.number().int().min(1).max(50),
    writeRejectionVerified: z.literal(false),
    signedCapabilitiesRevoked: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    const core = {
      kind: v.kind,
      configurationDigest: v.configurationDigest,
      baselineSha256: v.baselineSha256,
      observedAt: v.observedAt,
      refusals: v.refusals,
    };
    if (
      !ordered(v.refusals.map((r) => r.credentialId)) ||
      v.retainedSyntheticObjects !== v.refusals.length ||
      hash(JSON.stringify(core)) !== v.observationDigest
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Inconsistent standard-write observation',
      });
  });
const artifact = z
  .object({
    body: z.string().min(1).max(16384),
    sha256: sha,
    byteLength: z.number().int().positive().optional(),
  })
  .strict();
export type CredentialWriteArtifact = { body: string; sha256: string };
function parse(
  raw: unknown,
  schema: z.ZodTypeAny,
  limit: number,
): CredentialWriteArtifact {
  const a = artifact.parse(raw),
    size = Buffer.byteLength(a.body),
    value = schema.parse(JSON.parse(a.body));
  if (
    size > limit ||
    (a.byteLength !== undefined && a.byteLength !== size) ||
    hash(a.body) !== a.sha256 ||
    JSON.stringify(value) !== a.body
  )
    throw new Error('Inconsistent standard-write artifact');
  return { body: a.body, sha256: a.sha256 };
}
export const parseCredentialWriteBaseline = (raw: unknown) =>
  parse(raw, credentialWriteBaselineSchema, 8192);
export const parseCredentialWriteObservation = (raw: unknown) =>
  parse(raw, credentialWriteObservationSchema, 16384);
export function credentialWriteObservationArtifact(raw: unknown) {
  const value = credentialWriteObservationSchema.parse(raw),
    body = JSON.stringify(value);
  return parseCredentialWriteObservation({ body, sha256: hash(body) });
}
export function assertCredentialWritePair(
  baseline: CredentialWriteArtifact,
  report: CredentialWriteArtifact,
) {
  const b = credentialWriteBaselineSchema.parse(JSON.parse(baseline.body)),
    r = credentialWriteObservationSchema.parse(JSON.parse(report.body));
  if (
    r.baselineSha256 !== baseline.sha256 ||
    r.configurationDigest !== b.configurationDigest ||
    JSON.stringify(r.refusals.map((v) => v.credentialId)) !==
      JSON.stringify(b.credentialIds) ||
    Date.parse(r.observedAt) < Date.parse(b.capturedAt)
  )
    throw new Error('Standard-write observation does not match its baseline');
}
