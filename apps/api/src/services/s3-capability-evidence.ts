import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { S3MaintenanceArtifactStore } from './maintenance-artifact-store.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  resumableUploadEvidenceStorageSchema,
  resumableUploadEvidencePinSchema,
} from './resumable-upload-evidence.js';
import {
  parseS3CapabilityBaseline,
  parseS3CapabilityObservation,
  s3CapabilityObservationArtifact,
  assertS3CapabilityPair,
  s3ProbeHash as hash,
} from './s3-capability-contract.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const configuration = resumableUploadEvidenceStorageSchema
  .innerType()
  .extend({
    maintenance: credentialReadMaintenanceBindingSchema,
    probeDigest: sha,
    capabilityCustodyDigest: sha,
    credentialId: z
      .string()
      .uuid()
      .refine((v) => v === v.toLowerCase()),
  })
  .refine((c) => c.kmsKeyArn.split(':')[4] === c.accountId);
export const s3CapabilityEvidenceStorageSchema =
  resumableUploadEvidenceStorageSchema;
export const s3CapabilityEvidencePinSchema = resumableUploadEvidencePinSchema;
export function s3CapabilityEvidenceScope(raw: unknown) {
  const { maintenance, ...registry } = configuration.parse(raw);
  return hash(
    JSON.stringify({ kind: 'S3_CAPABILITY_PUBLIC_EVIDENCE_V1', registry }),
  );
}
const failure = () =>
  new Error(
    'Original S3 public evidence is unresolved; preserve the original attempt without retrying publication',
  );
/** Exact original public artifacts only. No decryption/provider requests,
 * missing acknowledgement reconstruction, current authority or reopening. */
export class S3CapabilityEvidence extends S3MaintenanceArtifactStore<
  z.infer<typeof s3CapabilityEvidencePinSchema>
> {
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
        namespace: 's3-capability',
        scopeDigest: s3CapabilityEvidenceScope(c),
        pinSchema: s3CapabilityEvidencePinSchema,
        limits: { BASELINE: 8192, OBSERVATION: 8192 },
        baseline: (raw) => {
          const { artifact, value: v } = parseS3CapabilityBaseline(raw);
          if (
            v.configurationDigest !== c.probeDigest ||
            v.credentialId !== c.credentialId ||
            v.capabilityPin.custodyDigest !== c.capabilityCustodyDigest ||
            JSON.stringify(v.maintenance) !== JSON.stringify(c.maintenance)
          )
            throw failure();
          return artifact;
        },
        parseObservation: (raw) => parseS3CapabilityObservation(raw).artifact,
        observationFromValue: s3CapabilityObservationArtifact,
        assertPair: (baseline, observation) => {
          assertS3CapabilityPair(
            baseline,
            parseS3CapabilityObservation(observation).value,
          );
        },
        failure,
      },
      client,
    );
  }
}
