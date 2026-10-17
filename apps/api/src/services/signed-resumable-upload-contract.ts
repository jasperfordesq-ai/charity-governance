import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { assertResumableLocation } from './resumable-location-contract.js';
export const signedTusHash = (v: string | Uint8Array) =>
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
export const signedResumableCredentialPinSchema = z
  .object({
    kind: z.literal('SIGNED_RESUMABLE_CREDENTIAL_PIN_V1'),
    reference: uuid,
    custodyDigest: sha,
    versionId: z
      .string()
      .regex(/^[!-~]{1,1024}$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(32768),
    tokenSha256: sha,
    locationSha256: sha,
  })
  .strict();
export const signedResumableTokenProofSchema = z
  .object({
    tokenSha256: sha,
    providerKeyId: uuid,
    tokenKid: z.string().min(1).max(128),
    issuerFingerprint: sha,
    issuedAt: time,
    expiresAt: time,
  })
  .strict();
export const signedResumableBaselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('SUPABASE_SIGNED_RESUMABLE_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    credentialPin: signedResumableCredentialPinSchema,
    tokenProof: signedResumableTokenProofSchema,
    capturedAt: time,
    expiresAt: time,
    offset: z.literal(6291456),
    uploadLength: z.literal(6291457),
    prefixSha256: z.literal(signedTusHash(Buffer.alloc(6291456, 0x43))),
  })
  .strict()
  .refine(
    (v) =>
      v.credentialPin.tokenSha256 === v.tokenProof.tokenSha256 &&
      Date.parse(v.tokenProof.issuedAt) <= Date.parse(v.capturedAt) &&
      Date.parse(v.tokenProof.expiresAt) >= Date.parse(v.capturedAt) + 60000 &&
      Date.parse(v.tokenProof.expiresAt) - Date.parse(v.tokenProof.issuedAt) <=
        7200000 &&
      Date.parse(v.expiresAt) >= Date.parse(v.capturedAt) + 60000 &&
      Date.parse(v.expiresAt) <= Date.parse(v.capturedAt) + 86460000,
  );
export function assertSignedResumableLocation(
  raw: unknown,
  scope: unknown,
  slot: 'old' | 'control-before' | 'control-after' = 'old',
) {
  const text = z.string().min(1).max(2048).parse(raw),
    u = new URL(text),
    prefix = '/storage/v1/upload/resumable/sign/';
  if (u.href !== text || !u.pathname.startsWith(prefix))
    throw new Error('Unresolved signed resumable location');
  const ordinary =
    u.origin +
    '/storage/v1/upload/resumable/' +
    u.pathname.slice(prefix.length);
  if (u.search || u.hash || u.username || u.password)
    throw new Error('Unresolved signed resumable location');
  assertResumableLocation(ordinary, scope, slot);
  return text;
}
export function parseSignedResumableBaseline(raw: unknown) {
  const a = z
    .object({ body: z.string().min(1).max(8192), sha256: sha })
    .strict()
    .parse(raw);
  if (Buffer.byteLength(a.body) > 8192 || signedTusHash(a.body) !== a.sha256)
    throw new Error('Unresolved signed resumable baseline');
  const value = signedResumableBaselineSchema.parse(JSON.parse(a.body));
  if (JSON.stringify(value) !== a.body)
    throw new Error('Unresolved signed resumable baseline');
  return { artifact: a, value };
}

const observationCore = z
  .object({
    kind: z.literal('SUPABASE_SIGNED_RESUMABLE_REFUSAL_V1'),
    configurationDigest: sha,
    baselineSha256: sha,
    credentialPinSha256: sha,
    tokenSha256: sha,
    locationSha256: sha,
    issuerFingerprint: sha,
    observedAt: time,
    providerObservedAt: time,
    refusalStatus: z.union([z.literal(400), z.literal(401), z.literal(403)]),
    refusalCode: z.enum([
      'InvalidJWT',
      'InvalidSignature',
      'SignatureDoesNotMatch',
      'AccessDenied',
    ]),
  })
  .strict();
export const signedResumableObservationSchema = observationCore
  .extend({
    observationDigest: sha,
    testedSignedResumablePatchRefusalObserved: z.literal(true),
    coverage: z.literal('ONE_ORIGINAL_REVIEWED_SIGNED_TUS_CAPABILITY_ONLY'),
    resumableSessionsRevoked: z.literal(false),
    signedCapabilitiesRevoked: z.literal(false),
    storageTokenIssuerVerified: z.literal(false),
    providerReleaseAttested: z.literal(false),
    inFlightWritesDrained: z.literal(false),
    wholeStorageQuiesced: z.literal(false),
    actionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (v) =>
      signedTusHash(JSON.stringify(observationCore.strip().parse(v))) ===
        v.observationDigest &&
      (v.refusalStatus !== 400 ||
        ['InvalidJWT', 'InvalidSignature'].includes(v.refusalCode)),
  );
export function assertSignedResumablePair(
  baseline: unknown,
  observation: unknown,
) {
  const { artifact: a, value: b } = parseSignedResumableBaseline(baseline),
    r = signedResumableObservationSchema.parse(observation),
    captured = Date.parse(b.capturedAt),
    observed = Date.parse(r.observedAt),
    provider = Date.parse(r.providerObservedAt);
  if (
    r.baselineSha256 !== a.sha256 ||
    r.configurationDigest !== b.configurationDigest ||
    r.credentialPinSha256 !== b.credentialPin.sha256 ||
    r.tokenSha256 !== b.tokenProof.tokenSha256 ||
    r.locationSha256 !== b.credentialPin.locationSha256 ||
    r.issuerFingerprint !== b.tokenProof.issuerFingerprint ||
    observed < captured ||
    provider < captured - 60000 ||
    provider > observed + 60000 ||
    observed - provider > 240000 ||
    provider + 60000 > Date.parse(b.expiresAt) ||
    provider + 60000 > Date.parse(b.tokenProof.expiresAt)
  )
    throw new Error(
      'Signed resumable evidence does not match its original baseline',
    );
  return r;
}
