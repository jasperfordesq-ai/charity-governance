import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { resumableUploadEvidencePinSchema } from './resumable-upload-evidence.js';
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
export type ResumableParentBinding = z.infer<
  typeof credentialReadMaintenanceBindingSchema
>;
/** Application-defined UUIDv8 identity. It is never acquisition/ACK authority. */
export function resumableChildAttempt(raw: unknown, credentialId: string) {
  const parent = credentialReadMaintenanceBindingSchema.parse(raw),
    id = uuid.parse(credentialId),
    bytes = createHash('sha256')
      .update(
        JSON.stringify({
          purpose: 'CHARITYPILOT_TUS_COHORT_CHILD_V1',
          parent,
          credentialId: id,
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
    childAttemptId: uuid,
    baselinePin: resumableUploadEvidencePinSchema.refine(
      (p) => p.kind === 'BASELINE',
    ),
  })
  .strict();
const reportEntry = z
  .object({
    credentialId: uuid,
    childAttemptId: uuid,
    observationPin: resumableUploadEvidencePinSchema.refine(
      (p) => p.kind === 'OBSERVATION',
    ),
    observationDigest: sha,
  })
  .strict();
function ordered(
  entries: { credentialId: string; childAttemptId: string }[],
  parent: ResumableParentBinding,
) {
  return (
    new Set(entries.map((e) => e.childAttemptId)).size === entries.length &&
    entries.every(
      (e, i) =>
        (i === 0 || entries[i - 1].credentialId < e.credentialId) &&
        e.childAttemptId === resumableChildAttempt(parent, e.credentialId) &&
        e.childAttemptId !== parent.attemptId,
    )
  );
}
export const resumableCohortBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('RESUMABLE_COHORT_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    capturedAt: time,
    entries: z.array(baselineEntry).min(1).max(50),
  })
  .strict()
  .refine((v) => ordered(v.entries, v.maintenance));
export const resumableCohortObservationSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('RESUMABLE_COHORT_OBSERVATION_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    baselineSha256: sha,
    observedAt: time,
    entries: z.array(reportEntry).min(1).max(50),
    configuredCredentialCohortRefusalsObserved: z.literal(true),
    coverage: z.literal(
      'ONE_ORIGINAL_TUS_SESSION_PER_CONFIGURED_RETIRED_MODERN_SECRET',
    ),
    resumableSessionsRevoked: z.literal(false),
    signedResumableVerified: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    providerReleaseAttested: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine((v) => ordered(v.entries, v.maintenance));
export const resumableCohortPinSchema = z
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
export type ResumableCohortPin = z.infer<typeof resumableCohortPinSchema>;
export type ResumableCohortArtifact = { body: string; sha256: string };
const artifactSchema = z
  .object({ body: z.string().min(1).max(131072), sha256: sha })
  .strict();
function parse(raw: unknown, schema: z.ZodTypeAny): ResumableCohortArtifact {
  const a = artifactSchema.parse(raw);
  if (
    Buffer.byteLength(a.body) > 131072 ||
    hash(a.body) !== a.sha256 ||
    JSON.stringify(schema.parse(JSON.parse(a.body))) !== a.body
  )
    throw new Error('Unresolved original resumable cohort artifact');
  return a;
}
export const parseResumableCohortBaseline = (raw: unknown) =>
  parse(raw, resumableCohortBaselineSchema);
export const parseResumableCohortObservation = (raw: unknown) =>
  parse(raw, resumableCohortObservationSchema);
export function resumableCohortObservationArtifact(raw: unknown) {
  const body = JSON.stringify(resumableCohortObservationSchema.parse(raw));
  return parseResumableCohortObservation({ body, sha256: hash(body) });
}
export function assertResumableCohortPair(
  baseline: unknown,
  observation: unknown,
) {
  const ba = parseResumableCohortBaseline(baseline),
    ra = parseResumableCohortObservation(observation),
    b = resumableCohortBaselineSchema.parse(JSON.parse(ba.body)),
    r = resumableCohortObservationSchema.parse(JSON.parse(ra.body));
  if (
    r.baselineSha256 !== ba.sha256 ||
    r.configurationDigest !== b.configurationDigest ||
    JSON.stringify(r.maintenance) !== JSON.stringify(b.maintenance) ||
    Date.parse(r.observedAt) < Date.parse(b.capturedAt) ||
    JSON.stringify(r.entries.map((e) => [e.credentialId, e.childAttemptId])) !==
      JSON.stringify(b.entries.map((e) => [e.credentialId, e.childAttemptId]))
  )
    throw new Error('Unresolved original resumable cohort pair');
}
