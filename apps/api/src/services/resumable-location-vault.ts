import { createHash, randomUUID } from 'node:crypto';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import { z } from 'zod';
import { EncryptedMaintenanceSecretStore } from './encrypted-maintenance-secret-store.js';
import {
  assertResumableLocation,
  resumableLocationPinSchema,
  type ResumableLocationPin,
} from './resumable-location-contract.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
const failure = () =>
  new Error(
    'Encrypted resumable-location custody is unresolved; preserve the original attempt without retrying retention',
  );
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const sha = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .length(64),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const arn = z
  .string()
  .regex(
    /^arn:aws:kms:eu-west-1:\d{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );
const configuration = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    uploadIdFormat: z.enum(['PATH_V1', 'FILE_VERSION_V1']),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    accountId: z.string().regex(/^\d{12}$/),
    dataKeyArn: arn,
    storageKeyArn: arn,
    maintenance: credentialReadMaintenanceBindingSchema,
    probeDigest: sha,
  })
  .strict()
  .refine(
    (c) =>
      c.dataKeyArn !== c.storageKeyArn &&
      [c.dataKeyArn, c.storageKeyArn].every(
        (k) => k.split(':')[4] === c.accountId,
      ),
  );
export const resumableLocationVaultStorageSchema = configuration
  .innerType()
  .omit({ maintenance: true, probeDigest: true })
  .refine(
    (c) =>
      c.dataKeyArn !== c.storageKeyArn &&
      [c.dataKeyArn, c.storageKeyArn].every(
        (k) => k.split(':')[4] === c.accountId,
      ),
  );
const contextSchema = z
  .object({
    purpose: z.literal('charitypilot-resumable-location-v1'),
    installationId: z.string(),
    maintenance: credentialReadMaintenanceBindingSchema,
    custodyDigest: sha,
    probeDigest: sha,
    keyArn: arn,
    reference: uuid,
    locationSha256: sha,
    locationBytes: z.number().int().min(1).max(2048),
  })
  .strict();
type Context = z.infer<typeof contextSchema>;
const locationInput = z
  .object({
    location: z.string().min(1).max(2048),
    sha256: sha,
  })
  .strict();

export class S3ResumableLocationVault {
  private readonly config: z.infer<typeof configuration>;
  private readonly store: EncryptedMaintenanceSecretStore<
    Context,
    ResumableLocationPin
  >;
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
        envelopeKind: 'RESUMABLE_LOCATION_ENVELOPE_V1',
        objectKey: this.request().Key,
        custodyDigest: this.configurationDigest(),
        parseContext: (raw) => contextSchema.parse(raw),
        assertContext: (c) => this.assertScope(c),
        kmsContext: (c) => this.kmsContext(c),
        plaintextBytes: (c) => c.locationBytes,
        validatePlaintext: (bytes, c) => {
          const location = new TextDecoder('utf-8', { fatal: true }).decode(
            bytes,
          );
          this.validateLocation(location);
          if (
            bytes.length !== c.locationBytes ||
            hash(bytes) !== c.locationSha256
          )
            throw failure();
        },
        parsePin: (raw) => resumableLocationPinSchema.parse(raw),
        makePin: (c, stored) =>
          resumableLocationPinSchema.parse({
            kind: 'RESUMABLE_LOCATION_PIN_V1',
            reference: c.reference,
            custodyDigest: this.configurationDigest(),
            ...stored,
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
        purpose: 'charitypilot-resumable-location-v1',
        installationId: c.installationId,
        bucket: c.bucket,
        accountId: c.accountId,
        dataKeyArn: c.dataKeyArn,
        storageKeyArn: c.storageKeyArn,
        projectRef: c.projectRef,
        uploadIdFormat: c.uploadIdFormat,
        probeDigest: c.probeDigest,
      }),
    );
  }
  private request() {
    const c = this.config;
    return {
      Bucket: c.bucket,
      ExpectedBucketOwner: c.accountId,
      Key: `managed-maintenance/${c.installationId}/${c.maintenance.attemptId}/resumable-location.json`,
    };
  }
  private context(
    reference: string,
    locationSha256: string,
    locationBytes: number,
  ) {
    return contextSchema.parse({
      purpose: 'charitypilot-resumable-location-v1',
      installationId: this.config.installationId,
      maintenance: this.config.maintenance,
      custodyDigest: this.configurationDigest(),
      probeDigest: this.config.probeDigest,
      keyArn: this.config.dataKeyArn,
      reference,
      locationSha256,
      locationBytes,
    });
  }
  private assertScope(c: Context) {
    if (
      JSON.stringify(c) !==
      JSON.stringify(
        this.context(c.reference, c.locationSha256, c.locationBytes),
      )
    )
      throw failure();
  }
  private kmsContext(c: Context) {
    this.assertScope(c);
    return {
      purpose: c.purpose,
      installationId: c.installationId,
      attemptId: c.maintenance.attemptId,
      sourceSha: c.maintenance.sourceSha,
      planDigest: c.maintenance.planDigest,
      maintenanceEpoch: String(c.maintenance.maintenanceEpoch),
      custodyDigest: c.custodyDigest,
      probeDigest: c.probeDigest,
      keyArn: c.keyArn,
      reference: c.reference,
      locationSha256: c.locationSha256,
      locationBytes: String(c.locationBytes),
    };
  }
  private validateLocation(raw: unknown) {
    return assertResumableLocation(raw, {
      installationId: this.config.installationId,
      projectRef: this.config.projectRef,
      attemptId: this.config.maintenance.attemptId,
      uploadIdFormat: this.config.uploadIdFormat,
    });
  }

  async retain(raw: unknown, caller?: AbortSignal) {
    if (this.attempted) throw failure();
    this.attempted = true;
    try {
      const input = locationInput.parse(raw);
      this.validateLocation(input.location);
      if (hash(input.location) !== input.sha256) throw failure();
      const bytes = Buffer.from(input.location),
        c = this.context(randomUUID(), input.sha256, bytes.length);
      try {
        const pin = await this.store.retain(c, bytes, caller);
        return {
          reference: pin.reference,
          locationSha256: c.locationSha256,
          pin,
        };
      } finally {
        bytes.fill(0);
      }
    } catch {
      throw failure();
    }
  }
  async withLocation<T>(
    rawPin: unknown,
    reference: string,
    consumer: (
      secret: { reference: string; location: string },
      signal: AbortSignal,
    ) => Promise<T>,
    caller?: AbortSignal,
  ) {
    try {
      const pin = resumableLocationPinSchema.parse(rawPin);
      if (uuid.parse(reference) !== pin.reference) throw failure();
      return await this.store.withSecret(
        pin,
        async (opened, signal) =>
          consumer(
            { reference, location: opened.bytes.toString('utf8') },
            signal,
          ),
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
        kind: 'RESUMABLE_LOCATION_OBSERVATION_V1' as const,
        pin: opened.pin,
        reference: opened.pin.reference,
        locationSha256: hash(opened.bytes),
        decryptable: true as const,
        originalAcknowledgementReconstructed: false as const,
        actionAuthorized: false as const,
      }),
      caller,
    );
  }
}
