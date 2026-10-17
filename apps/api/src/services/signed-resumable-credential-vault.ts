import { randomUUID } from 'node:crypto';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { KMSClient, KMSClientConfig } from '@aws-sdk/client-kms';
import { z } from 'zod';
import { EncryptedMaintenanceSecretStore } from './encrypted-maintenance-secret-store.js';
import { resumableLocationVaultStorageSchema } from './resumable-location-vault.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  assertSignedResumableLocation,
  signedResumableCredentialPinSchema,
  signedTusHash as hash,
} from './signed-resumable-upload-contract.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const configuration = resumableLocationVaultStorageSchema
  .innerType()
  .extend({
    maintenance: credentialReadMaintenanceBindingSchema,
    probeDigest: sha,
  })
  .refine(
    (c) =>
      c.dataKeyArn !== c.storageKeyArn &&
      [c.dataKeyArn, c.storageKeyArn].every(
        (k) => k.split(':')[4] === c.accountId,
      ),
  );
export const signedResumableVaultStorageSchema =
  resumableLocationVaultStorageSchema;
const purpose = 'charitypilot-signed-resumable-credential-v1';
const contextSchema = z
  .object({
    purpose: z.literal(purpose),
    installationId: z.string(),
    maintenance: credentialReadMaintenanceBindingSchema,
    custodyDigest: sha,
    probeDigest: sha,
    keyArn: z.string(),
    reference: uuid,
    tokenSha256: sha,
    locationSha256: sha,
    secretBytes: z.number().int().min(1).max(12288),
  })
  .strict();
type Context = z.infer<typeof contextSchema>;
type Pin = z.infer<typeof signedResumableCredentialPinSchema>;
const plainSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/),
    location: z.string().min(1).max(2048),
  })
  .strict();
const inputSchema = plainSchema.extend({
  tokenSha256: sha,
  locationSha256: sha,
});
const failure = () =>
  new Error(
    'Encrypted signed resumable custody is unresolved; preserve the original attempt without retrying retention',
  );
/** Combined original token+Location only. No parent execution/ACK reconstruction,
 * provider identity, IAM provisioning or JavaScript string erasure claim. */
export class S3SignedResumableCredentialVault {
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
        envelopeKind: 'SIGNED_RESUMABLE_CREDENTIAL_ENVELOPE_V1',
        objectKey:
          'managed-maintenance/' +
          this.config.installationId +
          '/' +
          this.config.maintenance.attemptId +
          '/signed-resumable-credential.json',
        custodyDigest: this.configurationDigest(),
        parseContext: (raw) => contextSchema.parse(raw),
        assertContext: (c) => this.assertContext(c),
        kmsContext: (c) => this.kmsContext(c),
        plaintextBytes: (c) => c.secretBytes,
        parsePin: (raw) => signedResumableCredentialPinSchema.parse(raw),
        validatePlaintext: (bytes, c) => {
          const v = this.plaintext(bytes);
          if (
            bytes.length !== c.secretBytes ||
            hash(v.token) !== c.tokenSha256 ||
            hash(v.location) !== c.locationSha256
          )
            throw failure();
        },
        makePin: (c, stored) =>
          signedResumableCredentialPinSchema.parse({
            kind: 'SIGNED_RESUMABLE_CREDENTIAL_PIN_V1',
            reference: c.reference,
            custodyDigest: this.configurationDigest(),
            ...stored,
            tokenSha256: c.tokenSha256,
            locationSha256: c.locationSha256,
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
        uploadIdFormat: c.uploadIdFormat,
        probeDigest: c.probeDigest,
      }),
    );
  }
  private context(
    reference: string,
    tokenSha256: string,
    locationSha256: string,
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
      tokenSha256,
      locationSha256,
      secretBytes,
    });
  }
  private assertContext(c: Context) {
    if (
      JSON.stringify(c) !==
      JSON.stringify(
        this.context(
          c.reference,
          c.tokenSha256,
          c.locationSha256,
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
      tokenSha256: c.tokenSha256,
      locationSha256: c.locationSha256,
      secretBytes: String(c.secretBytes),
    };
  }
  private validate(v: z.infer<typeof plainSchema>) {
    const c = this.config;
    assertSignedResumableLocation(v.location, {
      installationId: c.installationId,
      projectRef: c.projectRef,
      attemptId: c.maintenance.attemptId,
      uploadIdFormat: c.uploadIdFormat,
    });
    const parts = v.token.split('.'),
      decoded = parts.slice(0, 2).map((part) => {
        const bytes = Buffer.from(part, 'base64url');
        if (bytes.toString('base64url') !== part) throw failure();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          value: unknown = JSON.parse(text);
        if (JSON.stringify(value) !== text) throw failure();
        return value;
      });
    if (Buffer.from(parts[2], 'base64url').toString('base64url') !== parts[2])
      throw failure();
    z.object({
      alg: z.enum(['ES256', 'RS256']),
      kid: z
        .string()
        .min(1)
        .max(128)
        .refine((v) => !/[\x00-\x20\x7f]/.test(v)),
      typ: z.literal('JWT').optional(),
    })
      .strict()
      .parse(decoded[0]);
    const claims = z
      .object({
        url: z.literal(
          'charitypilot-recovery-resumable-probes/charitypilot-recovery-resumable-probe/' +
            c.installationId +
            '/' +
            c.maintenance.attemptId +
            '/old.txt',
        ),
        scope: z.literal('upload'),
        upsert: z.literal(true),
        owner: z.string().uuid().nullable().optional(),
        iat: z.number().int().nonnegative(),
        exp: z.number().int().positive(),
        nbf: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(decoded[1]);
    if (claims.exp <= claims.iat || claims.exp - claims.iat > 7200)
      throw failure();
    // Structural/scope checks only. Actual signature/current lifetime belong to
    // the active probe. Historical ciphertext must remain readable after expiry.
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
        plain = { token: v.token, location: v.location };
      this.validate(plain);
      if (
        hash(v.token) !== v.tokenSha256 ||
        hash(v.location) !== v.locationSha256
      )
        throw failure();
      const bytes = Buffer.from(JSON.stringify(plain));
      try {
        return await this.store.retain(
          this.context(
            randomUUID(),
            v.tokenSha256,
            v.locationSha256,
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
      secret: { reference: string; token: string; location: string },
      signal: AbortSignal,
    ) => Promise<T>,
    caller?: AbortSignal,
  ) {
    try {
      const pin = signedResumableCredentialPinSchema.parse(rawPin);
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
        kind: 'SIGNED_RESUMABLE_CREDENTIAL_OBSERVATION_V1' as const,
        pin: opened.pin,
        reference: opened.pin.reference,
        tokenSha256: opened.pin.tokenSha256,
        locationSha256: opened.pin.locationSha256,
        decryptable: true as const,
        originalAcknowledgementReconstructed: false as const,
        actionAuthorized: false as const,
      }),
      caller,
    );
  }
}
