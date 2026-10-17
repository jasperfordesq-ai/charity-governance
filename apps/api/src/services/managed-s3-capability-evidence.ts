import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { SupabaseS3CapabilityProof } from './supabase-s3-capability-proof.js';
import {
  S3CapabilityVault,
  s3CapabilityVaultStorageSchema,
} from './s3-capability-vault.js';
import {
  S3CapabilityEvidence,
  s3CapabilityEvidenceStorageSchema,
} from './s3-capability-evidence.js';
import {
  s3CapabilityBaselineSchema,
  s3CapabilityObservationSchema,
} from './s3-capability-contract.js';
import { S3CapabilityCohortEvidence } from './s3-capability-cohort-evidence.js';
import {
  s3CapabilityChildAttempt,
  s3CapabilityCohortBaselineSchema,
  s3CapabilityCohortObservationSchema,
  type S3CapabilityParentBinding,
  type S3CapabilityCohortPin,
} from './s3-capability-cohort-contract.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex'),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const key = z.object({ id: uuid, sha256: sha }).strict(),
  secret = z.object({ id: uuid, secret: z.string() }).strict();
const registrySchema = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    mode: z.literal('WORKING_CAPABILITIES'),
    region: z.enum(['eu-west-1', 'eu-central-1']),
    bucket: z.literal('charitypilot-recovery-s3-probes'),
    providerRelease: z
      .object({
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        imageDigest: sha,
      })
      .strict(),
    control: key,
    retired: z
      .array(
        z
          .object({
            id: uuid,
            accessKeyIdSha256: sha,
            secretAccessKeySha256: sha,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine((r) => {
    return (
      new Set([r.control.id, ...r.retired.map((k) => k.id)]).size ===
        r.retired.length + 1 &&
      new Set(r.retired.map((k) => k.accessKeyIdSha256)).size ===
        r.retired.length &&
      new Set(r.retired.map((k) => k.secretAccessKeySha256)).size ===
        r.retired.length
    );
  });
const secretsSchema = z
  .object({
    control: secret,
    retired: z
      .array(
        z
          .object({
            id: uuid,
            accessKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            secretAccessKey: z.string().regex(/^[!-~]{16,512}$/),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const failure = () =>
  new Error(
    'Managed S3 capability cohort is unresolved; preserve the original attempt without retrying uploads or evidence',
  );
type Child = {
  credentialId: string;
  endpoint: 'DIRECT' | 'GATEWAY';
  attemptId: string;
  probe: SupabaseS3CapabilityProof;
  vault: S3CapabilityVault;
  evidence: S3CapabilityEvidence;
};
type Clients = {
  vault?: S3Client;
  evidence?: S3Client;
  manifest?: S3Client;
  kms?: KMSClient;
};

/** All configured working S3 keys at both endpoints. No issuer-inventory attestation. No parent acquisition or dispatch. */
export class ManagedS3CapabilityEvidence {
  private readonly registry: z.infer<typeof registrySchema>;
  private readonly secrets: z.infer<typeof secretsSchema>;
  private readonly vaultStorage: z.infer<typeof s3CapabilityVaultStorageSchema>;
  private readonly evidenceStorage: z.infer<
    typeof s3CapabilityEvidenceStorageSchema
  >;
  constructor(
    raw: unknown,
    rawSecrets: unknown,
    vaultStorage: unknown,
    evidenceStorage: unknown,
    private readonly storageCredentials: NonNullable<
      S3ClientConfig['credentials']
    >,
    private readonly kmsCredentials: NonNullable<
      KMSClientConfig['credentials']
    >,
    private readonly transport: typeof fetch = fetch,
    private readonly clients?: Clients,
  ) {
    this.registry = registrySchema.parse(raw);
    this.registry.retired.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    this.secrets = secretsSchema.parse(rawSecrets);
    this.secrets.retired.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    this.vaultStorage = s3CapabilityVaultStorageSchema.parse(vaultStorage);
    this.evidenceStorage =
      s3CapabilityEvidenceStorageSchema.parse(evidenceStorage);
    const r = this.registry;
    if (
      !storageCredentials ||
      !kmsCredentials ||
      this.vaultStorage.installationId !== r.installationId ||
      this.evidenceStorage.installationId !== r.installationId ||
      this.vaultStorage.projectRef !== r.projectRef
    )
      throw failure();
    if (
      this.secrets.control.id !== r.control.id ||
      hash(this.secrets.control.secret) !== r.control.sha256 ||
      !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(this.secrets.control.secret) ||
      this.secrets.retired.length !== r.retired.length
    )
      throw failure();
    for (let i = 0; i < r.retired.length; i++) {
      const k = this.secrets.retired[i],
        expected = r.retired[i];
      if (
        k.id !== expected.id ||
        hash(k.accessKeyId) !== expected.accessKeyIdSha256 ||
        hash(k.secretAccessKey) !== expected.secretAccessKeySha256
      )
        throw failure();
    }
  }
  configurationDigest(installationId = this.registry.installationId) {
    if (installationId !== this.registry.installationId) throw failure();
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'ALL_CONFIGURED_WORKING_S3_KEYS_BOTH_ENDPOINTS_V1',
        registry: this.registry,
        vault: this.vaultStorage,
        evidence: this.evidenceStorage,
      }),
    );
  }
  assertStorageScope(raw: unknown) {
    const s = z
        .object({
          installationId: z.string(),
          projectRef: z.string(),
          captureKeyId: uuid,
          region: z.string(),
        })
        .strict()
        .parse(raw),
      r = this.registry;
    if (
      s.installationId !== r.installationId ||
      s.projectRef !== r.projectRef ||
      s.captureKeyId !== r.control.id ||
      s.region !== r.region
    )
      throw failure();
  }
  forAttempt(raw: unknown) {
    const parent = credentialReadMaintenanceBindingSchema.parse(raw),
      digest = this.configurationDigest(),
      r = this.registry;
    const children = r.retired.flatMap((retired, i) =>
      (['DIRECT', 'GATEWAY'] as const).map((endpoint) => {
        const attemptId = s3CapabilityChildAttempt(
            parent,
            retired.id,
            endpoint,
            digest,
          ),
          maintenance = { ...parent, attemptId },
          probe = new SupabaseS3CapabilityProof(
            {
              installationId: r.installationId,
              projectRef: r.projectRef,
              region: r.region,
              bucket: r.bucket,
              providerRelease: r.providerRelease,
              control: r.control,
              retired,
              maintenance,
              endpoint,
            },
            { control: this.secrets.control, retired: this.secrets.retired[i] },
            this.transport,
          ),
          vault = new S3CapabilityVault(
            {
              ...this.vaultStorage,
              maintenance,
              probeDigest: probe.configurationDigest(),
              endpoint,
              region: r.region,
              accessKeyIdSha256: retired.accessKeyIdSha256,
            },
            this.storageCredentials,
            this.kmsCredentials,
            { storage: this.clients?.vault, kms: this.clients?.kms },
          ),
          evidence = new S3CapabilityEvidence(
            {
              ...this.evidenceStorage,
              maintenance,
              credentialId: retired.id,
              probeDigest: probe.configurationDigest(),
              capabilityCustodyDigest: vault.configurationDigest(),
            },
            this.storageCredentials,
            this.clients?.evidence,
          );
        return {
          credentialId: retired.id,
          endpoint,
          attemptId,
          probe,
          vault,
          evidence,
        };
      }),
    );
    const manifests = new S3CapabilityCohortEvidence(
      {
        storage: this.evidenceStorage,
        maintenance: parent,
        configurationDigest: digest,
        credentialIds: r.retired.map((k) => k.id),
      },
      this.storageCredentials,
      this.clients?.manifest,
    );
    return new S3CapabilityCohortAttempt(parent, digest, children, manifests);
  }
}

class S3CapabilityCohortAttempt {
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(
    private readonly parent: S3CapabilityParentBinding,
    private readonly digest: string,
    private readonly children: Child[],
    private readonly manifests: S3CapabilityCohortEvidence,
  ) {}
  private async bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal,
      timer = setTimeout(() => controller.abort(), 300000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const result = await Promise.race([run(signal), cancelled]);
      signal.throwIfAborted();
      return result;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  private async readBaseline(pin: unknown, signal: AbortSignal) {
    const artifact = await this.manifests.observeBaseline(pin, signal),
      value = s3CapabilityCohortBaselineSchema.parse(JSON.parse(artifact.body));
    for (let i = 0; i < this.children.length; i++) {
      signal.throwIfAborted();
      const child = this.children[i],
        entry = value.entries[i];
      if (
        entry.credentialId !== child.credentialId ||
        entry.endpoint !== child.endpoint ||
        entry.childAttemptId !== child.attemptId
      )
        throw failure();
      const retained = child.probe.assertBaseline(
        await child.evidence.observeBaseline(entry.baselinePin, signal),
        child.vault.configurationDigest(),
      );
      const childBaseline = s3CapabilityBaselineSchema.parse(
        JSON.parse(retained.body),
      );
      if (
        Date.parse(childBaseline.capturedAt) > Date.parse(value.capturedAt) ||
        Date.parse(value.capturedAt) > Date.now() + 60000
      )
        throw failure();
    }
    return { artifact, value };
  }
  async baseline(caller?: AbortSignal): Promise<S3CapabilityCohortPin> {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.bounded(async (signal) => {
      const entries: z.infer<
        typeof s3CapabilityCohortBaselineSchema
      >['entries'] = [];
      for (const child of this.children) {
        signal.throwIfAborted();
        const original = child.probe.assertBaseline(
          await child.probe.baseline(
            (v, s) => child.vault.retain(v, s),
            child.vault.configurationDigest(),
            signal,
          ),
          child.vault.configurationDigest(),
        );
        const baselinePin = await child.evidence.publishBaseline(
          original,
          signal,
        );
        child.probe.assertBaseline(
          await child.evidence.observeBaseline(baselinePin, signal),
          child.vault.configurationDigest(),
        );
        entries.push({
          credentialId: child.credentialId,
          endpoint: child.endpoint,
          childAttemptId: child.attemptId,
          baselinePin,
        });
      }
      const body = JSON.stringify(
          s3CapabilityCohortBaselineSchema.parse({
            format: 1,
            kind: 'S3_CAPABILITY_COHORT_BASELINE_V1',
            configurationDigest: this.digest,
            maintenance: this.parent,
            capturedAt: new Date().toISOString(),
            entries,
          }),
        ),
        pin = await this.manifests.publishBaseline(
          { body, sha256: hash(body) },
          signal,
        );
      await this.readBaseline(pin, signal);
      return pin;
    }, caller);
  }
  async observeBaseline(pin: unknown, caller?: AbortSignal) {
    return this.bounded((signal) => this.readBaseline(pin, signal), caller);
  }
  private async readObservation(
    pin: unknown,
    baselinePin: unknown,
    signal: AbortSignal,
  ) {
    const baseline = await this.readBaseline(baselinePin, signal),
      artifact = await this.manifests.observeObservation(
        pin,
        baselinePin,
        signal,
      ),
      value = s3CapabilityCohortObservationSchema.parse(
        JSON.parse(artifact.body),
      );
    for (let i = 0; i < this.children.length; i++) {
      signal.throwIfAborted();
      const child = this.children[i],
        entry = value.entries[i],
        retained = await child.evidence.observeObservation(
          entry.observationPin,
          baseline.value.entries[i].baselinePin,
          signal,
        ),
        report = s3CapabilityObservationSchema.parse(JSON.parse(retained.body));
      if (
        entry.credentialId !== child.credentialId ||
        entry.endpoint !== child.endpoint ||
        entry.childAttemptId !== child.attemptId ||
        entry.observationDigest !== report.observationDigest ||
        Date.parse(report.observedAt) < Date.parse(baseline.value.capturedAt) ||
        Date.parse(report.observedAt) > Date.parse(value.observedAt) ||
        Date.parse(value.observedAt) - Date.parse(report.observedAt) > 240000 ||
        Date.parse(value.observedAt) > Date.now() + 60000
      )
        throw failure();
    }
    return { artifact, value };
  }
  async verifyRefusal(baselinePin: unknown, caller?: AbortSignal) {
    if (this.verificationAttempted) throw failure();
    this.verificationAttempted = true;
    return this.bounded(async (signal) => {
      const baseline = await this.readBaseline(baselinePin, signal),
        entries: z.infer<
          typeof s3CapabilityCohortObservationSchema
        >['entries'] = [];
      for (let i = 0; i < this.children.length; i++) {
        signal.throwIfAborted();
        const child = this.children[i],
          entry = baseline.value.entries[i],
          original = child.probe.assertBaseline(
            await child.evidence.observeBaseline(entry.baselinePin, signal),
            child.vault.configurationDigest(),
          ),
          saved = s3CapabilityBaselineSchema.parse(JSON.parse(original.body));
        const report = await child.vault.withCredential(
            saved.capabilityPin,
            saved.capabilityPin.reference,
            (secret, s) =>
              child.probe.verifyRefusal(
                original,
                child.vault.configurationDigest(),
                secret,
                s,
              ),
            signal,
          ),
          observationPin = await child.evidence.publishObservation(
            report,
            entry.baselinePin,
            signal,
          );
        entries.push({
          credentialId: child.credentialId,
          endpoint: child.endpoint,
          childAttemptId: child.attemptId,
          observationPin,
          observationDigest: report.observationDigest,
        });
      }
      const report = s3CapabilityCohortObservationSchema.parse({
          format: 1,
          kind: 'S3_CAPABILITY_COHORT_OBSERVATION_V1',
          configurationDigest: this.digest,
          maintenance: this.parent,
          baselineSha256: baseline.artifact.sha256,
          observedAt: new Date().toISOString(),
          entries,
          configuredCredentialCohortRefusalsObserved: true,
          coverage:
            'ORIGINAL_KEY_PRESIGNED_PUT_AND_MULTIPART_PER_CONFIGURED_KEY_AT_BOTH_ENDPOINTS',
          s3CredentialsRevoked: false,
          presignedCapabilitiesRevoked: false,
          multipartUploadsDrained: false,
          credentialInventoryComplete: false,
          inFlightWritesDrained: false,
          providerReleaseAttested: false,
          wholeStorageQuiesced: false,
          actionAuthorized: false,
        }),
        pin = await this.manifests.publishObservation(
          report,
          baselinePin,
          signal,
        );
      const retained = await this.readObservation(pin, baselinePin, signal);
      return {
        pin,
        observationDigest: retained.artifact.sha256,
        configuredCredentialCohortRefusalsObserved: true as const,
        s3CredentialsRevoked: false as const,
        actionAuthorized: false as const,
      };
    }, caller);
  }
  async observeObservation(
    pin: unknown,
    baselinePin: unknown,
    caller?: AbortSignal,
  ) {
    return this.bounded(
      (signal) => this.readObservation(pin, baselinePin, signal),
      caller,
    );
  }
}
