import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { S3MaintenanceArtifactStore } from './maintenance-artifact-store.js';
import { s3CapabilityEvidenceStorageSchema } from './s3-capability-evidence.js';
import {
  s3CapabilityCohortBaselineSchema,
  s3CapabilityCohortObservationSchema,
  s3CapabilityCohortPinSchema,
  parseS3CapabilityCohortBaseline,
  parseS3CapabilityCohortObservation,
  s3CapabilityCohortObservationArtifact,
  assertS3CapabilityCohortPair,
  type S3CapabilityCohortPin,
} from './s3-capability-cohort-contract.js';
const configuration = z
  .object({
    storage: s3CapabilityEvidenceStorageSchema,
    maintenance: credentialReadMaintenanceBindingSchema,
    configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    credentialIds: z
      .array(z.string().uuid())
      .min(1)
      .max(50)
      .refine((ids) => ids.every((id, i) => i === 0 || ids[i - 1] < id)),
  })
  .strict();
const failure = () =>
  new Error(
    'S3Capability cohort custody is unresolved; preserve the original attempt without retrying publication',
  );
export class S3CapabilityCohortEvidence extends S3MaintenanceArtifactStore<S3CapabilityCohortPin> {
  constructor(
    raw: unknown,
    credentials: NonNullable<S3ClientConfig['credentials']>,
    client?: S3Client,
  ) {
    const c = configuration.parse(raw);
    const scope = (v: {
      configurationDigest: string;
      maintenance: unknown;
      entries: { credentialId: string }[];
    }) => {
      if (
        v.configurationDigest !== c.configurationDigest ||
        JSON.stringify(v.maintenance) !== JSON.stringify(c.maintenance) ||
        JSON.stringify(
          v.entries.filter((_e, i) => i % 2 === 0).map((e) => e.credentialId),
        ) !== JSON.stringify(c.credentialIds)
      )
        throw failure();
    };
    super(
      { ...c.storage, maintenance: c.maintenance },
      credentials,
      {
        namespace: 's3-capability-cohort',
        pinSchema: s3CapabilityCohortPinSchema,
        limits: { BASELINE: 131072, OBSERVATION: 131072 },
        baseline: (raw) => {
          const a = parseS3CapabilityCohortBaseline(raw);
          scope(s3CapabilityCohortBaselineSchema.parse(JSON.parse(a.body)));
          return a;
        },
        parseObservation: (raw) => {
          const a = parseS3CapabilityCohortObservation(raw);
          scope(s3CapabilityCohortObservationSchema.parse(JSON.parse(a.body)));
          return a;
        },
        observationFromValue: s3CapabilityCohortObservationArtifact,
        assertPair: assertS3CapabilityCohortPair,
        failure,
      },
      client,
    );
  }
}
