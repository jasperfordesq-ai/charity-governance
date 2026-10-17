import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { SupabaseS3FeatureBoundaryProof } from './supabase-s3-feature-boundary-proof.js';
import type { SupabaseStorageWriterControl } from './supabase-storage-writer-control.js';
import { S3MaintenanceArtifactStore } from './maintenance-artifact-store.js';
import { s3CapabilityEvidenceStorageSchema } from './s3-capability-evidence.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { s3FeatureHash as hash } from './s3-feature-boundary-contract.js';
import {
  s3CurrentFeatureBaselineSchema,
  s3CurrentFeatureObservationSchema,
  s3CurrentFeaturePinSchema,
  parseS3CurrentFeatureBaseline,
  parseS3CurrentFeatureObservation,
  s3CurrentFeatureObservationArtifact,
  assertS3CurrentFeaturePair,
} from './s3-current-feature-evidence-contract.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const registrySchema = z
  .object({
    mode: z.literal('CURRENT_DISABLED'),
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    region: z.enum(['eu-west-1', 'eu-central-1']),
    bucket: z.literal('charitypilot-recovery-s3-probes'),
    providerRelease: z
      .object({
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        imageDigest: sha,
      })
      .strict(),
    control: z.object({ id: z.string().uuid(), sha256: sha }).strict(),
  })
  .strict();
const failure = () =>
  new Error(
    'Managed current-S3 feature evidence is unresolved; preserve the original attempt without retry or enabling S3',
  );
type Pin = z.infer<typeof s3CurrentFeaturePinSchema>;
/** Explicit current-disabled mode only, never historical empty-cohort exemption.
 * Active synthetic canaries require the original durable parent acquisition. */
