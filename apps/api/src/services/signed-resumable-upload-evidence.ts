import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { S3MaintenanceArtifactStore } from './maintenance-artifact-store.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { resumableUploadEvidenceStorageSchema } from './resumable-upload-evidence.js';
import { resumableUploadEvidencePinSchema } from './resumable-upload-evidence.js';
import {
  parseSignedResumableBaseline,
  parseSignedResumableObservation,
  signedResumableObservationArtifact,
  assertSignedResumablePair,
} from './signed-resumable-upload-contract.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const configuration = resumableUploadEvidenceStorageSchema
  .innerType()
  .extend({
    maintenance: credentialReadMaintenanceBindingSchema,
    probeDigest: sha,
    credentialCustodyDigest: sha,
    issuer: z
      .object({
        providerKeyId: z.string().uuid(),
        tokenKid: z.string().min(1).max(128),
        fingerprint: sha,
      })
      .strict(),
  })
  .refine((c) => c.kmsKeyArn.split(':')[4] === c.accountId);
export const signedResumableEvidencePinSchema =
  resumableUploadEvidencePinSchema;
export const signedResumableEvidenceStorageSchema =
  resumableUploadEvidenceStorageSchema;
export type SignedResumableEvidencePin = z.infer<
  typeof signedResumableEvidencePinSchema
>;
const failure = () =>
  new Error(
    'Original signed resumable evidence is unresolved; preserve the original attempt without retrying publication',
  );
/** Original public evidence only. No KMS/TUS dispatch, reconstruction or authority. */
export class S3SignedResumableUploadEvidence extends S3MaintenanceArtifactStore<SignedResumableEvidencePin> {
  constructor(
    raw: unknown,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    client?: S3Client,
  ) {
    const c = configuration.parse(raw);
    super(
      {
        installationId: c.installationId,
        bucket: c.bucket,
        accountId: c.accountId,
        kmsKeyArn: c.kmsKeyArn,
        maintenance: c.maintenance,
      },
      credentials,
      {
        namespace: 'signed-resumable',
        pinSchema: signedResumableEvidencePinSchema,
        limits: { BASELINE: 8192, OBSERVATION: 8192 },
        baseline: (raw) => {
          const { artifact, value: v } = parseSignedResumableBaseline(raw);
          if (
            v.configurationDigest !== c.probeDigest ||
            JSON.stringify(v.maintenance) !== JSON.stringify(c.maintenance) ||
            v.credentialPin.custodyDigest !== c.credentialCustodyDigest ||
            v.tokenProof.providerKeyId !== c.issuer.providerKeyId ||
            v.tokenProof.tokenKid !== c.issuer.tokenKid ||
            v.tokenProof.issuerFingerprint !== c.issuer.fingerprint
          )
            throw failure();
          return artifact;
        },
        parseObservation: (raw) =>
          parseSignedResumableObservation(raw).artifact,
        observationFromValue: signedResumableObservationArtifact,
        assertPair: (baseline, report) => {
          assertSignedResumablePair(
            baseline,
            parseSignedResumableObservation(report).value,
          );
        },
        failure,
      },
      client,
    );
  }
}
