import { randomUUID } from 'node:crypto';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import { z } from 'zod';
import { EncryptedMaintenanceSecretStore } from './encrypted-maintenance-secret-store.js';
import { resumableLocationVaultStorageSchema } from './resumable-location-vault.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  s3CapabilityPinSchema,
  s3ProbeHash as hash,
} from './s3-capability-contract.js';
import { assertOriginalS3PresignedUrl } from './s3-capability-target.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
export const s3CapabilityVaultStorageSchema =
  resumableLocationVaultStorageSchema
    .innerType()
    .omit({ uploadIdFormat: true })
    .refine(
      (c) =>
        c.dataKeyArn !== c.storageKeyArn &&
        [c.dataKeyArn, c.storageKeyArn].every(
          (k) => k.split(':')[4] === c.accountId,
        ),
    );
const configuration = s3CapabilityVaultStorageSchema
  .innerType()
  .extend({
    maintenance: credentialReadMaintenanceBindingSchema,
    probeDigest: sha,
    endpoint: z.enum(['DIRECT', 'GATEWAY']),
    region: z.enum(['eu-west-1', 'eu-central-1']),
    accessKeyIdSha256: sha,
  })
  .refine(
    (c) =>
      c.dataKeyArn !== c.storageKeyArn &&
      [c.dataKeyArn, c.storageKeyArn].every(
        (k) => k.split(':')[4] === c.accountId,
      ),
  );
const purpose = 'charitypilot-s3-capability-v1';
const contextSchema = z
  .object({
    purpose: z.literal(purpose),
    installationId: z.string(),
    maintenance: credentialReadMaintenanceBindingSchema,
    custodyDigest: sha,
    probeDigest: sha,
    keyArn: z.string(),
    reference: uuid,
    presignedUrlSha256: sha,
    uploadIdSha256: sha,
    secretBytes: z.number().int().min(1).max(12288),
  })
  .strict();
type Context = z.infer<typeof contextSchema>;
type Pin = z.infer<typeof s3CapabilityPinSchema>;
const plainSchema = z
  .object({
    presignedUrl: z.string().min(1).max(8192),
    uploadId: z.string().regex(/^[!-~]{1,1024}$/),
  })
  .strict();
const inputSchema = plainSchema.extend({
  presignedUrlSha256: sha,
  uploadIdSha256: sha,
});
const failure = () =>
  new Error(
    'Encrypted S3 capability custody is unresolved; preserve the original attempt without retrying retention',
  );
/** Combined original presigned URL+UploadId only. No parent execution/ACK reconstruction,
 * provider identity, IAM provisioning or JavaScript string erasure claim. */
