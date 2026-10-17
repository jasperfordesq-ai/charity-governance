import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  SupabaseSignedUploadProof,
  supabaseSignedUploadRegistrySchema,
} from './supabase-signed-upload-proof.js';
import { StorageSignedUploadIssuer } from './storage-signed-upload-issuer.js';
import {
  S3SignedUploadCredentialVault,
  signedUploadVaultStorageSchema,
} from './signed-upload-credential-vault.js';
import {
  S3SignedUploadEvidence,
  signedUploadEvidenceStorageSchema,
} from './signed-upload-evidence.js';
import type { SupabaseSigningKeyControl } from './supabase-signing-key-control.js';
const uuid = z.string().uuid();
const key = z.object({ id: uuid, secret: z.string() }).strict();
const secrets = z.object({ control: key, gateway: key }).strict();
const failure = () => new Error('Managed signed-upload scope is unresolved');
type Clients = { vault?: S3Client; kms?: KMSClient; evidence?: S3Client };

/** Static plan factory. Only acquired attempts create active probe/custody objects. */
export class ManagedSignedUploadEvidence {
  private readonly registry: z.infer<typeof supabaseSignedUploadRegistrySchema>;
  private readonly secrets: z.infer<typeof secrets>;
  private readonly vaultStorage: z.infer<typeof signedUploadVaultStorageSchema>;
  private readonly artifactStorage: z.infer<
    typeof signedUploadEvidenceStorageSchema
  >;
  constructor(
    registry: unknown,
    rawSecrets: unknown,
    vaultStorage: unknown,
    artifactStorage: unknown,
    private readonly storageCredentials: NonNullable<
      S3ClientConfig['credentials']
    >,
    private readonly kmsCredentials: NonNullable<
      KMSClientConfig['credentials']
    >,
    private readonly signing: SupabaseSigningKeyControl,
    private readonly transport: typeof fetch = fetch,
    private readonly clients?: Clients,
  ) {
    this.registry = supabaseSignedUploadRegistrySchema.parse(registry);
    this.secrets = secrets.parse(rawSecrets);
    new StorageSignedUploadIssuer(this.registry.previousIssuer);
    new StorageSignedUploadIssuer(this.registry.currentIssuer);
    this.vaultStorage = signedUploadVaultStorageSchema.parse(vaultStorage);
    this.artifactStorage =
      signedUploadEvidenceStorageSchema.parse(artifactStorage);
    const r = this.registry,
      s = signing.signedUploadScope(),
      old = s.keys.filter((k) => k.disposition === 'REVOKE_PREVIOUS'),
      current = s.keys.filter((k) => k.disposition === 'RETAIN_CURRENT');
    if (
      !storageCredentials ||
      !kmsCredentials ||
      [
        this.vaultStorage.installationId,
        this.artifactStorage.installationId,
        s.installationId,
      ].some((id) => id !== r.installationId) ||
      s.projectRef !== r.projectRef ||
      old.length !== 1 ||
      current.length !== 1 ||
      old[0].id !== r.previousIssuer.providerKeyId ||
      old[0].fingerprint !== r.previousIssuer.fingerprint ||
      old[0].algorithm !== r.previousIssuer.algorithm ||
      current[0].id !== r.currentIssuer.providerKeyId ||
      current[0].fingerprint !== r.currentIssuer.fingerprint ||
      current[0].algorithm !== r.currentIssuer.algorithm
    )
      throw failure();
    for (const name of ['control', 'gateway'] as const) {
      const k = this.secrets[name];
      if (
        k.id !== r[name].id ||
        createHash('sha256').update(k.secret).digest('hex') !== r[name].sha256
      )
        throw failure();
    }
    if (
      !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(this.secrets.control.secret) ||
      !/^sb_publishable_[A-Za-z0-9_-]{16,512}$/.test(
        this.secrets.gateway.secret,
      )
    )
      throw failure();
  }
  configurationDigest(installationId = this.registry.installationId) {
    if (installationId !== this.registry.installationId) throw failure();
    return createHash('sha256')
      .update(
        JSON.stringify({
          format: 1,
          policy: 'ORIGINAL_SIGNED_UPLOAD_DURABLE_EVIDENCE_V1',
          registry: this.registry,
          vault: this.vaultStorage,
          evidence: this.artifactStorage,
          signing: this.signing.configurationDigest(installationId),
        }),
      )
      .digest('hex');
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
    const maintenance = credentialReadMaintenanceBindingSchema.parse(raw),
      probe = new SupabaseSignedUploadProof(
        { ...this.registry, maintenance },
        this.secrets,
        this.transport,
      );
    const vault = new S3SignedUploadCredentialVault(
      {
        ...this.vaultStorage,
        maintenance,
        probeDigest: probe.configurationDigest(),
      },
      this.storageCredentials,
      this.kmsCredentials,
      { storage: this.clients?.vault, kms: this.clients?.kms },
    );
    const evidence = new S3SignedUploadEvidence(
      {
        ...this.artifactStorage,
        maintenance,
        probeDigest: probe.configurationDigest(),
        credentialCustodyDigest: vault.configurationDigest(),
      },
      this.storageCredentials,
      this.clients?.evidence,
    );
    return { probe, vault, evidence };
  }
  async revokeReviewed() {
    return this.signing.revokeReviewed();
  }
  async observeRevoked() {
    return this.signing.observeRevoked();
  }
}
