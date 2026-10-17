import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { S3MaintenanceArtifactStore } from './maintenance-artifact-store.js';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  parseResumableUploadBaseline,
  parseResumableUploadObservation,
  resumableUploadObservationArtifact,
  resumableUploadBaselineSchema,
  assertResumableUploadPair,
} from './resumable-upload-evidence-contract.js';
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
const configuration = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    accountId: z.string().regex(/^\d{12}$/),
    kmsKeyArn: z
      .string()
      .regex(
        /^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
      ),
    maintenance: credentialReadMaintenanceBindingSchema,
    credentialId: z
      .string()
      .uuid()
      .refine((v) => v === v.toLowerCase()),
    probeDigest: sha,
    locationCustodyDigest: sha,
  })
  .strict()
  .refine((c) => c.kmsKeyArn.split(':')[4] === c.accountId);
const pinSchema = z
  .object({
    kind: z.enum(['BASELINE', 'OBSERVATION']),
    versionId: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[!-~]+$/)
      .refine((v) => v !== 'null'),
    sha256: sha,
    byteLength: z.number().int().min(1).max(8192),
  })
  .strict();
export type ResumableUploadEvidencePin = z.infer<typeof pinSchema>;
export { pinSchema as resumableUploadEvidencePinSchema };
export const resumableUploadEvidenceStorageSchema = configuration
  .innerType()
  .omit({
    maintenance: true,
    probeDigest: true,
    locationCustodyDigest: true,
    credentialId: true,
  })
  .refine((c) => c.kmsKeyArn.split(':')[4] === c.accountId);
const failure = () =>
  new Error(
    'Independent resumable-upload evidence is unresolved; preserve the original attempt without retrying publication',
  );

/** Conditional exact-version evidence custody only. The parent must durably pin
 * the acknowledged baseline before revocation. No head transition, provider
 * mutation, retry, replacement, current tenant authority or reopening exists. */
export class S3ResumableUploadEvidence extends S3MaintenanceArtifactStore<ResumableUploadEvidencePin> {
  constructor(
    raw: unknown,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    client?: S3Client,
  ) {
    const config = configuration.parse(raw);
    super(
      {
        installationId: config.installationId,
        bucket: config.bucket,
        accountId: config.accountId,
        kmsKeyArn: config.kmsKeyArn,
        maintenance: config.maintenance,
      },
      credentials,
      {
        namespace: 'resumable',
        pinSchema,
        limits: { BASELINE: 8192, OBSERVATION: 8192 },
        baseline: (raw) => {
          const artifact = parseResumableUploadBaseline(raw),
            value = resumableUploadBaselineSchema.parse(
              JSON.parse(artifact.body),
            );
          if (
            value.configurationDigest !== config.probeDigest ||
            value.credentialId !== config.credentialId ||
            value.locationPin.custodyDigest !== config.locationCustodyDigest ||
            JSON.stringify(value.maintenance) !==
              JSON.stringify(config.maintenance)
          )
            throw failure();
          return artifact;
        },
        parseObservation: parseResumableUploadObservation,
        observationFromValue: resumableUploadObservationArtifact,
        assertPair: assertResumableUploadPair,
        failure,
      },
      client,
    );
  }
}