export class S3CapabilityVault {
  private readonly config: z.infer<typeof configuration>;
  private readonly store: EncryptedMaintenanceSecretStore<Context, Pin>;
  private attempted = false;
  constructor(
    raw: unknown,
    storageCredentials: NonNullable<S3ClientConfig['credentials']>,
    kmsCredentials: NonNullable<KMSClientConfig['credentials']>,
    clients?: { storage?: S3Client; kms?: KMSClient },
  ) {
    this.config = configuration.parse(raw);
    this.store = new EncryptedMaintenanceSecretStore(
      this.config,
      {
        envelopeKind: 'S3_CAPABILITY_ENVELOPE_V1',
        objectKey:
          'managed-maintenance/' +
          this.config.installationId +
          '/' +
          this.config.maintenance.attemptId +
          '/s3-capability/' +
          this.config.endpoint +
          '/' +
          this.config.region +
          '/' +
          this.config.accessKeyIdSha256 +
          '/' +
          this.config.probeDigest +
          '.json',
        custodyDigest: this.configurationDigest(),
        parseContext: (raw) => contextSchema.parse(raw),
        assertContext: (c) => this.assertContext(c),
        kmsContext: (c) => this.kmsContext(c),
        plaintextBytes: (c) => c.secretBytes,
        parsePin: (raw) => s3CapabilityPinSchema.parse(raw),
        validatePlaintext: (bytes, c) => {
          const v = this.plaintext(bytes);
          if (
            bytes.length !== c.secretBytes ||
            hash(v.presignedUrl) !== c.presignedUrlSha256 ||
            hash(v.uploadId) !== c.uploadIdSha256
          )
            throw failure();
        },
        makePin: (c, stored) =>
          s3CapabilityPinSchema.parse({
            kind: 'S3_CAPABILITY_PIN_V1',
            reference: c.reference,
            custodyDigest: this.configurationDigest(),
            ...stored,
            presignedUrlSha256: c.presignedUrlSha256,
            uploadIdSha256: c.uploadIdSha256,
          }),
      },
      storageCredentials,
      kmsCredentials,
      clients,
    );
  }
  configurationDigest() {
    const c = this.config;
    return hash(
      JSON.stringify({
        format: 1,
        purpose,
        installationId: c.installationId,
        bucket: c.bucket,
        accountId: c.accountId,
        dataKeyArn: c.dataKeyArn,
        storageKeyArn: c.storageKeyArn,
        projectRef: c.projectRef,
        endpoint: c.endpoint,
        region: c.region,
        accessKeyIdSha256: c.accessKeyIdSha256,
        probeDigest: c.probeDigest,
      }),
    );
  }
  private context(
    reference: string,
    presignedUrlSha256: string,
    uploadIdSha256: string,
    secretBytes: number,
  ) {
    return contextSchema.parse({
      purpose,
      installationId: this.config.installationId,
      maintenance: this.config.maintenance,
      custodyDigest: this.configurationDigest(),
      probeDigest: this.config.probeDigest,
      keyArn: this.config.dataKeyArn,
      reference,
      presignedUrlSha256,
      uploadIdSha256,
      secretBytes,
    });
  }
  private assertContext(c: Context) {
    if (
      JSON.stringify(c) !==
      JSON.stringify(
        this.context(
          c.reference,
          c.presignedUrlSha256,
          c.uploadIdSha256,
          c.secretBytes,
        ),
      )
    )
      throw failure();
  }
  private kmsContext(c: Context) {
    this.assertContext(c);
    return {
      purpose,
      installationId: c.installationId,
      attemptId: c.maintenance.attemptId,
      sourceSha: c.maintenance.sourceSha,
      planDigest: c.maintenance.planDigest,
      maintenanceEpoch: String(c.maintenance.maintenanceEpoch),
      custodyDigest: c.custodyDigest,
      probeDigest: c.probeDigest,
      keyArn: c.keyArn,
      reference: c.reference,
      presignedUrlSha256: c.presignedUrlSha256,
      uploadIdSha256: c.uploadIdSha256,
      secretBytes: String(c.secretBytes),
    };
  }
  private validate(v: z.infer<typeof plainSchema>) {
    const c = this.config;
    assertOriginalS3PresignedUrl(v.presignedUrl, {
      installationId: c.installationId,
      projectRef: c.projectRef,
      endpoint: c.endpoint,
      region: c.region,
      attemptId: c.maintenance.attemptId,
      accessKeyIdSha256: c.accessKeyIdSha256,
    });
    // UploadId is an opaque provider value, bound by original hash and probe
    // baseline. Only the active probe establishes its target/existence.
  }
  private plaintext(bytes: Buffer) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      v = plainSchema.parse(JSON.parse(text));
    if (JSON.stringify(v) !== text) throw failure();
    this.validate(v);
    return v;
  }
  async retain(raw: unknown, caller?: AbortSignal): Promise<Pin> {
    if (this.attempted) throw failure();
    this.attempted = true;
    try {
      const v = inputSchema.parse(raw),
        plain = { presignedUrl: v.presignedUrl, uploadId: v.uploadId };
      this.validate(plain);
      if (
        hash(v.presignedUrl) !== v.presignedUrlSha256 ||
        hash(v.uploadId) !== v.uploadIdSha256
      )
        throw failure();
      const bytes = Buffer.from(JSON.stringify(plain));
      try {
        return await this.store.retain(
          this.context(
            randomUUID(),
            v.presignedUrlSha256,
            v.uploadIdSha256,
            bytes.length,
          ),
          bytes,
          caller,
        );
      } finally {
        bytes.fill(0);
      }
    } catch {
      throw failure();
    }
  }
  async withCredential<T>(
    rawPin: unknown,
    reference: string,
    consumer: (
      secret: { reference: string; presignedUrl: string; uploadId: string },
      signal: AbortSignal,
    ) => Promise<T>,
    caller?: AbortSignal,
  ) {
    try {
      const pin = s3CapabilityPinSchema.parse(rawPin);
      if (uuid.parse(reference) !== pin.reference) throw failure();
      return await this.store.withSecret(
        pin,
        async (opened, signal) =>
          consumer({ reference, ...this.plaintext(opened.bytes) }, signal),
        caller,
      );
    } catch {
      throw failure();
    }
  }
  async inspect(rawPin?: unknown, caller?: AbortSignal) {
    return this.store.withSecret(
      rawPin,
      async (opened) => ({
        kind: 'S3_CAPABILITY_OBSERVATION_V1' as const,
        pin: opened.pin,
        reference: opened.pin.reference,
        presignedUrlSha256: opened.pin.presignedUrlSha256,
        uploadIdSha256: opened.pin.uploadIdSha256,
        decryptable: true as const,
        originalAcknowledgementReconstructed: false as const,
        actionAuthorized: false as const,
      }),
      caller,
    );
  }
}
