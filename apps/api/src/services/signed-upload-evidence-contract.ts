import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { signedUploadCredentialPinSchema } from './signed-upload-credential-contract.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const time = z
  .string()
  .datetime()
  .refine((v) => new Date(v).toISOString() === v);
const failure = () =>
  new Error('Signed-upload evidence does not match its original baseline');
export const signedUploadBaselineSchema = z
  .object({
    format: z.literal(2),
    kind: z.literal('SUPABASE_SIGNED_UPLOAD_BASELINE_V2'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    credentialReference: uuid,
    credentialPin: signedUploadCredentialPinSchema,
    tokenProof: z
      .object({
        tokenSha256: sha,
        providerKeyId: uuid,
        tokenKid: z.string().min(1).max(128),
        issuerFingerprint: sha,
        issuedAt: time,
        expiresAt: time,
      })
      .strict(),
    capturedAt: time,
    initialPayloadSha256: sha,
    updatePayloadSha256: sha,
  })
  .strict()
  .refine((v) => {
    const issued = Date.parse(v.tokenProof.issuedAt),
      expiry = Date.parse(v.tokenProof.expiresAt),
      captured = Date.parse(v.capturedAt);
    return (
      v.credentialPin.reference === v.credentialReference &&
      v.credentialPin.tokenSha256 === v.tokenProof.tokenSha256 &&
      expiry > issued &&
      expiry - issued <= 7200000 &&
      captured >= issued &&
      captured < expiry
    );
  });
const coreSchema = z
  .object({
    kind: z.literal('SUPABASE_SIGNED_UPLOAD_REFUSAL_V1'),
    configurationDigest: sha,
    baselineSha256: sha,
    credentialPinSha256: sha,
    tokenSha256: sha,
    issuerFingerprint: sha,
    observedAt: time,
    refusalStatus: z.union([z.literal(400), z.literal(401), z.literal(403)]),
    refusalCode: z.enum([
      'InvalidJWT',
      'InvalidSignature',
      'SignatureDoesNotMatch',
      'AccessDenied',
    ]),
    providerObservedAt: time,
  })
  .strict();
export const signedUploadObservationSchema = coreSchema
  .extend({
    observationDigest: sha,
    testedSignedUploadRefusalObserved: z.literal(true),
    issuedTokenSignatureMatched: z.literal(true),
    coverage: z.literal('ONE_REVIEWED_SYNTHETIC_SIGNED_UPLOAD_ONLY'),
    storageTokenIssuerVerified: z.literal(false),
    managementKeyAssociationVerified: z.literal(false),
    providerReleaseAttested: z.literal(false),
    signedCapabilitiesRevoked: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine((v) => {
    const core = coreSchema.strip().parse(v);
    return (
      hash(JSON.stringify(core)) === v.observationDigest &&
      (v.refusalStatus !== 400 ||
        ['InvalidJWT', 'InvalidSignature'].includes(v.refusalCode)) &&
      Math.abs(Date.parse(v.observedAt) - Date.parse(v.providerObservedAt)) <=
        60000
    );
  });
export type SignedUploadArtifact = { body: string; sha256: string };
const artifactSchema = z
  .object({
    body: z.string().min(1).max(8192),
    sha256: sha,
    byteLength: z.number().int().positive().optional(),
  })
  .strict();
function parse(raw: unknown, schema: z.ZodTypeAny): SignedUploadArtifact {
  const a = artifactSchema.parse(raw),
    size = Buffer.byteLength(a.body);
  if (
    size > 8192 ||
    (a.byteLength !== undefined && a.byteLength !== size) ||
    hash(a.body) !== a.sha256
  )
    throw failure();
  const v = schema.parse(JSON.parse(a.body));
  if (JSON.stringify(v) !== a.body) throw failure();
  return { body: a.body, sha256: a.sha256 };
}
export const parseSignedUploadBaseline = (raw: unknown) =>
  parse(raw, signedUploadBaselineSchema);
export const parseSignedUploadObservation = (raw: unknown) =>
  parse(raw, signedUploadObservationSchema);
export function signedUploadObservationArtifact(raw: unknown) {
  const body = JSON.stringify(signedUploadObservationSchema.parse(raw));
  return parseSignedUploadObservation({ body, sha256: hash(body) });
}
export function assertSignedUploadPair(
  baseline: unknown,
  observation: unknown,
) {
  const ba = parseSignedUploadBaseline(baseline),
    ra = parseSignedUploadObservation(observation);
  const b = signedUploadBaselineSchema.parse(JSON.parse(ba.body)),
    r = signedUploadObservationSchema.parse(JSON.parse(ra.body));
  if (
    r.baselineSha256 !== ba.sha256 ||
    r.configurationDigest !== b.configurationDigest ||
    r.credentialPinSha256 !== b.credentialPin.sha256 ||
    r.tokenSha256 !== b.tokenProof.tokenSha256 ||
    r.issuerFingerprint !== b.tokenProof.issuerFingerprint ||
    Date.parse(r.observedAt) < Date.parse(b.capturedAt) ||
    Date.parse(r.providerObservedAt) + 60000 >
      Date.parse(b.tokenProof.expiresAt) ||
    Date.parse(r.providerObservedAt) < Date.parse(b.tokenProof.issuedAt)
  )
    throw failure();
}
