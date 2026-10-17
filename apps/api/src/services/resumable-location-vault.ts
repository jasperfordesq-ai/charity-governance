import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Readable } from 'node:stream';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  type S3ClientConfig,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import { z } from 'zod';
import { assertResumableLocation } from './resumable-location-contract.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  resumableLocationPinSchema,
  type ResumableLocationPin,
} from './resumable-location-contract.js';
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
const base64 = z
  .string()
  .min(1)
  .max(16384)
  .refine((v) => Buffer.from(v, 'base64').toString('base64') === v);
const envelopeSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('RESUMABLE_LOCATION_ENVELOPE_V1'),
    context: contextSchema,
    wrappedKey: base64,
    iv: base64,
    tag: base64,
    ciphertext: base64,
  })
  .strict();
const locationInput = z
  .object({
    location: z.string().min(1).max(2048),
    sha256: sha,
  })
  .strict();
type KeyResponse = {
  Plaintext?: Uint8Array;
  CiphertextBlob?: Uint8Array;
  KeyId?: string;
  EncryptionAlgorithm?: string;
};
const clear = (r: KeyResponse | undefined) => {
  if (r?.Plaintext instanceof Uint8Array) r.Plaintext.fill(0);
};

/** Credential ciphertext only, purpose-separated from document/recovery data.
 * This does not provision IAM/KMS, advance the parent or authorise revocation.
 * Buffer zeroisation does not guarantee erasure of consumer-created JS strings. */
