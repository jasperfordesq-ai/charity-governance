import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { S3MaintenanceArtifactStore } from './maintenance-artifact-store.js';
import { resumableUploadEvidenceStorageSchema } from './resumable-upload-evidence.js';
import {
  resumableCohortBaselineSchema,
  resumableCohortObservationSchema,
  resumableCohortPinSchema,
  parseResumableCohortBaseline,
  parseResumableCohortObservation,
  resumableCohortObservationArtifact,
  assertResumableCohortPair,
  type ResumableCohortPin,
} from './resumable-cohort-contract.js';
const configuration = z
  .object({
    storage: resumableUploadEvidenceStorageSchema,
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
    'Resumable cohort custody is unresolved; preserve the original attempt without retrying publication',
  );
export class S3ResumableCohortEvidence extends S3MaintenanceArtifactStore<ResumableCohortPin> {
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
        JSON.stringify(v.entries.map((e) => e.credentialId)) !==
          JSON.stringify(c.credentialIds)
      )
        throw failure();
    };
    super(
      { ...c.storage, maintenance: c.maintenance },
      credentials,
      {
        namespace: 'resumable-cohort',
        pinSchema: resumableCohortPinSchema,
        limits: { BASELINE: 131072, OBSERVATION: 131072 },
        baseline: (raw) => {
          const a = parseResumableCohortBaseline(raw);
          scope(resumableCohortBaselineSchema.parse(JSON.parse(a.body)));
          return a;
        },
        parseObservation: (raw) => {
          const a = parseResumableCohortObservation(raw);
          scope(resumableCohortObservationSchema.parse(JSON.parse(a.body)));
          return a;
        },
        observationFromValue: resumableCohortObservationArtifact,
        assertPair: assertResumableCohortPair,
        failure,
      },
      client,
    );
  }
}