export class ManagedS3CurrentFeatureEvidence {
  private readonly registry: z.infer<typeof registrySchema>;
  private readonly storage: z.infer<typeof s3CapabilityEvidenceStorageSchema>;
  private readonly control: string;
  constructor(
    raw: unknown,
    control: unknown,
    private readonly metadata: SupabaseStorageWriterControl,
    storage: unknown,
    private readonly credentials: NonNullable<S3ClientConfig['credentials']>,
    private readonly transport: typeof fetch = fetch,
    private readonly client?: S3Client,
  ) {
    this.registry = registrySchema.parse(raw);
    this.storage = s3CapabilityEvidenceStorageSchema.parse(storage);
    this.control = z
      .string()
      .regex(/^sb_secret_[A-Za-z0-9_-]{16,512}$/)
      .parse(control);
    const r = this.registry,
      s = metadata.s3FeatureProofScope();
    if (
      !credentials ||
      hash(this.control) !== r.control.sha256 ||
      this.storage.installationId !== r.installationId ||
      s.installationId !== r.installationId ||
      s.projectRef !== r.projectRef ||
      s.region !== r.region ||
      s.captureKeyId !== r.control.id
    )
      throw failure();
  }
  configurationDigest(installationId = this.registry.installationId) {
    if (installationId !== this.registry.installationId) throw failure();
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'EXPLICIT_CURRENT_DISABLED_S3_PRE_POST_EVIDENCE_V1',
        registry: this.registry,
        storage: this.storage,
        metadata: this.metadata.configurationDigest(),
      }),
    );
  }
  forAttempt(raw: unknown) {
    const maintenance = credentialReadMaintenanceBindingSchema.parse(raw),
      digest = this.configurationDigest(),
      { mode, ...registry } = this.registry;
    const pre = new SupabaseS3FeatureBoundaryProof(
        { ...registry, maintenance, stage: 'PRE_CLOSURE' },
        this.control,
        this.metadata,
        this.transport,
      ),
      post = new SupabaseS3FeatureBoundaryProof(
        { ...registry, maintenance, stage: 'POST_CLOSURE' },
        this.control,
        this.metadata,
        this.transport,
      );
    const scope = (v: {
      configurationDigest: string;
      maintenance: unknown;
    }) => {
      if (
        v.configurationDigest !== digest ||
        JSON.stringify(v.maintenance) !== JSON.stringify(maintenance)
      )
        throw failure();
    };
    const baseline = (raw: unknown) => {
      const a = parseS3CurrentFeatureBaseline(raw),
        v = s3CurrentFeatureBaselineSchema.parse(JSON.parse(a.body));
      scope(v);
      pre.assertObservation(v.preObservation);
      return a;
    };
    const observation = (raw: unknown) => {
      const a = parseS3CurrentFeatureObservation(raw),
        v = s3CurrentFeatureObservationSchema.parse(JSON.parse(a.body));
      scope(v);
      post.assertObservation(v.postObservation);
      return a;
    };
    const evidence = new S3MaintenanceArtifactStore<Pin>(
      { ...this.storage, maintenance },
      this.credentials,
      {
        namespace: 's3-current-feature',
        pinSchema: s3CurrentFeaturePinSchema,
        limits: { BASELINE: 16384, OBSERVATION: 16384 },
        baseline,
        parseObservation: observation,
        observationFromValue: s3CurrentFeatureObservationArtifact,
        assertPair: assertS3CurrentFeaturePair,
        failure,
      },
      this.client,
    );
    return new CurrentFeatureAttempt(maintenance, digest, pre, post, evidence);
  }
}
class CurrentFeatureAttempt {
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(
    private readonly maintenance: z.infer<
      typeof credentialReadMaintenanceBindingSchema
    >,
    private readonly digest: string,
    private readonly pre: SupabaseS3FeatureBoundaryProof,
    private readonly post: SupabaseS3FeatureBoundaryProof,
    private readonly evidence: S3MaintenanceArtifactStore<Pin>,
  ) {}
  async baseline(signal?: AbortSignal) {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    const preObservation = await this.pre.probe(signal),
      body = JSON.stringify(
        s3CurrentFeatureBaselineSchema.parse({
          format: 1,
          kind: 'S3_CURRENT_FEATURE_BASELINE_V1',
          configurationDigest: this.digest,
          maintenance: this.maintenance,
          capturedAt: new Date().toISOString(),
          preObservation,
        }),
      );
    return this.evidence.publishBaseline({ body, sha256: hash(body) }, signal);
  }
  async observeBaseline(pin: unknown, signal?: AbortSignal) {
    const artifact = await this.evidence.observeBaseline(pin, signal);
    return {
      artifact,
      value: s3CurrentFeatureBaselineSchema.parse(JSON.parse(artifact.body)),
    };
  }
  async verifyRefusal(baselinePin: unknown, signal?: AbortSignal) {
    if (this.verificationAttempted) throw failure();
    this.verificationAttempted = true;
    const baseline = await this.observeBaseline(baselinePin, signal),
      postObservation = await this.post.probe(signal);
    const report = s3CurrentFeatureObservationSchema.parse({
      format: 1,
      kind: 'S3_CURRENT_FEATURE_OBSERVATION_V1',
      configurationDigest: this.digest,
      maintenance: this.maintenance,
      baselineSha256: baseline.artifact.sha256,
      observedAt: new Date().toISOString(),
      postObservation,
      configuredCurrentFeatureBoundaryObserved: true,
      coverage:
        'CURRENT_UNAUTHENTICATED_S3_FEATURE_BOUNDARY_PRE_AND_POST_BOTH_ENDPOINTS',
      originalWorkingS3BaselineProven: false,
      historicalNeverEnabledProven: false,
      credentialInventoryComplete: false,
      s3CredentialsRevoked: false,
      presignedCapabilitiesRevoked: false,
      multipartUploadsDrained: false,
      unknownMultipartSideEffectsExcluded: false,
      inFlightWritesDrained: false,
      providerReleaseAttested: false,
      controlPlaneWritersExcluded: false,
      wholeStorageQuiesced: false,
      originalAcknowledgementReconstructed: false,
      savedObservationAuthorizesExecution: false,
      actionAuthorized: false,
    });
    const pin = await this.evidence.publishObservation(
        report,
        baselinePin,
        signal,
      ),
      retained = await this.observeObservation(pin, baselinePin, signal);
    return {
      pin,
      observationDigest: retained.artifact.sha256,
      configuredCurrentFeatureBoundaryObserved: true as const,
      actionAuthorized: false as const,
    };
  }
  async observeObservation(
    pin: unknown,
    baselinePin: unknown,
    signal?: AbortSignal,
  ) {
    const artifact = await this.evidence.observeObservation(
      pin,
      baselinePin,
      signal,
    );
    return {
      artifact,
      value: s3CurrentFeatureObservationSchema.parse(JSON.parse(artifact.body)),
    };
  }
}
