import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import { SupabaseResumableUploadProof } from './supabase-resumable-upload-proof.js';
import {
  S3ResumableLocationVault,
  resumableLocationVaultStorageSchema,
} from './resumable-location-vault.js';
import {
  S3ResumableUploadEvidence,
  resumableUploadEvidenceStorageSchema,
} from './resumable-upload-evidence.js';
import {
  resumableUploadBaselineSchema,
  resumableUploadObservationSchema,
} from './resumable-upload-evidence-contract.js';
import { S3ResumableCohortEvidence } from './resumable-cohort-evidence.js';
import {
  resumableChildAttempt,
  resumableCohortBaselineSchema,
  resumableCohortObservationSchema,
  type ResumableParentBinding,
  type ResumableCohortPin,
} from './resumable-cohort-contract.js';
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
    bucket: z.literal('charitypilot-recovery-resumable-probes'),
    providerRelease: z
      .object({
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        imageDigest: sha,
      })
      .strict(),
    uploadIdFormat: z.enum(['PATH_V1', 'FILE_VERSION_V1']),
    control: key,
    retired: z.array(key).min(1).max(50),
  })
  .strict()
  .refine((r) => {
    const all = [r.control, ...r.retired];
    return (
      new Set(all.map((k) => k.id)).size === all.length &&
      new Set(all.map((k) => k.sha256)).size === all.length
    );
  });
const secretsSchema = z
  .object({ control: secret, retired: z.array(secret).min(1).max(50) })
  .strict();
const failure = () =>
  new Error(
    'Managed resumable cohort is unresolved; preserve the original attempt without retrying uploads or evidence',
  );
type Child = {
  credentialId: string;
  attemptId: string;
  probe: SupabaseResumableUploadProof;
  vault: S3ResumableLocationVault;
  evidence: S3ResumableUploadEvidence;
};
type Clients = {
  vault?: S3Client;
  evidence?: S3Client;
  manifest?: S3Client;
  kms?: KMSClient;
};

/** Complete configured modern-secret cohort. No parent acquisition or dispatch. */
export class ManagedResumableUploadEvidence {
  private readonly registry: z.infer<typeof registrySchema>;
  private readonly secrets: z.infer<typeof secretsSchema>;
  private readonly vaultStorage: z.infer<
    typeof resumableLocationVaultStorageSchema
  >;
  private readonly evidenceStorage: z.infer<
    typeof resumableUploadEvidenceStorageSchema
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
    this.vaultStorage = resumableLocationVaultStorageSchema.parse(vaultStorage);
    this.evidenceStorage =
      resumableUploadEvidenceStorageSchema.parse(evidenceStorage);
    const r = this.registry;
    if (
      !storageCredentials ||
      !kmsCredentials ||
      this.vaultStorage.installationId !== r.installationId ||
      this.evidenceStorage.installationId !== r.installationId ||
      this.vaultStorage.projectRef !== r.projectRef ||
      this.vaultStorage.uploadIdFormat !== r.uploadIdFormat
    )
      throw failure();
    const expected = [r.control, ...r.retired],
      supplied = [this.secrets.control, ...this.secrets.retired];
    if (expected.length !== supplied.length) throw failure();
    for (let i = 0; i < expected.length; i++) {
      const k = supplied[i];
      if (
        k.id !== expected[i].id ||
        !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(k.secret) ||
        hash(k.secret) !== expected[i].sha256
      )
        throw failure();
    }
  }
  configurationDigest(installationId = this.registry.installationId) {
    if (installationId !== this.registry.installationId) throw failure();
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'ALL_CONFIGURED_RETIRED_MODERN_SECRETS_ORIGINAL_TUS_V1',
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
          secretWriterIds: z.array(uuid),
        })
        .strict()
        .parse(raw),
      r = this.registry;
    if (
      s.installationId !== r.installationId ||
      s.projectRef !== r.projectRef ||
      s.captureKeyId !== r.control.id ||
      JSON.stringify([...s.secretWriterIds].sort()) !==
        JSON.stringify(r.retired.map((k) => k.id))
    )
      throw failure();
  }
  forAttempt(raw: unknown) {
    const parent = credentialReadMaintenanceBindingSchema.parse(raw),
      digest = this.configurationDigest(),
      r = this.registry;
    const children = r.retired.map((retired, i) => {
      const attemptId = resumableChildAttempt(parent, retired.id),
        maintenance = { ...parent, attemptId },
        probe = new SupabaseResumableUploadProof(
          { ...r, retired, maintenance },
          { control: this.secrets.control, retired: this.secrets.retired[i] },
          this.transport,
        ),
        vault = new S3ResumableLocationVault(
          {
            ...this.vaultStorage,
            maintenance,
            probeDigest: probe.configurationDigest(),
          },
          this.storageCredentials,
          this.kmsCredentials,
          { storage: this.clients?.vault, kms: this.clients?.kms },
        ),
        evidence = new S3ResumableUploadEvidence(
          {
            ...this.evidenceStorage,
            maintenance,
            credentialId: retired.id,
            probeDigest: probe.configurationDigest(),
            locationCustodyDigest: vault.configurationDigest(),
          },
          this.storageCredentials,
          this.clients?.evidence,
        );
      return { credentialId: retired.id, attemptId, probe, vault, evidence };
    });
    const manifests = new S3ResumableCohortEvidence(
      {
        storage: this.evidenceStorage,
        maintenance: parent,
        configurationDigest: digest,
        credentialIds: r.retired.map((k) => k.id),
      },
      this.storageCredentials,
      this.clients?.manifest,
    );
    return new ResumableCohortAttempt(parent, digest, children, manifests);
  }
}

