import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import type { SupabaseStorageWriterControl } from './supabase-storage-writer-control.js';
import { ManagedS3CapabilityEvidence } from './managed-s3-capability-evidence.js';
import { ManagedS3CurrentFeatureEvidence } from './managed-s3-current-feature-evidence.js';
import { s3CapabilityCohortPinSchema } from './s3-capability-cohort-contract.js';
import { s3FeatureHash as hash } from './s3-feature-boundary-contract.js';
const modeSchema = z.enum(['WORKING_CAPABILITIES', 'CURRENT_DISABLED']);
const scopeSchema = z
  .object({
    installationId: z.string(),
    projectRef: z.string(),
    captureKeyId: z.string().uuid(),
    region: z.string(),
  })
  .strict();
const failure = () =>
  new Error(
    'Explicit S3 maintenance mode/scope is unresolved; preserve the original attempt without fallback or enabling S3',
  );
type Clients = {
  vault?: S3Client;
  evidence?: S3Client;
  manifest?: S3Client;
  kms?: KMSClient;
};
/** Closed mode selection only. No mode guessing/fallback, original parent
 * acquisition, writer closure, provider-wide exclusion or reopening authority. */
export class ManagedS3MaintenanceEvidence {
  private readonly selectedMode: z.infer<typeof modeSchema>;
  private readonly branch:
    | ManagedS3CapabilityEvidence
    | ManagedS3CurrentFeatureEvidence;
  private readonly scope: z.infer<typeof scopeSchema>;
  private readonly metadataDigest: string;
  constructor(
    raw: unknown,
    secrets: unknown,
    metadata: SupabaseStorageWriterControl,
    vaultStorage: unknown,
    evidenceStorage: unknown,
    storageCredentials: NonNullable<S3ClientConfig['credentials']>,
    kmsCredentials: NonNullable<KMSClientConfig['credentials']> | null,
    transport: typeof fetch = fetch,
    clients?: Clients,
  ) {
    this.selectedMode = z
      .object({ mode: modeSchema })
      .passthrough()
      .parse(raw).mode;
    this.scope = scopeSchema.parse(metadata.s3FeatureProofScope());
    this.metadataDigest = metadata.configurationDigest(
      this.scope.installationId,
    );
    if (this.selectedMode === 'WORKING_CAPABILITIES') {
      if (!kmsCredentials) throw failure();
      const branch = new ManagedS3CapabilityEvidence(
        raw,
        secrets,
        vaultStorage,
        evidenceStorage,
        storageCredentials,
        kmsCredentials,
        transport,
        clients,
      );
      branch.assertStorageScope(this.scope);
      this.branch = branch;
    } else {
      if (
        vaultStorage !== null ||
        kmsCredentials !== null ||
        clients?.vault ||
        clients?.kms ||
        clients?.evidence
      )
        throw failure();
      const control = z
        .object({
          control: z
            .object({ id: z.string().uuid(), secret: z.string() })
            .strict(),
        })
        .strict()
        .parse(secrets).control;
      if (control.id !== this.scope.captureKeyId) throw failure();
      this.branch = new ManagedS3CurrentFeatureEvidence(
        raw,
        control.secret,
        metadata,
        evidenceStorage,
        storageCredentials,
        transport,
        clients?.manifest,
      );
    }
  }
  get mode() {
    return this.selectedMode;
  }
  configurationDigest(installationId = this.scope.installationId) {
    if (installationId !== this.scope.installationId) throw failure();
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'EXPLICIT_S3_MODE_BOUND_TO_ACTUAL_STORAGE_CONTROL_V1',
        mode: this.selectedMode,
        scope: this.scope,
        metadataDigest: this.metadataDigest,
        branchDigest: this.branch.configurationDigest(installationId),
      }),
    );
  }
  assertStorageScope(raw: unknown, configurationDigest: string) {
    if (
      JSON.stringify(scopeSchema.parse(raw)) !== JSON.stringify(this.scope) ||
      configurationDigest !== this.metadataDigest
    )
      throw failure();
  }
  forAttempt(raw: unknown) {
    const branch = this.branch.forAttempt(raw),
      mode = this.selectedMode,
      coverage =
        mode === 'WORKING_CAPABILITIES'
          ? 'ORIGINAL_CAPABILITIES_PER_CONFIGURED_KEY_AT_BOTH_ENDPOINTS'
          : 'CURRENT_UNAUTHENTICATED_ROUTES_PRE_AND_POST_AT_BOTH_ENDPOINTS';
    const limits = {
      credentialInventoryComplete: false as const,
      providerReleaseAttested: false as const,
      wholeStorageQuiesced: false as const,
      originalAcknowledgementReconstructed: false as const,
      savedObservationAuthorizesExecution: false as const,
      actionAuthorized: false as const,
    };
    return Object.freeze({
      mode,
      baseline: (signal?: AbortSignal) => branch.baseline(signal),
      observeBaseline: async (pin: unknown, signal?: AbortSignal) => {
        const observed = await branch.observeBaseline(pin, signal);
        return { mode, coverage, artifact: observed.artifact, ...limits };
      },
      verifyRefusal: async (baselinePin: unknown, signal?: AbortSignal) => {
        const verified = await branch.verifyRefusal(baselinePin, signal);
        return {
          mode,
          coverage,
          pin: s3CapabilityCohortPinSchema.parse(verified.pin),
          observationDigest: verified.observationDigest,
          configuredS3CoverageObserved: true as const,
          freshS3CoverageObserved: true as const,
          ...limits,
        };
      },
      observeObservation: async (
        pin: unknown,
        baselinePin: unknown,
        signal?: AbortSignal,
      ) => {
        const observed = await branch.observeObservation(
          pin,
          baselinePin,
          signal,
        );
        return {
          mode,
          coverage,
          artifact: observed.artifact,
          observationDigest: observed.artifact.sha256,
          observedAt: observed.value.observedAt,
          recordedS3CoverageObserved: true as const,
          freshS3CoverageObserved: false as const,
          ...limits,
        };
      },
    });
  }
}