export class S3ResumableLocationVault {
  private readonly config: z.infer<typeof configuration>;
  private readonly storage: S3Client;
  private readonly keys: KMSClient;
  private attempted = false;
  constructor(
    raw: unknown,
    storageCredentials: NonNullable<S3ClientConfig['credentials']>,
    kmsCredentials: NonNullable<KMSClientConfig['credentials']>,
    clients?: { storage?: S3Client; kms?: KMSClient },
  ) {
    this.config = configuration.parse(raw);
    if (!storageCredentials || !kmsCredentials) throw failure();
    const handler = {
      connectionTimeout: 5000,
      requestTimeout: 15000,
      throwOnRequestTimeout: true,
    };
    this.storage =
      clients?.storage ??
      new S3Client({
        region: 'eu-west-1',
        endpoint: 'https://s3.eu-west-1.amazonaws.com',
        credentials: storageCredentials,
        maxAttempts: 1,
        followRegionRedirects: false,
        requestHandler: handler,
      });
    this.keys =
      clients?.kms ??
      new KMSClient({
        region: 'eu-west-1',
        endpoint: 'https://kms.eu-west-1.amazonaws.com',
        credentials: kmsCredentials,
        maxAttempts: 1,
        requestHandler: handler,
      });
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
  private async work<T>(
    run: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal,
      timer = setTimeout(() => controller.abort(), 180000);
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
  private async kms(
    command: GenerateDataKeyCommand | DecryptCommand,
    caller: AbortSignal,
  ): Promise<KeyResponse> {
    const controller = new AbortController(),
      signal = AbortSignal.any([caller, controller.signal]),
      timer = setTimeout(() => controller.abort(), 15000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const pending = (
        command instanceof GenerateDataKeyCommand
          ? this.keys.send(command, { abortSignal: signal })
          : this.keys.send(command, { abortSignal: signal })
      ).then((response) => {
        if (signal.aborted) {
          clear(response);
          throw failure();
        }
        return response;
      });
      return await Promise.race([pending, cancelled]);
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  private sendStorage(
    command: GetObjectCommand,
    signal: AbortSignal,
  ): Promise<GetObjectCommandOutput>;
  private sendStorage(
    command: PutObjectCommand,
    signal: AbortSignal,
  ): Promise<PutObjectCommandOutput>;
  private async sendStorage(
    command: GetObjectCommand | PutObjectCommand,
    signal: AbortSignal,
  ) {
    let stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const pending = (
        command instanceof GetObjectCommand
          ? this.storage.send(command, { abortSignal: signal })
          : this.storage.send(command, { abortSignal: signal })
      ).then((response) => {
        if (signal.aborted) {
          if ('Body' in response && response.Body instanceof Readable)
            response.Body.destroy();
          throw failure();
        }
        return response;
      });
      return await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  private async generated(c: Context, signal: AbortSignal) {
    let r: KeyResponse | undefined;
    try {
      r = await this.kms(
        new GenerateDataKeyCommand({
          KeyId: this.config.dataKeyArn,
          KeySpec: 'AES_256',
          EncryptionContext: this.kmsContext(c),
        }),
        signal,
      );
      if (
        r.KeyId !== this.config.dataKeyArn ||
        !(r.Plaintext instanceof Uint8Array) ||
        r.Plaintext.byteLength !== 32 ||
        !(r.CiphertextBlob instanceof Uint8Array) ||
        r.CiphertextBlob.byteLength < 1 ||
        r.CiphertextBlob.byteLength > 6144
      )
        throw failure();
      return {
        key: Buffer.from(r.Plaintext),
        wrappedKey: Buffer.from(r.CiphertextBlob).toString('base64'),
      };
    } finally {
      clear(r);
    }
  }
  private async unwrapped(wrappedKey: string, c: Context, signal: AbortSignal) {
    const bytes = Buffer.from(wrappedKey, 'base64');
    if (
      !bytes.length ||
      bytes.length > 6144 ||
      bytes.toString('base64') !== wrappedKey
    )
      throw failure();
    let r: KeyResponse | undefined;
    try {
      r = await this.kms(
        new DecryptCommand({
          KeyId: this.config.dataKeyArn,
          CiphertextBlob: bytes,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          EncryptionContext: this.kmsContext(c),
        }),
        signal,
      );
      if (
        r.KeyId !== this.config.dataKeyArn ||
        r.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT' ||
        !(r.Plaintext instanceof Uint8Array) ||
        r.Plaintext.byteLength !== 32
      )
        throw failure();
      return Buffer.from(r.Plaintext);
    } finally {
      clear(r);
    }
  }
  private metadata(
    r: {
      VersionId?: string;
      ServerSideEncryption?: string;
      SSEKMSKeyId?: string;
    },
    version?: string,
  ) {
    return Boolean(
      r.VersionId &&
      r.VersionId !== 'null' &&
      r.ServerSideEncryption === 'aws:kms' &&
      r.SSEKMSKeyId === this.config.storageKeyArn &&
      (version === undefined || r.VersionId === version),
    );
  }
  private async stored(rawPin: unknown | undefined, caller: AbortSignal) {
    const pin =
      rawPin === undefined
        ? undefined
        : resumableLocationPinSchema.parse(rawPin);
    if (pin && pin.custodyDigest !== this.configurationDigest())
      throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([caller, controller.signal]),
      timer = setTimeout(() => controller.abort(), 15000);
    let stream: Readable | undefined;
    const abort = () => stream?.destroy(failure());
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await this.sendStorage(
        new GetObjectCommand({
          ...this.request(),
          ...(pin ? { VersionId: pin.versionId } : {}),
          ChecksumMode: 'ENABLED',
        }),
        signal,
      );
      if (response.Body instanceof Readable) stream = response.Body;
      if (
        signal.aborted ||
        !stream ||
        response.DeleteMarker ||
        !this.metadata(response, pin?.versionId) ||
        !Number.isInteger(response.ContentLength) ||
        response.ContentLength! < 1 ||
        response.ContentLength! > 32768 ||
        (pin && response.ContentLength !== pin.byteLength)
      )
        throw failure();
      const chunks: Buffer[] = [];
      let count = 0;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw failure();
        count += chunk.byteLength;
        if (count > 32768) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      if (signal.aborted || count !== response.ContentLength) throw failure();
      const body = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      if (pin && hash(body) !== pin.sha256) throw failure();
      const e = envelopeSchema.parse(JSON.parse(body));
      if (JSON.stringify(e) !== body) throw failure();
      this.assertScope(e.context);
      if (
        Buffer.from(e.iv, 'base64').length !== 12 ||
        Buffer.from(e.tag, 'base64').length !== 16 ||
        Buffer.from(e.ciphertext, 'base64').length !== e.context.locationBytes
      )
        throw failure();
      const observed = resumableLocationPinSchema.parse({
        kind: 'RESUMABLE_LOCATION_PIN_V1',
        reference: e.context.reference,
        custodyDigest: this.configurationDigest(),
        versionId: response.VersionId,
        sha256: hash(body),
        byteLength: count,
      });
      if (pin && JSON.stringify(pin) !== JSON.stringify(observed))
        throw failure();
      return { envelope: e, pin: observed };
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      stream?.destroy();
      controller.abort();
    }
  }
  private async opened(rawPin: unknown | undefined, signal: AbortSignal) {
    const stored = await this.stored(rawPin, signal),
      e = stored.envelope;
    let key: Buffer | undefined,
      partial: Buffer | undefined,
      plaintext: Buffer | undefined;
    try {
      key = await this.unwrapped(e.wrappedKey, e.context, signal);
      signal.throwIfAborted();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(e.iv, 'base64'),
        { authTagLength: 16 },
      );
      decipher.setAAD(Buffer.from(JSON.stringify(e.context)));
      decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
      partial = decipher.update(Buffer.from(e.ciphertext, 'base64'));
      const final = decipher.final();
      try {
        plaintext = Buffer.concat([partial, final]);
      } finally {
        final.fill(0);
      }
      if (
        plaintext.length !== e.context.locationBytes ||
        hash(plaintext) !== e.context.locationSha256
      )
        throw failure();
      locationInput.parse({
        location: new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
        sha256: e.context.locationSha256,
      });
      this.validateLocation(
        new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
      );
      const verified = plaintext;
      plaintext = undefined;
      return { bytes: verified, pin: stored.pin };
    } finally {
      key?.fill(0);
      partial?.fill(0);
      plaintext?.fill(0);
    }
  }
  async retain(
    raw: unknown,
    caller?: AbortSignal,
  ): Promise<{
    reference: string;
    locationSha256: string;
    pin: ResumableLocationPin;
  }> {
    if (this.attempted) throw failure();
    this.attempted = true;
    return this.work(async (signal) => {
      const input = locationInput.parse(raw);
      this.validateLocation(input.location);
      if (hash(input.location) !== input.sha256) throw failure();
      const c = this.context(
          randomUUID(),
          input.sha256,
          Buffer.byteLength(input.location),
        ),
        material = await this.generated(c, signal);
      let plain: Buffer | undefined;
      const abort = () => {
        plain?.fill(0);
        material.key.fill(0);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        plain = Buffer.from(input.location);
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', material.key, iv, {
            authTagLength: 16,
          });
        cipher.setAAD(Buffer.from(JSON.stringify(c)));
        const ciphertext = Buffer.concat([
            cipher.update(plain),
            cipher.final(),
          ]),
          body = JSON.stringify(
            envelopeSchema.parse({
              format: 1,
              kind: 'RESUMABLE_LOCATION_ENVELOPE_V1',
              context: c,
              wrappedKey: material.wrappedKey,
              iv: iv.toString('base64'),
              tag: cipher.getAuthTag().toString('base64'),
              ciphertext: ciphertext.toString('base64'),
            }),
          );
        if (Buffer.byteLength(body) > 32768) throw failure();
        material.key.fill(0);
        const controller = new AbortController(),
          combined = AbortSignal.any([signal, controller.signal]),
          timer = setTimeout(() => controller.abort(), 15000);
        let response: PutObjectCommandOutput;
        try {
          combined.throwIfAborted();
          response = await this.sendStorage(
            new PutObjectCommand({
              ...this.request(),
              IfNoneMatch: '*',
              Body: body,
              ContentType: 'application/json',
              ServerSideEncryption: 'aws:kms',
              SSEKMSKeyId: this.config.storageKeyArn,
              ChecksumSHA256: createHash('sha256')
                .update(body)
                .digest('base64'),
            }),
            combined,
          );
          if (combined.aborted || !this.metadata(response)) throw failure();
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
        const pin = resumableLocationPinSchema.parse({
          kind: 'RESUMABLE_LOCATION_PIN_V1',
          reference: c.reference,
          custodyDigest: this.configurationDigest(),
          versionId: response.VersionId,
          sha256: hash(body),
          byteLength: Buffer.byteLength(body),
        });
        const retained = await this.opened(pin, signal);
        try {
          if (!retained.bytes.equals(plain)) throw failure();
        } finally {
          retained.bytes.fill(0);
        }
        return {
          reference: c.reference,
          locationSha256: c.locationSha256,
          pin,
        };
      } finally {
        signal.removeEventListener('abort', abort);
        plain?.fill(0);
        material.key.fill(0);
      }
    }, caller);
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
    return this.work(async (signal) => {
      const pin = resumableLocationPinSchema.parse(rawPin);
      if (uuid.parse(reference) !== pin.reference) throw failure();
      const opened = await this.opened(pin, signal);
      const abort = () => opened.bytes.fill(0);
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        return await consumer(
          { reference, location: opened.bytes.toString('utf8') },
          signal,
        );
      } finally {
        signal.removeEventListener('abort', abort);
        opened.bytes.fill(0);
      }
    }, caller);
  }
  async inspect(rawPin?: unknown, caller?: AbortSignal) {
    return this.work(async (signal) => {
      const opened = await this.opened(rawPin, signal);
      try {
        return {
          kind: 'RESUMABLE_LOCATION_OBSERVATION_V1' as const,
          pin: opened.pin,
          reference: opened.pin.reference,
          locationSha256: hash(opened.bytes),
          decryptable: true as const,
          originalAcknowledgementReconstructed: false as const,
          actionAuthorized: false as const,
        };
      } finally {
        opened.bytes.fill(0);
      }
    }, caller);
  }
}