class ResumableCohortAttempt {
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(
    private readonly parent: ResumableParentBinding,
    private readonly digest: string,
    private readonly children: Child[],
    private readonly manifests: S3ResumableCohortEvidence,
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
      value = resumableCohortBaselineSchema.parse(JSON.parse(artifact.body));
    for (let i = 0; i < this.children.length; i++) {
      signal.throwIfAborted();
      const child = this.children[i],
        entry = value.entries[i];
      if (
        entry.credentialId !== child.credentialId ||
        entry.childAttemptId !== child.attemptId
      )
        throw failure();
      const retained = child.probe.assertBaseline(
        await child.evidence.observeBaseline(entry.baselinePin, signal),
        child.vault.configurationDigest(),
      );
      const childBaseline = resumableUploadBaselineSchema.parse(
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
  async baseline(caller?: AbortSignal): Promise<ResumableCohortPin> {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.bounded(async (signal) => {
      const entries: z.infer<typeof resumableCohortBaselineSchema>['entries'] =
        [];
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
          childAttemptId: child.attemptId,
          baselinePin,
        });
      }
      const body = JSON.stringify(
          resumableCohortBaselineSchema.parse({
            format: 1,
            kind: 'RESUMABLE_COHORT_BASELINE_V1',
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
      value = resumableCohortObservationSchema.parse(JSON.parse(artifact.body));
    for (let i = 0; i < this.children.length; i++) {
      signal.throwIfAborted();
      const child = this.children[i],
        entry = value.entries[i],
        retained = await child.evidence.observeObservation(
          entry.observationPin,
          baseline.value.entries[i].baselinePin,
          signal,
        ),
        report = resumableUploadObservationSchema.parse(
          JSON.parse(retained.body),
        );
      if (
        entry.credentialId !== child.credentialId ||
        entry.childAttemptId !== child.attemptId ||
        entry.observationDigest !== report.observationDigest ||
        Date.parse(report.observedAt) < Date.parse(baseline.value.capturedAt) ||
        Date.parse(report.observedAt) > Date.parse(value.observedAt)
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
        entries: z.infer<typeof resumableCohortObservationSchema>['entries'] =
          [];
      for (let i = 0; i < this.children.length; i++) {
        signal.throwIfAborted();
        const child = this.children[i],
          entry = baseline.value.entries[i],
          original = child.probe.assertBaseline(
            await child.evidence.observeBaseline(entry.baselinePin, signal),
            child.vault.configurationDigest(),
          ),
          saved = resumableUploadBaselineSchema.parse(
            JSON.parse(original.body),
          );
        const report = await child.vault.withLocation(
            saved.locationPin,
            saved.reference,
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
          childAttemptId: child.attemptId,
          observationPin,
          observationDigest: report.observationDigest,
        });
      }
      const report = resumableCohortObservationSchema.parse({
          format: 1,
          kind: 'RESUMABLE_COHORT_OBSERVATION_V1',
          configurationDigest: this.digest,
          maintenance: this.parent,
          baselineSha256: baseline.artifact.sha256,
          observedAt: new Date().toISOString(),
          entries,
          configuredCredentialCohortRefusalsObserved: true,
          coverage:
            'ONE_ORIGINAL_TUS_SESSION_PER_CONFIGURED_RETIRED_MODERN_SECRET',
          resumableSessionsRevoked: false,
          signedResumableVerified: false,
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
        resumableSessionsRevoked: false as const,
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
