import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  SupabaseSignedResumableUploadProof,
  supabaseSignedResumableRegistrySchema,
} from './supabase-signed-resumable-upload-proof.js';
import {
  S3SignedResumableCredentialVault,
  signedResumableVaultStorageSchema,
} from './signed-resumable-credential-vault.js';
import {
  S3SignedResumableUploadEvidence,
  signedResumableEvidenceStorageSchema,
} from './signed-resumable-upload-evidence.js';
import {
  parseSignedResumableBaseline,
  parseSignedResumableObservation,
  signedTusHash as hash,
} from './signed-resumable-upload-contract.js';
import type { ManagedSignedUploadEvidence } from './managed-signed-upload-evidence.js';
const uuid = z.string().uuid(),
  key = z.object({ id: uuid, secret: z.string() }).strict(),
  secretsSchema = z.object({ control: key, gateway: key }).strict();
const failure = () =>
  new Error(
    'Managed signed resumable evidence is unresolved; preserve the original attempt',
  );
type Binding = z.infer<typeof credentialReadMaintenanceBindingSchema>;
/** Separate UUIDv8 identity, never an acquisition/acknowledgement grant. */
export function signedResumableChildAttempt(
  raw: unknown,
  configurationDigest: string,
) {
  const parent = credentialReadMaintenanceBindingSchema.parse(raw);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(configurationDigest);
  const bytes = createHash('sha256')
    .update(
      JSON.stringify({
        purpose: 'CHARITYPILOT_SIGNED_TUS_CHILD_V1',
        parent,
        configurationDigest,
      }),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return uuid.parse(
    h.slice(0, 8) +
      '-' +
      h.slice(8, 12) +
      '-' +
      h.slice(12, 16) +
      '-' +
      h.slice(16, 20) +
      '-' +
      h.slice(20),
  );
}
export class ManagedSignedResumableUploadEvidence {
  private readonly registry: z.infer<
    typeof supabaseSignedResumableRegistrySchema
  >;
  private readonly secrets: z.infer<typeof secretsSchema>;
  private readonly vaultStorage: z.infer<
    typeof signedResumableVaultStorageSchema
  >;
  private readonly artifactStorage: z.infer<
    typeof signedResumableEvidenceStorageSchema
  >;
  private readonly signedDigest: string;
  constructor(
    signed: ManagedSignedUploadEvidence,
    format: unknown,
    rawSecrets: unknown,
    vaultStorage: unknown,
    artifactStorage: unknown,
    private readonly storageCredentials: NonNullable<
      S3ClientConfig['credentials']
    >,
    private readonly kmsCredentials: NonNullable<
      KMSClientConfig['credentials']
    >,
    private readonly transport: typeof fetch = fetch,
    private readonly clients?: {
      vault?: S3Client;
      kms?: KMSClient;
      evidence?: S3Client;
    },
  ) {
    this.registry = supabaseSignedResumableRegistrySchema.parse(
      signed.resumableProofRegistry(
        z.enum(['PATH_V1', 'FILE_VERSION_V1']).parse(format),
      ),
    );
    this.signedDigest = signed.configurationDigest();
    this.secrets = secretsSchema.parse(rawSecrets);
    this.vaultStorage = signedResumableVaultStorageSchema.parse(vaultStorage);
    this.artifactStorage =
      signedResumableEvidenceStorageSchema.parse(artifactStorage);
    if (
      !storageCredentials ||
      !kmsCredentials ||
      this.vaultStorage.installationId !== this.registry.installationId ||
      this.artifactStorage.installationId !== this.registry.installationId ||
      this.vaultStorage.projectRef !== this.registry.projectRef ||
      this.vaultStorage.uploadIdFormat !== this.registry.uploadIdFormat
    )
      throw failure();
    for (const name of ['control', 'gateway'] as const) {
      const k = this.secrets[name];
      if (
        k.id !== this.registry[name].id ||
        hash(k.secret) !== this.registry[name].sha256 ||
        !(
          name === 'control'
            ? /^sb_secret_[A-Za-z0-9_-]{16,512}$/
            : /^sb_publishable_[A-Za-z0-9_-]{16,512}$/
        ).test(k.secret)
      )
        throw failure();
    }
  }
  configurationDigest(installationId = this.registry.installationId) {
    if (installationId !== this.registry.installationId) throw failure();
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'ORIGINAL_SIGNED_TUS_WITH_INDEPENDENT_EVIDENCE_V1',
        registry: this.registry,
        vault: this.vaultStorage,
        evidence: this.artifactStorage,
        signedEvidence: this.signedDigest,
      }),
    );
  }
  assertSignedScope(digest: string) {
    if (digest !== this.signedDigest) throw failure();
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
      .parse(raw);
    if (
      s.installationId !== this.registry.installationId ||
      s.projectRef !== this.registry.projectRef ||
      s.captureKeyId !== this.registry.control.id
    )
      throw failure();
  }
  forAttempt(raw: unknown) {
    const parent = credentialReadMaintenanceBindingSchema.parse(raw),
      maintenance = {
        ...parent,
        attemptId: signedResumableChildAttempt(
          parent,
          this.configurationDigest(),
        ),
      },
      probe = new SupabaseSignedResumableUploadProof(
        { ...this.registry, maintenance },
        this.secrets,
        this.transport,
      ),
      vault = new S3SignedResumableCredentialVault(
        {
          ...this.vaultStorage,
          maintenance,
          probeDigest: probe.configurationDigest(),
        },
        this.storageCredentials,
        this.kmsCredentials,
        { storage: this.clients?.vault, kms: this.clients?.kms },
      ),
      old = this.registry.previousIssuer,
      evidence = new S3SignedResumableUploadEvidence(
        {
          ...this.artifactStorage,
          maintenance,
          probeDigest: probe.configurationDigest(),
          credentialCustodyDigest: vault.configurationDigest(),
          issuer: {
            providerKeyId: old.providerKeyId,
            tokenKid: old.tokenKid,
            fingerprint: old.fingerprint,
          },
        },
        this.storageCredentials,
        this.clients?.evidence,
      );
    return new SignedResumableAttempt(maintenance, probe, vault, evidence);
  }
}
class SignedResumableAttempt {
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(
    readonly maintenance: Binding,
    private readonly probe: SupabaseSignedResumableUploadProof,
    private readonly vault: S3SignedResumableCredentialVault,
    private readonly evidence: S3SignedResumableUploadEvidence,
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
      const value = await Promise.race([run(signal), cancelled]);
      signal.throwIfAborted();
      return value;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  private async readBaseline(pin: unknown, signal: AbortSignal) {
    const a = await this.evidence.observeBaseline(pin, signal);
    this.probe.assertBaseline(a, this.vault.configurationDigest());
    return a;
  }
  async baseline(caller?: AbortSignal) {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.bounded(async (signal) => {
      const a = await this.probe.baseline(
          (v, s) => this.vault.retain(v, s),
          this.vault.configurationDigest(),
          signal,
        ),
        pin = await this.evidence.publishBaseline(a, signal);
      await this.readBaseline(pin, signal);
      return pin;
    }, caller);
  }
  async observeBaseline(pin: unknown, caller?: AbortSignal) {
    return this.bounded(async (signal) => {
      const artifact = await this.readBaseline(pin, signal);
      return { artifact, value: parseSignedResumableBaseline(artifact).value };
    }, caller);
  }
  async verifyRefusal(baselinePin: unknown, caller?: AbortSignal) {
    if (this.verificationAttempted) throw failure();
    this.verificationAttempted = true;
    return this.bounded(async (signal) => {
      const a = await this.readBaseline(baselinePin, signal),
        b = parseSignedResumableBaseline(a).value,
        report = await this.vault.withCredential(
          b.credentialPin,
          b.credentialPin.reference,
          (v, s) =>
            this.probe.verifyRefusal(a, this.vault.configurationDigest(), v, s),
          signal,
        ),
        pin = await this.evidence.publishObservation(
          report,
          baselinePin,
          signal,
        );
      return {
        pin,
        observationDigest: report.observationDigest,
        testedSignedResumablePatchRefusalObserved: true as const,
      };
    }, caller);
  }
  async observeObservation(
    pin: unknown,
    baselinePin: unknown,
    caller?: AbortSignal,
  ) {
    return this.bounded(async (signal) => {
      await this.readBaseline(baselinePin, signal);
      const artifact = await this.evidence.observeObservation(
        pin,
        baselinePin,
        signal,
      );
      return {
        artifact,
        value: parseSignedResumableObservation(artifact).value,
      };
    }, caller);
  }
}
